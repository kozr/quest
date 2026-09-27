import Foundation
import SwiftUI
import UIKit
import UserNotifications
import StoreKit

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
    private var onboardingOperation = UUID()
    private var isChangingOnboarding = false
    @Published private(set) var onboarding: QuestOnboardingState?
    @Published private(set) var onboardingError: String?
    @Published private(set) var lockedQuests: LockedQuests?
    @Published private var storeConnectionProgress: [String: StoreConnectionProgress] = [:]
    private var persistsStoreProgress = false
    private static let storeProgressKey = "quest.store-connection-progress.v1"
    @Published private(set) var isTestFlight = false
    var canRetryOnboarding: Bool { isTestFlight && user != nil && !isPreviewMode }
    var shouldShowOnboarding: Bool { onboarding != nil && onboarding?.stage != .complete }
    @Published private(set) var user: Account?
    @Published private(set) var isPreviewMode = false
    @Published private(set) var serverSettings = ServerSettings.initial
    @Published private(set) var config: ServerConfig?
    @Published private(set) var isBootstrapping = true
    @Published private(set) var isAuthenticating = false
    @Published var authError: String?
    @Published var selectedTab = "activity"
    @Published var isActivityPresented = false
    @Published var activitySection: ActivitySection = .events

    @Published private(set) var queuedSales: [ActivityEvent] = []
    @Published private(set) var queuedSalesError: String?
    @Published private(set) var isLoadingQueuedSales = false

    @Published var selectedEnvironment: ActivityEnvironment = .production
    @Published private(set) var events: [ActivityEvent] = []
    @Published private(set) var nextCursor: String?
    @Published private(set) var isLoadingActivity = false
    @Published private(set) var activityError: String?
    @Published private(set) var apps: [ConnectedApp] = []
    @Published private(set) var isLoadingApps = false
    @Published private(set) var appsError: String?
    @Published private(set) var selectedLeadAppID: String?
    @Published private(set) var leadAccess: LeadAccessResponse?
    @Published private(set) var leadProfile: LeadProfile?
    @Published private(set) var leadLegacySuggestions: LeadLegacySuggestions?
    @Published private(set) var leadProfileStatus = LeadProfileStatus.local(code: "needs_profile")
    @Published private(set) var leadItems: [LeadItem] = []
    @Published private(set) var leadNextCursor: String?
    @Published private(set) var isLoadingLeadBoard = false
    @Published private(set) var isLoadingMoreLeads = false
    @Published private(set) var leadBoardError: String?

    var isPreparingLeadBoard: Bool {
        if apps.isEmpty { return isLoadingApps }
        guard selectedLeadAppID != nil, leadItems.isEmpty else { return false }
        // Cover the first render before the view's task starts, and the entire
        // profile + feed request. An active scan already has its own progress UI.
        if !isPreviewMode && leadAccess == nil && leadBoardError == nil { return true }
        return isLoadingLeadBoard && leadProfileStatus.progress?.shouldPoll != true
    }

    @Published private(set) var leadSetupMessage: String?
    @Published private(set) var leadProfileSaveError: String?
    @Published private(set) var isSavingLeadProfile = false
    @Published private(set) var isRequestingLeadDraft = false
    @Published private(set) var leadDraftStatus = "idle"
    @Published private(set) var leadDraft: LeadSetupDraft?
    @Published private(set) var leadDraftJobID: String?
    @Published private(set) var leadMutationError: String?
    @Published private(set) var leadFailedDismissal: LeadItem?
    @Published private(set) var leadPendingPostID: String?
    @Published private(set) var leadUndoAction: LeadUndoAction?
    @Published var requestedLeadSetupAppID: String?
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

    private var salesQueue: SalesQueue?
    private var salesQueueStore = SalesQueueStore.local
    private var salesQueueRequest = UUID()
    private var activeAppIDs: Set<String>?
    private var removedAppIDs = Set<String>()

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
    private var leadBoardRequest = UUID()
    private var leadProfileRequest = UUID()
    private var leadFeedRequest = UUID()
    private var leadMoreRequest = UUID()
    private var leadDraftOperation = UUID()
    private var leadDraftRequestID: String?
    private var leadProfileSaveOperation = UUID()
    private var leadDismissOperation = UUID()
    private var previewLeadDismissals: [String: Set<String>] = [:]
    private var journalSessions: [String: LeadJournalSession] = [:]

    init(loadStoredState: Bool = true) {
        persistsStoreProgress = loadStoredState
        guard loadStoredState else { return }
        if let data = UserDefaults.standard.data(forKey: Self.storeProgressKey),
           let saved = try? JSONDecoder().decode([String: StoreConnectionProgress].self, from: data) {
            storeConnectionProgress = saved
        }
        do {
            deletionReceipt = try KeychainStore.read(AccountDeletionReceipt.self, key: "accountDeletion")
            savedSession = try KeychainStore.read(SavedSession.self, key: "session")
            if let savedSession {
                // A session is never reused with an edited or unrelated server origin.
                guard savedSession.serverURL == serverSettings.url else {
                    try clearSession()
                    return
                }
                _ = try ServerAddress.validate(savedSession.serverURL, allowLocalHTTP: serverSettings.allowLocalHTTP)
                user = savedSession.user
                deviceId = savedSession.deviceId
                restoreSalesQueue()
            } else {
                try salesQueueStore.removeAll()
            }
        } catch {
            authError = error.localizedDescription
            savedSession = nil
        }
    }

    /// Dependency injection for isolated client tests; not selected by a launch argument or URL.
    convenience init(session: SavedSession, transport: URLSession, queueStore: SalesQueueStore? = nil) {
        self.init(loadStoredState: false)
        self.transport = transport
        self.savedSession = session
        self.user = session.user
        self.deviceId = session.deviceId
        self.serverSettings = ServerSettings(url: session.serverURL, allowLocalHTTP: false)
        self.salesQueueStore = queueStore ?? SalesQueueStore(directory: FileManager.default.temporaryDirectory
            .appendingPathComponent("queue-test-" + UUID().uuidString))
        restoreSalesQueue()
    }

    var privacyURL: URL { URL(string: "https://quest-liart-iota.vercel.app/privacy/")! }
    var supportURL: URL { URL(string: "https://quest-liart-iota.vercel.app/support/")! }
    var marketingClient: APIClient? { user != nil && !isPreviewMode ? try? client() : nil }
    var tavernEnabled: Bool { user != nil && !isPreviewMode && !isSigningOut && config?.tavernEnabled == true }
    var tavernClient: APIClient? { tavernEnabled ? try? client() : nil }

    /// Refresh independently from unrelated settings requests; stale enablement fails closed.
    func refreshTavernFlag() async {
        guard user != nil, !isPreviewMode, !isSigningOut else { return }
        let generation = sessionGeneration
        do {
            let response: ServerConfig = try await client().request("/api/config")
            guard generation == sessionGeneration else { return }
            config = response
        } catch {
            guard generation == sessionGeneration else { return }
            config = nil
            _ = handleUnauthorized(error)
        }
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
                // The individual feeds show recoverable loading errors.
            }
            await refreshAll()
            await loadOnboarding()
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
                // A new sign-in must not restore a journal retained by an older app version.
                try salesQueueStore.removeAll()
                try KeychainStore.write(settings, key: "server")
                try KeychainStore.write(session, key: "session")
            } catch {
                // Don't leave a usable orphaned session if secure local storage fails.
                let _: OKResponse? = try? await APIClient(baseURL: address, token: token).request("/api/auth/logout", method: "POST")
                throw error
            }
            sessionGeneration = UUID()
            resetLeadState(clearSelection: true)
            serverSettings = settings
            savedSession = session
            user = response.user
            selectedTab = "activity"
            isActivityPresented = false
            activitySection = .events
            restoreSalesQueue()
            pairingSignInNotice = nil
            deviceId = nil
            await refreshAll()
            await loadOnboarding()
            await setUpNotifications()
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
        isActivityPresented = false
        activitySection = .events
        apps = PreviewContent.apps
        resetLeadState(clearSelection: true)
        selectedLeadAppID = apps.first?.id
        previewLeadDismissals = [:]
        events = PreviewContent.events()
        queuedSales = events.filter { SalesQueue.qualifies($0, preview: true) }
        queuedSalesError = nil
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
        await refreshTavernFlag()
        await refreshAll()
        await loadOnboarding()
        await setUpNotifications()
    }

    func loadActivity(loadMore: Bool = false) async {
        async let queue: Void = loadMore ? () : refreshQueuedSales()
        await loadActivityPage(loadMore: loadMore)
        await queue
    }

    private func loadActivityPage(loadMore: Bool) async {
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
                events.append(contentsOf: response.events.filter { !existing.contains($0.id) && !removedAppIDs.contains($0.appId) })
            } else { events = response.events.filter { !removedAppIDs.contains($0.appId) } }
            nextCursor = response.nextCursor
            loadedEnvironment = environment
        } catch {
            guard sessionGeneration == generation, activityRequest == requestID else { return }
            if !handleUnauthorized(error) { activityError = error.localizedDescription }
        }
    }

    private func restoreSalesQueue() {
        guard let session = savedSession else { return }
        do {
            salesQueue = try salesQueueStore.read(server: session.serverURL, account: session.user.id)
            queuedSales = salesQueue?.pending ?? []
            queuedSalesError = nil
        } catch {
            queuedSalesError = "Your queued sales could not be loaded. Refresh to try again."
        }
    }

    /// Reads Production independently of the Activity filter. A failed page never advances the journal.
    func refreshQueuedSales() async {
        guard !isPreviewMode, !isSigningOut, !isLoadingQueuedSales, let session = savedSession else { return }
        let generation = sessionGeneration
        let request = UUID()
        salesQueueRequest = request
        isLoadingQueuedSales = true
        queuedSalesError = nil
        defer { if salesQueueRequest == request { isLoadingQueuedSales = false } }
        do {
            if salesQueue == nil {
                salesQueue = try salesQueueStore.read(server: session.serverURL, account: session.user.id)
                queuedSales = salesQueue?.pending ?? []
            }
            let startedAt = Date()
            var cutoff = salesQueue?.watermark
            var fetched: [ActivityEvent] = []
            var cursor: String?
            var cursors = Set<String>()
            repeat {
                try Task.checkCancellation()
                var query = [URLQueryItem(name: "environment", value: "Production"),
                             URLQueryItem(name: "limit", value: "100")]
                if let cursor { query.append(URLQueryItem(name: "before", value: cursor)) }
                let page: EventsResponse = try await client().request("/api/events", query: query)
                guard generation == sessionGeneration, request == salesQueueRequest else { return }
                let dates = try page.events.map(SalesQueue.receivedDate)
                fetched.append(contentsOf: page.events)
                if cutoff == nil { cutoff = dates.max() }
                // Include every ID on the boundary timestamp, even across multiple pages.
                if let cutoff, dates.contains(where: { $0 < cutoff }) { break }
                cursor = page.nextCursor
                if let cursor, (!cursors.insert(cursor).inserted || cursors.count > 1_000 || page.events.isEmpty) {
                    throw ClientError.message("Sales updates could not finish loading. Please refresh to try again.")
                }
            } while cursor != nil
            guard generation == sessionGeneration, request == salesQueueRequest else { return }
            if let activeAppIDs, fetched.contains(where: { !activeAppIDs.contains($0.appId) }) {
                // An unknown app could have just been connected. Check a fresh list before
                // discarding its sales, or advancing the checkpoint past them.
                let response: AppsResponse = try await client().request("/api/apps")
                guard generation == sessionGeneration, request == salesQueueRequest else { return }
                self.activeAppIDs = Set(response.apps.map(\.id)).subtracting(removedAppIDs)
            }
            // Read the CURRENT pending list: a reveal may have been acknowledged while awaiting a page.
            fetched.removeAll { removedAppIDs.contains($0.appId) }
            var updated = try salesQueue ?? SalesQueue.begin(with: fetched, now: startedAt)
            if salesQueue != nil { try updated.ingest(fetched) }
            if let activeAppIDs { updated.retainApps(activeAppIDs) }
            try salesQueueStore.write(updated, server: session.serverURL, account: session.user.id)
            salesQueue = updated
            queuedSales = updated.pending
        } catch {
            guard generation == sessionGeneration, request == salesQueueRequest else { return }
            if !handleUnauthorized(error) {
                queuedSalesError = "Queued sales could not be updated. Refresh to try again."
            }
        }
    }

    /// Call after displaying the captured reveal, using only that reveal's IDs.
    /// Persist before publishing so a write failure leaves the batch available to retry.
    @discardableResult
    func acknowledgeQueuedSales(ids: Set<String>) -> Bool {
        guard user != nil, !isSigningOut else { return false }
        if isPreviewMode {
            queuedSales.removeAll { ids.contains($0.id) }
            return true
        }
        guard let session = savedSession, var updated = salesQueue else { return false }
        updated.acknowledge(ids: ids)
        do {
            try salesQueueStore.write(updated, server: session.serverURL, account: session.user.id)
            salesQueue = updated
            queuedSales = updated.pending
            queuedSalesError = nil
            return true
        } catch {
            queuedSalesError = "Your reveal could not be saved. These sales will stay queued until you try again."
            return false
        }
    }

    func fetchSales(period: SalesPeriod, timeZone: TimeZone = .autoupdatingCurrent, displayCurrency: String = "") async throws -> SalesResponse {
        if isPreviewMode { return SalesResponse.demo(events: events, period: period, timeZone: timeZone) }
        guard user != nil, !isSigningOut else { throw ClientError.message("Sign in to view sales.") }
        let generation = sessionGeneration
        let now = Date(), formatter = ISO8601DateFormatter()
        var query = [URLQueryItem(name: "environment", value: selectedEnvironment.rawValue),
                     URLQueryItem(name: "to", value: formatter.string(from: now)),
                     URLQueryItem(name: "timeZone", value: timeZone == DisplayTimeZone.utc.timeZone ? "UTC" : timeZone.identifier)]
        if !displayCurrency.isEmpty { query.append(URLQueryItem(name: "displayCurrency", value: displayCurrency)) }
        if let start = period.start(now: now, calendar: Timestamp.calendar(timeZone: timeZone)) { query.append(URLQueryItem(name: "from", value: formatter.string(from: start))) }
        do {
            let response: SalesResponse = try await client().request("/api/sales", query: query)
            guard generation == sessionGeneration else { throw CancellationError() }
            return response
        } catch {
            guard generation == sessionGeneration else { throw CancellationError() }
            _ = handleUnauthorized(error)
            throw error
        }
    }

    func fetchTrials() async throws -> TrialsResponse {
        if isPreviewMode { return TrialsResponse.demo() }
        guard user != nil, !isSigningOut else { throw ClientError.message("Sign in to view trials.") }
        let environment = selectedEnvironment == .sandbox ? "Sandbox" : "Production"
        let generation = sessionGeneration
        do {
            return try await client().request("/api/trials", query: [URLQueryItem(name: "environment", value: environment)])
        } catch {
            guard generation == sessionGeneration else { throw CancellationError() }
            _ = handleUnauthorized(error)
            throw error
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
            apps = response.apps.filter { !removedAppIDs.contains($0.id) }
            let nextLeadAppID = selectedLeadAppID.flatMap { selected in apps.contains(where: { $0.id == selected }) ? selected : nil }
                ?? apps.first?.id
            if nextLeadAppID != selectedLeadAppID {
                selectedLeadAppID = nextLeadAppID
                resetLeadState(clearSelection: false)
            }
            let appIDs = Set(apps.map(\.id))
            activeAppIDs = appIDs
            if let session = savedSession, var updated = salesQueue {
                updated.retainApps(appIDs)
                // Hide removed details even if disk cleanup fails; a later sync retries the save.
                salesQueue = updated
                queuedSales = updated.pending
                do {
                    try salesQueueStore.write(updated, server: session.serverURL, account: session.user.id)
                } catch {
                    try? salesQueueStore.removeAll()
                    queuedSalesError = "Removed app data could not be saved locally. Refresh to retry cleanup."
                }
            }
        } catch {
            guard generation == sessionGeneration else { return }
            if !handleUnauthorized(error) { appsError = error.localizedDescription }
        }
    }

    func removeApp(id: String) async throws {
        guard !isPreviewMode, user != nil, !isSigningOut, !isDeletingAccount else {
            throw ClientError.message("Sign in to remove an app.")
        }
        let generation = sessionGeneration
        do {
            let _: OKResponse = try await client().request("/api/apps/\(id)", method: "DELETE")
            guard generation == sessionGeneration else { throw CancellationError() }
            // Stale reads must not restore an app or its sales after removal succeeds.
            removedAppIDs.insert(id)
            apps.removeAll { $0.id == id }
            if selectedLeadAppID == id {
                selectedLeadAppID = apps.first?.id
                resetLeadState(clearSelection: false)
            }
            activeAppIDs?.remove(id)
            events.removeAll { $0.appId == id }
            queuedSales.removeAll { $0.appId == id }
            if let session = savedSession, var updated = salesQueue {
                let retained = Set(updated.pending.map(\.appId)).subtracting(removedAppIDs)
                updated.retainApps(retained)
                salesQueue = updated
                do {
                    try salesQueueStore.write(updated, server: session.serverURL, account: session.user.id)
                } catch {
                    try? salesQueueStore.removeAll()
                    queuedSalesError = "Removed app data could not be saved locally. Refresh to retry cleanup."
                }
            }
        } catch {
            guard generation == sessionGeneration else { throw CancellationError() }
            _ = handleUnauthorized(error)
            throw error
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
        // Ask in context, after the user chooses notifications during setup.
        guard permissionStatus != .notDetermined || explicitlyRequested else { return }
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
                if user == nil { authError = error.localizedDescription }
                else { settingsError = "Could not safely sign out: \(error.localizedDescription). Reconnect and try again so this phone and session can be revoked." }
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
            do { try clearSession() }
            catch { authError = error.localizedDescription }
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
            let result: AccountDeletionStatus = try await APIClient(baseURL: address, token: nil, transport: transport)
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

    func showActivity() {
        activitySection = .events
        isActivityPresented = true
        selectedTab = "activity"
    }

    func notificationOpened(environment: String?, leadAppId: String? = nil) async {
        guard user != nil, !isPreviewMode else { return }
        if let leadAppId {
            if !apps.contains(where: { $0.id == leadAppId }) { await loadApps() }
            guard apps.contains(where: { $0.id == leadAppId }) else { return }
            selectedTab = "leads"
            selectLeadApp(leadAppId)
            await refreshLeadBoard()
            return
        }
        if let environment = ActivityEnvironment.fromNotification(environment) {
            selectedEnvironment = environment
        }
        showActivity()
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

    func selectLeadApp(_ appId: String) {
        guard apps.contains(where: { $0.id == appId }), selectedLeadAppID != appId else { return }
        selectedLeadAppID = appId
        resetLeadState(clearSelection: false)
    }

    func requestLeadProfileSetup(appID: String) {
        guard apps.contains(where: { $0.id == appID }), !isPreviewMode else { return }
        selectLeadApp(appID)
        requestedLeadSetupAppID = appID
        selectedTab = "leads"
    }

    func journal(for lead: LeadItem, appName: String) -> LeadJournalSession {
        let key = "\(lead.appId)|\(leadProfile?.revision ?? 0)|\(lead.id)"
        if let existing = journalSessions[key] { return existing }
        let session = LeadJournalSession(lead: lead, appName: appName, revision: leadProfile?.revision,
                                         plan: isPreviewMode ? LeadJournalExamples.plan(for: lead, appName: appName) : nil)
        journalSessions[key] = session
        return session
    }

    func prepareJournal(_ journal: LeadJournalSession) async {
        guard journal.plan == nil, !journal.isLoading else { return }
        guard !isPreviewMode, user != nil, let revision = journal.profileRevision,
              apps.contains(where: { $0.id == journal.lead.appId }) else {
            journal.error = "Open a current quest from your board to prepare replies."
            return
        }
        let generation = sessionGeneration
        journal.isLoading = true
        journal.error = nil
        defer { journal.isLoading = false }
        let path = "/api/apps/\(journal.lead.appId)/leads/\(journal.lead.postId)/replies"
        do {
            var response: LeadReplyResponse
            if let jobID = journal.jobID {
                response = try await client().request("\(path)/\(jobID)")
            } else {
                response = try await client().send(path, body: LeadScanStartRequest(expectedRevision: revision))
            }
            for attempt in 0..<20 {
                try Task.checkCancellation()
                guard generation == sessionGeneration, user != nil,
                      apps.contains(where: { $0.id == journal.lead.appId }) else { throw CancellationError() }
                if try journal.accept(response) { return }
                try await Task.sleep(for: .seconds(attempt < 5 ? 2 : 3))
                response = try await client().request("\(path)/\(response.jobId)")
            }
            journal.error = "Still preparing your suggestions. Check again in a moment."
        } catch is CancellationError {
            // The same job is checked when reopening; navigating away never queues another call.
        } catch {
            guard generation == sessionGeneration else { return }
            journal.error = error.localizedDescription
            _ = handleUnauthorized(error)
        }
    }

    func prepareLeadProfileEdit(appId: String) {
        guard appId == selectedLeadAppID else { return }
        leadMutationError = nil
        leadFailedDismissal = nil
        leadProfileSaveError = nil
    }

    func refreshLeadBoard(background: Bool = false) async {
        guard !Task.isCancelled else { return }
        // A background refresh must not erase the user's in-flight dismiss/undo action.
        if background && (leadUndoAction != nil || leadPendingPostID != nil || isSavingLeadProfile) { return }
        if isPreviewMode {
            guard let appId = selectedLeadAppID, let app = apps.first(where: { $0.id == appId }) else {
                leadProfile = nil
                leadItems = []
                leadProfileStatus = .local(code: "no_apps")
                return
            }
            leadProfile = LeadPreviewFixtures.profile(appId: appId)
            let dismissed = previewLeadDismissals[appId] ?? []
            leadItems = LeadPreviewFixtures.leads(app: app).filter { !dismissed.contains($0.id) }
            leadNextCursor = nil
            leadProfileStatus = .local(code: "demo")
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--leads-scan-preview"),
               let sample = LeadPreviewFixtures.leads(app: app).first {
                leadItems = []
                leadProfileStatus.progress = LeadScanProgress(phase: "assessing", batchId: "offline-preview", fraction: 0.56,
                    post: LeadReviewPost(id: sample.postId, community: sample.community, title: sample.title,
                                         excerpt: sample.excerpt, state: "reviewing"))
            }
            #endif
            leadBoardError = nil
            #if DEBUG
            if let state = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--onboarding-state=") }) {
                leadItems = []
                switch String(state.dropFirst("--onboarding-state=".count)) {
                case "loading": leadProfileStatus.progress = LeadScanProgress(phase: "assessing", batchId: "sample", fraction: 0.46, post: nil)
                case "error": leadBoardError = "Couldn’t load your quests. Check your connection and try again."
                default: leadProfileStatus = .local(code: "ready")
                }
            }
            #endif
            return
        }
        guard user != nil, !isSigningOut, !isDeletingAccount else { return }
        if apps.isEmpty && !isLoadingApps { await loadApps() }
        guard let appId = selectedLeadAppID, apps.contains(where: { $0.id == appId }) else {
            leadProfile = nil
            leadItems = []
            leadNextCursor = nil
            leadProfileStatus = .local(code: "no_apps")
            leadBoardError = nil
            return
        }
        // A visible-screen refresh supersedes an interrupted request; background polling waits.
        guard !Task.isCancelled, (!background || !isLoadingLeadBoard), leadPendingPostID == nil else { return }

        let generation = sessionGeneration
        let boardRequest = UUID()
        let profileRequest = UUID()
        let feedRequest = UUID()
        leadBoardRequest = boardRequest
        leadProfileRequest = profileRequest
        leadFeedRequest = feedRequest
        isLoadingLeadBoard = true
        leadBoardError = nil
        leadProfileSaveError = nil
        defer {
            if leadBoardRequest == boardRequest { isLoadingLeadBoard = false }
        }

        do {
            let access: LeadAccessResponse = try await client().request("/api/leads/access")
            guard isCurrentLeadBoard(appId: appId, generation: generation, boardRequest: boardRequest) else { return }
            leadAccess = access
            guard access.enabled else {
                leadProfile = nil
                leadLegacySuggestions = nil
                leadItems = []
                leadNextCursor = nil
                leadProfileStatus = .local(code: access.reasonCode ?? "disabled")
                return
            }

            let response: LeadProfileResponse = try await client().request("/api/apps/\(appId)/leads/profile")
            guard isCurrentLeadBoard(appId: appId, generation: generation, boardRequest: boardRequest),
                  leadProfileRequest == profileRequest, leadFeedRequest == feedRequest else { return }
            leadProfile = response.profile
            leadLegacySuggestions = response.legacySuggestions
            if !background { leadProfileStatus = response.status }
            if !background { leadUndoAction = nil }

            guard response.profile?.enabled == true else {
                leadItems = []
                leadNextCursor = nil
                return
            }

            let page: LeadsPageResponse = try await client().request("/api/apps/\(appId)/leads",
                query: [URLQueryItem(name: "limit", value: "20")])
            guard isCurrentLeadBoard(appId: appId, generation: generation, boardRequest: boardRequest),
                  leadFeedRequest == feedRequest,
                  leadProfile?.revision == response.profile?.revision else { return }
            leadItems = page.leads.filter { $0.appId == appId }
            lockedQuests = page.locked
            leadNextCursor = page.nextCursor
            var progress = page.status.progress
            if leadItems.isEmpty, progress?.canStart == true, access.aiAvailable,
               let revision = response.profile?.revision {
                let start: LeadScanStartResponse = try await client().send("/api/apps/\(appId)/leads/scan",
                    method: "POST", body: LeadScanStartRequest(expectedRevision: revision))
                guard isCurrentLeadBoard(appId: appId, generation: generation, boardRequest: boardRequest),
                      leadFeedRequest == feedRequest, leadProfile?.revision == revision else { return }
                progress = start.progress
            }
            leadProfileStatus = LeadProfileStatus(code: page.status.code,
                lastCollectedAt: response.status.lastCollectedAt,
                lastQualifiedAt: response.status.lastQualifiedAt,
                nextCheckAt: response.status.nextCheckAt,
                partial: response.status.partial || page.status.partial,
                limited: page.status.limited ?? response.status.limited,
                progress: progress)
        } catch {
            guard !Task.isCancelled, !(error is CancellationError),
                  (error as? URLError)?.code != .cancelled else { return }
            guard isCurrentLeadBoard(appId: appId, generation: generation, boardRequest: boardRequest),
                  leadProfileRequest == profileRequest, leadFeedRequest == feedRequest else { return }
            if handleUnauthorized(error) { return }
            if (error as? ClientError)?.isNotFound == true,
               (error as? ClientError)?.serverCode == "APP_NOT_FOUND" {
                removedAppIDs.insert(appId)
                apps.removeAll { $0.id == appId }
                selectedLeadAppID = apps.first?.id
                resetLeadState(clearSelection: false)
                leadBoardError = "This app is no longer connected. Choose another app or reconnect it from Apps."
            } else {
                leadBoardError = error.localizedDescription
            }
            leadItems = []
            leadNextCursor = nil
        }
    }

    func loadMoreLeads() async {
        guard !isPreviewMode, !isLoadingLeadBoard, !isLoadingMoreLeads, leadPendingPostID == nil,
              let appId = selectedLeadAppID, apps.contains(where: { $0.id == appId }),
              let cursor = leadNextCursor, let profile = leadProfile else { return }
        let generation = sessionGeneration
        let profileRevision = profile.revision
        let request = UUID()
        let feedEpoch = leadFeedRequest
        leadMoreRequest = request
        isLoadingMoreLeads = true
        defer { if leadMoreRequest == request { isLoadingMoreLeads = false } }
        do {
            let page: LeadsPageResponse = try await client().request("/api/apps/\(appId)/leads", query: [
                URLQueryItem(name: "cursor", value: cursor), URLQueryItem(name: "limit", value: "20")
            ])
            guard generation == sessionGeneration, request == leadMoreRequest,
                  selectedLeadAppID == appId, apps.contains(where: { $0.id == appId }),
                  leadProfile?.revision == profileRevision, leadFeedRequest == feedEpoch else { return }
            let existing = Set(leadItems.map(\.id))
            leadItems.append(contentsOf: page.leads.filter { $0.appId == appId && !existing.contains($0.id) })
            leadNextCursor = page.nextCursor
            leadProfileStatus = LeadProfileStatus(code: page.status.code,
                lastCollectedAt: leadProfileStatus.lastCollectedAt,
                lastQualifiedAt: leadProfileStatus.lastQualifiedAt,
                nextCheckAt: leadProfileStatus.nextCheckAt,
                partial: leadProfileStatus.partial || page.status.partial,
                limited: page.status.limited ?? leadProfileStatus.limited,
                progress: page.status.progress ?? leadProfileStatus.progress)
        } catch {
            guard generation == sessionGeneration, request == leadMoreRequest, selectedLeadAppID == appId,
                  leadProfile?.revision == profileRevision, leadFeedRequest == feedEpoch else { return }
            if !handleUnauthorized(error) { leadBoardError = error.localizedDescription }
        }
    }

    func saveLeadProfile(appId: String, request: LeadProfileSaveRequest) async throws {
        guard !isPreviewMode, user != nil, appId == selectedLeadAppID,
              apps.contains(where: { $0.id == appId }) else {
            throw ClientError.message("Choose a connected app to save its profile.")
        }
        let generation = sessionGeneration
        let operation = UUID()
        leadProfileSaveOperation = operation
        leadBoardRequest = UUID()
        leadProfileRequest = UUID()
        leadFeedRequest = UUID()
        leadMoreRequest = UUID()
        leadDismissOperation = UUID()
        leadPendingPostID = nil
        isLoadingLeadBoard = false
        isLoadingMoreLeads = false
        leadProfileSaveError = nil
        leadItems = []
        leadNextCursor = nil
        leadUndoAction = nil
        leadFeedRequest = UUID()
        isSavingLeadProfile = true
        defer { if leadProfileSaveOperation == operation { isSavingLeadProfile = false } }
        do {
            let result: LeadProfileSaveResponse = try await client().send(
                "/api/apps/\(appId)/leads/profile", method: "PUT", body: request)
            guard generation == sessionGeneration, operation == leadProfileSaveOperation,
                  selectedLeadAppID == appId, apps.contains(where: { $0.id == appId }) else {
                throw CancellationError()
            }
            leadProfile = result.profile
            leadLegacySuggestions = nil
            leadProfileStatus = .local(code: result.profile.enabled ? "waiting" : "needs_profile")
            await refreshLeadBoard()
        } catch {
            guard generation == sessionGeneration, operation == leadProfileSaveOperation,
                  selectedLeadAppID == appId else { throw CancellationError() }
            if handleUnauthorized(error) { throw error }
            leadProfileSaveError = (error as? ClientError)?.serverCode == "STALE_PROFILE"
                ? "This profile changed on another device. Reload it and review your edits before saving."
                : error.localizedDescription
            throw error
        }
    }

    func requestLeadDraft(appId: String) async {
        guard !isPreviewMode, user != nil, !isRequestingLeadDraft, appId == selectedLeadAppID,
              apps.contains(where: { $0.id == appId }), leadAccess?.enabled == true else { return }
        guard leadAccess?.aiAvailable == true else {
            leadDraftStatus = "unavailable"
            leadSetupMessage = "AI suggestions are unavailable. Enter the app’s problems and capabilities manually."
            return
        }
        let generation = sessionGeneration
        let operation = UUID()
        leadDraftOperation = operation
        leadDraft = nil
        leadDraftJobID = nil
        let requestId = leadDraftRequestID ?? UUID().uuidString
        leadDraftRequestID = requestId
        leadDraftStatus = "requesting"
        leadSetupMessage = nil
        isRequestingLeadDraft = true
        defer { if leadDraftOperation == operation { isRequestingLeadDraft = false } }
        do {
            let result: LeadDraftCreateResponse = try await client().send(
                "/api/apps/\(appId)/leads/draft", body: LeadDraftRequest(requestId: requestId))
            guard isCurrentLeadDraft(appId: appId, generation: generation, operation: operation) else { return }
            if result.status == "manual" {
                leadDraftStatus = "manual"
                leadSetupMessage = "The App Store description isn’t available. Enter the app’s problems and capabilities manually."
                leadDraftRequestID = nil
                return
            }
            guard let jobId = result.jobId else {
                leadDraftStatus = "unavailable"
                leadSetupMessage = "Setup suggestions could not be started. Continue manually or try again."
                return
            }
            leadDraftJobID = jobId
            await pollLeadDraft(appId: appId, jobId: jobId, generation: generation, operation: operation)
        } catch {
            guard isCurrentLeadDraft(appId: appId, generation: generation, operation: operation) else { return }
            if handleUnauthorized(error) { return }
            if ["REQUEST_ID_EXPIRED", "REQUEST_ID_CONFLICT"].contains((error as? ClientError)?.serverCode ?? "") {
                leadDraftRequestID = nil
            }
            leadDraftStatus = "unavailable"
            leadSetupMessage = (error as? ClientError)?.serverCode == "AI_UNAVAILABLE"
                ? "AI suggestions are unavailable. Enter the app’s problems and capabilities manually."
                : error.localizedDescription
        }
    }

    func retryLeadDraftStatus(appId: String) async {
        guard let jobId = leadDraftJobID, appId == selectedLeadAppID, !isPreviewMode,
              !isRequestingLeadDraft else { return }
        let generation = sessionGeneration
        let operation = UUID()
        leadDraftOperation = operation
        leadDraftStatus = "pending"
        leadSetupMessage = "Checking whether the suggestions are ready…"
        isRequestingLeadDraft = true
        defer { if leadDraftOperation == operation { isRequestingLeadDraft = false } }
        await pollLeadDraft(appId: appId, jobId: jobId, generation: generation, operation: operation)
    }

    func cancelLeadDraftPolling(appId: String) {
        guard appId == selectedLeadAppID else { return }
        leadDraftOperation = UUID()
        isRequestingLeadDraft = false
        if leadDraftStatus == "pending" {
            leadSetupMessage = "Suggestions are still processing. Check status when you return."
        }
    }

    func dismissLead(_ lead: LeadItem) async {
        guard let appId = selectedLeadAppID, lead.appId == appId,
              leadPendingPostID == nil, leadItems.contains(where: { $0.id == lead.id }) else { return }
        let revision = leadProfile?.revision
        let generation = sessionGeneration
        let operation = UUID()
        let action = LeadUndoAction(appId: appId, profileRevision: revision, lead: lead)
        leadDismissOperation = operation
        leadPendingPostID = lead.postId
        leadMutationError = nil
        leadFailedDismissal = nil
        leadUndoAction = nil
        leadItems.removeAll { $0.id == lead.id }
        leadFeedRequest = UUID()
        leadMoreRequest = UUID()
        isLoadingMoreLeads = false

        if isPreviewMode {
            leadPendingPostID = nil
            previewLeadDismissals[appId, default: []].insert(lead.id)
            leadUndoAction = action
            return
        }
        guard revision != nil, user != nil else {
            leadPendingPostID = nil
            leadMutationError = "Set up this app’s profile before dismissing leads."
            restoreLead(lead, appId: appId, revision: revision)
            return
        }
        do {
            let _: LeadMutationResponse = try await client().send(
                "/api/apps/\(appId)/leads/\(lead.postId)/dismissal", method: "PUT",
                body: LeadDismissalRequest(mutationId: action.mutationId))
            guard isCurrentLeadMutation(appId: appId, generation: generation, operation: operation, revision: revision) else { return }
            leadPendingPostID = nil
            leadUndoAction = action
        } catch {
            guard isCurrentLeadMutation(appId: appId, generation: generation, operation: operation, revision: revision) else { return }
            leadPendingPostID = nil
            if handleUnauthorized(error) { return }
            restoreLead(lead, appId: appId, revision: revision)
            leadFailedDismissal = lead
            leadMutationError = "This lead could not be dismissed and has been restored. Try again."
        }
    }

    func retryLeadDismissal() async {
        guard let lead = leadFailedDismissal else { return }
        leadFailedDismissal = nil
        await dismissLead(lead)
    }

    func undoLeadDismissal() async {
        guard let action = leadUndoAction, selectedLeadAppID == action.appId,
              leadProfile?.revision == action.profileRevision, leadPendingPostID == nil else { return }
        let appId = action.appId
        let generation = sessionGeneration
        let operation = UUID()
        leadDismissOperation = operation
        leadMutationError = nil
        if isPreviewMode {
            previewLeadDismissals[appId, default: []].remove(action.lead.id)
            restoreLead(action.lead, appId: appId, revision: action.profileRevision)
            if leadUndoAction?.id == action.id { leadUndoAction = nil }
            return
        }
        leadPendingPostID = action.lead.postId
        leadFeedRequest = UUID()
        leadMoreRequest = UUID()
        isLoadingMoreLeads = false
        do {
            let _: LeadMutationResponse = try await client().send(
                "/api/apps/\(appId)/leads/\(action.lead.postId)/dismissal", method: "DELETE",
                body: LeadDismissalRequest(mutationId: action.mutationId))
            guard isCurrentLeadMutation(appId: appId, generation: generation, operation: operation,
                                        revision: action.profileRevision), leadUndoAction?.id == action.id else { return }
            leadPendingPostID = nil
            restoreLead(action.lead, appId: appId, revision: action.profileRevision)
            leadUndoAction = nil
        } catch {
            guard isCurrentLeadMutation(appId: appId, generation: generation, operation: operation,
                                        revision: action.profileRevision), leadUndoAction?.id == action.id else { return }
            leadPendingPostID = nil
            if handleUnauthorized(error) { return }
            leadUndoAction = nil
            leadMutationError = (error as? ClientError)?.serverCode == "STALE_UNDO"
                ? "This lead was dismissed again on another device. Refresh the board to check its current state."
                : "Undo could not restore this lead. Refresh the board to check its current state."
        }
    }

    func clearLeadUndo(id: UUID) {
        guard leadUndoAction?.id == id, leadPendingPostID != leadUndoAction?.lead.postId else { return }
        leadUndoAction = nil
    }

    func leadOpenDestination(_ lead: LeadItem) -> LeadOpenDestination {
        LeadURL.destination(for: lead)
    }

    private func pollLeadDraft(appId: String, jobId: String, generation: UUID, operation: UUID) async {
        let delays: [UInt64] = [2, 4, 6, 8, 10]
        for delay in delays {
            do { try await Task.sleep(for: .seconds(delay)) }
            catch { return }
            guard isCurrentLeadDraft(appId: appId, generation: generation, operation: operation) else { return }
            do {
                let result: LeadDraftStatusResponse = try await client().request(
                    "/api/apps/\(appId)/leads/drafts/\(jobId)")
                guard isCurrentLeadDraft(appId: appId, generation: generation, operation: operation) else { return }
                switch result.status {
                case "succeeded":
                    guard let draft = result.draft else {
                        leadDraftStatus = "failed"
                        leadSetupMessage = "Setup suggestions were incomplete. Enter the app’s problems and capabilities manually."
                        return
                    }
                    leadDraft = draft
                    leadDraftStatus = "succeeded"
                    leadDraftRequestID = nil
                    leadSetupMessage = "Review and edit these App Store based suggestions before saving."
                    return
                case "failed", "uncertain", "cancelled":
                    leadDraftStatus = result.status
                    leadDraftRequestID = nil
                    leadSetupMessage = "AI suggestions are unavailable. Enter the app’s problems and capabilities manually."
                    return
                default:
                    if result.reasonCode == "BUDGET_PAUSED" || result.reasonCode == "DAILY_LIMIT" {
                        leadDraftStatus = "limited"
                        leadSetupMessage = "AI setup suggestions are paused by current usage limits. You can continue manually or check status later."
                        return
                    }
                    leadDraftStatus = "pending"
                    leadSetupMessage = "The suggestions are still processing. You can continue editing manually."
                }
            } catch {
                guard isCurrentLeadDraft(appId: appId, generation: generation, operation: operation) else { return }
                if handleUnauthorized(error) { return }
                leadDraftStatus = "pending"
                leadSetupMessage = "The setup status could not be checked. Retry status or continue manually."
                return
            }
        }
        guard isCurrentLeadDraft(appId: appId, generation: generation, operation: operation) else { return }
        leadDraftStatus = "pending"
        leadSetupMessage = "Suggestions are still processing. Check status when you return."
    }

    private func isCurrentLeadBoard(appId: String, generation: UUID, boardRequest: UUID) -> Bool {
        !Task.isCancelled && generation == sessionGeneration && leadBoardRequest == boardRequest && selectedLeadAppID == appId &&
            apps.contains(where: { $0.id == appId }) && user != nil && !isSigningOut && !isDeletingAccount
    }

    private func isCurrentLeadDraft(appId: String, generation: UUID, operation: UUID) -> Bool {
        generation == sessionGeneration && leadDraftOperation == operation && selectedLeadAppID == appId &&
            apps.contains(where: { $0.id == appId }) && user != nil && !isPreviewMode
    }

    private func isCurrentLeadMutation(appId: String, generation: UUID, operation: UUID, revision: Int?) -> Bool {
        generation == sessionGeneration && leadDismissOperation == operation && selectedLeadAppID == appId &&
            apps.contains(where: { $0.id == appId }) && user != nil && leadProfile?.revision == revision
    }

    private func restoreLead(_ lead: LeadItem, appId: String, revision: Int?) {
        guard selectedLeadAppID == appId, apps.contains(where: { $0.id == appId }),
              leadProfile?.revision == revision, !leadItems.contains(where: { $0.id == lead.id }) else { return }
        leadItems.append(lead)
        leadItems.sort {
            (Timestamp.date($0.createdAt) ?? .distantPast) > (Timestamp.date($1.createdAt) ?? .distantPast)
        }
    }

    private func resetLeadState(clearSelection: Bool) {
        lockedQuests = nil
        if clearSelection { selectedLeadAppID = nil; journalSessions = [:] }
        leadBoardRequest = UUID()
        leadProfileRequest = UUID()
        leadFeedRequest = UUID()
        leadMoreRequest = UUID()
        leadDraftOperation = UUID()
        leadDraftRequestID = nil
        leadProfileSaveOperation = UUID()
        leadDismissOperation = UUID()
        leadAccess = nil
        leadProfile = nil
        leadLegacySuggestions = nil
        leadProfileStatus = .local(code: "needs_profile")
        leadItems = []
        leadNextCursor = nil
        isLoadingLeadBoard = false
        isLoadingMoreLeads = false
        leadBoardError = nil
        leadSetupMessage = nil
        leadProfileSaveError = nil
        isSavingLeadProfile = false
        isRequestingLeadDraft = false
        leadDraftStatus = "idle"
        leadDraft = nil
        leadDraftJobID = nil
        leadDraftRequestID = nil
        leadMutationError = nil
        leadFailedDismissal = nil
        leadPendingPostID = nil
        leadUndoAction = nil
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
        var cleanupError: Error?
        if removeStoredSession {
            do { try salesQueueStore.removeAll() }
            catch { cleanupError = ClientError.message("The local sales cache could not be removed. Reopen Questline to retry, or remove the app to clear it from this phone.") }
            do { try KeychainStore.remove("session") }
            catch { if cleanupError == nil { cleanupError = error } }
        }
        if !isPreviewMode {
            UIApplication.shared.unregisterForRemoteNotifications()
            UNUserNotificationCenter.current().removeAllDeliveredNotifications()
            UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
        }
        sessionGeneration = UUID()
        previewLeadDismissals = [:]
        resetLeadState(clearSelection: true)
        salesQueueRequest = UUID()
        salesQueue = nil
        activeAppIDs = nil
        removedAppIDs = []
        queuedSales = []
        queuedSalesError = nil
        isLoadingQueuedSales = false
        activityRequest = UUID()
        pairingRequest = UUID()
        pairingIsBusy = false
        isPairingPresented = false
        pairingLink = nil
        pairingReview = nil
        pairingError = nil
        pairingNotice = nil
        savedSession = nil
        onboarding = nil
        onboardingError = nil
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
        isActivityPresented = false
        activitySection = .events
        if let cleanupError { throw cleanupError }
    }
}


extension AppModel {
    func marketOverview(appID: String) async throws -> MarketOverview {
        guard !isPreviewMode, user != nil, apps.contains(where: { $0.id == appID }) else {
            throw ClientError.message("Market insights require a connected app and signed-in account.")
        }
        let generation = sessionGeneration
        do {
            let response: MarketOverview = try await client().request("/api/apps/\(appID)/market")
            guard generation == sessionGeneration, user != nil,
                  apps.contains(where: { $0.id == appID }), response.appId == appID else {
                throw CancellationError()
            }
            return response
        } catch {
            guard generation == sessionGeneration else { throw CancellationError() }
            if handleUnauthorized(error) { throw CancellationError() }
            throw error
        }
    }

    func marketPeople(appID: String, revision: Int, snapshotId: String?, problemID: String?, page: MarketPaginationRequest) async throws -> MarketPeoplePageDTO {
        guard !isPreviewMode, user != nil, apps.contains(where: { $0.id == appID }) else {
            throw ClientError.message("Market people require a connected app and signed-in account.")
        }
        var query = [URLQueryItem(name: "limit", value: String(page.limit))]
        if let snapshotId { query.append(URLQueryItem(name: "snapshotId", value: snapshotId)) }
        if let problemID { query.append(URLQueryItem(name: "problemId", value: problemID)) }
        if let cursor = page.cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        let generation = sessionGeneration
        do {
            let response: MarketPeoplePageDTO = try await client().request("/api/apps/\(appID)/market/people", query: query)
            guard generation == sessionGeneration, user != nil,
                  apps.contains(where: { $0.id == appID }), response.appId == appID else {
                throw CancellationError()
            }
            guard response.profileRevision == revision else {
                throw ClientError.codedServer(status: 409,
                                              message: "Market evidence changed while it was loading. Refresh to continue.",
                                              code: "STALE_PROFILE")
            }
            guard response.snapshotId == snapshotId else {
                throw ClientError.codedServer(status: 409,
                                              message: "This evidence snapshot has expired. Refresh to load current evidence.",
                                              code: "STALE_SNAPSHOT")
            }
            guard response.problemId == problemID else { throw ClientError.invalidResponse }
            return response
        } catch {
            guard generation == sessionGeneration else { throw CancellationError() }
            if handleUnauthorized(error) { throw CancellationError() }
            throw error
        }
    }

    func startMarketScan(appID: String, revision: Int, idempotencyKey: String) async throws -> MarketScanDTO {
        guard !isPreviewMode, user != nil, apps.contains(where: { $0.id == appID }) else {
            throw ClientError.message("Market scans require a connected app and signed-in account.")
        }
        let generation = sessionGeneration
        do {
            let response: MarketScanStartResponse = try await client().send(
                "/api/apps/\(appID)/market/scan",
                body: MarketScanRequest(expectedRevision: revision, idempotencyKey: idempotencyKey))
            guard generation == sessionGeneration, user != nil,
                  apps.contains(where: { $0.id == appID }),
                  response.scan.profileRevision == revision else { throw CancellationError() }
            return response.scan
        } catch {
            guard generation == sessionGeneration else { throw CancellationError() }
            if handleUnauthorized(error) { throw CancellationError() }
            throw error
        }
    }

    func marketScan(appID: String, scanID: String) async throws -> MarketScanDTO {
        guard !isPreviewMode, user != nil, apps.contains(where: { $0.id == appID }) else {
            throw ClientError.message("Market scans require a connected app and signed-in account.")
        }
        let generation = sessionGeneration
        do {
            let response: MarketScanDTO = try await client().request("/api/apps/\(appID)/market/scans/\(scanID)")
            guard generation == sessionGeneration, user != nil,
                  apps.contains(where: { $0.id == appID }), response.id == scanID else {
                throw CancellationError()
            }
            return response
        } catch {
            guard generation == sessionGeneration else { throw CancellationError() }
            if handleUnauthorized(error) { throw CancellationError() }
            throw error
        }
    }

    func checkTestFlightInstallation() async {
        #if !DEBUG && !targetEnvironment(simulator)
        guard !isTestFlight else { return }
        // TestFlight's receipt is available without an asynchronous StoreKit lookup.
        // Keep this compatibility signal: AppTransaction can be unavailable on beta installs.
        if Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt" {
            isTestFlight = true
            return
        }
        guard case .verified(let transaction) = try? await AppTransaction.shared else { return }
        isTestFlight = transaction.environment == .sandbox
        #endif
    }

    func retryOnboarding() async throws {
        guard canRetryOnboarding, !isChangingOnboarding else {
            throw ClientError.message("Onboarding can only be retried in TestFlight.")
        }
        let generation = sessionGeneration
        onboardingOperation = UUID()
        isChangingOnboarding = true
        defer { isChangingOnboarding = false }
        // Bootstrap older beta accounts before updating their stage. Entitlements stay server-owned.
        let _: QuestOnboardingState = try await client().send("/api/onboarding/bootstrap", body: EmptyOnboardingBody())
        guard generation == sessionGeneration else { throw CancellationError() }
        struct Input: Encodable { let stage = OnboardingStage.app }
        let state: QuestOnboardingState = try await client().send("/api/onboarding", method: "PUT", body: Input())
        guard generation == sessionGeneration else { throw CancellationError() }
        for session in journalSessions.values { session.onboardingSelection = OnboardingReplySelection() }
        for app in apps {
            updateConnectionProgress(for: app) { $0.step = .provider; $0.pushPromptSeen = false }
        }
        onboardingError = nil
        onboarding = state
    }

    func loadOnboarding() async {
        guard user != nil, !isPreviewMode, !isChangingOnboarding else { return }
        let generation = sessionGeneration
        let operation = UUID()
        onboardingOperation = operation
        do {
            let state: QuestOnboardingState = try await client().send("/api/onboarding/bootstrap", body: EmptyOnboardingBody())
            guard generation == sessionGeneration, operation == onboardingOperation else { return }
            onboarding = state
            onboardingError = nil
            if let appId = state.appId, apps.contains(where: { $0.id == appId }), shouldShowOnboarding {
                selectLeadApp(appId)
            }
        } catch {
            guard generation == sessionGeneration, operation == onboardingOperation else { return }
            if handleUnauthorized(error) { return }
            // A previously completed account stays usable offline. New accounts get a retry page.
            if onboarding == nil && apps.isEmpty { onboarding = QuestOnboardingState(stage: .app) }
            onboardingError = error.localizedDescription
        }
    }

    func moveOnboarding(to stage: OnboardingStage, appId: String? = nil) async throws {
        if isPreviewMode {
            onboarding?.stage = stage
            if let appId { onboarding?.appId = appId }
            return
        }
        let generation = sessionGeneration
        onboardingOperation = UUID()
        isChangingOnboarding = true
        defer { isChangingOnboarding = false }
        struct Input: Encodable { let stage: OnboardingStage; let appId: String? }
        let state: QuestOnboardingState = try await client().send("/api/onboarding", method: "PUT", body: Input(stage: stage, appId: appId))
        guard generation == sessionGeneration else { throw CancellationError() }
        onboarding = state
        onboardingError = nil
    }

    func searchOnboardingApps(_ input: String) async throws -> [AppStoreMatch] {
        if isPreviewMode { return apps.filter { $0.name.localizedCaseInsensitiveContains(input) }.map(AppStoreMatch.init) }
        let generation = sessionGeneration
        let term = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let matches: [AppStoreMatch]
        if term.contains("://") {
            struct Input: Encodable { let url: String }
            let result: AppStoreMatch = try await client().send("/api/apps/lookup", body: Input(url: term))
            matches = [result]
        } else {
            struct Input: Encodable { let term: String }
            struct Result: Decodable { let apps: [AppStoreMatch] }
            let result: Result = try await client().send("/api/apps/search", body: Input(term: term))
            matches = result.apps
        }
        guard generation == sessionGeneration else { throw CancellationError() }
        return matches
    }

    func chooseOnboardingApp(_ match: AppStoreMatch) async throws {
        var app = apps.first { $0.bundleId == match.bundleId }
        if app == nil {
            let generation = sessionGeneration
            struct Input: Encodable {
                let name: String; let bundleId: String; let appleId: String; let iconUrl: String?
                let source = "apple"
            }
            struct Result: Decodable { let app: ConnectedApp }
            let result: Result = try await client().send("/api/apps", body: Input(name: match.name, bundleId: match.bundleId, appleId: match.appleId, iconUrl: match.iconUrl))
            guard generation == sessionGeneration else { throw CancellationError() }
            app = result.app
            apps.append(result.app)
        }
        guard let app else { throw ClientError.message("Choose your app to continue.") }
        selectLeadApp(app.id)
        try await moveOnboarding(to: .quest, appId: app.id)
    }

    func startQuestTrial() async throws {
        if isPreviewMode {
            onboarding?.trialStartedAt = Date().timeIntervalSince1970 * 1000
            onboarding?.trialEndsAt = Date().addingTimeInterval(14 * 86400).timeIntervalSince1970 * 1000
            onboarding?.trialActive = true
            onboarding?.trialAvailable = false
            onboarding?.stage = .notifications
            lockedQuests = nil
            return
        }
        let generation = sessionGeneration
        onboardingOperation = UUID()
        isChangingOnboarding = true
        defer { isChangingOnboarding = false }
        let state: QuestOnboardingState = try await client().send("/api/onboarding/trial", body: EmptyOnboardingBody())
        guard generation == sessionGeneration else { throw CancellationError() }
        onboarding = state
        await refreshLeadBoard()
    }

    func finishOnboarding() async throws {
        try await moveOnboarding(to: .complete)
        selectedTab = "leads"
    }

    var phoneAlertsReady: Bool {
        [.authorized, .provisional, .ephemeral].contains(permissionStatus) && deviceId != nil
    }

    private func storeProgressKey(for appID: String) -> String {
        StoreConnectionProgress.key(server: serverSettings.url, userID: user?.id ?? "", appID: appID)
    }

    func connectionProgress(for app: ConnectedApp) -> StoreConnectionProgress {
        storeConnectionProgress[storeProgressKey(for: app.id)]
            ?? StoreConnectionProgress(provider: app.source == "revenuecat" ? .revenuecat : .apple)
    }

    func updateConnectionProgress(for app: ConnectedApp, _ update: (inout StoreConnectionProgress) -> Void) {
        guard user != nil else { return }
        var progress = connectionProgress(for: app)
        update(&progress)
        storeConnectionProgress[storeProgressKey(for: app.id)] = progress
        if persistsStoreProgress && !isPreviewMode,
           let data = try? JSONEncoder().encode(storeConnectionProgress) {
            UserDefaults.standard.set(data, forKey: Self.storeProgressKey)
        }
    }

    var unfinishedStoreSetup: ConnectedApp? {
        guard !shouldShowOnboarding, !isPreviewMode else { return nil }
        return apps.first { app in
            !app.hasVerifiedProductionConnection &&
                (connectionProgress(for: app).started || (onboarding?.legacy != true && onboarding?.appId == app.id))
        }
    }

    #if DEBUG
    func enterOnboardingPreview(stage: OnboardingStage) async {
        enterPreview()
        guard let app = apps.first else { return }
        selectLeadApp(app.id)
        await refreshLeadBoard()
        onboarding = QuestOnboardingState(stage: stage, appId: app.id)
        lockedQuests = LockedQuests(count: 7, hasMore: false, previews: [
            LockedQuestPreview(id: "sample-locked-one", community: "journaling"),
            LockedQuestPreview(id: "sample-locked-two", community: "productivity")])
        if let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--store-setup-preview=") }) {
            let state = String(argument.dropFirst("--store-setup-preview=".count))
            updateConnectionProgress(for: app) {
                $0.pushPromptSeen = state != "push"
                $0.started = true
                $0.provider = state == "revenuecat" ? .revenuecat : .apple
                $0.step = ["apple", "revenuecat"].contains(state) ? .guide : ["waiting", "connected"].contains(state) ? .status : .provider
            }
            if state != "push" { permissionStatus = .authorized; deviceId = "offline-preview-phone" }
            if state == "connected" {
                apps[0] = ConnectedApp(id: app.id, name: app.name, bundleId: app.bundleId, appleId: app.appleId,
                    source: app.source, iconUrl: app.iconUrl, createdAt: app.createdAt, webhookUrls: app.webhookUrls,
                    lastProductionEventAt: "2026-09-24T12:00:00Z", lastSandboxEventAt: nil,
                    forwardingUrl: nil, bundledIconName: app.bundledIconName)
            }
        }
    }
    #endif
}

private struct EmptyOnboardingBody: Encodable {}
