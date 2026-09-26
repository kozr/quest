import SwiftUI
import Charts

// Wire amounts remain integer milliunit strings, preserving precision across JSON.
enum SalesMoney {
    static func value(_ milliunits: String) -> Decimal { (Decimal(string: milliunits, locale: Locale(identifier: "en_US_POSIX")) ?? 0) / 1000 }
    static func text(_ milliunits: String, currency: String) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currency
        formatter.currencySymbol = currency
        return formatter.string(from: NSDecimalNumber(decimal: value(milliunits))) ?? "\(currency) —"
    }
}

struct SalesDay: Decodable {
    let date: String
    let sales: String
    let unknownCount: Int
}
struct SalesApp: Decodable, Identifiable {
    let appId: String
    let appName: String
    let sales: String
    var id: String { appId }
}
struct SalesCurrency: Decodable, Identifiable {
    let currency: String
    let purchases: String
    let renewals: String
    let refunds: String
    let reversals: String
    let sales: String
    let afterRefunds: String
    let unknownCount: Int
    let days: [SalesDay]
    let apps: [SalesApp]
    var hours: [SalesDay]? = nil
    var id: String { currency }
    func money(_ amount: String) -> String { SalesMoney.text(amount, currency: currency) }
}
struct SalesConversion: Decodable {
    let status: String
    let currency: String
    let provider: String
    let earliestRateDate: String?
    let latestRateDate: String?
    let message: String?
    let totals: SalesCurrency?
}

struct SalesResponse: Decodable {
    let from: String
    let to: String
    let timeZone: String
    let firstRecordedAt: String?
    let coverage: String
    let unassignedCount: Int
    let currencies: [SalesCurrency]
    var conversion: SalesConversion? = nil

    static func demo(events: [ActivityEvent], period: SalesPeriod, now: Date = .now, timeZone: TimeZone = .autoupdatingCurrent) -> Self {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let start = period.start(now: now, calendar: calendar)
        let events = events.filter { event in
            guard let date = Timestamp.date(event.occurredAt) else { return false }
            return date < now && (start == nil || date >= start!)
        }
        let formatter = ISO8601DateFormatter()
        let day = DateFormatter()
        day.calendar = calendar; day.locale = Locale(identifier: "en_US_POSIX"); day.timeZone = calendar.timeZone
        day.dateFormat = "yyyy-MM-dd"
        func sum(_ events: [ActivityEvent], kinds: [String]) -> String {
            let value = events.filter { kinds.contains($0.kind) }.reduce(Decimal.zero) { $0 + Decimal($1.amountMilliunits ?? 0) }
            return NSDecimalNumber(decimal: value).stringValue
        }
        let hourAnchor = start ?? calendar.startOfDay(for: now)
        let hours: [SalesDay]? = start != nil && now.timeIntervalSince(hourAnchor) <= 26 * 3600
            ? Dictionary(grouping: events) { event in
                formatter.string(from: hourAnchor.addingTimeInterval(floor(Timestamp.date(event.occurredAt)!.timeIntervalSince(hourAnchor) / 3600) * 3600))
            }.map { SalesDay(date: $0.key, sales: sum($0.value, kinds: ["sale", "renewal"]), unknownCount: 0) }.sorted { $0.date < $1.date }
            : nil
        let currency = SalesCurrency(currency: "USD", purchases: sum(events, kinds: ["sale"]), renewals: sum(events, kinds: ["renewal"]),
            refunds: sum(events, kinds: ["refund"]), reversals: "0", sales: sum(events, kinds: ["sale", "renewal"]),
            afterRefunds: sum(events, kinds: ["sale", "renewal", "refund"]), unknownCount: 0,
            days: Dictionary(grouping: events) { day.string(from: Timestamp.date($0.occurredAt)!) }.map {
                SalesDay(date: $0.key, sales: sum($0.value, kinds: ["sale", "renewal"]), unknownCount: 0)
            }.sorted { $0.date < $1.date },
            apps: PreviewContent.apps.map { app in
                SalesApp(appId: app.id, appName: app.name, sales: sum(events.filter { $0.appId == app.id }, kinds: ["sale", "renewal"]))
            }, hours: hours)
        let earliest = events.compactMap { Timestamp.date($0.occurredAt) }.min()
        return Self(from: formatter.string(from: start ?? earliest ?? now), to: formatter.string(from: now), timeZone: timeZone == DisplayTimeZone.utc.timeZone ? "UTC" : timeZone.identifier,
            firstRecordedAt: earliest.map(formatter.string), coverage: "demo", unassignedCount: 0, currencies: [currency])
    }
}
enum SalesPeriod: String, CaseIterable, Identifiable {
    case today = "Today", month = "This month", recorded = "All recorded"
    var id: String { rawValue }
    func start(now: Date, calendar: Calendar = .current) -> Date? {
        switch self {
        case .today: calendar.startOfDay(for: now)
        case .month: calendar.dateInterval(of: .month, for: now)?.start
        case .recorded: nil
        }
    }
}

