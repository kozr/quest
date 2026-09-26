import Foundation
import SwiftUI

enum TavernRank: String, Codable, CaseIterable {
    case bronze, silver, gold, platinum, diamond
    var title: String { rawValue.capitalized }
    var threshold: String {
        switch self { case .bronze: "$1+"; case .silver: "$100+"; case .gold: "$500+"; case .platinum: "$1k+"; case .diamond: "$10k+" }
    }
    var symbol: String {
        switch self { case .bronze: "shield"; case .silver: "shield.lefthalf.filled"; case .gold: "shield.fill"; case .platinum: "checkmark.shield.fill"; case .diamond: "diamond.fill" }
    }
    var color: Color {
        switch self {
        case .bronze: Color(red: 0.89, green: 0.59, blue: 0.37)
        case .silver: Color(red: 0.70, green: 0.77, blue: 0.86)
        case .gold: QuestStyle.gold
        case .platinum: Color(red: 0.85, green: 0.94, blue: 0.98)
        case .diamond: Color(red: 0.42, green: 0.87, blue: 1)
        }
    }
}
struct TavernProfile: Decodable { let id: String; let name: String; let showRank: Bool }
struct TavernRankSummary: Decodable {
    let rank: TavernRank?; let peakMilliunits: String?; let status: String; let calculatedAt: String; let currency: String
}
struct TavernBlockedMember: Decodable, Identifiable { let id: String; let name: String }
struct TavernSettings: Decodable {
    let profile: TavernProfile?; let rank: TavernRankSummary?; let blocked: [TavernBlockedMember]; let isModerator: Bool
}
struct TavernMessage: Decodable, Identifiable {
    struct Author: Decodable { let id: String; let name: String; let rank: TavernRank? }
    struct Reply: Decodable { let name: String; let text: String }
    let id: String; let author: Author; let text: String; let createdAt: String; let reply: Reply?
    let helpful: Int; let celebrate: Int; let myReaction: String?; let isMine: Bool
    var date: Date { ISO8601DateFormatter.tavern.date(from: createdAt) ?? .distantPast }
}
private extension ISO8601DateFormatter {
    static var tavern: ISO8601DateFormatter {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return formatter
    }
}
struct TavernFeed: Decodable { let messages: [TavernMessage]; let nextCursor: String?; let onlineCount: Int; let onlineCountCapped: Bool }
struct TavernReport: Decodable, Identifiable {
    let id: String; let messageId: String; let reason: String; let createdAt: String; let text: String; let authorId: String?; let name: String
}
struct TavernReports: Decodable { let reports: [TavernReport] }
private struct TavernProfileInput: Encodable { let name: String; let showRank: Bool; let rulesVersion = 1 }
private struct TavernSendInput: Encodable { let id: String; let text: String; let replyTo: String? }
private struct TavernReactionInput: Encodable {
    let kind: String?
    // Null clears a reaction; synthesized Encodable would omit it.
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let kind { try container.encode(kind, forKey: .kind) } else { try container.encodeNil(forKey: .kind) }
    }
    private enum CodingKeys: String, CodingKey { case kind }
}

@MainActor
final class TavernStore: ObservableObject {
    @Published private(set) var settings: TavernSettings?
    @Published private(set) var messages: [TavernMessage] = []
    @Published private(set) var reports: [TavernReport] = []
    @Published private(set) var nextCursor: String?
    @Published private(set) var onlineCount = 0
    @Published private(set) var onlineCountCapped = false
    @Published private(set) var isLoading = false
    @Published private(set) var isBusy = false
    @Published private(set) var unavailable = false
    @Published private(set) var viewingHistory = false
    @Published var error: String?
    @Published var notice: String?
    @Published var draft = ""
    @Published var replyingTo: TavernMessage?
    private var client: APIClient?
    private var context = ""
    private var generation = UUID()
    private var feedRevision = UUID()
    private var settingsRevision = UUID()
    private var pendingSend: (id: String, text: String, replyTo: String?)?

