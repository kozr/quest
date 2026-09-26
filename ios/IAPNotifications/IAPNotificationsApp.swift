import SwiftUI
import UIKit
import UserNotifications
import AuthenticationServices
import StoreKit

@main
struct IAPNotificationsApp: App {
    @UIApplicationDelegateAdaptor(PushDelegate.self) private var pushDelegate
    @StateObject private var model: AppModel = {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--marketing-paywall-preview") {
            return AppModel(loadStoredState: false)
        }
        if ProcessInfo.processInfo.arguments.contains("--quest-market-preview") {
            return AppModel(loadStoredState: false)
        }
        if ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("--onboarding-preview=") }) {
            return AppModel(loadStoredState: false)
        }
        #endif
        return AppModel()
    }()
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var marketing = MarketingStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .environmentObject(marketing)
                .tint(Color(.systemBlue))
                .task(id: "\(model.user?.id ?? "")|\(model.isPreviewMode)|\(model.serverSettings.url)") {
                    marketing.configure(client: model.marketingClient, userID: model.user?.id, preview: model.isPreviewMode)
                    await marketing.load()
                }
                .task {
                    pushDelegate.model = model
                    #if DEBUG
                    if ProcessInfo.processInfo.arguments.contains("--marketing-paywall-preview") {
                        model.enterPreview()
                        model.selectedTab = "marketing-preview"
                        return
                    }
                    if let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--onboarding-preview=") }),
                       let stage = OnboardingStage(rawValue: String(argument.dropFirst("--onboarding-preview=".count))) {
                        await model.enterOnboardingPreview(stage: stage)
                        return
                    }
                    if ProcessInfo.processInfo.arguments.contains("--quest-journal-preview"), model.user == nil {
                        model.enterPreview()
                        model.selectedTab = "leads"
                        return
                    }
                    if ProcessInfo.processInfo.arguments.contains("--quest-market-preview"), model.user == nil {
                        model.enterPreview()
                        model.selectedTab = "market"
                        return
                    }
                    #endif
                    await model.bootstrap()
                    await model.refreshDeletionStatus()
                    await pushDelegate.openPendingNotificationIfNeeded()
                }
                .onChange(of: model.user?.id) { _, userID in
                    if userID != nil { Task { await pushDelegate.openPendingNotificationIfNeeded() } }
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { Task { await model.foreground(); await marketing.load() } }
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
    private var pendingLeadAppId: String?
    private var hasPendingNotification = false

    func openPendingNotificationIfNeeded() async {
        guard hasPendingNotification, model?.user != nil else { return }
        hasPendingNotification = false
        let environment = pendingEnvironment
        let leadAppId = pendingLeadAppId
        pendingEnvironment = nil
        pendingLeadAppId = nil
        await model?.notificationOpened(environment: environment, leadAppId: leadAppId)
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
        let leadAppId = response.notification.request.content.userInfo["kind"] as? String == "lead"
            ? response.notification.request.content.userInfo["appId"] as? String : nil
        completionHandler()
        Task { @MainActor [weak self] in
            guard let self else { return }
            pendingEnvironment = environment
            pendingLeadAppId = leadAppId
            hasPendingNotification = true
            await openPendingNotificationIfNeeded()
        }
    }
}

