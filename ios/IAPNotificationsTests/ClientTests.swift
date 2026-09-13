import XCTest
import UIKit
import UserNotifications
import SwiftUI
import WebKit
@testable import IAPNotifications

final class ClientTests: XCTestCase {
    func testNotificationOnboardingRequestsPermissionAndRegistersExistingGrants() {
        XCTAssertEqual(NotificationSetupAction.next(for: .notDetermined, registrationAllowed: true), .requestPermission)
        for status: UNAuthorizationStatus in [.authorized, .provisional, .ephemeral] {
            XCTAssertEqual(NotificationSetupAction.next(for: status, registrationAllowed: true), .register)
        }
        // iOS cannot show the permission prompt again after denial.
        XCTAssertEqual(NotificationSetupAction.next(for: .denied, registrationAllowed: true), .none)
    }

    func testExistingUnregisteredSessionsAutomaticallyEnableNotificationSetup() throws {
        let json = #"{"serverURL":"https://example.com","token":"test-session","user":{"id":"test-account","email":"test@example.com"}}"#
        let session = try JSONDecoder().decode(SavedSession.self, from: Data(json.utf8))
        XCTAssertNil(session.deviceId)
        XCTAssertTrue(session.automaticNotificationRegistrationAllowed)
        XCTAssertEqual(NotificationSetupAction.next(for: .authorized,
            registrationAllowed: session.automaticNotificationRegistrationAllowed), .register)
    }

    func testBrowserDisconnectStaysPausedAcrossSessionRestoration() throws {
        var session = SavedSession(serverURL: "https://example.com", token: "test-session",
                                   user: Account(id: "test-account", email: "test@example.com"))
        session.notificationsPaused = true
        let restored = try JSONDecoder().decode(SavedSession.self, from: JSONEncoder().encode(session))
        for status: UNAuthorizationStatus in [.notDetermined, .denied, .authorized, .provisional, .ephemeral] {
            XCTAssertEqual(NotificationSetupAction.next(for: status,
                registrationAllowed: restored.automaticNotificationRegistrationAllowed), .none)
        }
        session.notificationsPaused = false
        XCTAssertEqual(NotificationSetupAction.next(for: .authorized,
            registrationAllowed: session.automaticNotificationRegistrationAllowed), .register)
    }

    @MainActor
    func testPublicPreviewUsesOnlyDemoDataAndLocalPreferences() async {
        let model = AppModel(loadStoredState: false)
        model.enterPreview()
        XCTAssertTrue(model.isPreviewMode)
        XCTAssertEqual(model.user?.id, "offline-preview")
        XCTAssertFalse(model.events.isEmpty)
        XCTAssertTrue(model.events.allSatisfy { $0.environment == "Demo" && $0.notificationType == "DEMO" })
        XCTAssertTrue(model.apps.allSatisfy { $0.lastProductionEventAt == nil && $0.lastSandboxEventAt == nil })
        await model.refreshAll()
        await model.setPreference(\.hideAmounts, value: true)
        XCTAssertEqual(model.preferences?.hideAmounts, true)
        XCTAssertNil(model.settingsError)
        XCTAssertNil(model.deviceId)
        model.selectedEnvironment = .production
        await model.loadActivity()
        XCTAssertEqual(model.selectedEnvironment, .demo)
        XCTAssertFalse(model.events.isEmpty)
        await model.logout()
        XCTAssertFalse(model.isPreviewMode)
        XCTAssertNil(model.user)
        XCTAssertTrue(model.events.isEmpty)
    }

    @MainActor
    func testWelcomeDoesNotNeedAServiceConnection() async {
        let model = AppModel(loadStoredState: false)
        await model.bootstrap()
        XCTAssertFalse(model.isBootstrapping)
        XCTAssertNil(model.user)
        XCTAssertNil(model.config)
        XCTAssertNil(model.authError)
        model.enterPreview()
        XCTAssertTrue(model.isPreviewMode)
    }