    func configure(client: APIClient?, accountID: String?) {
        let key = client.map { "\(accountID ?? "")|\($0.baseURL.absoluteString)|\($0.token ?? "")" } ?? ""
        guard key != context else { return }
        context = key; generation = UUID(); self.client = client
        settings = nil; messages = []; reports = []; nextCursor = nil; onlineCount = 0
        draft = ""; replyingTo = nil; pendingSend = nil; error = nil; notice = nil
        isLoading = false; isBusy = false; viewingHistory = false; unavailable = false
    }
    private func handle(_ failure: Error) {
        if failure is CancellationError { return }
        if let failure = failure as? ClientError,
           failure.serverCode == "TAVERN_DISABLED" || failure.serverCode == "TAVERN_SUSPENDED" || failure.isUnauthorized {
            generation = UUID(); client = nil; unavailable = true
            settings = nil; messages = []; reports = []; nextCursor = nil; draft = ""; replyingTo = nil; pendingSend = nil
            isLoading = false; isBusy = false
        }
        error = failure.localizedDescription
    }
    func loadSettings() async {
        guard let client else { return }
        let request = generation, revision = UUID(); settingsRevision = revision
        do {
            let value: TavernSettings = try await client.request("/api/tavern/settings")
            guard request == generation, revision == settingsRevision else { return }; settings = value
        } catch { if request == generation && revision == settingsRevision { handle(error) } }
    }
    func refresh(older: Bool = false) async {
        guard let client, settings?.profile != nil, !isLoading, !isBusy else { return }
        if older && nextCursor == nil { return }
        let request = generation, revision = UUID(); feedRevision = revision; isLoading = true
        defer { if request == generation && revision == feedRevision { isLoading = false } }
        do {
            let query = older ? [URLQueryItem(name: "before", value: nextCursor)] : []
            let feed: TavernFeed = try await client.request("/api/tavern/messages", query: query)
            guard request == generation, revision == feedRevision else { return }
            if older {
                let existing = Set(messages.map(\.id)); messages = feed.messages.filter { !existing.contains($0.id) } + messages
                viewingHistory = true
            } else { messages = feed.messages; viewingHistory = false }
            nextCursor = feed.nextCursor; onlineCount = feed.onlineCount; onlineCountCapped = feed.onlineCountCapped; error = nil
        } catch { if request == generation && revision == feedRevision { handle(error) } }
    }
    @discardableResult
    private func mutate(_ operation: (APIClient) async throws -> Void) async -> Bool {
        guard let client, !isBusy else { return false }
        // A pre-mutation feed/settings response must not restore blocked members or old visibility.
        feedRevision = UUID(); settingsRevision = UUID(); isLoading = false
        let request = generation; isBusy = true; error = nil; notice = nil
        defer { if request == generation { isBusy = false } }
        do { try await operation(client); return request == generation }
        catch { if request == generation { handle(error) }; return false }
    }
    func save(name: String, showRank: Bool) async -> Bool {
        let saved = await mutate { client in
            let _: TavernProfileResponse = try await client.send("/api/tavern/settings", method: "PUT", body: TavernProfileInput(name: name, showRank: showRank))
        }
        if saved { await loadSettings(); await refresh() }; return saved
    }
    func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines), reply = replyingTo?.id
        guard !text.isEmpty, text.count <= 2000 else { return }
        if pendingSend?.text != text || pendingSend?.replyTo != reply { pendingSend = (UUID().uuidString.lowercased(), text, reply) }
        let messageID = pendingSend!.id
        let sent = await mutate { client in
            let _: OKResponse = try await client.send("/api/tavern/messages", body: TavernSendInput(id: messageID, text: text, replyTo: reply))
        }
        if sent {
            if draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { draft = ""; replyingTo = nil }
            pendingSend = nil; await refresh()
        }
    }
    func react(_ message: TavernMessage, kind: String) async {
        let success = await mutate { client in
            let _: OKResponse = try await client.send("/api/tavern/messages/\(message.id)/reaction", method: "PUT", body: TavernReactionInput(kind: message.myReaction == kind ? nil : kind))
        }
        if success { await refresh() }
    }
    func remove(_ message: TavernMessage) async {
        let success = await mutate { client in let _: OKResponse = try await client.request("/api/tavern/messages/\(message.id)", method: "DELETE") }
        if success { await refresh() }
    }
    func report(_ message: TavernMessage, reason: String) async {
        if await mutate({ client in let _: OKResponse = try await client.send("/api/tavern/messages/\(message.id)/report", body: ["reason": reason]) }) {
            notice = "Report sent to the Tavern moderators."
        }
    }
    func block(_ memberID: String, remove: Bool = false) async {
        let success = await mutate { client in let _: OKResponse = try await client.request("/api/tavern/blocks/\(memberID)", method: remove ? "DELETE" : "PUT") }
        if success { replyingTo = nil; await loadSettings(); await refresh() }
    }
    func loadReports() async {
        guard let client, settings?.isModerator == true else { return }
        let request = generation
        do {
            let value: TavernReports = try await client.request("/api/tavern/moderation/reports")
            if request == generation { reports = value.reports }
        } catch { if request == generation { handle(error) } }
    }
    func moderate(_ report: TavernReport, action: String) async {
        let success = await mutate { client in let _: OKResponse = try await client.send("/api/tavern/moderation/reports/\(report.id)", body: ["action": action]) }
        if success { await loadReports(); await refresh() }
    }
}
private struct TavernProfileResponse: Decodable { let profile: TavernProfile }