@MainActor
final class SalesModel: ObservableObject {
    @Published var period: SalesPeriod = .month
    static let displayCurrencies = ["CAD", "USD", "EUR", "GBP", "AUD", "JPY", "CHF", "CNY", "HKD", "NZD", "SGD", "INR", "KRW", "BRL", "MXN"]
    @Published var displayCurrency = UserDefaults.standard.string(forKey: "sales.displayCurrency") ?? "USD" {
        didSet { UserDefaults.standard.set(displayCurrency, forKey: "sales.displayCurrency") }
    }
    @Published var currency = ""
    @Published private(set) var response: SalesResponse?
    @Published private(set) var isLoading = false
    @Published private(set) var error: String?
    @Published private var isDemo = false
    private var requestID = UUID()
    init(response: SalesResponse? = nil) { self.response = response; currency = response?.currencies.first?.currency ?? "" }
    var isConverted: Bool { !isDemo && !displayCurrency.isEmpty }
    var conversionAvailable: Bool { response?.conversion?.currency == displayCurrency && response?.conversion?.status == "available" }
    var heading: String { isConverted ? "Estimated sales" : "Recorded sales" }
    var selected: SalesCurrency? {
        if isConverted { return conversionAvailable ? response?.conversion?.totals : nil }
        return response?.currencies.first { $0.currency == currency }
    }
    var conversionNote: String {
        guard conversionAvailable, let conversion = response?.conversion else {
            return "Rates unavailable. Try again or use original currencies."
        }
        if let first = conversion.earliestRateDate, let last = conversion.latestRateDate {
            return "Frankfurter · \(first == last ? first : first + " – " + last)"
        }
        return "No conversion needed."
    }
    func hasResponse(in timeZone: TimeZone) -> Bool {
        guard let response else { return false }
        // autoupdatingCurrent is not equal to a fixed TimeZone, even for the same zone.
        return TimeZone(identifier: response.timeZone)?.identifier == timeZone.identifier
    }
    func source(_ model: AppModel, timeZone: TimeZone = .autoupdatingCurrent) -> String {
        "\(model.user?.id ?? "")|\(model.isPreviewMode)|\(model.selectedEnvironment.rawValue)|\(period.rawValue)|\(displayCurrency)|\(timeZone.identifier)|\(model.apps.map(\.id).joined(separator: ","))"
    }
    func load(_ model: AppModel, timeZone: TimeZone = .autoupdatingCurrent) async {
        isDemo = model.isPreviewMode
        let id = UUID(), source = source(model, timeZone: timeZone)
        requestID = id
        response = nil; error = nil; isLoading = true
        defer { if id == requestID { isLoading = false } }
        do {
            let result = try await model.fetchSales(period: period, timeZone: timeZone, displayCurrency: displayCurrency)
            try Task.checkCancellation()
            guard id == requestID, source == self.source(model, timeZone: timeZone) else { return }
            response = result
            if !result.currencies.contains(where: { $0.currency == currency }) { currency = result.currencies.first?.currency ?? "" }
        } catch is CancellationError { return }
        catch {
            guard id == requestID, source == self.source(model, timeZone: timeZone) else { return }
            self.error = (error as? ClientError)?.isNotFound == true
                ? "Sales totals are not available on this server yet."
                : error.localizedDescription
        }
    }
}

struct DisplayTimeZoneControl: View {
    @AppStorage(DisplayTimeZone.storageKey) private var selection: DisplayTimeZone = .local
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(spacing: 12))
        layout {
            Text("Time zone").font(QuestTypography.secondary).foregroundStyle(QuestStyle.muted)
            if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
            HStack(spacing: 0) {
                ForEach(DisplayTimeZone.allCases) { mode in
                    Button { selection = mode } label: {
                        Text(mode.title).font(QuestTypography.secondaryAction)
                            .foregroundStyle(selection == mode ? QuestStyle.navy : QuestStyle.muted)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background(selection == mode ? QuestStyle.gold : .clear, in: RoundedRectangle(cornerRadius: 10))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(mode.title) time zone")
                    .accessibilityAddTraits(selection == mode ? .isSelected : [])
                    .accessibilityHint("Updates dates and sales periods. Saved on this iPhone.")
                    .accessibilityIdentifier("displayTimeZone-\(mode.rawValue)")
                }
            }
            .padding(2)
            .background(QuestStyle.navy, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(QuestStyle.muted.opacity(0.4), lineWidth: 1))
            .frame(maxWidth: typeSize.isAccessibilitySize ? .infinity : 176)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("displayTimeZone")
        }
    }
}

