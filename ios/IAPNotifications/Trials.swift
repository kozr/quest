import SwiftUI

struct TrialRecord: Decodable, Identifiable {
    let id: String
    let appId: String
    let appName: String
    let productId: String
    let startedAt: String
    let endsAt: String
    let renewalStatus: TrialRenewalStatus
    let lastUpdatedAt: String

    func isLive(at date: Date) -> Bool {
        guard let start = Timestamp.date(startedAt), let end = Timestamp.date(endsAt) else { return false }
        return start <= date && date < end
    }
}

enum TrialRenewalStatus: String, Decodable, CaseIterable, Identifiable {
    case on, off, unknown
    var id: String { rawValue }
    var title: String { switch self { case .on: "Renewal on"; case .off: "Renewal off"; case .unknown: "Unknown" } }
    var symbol: String { switch self { case .on: "checkmark.circle.fill"; case .off: "minus.circle.fill"; case .unknown: "questionmark.circle.fill" } }
    var color: Color { switch self { case .on: Color(red: 0.57, green: 0.91, blue: 0.39); case .off: TrialsStyle.gold; case .unknown: TrialsStyle.muted } }
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

struct TrialsResponse: Decodable {
    let asOf: String
    let coverage: String
    let truncated: Bool
    let unverifiedCount: Int
    let trials: [TrialRecord]

    static func demo(now: Date = Date()) -> Self {
        let formatter = ISO8601DateFormatter()
        let apps = PreviewContent.apps
        let records = (0..<128).map { index in
            let app = apps[index < 18 ? index % 2 : index < 87 ? 0 : 1]
            let state: TrialRenewalStatus = index < 18 ? ([1, 8, 15].contains(index) ? .off : index == 3 ? .unknown : .on)
                : index < 100 ? .on : index < 121 ? .off : .unknown
            let hours = index < 18 ? Double(index + 1) : Double(25 + index)
            return TrialRecord(id: String(format: "demo%06d", index + 1), appId: app.id, appName: app.name,
                productId: index.isMultiple(of: 2) ? "Annual" : "Monthly",
                startedAt: formatter.string(from: now.addingTimeInterval(-86_400)),
                endsAt: formatter.string(from: now.addingTimeInterval(hours * 3_600)), renewalStatus: state,
                lastUpdatedAt: formatter.string(from: now))
        }
        return Self(asOf: formatter.string(from: now), coverage: "demo", truncated: false, unverifiedCount: 0, trials: records)
    }
}

@MainActor
final class TrialsModel: ObservableObject {
    @Published private(set) var response: TrialsResponse?
    @Published private(set) var isLoading = false
    @Published private(set) var error: String?
    private var requestID = UUID()
    private var loadedSource: String?
    private var receivedAt = Date()

    init(response: TrialsResponse? = nil) { self.response = response }

    // Advance the server's as-of time while on screen; expiry does not wait for another notification.
    func now(at localDate: Date) -> Date {
        guard let serverDate = response.flatMap({ Timestamp.date($0.asOf) }) else { return localDate }
        return serverDate.addingTimeInterval(max(0, localDate.timeIntervalSince(receivedAt)))
    }

    func load(_ model: AppModel) async {
        let source = "\(model.user?.id ?? "")|\(model.selectedEnvironment.rawValue)|\(model.isPreviewMode)"
        let request = UUID()
        requestID = request
        if source != loadedSource { response = nil }
        isLoading = true
        error = nil
        defer { if request == requestID { isLoading = false } }
        do {
            let result = try await model.fetchTrials()
            try Task.checkCancellation()
            guard request == requestID, source == "\(model.user?.id ?? "")|\(model.selectedEnvironment.rawValue)|\(model.isPreviewMode)" else { return }
            response = result
            loadedSource = source
            receivedAt = Date()
        } catch is CancellationError { return }
        catch {
            // URLSession reports cancellation as URLError, not CancellationError.
            // Leaving the screen or replacing a refresh must not display a failure.
            guard request == requestID, !Task.isCancelled,
                  (error as? URLError)?.code != .cancelled else { return }
            self.error = Self.refreshMessage(for: error)
        }
    }