    @MainActor
    func testDemoIgnoresExternalEntryPointsAndResetsOnExit() async {
        let model = AppModel(loadStoredState: false)
        await model.bootstrap()
        model.enterPreview()
        let initialTimes = model.events.map(\.occurredAt)
        model.beginPairing()
        await model.inspectPairingLink(pairingURL())
        await model.notificationOpened(environment: "Production")
        await model.enableNotifications()
        await model.receivedAPNSToken("sample-apns-token")
        model.registrationFailed(ClientError.message("sample failure"))
        await model.sendTestPush()
        await model.foreground()
        await model.refreshAll()
        XCTAssertFalse(model.isPairingPresented)
        XCTAssertNil(model.pairingError)
        XCTAssertNil(model.pushError)
        XCTAssertNil(model.deviceId)
        XCTAssertEqual(model.selectedEnvironment, .demo)
        XCTAssertEqual(model.events.map(\.occurredAt), initialTimes)
        XCTAssertTrue(model.apps.allSatisfy { $0.iconUrl == nil && $0.webhookUrls.production.isEmpty && $0.webhookUrls.sandbox.isEmpty })
        await model.setPreference(\.hideAmounts, value: true)
        await model.logout()
        XCTAssertNil(model.preferences)
        XCTAssertTrue(model.apps.isEmpty)
        XCTAssertEqual(model.selectedTab, "activity")
        model.enterPreview()
        XCTAssertEqual(model.preferences, PreviewContent.preferences)
        XCTAssertNil(model.authError)
    }

