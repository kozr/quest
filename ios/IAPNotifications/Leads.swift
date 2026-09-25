import Foundation

struct LeadAccessResponse: Decodable, Equatable {
    let enabled: Bool
    let aiAvailable: Bool
    let reasonCode: String?
}

struct LeadProblem: Codable, Equatable, Identifiable {
    let id: String
    var text: String
}

struct LeadCapability: Codable, Equatable, Identifiable {
    let id: String
    var text: String
    var evidenceQuote: String?
    var source: String
}

struct LeadDescriptionSource: Codable, Equatable {
    let appleId: String
    let country: String
    let fetchedAt: String
    let contentHash: String
}

struct LeadProfile: Decodable, Equatable {
    let appId: String
    let schemaVersion: Int
    let revision: Int
    let enabled: Bool
    let problems: [LeadProblem]
    let capabilities: [LeadCapability]
    let communities: [String]
    let keywords: [String]
    let descriptionSource: LeadDescriptionSource?
    let confirmedAt: String
    let updatedAt: String
}

struct LeadLegacySuggestions: Decodable, Equatable {
    let communities: [String]
    let keywords: [String]
}

struct LeadProfileStatus: Decodable, Equatable {
    let code: String
    let lastCollectedAt: String?
    let lastQualifiedAt: String?
    let nextCheckAt: String?
    let partial: Bool
    let limited: Bool?
    var progress: LeadScanProgress? = nil
}

struct LeadScanProgress: Decodable, Equatable {
    let phase: String
    let batchId: String?
    let fraction: Double?
    let post: LeadReviewPost?
    var canStart: Bool? = nil
    var background: Bool? = nil

    var isWorking: Bool { phase == "collecting" || phase == "assessing" }
    var shouldPoll: Bool { isWorking || phase == "queued" || phase == "waiting" }
    var normalizedFraction: Double? {
        guard let fraction, fraction.isFinite else { return nil }
        return min(1, max(0, fraction))
    }
}

struct LeadReviewPost: Decodable, Equatable {
    let id: String
    let community: String
    let title: String
    let excerpt: String
    let state: String
}

struct LeadScanStartRequest: Encodable {
    let expectedRevision: Int
}

struct LeadScanStartResponse: Decodable {
    let started: Bool
    let progress: LeadScanProgress
}

struct LeadProfileResponse: Decodable {
    let profile: LeadProfile?
    let legacySuggestions: LeadLegacySuggestions?
    let status: LeadProfileStatus
}

struct LeadProfileSaveResponse: Decodable {
    let profile: LeadProfile
}

struct LeadItem: Decodable, Equatable, Identifiable {
    let id: String
    let appId: String
    let postId: String
    let community: String
    let title: String
    let excerpt: String
    let url: String?
    let createdAt: String
    let whyItFits: String
    let qualifiedAt: String?

    var isSample: Bool { id.hasPrefix("sample-lead-") }

    init(id: String, appId: String, postId: String, community: String, title: String,
         excerpt: String, url: String? = nil, createdAt: String, whyItFits: String,
         qualifiedAt: String? = nil) {
        self.id = id
        self.appId = appId
        self.postId = postId
        self.community = community
        self.title = title
        self.excerpt = excerpt
        self.url = url
        self.createdAt = createdAt
        self.whyItFits = whyItFits
        self.qualifiedAt = qualifiedAt
    }
}

struct LeadsPageResponse: Decodable {
    var locked: LockedQuests? = nil
    let leads: [LeadItem]
    let nextCursor: String?
    let status: LeadPageStatus
}

struct LeadPageStatus: Decodable {
    let code: String
    let partial: Bool
    let limited: Bool?
    var progress: LeadScanProgress? = nil
}

struct LeadDraftRequest: Encodable {
    let requestId: String
}

struct LeadDraftCreateResponse: Decodable {
    let jobId: String?
    let status: String
    let reasonCode: String?
}

struct LeadDraftProblem: Decodable, Equatable, Identifiable {
    var id: String { text.lowercased() }
    let text: String
    let rationale: String
}

struct LeadDraftCapability: Decodable, Equatable, Identifiable {
    var id: String { text.lowercased() }
    let text: String
    let evidenceQuote: String
    let rationale: String
}

struct LeadDraftSource: Decodable, Equatable {
    let appleId: String
    let country: String
    let fetchedAt: String
}

struct LeadSetupDraft: Decodable, Equatable {
    let id: String
    let problems: [LeadDraftProblem]
    let capabilities: [LeadDraftCapability]
    let suggestedCommunities: [String]
    let source: LeadDraftSource
    let sourceHash: String
}

struct LeadDraftStatusResponse: Decodable {
    let status: String
    let draft: LeadSetupDraft?
    let reasonCode: String?
}

struct LeadProfileRowInput: Encodable, Equatable {
    let id: String?
    let text: String

    init(id: String? = nil, text: String) {
        self.id = id
        self.text = text
    }
}

struct LeadProfileSaveRequest: Encodable {
    let expectedRevision: Int
    let enabled: Bool
    let problems: [LeadProfileRowInput]
    let capabilities: [LeadProfileRowInput]
    let communities: [String]
    let keywords: [String]
    let draftId: String?
}

struct LeadDismissalRequest: Encodable {
    let mutationId: String
}

struct LeadMutationResponse: Decodable {
    let ok: Bool
    let mutationId: String?
}

