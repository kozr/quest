import SwiftUI
import WebKit

struct AppsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var dashboard: DashboardAccess?
    @State private var choosingSetup = false
    @State private var pairAfterDismiss = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: QuestPageLayout.sectionSpacing) {
                    if let error = error ?? model.appsError {
                        VStack(alignment: .leading, spacing: 8) {
                            SetupError(message: error)
                            Button("Retry") { Task { await model.loadApps() } }.frame(minHeight: 44)
                        }
                    }
                    if model.isLoadingApps && model.apps.isEmpty {
                        ProgressView("Loading apps…").frame(maxWidth: .infinity).padding(.vertical, 32)
                    } else if model.apps.isEmpty && model.appsError == nil {
                        ContentUnavailableView {
                            Label("Connect your first app", systemImage: "square.stack")
                        } description: {
                            Text("Connect an app to start receiving sales alerts.")
                        } actions: {
                            if !model.isPreviewMode {
                                Button("Add app") { choosingSetup = true }.buttonStyle(.borderedProminent)
                            }
                        }
                    } else {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(model.isPreviewMode ? "Sample apps" : "Your apps")
                                .font(QuestTypography.sectionTitle).foregroundStyle(QuestStyle.muted)
                                .accessibilityAddTraits(.isHeader)
                            ForEach(model.apps) { app in
                                NavigationLink { AppDetailView(appID: app.id) } label: { appRow(app) }
                                    .buttonStyle(.plain).accessibilityIdentifier("app-" + app.id)
                                Divider().overlay(QuestStyle.muted.opacity(0.15))
                            }
                            if !model.isPreviewMode {
                                Button { open(.apps) } label: {
                                    HStack(spacing: 14) {
                                        Image(systemName: "safari").font(.title2)
                                        VStack(alignment: .leading, spacing: 5) {
                                            Text("Open dashboard").font(QuestTypography.body)
                                            Text("Manage your apps and connections.")
                                                .font(QuestTypography.metadata).foregroundStyle(QuestStyle.muted)
                                        }
                                        Spacer(minLength: 0)
                                        Image(systemName: "arrow.up.right.square").font(QuestTypography.secondary)
                                    }.frame(minHeight: 44).padding(.vertical, 16)
                                }.foregroundStyle(QuestStyle.muted).accessibilityIdentifier("appsDashboard")
                            }
                        }
                    }
                }.padding(.horizontal, QuestPageLayout.margin).padding(.bottom, 24)
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                QuestMainPageHeader(title: "Apps", systemImage: "square.grid.2x2",
                                    subtitle: model.isPreviewMode ? "Sample apps" : nil) {
                    if !model.isPreviewMode {
                        Button { choosingSetup = true } label: {
                            Label("Add app", systemImage: "plus").labelStyle(.iconOnly)
                                .font(QuestTypography.secondaryAction)
                                .foregroundStyle(QuestStyle.gold)
                                .frame(width: 44, height: 44)
                                .background(QuestStyle.navy.opacity(0.9), in: RoundedRectangle(cornerRadius: 10))
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(QuestStyle.gold.opacity(0.8)))
                        }.accessibilityIdentifier("addApp")
                    }
                }
            }
            .background(QuestStyle.navy.ignoresSafeArea())
            .foregroundStyle(.white).tint(QuestStyle.gold)
            .navigationTitle("Apps")
            .toolbar(.hidden, for: .navigationBar)
            .toolbarBackground(QuestStyle.navy, for: .tabBar)
            .toolbarBackground(.visible, for: .tabBar)
            .preferredColorScheme(.dark)
            .refreshable { await model.loadApps() }
            .sheet(isPresented: $choosingSetup, onDismiss: {
                if pairAfterDismiss {
                    pairAfterDismiss = false
                    model.beginPairing()
                }
                Task { await model.refreshAll() }
            }) {
                AddAppSetupSheet {
                    pairAfterDismiss = true
                    choosingSetup = false
                }
            }
            .sheet(item: $dashboard, onDismiss: { Task { await model.refreshAll() } }) { access in
                DashboardSheet(access: access)
            }
        }
    }

    private func appRow(_ app: ConnectedApp) -> some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 14))
        return layout {
            ActivityInventorySlot {
                AppArtwork(url: app.iconUrl, name: app.name, bundledIconName: app.bundledIconName).accentColor(QuestStyle.gold)
            }
            VStack(alignment: .leading, spacing: 7) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(app.name).font(QuestTypography.cardTitle).fixedSize()
                        connectionStatus(app).fixedSize()
                    }
                    VStack(alignment: .leading, spacing: 7) {
                        Text(app.name).font(QuestTypography.cardTitle)
                        connectionStatus(app)
                    }
                }
                Text(app.bundleId).font(QuestTypography.metadata).foregroundStyle(QuestStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
            Image(systemName: "chevron.right").font(QuestTypography.metadata).foregroundStyle(QuestStyle.muted)
        }
        .padding(.vertical, 16)
        .accessibilityElement(children: .combine)
    }

    private func connectionStatus(_ app: ConnectedApp) -> some View {
        Label(model.isPreviewMode ? "Sample app" : app.lastProductionEventAt == nil ? "Waiting for Apple" : "Connected",
              systemImage: model.isPreviewMode ? "square.grid.2x2" : app.lastProductionEventAt == nil ? "clock" : "checkmark.circle.fill")
            .font(QuestTypography.metadata)
            .foregroundStyle(model.isPreviewMode ? QuestStyle.muted : app.lastProductionEventAt == nil ? QuestStyle.gold : Color(.systemGreen))
    }

    private func open(_ destination: DashboardDestination) {
        do { dashboard = try model.dashboardAccess(for: destination); error = nil }
        catch { self.error = error.localizedDescription }
    }
}