    private static func refreshMessage(for error: Error) -> String {
        if let error = error as? URLError {
            switch error.code {
            case .notConnectedToInternet:
                return "You're offline. Connect to the internet and try again."
            case .timedOut:
                return "Trial refresh timed out. Try again."
            default:
                return "Could not connect to the trial service (network \(error.code.rawValue)). Try again."
            }
        }
        if let error = error as? ClientError {
            switch error {
            case .server(status: 404, _), .codedServer(status: 404, _, _):
                return "Trial tracking is not available on this server yet."
            case .server(status: 401, _), .codedServer(status: 401, _, _):
                return "Sign in again to refresh trial counts."
            case .server(let status, _), .codedServer(let status, _, _):
                return "Trial refresh failed (HTTP \(status)). Try again."
            case .invalidResponse:
                return "The server returned trial data that could not be read. Try again."
            case .message:
                break
            }
        }
        return "Trial counts could not be refreshed. Try again."
    }
}

private enum TrialsStyle {
    static let navy = QuestStyle.navy
    static let gold = QuestStyle.gold
    static let muted = QuestStyle.muted
}

enum ActivitySection: String, CaseIterable, Identifiable {
    case events = "Events", trials = "Trials"
    var id: String { rawValue }
}

struct ActivityHubView: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        if model.activitySection == .trials {
            TrialsDashboardView(section: $model.activitySection)
        } else {
            ActivityView(section: $model.activitySection)
        }
    }
}

