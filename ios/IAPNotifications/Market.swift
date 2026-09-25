import Foundation

enum MarketSignalKind: String, Codable, CaseIterable {
    case recurringProblem = "recurring_problem"
    case competitorComplaint = "competitor_complaint"
    case workaround
}

enum MarketProspectStatus: String, Codable, CaseIterable {
    case potentialFit = "potential_fit"
    case needsReview = "needs_review"
    case notAProspect = "not_a_prospect"
}

enum MarketSourceKind: String, Codable, CaseIterable {
    case post
    case comment
}

enum MarketCoverage: String, Codable {
    case partial
    case completeForConfiguredScan = "complete_for_configured_scan"
}

enum MarketScanStatus: String, Codable, CaseIterable {
    case queued
    case collecting
    case analyzing
    case complete
    case failed
    case cancelled

    var isActive: Bool { self == .queued || self == .collecting || self == .analyzing }
}

enum MarketSegment: String, CaseIterable, Identifiable {
    case problems = "Problems"
    case people = "People"
    var id: String { rawValue }
}

struct MarketSourceDTO: Codable, Equatable, Identifiable {
    let id: String
    let provider: String
    let kind: MarketSourceKind
    let threadId: String
    let parentId: String?
    let authorKey: String?
    let authorDisplayName: String?
    let title: String?
    let text: String
    let community: String
    let url: String?
    let createdAt: String?
    let fetchedAt: String?
    let contentHash: String
    let expiresAt: String?
    let isSample: Bool

    var verifiedRedditURL: URL? {
        guard !isSample, provider == "reddit",
              let raw = url,
              let parts = URLComponents(string: raw),
              parts.scheme?.lowercased() == "https",
              let host = parts.host?.lowercased(), host == "reddit.com" || host == "www.reddit.com",
              parts.user == nil, parts.password == nil, parts.port == nil,
              parts.query == nil, parts.fragment == nil else { return nil }
        let path = parts.path.split(separator: "/").map(String.init)
        let identityParts = id.split(separator: ":", omittingEmptySubsequences: false)
        guard identityParts.count == 3, identityParts[0] == "reddit",
              (kind == .post && identityParts[1] == "post") || (kind == .comment && identityParts[1] == "comment") else { return nil }
        var nativeID = String(identityParts[2])
        if nativeID.hasPrefix("t1_") || nativeID.hasPrefix("t3_") { nativeID.removeFirst(3) }
        var nativeThreadID = threadId
        if nativeThreadID.hasPrefix("t3_") { nativeThreadID.removeFirst(3) }
        guard nativeID.range(of: "^[A-Za-z0-9]{1,20}$", options: .regularExpression) != nil,
              nativeThreadID.range(of: "^[A-Za-z0-9]{1,20}$", options: .regularExpression) != nil,
              community.range(of: "^[A-Za-z0-9_]{2,21}$", options: .regularExpression) != nil,
              path.count >= 4,
              path[0].lowercased() == "r",
              path[1].lowercased() == community.lowercased(),
              path[2].lowercased() == "comments",
              path[3] == nativeThreadID else { return nil }
        if kind == .comment {
            guard path.count == 6, path[5] == nativeID else { return nil }
        } else {
            guard nativeID == nativeThreadID, (4...5).contains(path.count) else { return nil }
        }
        if let parentId, parentId.hasPrefix("t3_"), String(parentId.dropFirst(3)) != nativeThreadID { return nil }
        var canonical = URLComponents()
        canonical.scheme = "https"
        canonical.host = "www.reddit.com"
        canonical.path = parts.path
        guard let result = canonical.url, result.host == "www.reddit.com" else { return nil }
        return result
    }
}

struct MarketEvidenceDTO: Codable, Equatable, Identifiable {
    let id: String
    let problemId: String
    let signalKind: MarketSignalKind
    let quote: String
    let explanation: String
    let prospectStatus: MarketProspectStatus
    let prospectReason: String
    let matchedCapabilityIds: [String]
    let competitorName: String?
    let sourceContentHash: String
    let source: MarketSourceDTO
    let isSample: Bool
}

struct MarketProblem: Codable, Equatable, Identifiable {
    let id: String
    let title: String
    let summary: String
    let signalKind: MarketSignalKind
    let peopleCount: Int
    let conversationCount: Int
    let observationCount: Int
    let representativeEvidenceId: String?
    let lastObservedAt: String?
}

struct MarketSourceCoverage: Codable, Equatable {
    let provider: String
    let collectedCount: Int
}