struct SalesPeriodPicker: View {
    @ObservedObject var sales: SalesModel
    var body: some View {
        Menu {
            Picker("Period", selection: $sales.period) {
                ForEach(SalesPeriod.allCases) { Text($0.rawValue).tag($0) }
            }
        } label: {
            HStack(spacing: 6) { Text(sales.period.rawValue); Image(systemName: "chevron.down").font(QuestTypography.metadata) }
                .font(QuestTypography.secondary).frame(minHeight: 44)
        }.accessibilityIdentifier("salesPeriod")
    }
}

struct SalesConversionPicker: View {
    @ObservedObject var sales: SalesModel
    @EnvironmentObject private var model: AppModel
    var body: some View {
        if !model.isPreviewMode {
            Picker("Display currency", selection: $sales.displayCurrency) {
                Text("Original currencies").tag("")
                ForEach(SalesModel.displayCurrencies, id: \.self) { Text($0).tag($0) }
            }
            .pickerStyle(.menu)
            .frame(minHeight: 44)
            .accessibilityIdentifier("salesDisplayCurrency")
        }
    }
}

struct SalesSummaryView: View {
    @Environment(\.timeZone) private var timeZone
    @ObservedObject var sales: SalesModel
    @EnvironmentObject private var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ViewThatFits(in: .horizontal) {
                HStack { Text(sales.heading).font(QuestTypography.secondary); Spacer(); SalesPeriodPicker(sales: sales) }
                VStack(alignment: .leading, spacing: 0) { Text(sales.heading).font(QuestTypography.secondary); SalesPeriodPicker(sales: sales) }
            }
            SalesConversionPicker(sales: sales)
            if let error = sales.error {
                Text(error).font(QuestTypography.secondary).foregroundStyle(QuestStyle.muted)
                Button("Try again") { Task { await sales.load(model, timeZone: timeZone) } }.frame(minHeight: 44)
            } else if sales.isLoading || !sales.hasResponse(in: timeZone) {
                ProgressView("Loading total…").padding(.vertical, 12)
            } else {
                NavigationLink {
                    SalesLedgerView(sales: sales)
                } label: {
                    VStack(alignment: .leading, spacing: 9) {
                        if let selected = sales.selected {
                            Text(selected.money(selected.sales)).font(QuestTypography.metric)
                                .monospacedDigit().foregroundStyle(.white)
                        } else if sales.isConverted && !sales.conversionAvailable {
                            Text("Conversion unavailable").font(.title3.weight(.semibold)).foregroundStyle(.white)
                        } else {
                            Text("No recorded sales").font(.title3.weight(.semibold)).foregroundStyle(.white)
                        }
                        HStack(alignment: .firstTextBaseline) {
                            Text("Before Apple fees").foregroundStyle(QuestStyle.muted)
                            Spacer(minLength: 4)
                            Label("View ledger", systemImage: "chevron.right").labelStyle(.titleAndIcon).foregroundStyle(QuestStyle.gold)
                        }.font(QuestTypography.metadata)
                        if !sales.isConverted && (sales.response?.currencies.count ?? 0) > 1 {
                            Text("\(sales.response!.currencies.count) currencies · View separately in ledger").font(QuestTypography.metadata).foregroundStyle(QuestStyle.muted)
                        }
                        if sales.isConverted && !sales.conversionAvailable { Text(sales.conversionNote).font(QuestTypography.metadata).foregroundStyle(QuestStyle.muted) }
                        if (sales.selected?.unknownCount ?? 0) + (sales.response?.unassignedCount ?? 0) > 0 {
                            Text("Some amounts are unavailable · Known amounts only").font(QuestTypography.metadata).foregroundStyle(QuestStyle.gold)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.bottom, 8)
                }.buttonStyle(.plain).accessibilityIdentifier("openSalesLedger")
            }
        }.padding(.horizontal, 16).padding(.vertical, 8)
            .background(.white.opacity(0.035), in: SlotShape())
            .overlay(SlotShape().stroke(QuestStyle.muted.opacity(0.28), lineWidth: 1))
            .overlay(InventoryCornerTrim().stroke(QuestStyle.gold.opacity(0.7), lineWidth: 1))
    }
}

