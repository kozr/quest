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
                .tint(Color(.systemBlue))
                .task {
                    pushDelegate.model = model
                    await model.bootstrap()
                    await model.refreshDeletionStatus()
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
                ProgressView("Opening Questline…")
            } else if model.user == nil {
                AuthenticationView()
            } else {
                TabView(selection: $model.selectedTab) {
                    ActivityView()
                        .tabItem { Label("Activity", systemImage: "list.bullet") }
                        .tag("activity")
                    AppsView()
                        .tabItem { Label("Apps", systemImage: "square.grid.2x2") }
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
    @Environment(\.colorScheme) private var colorScheme
    @State private var appleAttempt: AppleAttempt?

    private struct AppleAttempt {
        let nonce: String
        let state: String
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 32) {
                    Text("Questline")
                        .font(.headline)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 12)
                    VStack(alignment: .leading, spacing: 20) {
                        Image(systemName: "bell.badge")
                            .font(.largeTitle.weight(.medium))
                            .foregroundStyle(.tint)
                            .accessibilityHidden(true)
                        Text("Sales and\nrefund alerts")
                            .font(.largeTitle.bold())
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityAddTraits(.isHeader)
                        Text("Keep up with purchases, renewals, and refunds across your apps.")
                            .font(.title3)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 24)
                    VStack(spacing: 16) {
                        if let notice = model.accountNotice {
                            Label(notice, systemImage: "checkmark.circle")
                                .font(.subheadline)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if let message = model.pairingSignInNotice {
                            Label(message, systemImage: "qrcode.viewfinder")
                                .font(.subheadline)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        appleSignIn
                        if model.isAuthenticating { ProgressView("Finishing Apple sign-in…") }
                        if let error = model.authError { ErrorMessage(message: error) }
                        Button(action: model.enterPreview) {
                            Text("Explore demo")
                                .font(.headline)
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.roundedRectangle(radius: 12))
                        .controlSize(.large)
                        .disabled(model.isAuthenticating || appleAttempt != nil)
                        .accessibilityIdentifier("exploreDemo")
                        Text("Try sample activity and alert preferences.\nNo account needed. Works offline.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 24) { supportLinks }
                        VStack(spacing: 4) { supportLinks }
                    }
                    .font(.footnote)
                    .frame(maxWidth: .infinity)
                }
                .frame(maxWidth: 480, minHeight: max(0, geometry.size.height - 48))
                .padding(24)
                .frame(maxWidth: .infinity)
            }
            .background(Color(.systemGroupedBackground))
        }
    }

    private var supportLinks: some View {
        Group {
            Link("Privacy policy", destination: model.privacyURL).frame(minHeight: 44)
            Link("Help and support", destination: model.supportURL).frame(minHeight: 44)
        }
    }

    private var appleSignIn: some View {
        SignInWithAppleButton(.signIn) { request in
            model.authError = nil
            do {
                let attempt = AppleAttempt(nonce: try AppleSignInNonce.make(), state: UUID().uuidString)
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
                                                         url: model.serverSettings.url,
                                                         allowLocalHTTP: model.serverSettings.allowLocalHTTP) }
            case .failure(let error):
                if (error as? ASAuthorizationError)?.code != .canceled {
                    model.authError = "Apple sign-in failed. Check your Apple Account in iPhone Settings and try again."
                }
            }
        }
        .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
        .frame(height: 54)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .accessibilityIdentifier("signInWithApple")
        .disabled(model.isAuthenticating || appleAttempt != nil)
    }
}

struct DemoNotice: View {
    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 4) {
                Text("Demo mode").font(.subheadline.weight(.semibold))
                Text("Sample data · Not real sales")
                    .font(.caption).foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: "info.circle").foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