struct TrialsDashboardView: View {
    @Environment(\.timeZone) private var timeZone
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @Binding var section: ActivitySection
    @StateObject private var trials = TrialsModel()
    @State private var appID: String?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Group {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                let now = trials.now(at: context.date)
                let live = (trials.response?.trials ?? []).filter { $0.isLive(at: now) && (appID == nil || $0.appId == appID) }
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        VStack(alignment: .leading, spacing: 16) {
                            ActivitySceneHeader(title: "Trials", badge: model.isPreviewMode ? "Demo" : model.selectedEnvironment.rawValue, topSpacing: 16)
                            ActivitySectionPicker(selection: $section)
                        }
                        filters
                        if let error = trials.error {
                            VStack(alignment: .leading, spacing: 8) {
                                Label(error, systemImage: "exclamationmark.triangle")
                                Button("Try again") { Task { await trials.load(model) } }.buttonStyle(.bordered)
                            }.font(.subheadline)
                        }
                        if trials.isLoading && trials.response == nil {
                            ProgressView("Loading trials…").frame(maxWidth: .infinity).padding(.vertical, 36)
                        } else if let response = trials.response {
                            summary(live, response: response, now: now)
                            coverage(response)
                        }
                    }.padding(.horizontal, 24).padding(.bottom, 28)
                }
                .refreshable { await trials.load(model) }
                .background(TrialsStyle.navy.ignoresSafeArea())
            }
            .foregroundStyle(.white).tint(TrialsStyle.gold)
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.visible, for: .navigationBar)
            .toolbarBackground(TrialsStyle.navy, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbarBackground(TrialsStyle.navy, for: .tabBar)
            .toolbarBackground(.visible, for: .tabBar)
            .preferredColorScheme(.dark)
            .task(id: "\(model.user?.id ?? "")|\(model.selectedEnvironment.rawValue)") {
                if !model.isPreviewMode && model.selectedEnvironment == .demo { model.selectedEnvironment = .production }
                await trials.load(model)
            }
            .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await trials.load(model) } } }
            .onChange(of: model.events.map(\.id)) { _, _ in Task { await trials.load(model) } }
            .onChange(of: model.apps.map(\.id)) { _, ids in if let appID, !ids.contains(appID) { self.appID = nil } }
        }
    }

    private var filters: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Menu {
                    Button("All apps") { appID = nil }
                    ForEach(model.apps) { app in Button(app.name) { appID = app.id } }
                } label: {
                    Label(model.apps.first { $0.id == appID }?.name ?? "All apps", systemImage: "chevron.down")
                        .font(.subheadline.weight(.semibold)).padding(12)
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(TrialsStyle.muted.opacity(0.5)))
                }
                Spacer()
                if trials.isLoading { ProgressView().accessibilityLabel("Refreshing trials") }
            }
            if model.isPreviewMode {
                Text("Sample data · Not real subscribers")
                    .font(.caption).foregroundStyle(TrialsStyle.muted)
            }
            if !model.isPreviewMode {
                Picker("Trial environment", selection: $model.selectedEnvironment) {
                    Text("Production").tag(ActivityEnvironment.production)
                    Text("Sandbox").tag(ActivityEnvironment.sandbox)
                }.pickerStyle(.segmented)
            }
        }
    }

    private func summary(_ live: [TrialRecord], response: TrialsResponse, now: Date) -> some View {
        VStack(alignment: .leading, spacing: 22) {
            let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(alignment: .center, spacing: 14))
            layout {
                Text("\(response.truncated ? "≥" : "")\(live.count)")
                    .font(.system(size: 64, weight: .bold, design: .rounded)).monospacedDigit()
                VStack(alignment: .leading, spacing: 4) {
                    Text("Live trials").font(.title2.bold())
                    Text("Still within their free trial period").font(.subheadline).foregroundStyle(TrialsStyle.muted)
                }
            }.accessibilityElement(children: .combine)
            if response.truncated {
                Label("Partial results · counts may be higher", systemImage: "info.circle")
                    .font(.subheadline).foregroundStyle(TrialsStyle.gold)
            }
            distribution(live)
            let metricLayout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12)) : AnyLayout(HStackLayout(spacing: 8))
            metricLayout {
                ForEach(TrialRenewalStatus.allCases) { status in
                    NavigationLink {
                        TrialListView(trials: trials, appID: appID, initialStatus: status)
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Image(systemName: status.symbol).font(.title2).foregroundStyle(status.color)
                            Text("\(live.filter { $0.renewalStatus == status }.count)")
                                .font(.title2.bold()).monospacedDigit().foregroundStyle(.white)
                            Text(status.title).font(.caption).foregroundStyle(TrialsStyle.muted)
                                .fixedSize(horizontal: false, vertical: true)
                        }.frame(maxWidth: .infinity, minHeight: 50, alignment: .leading)
                    }.accessibilityLabel("\(live.filter { $0.renewalStatus == status }.count) live trials, \(status.title). Show trials.")
                }
            }
            let ending = live.filter { (Timestamp.date($0.endsAt) ?? .distantFuture) <= now.addingTimeInterval(86_400) }
            NavigationLink {
                TrialListView(trials: trials, appID: appID, endingSoon: true)
            } label: {
                let endingLayout = typeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
                    : AnyLayout(HStackLayout(spacing: 14))
                endingLayout {
                    ActivityInventorySlot {
                        Image(systemName: "hourglass").font(.title2).foregroundStyle(TrialsStyle.gold)
                            .frame(width: 36, height: 36)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Ending in 24 hours").font(.headline)
                        Text("\(ending.filter { $0.renewalStatus == .on }.count) on · \(ending.filter { $0.renewalStatus == .off }.count) off · \(ending.filter { $0.renewalStatus == .unknown }.count) unknown")
                            .font(.caption).foregroundStyle(TrialsStyle.muted)
                    }
                    if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
                    Text("\(ending.count)").font(.title3.bold())
                    Image(systemName: "chevron.right").font(.caption)
                }.padding(14)
                    .background(Color.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(TrialsStyle.gold.opacity(0.7)))
            }.foregroundStyle(.white)
            if live.isEmpty {
                Text("No live trials in the received updates. Trials will appear here when Apple sends a free-trial transaction.")
                    .font(.subheadline).foregroundStyle(TrialsStyle.muted)
            } else {
                Text("By app").font(.title3.bold()).accessibilityAddTraits(.isHeader)
                ForEach(model.apps.filter { app in live.contains { $0.appId == app.id } }) { app in
                    NavigationLink {
                        TrialListView(trials: trials, appID: app.id)
                    } label: {
                        let appLayout = typeSize.isAccessibilitySize
                            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10))
                            : AnyLayout(HStackLayout(spacing: 12))
                        appLayout {
                            ActivityInventorySlot {
                                AppArtwork(url: app.iconUrl, name: app.name, bundledIconName: app.bundledIconName).accentColor(TrialsStyle.gold)
                            }
                            Text(app.name).font(.headline)
                            if !typeSize.isAccessibilitySize { Spacer() }
                            Text("\(live.filter { $0.appId == app.id }.count) live").font(.subheadline)
                            Image(systemName: "chevron.right").font(.caption)
                        }.padding(.vertical, 6)
                    }.foregroundStyle(.white)
                    Divider().overlay(TrialsStyle.muted.opacity(0.2))
                }
                NavigationLink { TrialListView(trials: trials, appID: appID) } label: {
                    HStack {
                        Text("View all live trials")
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption)
                    }.frame(minHeight: 44)
                }
            }
        }
    }

    private func distribution(_ records: [TrialRecord]) -> some View {
        GeometryReader { geometry in
            HStack(spacing: 0) {
                ForEach(TrialRenewalStatus.allCases) { status in
                    let count = records.filter { $0.renewalStatus == status }.count
                    status.color.frame(width: max(0, geometry.size.width - 8) * CGFloat(count) / CGFloat(max(records.count, 1)))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(TrialsStyle.muted.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 5))
            .padding(4)
            .background(TrialsStyle.navy, in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(TrialsStyle.muted.opacity(0.45)))
            .overlay {
                HStack {
                    Capsule().fill(TrialsStyle.gold.opacity(0.75)).frame(width: 3)
                    Spacer()
                    Capsule().fill(TrialsStyle.gold.opacity(0.75)).frame(width: 3)
                }.padding(.vertical, 4)
            }
        }.frame(height: 22).accessibilityHidden(true)
    }

    private func coverage(_ response: TrialsResponse) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if model.isPreviewMode {
                Text("Sample data · Not real subscribers")
            } else {
                Label("Based on received Apple updates", systemImage: "info.circle")
                Text("Earlier trials may be missing. Import notification history from your app’s dashboard to include them.")
                Text("Last fetched \(Timestamp.date(response.asOf)?.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: timeZone)) ?? "—")")
                if response.unverifiedCount > 0 { Text("\(response.unverifiedCount) trial records have no confirmed end date and are excluded from live counts.") }
                if response.truncated { Text("Partial results: showing up to 1,000 live trials. Counts may be higher.") }
            }
            Text("Renewal on does not guarantee payment.")
        }.font(.caption).foregroundStyle(TrialsStyle.muted)
    }
}