struct SalesChartPoint: Identifiable {
    let date: Date
    let amount: Decimal
    let unknownCount: Int
    var id: Date { date }
}
struct SalesChartData {
    let points: [SalesChartPoint]
    let monthly: Bool
    let hourly: Bool
    let calendar: Calendar
    let domain: ClosedRange<Date>
    var component: Calendar.Component { hourly ? .hour : monthly ? .month : .day }
    init(response: SalesResponse, currency: SalesCurrency) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: response.timeZone) ?? .current
        self.calendar = calendar
        let start = Timestamp.date(response.from) ?? .now
        let end = Timestamp.date(response.to) ?? start
        monthly = (calendar.dateComponents([.day], from: start, to: end).day ?? 0) > 90
        hourly = currency.hours != nil && calendar.isDate(start, inSameDayAs: end.addingTimeInterval(-0.001))
        let component: Calendar.Component = hourly ? .hour : monthly ? .month : .day
        let formatter = DateFormatter()
        formatter.calendar = calendar; formatter.timeZone = calendar.timeZone; formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        var buckets: [Date: (Decimal, Int)] = [:]
        for bucket in hourly ? (currency.hours ?? []) : currency.days {
            let date = hourly ? Timestamp.date(bucket.date) : formatter.date(from: bucket.date)
            guard let date else { continue }
            let key = hourly ? date : (calendar.dateInterval(of: component, for: date)?.start ?? date)
            let previous = buckets[key] ?? (0, 0)
            buckets[key] = (previous.0 + SalesMoney.value(bucket.sales), previous.1 + bucket.unknownCount)
        }
        let first = hourly ? start : (calendar.dateInterval(of: component, for: start)?.start ?? start)
        var date = first
        var points: [SalesChartPoint] = []
        while date < end {
            let bucket = buckets[date] ?? (0, 0)
            points.append(SalesChartPoint(date: date, amount: bucket.0, unknownCount: bucket.1))
            let next = hourly ? date.addingTimeInterval(3600) : calendar.date(byAdding: component, value: 1, to: date)
            guard let next, next > date else { break }
            date = next
        }
        self.points = points
        // Keep today's full time axis stable without drawing future hours as recorded zeroes.
        let upper = hourly ? (calendar.dateInterval(of: .day, for: start)?.end ?? date) : date
        domain = first...max(first.addingTimeInterval(1), upper)
    }
    func label(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar; formatter.timeZone = calendar.timeZone
        if hourly { formatter.setLocalizedDateFormatFromTemplate("jmm z") }
        else { formatter.setLocalizedDateFormatFromTemplate(monthly ? "MMM yyyy" : "MMM d") }
        return formatter.string(from: date)
    }
}