private struct ActivityView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if model.isPreviewMode {
                        DemoNotice()
                    } else {
                    Picker("Environment", selection: $model.selectedEnvironment) {
                        ForEach(ActivityEnvironment.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("activityEnvironment")
                    if model.selectedEnvironment != .production {
                        Label(model.selectedEnvironment == .demo
                              ? "Sample events · Not real sales"
                              : "Test purchases · Not real sales",
                              systemImage: "info.circle")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    }
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                .listRowSeparator(.hidden)
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
                        Label("No activity yet", systemImage: "bell")
                    } description: {
                        if model.selectedEnvironment == .production && model.apps.isEmpty {
                            Text("Connect an app from the Apps tab.")
                        } else {
                            Text("New events will appear here when your connected apps receive notifications.")
                        }
                    }
                    .listRowBackground(Color.clear)
                }
                ForEach(eventDays, id: \.self) { day in
                    Section(dayTitle(day)) {
                        ForEach(eventsByDay[day] ?? []) { event in
                            NavigationLink {
                                EventDetailView(event: event)
                            } label: {
                                ActivityRow(event: event, app: model.apps.first { $0.id == event.appId })
                            }
                        }
                    }
                }
                if model.nextCursor != nil {
                    Button {
                        Task { await model.loadActivity(loadMore: true) }
                    } label: {
                        HStack { Text("Load more"); Spacer(); if model.isLoadingActivity { ProgressView() } }
                    }
                    .disabled(model.isLoadingActivity)
                }
            }
            .listStyle(.insetGrouped)
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
    private var eventsByDay: [Date: [ActivityEvent]] {
        Dictionary(grouping: model.events) { event in
            Timestamp.date(event.occurredAt).map { Calendar.current.startOfDay(for: $0) } ?? .distantPast
        }
    }

    private var eventDays: [Date] { eventsByDay.keys.sorted(by: >) }

    private func dayTitle(_ date: Date) -> String {
        if date == .distantPast { return "Other activity" }
        if Calendar.current.isDateInToday(date) { return "Today" }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(date: .abbreviated, time: .omitted)
    }

}

struct AppArtwork: View {
    let url: String?
    let name: String
    @ScaledMetric(relativeTo: .body) private var size = 48

    var body: some View {
        AsyncImage(url: url.flatMap(URL.init(string:))) { image in
            image.resizable().scaledToFill()
        } placeholder: {
            Text(name.split(whereSeparator: \.isWhitespace).prefix(2).compactMap(\.first).map(String.init).joined().uppercased())
                .font(.headline)
                .foregroundStyle(Color.accentColor)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.accentColor.opacity(0.12))
        }
        .frame(width: min(size, 64), height: min(size, 64))
        .clipShape(RoundedRectangle(cornerRadius: 11))
        .accessibilityHidden(true)
    }
}