struct TrialListView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var trials: TrialsModel
    var appID: String? = nil
    var endingSoon = false
    @State private var status: TrialRenewalStatus?
    @Environment(\.dynamicTypeSize) private var typeSize

    init(trials: TrialsModel, appID: String? = nil, endingSoon: Bool = false, initialStatus: TrialRenewalStatus? = nil) {
        self.trials = trials; self.appID = appID; self.endingSoon = endingSoon
        _status = State(initialValue: initialStatus)
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            let now = trials.now(at: context.date)
            let all = (trials.response?.trials ?? []).filter { record in
                record.isLive(at: now) && (appID == nil || record.appId == appID)
                && (!endingSoon || (Timestamp.date(record.endsAt) ?? .distantFuture) <= now.addingTimeInterval(86_400))
            }.sorted { $0.endsAt < $1.endsAt }
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    ActivitySceneHeader(title: endingSoon ? "Ending soon" : "Live trials",
                                     badge: model.isPreviewMode ? "Demo" : model.selectedEnvironment.rawValue)
                    Text(endingSoon ? "\(all.count) trials end in the next 24 hours" : "\(all.count) trials still live")
                        .foregroundStyle(TrialsStyle.muted)
                    if trials.response?.truncated == true {
                        Text("Partial results · counts may be higher").font(.caption).foregroundStyle(TrialsStyle.gold)
                    }
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            filter("All \(all.count)", value: nil)
                            ForEach(TrialRenewalStatus.allCases) { value in
                                filter("\(value == .unknown ? "Unknown" : value == .on ? "On" : "Off") \(all.filter { $0.renewalStatus == value }.count)", value: value)
                            }
                        }
                    }
                    let visible = all.filter { status == nil || $0.renewalStatus == status }
                    if visible.isEmpty { Text("No trials match this filter.").foregroundStyle(TrialsStyle.muted).padding(.vertical, 20) }
                    LazyVStack(spacing: 16) {
                        ForEach(visible) { record in
                            row(record, now: now)
                            Divider().overlay(TrialsStyle.muted.opacity(0.2))
                        }
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Cancelled can still be live", systemImage: "hourglass").font(.headline)
                        Text("Renewal off means no automatic payment is scheduled. Trial access may continue until it ends.")
                            .font(.subheadline).foregroundStyle(TrialsStyle.muted)
                    }.padding(16).overlay(RoundedRectangle(cornerRadius: 12).stroke(TrialsStyle.muted.opacity(0.4)))
                    Text(model.isPreviewMode ? "Sample data · Not real subscribers" : "Based on received Apple updates. Renewal on does not guarantee payment.")
                        .font(.caption).foregroundStyle(TrialsStyle.muted)
                    if let error = trials.error { Text(error).font(.caption) }
                }.padding(24)
            }.refreshable { await trials.load(model) }
        }
        .background(TrialsStyle.navy).foregroundStyle(.white).tint(TrialsStyle.gold)
        .navigationTitle("Trials").navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbarBackground(TrialsStyle.navy, for: .navigationBar, .tabBar)
        .toolbarBackground(.visible, for: .navigationBar, .tabBar)
        .preferredColorScheme(.dark)
    }

    private func filter(_ title: String, value: TrialRenewalStatus?) -> some View {
        Button(title) { status = value }
            .font(.subheadline.weight(.semibold)).padding(.horizontal, 14).frame(minHeight: 44)
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(status == value ? TrialsStyle.gold : TrialsStyle.muted.opacity(0.5)))
            .foregroundStyle(status == value ? TrialsStyle.gold : .white)
            .accessibilityAddTraits(status == value ? .isSelected : [])
    }

    private func row(_ record: TrialRecord, now: Date) -> some View {
        let layout = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10)) : AnyLayout(HStackLayout(alignment: .center, spacing: 12))
        return layout {
            ActivityInventorySlot {
                AppArtwork(url: model.apps.first { $0.id == record.appId }?.iconUrl, name: record.appName, bundledIconName: model.apps.first { $0.id == record.appId }?.bundledIconName).accentColor(TrialsStyle.gold)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(record.appName).font(.headline)
                Text(record.productId).font(.caption).foregroundStyle(TrialsStyle.muted)
                Text("Trial #\(record.id.suffix(6).uppercased())").font(.caption2).foregroundStyle(TrialsStyle.muted)
            }
            if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
            VStack(alignment: typeSize.isAccessibilitySize ? .leading : .trailing, spacing: 6) {
                let remaining = max(1, Int(ceil((Timestamp.date(record.endsAt) ?? now).timeIntervalSince(now) / 60)))
                Text(remaining < 60 ? "Ends in \(remaining)m" : remaining < 1440 ? "Ends in \(Int(ceil(Double(remaining) / 60)))h" : "Ends in \(Int(ceil(Double(remaining) / 1440)))d")
                    .font(.subheadline)
                Label(record.renewalStatus.title, systemImage: record.renewalStatus.symbol)
                    .font(.caption).foregroundStyle(record.renewalStatus.color)
            }
        }.accessibilityElement(children: .combine)
    }
}