struct LeadUndoAction: Equatable, Identifiable {
    let id: UUID
    let appId: String
    let profileRevision: Int?
    let lead: LeadItem
    let mutationId: String

    init(appId: String, profileRevision: Int?, lead: LeadItem, mutationId: String = UUID().uuidString) {
        self.id = UUID()
        self.appId = appId
        self.profileRevision = profileRevision
        self.lead = lead
        self.mutationId = mutationId
    }
}

enum LeadOpenDestination: Equatable {
    case reddit(URL)
    case sampleExplanation
    case unavailable
}

enum LeadPickUpResult: Equatable {
    case opened(URL)
    case sampleExplanation
    case unavailable
}

enum LeadURL {
    static func destination(for lead: LeadItem) -> LeadOpenDestination {
        guard !lead.isSample else { return .sampleExplanation }
        guard let raw = lead.url,
              let parts = URLComponents(string: raw),
              parts.scheme?.lowercased() == "https",
              let host = parts.host?.lowercased(),
              host == "reddit.com" || host == "www.reddit.com",
              parts.user == nil, parts.password == nil, parts.port == nil,
              parts.query == nil, parts.fragment == nil,
              let community = safeCommunity(lead.community),
              let postId = safePostID(lead.postId)
        else { return .unavailable }

        let segments = parts.path.split(separator: "/").map(String.init)
        guard segments.count >= 4,
              segments[0].lowercased() == "r",
              segments[1].lowercased() == community.lowercased(),
              segments[2].lowercased() == "comments",
              segments[3].lowercased() == postId.lowercased()
        else { return .unavailable }

        var canonical = URLComponents()
        canonical.scheme = "https"
        canonical.host = "www.reddit.com"
        canonical.path = "/r/\(community)/comments/\(postId)/"
        guard let url = canonical.url else { return .unavailable }
        return .reddit(url)
    }

    static func performPickUp(for lead: LeadItem, openURL: (URL) -> Void) -> LeadPickUpResult {
        switch destination(for: lead) {
        case .reddit(let url):
            openURL(url)
            return .opened(url)
        case .sampleExplanation:
            return .sampleExplanation
        case .unavailable:
            return .unavailable
        }
    }

    private static func safeCommunity(_ value: String) -> String? {
        value.range(of: "^[A-Za-z0-9_]{2,21}$", options: .regularExpression) == nil ? nil : value
    }

    private static func safePostID(_ value: String) -> String? {
        value.range(of: "^[A-Za-z0-9]{1,20}$", options: .regularExpression) == nil ? nil : value
    }
}

enum LeadPreviewFixtures {
    static func leads(app: ConnectedApp, now: Date = Date()) -> [LeadItem] {
        let formatter = ISO8601DateFormatter()
        let orbit = app.id == "demo-orbit"
        let examples: [(String, String, String, String)] = orbit ? [
            ("journaling", "Is there an app for quick daily journal entries?",
             "Is there an app where I can jot down a few thoughts each day and revisit older entries?",
             "Keeps daily entries easy to revisit."),
            ("Journaling", "Any app that helps build an easy journaling habit?",
             "I’m looking for an app to save a few thoughts at the end of each day and look back on them later.",
             "Keeps daily entries easy to revisit.")
        ] : [
            ("productivity", "Need a focus timer that helps me start",
             "I keep stalling before study sessions. Looking for a lightweight timer that gives me a clear start and a short break.",
             "Adds structure to study sessions."),
            ("study", "Looking for a simple way to stay on task while studying",
             "I’d like to plan a work block, silence distractions for a while, then take a timed break.",
             "Times study blocks and breaks.")
        ]
        return [
            LeadItem(id: "sample-lead-\(app.id)-one", appId: app.id, postId: "sample-one",
                     community: examples[0].0, title: examples[0].1, excerpt: examples[0].2,
                     createdAt: formatter.string(from: now.addingTimeInterval(-42 * 60)),
                     whyItFits: examples[0].3),
            LeadItem(id: "sample-lead-\(app.id)-two", appId: app.id, postId: "sample-two",
                     community: examples[1].0, title: examples[1].1, excerpt: examples[1].2,
                     createdAt: formatter.string(from: now.addingTimeInterval(-3 * 3600)),
                     whyItFits: examples[1].3)
        ]
    }

    static func profile(appId: String) -> LeadProfile {
        let now = ISO8601DateFormatter().string(from: Date())
        let orbit = appId == "demo-orbit"
        return LeadProfile(appId: appId, schemaVersion: 1, revision: 1, enabled: true,
            problems: [LeadProblem(id: "sample-problem", text: orbit ? "Build a daily journaling habit" : "Stay focused during planned work sessions")],
            capabilities: [LeadCapability(id: "sample-capability", text: orbit ? "Write and revisit journal entries" : "Run focus sessions with timed breaks",
                                          evidenceQuote: nil, source: "user_confirmed")],
            communities: orbit ? ["journaling", "Journaling"] : ["productivity", "study"],
            keywords: [], descriptionSource: nil,
            confirmedAt: now, updatedAt: now)
    }
}

extension LeadProfileStatus {
    static func local(code: String, partial: Bool = false) -> LeadProfileStatus {
        LeadProfileStatus(code: code, lastCollectedAt: nil, lastQualifiedAt: nil,
                          nextCheckAt: nil, partial: partial, limited: nil)
    }
}
