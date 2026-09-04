import Foundation

struct Account: Codable, Equatable {
    let id: String
    let email: String
}

struct ServerConfig: Decodable {
    let serviceName: String
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
struct ErrorResponse: Decodable { let error: String }

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

struct ActivityEvent: Decodable, Identifiable {
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
        return .init(url: "http://localhost:4317", allowLocalHTTP: true)
        #else
        return .init(url: "", allowLocalHTTP: false)
        #endif
    }
}

struct SavedSession: Codable {
    let serverURL: String
    let token: String
    var user: Account
    var deviceId: String?
}

enum Timestamp {
    static func date(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    static func display(_ value: String) -> String {
        guard let date = date(value) else { return "Unknown date" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
