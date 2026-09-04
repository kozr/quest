import Foundation
import SwiftUI
import UIKit
import UserNotifications

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var user: Account?
    @Published private(set) var serverSettings = ServerSettings.initial
    @Published private(set) var config: ServerConfig?
    @Published private(set) var isBootstrapping = true
    @Published private(set) var isAuthenticating = false
    @Published private(set) var isCheckingServer = false
    @Published var authError: String?
    @Published var connectionMessage: String?
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
    private var sessionGeneration = UUID()
    private var activityRequest = UUID()
    private var loadedEnvironment: ActivityEnvironment?
    private var apnsToken: String?
    private var hasBootstrapped = false
    private var automaticRegistrationAllowed = false
    private var preferenceRevision = 0
    private var deviceRevision = 0
    private var pairingLink: PairingLink?
    private var pairingRequest = UUID()

    init() {
        do {
            serverSettings = try KeychainStore.read(ServerSettings.self, key: "server") ?? .initial
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
                automaticRegistrationAllowed = savedSession.deviceId != nil
            }
        } catch {
            authError = error.localizedDescription
            savedSession = nil
        }
    }

    var browserSetupURL: URL? {
        try? ServerAddress.validate(serverSettings.url, allowLocalHTTP: serverSettings.allowLocalHTTP)
    }

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
                connectionMessage = "Could not reach the server. Pull to refresh when it is available."
            }
            await refreshAll()
            registerIfAlreadyAuthorized()
        } else if !serverSettings.url.isEmpty {
            await checkServer(url: serverSettings.url, allowLocalHTTP: serverSettings.allowLocalHTTP)
        }
    }

    func checkServer(url: String, allowLocalHTTP: Bool) async {
        guard user == nil, !isCheckingServer else { return }
        isCheckingServer = true
        connectionMessage = nil
        authError = nil
        config = nil
        defer { isCheckingServer = false }
        do {
            let address = try ServerAddress.validate(url, allowLocalHTTP: allowLocalHTTP)
            let response: ServerConfig = try await APIClient(baseURL: address, token: nil).request("/api/config")
            let settings = ServerSettings(url: address.absoluteString, allowLocalHTTP: allowLocalHTTP)
            try KeychainStore.write(settings, key: "server")
            serverSettings = settings
            config = response
            connectionMessage = "Connected to \(response.serviceName)."
        } catch { authError = error.localizedDescription }
    }

    func authenticate(email: String, password: String, register: Bool, url: String, allowLocalHTTP: Bool) async {
        guard !isAuthenticating else { return }
        isAuthenticating = true
        authError = nil
        defer { isAuthenticating = false }
        do {
            let address = try ServerAddress.validate(url, allowLocalHTTP: allowLocalHTTP)
            let anonymousClient = APIClient(baseURL: address, token: nil)
            let currentConfig: ServerConfig = try await anonymousClient.request("/api/config")
            config = currentConfig
            if register && !currentConfig.registrationEnabled {
                throw ClientError.message("New accounts are disabled on this server. Sign in with an existing account.")
            }
            struct AuthBody: Encodable { let email: String; let password: String; let client = "ios" }
            let response: AuthResponse = try await anonymousClient.send(
                register ? "/api/auth/register" : "/api/auth/login",
                body: AuthBody(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password))
            guard let token = response.token, !token.isEmpty else {
                throw ClientError.message("This server did not return a native session token. Check that it supports the iOS API.")
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
            connectionMessage = nil
            pairingSignInNotice = nil
            deviceId = nil
            automaticRegistrationAllowed = false
            await refreshAll()
            await refreshPermission()
            registerIfAlreadyAuthorized()
        } catch { authError = error.localizedDescription }
    }

    func refreshAll() async {
        guard user != nil, !isSigningOut else { return }
        async let activity: Void = loadActivity()
        async let appList: Void = loadApps()
        async let settings: Void = loadSettings()
        _ = await (activity, appList, settings)
    }

    func foreground() async {
        await refreshPermission()
        guard hasBootstrapped, !isBootstrapping, user != nil else { return }
        await refreshAll()
        registerIfAlreadyAuthorized()
    }

    func loadActivity(loadMore: Bool = false) async {
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

    func loadSettings() async {
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
                automaticRegistrationAllowed = false
                try persistSession()
                pushMessage = "This phone was disconnected on the server. Enable notifications to reconnect it."
            }
        } catch {
            guard generation == sessionGeneration else { return }
            if !handleUnauthorized(error) { settingsError = error.localizedDescription }
        }
    }

    func setPreference(_ keyPath: WritableKeyPath<AlertPreferences, Bool>, value: Bool) async {
        guard var updated = preferences, !isSavingPreferences else { return }
        updated[keyPath: keyPath] = value
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
        guard user != nil, !isSigningOut else { return }
        pushError = nil
        pushMessage = nil
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
            await refreshPermission()
            guard granted else {
                pushMessage = "Notifications are disabled. You can enable them in iPhone Settings."
                return
            }
            automaticRegistrationAllowed = true
            deviceRevision += 1
            pushMessage = "Registering this phone with Apple…"
            UIApplication.shared.registerForRemoteNotifications()
            if let apnsToken { await registerDevice(token: apnsToken) }
        } catch { pushError = error.localizedDescription }
    }

    func receivedAPNSToken(_ token: String) async {
        apnsToken = token
        await registerDevice(token: token)
    }

    func registrationFailed(_ error: Error) {
        pushError = "Apple could not register this device: \(error.localizedDescription). A signed build with the Push Notifications capability is required."
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
            guard response.queued else { throw ClientError.message("The server did not queue a test push.") }
            pushMessage = "Test push queued. This does not confirm delivery. Look for the notification on your phone; inspect delivery status in the web app if it does not arrive."
        } catch {
            guard generation == sessionGeneration else { return }
            if !handleUnauthorized(error) { pushError = error.localizedDescription }
        }
    }

    func logout() async {
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

    func notificationOpened(environment: String?) async {
        guard user != nil else { return }
        if let environment = ActivityEnvironment.fromNotification(environment) {
            selectedEnvironment = environment
        }
        selectedTab = "activity"
        await loadActivity()
    }

    func beginPairing() {
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
                throw ClientError.message("Your signed-in server changed. Scan a new code before continuing.")
            }
            let response: OKResponse = try await currentClient.send(
                approve ? "/api/pairing/approve" : "/api/pairing/deny", body: link.credentials)
            guard generation == sessionGeneration, requestID == pairingRequest else { return }
            guard response.ok else { throw ClientError.message("The server did not confirm this action.") }
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

    private func registerIfAlreadyAuthorized() {
        guard user != nil, !isSigningOut, automaticRegistrationAllowed,
              permissionStatus == .authorized || permissionStatus == .provisional || permissionStatus == .ephemeral else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    private func registerDevice(token: String) async {
        guard user != nil, !isSigningOut, !isRegisteringDevice, automaticRegistrationAllowed else { return }
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
            pushMessage = "This phone is registered (\(pushEnvironment) APNs). Send a test to check delivery."
        } catch {
            guard generation == sessionGeneration else { return }
            if !handleUnauthorized(error) { pushError = error.localizedDescription }
        }
    }

    private func client() throws -> APIClient {
        guard let savedSession else { throw ClientError.message("Sign in to continue.") }
        let address = try ServerAddress.validate(savedSession.serverURL, allowLocalHTTP: serverSettings.allowLocalHTTP)
        return APIClient(baseURL: address, token: savedSession.token)
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

    private func clearSession() throws {
        try KeychainStore.remove("session")
        UIApplication.shared.unregisterForRemoteNotifications()
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
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
        user = nil
        deviceId = nil
        apnsToken = nil
        automaticRegistrationAllowed = false
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
        connectionMessage = nil
        selectedEnvironment = .production
        selectedTab = "activity"
    }
}
