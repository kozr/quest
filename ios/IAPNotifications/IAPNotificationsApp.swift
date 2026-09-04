import SwiftUI
import UIKit
import UserNotifications
import AuthenticationServices

@main
struct IAPNotificationsApp: App {
    @UIApplicationDelegateAdaptor(PushDelegate.self) private var pushDelegate
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .task {
                    pushDelegate.model = model
                    await model.bootstrap()
                    await pushDelegate.openPendingNotificationIfNeeded()
                }
                .onChange(of: model.user?.id) { _, userID in
                    if userID != nil { Task { await pushDelegate.openPendingNotificationIfNeeded() } }
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { Task { await model.foreground() } }
                }
                .onOpenURL { url in
                    Task { await model.inspectPairingLink(url.absoluteString) }
                }
                .sheet(isPresented: $model.isPairingPresented, onDismiss: model.closePairing) {
                    PairingView().environmentObject(model)
                }
        }
    }
}

@MainActor
final class PushDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    weak var model: AppModel?
    private var pendingEnvironment: String?
    private var hasPendingNotification = false

    func openPendingNotificationIfNeeded() async {
        guard hasPendingNotification, model?.user != nil else { return }
        hasPendingNotification = false
        let environment = pendingEnvironment
        pendingEnvironment = nil
        await model?.notificationOpened(environment: environment)
    }

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { await model?.receivedAPNSToken(token) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        model?.registrationFailed(error)
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                           willPresent notification: UNNotification,
                                           withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
        Task { @MainActor [weak self] in await self?.model?.loadActivity() }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                           didReceive response: UNNotificationResponse,
                                           withCompletionHandler completionHandler: @escaping () -> Void) {
        let environment = response.notification.request.content.userInfo["environment"] as? String
        completionHandler()
        Task { @MainActor [weak self] in
            guard let self else { return }
            pendingEnvironment = environment
            hasPendingNotification = true
            await openPendingNotificationIfNeeded()
        }
    }
}

private struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Group {
            if model.isBootstrapping {
                VStack(spacing: 16) {
                    ProgressView()
                    Text("Connecting to your server…").foregroundStyle(.secondary)
                }
            } else if model.user == nil {
                AuthenticationView()
            } else {
                TabView(selection: $model.selectedTab) {
                    ActivityView()
                        .tabItem { Label("Activity", systemImage: "bell") }
                        .tag("activity")
                    AppsView()
                        .tabItem { Label("Apps", systemImage: "square.stack") }
                        .tag("apps")
                    SettingsView()
                        .tabItem { Label("Settings", systemImage: "gearshape") }
                        .tag("settings")
                }
            }
        }
    }
}

private struct AuthenticationView: View {
    @EnvironmentObject private var model: AppModel
    @State private var appleAttempt: AppleAttempt?
    @State private var serverURL = ""
    @State private var allowLocalHTTP = false
    @State private var isServerExpanded = true