struct RootView: View {
    @AppStorage(DisplayTimeZone.storageKey) private var displayTimeZone: DisplayTimeZone = .local
    var questReveal: QuestReveal? = nil
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var billing: MarketingStore
    @State private var storeSetupApp: ConnectedApp?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if model.isBootstrapping {
                ProgressView("Opening Questline…")
            } else if model.user == nil {
                AuthenticationView()
            } else if model.isAuthenticating {
                ProgressView("Opening your journal…")
            } else if model.isPreviewMode && model.selectedTab == "marketing-preview" {
                MarketingPaywallView(onClose: { model.selectedTab = "activity" })
            } else if model.shouldShowOnboarding {
                QuestOnboardingView()
            } else {
                TabView(selection: $model.selectedTab) {
                    NavigationStack {
                        QuestView(reveal: questReveal)
                            .navigationTitle("Activity")
                            .toolbar(.hidden, for: .navigationBar)
                            .navigationDestination(isPresented: $model.isActivityPresented) {
                                ActivityHubView()
                            }
                    }
                        .tabItem { Label("Activity", systemImage: "list.bullet") }
                        .tag("activity")
                    MarketingAccessView { LeadsView() }
                        .tabItem { Label("Leads", systemImage: "pin.fill") }
                        .tag("leads")
                    MarketingAccessView { MarketView() }
                        .tabItem { Label("Market", systemImage: "chart.bar.xaxis") }
                        .tag("market")
                    AppsView()
                        .tabItem { Label("Apps", systemImage: "square.grid.2x2") }
                        .tag("apps")
                    SettingsView()
                        .tabItem { Label("Settings", systemImage: "gearshape") }
                        .tag("settings")
                }
                .tint(QuestStyle.gold)
                .toolbarBackground(QuestStyle.navy, for: .tabBar)
                .toolbarBackground(.visible, for: .tabBar)
                .toolbarColorScheme(.dark, for: .tabBar)
                .safeAreaInset(edge: .top, spacing: 0) {
                    if let app = model.unfinishedStoreSetup {
                        Button { storeSetupApp = app } label: {
                            HStack(spacing: 12) {
                                Image(systemName: model.connectionProgress(for: app).step == .status ? "clock" : "bell.badge")
                                    .foregroundStyle(QuestStyle.gold)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(model.connectionProgress(for: app).step == .status ? "Waiting for your store" : "Finish setting up sales alerts")
                                        .font(.subheadline.weight(.semibold))
                                    Text(app.name).font(.caption).foregroundStyle(.white.opacity(0.75))
                                }
                                Spacer(minLength: 4)
                                Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                            }.foregroundStyle(.white).padding(.horizontal, 18).padding(.vertical, 12)
                                .frame(maxWidth: .infinity, minHeight: 56).background(QuestStyle.navy)
                        }.buttonStyle(.plain).accessibilityIdentifier("storeSetup.reminder")
                            .task(id: "\(app.id)|\(scenePhase == .active)") {
                                guard scenePhase == .active, model.connectionProgress(for: app).step == .status else { return }
                                while !Task.isCancelled {
                                    await model.loadApps()
                                    if model.apps.first(where: { $0.id == app.id })?.hasVerifiedProductionConnection == true { return }
                                    do { try await Task.sleep(for: .seconds(15)) } catch { return }
                                }
                            }
                    }
                }
                .fullScreenCover(item: $storeSetupApp) { app in
                    SalesConnectionPage(appID: app.id, standalone: true).environmentObject(model)
                }
            }
        }
        .environment(\.timeZone, displayTimeZone.timeZone)
        .environment(\.calendar, displayTimeZone.calendar)
    }
}