private struct ActivityRow: View {
    let event: ActivityEvent
    let app: ConnectedApp?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
            : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
        layout {
            AppArtwork(url: app?.iconUrl, name: event.appName)
            VStack(alignment: .leading, spacing: 4) {
                if typeSize.isAccessibilitySize {
                    Text(event.appName).font(.headline)
                    amount
                    details
                    timestamp
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(event.appName).font(.headline)
                        Spacer(minLength: 4)
                        amount
                    }
                    HStack(alignment: .top, spacing: 8) {
                        details
                        Spacer(minLength: 4)
                        timestamp
                    }
                }
            }
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }

    private var amount: some View {
        Group {
            if let amount = event.amountDescription {
                Text(amount).font(.subheadline.weight(.semibold)).monospacedDigit()
            }
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(event.title).font(.subheadline)
            Text(event.detail).font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var timestamp: some View {
        Group {
            if let date = Timestamp.date(event.occurredAt) {
                Text(date, style: .time)
            } else {
                Text(event.occurredAt)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}

private struct EventDetailView: View {
    let event: ActivityEvent

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Label(event.title, systemImage: event.symbol)
                        .font(.headline)
                    if let amount = event.amountDescription {
                        Text(amount).font(.largeTitle.weight(.semibold)).monospacedDigit()
                    }
                    Text(event.detail).foregroundStyle(.secondary)
                }
                .padding(.vertical, 12)
                LabeledContent("App", value: event.appName)
                LabeledContent("Environment", value: event.environment)
            }
            Section("Event details") {
                LabeledContent("Occurred", value: Timestamp.display(event.occurredAt))
                LabeledContent("Received", value: Timestamp.display(event.receivedAt))
                LabeledContent("Apple event", value: event.notificationType)
                if let subtype = event.subtype { LabeledContent("Subtype", value: subtype) }
                if let product = event.productId { LabeledContent("Product", value: product) }
                if let transaction = event.transactionId { LabeledContent("Transaction", value: transaction) }
            }
        }
        .textSelection(.enabled)
        .navigationTitle("Event")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    @State private var confirmingLogout = false
    @State private var showingDeletion = false

    var body: some View {
        NavigationStack {
            Form {
                if model.isPreviewMode {
                    Section {
                        DemoNotice()
                        Button("Exit demo") { Task { await model.logout() } }
                            .accessibilityIdentifier("exitDemo")
                    } footer: {
                        Text("Preferences reset when you exit. No notifications are sent.")
                    }
                    Section("Notification preview") {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Orbit Journal").font(.headline)
                            Text(model.preferences?.hideAmounts == true ? "New purchase" : "New purchase · USD 12.99")
                                .font(.subheadline)
                            Text("Sample notification").font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                        .accessibilityElement(children: .combine)
                    }
                }
                if !model.isPreviewMode { Section("Computer access") {
                    Button(action: model.beginPairing) {
                        Label("Sign in on computer", systemImage: "qrcode.viewfinder")
                    }
                    .disabled(model.isSigningOut)
                    .accessibilityIdentifier("startPairing")
                }
                Section("Notifications") {
                    LabeledContent { Text(model.permissionDescription) } label: { Label("Permission", systemImage: "bell.fill") }
                    if let config = model.config, !config.apnsConfigured {
                        Label("Notifications are temporarily unavailable. Please try again later.", systemImage: "exclamationmark.triangle")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    if model.permissionStatus == .denied {
                        Button("Open notification settings") {
                            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                        }
                    } else {
                        Button {
                            Task { await model.enableNotifications() }
                        } label: {
                            HStack {
                                Text(model.deviceId == nil ? "Enable notifications" : "Reconnect notifications")
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
                            Label("Send test push", systemImage: "paperplane")
                            Spacer()
                            if model.isTestingPush { ProgressView() }
                        }
                    }
                    .disabled(model.deviceId == nil || model.config?.apnsConfigured != true || model.isTestingPush || model.isSigningOut)
                    if let message = model.pushMessage { Text(message).font(.caption).foregroundStyle(.secondary) }
                    if let error = model.pushError { ErrorMessage(message: error) }
                }
                }
                Section {
                    if model.preferences != nil {
                        Toggle("New purchases", isOn: preference(\.sales))
                        Toggle("Subscription renewals", isOn: preference(\.renewals))
                        Toggle("Free trials started", isOn: preference(\.trials))
                        Toggle("Refunds issued", isOn: preference(\.refunds))
                        Toggle("Refunds reversed", isOn: preference(\.refundReversals))
                        Toggle("Auto-renew turned off", isOn: preference(\.autoRenewDisabled))
                        Toggle("Auto-renew turned on", isOn: preference(\.autoRenewEnabled))
                        Toggle("Billing issues", isOn: preference(\.billingIssues))
                        Toggle("Subscriptions expired", isOn: preference(\.expirations))
                        Toggle("Other App Store updates", isOn: preference(\.otherUpdates))
                        Toggle("Sandbox alerts", isOn: preference(\.sandbox))
                        Toggle("Hide amounts in notifications", isOn: preference(\.hideAmounts))
                    } else {
                        Button("Load alert preferences") { Task { await model.loadSettings() } }
                    }
                    if model.isSavingPreferences { ProgressView("Saving…") }
                } header: {
                    Text("Alerts")
                } footer: {
                    Text(model.isPreviewMode ? "Preview changes last until you exit the demo." : "Applies to all your phones.")
                }
                .disabled(model.isSavingPreferences || model.isSigningOut)
                if let error = model.settingsError {
                    Section {
                        ErrorMessage(message: error)
                        Button("Retry settings") { Task { await model.loadSettings() } }
                    }
                }
                if !model.isPreviewMode { Section("Account") {
                    LabeledContent("Email", value: model.user?.email ?? "")
                    Button(role: .destructive) { confirmingLogout = true } label: {
                        HStack {
                            Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                            Spacer()
                            if model.isSigningOut { ProgressView() }
                        }
                    }
                    .disabled(model.isSigningOut || model.isRegisteringDevice)
                    Button("Delete account", role: .destructive) {
                        model.deletionError = nil
                        showingDeletion = true
                    }
                    .disabled(model.isSigningOut || model.isRegisteringDevice)
                    .accessibilityIdentifier("deleteAccount")
                } }
                Section("About Questline") {
                    Link("Privacy policy", destination: model.privacyURL)
                    Link("Help and support", destination: model.supportURL)
                }
            }
            .navigationTitle("Settings")
            .refreshable { await model.loadSettings() }
            .sheet(isPresented: $showingDeletion) { DeleteAccountView().environmentObject(model) }
            .confirmationDialog("Sign out and disconnect this phone?", isPresented: $confirmingLogout, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { Task { await model.logout() } }
            } message: {
                Text("Notifications stop on this phone. Your account and apps stay saved.")
            }
        }
    }

    private func preference(_ keyPath: WritableKeyPath<AlertPreferences, Bool>) -> Binding<Bool> {
        Binding(get: { model.preferences?[keyPath: keyPath] ?? false },
                set: { value in Task { await model.setPreference(keyPath, value: value) } })
    }
}

private struct DeleteAccountView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var attempt: (nonce: String, state: String)?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Permanently delete your Questline account?")
                        .font(.headline)
                    Text("Your connected apps, activity, preferences, device registrations, and queued deliveries will be removed. All your Questline sessions will end. This cannot be undone.")
                    Text("This only deletes data held by Questline. It does not delete your apps from Apple or cancel your customers’ purchases.")
                        .foregroundStyle(.secondary)
                }
                Section("Before you delete") {
                    Text("If Apple sends notifications to a Questline URL, change it back to your own server in App Store Connect first. For RevenueCat, remove its forwarding link to Questline. Deleting this account stops forwarding.")
                    Link("Connection and deletion help", destination: model.supportURL)
                }
                Section {
                    Text("Confirm with the same Apple Account to permanently delete this account. Stored data is normally removed within 24 hours.")
                    SignInWithAppleButton(.continue) { request in
                        model.deletionError = nil
                        do {
                            let nonce = try AppleSignInNonce.make()
                            let state = UUID().uuidString
                            attempt = (nonce, state)
                            request.nonce = AppleSignInNonce.hash(nonce)
                            request.state = state
                        } catch { model.deletionError = error.localizedDescription }
                    } onCompletion: { result in
                        let current = attempt
                        attempt = nil
                        switch result {
                        case .success(let authorization):
                            guard let current,
                                  let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                                  credential.state == current.state,
                                  let tokenData = credential.identityToken,
                                  let token = String(data: tokenData, encoding: .utf8),
                                  let codeData = credential.authorizationCode,
                                  let code = String(data: codeData, encoding: .utf8), !code.isEmpty else {
                                model.deletionError = "Apple confirmation could not be completed. Please try again."
                                return
                            }
                            Task { await model.deleteAccount(idToken: token, rawNonce: current.nonce, authorizationCode: code) }
                        case .failure(let error):
                            if (error as? ASAuthorizationError)?.code != .canceled {
                                model.deletionError = "Apple confirmation failed. Check your Apple Account in iPhone Settings and try again."
                            }
                        }
                    }
                    .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
                    .frame(height: 50)
                    .disabled(model.isDeletingAccount || attempt != nil)
                    .accessibilityIdentifier("confirmAccountDeletionWithApple")
                    if model.isDeletingAccount { ProgressView("Revoking Apple access and requesting deletion…") }
                    if let error = model.deletionError { ErrorMessage(message: error) }
                }
            }
            .navigationTitle("Delete account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }.disabled(model.isDeletingAccount)
            } }
            .interactiveDismissDisabled(model.isDeletingAccount)
        }
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
