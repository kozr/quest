import Foundation

enum OnboardingStage: String, Codable, CaseIterable {
    case app, quest, first, trial, notifications, complete
}

struct QuestOnboardingState: Codable, Equatable {
    var stage: OnboardingStage
    var legacy: Bool? = nil
    var appId: String? = nil
    var trialStartedAt: Double? = nil
    var trialEndsAt: Double? = nil
    var trialActive: Bool = false
    var trialAvailable: Bool = true

    var hasActiveTrial: Bool {
        trialActive && (trialEndsAt ?? 0) > Date().timeIntervalSince1970 * 1000
    }
}

struct LockedQuestPreview: Decodable, Equatable, Identifiable {
    let id: String
    let community: String
}

struct LockedQuests: Decodable, Equatable {
    let count: Int
    let hasMore: Bool
    let previews: [LockedQuestPreview]

    var title: String {
        guard count > 0 else { return "More quests" }
        return "\(count)\(hasMore ? "+" : "") more \(count == 1 && !hasMore ? "quest" : "quests")"
    }
}

struct AppStoreMatch: Decodable, Identifiable, Equatable {
    var id: String { bundleId }
    let name: String
    let bundleId: String
    let appleId: String
    var developer: String? = nil
    let iconUrl: String?
    var appStoreUrl: String? = nil
    var bundledIconName: String? = nil

    init(app: ConnectedApp) {
        name = app.name; bundleId = app.bundleId; appleId = app.appleId
        iconUrl = app.iconUrl; bundledIconName = app.bundledIconName
    }
}

/// Copied selection and expansion are independent: collapsing never clears the gold number.
struct OnboardingReplySelection: Equatable {
    var expandedID: String?
    var copiedID: String?

    mutating func toggle(_ id: String) { expandedID = expandedID == id ? nil : id }
    mutating func copied(_ id: String) { copiedID = id; expandedID = nil }
}

enum StoreConnectionProvider: String, Codable, CaseIterable {
    case apple, revenuecat

    var title: String { self == .apple ? "App Store Connect" : "RevenueCat" }
    var subtitle: String { self == .apple ? "Direct from Apple" : "Use your existing setup" }
    var symbol: String { self == .apple ? "app.badge" : "link" }

    func dashboardURL(appleID: String) -> URL {
        if self == .apple, !appleID.isEmpty, appleID.allSatisfy(\.isNumber) {
            return URL(string: "https://appstoreconnect.apple.com/apps/\(appleID)/distribution/info")!
        }
        return URL(string: self == .apple ? "https://appstoreconnect.apple.com/apps" : "https://app.revenuecat.com/")!
    }

    /// Never copy a credential-bearing endpoint from another origin or environment.
    func notificationURL(for app: ConnectedApp, serverURL: String) -> URL? {
        let value = self == .apple ? app.webhookUrls.production : app.forwardingUrl
        guard let value, let url = URL(string: value), let server = URL(string: serverURL),
              url.scheme == "https", url.host == server.host, url.port == server.port,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { return nil }
        let parts = url.path.split(separator: "/")
        guard parts.count == 4, parts[0] == "webhooks", parts[1] == "apple",
              parts[3] == (self == .apple ? "production" : "forward") else { return nil }
        return url
    }
}

enum StoreConnectionStep: String, Codable { case provider, guide, status }

/// Navigation progress is local; only a server-verified production event confirms a store.
struct StoreConnectionProgress: Codable, Equatable {
    var provider: StoreConnectionProvider = .apple
    var step: StoreConnectionStep = .provider
    var pushPromptSeen = false
    var started = false

    static func key(server: String, userID: String, appID: String) -> String {
        // Encode components to avoid separator collisions and cross-account progress reuse.
        (try? JSONEncoder().encode([server, userID, appID]).base64EncodedString()) ?? ""
    }
}

extension ConnectedApp {
    var hasVerifiedProductionConnection: Bool {
        guard let value = lastProductionEventAt else { return false }
        return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