private struct AuthenticationView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .largeTitle) private var wordmarkSize = 42
    @ScaledMetric(relativeTo: .largeTitle) private var headlineSize = 34
    @State private var appleAttempt: AppleAttempt?

    private struct AppleAttempt {
        let nonce: String
        let state: String
    }

    var body: some View {
        GeometryReader { geometry in
            let fullHeight = geometry.size.height + geometry.safeAreaInsets.top + geometry.safeAreaInsets.bottom
            let heroHeight = typeSize.isAccessibilitySize ? 380 : max(320, min(560, fullHeight * 0.57))
            ScrollView {
                VStack(spacing: 0) {
                    welcomeScene(width: geometry.size.width, height: heroHeight, safeTop: geometry.safeAreaInsets.top)
                    VStack(spacing: 24) {
                        VStack(spacing: 14) {
                            Text("Every sale.\nA little adventure.")
                                .font(.system(size: headlineSize, weight: .semibold, design: .serif))
                                .tracking(-0.6)
                                .accessibilityAddTraits(.isHeader)
                            Text("Purchase, renewal, and refund alerts for your apps, wherever you are.")
                                .font(.body)
                                .foregroundStyle(QuestStyle.muted)
                                .frame(maxWidth: 355)
                        }
                        .fixedSize(horizontal: false, vertical: true)
                        signInActions
                    }
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
                    .frame(maxWidth: 480)
                    Spacer(minLength: 24)
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 24) { supportLinks }
                        VStack(spacing: 4) { supportLinks }
                    }
                    .font(.footnote)
                    .foregroundStyle(QuestStyle.muted)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 12)
                    .frame(maxWidth: .infinity)
                }
                .frame(maxWidth: .infinity, minHeight: geometry.size.height + geometry.safeAreaInsets.top)
            }
            .ignoresSafeArea(edges: .top)
        }
        .background(QuestStyle.navy.ignoresSafeArea())
        .foregroundStyle(.white)
        .tint(QuestStyle.gold)
        .preferredColorScheme(.dark)
    }

    private func welcomeScene(width: CGFloat, height: CGFloat, safeTop: CGFloat) -> some View {
        ZStack(alignment: .top) {
            // Align the bundled landscape's stone platform with the shared chest's feet.
            // Scenery scrolls with the hero, so it never sits behind the sign-in controls.
            let landscapeHeight = width * 1844 / 853
            Image("QuestLandscape")
                .resizable().scaledToFill()
                .frame(width: width, height: landscapeHeight)
                .offset(y: height - 26 - landscapeHeight * 0.64)
                .frame(width: width, height: height, alignment: .top)
                .accessibilityHidden(true)
            LinearGradient(colors: [QuestStyle.navy.opacity(0.35), .clear], startPoint: .top, endPoint: .bottom)
                .frame(height: safeTop + 150)
                .accessibilityHidden(true)
            QuestChest(isOpen: false, reduceMotion: true)
                .frame(width: min(width, 480), height: 240)
                .frame(maxHeight: .infinity, alignment: .bottom)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            LinearGradient(stops: [.init(color: .clear, location: 0),
                                   .init(color: QuestStyle.navy.opacity(0.85), location: 0.7),
                                   .init(color: QuestStyle.navy, location: 1)],
                           startPoint: .top, endPoint: .bottom)
                .frame(height: 80)
                .frame(maxHeight: .infinity, alignment: .bottom)
                .accessibilityHidden(true)
            VStack(spacing: 10) {
                Image(systemName: "diamond.fill")
                    .font(.system(size: 18)).foregroundStyle(QuestStyle.gold)
                    .accessibilityHidden(true)
                Text("Questline")
                    .font(.system(size: min(wordmarkSize, 58), weight: .semibold, design: .serif))
                    .tracking(-0.8)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
            }
            .shadow(color: QuestStyle.navy.opacity(0.6), radius: 10, y: 2)
            .padding(.horizontal, 24)
            .padding(.top, safeTop + 24)
        }
        .frame(width: width, height: height)
        .clipped()
    }

    private var signInActions: some View {
        VStack(spacing: 12) {
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
            VStack(spacing: 0) {
                Button(action: model.enterPreview) {
                    HStack(spacing: 10) {
                        Text("Explore demo")
                        Image(systemName: "arrow.right").accessibilityHidden(true)
                    }
                    .font(.headline)
                    .foregroundStyle(QuestStyle.gold)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(model.isAuthenticating || appleAttempt != nil)
                .accessibilityIdentifier("exploreDemo")
                .accessibilityHint("Explore sample activity offline, without an account.")
                Text("No account needed.")
                    .font(.footnote)
                    .foregroundStyle(QuestStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var supportLinks: some View {
        Group {
            Link("Privacy policy", destination: model.privacyURL).frame(minHeight: 44)
            Link("Help & support", destination: model.supportURL).frame(minHeight: 44)
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
        .signInWithAppleButtonStyle(.white)
        .frame(height: 56)
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

enum EventFilter: String, CaseIterable, Identifiable {
    case all = "All events", sales = "Sales", refunds = "Refunds", updates = "Updates"
    var id: String { rawValue }

    func includes(_ event: ActivityEvent) -> Bool {
        switch self {
        case .all: return true
        case .sales: return ["sale", "renewal"].contains(event.kind)
        case .refunds: return ["refund", "refund_reversed"].contains(event.kind)
        case .updates: return !["sale", "renewal", "refund", "refund_reversed"].contains(event.kind)
        }
    }
}

struct ActivityView: View {
    @Environment(\.timeZone) private var timeZone
    @StateObject private var sales = SalesModel()
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var model: AppModel
    @Binding private var section: ActivitySection
    @State private var filter: EventFilter

    init(section: Binding<ActivitySection> = .constant(.events), filter: EventFilter = .all) {
        _section = section
        _filter = State(initialValue: filter)
    }

    var body: some View {
        Group {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ActivitySceneHeader(title: "Events", badge: model.isPreviewMode ? "Demo" : model.selectedEnvironment.rawValue, topSpacing: 16, showsLandscape: false)
                    ActivitySectionPicker(selection: $section)
                    if !model.isPreviewMode {
                        Picker("Environment", selection: $model.selectedEnvironment) {
                            ForEach(ActivityEnvironment.allCases) { Text($0.rawValue).tag($0) }
                        }.pickerStyle(.segmented).accessibilityIdentifier("activityEnvironment")
                        if model.selectedEnvironment != .production {
                            Label(model.selectedEnvironment == .demo ? "Sample events · Not real sales" : "Test purchases · Not real sales", systemImage: "info.circle")
                                .font(.caption).foregroundStyle(QuestStyle.muted)
                        }
                    }
                    DisplayTimeZoneControl()
                    SalesSummaryView(sales: sales)
                    HStack(spacing: 8) {
                        ScrollView(.horizontal) {
                            HStack(spacing: 8) {
                                ForEach(EventFilter.allCases) { option in
                                    Button { filter = option } label: {
                                        Text(option == .all ? "All" : option.rawValue).font(.subheadline.weight(.semibold))
                                            .padding(.horizontal, 13).frame(minHeight: 44)
                                            .foregroundStyle(filter == option ? QuestStyle.navy : QuestStyle.muted)
                                            .background(filter == option ? QuestStyle.gold : QuestStyle.navy, in: Capsule())
                                            .overlay(Capsule().stroke(filter == option ? .clear : QuestStyle.muted.opacity(0.25), lineWidth: 1))
                                    }.buttonStyle(.plain)
                                        .accessibilityAddTraits(filter == option ? .isSelected : [])
                                        .accessibilityIdentifier("eventFilter-\(option.id)")
                                }
                            }
                        }.scrollIndicators(.hidden)
                        Button { Task { await model.loadActivity() } } label: {
                            Image(systemName: "arrow.clockwise").font(.body.weight(.semibold))
                                .frame(width: 44, height: 44)
                        }.accessibilityLabel("Refresh events").disabled(model.isLoadingActivity)
                    }
                    if model.isPreviewMode {
                        Text("Sample data · Not real sales").font(.caption).foregroundStyle(QuestStyle.muted)
                    }
                    if let error = model.activityError {
                        VStack(alignment: .leading, spacing: 8) {
                            Label(error, systemImage: "exclamationmark.triangle")
                            Button("Try again") { Task { await model.loadActivity() } }.frame(minHeight: 44)
                        }.font(.subheadline).padding(16)
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(QuestStyle.gold.opacity(0.5)))
                    }
                    if model.isLoadingActivity && model.events.isEmpty {
                        ProgressView("Loading events…").frame(maxWidth: .infinity).padding(.vertical, 40)
                    } else if filteredEvents.isEmpty && model.activityError == nil {
                        ContentUnavailableView {
                            Label(model.events.isEmpty ? "No events yet" : "No matching events", systemImage: "text.book.closed")
                        } description: {
                            Text(model.events.isEmpty
                                 ? (model.apps.isEmpty ? "Connect an app from the Apps tab to start your journal." : "Updates from your connected apps will appear here.")
                                 : "No \(filter.rawValue.lowercased()) in the loaded activity. Try another filter\(model.nextCursor == nil ? "." : " or load older events.")")
                        }
                    }
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(eventDays, id: \.self) { day in
                            HStack {
                                Text(dayTitle(day)).font(.headline)
                                if day != .distantPast {
                                    Text(Timestamp.zoneLabel(timeZone, at: day)).font(.caption)
                                }
                                Spacer()
                                if day != .distantPast {
                                    Text(day.formatted(Date.FormatStyle(timeZone: timeZone).month(.abbreviated).day()))
                                        .font(.caption).foregroundStyle(QuestStyle.muted)
                                }
                                Rectangle().fill(QuestStyle.muted.opacity(0.25)).frame(height: 1)
                                Image(systemName: "diamond.fill").font(.system(size: 6))
                                    .foregroundStyle(QuestStyle.muted.opacity(0.6)).accessibilityHidden(true)
                            }.foregroundStyle(QuestStyle.muted)
                                .padding(.top, 20).padding(.bottom, 6).accessibilityAddTraits(.isHeader)
                            ForEach(eventsByDay[day] ?? []) { event in
                                NavigationLink {
                                    EventDetailView(event: event)
                                } label: {
                                    ActivityRow(event: event, app: model.apps.first { $0.id == event.appId })
                                }.buttonStyle(.plain).accessibilityIdentifier("event-\(event.id)")
                                Rectangle().fill(QuestStyle.muted.opacity(0.13)).frame(height: 1)
                            }
                        }
                    }
                    if model.nextCursor != nil {
                        Button {
                            Task { await model.loadActivity(loadMore: true) }
                        } label: {
                            HStack {
                                Text("Load older events")
                                Spacer()
                                if model.isLoadingActivity { ProgressView() } else { Image(systemName: "arrow.down") }
                            }.font(.subheadline.weight(.semibold)).padding(16)
                                .overlay(RoundedRectangle(cornerRadius: 12).stroke(QuestStyle.muted.opacity(0.35)))
                        }.disabled(model.isLoadingActivity)
                        if filter != .all {
                            Text("Filters apply to loaded events. Load more to check older activity.")
                                .font(.caption).foregroundStyle(QuestStyle.muted)
                        }
                    }
                }.padding(.horizontal, 24).padding(.bottom, 24)
            }
            .background { ActivityPageBackground() }
            .foregroundStyle(.white).tint(QuestStyle.gold)
            .refreshable { await model.loadActivity() }
            .onChange(of: model.selectedEnvironment) { _, _ in Task { await model.loadActivity() } }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.visible, for: .navigationBar)
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbarBackground(QuestStyle.navy, for: .tabBar)
            .toolbarBackground(.visible, for: .tabBar)
            .preferredColorScheme(.dark)
        }
            .task(id: sales.source(model, timeZone: timeZone)) { await sales.load(model, timeZone: timeZone) }
            .onChange(of: model.isLoadingActivity) { wasLoading, loading in
                if wasLoading && !loading { Task { await sales.load(model, timeZone: timeZone) } }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await sales.load(model, timeZone: timeZone) } }
            }
    }

    private var filteredEvents: [ActivityEvent] { model.events.filter(filter.includes) }
    private var eventsByDay: [Date: [ActivityEvent]] {
        Dictionary(grouping: filteredEvents.sorted {
            let left = $0.activityDate ?? .distantPast
            let right = $1.activityDate ?? .distantPast
            return left == right ? $0.id < $1.id : left > right
        }) { event in
            event.activityDate.map { Timestamp.calendar(timeZone: timeZone).startOfDay(for: $0) } ?? .distantPast
        }
    }
    private var eventDays: [Date] { eventsByDay.keys.sorted(by: >) }
    private func dayTitle(_ date: Date) -> String {
        if date == .distantPast { return "Other events" }
        if Timestamp.calendar(timeZone: timeZone).isDateInToday(date) { return "Today" }
        if Timestamp.calendar(timeZone: timeZone).isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, timeZone: timeZone))
    }
}