// Shared Activity components use the same palette, artwork and clipped corners as Quest.
struct ActivitySceneHeader: View {
    let title: String
    let badge: String
    var topSafeArea: CGFloat = 0
    var topSpacing: CGFloat = 80

    var body: some View {
        QuestScenicHeader(title: title, topSafeArea: topSafeArea, topSpacing: topSpacing) {
            Text(badge).font(.caption.weight(.semibold))
                .foregroundStyle(QuestStyle.muted)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(QuestStyle.navy.opacity(0.9), in: Capsule())
                .overlay(Capsule().stroke(QuestStyle.muted.opacity(0.35)))
        }
    }
}

struct QuestScenicHeader<Trailing: View>: View {
    let title: String
    var systemImage: String? = nil
    var topSafeArea: CGFloat = 0
    var topSpacing: CGFloat = 80
    @ViewBuilder var trailing: Trailing
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
        layout {
            Group {
                if let systemImage {
                    QuestMainPageTitle(title: title, systemImage: systemImage)
                } else {
                    Text(title).font(.system(.largeTitle, design: .serif).bold())
                        .foregroundStyle(.white)
                        .accessibilityAddTraits(.isHeader)
                }
            }
            .shadow(color: QuestStyle.navy.opacity(0.8), radius: 4, y: 2)
            if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
            trailing
        }
        .padding(.top, topSpacing + topSafeArea).padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            GeometryReader { geometry in
                Image("QuestLandscape").resizable().scaledToFill()
                    .frame(width: geometry.size.width + 48, height: geometry.size.height + 90, alignment: .top)
                    .clipped()
                    .overlay(LinearGradient(stops: [
                        .init(color: QuestStyle.navy.opacity(0.1), location: 0),
                        .init(color: QuestStyle.navy.opacity(0.3), location: 0.45),
                        .init(color: QuestStyle.navy, location: 1)
                    ], startPoint: .top, endPoint: .bottom))
                    .offset(x: -24, y: -60)
            }.allowsHitTesting(false).accessibilityHidden(true)
        }
    }
}

