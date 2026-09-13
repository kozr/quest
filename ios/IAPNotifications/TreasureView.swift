import SwiftUI

/// A phone-local collection journal. Activity remains the source of truth.
struct TreasureLedger: Codable {
    var startedAt: Date
    var watermark: Date
    var boundaryIDs: Set<String>
    var pending: [ActivityEvent] = []

    static func begin(with events: [ActivityEvent], now: Date = Date()) -> Self {
        let latest = events.compactMap { Timestamp.date($0.receivedAt) }.max() ?? .distantPast
        return Self(startedAt: now, watermark: latest,
                    boundaryIDs: Set(events.filter { Timestamp.date($0.receivedAt) == latest }.map(\.id)))
    }

    mutating func ingest(_ events: [ActivityEvent]) {
        var known = Set(pending.map(\.id))
        for event in events {
            guard let received = Timestamp.date(event.receivedAt),
                  received > watermark || (received == watermark && !boundaryIDs.contains(event.id)),
                  let occurred = Timestamp.date(event.occurredAt), occurred >= startedAt,
                  Self.qualifies(event), known.insert(event.id).inserted else { continue }
            pending.append(event)
        }
        if let latest = events.compactMap({ Timestamp.date($0.receivedAt) }).max(), latest >= watermark {
            let ids = Set(events.filter { Timestamp.date($0.receivedAt) == latest }.map(\.id))
            boundaryIDs = latest == watermark ? boundaryIDs.union(ids) : ids
            watermark = latest
        }
    }

    static func qualifies(_ event: ActivityEvent, preview: Bool = false) -> Bool {
        event.environment == (preview ? "Demo" : "Production") && event.isMonetary
            && ["sale", "renewal"].contains(event.kind) && (event.amountMilliunits ?? 0) > 0
            && !(event.currency ?? "").isEmpty
    }

    static func storageKey(server: String, account: String) -> String {
        "quest.treasure.v1." + Data("\(server)\n\(account)".utf8).base64EncodedString()
    }
}

struct TreasureTotal: Identifiable {
    let id: String
    let amount: Decimal
    var formatted: String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = id
        formatter.currencySymbol = id
        return formatter.string(from: NSDecimalNumber(decimal: amount / 1_000)) ?? id
    }

    static func summarize(_ events: [ActivityEvent]) -> [Self] {
        var totals: [String: Decimal] = [:]
        for event in events {
            guard let currency = event.currency, let amount = event.amountMilliunits else { continue }
            totals[currency, default: 0] += Decimal(amount)
        }
        return totals.keys.sorted().map { Self(id: $0, amount: totals[$0]!) }
    }
}

struct TreasureView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var opened = false
    @State private var reveal: [ActivityEvent] = []
    @State private var hapticTrigger = 0

    private var ready: Bool { !model.treasureSales.isEmpty }

    var body: some View {
        VStack(spacing: 16) {
            Text(opened ? "Your work found its people." : ready ? "A little treasure awaits." : "Your next chapter is being built.")
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            Button(action: openChest) {
                ZStack {
                    Image("TreasureClosed").resizable().scaledToFit().opacity(opened ? 0 : 1)
                    Image("TreasureOpen").resizable().scaledToFit().opacity(opened ? 1 : 0)
                }
                .frame(maxWidth: 240)
                .frame(height: 220)
                .scaleEffect(opened && !reduceMotion ? 1.04 : 1)
                .opacity(!ready && !opened ? 0.65 : 1)
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!ready || opened)
            .accessibilityLabel(opened ? "Treasure chest opened" : "Open treasure chest")
            .accessibilityHint(ready ? "Reveal your new sales and paid renewals." : "Unlocks after new sales arrive.")
            .accessibilityIdentifier("treasureChest")

            if opened {
                VStack(spacing: 6) {
                    ForEach(TreasureTotal.summarize(reveal)) { total in
                        Text(total.formatted).font(.largeTitle.weight(.semibold)).monospacedDigit()
                            .contentTransition(.numericText())
                    }
                    Text("\(reveal.count) \(reveal.count == 1 ? "sale" : "sales") · Purchases and paid renewals")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Text(model.isPreviewMode ? "Sample sales · No real money" : "Gross sales before fees and refunds")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .multilineTextAlignment(.center)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("treasureReveal")
            } else {
                Text(ready ? "New sales have arrived. Take a moment to enjoy them."
                     : "Keep creating. Your chest unlocks when new sales arrive.")
                    .font(.subheadline).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            if ready && !opened {
                Button("Open your chest", action: openChest)
                    .buttonStyle(.borderedProminent).controlSize(.large)
                    .accessibilityIdentifier("openTreasure")
            } else if opened {
                Button("Back to the journey") { opened = false; reveal = [] }
                    .buttonStyle(.bordered).controlSize(.large)
            }
            if let error = model.treasureError {
                Text(error).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
        .sensoryFeedback(.success, trigger: hapticTrigger)
        .onChange(of: model.treasureVisit) { _, _ in opened = false; reveal = [] }
        .onChange(of: model.user?.id) { _, _ in opened = false; reveal = [] }
    }

    private func openChest() {
        guard ready, !opened else { return }
        let sales = model.openTreasure()
        guard !sales.isEmpty else { return }
        reveal = sales
        withAnimation(reduceMotion ? .linear(duration: 0.15) : .easeOut(duration: 0.6)) { opened = true }
        hapticTrigger += 1
    }
}