struct AppArtwork: View {
    let url: String?
    let name: String
    var bundledIconName: String? = nil
    @ScaledMetric(relativeTo: .body) private var size = 48

    var body: some View {
        Group {
            if let bundledIconName {
                Image(bundledIconName).resizable().scaledToFill()
            } else {
                AsyncImage(url: url.flatMap(URL.init(string:))) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Text(name.split(whereSeparator: \.isWhitespace).prefix(2).compactMap(\.first).map(String.init).joined().uppercased())
                        .font(.headline)
                        .foregroundStyle(Color.accentColor)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color.accentColor.opacity(0.12))
                }
            }
        }
        .frame(width: min(size, 64), height: min(size, 64))
        .clipShape(RoundedRectangle(cornerRadius: 11))
        .accessibilityHidden(true)
    }
}

private struct ActivityRow: View {
    @Environment(\.timeZone) private var timeZone
    let event: ActivityEvent
    let app: ConnectedApp?
    @Environment(\.dynamicTypeSize) private var typeSize

    private var eventColor: Color {
        switch event.kind {
        case "refund": return Color(red: 1, green: 0.61, blue: 0.52)
        case "sale", "renewal": return .white
        default: return QuestStyle.muted
        }
    }

    var body: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 14))
        layout {
            ActivityInventorySlot {
                AppArtwork(url: app?.iconUrl, name: event.appName, bundledIconName: app?.bundledIconName).accentColor(QuestStyle.gold)
            }
            VStack(alignment: .leading, spacing: 7) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(event.appName).font(.headline).fixedSize()
                        Spacer(minLength: 4)
                        amount.fixedSize()
                    }
                    VStack(alignment: .leading, spacing: 5) {
                        Text(event.appName).font(.headline)
                        amount
                    }
                }
                Text(event.kind == "renewal" ? "Transaction date · \(Timestamp.display(event.occurredAt, timeZone: timeZone))" : event.title)
                    .font(.subheadline).foregroundStyle(eventColor)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 6) {
                    Image(systemName: event.symbol)
                    if let date = event.activityDate {
                        Text(date, style: .time)
                    } else { Text("Time unavailable") }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.caption2)
                }.font(.caption).foregroundStyle(QuestStyle.muted)
            }
        }
        .foregroundStyle(.white)
        .padding(.vertical, 14)
        .accessibilityElement(children: .combine)
    }

    private var amount: some View {
        Group {
            if let amount = event.amountDescription {
                Text(amount).font(.subheadline.weight(.semibold)).monospacedDigit().foregroundStyle(eventColor)
            }
        }
    }
}