struct SalesGraph: View {
    let response: SalesResponse
    let currency: SalesCurrency
    @State private var selectedDate: Date?
    private var data: SalesChartData { SalesChartData(response: response, currency: currency) }
    private var selected: SalesChartPoint? {
        guard let selectedDate else { return nil }
        return data.points.first { point in
            if data.hourly { return point.date <= selectedDate && selectedDate < point.date.addingTimeInterval(3600) }
            return data.calendar.isDate(point.date, equalTo: selectedDate, toGranularity: data.component)
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(data.hourly ? "Hourly sales" : data.monthly ? "Monthly sales" : "Daily sales").font(QuestTypography.sectionTitle)
            if let selected {
                Text("\(data.label(selected.date)) · \(SalesMoney.text(NSDecimalNumber(decimal: selected.amount * 1000).stringValue, currency: currency.currency))\(selected.unknownCount > 0 ? " · Known amounts" : "")")
                    .font(QuestTypography.secondary).foregroundStyle(QuestStyle.gold)
            } else {
                Text("\(currency.currency) · Before refunds · Tap a bar for details").font(QuestTypography.metadata).foregroundStyle(QuestStyle.muted)
            }
            Chart(data.points) { point in
                BarMark(x: .value("Date", point.date, unit: data.component),
                        y: .value("Recorded sales", NSDecimalNumber(decimal: point.amount).doubleValue),
                        width: data.points.count == 1 && !data.hourly ? .fixed(24) : .ratio(0.65))
                    .foregroundStyle(QuestStyle.gold.opacity(selected == nil || selected?.id == point.id ? 1 : 0.4))
                    .cornerRadius(2)
                    .accessibilityLabel(data.label(point.date))
                    .accessibilityValue("\(SalesMoney.text(NSDecimalNumber(decimal: point.amount * 1000).stringValue, currency: currency.currency))\(point.unknownCount > 0 ? ", some amounts unavailable" : "")")
                if let selected, selected.id == point.id {
                    RuleMark(x: .value("Selected date", point.date)).foregroundStyle(QuestStyle.muted.opacity(0.5))
                }
            }
            .chartXSelection(value: $selectedDate)
            .chartGesture { proxy in
                SpatialTapGesture().onEnded { event in proxy.selectXValue(at: event.location.x) }
            }
            .chartXScale(domain: data.domain)
            .chartYScale(domain: 0...max(1, data.points.map { NSDecimalNumber(decimal: $0.amount).doubleValue }.max() ?? 1))
            .chartXAxis {
                AxisMarks(values: .stride(by: data.component, count: data.hourly ? 6 : max(1, data.points.count / 4))) { value in
                    if let date = value.as(Date.self) {
                        AxisValueLabel {
                            Text(date, format: data.hourly ? .dateTime.hour() : data.monthly ? .dateTime.month(.abbreviated) : .dateTime.month(.abbreviated).day())
                        }
                    }
                    AxisTick()
                }
            }
            .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { _ in AxisGridLine().foregroundStyle(QuestStyle.muted.opacity(0.12)); AxisValueLabel() } }
            .environment(\.calendar, data.calendar)
            .environment(\.timeZone, data.calendar.timeZone)
            .frame(height: 180)
            .accessibilityIdentifier("salesGraph")
            if currency.days.contains(where: { $0.unknownCount > 0 }) {
                Text("The graph includes known amounts only.").font(QuestTypography.metadata).foregroundStyle(QuestStyle.gold)
            }
        }
    }
}