struct AddAppSetupSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var dashboard: DashboardAccess?
    @State private var error: String?
    let scanComputer: () -> Void

    var body: some View {
        if let dashboard {
            DashboardSheet(access: dashboard, close: { dismiss() })
        } else {
            NavigationStack {
                List {
                    Section {
                        NavigationLink {
                            BrowserAppSetupView(scanComputer: scanComputer)
                        } label: {
                            setupOption("On a computer", symbol: "desktopcomputer", recommended: true,
                                        detail: "More room to follow the steps in App Store Connect.")
                        }
                        .accessibilityIdentifier("browserSetup")
                        Button {
                            do { dashboard = try model.dashboardAccess(for: .addApp); error = nil }
                            catch { self.error = error.localizedDescription }
                        } label: {
                            HStack(spacing: 12) {
                                setupOption("On this iPhone", symbol: "iphone", recommended: false,
                                            detail: "Stay signed in. Find your app by name or paste its link.")
                                Image(systemName: "chevron.right")
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                    .accessibilityHidden(true)
                            }
                        }
                        .accessibilityIdentifier("mobileSetup")
                    } header: {
                        Text("Where would you like to connect your app?")
                    }
                    if let error { Section { SetupError(message: error) } }
                }
                .navigationTitle("Add app")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            }
        }
    }

    private func setupOption(_ title: String, symbol: String, recommended: Bool, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: symbol).font(QuestTypography.cardTitle).foregroundStyle(Color(.label))
            if recommended {
                Text("Recommended").font(QuestTypography.secondaryAction).foregroundStyle(Color.accentColor)
            }
            Text(detail).font(QuestTypography.secondary).foregroundStyle(Color(.label))
        }
        .fixedSize(horizontal: false, vertical: true)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct BrowserAppSetupView: View {
    @EnvironmentObject private var model: AppModel
    let scanComputer: () -> Void
    @State private var copied = false

    var body: some View {
        List {
            if let access = try? model.dashboardAccess(for: .addApp) {
                Section {
                    Text("Open this link on your computer. Keep your phone nearby for the next step.")
                    ShareLink(item: access.url) { Label("Share dashboard link", systemImage: "square.and.arrow.up") }
                    Button {
                        UIPasteboard.general.url = access.url
                        copied = true
                    } label: { Label(copied ? "Link copied" : "Copy link", systemImage: "doc.on.doc") }
                    DisclosureGroup("View dashboard address") {
                        Text(access.url.absoluteString)
                            .font(QuestTypography.secondary)
                            .textSelection(.enabled)
                    }
                } header: {
                    Text("1. Open the dashboard")
                }
                Section {
                    Text("Once the dashboard shows a sign-in QR code, scan it here and confirm the matching code.")
                    Button(action: scanComputer) { Label("Scan sign-in QR code", systemImage: "qrcode.viewfinder") }
                        .accessibilityIdentifier("scanSetupQR")
                } header: {
                    Text("2. Sign in with this iPhone")
                } footer: {
                    Text("Already signed in on your computer? Choose Add app there to continue. Your apps will appear here automatically.")
                }
            } else {
                SetupError(message: "Sign in to set up your apps.")
            }
        }
        .navigationTitle("On a computer")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct AppDetailView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.timeZone) private var timeZone
    @EnvironmentObject private var model: AppModel
    let appID: String
    @State private var dashboard: DashboardAccess?
    @State private var error: String?
    @State private var confirmRemoval = false
    @State private var isRemoving = false

    var body: some View {
        Group {
            if let app = model.apps.first(where: { $0.id == appID }) {
                List {
                    Section {
                        AppArtwork(url: app.iconUrl, name: app.name, bundledIconName: app.bundledIconName)
                        LabeledContent("Bundle ID", value: app.bundleId).textSelection(.enabled)
                    }
                    if model.isPreviewMode {
                        Section { DemoNotice() } footer: {
                            Text("This sample app has no connection to Apple. Sign in to add your own apps.")
                        }
                    } else {
                        Section {
                            Button {
                                do { dashboard = try model.dashboardAccess(for: .connection(app.id)); error = nil }
                                catch { self.error = error.localizedDescription }
                            } label: { Label("Manage connection", systemImage: "safari") }
                                .accessibilityIdentifier("manageConnection")
                            if app.source == "revenuecat" {
                                Link(destination: URL(string: "https://app.revenuecat.com/")!) {
                                    Label("Open RevenueCat", systemImage: "arrow.up.right.square")
                                }
                            } else if let url = URL(string: "https://appstoreconnect.apple.com/apps/\(app.appleId)/distribution/info") {
                                Link(destination: url) { Label("Open App Store Connect", systemImage: "arrow.up.right.square") }
                            }
                        } footer: {
                            Text("Manage URLs, forwarding, and connection tests in your dashboard. No sign-in or scanning needed.")
                        }
                        Section("Latest Apple events") {
                            LabeledContent("Production", value: app.lastProductionEventAt.map { Timestamp.display($0, timeZone: timeZone) } ?? "Waiting for Apple")
                            LabeledContent("Sandbox", value: app.lastSandboxEventAt.map { Timestamp.display($0, timeZone: timeZone) } ?? "Waiting for Apple")
                        }
                        Section {
                            Button(role: .destructive) { confirmRemoval = true } label: {
                                HStack {
                                    Label(isRemoving ? "Removing app…" : "Remove app", systemImage: "trash")
                                    if isRemoving { Spacer(); ProgressView() }
                                }
                            }
                            .disabled(isRemoving)
                            .accessibilityIdentifier("removeApp")
                        } footer: {
                            Text("Permanently removes this app’s history and stops its webhook URLs.")
                        }
                        if let error = error ?? model.appsError { Section { SetupError(message: error) } }
                    }
                }
                .confirmationDialog("Remove “\(app.name)”?", isPresented: $confirmRemoval, titleVisibility: .visible) {
                    Button("Remove app", role: .destructive) {
                        isRemoving = true
                        error = nil
                        Task {
                            do {
                                try await model.removeApp(id: appID)
                                dismiss()
                                await model.refreshAll()
                            } catch {
                                self.error = error.localizedDescription
                            }
                            isRemoving = false
                        }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("This permanently deletes this app’s event history and queued notifications, and stops its webhook URLs. This cannot be undone.")
                }
                .navigationTitle(app.name)
                .refreshable { await model.loadApps() }
            } else {
                ContentUnavailableView("App unavailable", systemImage: "square.stack",
                                       description: Text("This app may have been removed. Return to Apps and refresh."))
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .sheet(item: $dashboard, onDismiss: { Task { await model.refreshAll() } }) { access in
            DashboardSheet(access: access)
        }
    }
}

enum DashboardDestination {
    case apps, addApp, connection(String)

    var title: String {
        switch self {
        case .apps: return "Dashboard"
        case .addApp: return "Connect an app"
        case .connection: return "Manage connection"
        }
    }

    var fragment: String {
        var parts = URLComponents()
        switch self {
        case .apps: return "apps"
        case .addApp: parts.queryItems = [URLQueryItem(name: "add", value: "1")]
        case .connection(let id): parts.queryItems = [URLQueryItem(name: "app", value: id)]
        }
        return "apps?" + (parts.percentEncodedQuery ?? "")
    }
}

struct DashboardAccess: Identifiable {
    let id = UUID()
    let origin: URL
    let url: URL
    let cookie: HTTPCookie
    let title: String

    init(origin: URL, token: String, destination: DashboardDestination) throws {
        _ = try ServerAddress.validate(origin.absoluteString, allowLocalHTTP: true)
        guard token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              var parts = URLComponents(url: origin, resolvingAgainstBaseURL: false),
              parts.host != nil, parts.user == nil, parts.password == nil,
              ["https", "http"].contains(parts.scheme), parts.path.isEmpty || parts.path == "/",
              parts.query == nil, parts.fragment == nil else { throw ClientError.invalidResponse }
        self.origin = origin
        self.title = destination.title
        parts.path = "/"
        parts.queryItems = [URLQueryItem(name: "client", value: "ios")]
        parts.percentEncodedFragment = destination.fragment
        guard let url = parts.url else { throw ClientError.invalidResponse }
        self.url = url
        // Use an origin-bound, HttpOnly cookie in this sheet's memory-only WebKit store.
        // The native service session never appears in a URL, page script, or Safari cookie jar.
        let secure = origin.scheme == "https" ? "; Secure" : ""
        let header = "iap_session=\(token); Path=/; HttpOnly; SameSite=Strict; Max-Age=3600\(secure)"
        guard let cookie = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: origin).first,
              cookie.isHTTPOnly, cookie.domain == origin.host else { throw ClientError.invalidResponse }
        self.cookie = cookie
    }

    func permits(_ url: URL) -> Bool {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.user == nil, parts.password == nil else { return false }
        return PairingLink.canonicalOrigin(url) == PairingLink.canonicalOrigin(origin)
    }
}

struct DashboardSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let access: DashboardAccess
    var close: (() -> Void)? = nil
    @State private var loading = true
    @State private var error: String?
    @State private var reload = 0

    var body: some View {
        NavigationStack {
            ZStack {
                DashboardWebView(access: access, reload: reload, loading: $loading, error: $error,
                                 authenticationRequired: { closeSheet() })
                    .opacity(error == nil ? 1 : 0)
                if let error {
                    ContentUnavailableView {
                        Label("Couldn’t open dashboard", systemImage: "wifi.exclamationmark")
                    } description: { Text(error) } actions: {
                        Button("Try again") { self.error = nil; loading = true; reload += 1 }
                    }
                } else if loading { ProgressView("Opening dashboard…") }
            }
            .navigationTitle(access.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { closeSheet() } }
                ToolbarItem(placement: .primaryAction) {
                    Button { error = nil; loading = true; reload += 1 } label: { Label("Reload", systemImage: "arrow.clockwise") }
                        .disabled(loading)
                }
            }
            .onChange(of: model.user?.id) { _, _ in closeSheet() }
        }
    }
    private func closeSheet() {
        if let close { close() } else { dismiss() }
    }
}


