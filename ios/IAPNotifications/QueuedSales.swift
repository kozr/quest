import Foundation
import CryptoKit

/// A phone-local reveal journal. Activity remains the source of truth.
struct SalesQueue: Codable {
    let startedAt: Date
    private(set) var watermark: Date
    private(set) var boundaryIDs: Set<String>
    private(set) var pending: [ActivityEvent] = []

    /// Existing history establishes a baseline; it is not presented as new loot.
    static func begin(with events: [ActivityEvent], now: Date) throws -> Self {
        let dates = try events.map(receivedDate)
        let latest = dates.max() ?? .distantPast
        return Self(startedAt: now, watermark: latest,
                    boundaryIDs: Set(zip(events, dates).filter { $0.1 == latest }.map { $0.0.id }))
    }

    static func qualifies(_ event: ActivityEvent, preview: Bool = false) -> Bool {
        event.environment == (preview ? "Demo" : "Production") && event.isMonetary
            && ["sale", "renewal"].contains(event.kind) && (event.amountMilliunits ?? 0) > 0
            && !(event.currency ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func receivedDate(_ event: ActivityEvent) throws -> Date {
        guard let date = Timestamp.date(event.receivedAt) else {
            throw ClientError.message("Sales updates could not be read. Please refresh to try again.")
        }
        return date
    }

    /// Commit only a complete fetch, never individual pages fetched newest-first.
    mutating func ingest(_ events: [ActivityEvent]) throws {
        let dates = try events.map(Self.receivedDate)
        var known = Set(pending.map(\.id))
        for (event, received) in zip(events, dates) {
            guard received > watermark || (received == watermark && !boundaryIDs.contains(event.id)),
                  Self.qualifies(event) else { continue }
            guard let occurred = Timestamp.date(event.occurredAt) else {
                throw ClientError.message("A sale has an unreadable date. Please refresh to try again.")
            }
            // Transactions predating tracking remain in Activity, including imported history.
            guard occurred >= startedAt, known.insert(event.id).inserted else { continue }
            pending.append(event)
        }
        if let latest = dates.max(), latest >= watermark {
            let ids = Set(zip(events, dates).filter { $0.1 == latest }.map { $0.0.id })
            boundaryIDs = latest == watermark ? boundaryIDs.union(ids) : ids
            watermark = latest
        }
        pending.sort { ($0.receivedAt, $0.id) < ($1.receivedAt, $1.id) }
    }

    mutating func acknowledge(ids: Set<String>) {
        pending.removeAll { ids.contains($0.id) }
    }

    /// Removing an app must also remove its locally captured purchase details.
    /// Keep the checkpoint so retained apps do not replay already revealed sales.
    mutating func retainApps(_ appIDs: Set<String>) {
        pending.removeAll { !appIDs.contains($0.appId) }
    }
}

struct SalesQueueStore {
    let directory: URL

    static var local: Self {
        Self(directory: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("QueuedSales", isDirectory: true))
    }

    func fileURL(server: String, account: String) -> URL {
        let digest = SHA256.hash(data: Data("\(server)\n\(account)".utf8))
            .map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(digest + ".json")
    }

    func read(server: String, account: String) throws -> SalesQueue? {
        let url = fileURL(server: server, account: account)
        do { return try JSONDecoder().decode(SalesQueue.self, from: Data(contentsOf: url)) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
    }

    func write(_ queue: SalesQueue, server: String, account: String) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var folder = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try folder.setResourceValues(values)
        try JSONEncoder().encode(queue).write(to: fileURL(server: server, account: account),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func remove(server: String, account: String) throws {
        do { try FileManager.default.removeItem(at: fileURL(server: server, account: account)) }
        catch let error as CocoaError where error.code == .fileNoSuchFile { return }
    }

    /// Includes orphaned journals left by earlier versions or previously signed-in accounts.
    func removeAll() throws {
        do { try FileManager.default.removeItem(at: directory) }
        catch let error as CocoaError where error.code == .fileNoSuchFile { return }
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
