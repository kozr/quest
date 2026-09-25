import Foundation

struct Account: Codable, Equatable {
    let id: String
    let email: String
}

/// Public, offline product preview. Never creates an account, webhook, or push job.
enum PreviewContent {
    static let apps: [ConnectedApp] = [
        ConnectedApp(id: "demo-orbit", name: "Orbit Journal", bundleId: "com.example.orbit", appleId: "0", source: "apple", iconUrl: nil,
                     createdAt: "2026-09-01T12:00:00Z", webhookUrls: .init(production: "", sandbox: ""),
                     lastProductionEventAt: nil, lastSandboxEventAt: nil, forwardingUrl: nil, bundledIconName: "DemoOrbitIcon"),
        ConnectedApp(id: "demo-focus", name: "Pocket Focus", bundleId: "com.example.focus", appleId: "0", source: "apple", iconUrl: nil,
                     createdAt: "2026-09-01T12:00:00Z", webhookUrls: .init(production: "", sandbox: ""),
                     lastProductionEventAt: nil, lastSandboxEventAt: nil, forwardingUrl: nil, bundledIconName: "DemoFocusIcon")
    ]
    static func events(now: Date = Date()) -> [ActivityEvent] {
        let examples: [(String, String, String, Int64?, Int)] = [
            ("sale", "New purchase", "A permanent unlock was purchased.", 12990, 0),
            ("renewal", "Subscription renewed", "A monthly subscription renewed.", 4990, 1),
            ("refund", "Refund issued", "A purchase was fully refunded.", -2990, 0),
            ("trial", "Free trial started", "A new customer started a free trial.", 0, 1),
            ("sale", "New purchase", "A pack of consumable credits was purchased.", 1990, 0),
            ("auto_renew_disabled", "Auto-renew turned off", "Access continues until the subscription expires.", nil, 1)
        ]
        let formatter = ISO8601DateFormatter()
        return examples.enumerated().map { index, item in
            let app = apps[item.4]
            let time = formatter.string(from: now.addingTimeInterval(-Double(index * 2800 + 240)))
            return ActivityEvent(id: "demo-event-\(index)", appId: app.id, appName: app.name, kind: item.0,
                                 title: item.1, detail: "Sample event. \(item.2)", amountMilliunits: item.3,
                                 currency: item.3 == nil ? nil : "USD", productId: "example.product.\(index)",
                                 transactionId: "sample-\(index)", environment: "Demo", occurredAt: time,
                                 receivedAt: time, notificationType: "DEMO", subtype: nil,
                                 isMonetary: ["sale", "renewal", "refund"].contains(item.0))
        }
    }
    static var preferences: AlertPreferences {
        // Fixed app-owned sample data; decoding also preserves legacy preference defaults.
        try! JSONDecoder().decode(AlertPreferences.self, from: Data(#"{"sales":true,"refunds":true,"lifecycle":false,"sandbox":false,"hideAmounts":false}"#.utf8))
    }
}

struct ServerConfig: Decodable {
    let serviceName: String
    let authProvider: String?
    let registrationEnabled: Bool
    let demoEnabled: Bool
    let apnsConfigured: Bool
    let publicUrl: String
}

struct AuthResponse: Decodable {
    let user: Account
    let token: String?
}

struct UserResponse: Decodable { let user: Account }
struct AppsResponse: Decodable { let apps: [ConnectedApp] }
struct EventsResponse: Decodable {
    let events: [ActivityEvent]
    let nextCursor: String?
}
struct PreferencesResponse: Decodable { let preferences: AlertPreferences }
struct DeviceResponse: Decodable { let device: RegisteredDevice }
struct DevicesResponse: Decodable { let devices: [RegisteredDevice] }
struct TestPushResponse: Decodable { let queued: Bool }
struct OKResponse: Decodable { let ok: Bool }
struct AccountDeletionResponse: Decodable { let ok: Bool; let receipt: String }
struct AccountDeletionStatus: Decodable { let status: String }
struct AccountDeletionReceipt: Codable { let serverURL: String; let token: String }
struct ErrorResponse: Decodable { let error: String; let code: String? }

struct ConnectedApp: Decodable, Identifiable {
    struct WebhookURLs: Decodable {
        let production: String
        let sandbox: String
    }

    let id: String
    let name: String
    let bundleId: String
    let appleId: String
    let source: String
    let iconUrl: String?
    let createdAt: String
    let webhookUrls: WebhookURLs
    let lastProductionEventAt: String?
    let lastSandboxEventAt: String?
    let forwardingUrl: String?
    // App-owned preview art only; never supplied by API responses.
    var bundledIconName: String? = nil

    private enum CodingKeys: String, CodingKey {
        case id, name, bundleId, appleId, source, iconUrl, createdAt, webhookUrls
        case lastProductionEventAt, lastSandboxEventAt, forwardingUrl
    }
}

enum ActivityEnvironment: String, CaseIterable, Identifiable {
    case production = "Production"
    case sandbox = "Sandbox"
    case demo = "Demo"
    var id: String { rawValue }

    static func fromNotification(_ value: String?) -> ActivityEnvironment? {
        guard let value else { return nil }
        return ActivityEnvironment(rawValue: value)
    }
}

struct ActivityEvent: Codable, Identifiable {
    let id: String
    let appId: String
    let appName: String
    let kind: String
    let title: String
    let detail: String
    let amountMilliunits: Int64?
    let currency: String?
    let productId: String?
    let transactionId: String?
    let environment: String
    let occurredAt: String
    let receivedAt: String
    let notificationType: String
    let subtype: String?
    let isMonetary: Bool
    var activityAt: String? = nil

    var activityDate: Date? {
        if let activityAt, let date = Timestamp.date(activityAt) { return date }
        // Older servers/cache entries do not distinguish imports. Preserve history,
        // but never present a transaction later than receipt as the activity time.
        let occurred = Timestamp.date(occurredAt)
        let received = Timestamp.date(receivedAt)
        if let occurred, let received { return min(occurred, received) }
        return occurred ?? received
    }

    var appleDateLabel: String {
        if environment == "Demo" { return "Demo event date" }
        return ["sale", "renewal", "trial"].contains(kind) ? "Apple transaction date" : "Apple event date"
    }

    var renewalReportedEarly: Bool {
        guard kind == "renewal", let occurred = Timestamp.date(occurredAt),
              let received = Timestamp.date(receivedAt) else { return false }
        return occurred > received
    }

    var amountDescription: String? {
        guard let amountMilliunits, let currency, !currency.isEmpty else { return nil }
        let value = Decimal(amountMilliunits) / 1_000
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currency
        formatter.currencySymbol = currency
        return formatter.string(from: NSDecimalNumber(decimal: value))
    }

    var symbol: String {
        switch kind {
        case "sale": return "cart"
        case "renewal": return "arrow.triangle.2.circlepath"
        case "refund": return "arrow.uturn.backward"
        case "refund_reversed": return "arrow.uturn.forward"
        case "trial": return "clock"
        case "billing_issue": return "exclamationmark.triangle"
        case "test": return "bell.badge"
        default: return "bell"
        }
    }
}

struct AlertPreferences: Codable, Equatable {
    var sales: Bool
    var refunds: Bool
    var lifecycle: Bool
    var sandbox: Bool
    var hideAmounts: Bool
    var renewals: Bool
    var trials: Bool
    var refundReversals: Bool
    var autoRenewDisabled: Bool
    var autoRenewEnabled: Bool
    var billingIssues: Bool
    var expirations: Bool
    var otherUpdates: Bool

    enum CodingKeys: String, CodingKey {
        case sales, refunds, lifecycle, sandbox, hideAmounts, renewals, trials, refundReversals, autoRenewDisabled, autoRenewEnabled, billingIssues, expirations, otherUpdates
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        sales = try values.decode(Bool.self, forKey: .sales)
        refunds = try values.decode(Bool.self, forKey: .refunds)
        lifecycle = try values.decode(Bool.self, forKey: .lifecycle)
        sandbox = try values.decode(Bool.self, forKey: .sandbox)
        hideAmounts = try values.decode(Bool.self, forKey: .hideAmounts)
        renewals = try values.decodeIfPresent(Bool.self, forKey: .renewals) ?? sales
        trials = try values.decodeIfPresent(Bool.self, forKey: .trials) ?? lifecycle
        refundReversals = try values.decodeIfPresent(Bool.self, forKey: .refundReversals) ?? refunds
        autoRenewDisabled = try values.decodeIfPresent(Bool.self, forKey: .autoRenewDisabled) ?? lifecycle
        autoRenewEnabled = try values.decodeIfPresent(Bool.self, forKey: .autoRenewEnabled) ?? lifecycle
        billingIssues = try values.decodeIfPresent(Bool.self, forKey: .billingIssues) ?? lifecycle
        expirations = try values.decodeIfPresent(Bool.self, forKey: .expirations) ?? lifecycle
        otherUpdates = try values.decodeIfPresent(Bool.self, forKey: .otherUpdates) ?? lifecycle
    }
}

struct RegisteredDevice: Codable, Identifiable {
    let id: String
    let name: String
    let environment: String
    let createdAt: String
    let lastSeenAt: String
    let active: Bool
}

struct ServerSettings: Codable {
    var url: String
    var allowLocalHTTP: Bool

    static var initial: ServerSettings {
        #if DEBUG
        // Optional Xcode scheme override; server configuration is never part of the customer UI.
        if let url = ProcessInfo.processInfo.environment["QUESTLINE_API_URL"] {
            return .init(url: url, allowLocalHTTP: true)
        }
        #endif
        return .init(url: "https://quest-liart-iota.vercel.app", allowLocalHTTP: false)
    }
}

struct SavedSession: Codable {
    let serverURL: String
    let token: String
    var user: Account
    var deviceId: String?
    // Optional for sessions saved before automatic notification onboarding.
    var notificationsPaused: Bool?

    var automaticNotificationRegistrationAllowed: Bool { notificationsPaused != true }
}

enum DisplayTimeZone: String, CaseIterable, Identifiable {
    case local, utc
    static let storageKey = "questline.displayTimeZone"
    var id: String { rawValue }
    var title: String { self == .utc ? "UTC" : "Local" }
    var timeZone: TimeZone { self == .utc ? TimeZone(identifier: "UTC")! : .autoupdatingCurrent }
    var calendar: Calendar { Timestamp.calendar(timeZone: timeZone) }
}

enum Timestamp {
    static func zoneLabel(_ timeZone: TimeZone, at date: Date) -> String {
        timeZone == DisplayTimeZone.utc.timeZone ? "UTC" : (timeZone.abbreviation(for: date) ?? timeZone.identifier)
    }

    static func calendar(timeZone: TimeZone) -> Calendar {
        var calendar = Calendar.current
        calendar.timeZone = timeZone
        return calendar
    }

    static func date(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    static func display(_ value: String, timeZone: TimeZone = .autoupdatingCurrent) -> String {
        guard let date = date(value) else { return "Unknown date" }
        return date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, timeZone: timeZone))
    }

    static func displayWithTimeZone(_ value: String, timeZone: TimeZone = .autoupdatingCurrent) -> String {
        guard let date = date(value) else { return "Unknown date" }
        if timeZone == DisplayTimeZone.utc.timeZone { return display(value, timeZone: timeZone) + " UTC" }
        return date.formatted(Date.FormatStyle(timeZone: timeZone).year().month(.abbreviated).day().hour().minute().timeZone(.specificName(.short)))
    }
}