    func testAppleNonceIsSecureLengthUniqueAndSHA256Bound() throws {
        let values = try (0..<100).map { _ in try AppleSignInNonce.make() }
        XCTAssertEqual(Set(values).count, 100)
        for value in values {
            XCTAssertEqual(value.count, 43)
            XCTAssertNotNil(value.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression))
            XCTAssertEqual(AppleSignInNonce.hash(value).count, 64)
        }
        XCTAssertEqual(AppleSignInNonce.hash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    func testServerOriginRejectsCredentialsPathsAndQuery() {
        for address in ["https://user:password@example.com", "https://example.com/api", "https://example.com?token=secret", "https://example.com#fragment", "file:///tmp/server", "example.com"] {
            XCTAssertThrowsError(try ServerAddress.validate(address, allowLocalHTTP: true), address)
        }
    }

    func testHTTPSOriginIsNormalizedWithoutAddingAPath() throws {
        let url = try ServerAddress.validate(" HTTPS://EXAMPLE.COM:4317/ ", allowLocalHTTP: false)
        XCTAssertEqual(url.absoluteString, "https://example.com:4317")
    }

    func testHTTPNeverAllowsPublicOrLookalikeAddresses() {
        for address in ["http://example.com", "http://8.8.8.8", "http://127.0.0.1.evil.test", "http://192.168.1.1.evil.test", "http://172.32.0.1", "http://10.999.1.1"] {
            XCTAssertThrowsError(try ServerAddress.validate(address, allowLocalHTTP: true), address)
        }
    }

    func testLocalHTTPRequiresExplicitDebugConsent() {
        for address in ["http://localhost:4317", "http://127.0.0.1:4317", "http://192.168.1.2:4317", "http://10.0.0.2:4317", "http://172.16.0.1:4317", "http://macbook.local:4317", "http://[::1]:4317"] {
            XCTAssertThrowsError(try ServerAddress.validate(address, allowLocalHTTP: false))
            #if DEBUG
            XCTAssertNoThrow(try ServerAddress.validate(address, allowLocalHTTP: true), address)
            #else
            XCTAssertThrowsError(try ServerAddress.validate(address, allowLocalHTTP: true), address)
            #endif
        }
    }

    func testTimestampAcceptsFractionalAndWholeSeconds() {
        XCTAssertNotNil(Timestamp.date("2026-09-03T12:30:15.123Z"))
        XCTAssertNotNil(Timestamp.date("2026-09-03T12:30:15Z"))
        XCTAssertNil(Timestamp.date("yesterday"))
    }

    func testPushEnvironmentSelectsMatchingFeed() {
        XCTAssertEqual(ActivityEnvironment.fromNotification("Production"), .production)
        XCTAssertEqual(ActivityEnvironment.fromNotification("Sandbox"), .sandbox)
        XCTAssertEqual(ActivityEnvironment.fromNotification("Demo"), .demo)
        XCTAssertNil(ActivityEnvironment.fromNotification(nil))
        XCTAssertNil(ActivityEnvironment.fromNotification("unknown"))
    }

    func testForwardingFieldIsOptional() throws {
        let json = #"{"id":"app1","name":"Test","bundleId":"com.example.test","appleId":"1234","source":"apple","iconUrl":null,"createdAt":"2026-09-03T00:00:00Z","webhookUrls":{"production":"https://example.com/p","sandbox":"https://example.com/s"},"lastProductionEventAt":null,"lastSandboxEventAt":null}"#
        let app = try JSONDecoder().decode(ConnectedApp.self, from: Data(json.utf8))
        XCTAssertNil(app.forwardingUrl)
        XCTAssertNil(app.lastProductionEventAt)
    }

    func testUnknownEventKindRemainsReadable() throws {
        let json = #"{"id":"event1","appId":"app1","appName":"Test","kind":"future_kind","title":"New Apple event","detail":"Kept for inspection","amountMilliunits":4990,"currency":"USD","productId":null,"transactionId":null,"environment":"Production","occurredAt":"2026-09-03T00:00:00Z","receivedAt":"2026-09-03T00:00:00Z","notificationType":"FUTURE_EVENT","subtype":null,"isMonetary":false}"#
        let event = try JSONDecoder().decode(ActivityEvent.self, from: Data(json.utf8))
        XCTAssertEqual(event.symbol, "bell")
        XCTAssertTrue(event.amountDescription?.contains("4.99") == true)
        XCTAssertTrue(event.amountDescription?.contains("USD") == true)
    }

    func testPairingLinkAcceptsOnlyMatchingOrigin() throws {
        let link = try PairingLink.parse(pairingURL(server: "https://EXAMPLE.com:443/"),
                                         signedInServer: URL(string: "https://example.com")!, allowLocalHTTP: false)
        XCTAssertEqual(link.serverOrigin, "https://example.com")
        XCTAssertEqual(link.credentials.id, String(repeating: "a", count: 22))
        XCTAssertEqual(link.credentials.token, String(repeating: "b", count: 43))
        for server in ["https://evil.example.com", "https://example.com.evil.test", "https://example.com:444", "http://example.com"] {
            XCTAssertThrowsError(try PairingLink.parse(pairingURL(server: server),
                                                       signedInServer: URL(string: "https://example.com")!, allowLocalHTTP: true))
        }
    }

    func testPairingLinkRejectsAmbiguousParametersAndRoutes() {
        let valid = pairingURL()
        let invalid = [
            valid + "&v=1", valid + "&unexpected=true", valid + "#fragment",
            valid.replacingOccurrences(of: "v=1", with: "v=2"),
            valid.replacingOccurrences(of: "://pair?", with: "://pair/path?"),
            valid.replacingOccurrences(of: "://pair?", with: "://user@pair?"),
            valid.replacingOccurrences(of: "://pair?", with: "://pair:80?"),
            valid.replacingOccurrences(of: "iapnotifications:", with: "https:"),
            "123456",
        ]
        for value in invalid {
            XCTAssertThrowsError(try PairingLink.parse(value, signedInServer: URL(string: "https://example.com")!, allowLocalHTTP: false))
        }
    }

    func testPairingLinkRejectsMalformedChallengeSecrets() {
        for (id, token) in [("short", String(repeating: "b", count: 43)),
                            (String(repeating: "a", count: 22), "123456"),
                            (String(repeating: "a", count: 21) + "+", String(repeating: "b", count: 43)),
                            (String(repeating: "a", count: 22), String(repeating: "b", count: 42) + "=")] {
            XCTAssertThrowsError(try PairingLink.parse(pairingURL(id: id, token: token),
                                                       signedInServer: URL(string: "https://example.com")!, allowLocalHTTP: false))
        }
        XCTAssertThrowsError(try PairingLink.parse(String(repeating: "a", count: 2_049),
                                                   signedInServer: URL(string: "https://example.com")!, allowLocalHTTP: false))
    }

    func testPairingRejectsServerCredentialsAndPaths() {
        for server in ["https://user:password@example.com", "https://example.com/api", "https://example.com?redirect=evil", "https://example.com#fragment"] {
            XCTAssertThrowsError(try PairingLink.parse(pairingURL(server: server),
                                                       signedInServer: URL(string: "https://example.com")!, allowLocalHTTP: false))
        }
    }

    func testPairingInspectionRequiresFreshMatchingRequest() throws {
        let link = try PairingLink.parse(pairingURL(), signedInServer: URL(string: "https://example.com")!, allowLocalHTTP: false)
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let future = ISO8601DateFormatter().string(from: now.addingTimeInterval(300))
        let review = PairingReview(id: link.credentials.id, code: "012345", expiresAt: future, publicUrl: "https://example.com", browserName: "Safari on macOS")
        XCTAssertNoThrow(try review.validate(for: link, allowLocalHTTP: false, now: now))
        for invalid in [
            PairingReview(id: "wrong", code: "012345", expiresAt: future, publicUrl: "https://example.com", browserName: "Safari"),
            PairingReview(id: link.credentials.id, code: "12a456", expiresAt: future, publicUrl: "https://example.com", browserName: "Safari"),
            PairingReview(id: link.credentials.id, code: "123456", expiresAt: "2020-01-01T00:00:00Z", publicUrl: "https://example.com", browserName: "Safari"),
            PairingReview(id: link.credentials.id, code: "123456", expiresAt: future, publicUrl: "https://evil.example.com", browserName: "Safari"),
            PairingReview(id: link.credentials.id, code: "123456", expiresAt: "invalid", publicUrl: "https://example.com", browserName: "Safari"),
        ] {
            XCTAssertThrowsError(try invalid.validate(for: link, allowLocalHTTP: false, now: now))
        }
    }

    func testPairingBodyContainsOnlyChallengeFields() throws {
        let link = try PairingLink.parse(pairingURL(), signedInServer: URL(string: "https://example.com")!, allowLocalHTTP: false)
        let data = try JSONEncoder().encode(link.credentials)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(Set(object.keys), Set(["id", "token"]))
    }

    private func pairingURL(server: String = "https://example.com", id: String = String(repeating: "a", count: 22), token: String = String(repeating: "b", count: 43)) -> String {
        var parts = URLComponents()
        parts.scheme = "iapnotifications"
        parts.host = "pair"
        parts.queryItems = [URLQueryItem(name: "v", value: "1"), URLQueryItem(name: "server", value: server),
                            URLQueryItem(name: "id", value: id), URLQueryItem(name: "token", value: token)]
        return parts.string!
    }
}

// Compiled with the extension source so artwork handling is exercised without APNs.
final class NotificationArtworkTests: XCTestCase {
    func testOnlyPublicAppleArtworkURLsAreAccepted() {
        XCTAssertNotNil(NotificationService.iconURL("https://is1-ssl.mzstatic.com/image/icon.png"))
        for value in ["http://is1.mzstatic.com/icon.png", "https://mzstatic.com.evil.test/icon.png",
                      "https://user:pass@is1.mzstatic.com/icon.png", "https://is1.mzstatic.com:443/icon.png",
                      "file:///tmp/icon.png", "https://127.0.0.1/icon.png"] {
            XCTAssertNil(NotificationService.iconURL(value))
        }
        XCTAssertNil(NotificationService.iconURL(nil))
    }

