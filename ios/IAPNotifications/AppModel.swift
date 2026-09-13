import Foundation
import SwiftUI
import UIKit
import UserNotifications

enum NotificationSetupAction {
    case requestPermission, register, none

    static func next(for status: UNAuthorizationStatus, registrationAllowed: Bool) -> Self {
        guard registrationAllowed else { return .none }
        switch status {
        case .notDetermined: return .requestPermission
        case .authorized, .provisional, .ephemeral: return .register
        default: return .none
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var user: Account?
    @Published private(set) var isPreviewMode = false
    @Published private(set) var serverSettings = ServerSettings.initial
    @Published private(set) var config: ServerConfig?
    @Published private(set) var isBootstrapping = true
    @Published private(set) var isAuthenticating = false
    @Published var authError: String?
    @Published var selectedTab = "activity"

    @Published var selectedEnvironment: ActivityEnvironment = .production
    @Published private(set) var events: [ActivityEvent] = []
    @Published private(set) var nextCursor: String?
    @Published private(set) var isLoadingActivity = false
    @Published private(set) var activityError: String?
    @Published private(set) var apps: [ConnectedApp] = []
    @Published private(set) var isLoadingApps = false
    @Published private(set) var appsError: String?
    @Published private(set) var preferences: AlertPreferences?
    @Published private(set) var isSavingPreferences = false
    @Published private(set) var settingsError: String?
    @Published private(set) var isSigningOut = false
    @Published private(set) var isDeletingAccount = false
    @Published var deletionError: String?
    @Published private(set) var accountNotice: String?

    @Published private(set) var permissionStatus: UNAuthorizationStatus = .notDetermined
    @Published private(set) var isRegisteringDevice = false
    @Published private(set) var deviceId: String?
    @Published private(set) var pushMessage: String?
    @Published private(set) var pushError: String?
    @Published private(set) var isTestingPush = false

    @Published var isPairingPresented = false
    @Published private(set) var pairingReview: PairingReview?
    @Published private(set) var pairingIsBusy = false
    @Published private(set) var pairingError: String?
    @Published private(set) var pairingNotice: String?
    @Published private(set) var pairingSignInNotice: String?

    private var savedSession: SavedSession?
    private var transport: URLSession?
    private var deletionReceipt: AccountDeletionReceipt?
    private var sessionGeneration = UUID()
    private var activityRequest = UUID()
    private var loadedEnvironment: ActivityEnvironment?
    private var apnsToken: String?
    private var hasBootstrapped = false
    private var isSettingUpNotifications = false
    private var automaticRegistrationAllowed: Bool {
        savedSession?.automaticNotificationRegistrationAllowed == true
    }
    private var preferenceRevision = 0
    private var deviceRevision = 0
    private var pairingLink: PairingLink?
    private var pairingRequest = UUID()

    init(loadStoredState: Bool = true) {
        guard loadStoredState else { return }
        do {
            deletionReceipt = try KeychainStore.read(AccountDeletionReceipt.self, key: "accountDeletion")
            savedSession = try KeychainStore.read(SavedSession.self, key: "session")
            if let savedSession {
                // A session is never reused with an edited or unrelated server origin.
                guard savedSession.serverURL == serverSettings.url else {
                    try KeychainStore.remove("session")
                    self.savedSession = nil
                    return
                }
                _ = try ServerAddress.validate(savedSession.serverURL, allowLocalHTTP: serverSettings.allowLocalHTTP)
                user = savedSession.user
                deviceId = savedSession.deviceId
            }
        } catch {
            authError = error.localizedDescription
            savedSession = nil
        }
    }

    /// Dependency injection for isolated client tests; not selected by a launch argument or URL.
    convenience init(session: SavedSession, transport: URLSession) {
        self.init(loadStoredState: false)
        self.transport = transport
        self.savedSession = session
        self.user = session.user
        self.deviceId = session.deviceId
        self.serverSettings = ServerSettings(url: session.serverURL, allowLocalHTTP: false)
    }

    var privacyURL: URL { URL(string: "https://quest-liart-iota.vercel.app/privacy/")! }
    var supportURL: URL { URL(string: "https://quest-liart-iota.vercel.app/support/")! }

    var pushEnvironment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    var permissionDescription: String {
        switch permissionStatus {
        case .notDetermined: return "Not requested"
        case .denied: return "Disabled in iPhone Settings"
        case .authorized: return "Allowed"
        case .provisional: return "Quiet delivery allowed"
        case .ephemeral: return "Temporarily allowed"
        @unknown default: return "Unknown"
        }
    }

    func bootstrap() async {
        guard !hasBootstrapped else { return }
        hasBootstrapped = true
        defer { isBootstrapping = false }
        await refreshPermission()
        if let session = savedSession {
            do {
                let response: UserResponse = try await client().request("/api/auth/me")
                guard savedSession?.token == session.token else { return }
                user = response.user
                savedSession?.user = response.user
                try persistSession()
            } catch {
                if handleUnauthorized(error) { return }
                // Keep an offline session; a temporary network failure is not a logout.
                // The individual feeds show recoverable loading errors.
            }
            await refreshAll()
            await setUpNotifications()
        }
        // Signed-out launch is local: the welcome screen and demo never wait for a network check.
    }

    func authenticateWithApple(idToken: String, rawNonce: String, url: String, allowLocalHTTP: Bool) async {
        guard user == nil, !isPreviewMode, !isAuthenticating else { return }
        isAuthenticating = true
        authError = nil
        defer { isAuthenticating = false }
        do {
            let address = try ServerAddress.validate(url, allowLocalHTTP: allowLocalHTTP)
            let anonymousClient = APIClient(baseURL: address, token: nil)
            let currentConfig: ServerConfig = try await anonymousClient.request("/api/config")
            config = currentConfig
            guard currentConfig.authProvider == "apple" else {
                throw ClientError.message("Sign-in is temporarily unavailable. Please try again later.")
            }
            struct AuthBody: Encodable { let idToken: String; let rawNonce: String; let client = "ios" }
            let response: AuthResponse = try await anonymousClient.send(
                "/api/auth/apple", body: AuthBody(idToken: idToken, rawNonce: rawNonce))
            guard let token = response.token, !token.isEmpty else {
                throw ClientError.message("Sign-in could not be completed. Please try again.")
            }
            let settings = ServerSettings(url: address.absoluteString, allowLocalHTTP: allowLocalHTTP)
            let session = SavedSession(serverURL: address.absoluteString, token: token, user: response.user)
            do {
                try KeychainStore.write(settings, key: "server")
                try KeychainStore.write(session, key: "session")
            } catch {
                // Don't leave a usable orphaned session if secure local storage fails.
                let _: OKResponse? = try? await APIClient(baseURL: address, token: token).request("/api/auth/logout", method: "POST")
                throw error
            }
            sessionGeneration = UUID()
            serverSettings = settings
            savedSession = session
            user = response.user
            pairingSignInNotice = nil
            deviceId = nil
            await setUpNotifications()
            await refreshAll()
        } catch { authError = error.localizedDescription }
    }

    func refreshAll() async {
        guard user != nil, !isSigningOut else { return }
        async let activity: Void = loadActivity()
        async let appList: Void = loadApps()
        async let settings: Void = loadSettings()
        _ = await (activity, appList, settings)
    }

    func enterPreview() {
        guard user == nil, !isAuthenticating else { return }
        isPreviewMode = true
        user = Account(id: "offline-preview", email: "Demo account")
        selectedEnvironment = .demo
        loadedEnvironment = .demo
        selectedTab = "activity"
        apps = PreviewContent.apps
        events = PreviewContent.events()
        preferences = PreviewContent.preferences
        deviceId = nil
        authError = nil
        pairingSignInNotice = nil
        config = nil
        isBootstrapping = false
    }

    func foreground() async {
        guard !isPreviewMode else { return }
        await refreshDeletionStatus()
        await refreshPermission()
        guard hasBootstrapped, !isBootstrapping, !isAuthenticating, user != nil else { return }
        await refreshAll()
        await setUpNotifications()
    }

    func loadActivity(loadMore: Bool = false) async {
        if isPreviewMode {
            selectedEnvironment = .demo
            if events.isEmpty { events = PreviewContent.events() }
            loadedEnvironment = .demo
            return
        }
        guard user != nil, !isSigningOut else { return }
        if loadMore && (isLoadingActivity || nextCursor == nil) { return }
        let requestID = UUID()
        let generation = sessionGeneration
        let environment = selectedEnvironment
        activityRequest = requestID
        isLoadingActivity = true
        activityError = nil
        if loadedEnvironment != environment {
            events = []
            nextCursor = nil
        }
        defer { if activityRequest == requestID { isLoadingActivity = false } }
        var query = [URLQueryItem(name: "environment", value: environment.rawValue), URLQueryItem(name: "limit", value: "50")]
        if loadMore, let nextCursor { query.append(URLQueryItem(name: "before", value: nextCursor)) }
        do {
            let response: EventsResponse = try await client().request("/api/events", query: query)
            guard sessionGeneration == generation, activityRequest == requestID else { return }
            if loadMore {
                let existing = Set(events.map(\.id))
                events.append(contentsOf: response.events.filter { !existing.contains($0.id) })
            } else { events = response.events }
            nextCursor = response.nextCursor
            loadedEnvironment = environment
        } catch {
            guard sessionGeneration == generation, activityRequest == requestID else { return }
            if !handleUnauthorized(error) { activityError = error.localizedDescription }
        }
    }

    func loadApps() async {
        if isPreviewMode { return }
        guard user != nil, !isSigningOut, !isLoadingApps else { return }
        let generation = sessionGeneration
        isLoadingApps = true
        appsError = nil
        defer { isLoadingApps = false }
        do {
            let response: AppsResponse = try await client().request("/api/apps")
            guard generation == sessionGeneration else { return }
            apps = response.apps
        } catch {
            guard generation == sessionGeneration else { return }
            if !handleUnauthorized(error) { appsError = error.localizedDescription }
        }
    }

    func dashboardAccess(for destination: DashboardDestination) throws -> DashboardAccess {
        guard !isPreviewMode, !isSigningOut, !isDeletingAccount, let savedSession else {
            throw ClientError.message("Sign in to manage your apps.")
        }
        let origin = try ServerAddress.validate(savedSession.serverURL, allowLocalHTTP: serverSettings.allowLocalHTTP)
        return try DashboardAccess(origin: origin, token: savedSession.token, destination: destination)
    }

    func loadSettings() async {
        if isPreviewMode { return }
        guard user != nil, !isSigningOut else { return }
        let generation = sessionGeneration
        let requestedPreferenceRevision = preferenceRevision
        let requestedDeviceRevision = deviceRevision
        settingsError = nil
        do {
            let currentClient = try client()
            async let serverConfig: ServerConfig = currentClient.request("/api/config")
            async let preferenceResponse: PreferencesResponse = currentClient.request("/api/preferences")
            async let devicesResponse: DevicesResponse = currentClient.request("/api/devices")
            let (newConfig, newPreferences, devices) = try await (serverConfig, preferenceResponse, devicesResponse)
            guard generation == sessionGeneration else { return }
            config = newConfig
            if !isSavingPreferences && preferenceRevision == requestedPreferenceRevision {
                preferences = newPreferences.preferences
            }
            if deviceRevision == requestedDeviceRevision,
               let deviceId, !devices.devices.contains(where: { $0.id == deviceId && $0.active }) {
                self.deviceId = nil
                savedSession?.deviceId = nil
                savedSession?.notificationsPaused = true
                try persistSession()
                pushMessage = "Notifications are off for this phone. Enable them to receive alerts."
            }
        } catch {
            guard generation == sessionGeneration else { return }
            if !handleUnauthorized(error) { settingsError = error.localizedDescription }
        }
    }

    func setPreference(_ keyPath: WritableKeyPath<AlertPreferences, Bool>, value: Bool) async {
        guard var updated = preferences, !isSavingPreferences else { return }
        updated[keyPath: keyPath] = value
        if isPreviewMode { preferences = updated; return }
        let generation = sessionGeneration
        preferenceRevision += 1
        isSavingPreferences = true
        settingsError = nil
        defer { isSavingPreferences = false }
        do {
            let response: PreferencesResponse = try await client().send("/api/preferences", method: "PATCH", body: updated)
            guard generation == sessionGeneration else { return }
            preferences = response.preferences
        } catch {
            guard generation == sessionGeneration else { return }
            if !handleUnauthorized(error) { settingsError = error.localizedDescription }
        }
    }

    func enableNotifications() async {
        await setUpNotifications(explicitlyRequested: true)
    }

    private func setUpNotifications(explicitlyRequested: Bool = false) async {
        guard !isPreviewMode, user != nil, !isSigningOut, !isDeletingAccount,
              !isSettingUpNotifications, !isRegisteringDevice else { return }
        let generation = sessionGeneration
        isSettingUpNotifications = true
        defer { isSettingUpNotifications = false }
        await refreshPermission()
        guard generation == sessionGeneration, user != nil, !isSigningOut, !isDeletingAccount else { return }
        let action = NotificationSetupAction.next(for: permissionStatus,
            registrationAllowed: explicitlyRequested || automaticRegistrationAllowed)
        guard action != .none else {
            if permissionStatus == .denied {
                pushMessage = "Notifications are disabled. You can enable them in iPhone Settings."
            }
            return
        }
        pushError = nil
        pushMessage = nil
        do {
            if action == .requestPermission {
                _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
                await refreshPermission()
            }
            guard generation == sessionGeneration, user != nil, !isSigningOut, !isDeletingAccount else { return }
            guard NotificationSetupAction.next(for: permissionStatus, registrationAllowed: true) == .register else {
                pushMessage = "Notifications are disabled. You can enable them in iPhone Settings."
                return
            }
            // Only the explicit button may reconnect a phone disabled in the browser.
            guard explicitlyRequested || automaticRegistrationAllowed else { return }
            if explicitlyRequested {
                savedSession?.notificationsPaused = false
                try persistSession()
            }
            deviceRevision += 1
            pushMessage = "Registering this phone with Apple…"
            UIApplication.shared.registerForRemoteNotifications()
            if let apnsToken { await registerDevice(token: apnsToken) }
        } catch {
            guard generation == sessionGeneration else { return }
            pushError = error.localizedDescription
        }
    }

    func receivedAPNSToken(_ token: String) async {
        guard !isPreviewMode else { return }
        apnsToken = token
        await registerDevice(token: token)
    }

    func registrationFailed(_ error: Error) {
        guard !isPreviewMode else { return }
        pushError = "Notifications could not be enabled. Please try again."
        pushMessage = nil
    }

    func sendTestPush() async {
        guard let deviceId, !isTestingPush else { return }
        let generation = sessionGeneration
        isTestingPush = true
        pushError = nil
        pushMessage = nil
        defer { isTestingPush = false }
        do {
            let response: TestPushResponse = try await client().request("/api/devices/\(deviceId)/test", method: "POST")
            guard generation == sessionGeneration else { return }
            guard response.queued else { throw ClientError.message("The test notification could not be sent. Please try again.") }
            pushMessage = "Test queued. Check your phone for the notification."
        } catch {
            guard generation == sessionGeneration else { return }
            if !handleUnauthorized(error) { pushError = error.localizedDescription }
        }
    }

    func logout() async {
        if isPreviewMode { try? clearSession(removeStoredSession: false); return }
        guard !isSigningOut, !isRegisteringDevice else { return }
        isSigningOut = true
        settingsError = nil
        defer { isSigningOut = false }
        do {
            let currentClient = try client()
            if let deviceId {
                do {
                    let _: OKResponse = try await currentClient.request("/api/devices/\(deviceId)", method: "DELETE")
                } catch let error as ClientError where error.isNotFound { /* Already revoked. */ }
                self.deviceId = nil
                savedSession?.deviceId = nil
                try persistSession()
            }
            let _: OKResponse = try await currentClient.request("/api/auth/logout", method: "POST")
            try clearSession()
        } catch {
            if !handleUnauthorized(error) {
                settingsError = "Could not safely sign out: \(error.localizedDescription). Reconnect and try again so this phone and session can be revoked."
            }
        }
    }

    func deleteAccount(idToken: String, rawNonce: String, authorizationCode: String) async {
        guard user != nil, !isSigningOut, !isRegisteringDevice else { return }
        isDeletingAccount = true
        isSigningOut = true
        deletionError = nil
        defer { isDeletingAccount = false; isSigningOut = false }
        do {
            struct DeleteBody: Encodable {
                let idToken: String
                let rawNonce: String
                let authorizationCode: String
                let client = "ios"
            }
            let address = serverSettings.url
            let response: AccountDeletionResponse = try await client().send("/api/account/delete", body:
                DeleteBody(idToken: idToken, rawNonce: rawNonce, authorizationCode: authorizationCode))
            guard response.ok else { throw ClientError.message("Deletion was not accepted. Please try again.") }
            let receipt = AccountDeletionReceipt(serverURL: address, token: response.receipt)
            deletionReceipt = receipt
            try? KeychainStore.write(receipt, key: "accountDeletion")
            try clearSession()
            accountNotice = "Account deletion has started. Your phones and browser sessions are disconnected. Stored data is normally removed within 24 hours."
            await refreshDeletionStatus()
        } catch {
            // A failed Apple confirmation must leave the account available for retry.
            // Never report deletion as complete from an expired session or a timeout.
            deletionError = error.localizedDescription
        }
    }

    func refreshDeletionStatus() async {
        guard let receipt = deletionReceipt, !isPreviewMode else { return }
        do {
            let address = try ServerAddress.validate(receipt.serverURL, allowLocalHTTP: serverSettings.allowLocalHTTP)
            struct StatusBody: Encodable { let receipt: String }
            let result: AccountDeletionStatus = try await APIClient(baseURL: address, token: nil)
                .send("/api/account/deletion-status", body: StatusBody(receipt: receipt.token))
            if result.status == "complete" {
                accountNotice = "Your Questline account and stored app data have been deleted."
                deletionReceipt = nil
                try? KeychainStore.remove("accountDeletion")
            } else if result.status == "deleting" {
                accountNotice = "Account deletion is in progress. Stored data is normally removed within 24 hours. Return here to check completion."
            } else {
                accountNotice = "The deletion receipt is no longer available. Contact support if you need to confirm its status."
                deletionReceipt = nil
                try? KeychainStore.remove("accountDeletion")
            }
        } catch {
            accountNotice = "Your deletion request was accepted. Reconnect to check its status."
        }
    }

    func notificationOpened(environment: String?) async {
        guard user != nil, !isPreviewMode else { return }
        if let environment = ActivityEnvironment.fromNotification(environment) {
            selectedEnvironment = environment
        }
        selectedTab = "activity"
        await loadActivity()
    }

    func beginPairing() {
        if isPreviewMode { return }
        guard user != nil, !isSigningOut else {
            pairingSignInNotice = "Sign in on this phone first, then scan the computer's QR code again."
            return
        }
        guard !pairingIsBusy else { return }
        resetPairing()
        isPairingPresented = true
    }

    func resetPairing() {
        guard !pairingIsBusy else { return }
        pairingRequest = UUID()
        pairingLink = nil
        pairingReview = nil
        pairingError = nil
        pairingNotice = nil
    }

    func closePairing() {
        guard !pairingIsBusy else { return }
        isPairingPresented = false
        resetPairing()
    }

    func inspectPairingLink(_ value: String) async {
        guard !isPreviewMode else { return }
        guard user != nil, !isSigningOut else {
            // Do not retain a login challenge across account sign-ins.
            pairingSignInNotice = "Sign in on this phone first, then scan or open the computer's QR link again."
            return
        }
        guard !pairingIsBusy else { return }
        resetPairing()
        isPairingPresented = true
        let generation = sessionGeneration
        let requestID = UUID()
        pairingRequest = requestID
        pairingIsBusy = true
        defer { if pairingRequest == requestID { pairingIsBusy = false } }
        do {
            let currentClient = try client()
            let link = try PairingLink.parse(value, signedInServer: currentClient.baseURL,
                                            allowLocalHTTP: serverSettings.allowLocalHTTP)
            // The scanned origin is checked only. All requests stay on the Keychain-bound API origin.
            let response: PairingInspectionResponse = try await currentClient.send("/api/pairing/inspect", body: link.credentials)
            guard generation == sessionGeneration, pairingRequest == requestID else { return }
            try response.pairing.validate(for: link, allowLocalHTTP: serverSettings.allowLocalHTTP)
            pairingLink = link
            pairingReview = response.pairing
        } catch {
            guard generation == sessionGeneration, pairingRequest == requestID else { return }
            if !handleUnauthorized(error) { pairingError = error.localizedDescription }
        }
    }

    func approvePairing() async {
        guard !pairingIsBusy, let pairingLink, let pairingReview, user != nil, !isSigningOut else { return }
        do {
            try pairingReview.validate(for: pairingLink, allowLocalHTTP: serverSettings.allowLocalHTTP)
        } catch {
            pairingError = error.localizedDescription
            return
        }
        await resolvePairing(approve: true, link: pairingLink)
    }

    func denyPairing() async {
        guard !pairingIsBusy, let pairingLink, pairingReview != nil, user != nil, !isSigningOut else { return }
        await resolvePairing(approve: false, link: pairingLink)
    }

    private func resolvePairing(approve: Bool, link: PairingLink) async {
        let generation = sessionGeneration
        let requestID = pairingRequest
        pairingIsBusy = true
        pairingError = nil
        defer { if pairingRequest == requestID { pairingIsBusy = false } }
        do {
            let currentClient = try client()
            guard PairingLink.canonicalOrigin(currentClient.baseURL) == link.serverOrigin else {
                throw ClientError.message("This sign-in request no longer matches your session. Scan a new code.")
            }
            let response: OKResponse = try await currentClient.send(
                approve ? "/api/pairing/approve" : "/api/pairing/deny", body: link.credentials)
            guard generation == sessionGeneration, requestID == pairingRequest else { return }
            guard response.ok else { throw ClientError.message("This action could not be confirmed. Please try again.") }
            pairingLink = nil
            pairingReview = nil
            pairingNotice = approve
                ? "Browser approved. Return to your computer to finish signing in. No password is needed there."
                : "Request denied. That QR code can no longer sign in."
        } catch {
            guard generation == sessionGeneration, requestID == pairingRequest else { return }
            if !handleUnauthorized(error) {
                pairingError = approve
                    ? "Approval was not confirmed: \(error.localizedDescription) Check your computer before trying again."
                    : error.localizedDescription
            }
        }
    }

    private func refreshPermission() async {
        permissionStatus = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    private func registerDevice(token: String) async {
        guard !isPreviewMode, user != nil, !isSigningOut, !isDeletingAccount, !isRegisteringDevice,
              NotificationSetupAction.next(for: permissionStatus, registrationAllowed: automaticRegistrationAllowed) == .register else { return }
        let generation = sessionGeneration
        deviceRevision += 1
        isRegisteringDevice = true
        pushError = nil
        defer {
            isRegisteringDevice = false
            if generation == sessionGeneration, let latestToken = apnsToken, latestToken != token {
                Task { await registerDevice(token: latestToken) }
            }
        }
        do {
            struct DeviceBody: Encodable { let token: String; let name: String; let environment: String }
            let response: DeviceResponse = try await client().send("/api/devices", body: DeviceBody(
                token: token, name: UIDevice.current.name, environment: pushEnvironment))
            guard generation == sessionGeneration, !isSigningOut else { return }
            deviceId = response.device.id
            savedSession?.deviceId = response.device.id
            do { try persistSession() }
            catch {
                let _: OKResponse? = try? await client().request("/api/devices/\(response.device.id)", method: "DELETE")
                deviceId = nil
                savedSession?.deviceId = nil
                throw error
            }
            pushMessage = "Notifications connected."
        } catch {
            guard generation == sessionGeneration else { return }
            if !handleUnauthorized(error) { pushError = error.localizedDescription }
        }
    }

    private func client() throws -> APIClient {
        guard !isPreviewMode else { throw ClientError.message("Exit the demo and sign in to connect your own apps.") }
        guard let savedSession else { throw ClientError.message("Sign in to continue.") }
        let address = try ServerAddress.validate(savedSession.serverURL, allowLocalHTTP: serverSettings.allowLocalHTTP)
        return APIClient(baseURL: address, token: savedSession.token, transport: transport)
    }

    private func persistSession() throws {
        if let savedSession { try KeychainStore.write(savedSession, key: "session") }
    }

    @discardableResult
    private func handleUnauthorized(_ error: Error) -> Bool {
        guard let error = error as? ClientError, error.isUnauthorized else { return false }
        do { try clearSession() }
        catch { authError = error.localizedDescription; return true }
        authError = "Your session expired or was revoked. Sign in again."
        return true
    }

    private func clearSession(removeStoredSession: Bool = true) throws {
        if removeStoredSession { try KeychainStore.remove("session") }
        if !isPreviewMode {
            UIApplication.shared.unregisterForRemoteNotifications()
            UNUserNotificationCenter.current().removeAllDeliveredNotifications()
            UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
        }
        sessionGeneration = UUID()
        activityRequest = UUID()
        pairingRequest = UUID()
        pairingIsBusy = false
        isPairingPresented = false
        pairingLink = nil
        pairingReview = nil
        pairingError = nil
        pairingNotice = nil
        savedSession = nil
        isPreviewMode = false
        user = nil
        deviceId = nil
        apnsToken = nil
        events = []
        nextCursor = nil
        apps = []
        preferences = nil
        loadedEnvironment = nil
        isLoadingActivity = false
        activityError = nil
        appsError = nil
        settingsError = nil
        pushError = nil
        pushMessage = nil
        selectedEnvironment = .production
        selectedTab = "activity"
    }
}