    private struct AppleAttempt {
        let nonce: String
        let state: String
        let serverURL: String
        let allowLocalHTTP: Bool
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Sales and refund alerts for your apps.")
                    Text("Sign in with Apple here, then scan and approve your computer's QR code from Settings. No desktop login or password needed.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    if let message = model.pairingSignInNotice {
                        Label(message, systemImage: "qrcode.viewfinder")
                            .font(.subheadline)
                    }
                }
                Section("Server") {
                    DisclosureGroup("Server connection", isExpanded: $isServerExpanded) {
                        TextField("https://alerts.example.com", text: $serverURL)
                            .textContentType(.URL)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("serverURL")
                        #if DEBUG
                        Toggle("Allow local development HTTP", isOn: $allowLocalHTTP)
                        Text("Debug only. HTTP is allowed for localhost, .local names, and private IPv4 addresses. Use HTTPS for hosted servers.")
                            .font(.caption).foregroundStyle(.secondary)
                        #endif
                        Button {
                            Task { await model.checkServer(url: serverURL, allowLocalHTTP: allowLocalHTTP) }
                        } label: {
                            HStack {
                                Text("Check connection")
                                Spacer()
                                if model.isCheckingServer { ProgressView() }
                            }
                        }
                        .disabled(serverURL.isEmpty || model.isCheckingServer || model.isAuthenticating)
                    }
                    if let message = model.connectionMessage {
                        Label(message, systemImage: "checkmark.circle").font(.subheadline)
                    }
                }
                Section("Sign in") {
                    SignInWithAppleButton(.signIn) { request in
                        model.authError = nil
                        do {
                            let address = try ServerAddress.validate(serverURL, allowLocalHTTP: allowLocalHTTP)
                            let attempt = AppleAttempt(nonce: try AppleSignInNonce.make(), state: UUID().uuidString,
                                                       serverURL: address.absoluteString, allowLocalHTTP: allowLocalHTTP)
                            appleAttempt = attempt
                            request.requestedScopes = [.email]
                            request.nonce = AppleSignInNonce.hash(attempt.nonce)
                            request.state = attempt.state
                        } catch { model.authError = error.localizedDescription }
                    } onCompletion: { result in
                        let attempt = appleAttempt
                        appleAttempt = nil
                        switch result {
                        case .success(let authorization):
                            guard let attempt,
                                  let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                                  credential.state == attempt.state,
                                  let data = credential.identityToken,
                                  let token = String(data: data, encoding: .utf8) else {
                                model.authError = "Apple sign-in could not be completed. Please try again."
                                return
                            }
                            Task { await model.authenticateWithApple(idToken: token, rawNonce: attempt.nonce,
                                                                     url: attempt.serverURL, allowLocalHTTP: attempt.allowLocalHTTP) }
                        case .failure(let error):
                            if (error as? ASAuthorizationError)?.code != .canceled {
                                model.authError = "Apple sign-in failed. Check your Apple Account in iPhone Settings and try again."
                            }
                        }
                    }
                    .signInWithAppleButtonStyle(.black)
                    .frame(height: 50)
                    .accessibilityIdentifier("signInWithApple")
                    .disabled((try? ServerAddress.validate(serverURL, allowLocalHTTP: allowLocalHTTP)) == nil ||
                              model.isAuthenticating || model.isCheckingServer || appleAttempt != nil)
                    if model.isAuthenticating { ProgressView("Finishing Apple sign-in…") }
                    Text(model.config?.registrationEnabled == false
                         ? "This server is accepting existing beta accounts only."
                         : "Your account is created on first sign-in. Hide My Email is supported.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let error = model.authError { Section { ErrorMessage(message: error) } }
            }
            .navigationTitle("IAP Notifications")
            .onAppear {
                serverURL = model.serverSettings.url
                allowLocalHTTP = model.serverSettings.allowLocalHTTP
            }
        }
    }

}

private struct ActivityView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Environment", selection: $model.selectedEnvironment) {
                        ForEach(ActivityEnvironment.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("activityEnvironment")
                    if model.selectedEnvironment != .production {
                        Label(model.selectedEnvironment == .demo
                              ? "Demo events are examples, not real sales or proof that Apple is connected."
                              : "Sandbox events are test purchases, not real sales.",
                              systemImage: "info.circle")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let error = model.activityError {
                    Section {
                        ErrorMessage(message: error)
                        Button("Retry") { Task { await model.loadActivity() } }
                    }
                }
                if model.isLoadingActivity && model.events.isEmpty {
                    Section { HStack { Spacer(); ProgressView("Loading activity…"); Spacer() } }
                } else if model.events.isEmpty && model.activityError == nil {
                    ContentUnavailableView {
                        Label("No \(model.selectedEnvironment.rawValue.lowercased()) activity", systemImage: "bell")
                    } description: {
                        Text(model.selectedEnvironment == .production
                             ? "Add an app in the Apps tab. Verified Apple events will appear here."
                             : "Events from this environment will appear here when received.")
                    }
                    .listRowBackground(Color.clear)
                }
                ForEach(model.events) { event in
                    NavigationLink {
                        EventDetailView(event: event)
                    } label: {
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: event.symbol).frame(width: 24).padding(.top, 2)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 5) {
                                Text(event.title).font(.headline)
                                Text(event.appName).font(.subheadline)
                                Text(event.detail).font(.subheadline).foregroundStyle(.secondary)
                                Text(Timestamp.display(event.occurredAt)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
                if model.nextCursor != nil {
                    Button {
                        Task { await model.loadActivity(loadMore: true) }
                    } label: {
                        HStack { Text("Load older events"); Spacer(); if model.isLoadingActivity { ProgressView() } }
                    }
                    .disabled(model.isLoadingActivity)
                }
            }
            .navigationTitle("Activity")
            .refreshable { await model.loadActivity() }
            .onChange(of: model.selectedEnvironment) { _, _ in Task { await model.loadActivity() } }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await model.loadActivity() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                        .disabled(model.isLoadingActivity)
                }
            }
        }
    }
}