struct EventDetailView: View {
    @Environment(\.timeZone) private var timeZone
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
                LabeledContent("Received", value: Timestamp.displayWithTimeZone(event.receivedAt, timeZone: timeZone))
                LabeledContent(event.appleDateLabel, value: Timestamp.displayWithTimeZone(event.occurredAt, timeZone: timeZone))
                if event.renewalReportedEarly {
                    Text("Apple reported this renewal before its transaction date.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                LabeledContent("Apple event", value: event.notificationType)
                if let subtype = event.subtype { LabeledContent("Subtype", value: subtype) }
                if let product = event.productId { LabeledContent("Product", value: product) }
                if let transaction = event.transactionId { LabeledContent("Transaction", value: transaction) }
            }
        }
        .textSelection(.enabled)
        .navigationTitle("Event")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .scrollContentBackground(.hidden)
        .background(QuestStyle.navy)
        .tint(QuestStyle.gold)
        .toolbarBackground(QuestStyle.navy, for: .navigationBar, .tabBar)
        .toolbarBackground(.visible, for: .navigationBar, .tabBar)
        .preferredColorScheme(.dark)
    }
}

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var billing: MarketingStore
    @Environment(\.openURL) private var openURL
    @State private var confirmingLogout = false
    @State private var showingDeletion = false
    @State private var retryingOnboarding = false
    @State private var onboardingRetryError: String?
    @State private var showingMarketing = false

    var body: some View {
        NavigationStack {
            Form {
                Group {
                if model.isPreviewMode {
                    Section {
                        DemoNotice()
                        Button("Exit demo") { Task { await model.logout() } }
                            .accessibilityIdentifier("exitDemo")
                    } header: {
                        scenicHeader
                    } footer: {
                        Text("Preferences reset when you exit. No notifications are sent.")
                    }
                    Section {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Orbit Journal").font(.headline)
                            Text(model.preferences?.hideAmounts == true ? "New purchase" : "New purchase · USD 12.99")
                                .font(.subheadline)
                            Text("Sample notification").font(.caption).foregroundStyle(QuestStyle.muted)
                        }
                        .padding(.vertical, 4)
                        .accessibilityElement(children: .combine)
                    } header: { QuestSettingsHeading(title: "Notification preview") }
                }
                if !model.isPreviewMode {
                Section {
                    LabeledContent { Text(model.permissionDescription) } label: { Label("Permission", systemImage: "bell.fill") }
                    if let config = model.config, !config.apnsConfigured {
                        Label("Notifications are temporarily unavailable. Please try again later.", systemImage: "exclamationmark.triangle")
                            .font(.subheadline).foregroundStyle(QuestStyle.muted)
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
                    if let message = model.pushMessage { Text(message).font(.caption).foregroundStyle(QuestStyle.muted) }
                    if let error = model.pushError { ErrorMessage(message: error) }
                } header: {
                    VStack(spacing: 24) {
                        scenicHeader
                        QuestSettingsHeading(title: "Notifications")
                    }
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
                    QuestSettingsHeading(title: "Alerts")
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
                if !model.isPreviewMode {
                    Section {
                    Button(action: model.beginPairing) {
                        Label("Sign in on computer", systemImage: "qrcode.viewfinder")
                    }
                    .disabled(model.isSigningOut)
                    .accessibilityIdentifier("startPairing")
                } header: { QuestSettingsHeading(title: "Computer access") }
                }
                if !model.isPreviewMode { Section {
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
                } header: { QuestSettingsHeading(title: "Account") } }
                if model.canRetryOnboarding {
                    Section {
                        Button {
                            retryingOnboarding = true
                            onboardingRetryError = nil
                            Task {
                                do { try await model.retryOnboarding() }
                                catch is CancellationError { }
                                catch { onboardingRetryError = error.localizedDescription }
                                retryingOnboarding = false
                            }
                        } label: {
                            HStack {
                                Label("Retry onboarding", systemImage: "arrow.counterclockwise")
                                Spacer()
                                if retryingOnboarding { ProgressView() }
                            }
                        }
                        .disabled(retryingOnboarding || model.isSigningOut || model.isRegisteringDevice)
                        .accessibilityIdentifier("retryOnboarding")
                        if let error = onboardingRetryError { ErrorMessage(message: error) }
                    } header: { QuestSettingsHeading(title: "TestFlight") }
                    footer: { Text("Replay setup with your current account.") }
                }
                Section {
                    Button { showingMarketing = true } label: {
                        Label(billing.hasActiveSubscription ? "Manage Marketing" : "Explore Marketing", systemImage: "sparkles")
                    }.accessibilityIdentifier("settings.marketing")
                    Text("Sales analytics and sales push notifications are free.").font(.caption)
                } header: { QuestSettingsHeading(title: "Marketing") }
                Section {
                    Link("Privacy policy", destination: model.privacyURL)
                    Link("Help and support", destination: model.supportURL)
                } header: { QuestSettingsHeading(title: "About Questline") }
                }.listRowBackground(Color.white.opacity(0.045))
            }
            .scrollContentBackground(.hidden)
            .contentMargins(.top, 0, for: .scrollContent)
            .background(QuestStyle.navy.ignoresSafeArea())
            .tint(QuestStyle.gold)
            .preferredColorScheme(.dark)
            .navigationTitle("Settings")
            .toolbar(.hidden, for: .navigationBar)
            .toolbarBackground(QuestStyle.navy, for: .tabBar)
            .toolbarBackground(.visible, for: .tabBar)
            .refreshable { await model.loadSettings() }
            .fullScreenCover(isPresented: $showingMarketing) { MarketingPaywallView() }
            .task(id: model.selectedTab) {
                if model.selectedTab == "settings" { await model.checkTestFlightInstallation() }
            }
            .sheet(isPresented: $showingDeletion) { DeleteAccountView().environmentObject(model) }
            .confirmationDialog("Sign out and disconnect this phone?", isPresented: $confirmingLogout, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { Task { await model.logout() } }
            } message: {
                Text("Notifications stop on this phone. Your account and apps stay saved.")
            }
        }
    }

    private var scenicHeader: some View {
        QuestScenicHeader(title: "Settings", systemImage: "gearshape") { EmptyView() }
            .textCase(nil)
            .padding(.horizontal, -12)
    }

    private func preference(_ keyPath: WritableKeyPath<AlertPreferences, Bool>) -> Binding<Bool> {
        Binding(get: { model.preferences?[keyPath: keyPath] ?? false },
                set: { value in Task { await model.setPreference(keyPath, value: value) } })
    }
}

private struct QuestSettingsHeading: View {
    let title: String

    var body: some View {
        HStack(spacing: 10) {
            Rectangle().fill(QuestStyle.muted.opacity(0.25)).frame(height: 1)
            Text(title).font(.subheadline).textCase(nil).foregroundStyle(QuestStyle.muted)
                .fixedSize(horizontal: false, vertical: true).layoutPriority(1)
            Image(systemName: "diamond.fill").font(.system(size: 6)).foregroundStyle(QuestStyle.gold)
                .accessibilityHidden(true)
            Rectangle().fill(QuestStyle.muted.opacity(0.25)).frame(height: 1)
        }.accessibilityAddTraits(.isHeader)
    }
}

private struct DeleteAccountView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var attempt: (nonce: String, state: String)?
    @State private var managingSubscription = false

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
                    Text("Deleting your Questline account does not cancel your Marketing subscription. You can manage or cancel it in the App Store.")
                    Button("Manage Marketing subscription") { managingSubscription = true }
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
            .manageSubscriptionsSheet(isPresented: $managingSubscription)
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