    func testMissingArtworkDeliversOriginalExactlyOnceEvenAfterExpiry() {
        let service = NotificationService()
        let content = UNMutableNotificationContent()
        content.title = "My App"
        content.body = "Refund"
        content.userInfo = ["eventId": "event", "environment": "Sandbox"]
        var count = 0
        service.didReceive(UNNotificationRequest(identifier: "test", content: content, trigger: nil)) { result in
            count += 1
            XCTAssertEqual(result.title, "My App")
            XCTAssertEqual(result.body, "Refund")
            XCTAssertEqual(result.userInfo["eventId"] as? String, "event")
            XCTAssertTrue(result.attachments.isEmpty)
        }
        service.serviceExtensionTimeWillExpire()
        XCTAssertEqual(count, 1)
    }

    func testArtworkProducesAttachmentAndCorruptDataIsRejected() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = directory.appendingPathComponent("source.png")
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 512, height: 512))
        let image = renderer.image { context in
            UIColor.systemBlue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 512, height: 512))
        }
        try XCTUnwrap(image.pngData()).write(to: source)
        let attachment = try NotificationService.makeAttachment(from: source, in: directory)
        XCTAssertEqual(attachment.identifier, "app-icon")
        XCTAssertEqual(attachment.type, "public.png")
        let corrupt = directory.appendingPathComponent("corrupt.png")
        try Data("not an image".utf8).write(to: corrupt)
        XCTAssertThrowsError(try NotificationService.makeAttachment(from: corrupt, in: directory))
    }
}