struct DashboardWebView: UIViewRepresentable {
    @AppStorage(DisplayTimeZone.storageKey) private var displayTimeZone: DisplayTimeZone = .local
    let access: DashboardAccess
    let reload: Int
    @Binding var loading: Bool
    @Binding var error: String?
    let authenticationRequired: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(context.coordinator, name: "questline")
        // Each sheet has a fresh store; start with the iPhone's display preference.
        let timeZoneScript = "if (localStorage.getItem('questline.displayTimeZone') === null) { localStorage.setItem('questline.displayTimeZone', '\(displayTimeZone.rawValue)'); }"
        config.userContentController.addUserScript(WKUserScript(source: timeZoneScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        context.coordinator.reload = reload
        config.websiteDataStore.httpCookieStore.setCookie(access.cookie) { [weak view] in
            view?.load(URLRequest(url: access.url))
        }
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.reload != reload {
            context.coordinator.reload = reload
            view.load(URLRequest(url: access.url))
        }
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.stopLoading()
        view.configuration.userContentController.removeScriptMessageHandler(forName: "questline")
        view.navigationDelegate = nil
        view.uiDelegate = nil
        view.configuration.websiteDataStore.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {}
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var parent: DashboardWebView
        var reload = 0
        init(_ parent: DashboardWebView) { self.parent = parent }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            if parent.access.permits(url) { decisionHandler(.allow); return }
            // External provider/help pages use Safari, which never receives this sheet's cookies.
            if navigationAction.navigationType == .linkActivated, ["https", "mailto"].contains(url.scheme ?? "") {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { parent.loading = false }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            parent.loading = false
            parent.error = "The dashboard closed unexpectedly. Tap Try again to reopen it."
        }
        private func failed(_ error: Error) {
            guard (error as NSError).code != NSURLErrorCancelled else { return }
            parent.loading = false
            parent.error = "Check your connection and try again."
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame,
                  let url = message.frameInfo.request.url, parent.access.permits(url) else { return }
            if message.body as? String == "authenticationRequired" { parent.authenticationRequired() }
            if let body = message.body as? [String: String], body["type"] == "displayTimeZone",
               let value = body["value"], let mode = DisplayTimeZone(rawValue: value) {
                parent.displayTimeZone = mode
            }
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            guard let url = navigationAction.request.url else { return nil }
            if parent.access.permits(url) { webView.load(URLRequest(url: url)) }
            else if ["https", "mailto"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
            return nil
        }

        // WKWebView otherwise silently declines the dashboard's destructive-action confirmations.
        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            guard let url = frame.request.url, parent.access.permits(url),
                  var presenter = webView.window?.rootViewController else { completionHandler(false); return }
            while let presented = presenter.presentedViewController { presenter = presented }
            let alert = UIAlertController(title: "Questline", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "Continue", style: .default) { _ in completionHandler(true) })
            presenter.present(alert, animated: true)
        }
    }
}

struct SetupError: View {
    let message: String
    var body: some View {
        Label(message, systemImage: "exclamationmark.circle")
            .foregroundStyle(Color(.systemRed))
            .fixedSize(horizontal: false, vertical: true)
    }
}