struct MarketScanDTO: Codable, Equatable, Identifiable {
    let id: String
    let status: MarketScanStatus
    let profileRevision: Int
    let requestedAt: String?
    let startedAt: String?
    let finishedAt: String?
    let nextRunAt: String?
    let retryAfter: String?
    let reasonCode: String?
    let canRetry: Bool
}

struct MarketResearch: Codable, Equatable {
    struct Finding: Codable, Equatable {
        struct Source: Codable, Equatable {
            let url: String
            let title: String
            var publicURL: URL? {
                guard let parts = URLComponents(string: url), parts.scheme == "https",
                      let host = parts.host, host.contains("."), host != "localhost",
                      !host.hasSuffix(".local"), parts.user == nil, parts.password == nil,
                      parts.port == nil else { return nil }
                return parts.url
            }
        }
        let title: String
        let summary: String
        let sources: [Source]
    }
    let findings: [Finding]
}

struct MarketOverview: Codable, Equatable {
    let appId: String
    let profileRevision: Int
    let snapshotId: String?
    let generatedAt: String?
    let windowStart: String?
    let windowEnd: String?
    let coverage: MarketCoverage
    let sources: [MarketSourceCoverage]
    let featuredProblemId: String?
    let problems: [MarketProblem]
    let evidence: [MarketEvidenceDTO]
    let scan: MarketScanDTO?
    let isSample: Bool

    var research: MarketResearch? = nil

    var featuredProblem: MarketProblem? {
        if let featuredProblemId, let featured = problems.first(where: { $0.id == featuredProblemId }) {
            return featured
        }
        return problems.first
    }

    func evidence(for problem: MarketProblem) -> MarketEvidenceDTO? {
        if let id = problem.representativeEvidenceId, let match = evidence.first(where: { $0.id == id }) {
            return match
        }
        return evidence.first(where: { $0.problemId == problem.id })
    }
}

struct MarketResearchProspect: Codable, Equatable {
    struct Evidence: Codable, Equatable {
        let url: String
        let title: String
        let excerpt: String
        let publishedAt: String?
        let verifiedAt: String
        let verification: String
        var publicURL: URL? { MarketResearchProspect.publicURL(url) }
    }
    let id: String
    let provider: String
    let publicHandle: String
    let displayName: String
    let profileUrl: String
    let relationship: String
    let status: String
    let problem: String
    let fitReason: String
    let matchedCapabilityIds: [String]
    let evidence: [Evidence]
    var profileURL: URL? { Self.publicURL(profileUrl) }
    var platformLabel: String { provider == "youtube" ? "YouTube" : provider == "x" ? "X" : "Reddit" }
    var relationshipLabel: String { relationship == "creator_partner" ? "Creator partner" : "Potential user" }
    static func publicURL(_ raw: String) -> URL? {
        guard let parts = URLComponents(string: raw), parts.scheme == "https",
              let host = parts.host?.lowercased(),
              ["reddit.com", "www.reddit.com", "x.com", "twitter.com", "www.youtube.com", "youtube.com", "youtu.be"].contains(host),
              parts.user == nil, parts.password == nil, parts.port == nil else { return nil }
        return parts.url
    }
}

struct MarketPersonDTO: Codable, Equatable, Identifiable {
    var researchProspect: MarketResearchProspect? = nil
    let id: String
    let authorKey: String?
    let authorDisplayName: String?
    let prospectStatus: MarketProspectStatus
    let prospectReason: String
    let problemIds: [String]
    let evidence: [MarketEvidenceDTO]
    let isSample: Bool
}

struct MarketPeoplePageDTO: Codable, Equatable {
    let appId: String
    let profileRevision: Int
    let snapshotId: String?
    let problemId: String?
    let people: [MarketPersonDTO]
    let nextCursor: String?
    let coverage: MarketCoverage
    let windowStart: String?
    let windowEnd: String?
}

struct MarketScanRequest: Encodable {
    let expectedRevision: Int
    let idempotencyKey: String
}

struct MarketScanStartResponse: Decodable {
    let scan: MarketScanDTO
}

struct MarketPaginationRequest {
    let cursor: String?
    let limit: Int

    init(cursor: String? = nil, limit: Int = 20) {
        self.cursor = cursor
        self.limit = min(max(limit, 1), 50)
    }
}

enum MarketPeopleDestination: Equatable {
    case open(URL)
    case sampleExplanation
    case unavailable

    static func forSource(_ source: MarketSourceDTO) -> Self {
        if source.isSample { return .sampleExplanation }
        guard let url = source.verifiedRedditURL else { return .unavailable }
        return .open(url)
    }
}