// No live service, Apple credentials, or saved account is used by these setup checks.
private final class SetupURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    static var holdAppsRead: ((SetupURLProtocol) -> Void)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if request.httpMethod == "GET", request.url?.path == "/api/apps", let hold = Self.holdAppsRead {
            hold(self)
            return
        }
        do {
            let (status, data) = try Self.handler!(request)
            complete(status: status, data: data)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
    func complete(status: Int, data: Data) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}

@MainActor
final class DashboardTests: XCTestCase {
    private let fixture = #"{"id":"setup-app","name":"Orbit Journal","bundleId":"com.example.orbit","appleId":"123456789","source":"apple","iconUrl":null,"createdAt":"2026-09-11T12:00:00Z","webhookUrls":{"production":"https://example.com/webhooks/apple/sample/production","sandbox":"https://example.com/webhooks/apple/sample/sandbox"},"forwardingUrl":"https://example.com/webhooks/apple/sample/forward","forwarding":{"productionUrl":"https://existing.example.com/production","sandboxUrl":null},"lastProductionEventAt":null,"lastSandboxEventAt":null}"#

    private func model() -> AppModel {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SetupURLProtocol.self]
        return AppModel(session: SavedSession(serverURL: "https://example.com", token: String(repeating: "a", count: 43),
                                              user: Account(id: "synthetic-user", email: "test@example.com")),
                        transport: URLSession(configuration: config))
    }

    func testQuickLinksContainOnlyDestinationAndPrivateCookieIsOriginBound() throws {
        let access = try model().dashboardAccess(for: .connection("setup-app"))
        XCTAssertEqual(access.url.absoluteString, "https://example.com/?client=ios#apps?app=setup-app")
        XCTAssertFalse(access.url.absoluteString.contains(access.cookie.value))
        XCTAssertEqual(access.cookie.name, "iap_session")
        XCTAssertEqual(access.cookie.domain, "example.com")
        XCTAssertTrue(access.cookie.isHTTPOnly)
        XCTAssertTrue(access.cookie.isSecure)
        XCTAssertEqual(access.cookie.path, "/")
        XCTAssertLessThan(try XCTUnwrap(access.cookie.expiresDate).timeIntervalSinceNow, 3601)
        let add = try model().dashboardAccess(for: .addApp)
        XCTAssertEqual(add.url.fragment, "apps?add=1")
        XCTAssertEqual(try model().dashboardAccess(for: .apps).url.fragment, "apps")
    }

    func testDashboardNeverNavigatesItsSignedInStoreToOtherOrigins() throws {
        let access = try model().dashboardAccess(for: .apps)
        XCTAssertTrue(access.permits(URL(string: "https://example.com/#settings")!))
        XCTAssertTrue(access.permits(URL(string: "https://example.com:443/api/apps")!))
        for url in ["https://evil.example.com", "https://example.com.evil.test", "https://example.com:444", "http://example.com", "https://user:pass@example.com", "file:///tmp/page", "javascript:alert(1)"] {
            XCTAssertFalse(access.permits(URL(string: url)!), url)
        }
    }

    func testSignedOutAndDemoCannotCreateDashboardSession() {
        let model = AppModel(loadStoredState: false)
        XCTAssertThrowsError(try model.dashboardAccess(for: .addApp))
        model.enterPreview()
        XCTAssertThrowsError(try model.dashboardAccess(for: .apps))
        XCTAssertThrowsError(try model.dashboardAccess(for: .connection("demo-orbit")))
    }

    func testAppIDsAreEncodedAndCannotInjectAnotherDestination() throws {
        let access = try model().dashboardAccess(for: .connection("one&add=1#two"))
        let fragment = try XCTUnwrap(URLComponents(url: access.url, resolvingAgainstBaseURL: false)?.percentEncodedFragment)
        XCTAssertEqual(fragment, "apps?app=one%26add%3D1%23two")
        XCTAssertThrowsError(try DashboardAccess(origin: URL(string: "https://example.com")!, token: "bad; injected=value", destination: .apps))
    }

    func testDashboardCookieIsHttpOnlyAndStoreIsEphemeral() async throws {
        let access = try model().dashboardAccess(for: .apps)
        let store = WKWebsiteDataStore.nonPersistent()
        XCTAssertFalse(store.isPersistent)
        await store.httpCookieStore.setCookie(access.cookie)
        let cookies = await store.httpCookieStore.allCookies()
        let cookie = try XCTUnwrap(cookies.first { $0.name == "iap_session" })
        XCTAssertTrue(cookie.isHTTPOnly)
        XCTAssertTrue(cookie.isSecure)
        XCTAssertEqual(cookie.domain, "example.com")
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        let remaining = await store.httpCookieStore.allCookies()
        XCTAssertTrue(remaining.isEmpty)
    }

    func testQuickLinkScreensRenderOnIPhone() async throws {
        let fixture = fixture
        SetupURLProtocol.handler = { _ in (200, Data("{\"apps\":[\(fixture)]}".utf8)) }
        let model = model()
        await model.loadApps()
        try await capture(AddAppSetupSheet(scanComputer: {}).environmentObject(model), name: "setup-choice")
        try await capture(AddAppSetupSheet(scanComputer: {}).environmentObject(model)
            .environment(\.colorScheme, .dark).environment(\.dynamicTypeSize, .accessibility3), name: "setup-choice-accessibility-dark")
        try await capture(NavigationStack { BrowserAppSetupView(scanComputer: {}) }.environmentObject(model), name: "browser-setup")
        try await capture(AppsView().environmentObject(model), name: "quick-links-apps")
        try await capture(NavigationStack { AppDetailView(appID: "setup-app") }.environmentObject(model), name: "quick-links-connection")
        try await capture(NavigationStack { AppDetailView(appID: "setup-app") }.environmentObject(model)
            .environment(\.colorScheme, .dark).environment(\.dynamicTypeSize, .accessibility3), name: "quick-links-accessibility-dark")
        let empty = self.model()
        try await capture(AppsView().environmentObject(empty), name: "quick-links-empty")
    }

    private func capture<V: View>(_ view: V, name: String, scrollToBottom: Bool = false) async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: view)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(600))
        host.view.layoutIfNeeded()
        if scrollToBottom {
            func scrollView(in view: UIView) -> UIScrollView? {
                if let scroll = view as? UIScrollView { return scroll }
                return view.subviews.compactMap { scrollView(in: $0) }.first
            }
            let scroll = try XCTUnwrap(scrollView(in: host.view))
            scroll.setContentOffset(CGPoint(x: 0, y: max(0, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)), animated: false)
            try await Task.sleep(for: .milliseconds(300))
        }
        let screenshot = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        // Export these simulator-rendered screens alongside the xcresult for visual inspection.
        let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("native-setup-screens")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try screenshot.pngData()!.write(to: directory.appendingPathComponent(name + ".png"))
    }
}