private struct EventDetailView: View {
    let event: ActivityEvent

    var body: some View {
        Form {
            Section {
                Label(event.title, systemImage: event.symbol).font(.headline)
                Text(event.detail)
                LabeledContent("App", value: event.appName)
                LabeledContent("Environment", value: event.environment)
                if let amount = event.amountDescription { LabeledContent("Amount", value: amount) }
            }
            Section("Event details") {
                LabeledContent("Occurred", value: Timestamp.display(event.occurredAt))
                LabeledContent("Received", value: Timestamp.display(event.receivedAt))
                LabeledContent("Apple event", value: event.notificationType)
                if let subtype = event.subtype { LabeledContent("Subtype", value: subtype) }
                if let product = event.productId { LabeledContent("Product", value: product) }
                if let transaction = event.transactionId { LabeledContent("Transaction", value: transaction) }
            }
            Section {
                Text("Amounts reflect transaction prices, not net proceeds or payouts. Currencies are kept separate. Consult App Store Connect for accounting.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .textSelection(.enabled)
        .navigationTitle("Event")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct AppsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        if let url = model.browserSetupURL { openURL(url) }
                    } label: { Label("Add or manage apps in browser", systemImage: "safari") }
                    Text("On a computer, display the browser's sign-in QR code, then choose Settings → Sign in on computer here. After connecting apps, return here and refresh.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let error = model.appsError {
                    Section {
                        ErrorMessage(message: error)
                        Button("Retry") { Task { await model.loadApps() } }
                    }
                }
                if model.isLoadingApps && model.apps.isEmpty {
                    HStack { Spacer(); ProgressView("Loading apps…"); Spacer() }
                } else if model.apps.isEmpty && model.appsError == nil {
                    ContentUnavailableView("No apps connected", systemImage: "square.stack", description: Text("Open browser setup to add your first app."))
                        .listRowBackground(Color.clear)
                }
                ForEach(model.apps) { app in
                    NavigationLink {
                        AppDetailView(app: app)
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(app.name).font(.headline)
                            Text(app.bundleId).font(.caption).foregroundStyle(.secondary)
                            Label(app.lastProductionEventAt == nil ? "Waiting for Apple" : "Production events received",
                                  systemImage: app.lastProductionEventAt == nil ? "clock" : "checkmark.circle")
                                .font(.subheadline)
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            .navigationTitle("Apps")
            .refreshable { await model.loadApps() }
            .toolbar {
                Button { Task { await model.loadApps() } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .disabled(model.isLoadingApps)
            }
        }
    }
}

private struct AppDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    let app: ConnectedApp

    var body: some View {
        Form {
            Section("App") {
                LabeledContent("Name", value: app.name)
                LabeledContent("Bundle ID", value: app.bundleId)
                LabeledContent("Apple ID", value: app.appleId)
                LabeledContent("Source", value: app.source == "revenuecat" ? "RevenueCat forwarding" : "Apple directly")
            }
            Section("Connection") {
                LabeledContent("Production", value: app.lastProductionEventAt.map(Timestamp.display) ?? "Waiting for Apple")
                LabeledContent("Sandbox", value: app.lastSandboxEventAt.map(Timestamp.display) ?? "Waiting for Apple")
                Text("These are the latest verified events received from Apple. A demo event or test push does not establish this connection.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section {
                Button {
                    if let url = model.browserSetupURL { openURL(url) }
                } label: { Label("Manage connection in browser", systemImage: "safari") }
            }
        }
        .textSelection(.enabled)
        .navigationTitle(app.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    @State private var confirmingLogout = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Computer access") {
                    Button(action: model.beginPairing) {
                        Label("Sign in on computer", systemImage: "qrcode.viewfinder")
                    }
                    .disabled(model.isSigningOut)
                    .accessibilityIdentifier("startPairing")
                    Text("Scan the QR code on a browser you opened yourself. You will compare a matching code and explicitly approve access.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("Phone notifications") {
                    LabeledContent("Permission", value: model.permissionDescription)
                    LabeledContent("Phone registration", value: model.deviceId == nil ? "Not registered" : "Registered")
                    LabeledContent("Push environment", value: model.pushEnvironment.capitalized)
                    if let config = model.config, !config.apnsConfigured {
                        Label("The server has no APNs credentials. Activity works, but push delivery is unavailable until the server owner configures APNs.", systemImage: "exclamationmark.triangle")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    if model.permissionStatus == .denied {
                        Button("Open iPhone notification settings") {
                            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                        }
                    } else {
                        Button {
                            Task { await model.enableNotifications() }
                        } label: {
                            HStack {
                                Text(model.deviceId == nil ? "Enable notifications" : "Refresh phone registration")
                                Spacer()
                                if model.isRegisteringDevice { ProgressView() }
                            }
                        }
                        .disabled(model.isRegisteringDevice || model.isSigningOut)
                    }
                    Button {
                        Task { await model.sendTestPush() }
                    } label: {
                        HStack {
                            Text("Send test push")
                            Spacer()
                            if model.isTestingPush { ProgressView() }
                        }
                    }
                    .disabled(model.deviceId == nil || model.config?.apnsConfigured != true || model.isTestingPush || model.isSigningOut)
                    if let message = model.pushMessage { Text(message).font(.caption).foregroundStyle(.secondary) }
                    if let error = model.pushError { ErrorMessage(message: error) }
                }
                Section {
                    if model.preferences != nil {
                        Toggle("Sales and renewals", isOn: preference(\.sales))
                        Toggle("Refunds and reversals", isOn: preference(\.refunds))
                        Toggle("Subscription lifecycle", isOn: preference(\.lifecycle))
                        Toggle("Sandbox alerts", isOn: preference(\.sandbox))
                        Toggle("Hide amounts in notifications", isOn: preference(\.hideAmounts))
                    } else {
                        Button("Load alert preferences") { Task { await model.loadSettings() } }
                    }
                    if model.isSavingPreferences { ProgressView("Saving…") }
                } header: {
                    Text("Alert preferences")
                } footer: {
                    Text("Preferences apply to all your connected phones. Lifecycle alerts include trials, renewal status changes, and billing issues. The activity feed keeps all received events.")
                }
                .disabled(model.isSavingPreferences || model.isSigningOut)
                if let error = model.settingsError {
                    Section {
                        ErrorMessage(message: error)
                        Button("Retry settings") { Task { await model.loadSettings() } }
                    }
                }
                Section("Account") {
                    LabeledContent("Email", value: model.user?.email ?? "")
                    LabeledContent("Server", value: model.serverSettings.url)
                        .font(.subheadline)
                    Text("To change servers, sign out first. Your saved session stays bound to this server.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button(role: .destructive) { confirmingLogout = true } label: {
                        HStack {
                            Text("Sign out")
                            Spacer()
                            if model.isSigningOut { ProgressView() }
                        }
                    }
                    .disabled(model.isSigningOut || model.isRegisteringDevice)
                }
                Section {
                    Text("Core beta · iOS 17+\nSetup is browser-based. Sign in with Apple and quiet hours are not part of this build.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .refreshable { await model.loadSettings() }
            .confirmationDialog("Sign out and disconnect this phone?", isPresented: $confirmingLogout, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { Task { await model.logout() } }
            } message: {
                Text("This phone will be removed from push delivery and this session will be revoked. Your account and apps are kept.")
            }
        }
    }

    private func preference(_ keyPath: WritableKeyPath<AlertPreferences, Bool>) -> Binding<Bool> {
        Binding(get: { model.preferences?[keyPath: keyPath] ?? false },
                set: { value in Task { await model.setPreference(keyPath, value: value) } })
    }
}

private struct ErrorMessage: View {
    let message: String
    var body: some View {
        Label(message, systemImage: "exclamationmark.circle")
            .font(.subheadline)
            .foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel("Error: \(message)")
    }
}