struct SalesLedgerView: View {
    @Environment(\.timeZone) private var timeZone
    @ObservedObject var sales: SalesModel
    @EnvironmentObject private var model: AppModel
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        GeometryReader { geometry in
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                ActivitySceneHeader(title: "Sales ledger", badge: model.isPreviewMode ? "Sample" : model.selectedEnvironment.rawValue,
                                    topSafeArea: geometry.safeAreaInsets.top)
                HStack {
                    SalesPeriodPicker(sales: sales)
                    Spacer()
                    if !sales.isConverted, let response = sales.response, !response.currencies.isEmpty {
                        Picker("Currency", selection: $sales.currency) {
                            ForEach(response.currencies) { Text($0.currency).tag($0.currency) }
                        }.pickerStyle(.menu).accessibilityIdentifier("salesCurrency")
                    }
                }
                SalesConversionPicker(sales: sales)
                DisplayTimeZoneControl()
                if let error = sales.error {
                    Text(error).foregroundStyle(QuestStyle.muted)
                    Button("Try again") { Task { await sales.load(model, timeZone: timeZone) } }.frame(minHeight: 44)
                } else if sales.isLoading || !sales.hasResponse(in: timeZone) {
                    ProgressView("Loading ledger…").frame(maxWidth: .infinity).padding(.vertical, 40)
                } else if let response = sales.response {
                    if model.isPreviewMode || model.selectedEnvironment == .demo {
                        Text("Sample data · Not real sales").font(QuestTypography.metadata).foregroundStyle(QuestStyle.gold)
                    } else if model.selectedEnvironment == .sandbox {
                        Text("Test purchases · Not real sales").font(QuestTypography.metadata).foregroundStyle(QuestStyle.gold)
                    }
                    Text("All apps · \(dateRange(response)) · \(Timestamp.zoneLabel(TimeZone(identifier: response.timeZone) ?? timeZone, at: Timestamp.date(response.to) ?? .now))")
                        .font(QuestTypography.metadata).foregroundStyle(QuestStyle.muted)
                    if sales.isConverted {
                        Text(sales.heading).font(QuestTypography.cardTitle)
                        Text(sales.conversionNote).font(QuestTypography.metadata).foregroundStyle(QuestStyle.muted)
                    }
                    if let currency = sales.selected {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("After refunds").font(QuestTypography.sectionTitle)
                            Text(currency.money(currency.afterRefunds)).font(QuestTypography.metric).monospacedDigit()
                            Text("Before Apple fees and taxes").font(QuestTypography.metadata).foregroundStyle(QuestStyle.muted)
                            if currency.unknownCount + response.unassignedCount > 0 {
                                Label("\(currency.unknownCount + response.unassignedCount) events have unavailable amounts or currencies. Totals include known amounts only.", systemImage: "info.circle")
                                    .font(QuestTypography.metadata).foregroundStyle(QuestStyle.gold)
                            }
                        }
                        SalesGraph(response: response, currency: currency).id("\(response.from)|\(response.to)|\(currency.currency)")
                        VStack(spacing: 14) {
                            moneyRow("New purchases", amount: currency.purchases, currency: currency)
                            moneyRow("Renewals", amount: currency.renewals, currency: currency)
                            Divider().overlay(QuestStyle.muted.opacity(0.3))
                            moneyRow(sales.heading, amount: currency.sales, currency: currency)
                            moneyRow("Refunds", amount: currency.refunds, currency: currency)
                            if currency.reversals != "0" { moneyRow("Refund reversals", amount: currency.reversals, currency: currency) }
                        }
                        Text("Sales by app").font(QuestTypography.sectionTitle)
                        ForEach(currency.apps.sorted { SalesMoney.value($0.sales) > SalesMoney.value($1.sales) }) { app in
                            HStack(spacing: 12) {
                                ActivityInventorySlot { AppArtwork(url: model.apps.first { $0.id == app.appId }?.iconUrl, name: app.appName, bundledIconName: model.apps.first { $0.id == app.appId }?.bundledIconName).accentColor(QuestStyle.gold) }
                                let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6)) : AnyLayout(HStackLayout(spacing: 8))
                                layout {
                                    Text(app.appName).font(QuestTypography.appName)
                                    if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
                                    Text(currency.money(app.sales)).font(QuestTypography.secondary).monospacedDigit()
                                }
                            }
                            Divider().overlay(QuestStyle.muted.opacity(0.15))
                        }
                        Text("App totals show sales before refunds.").font(QuestTypography.metadata).foregroundStyle(QuestStyle.muted)
                    } else if sales.isConverted && !sales.conversionAvailable {
                        Button("Retry conversion") { Task { await sales.load(model, timeZone: timeZone) } }.frame(minHeight: 44)
                    } else {
                        ContentUnavailableView("No recorded sales", systemImage: "chart.bar", description: Text("Choose another period or wait for a purchase to arrive."))
                        if response.unassignedCount > 0 { Text("\(response.unassignedCount) events have unavailable currencies.").font(QuestTypography.metadata).foregroundStyle(QuestStyle.gold) }
                    }
                    Text("Recorded activity only.").font(QuestTypography.metadata).foregroundStyle(QuestStyle.muted)
                }
            }.padding(.horizontal, 24).padding(.bottom, 32)
        }
        .ignoresSafeArea(.container, edges: .top)
        .refreshable { await sales.load(model, timeZone: timeZone) }
        }
        .background(QuestStyle.navy).foregroundStyle(.white).tint(QuestStyle.gold).preferredColorScheme(.dark)
        .navigationTitle("").navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbarBackground(.hidden, for: .navigationBar)
        .onChange(of: sales.source(model, timeZone: timeZone)) { _, _ in
            Task { await sales.load(model, timeZone: timeZone) }
        }
    }
    private func dateRange(_ response: SalesResponse) -> String {
        guard let from = Timestamp.date(response.from), let to = Timestamp.date(response.to) else { return "Recorded activity" }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: response.timeZone) ?? .current
        let last = to.addingTimeInterval(-0.001)
        let formatter = DateFormatter()
        formatter.calendar = calendar; formatter.timeZone = calendar.timeZone; formatter.dateStyle = .medium
        if calendar.isDate(from, inSameDayAs: last) { return formatter.string(from: from) }
        return "\(formatter.string(from: from)) – \(formatter.string(from: last))"
    }
    private func moneyRow(_ title: String, amount: String, currency: SalesCurrency) -> some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 5)) : AnyLayout(HStackLayout())
        return layout {
            Text(title).foregroundStyle(QuestStyle.muted)
            if !typeSize.isAccessibilitySize { Spacer() }
            Text(currency.money(amount)).monospacedDigit().foregroundStyle(amount.hasPrefix("-") ? Color(red: 1, green: 0.61, blue: 0.52) : .white)
        }.font(QuestTypography.secondary).frame(maxWidth: .infinity, alignment: .leading)
    }
}