struct ActivitySectionPicker: View {
    @Binding var selection: ActivitySection

    var body: some View {
        HStack(spacing: 0) {
            ForEach(ActivitySection.allCases) { section in
                Button { selection = section } label: {
                    HStack(spacing: 8) {
                        if selection == section {
                            Image(systemName: "diamond.fill").font(.system(size: 7)).foregroundStyle(QuestStyle.gold)
                        }
                        Text(section.rawValue).font(.subheadline.weight(.semibold))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .foregroundStyle(selection == section ? .white : QuestStyle.muted)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .padding(.vertical, 3)
                    .background(selection == section ? QuestStyle.gold.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10)
                        .stroke(selection == section ? QuestStyle.gold.opacity(0.85) : .clear, lineWidth: 1))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selection == section ? .isSelected : [])
                .accessibilityLabel(section.rawValue)
                .accessibilityHint("Show \(section.rawValue.lowercased()) in Activity")
                .accessibilityIdentifier("activitySection-" + section.rawValue)
            }
        }
        .background(QuestStyle.navy, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(QuestStyle.muted.opacity(0.25)))

    }
}

struct ActivityInventorySlot<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(5)
            .background(Color.white.opacity(0.035), in: SlotShape())
            .overlay(SlotShape().stroke(QuestStyle.muted.opacity(0.45), lineWidth: 1))
            .overlay(InventoryCornerTrim().stroke(QuestStyle.gold.opacity(0.75), style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round)))
            .shadow(color: .black.opacity(0.2), radius: 2, y: 2)
    }
}

struct InventoryCornerTrim: Shape {
    func path(in rect: CGRect) -> Path {
        Path { path in
            for right in [false, true] {
                for bottom in [false, true] {
                    func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                        CGPoint(x: right ? rect.maxX - x : rect.minX + x,
                                y: bottom ? rect.maxY - y : rect.minY + y)
                    }
                    path.move(to: point(1, 12))
                    path.addLine(to: point(1, 6))
                    path.addLine(to: point(6, 1))
                    path.addLine(to: point(12, 1))
                }
            }
        }
    }
}
