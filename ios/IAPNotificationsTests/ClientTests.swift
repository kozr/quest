import XCTest
import UIKit
import UserNotifications
import SwiftUI
import SceneKit
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

    func testUTCModePreservesInstantAndChangesCalendarDayAcrossDST() throws {
        let local = TimeZone(identifier: "America/Vancouver")!
        let utc = DisplayTimeZone.utc.timeZone
        for month in ["01", "09"] {
            let raw = "2026-\(month)-14T06:16:38.056Z"
            let instant = try XCTUnwrap(Timestamp.date(raw))
            XCTAssertEqual(Timestamp.calendar(timeZone: utc).component(.day, from: instant), 14)
            XCTAssertEqual(Timestamp.calendar(timeZone: local).component(.day, from: instant), 13)
            XCTAssertEqual(Timestamp.calendar(timeZone: utc).component(.hour, from: instant), 6)
            XCTAssertNotEqual(Timestamp.display(raw, timeZone: local), Timestamp.display(raw, timeZone: utc))
            XCTAssertTrue(Timestamp.displayWithTimeZone(raw, timeZone: utc).hasSuffix(" UTC"))
            XCTAssertEqual(Timestamp.date(raw), instant)
        }
        let now = try XCTUnwrap(Timestamp.date("2026-09-01T06:30:00Z"))
        XCTAssertEqual(SalesPeriod.today.start(now: now, calendar: Timestamp.calendar(timeZone: utc)), Timestamp.date("2026-09-01T00:00:00Z"))
        XCTAssertEqual(SalesPeriod.today.start(now: now, calendar: Timestamp.calendar(timeZone: local)), Timestamp.date("2026-08-31T07:00:00Z"))
        XCTAssertEqual(SalesPeriod.month.start(now: now, calendar: Timestamp.calendar(timeZone: local)), Timestamp.date("2026-08-01T07:00:00Z"))
        XCTAssertEqual(SalesPeriod.month.start(now: now, calendar: Timestamp.calendar(timeZone: utc)), Timestamp.date("2026-09-01T00:00:00Z"))
    }

    private func timestampEvent(occurred: String = "2026-09-14T15:15:08.000Z",
                                received: String = "2026-09-14T07:16:38.056Z",
                                activity: String? = nil) throws -> ActivityEvent {
        var json: [String: Any] = [
            "id": "timestamp-fixture", "appId": "fixture-app", "appName": "Timestamp fixture",
            "kind": "renewal", "title": "Subscription renewed", "detail": "Fixture",
            "environment": "Production", "occurredAt": occurred, "receivedAt": received,
            "notificationType": "DID_RENEW", "isMonetary": true
        ]
        if let activity { json["activityAt"] = activity }
        return try JSONDecoder().decode(ActivityEvent.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testActivityTimestampUsesReceiptForEarlyRenewalAndPreservesAppleDate() throws {
        let event = try timestampEvent(activity: "2026-09-14T07:16:38.056Z")
        XCTAssertEqual(event.activityDate, Timestamp.date(event.receivedAt))
        XCTAssertEqual(event.occurredAt, "2026-09-14T15:15:08.000Z")
        XCTAssertEqual(event.appleDateLabel, "Apple transaction date")
        XCTAssertTrue(event.renewalReportedEarly)
        let restored = try JSONDecoder().decode(ActivityEvent.self, from: JSONEncoder().encode(event))
        XCTAssertEqual(restored.activityAt, event.receivedAt)
    }

    func testActivityTimestampUsesExplicitReceiptEvenForDelayedLiveEvents() throws {
        let event = try timestampEvent(occurred: "2026-09-13T15:15:08.000Z", activity: "2026-09-14T07:16:38.056Z")
        XCTAssertEqual(event.activityDate, Timestamp.date(event.receivedAt))
        XCTAssertFalse(event.renewalReportedEarly)
    }

    func testActivityTimestampKeepsImportedAndLegacyHistoryDates() throws {
        for activity in [nil, "2026-08-14T15:15:08.000Z"] as [String?] {
            let event = try timestampEvent(occurred: "2026-08-14T15:15:08.000Z", activity: activity)
            XCTAssertEqual(event.activityDate, Timestamp.date(event.occurredAt))
            XCTAssertFalse(event.renewalReportedEarly)
        }
    }

    func testActivityTimestampLegacyFallbackGroupsByLocalReceiptDayAcrossDST() throws {
        for month in ["01", "09"] {
            let event = try timestampEvent(occurred: "2026-\(month)-14T15:15:08.000Z",
                                          received: "2026-\(month)-14T06:16:38.056Z")
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: "America/Vancouver")!
            let date = try XCTUnwrap(event.activityDate)
            XCTAssertEqual(calendar.component(.day, from: date), 13)
            XCTAssertEqual(calendar.component(.hour, from: date), month == "01" ? 22 : 23)
            XCTAssertEqual(calendar.component(.day, from: try XCTUnwrap(Timestamp.date(event.occurredAt))), 14)
        }
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
    static var holdEventsRead: ((SetupURLProtocol) -> Void)?
    static var holdAppsRead: ((SetupURLProtocol) -> Void)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if request.url?.path == "/api/events", let hold = Self.holdEventsRead {
            hold(self)
            return
        }
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

    func testQuestReadyRevealAndAccessibilityScreens() async throws {
        let model = AppModel(loadStoredState: false)
        model.enterPreview()
        let reveal = QuestReveal()
        XCTAssertEqual(model.queuedSales.count, 3)
        try await capture(RootView(questReveal: reveal).environmentObject(model), name: "quest-ready", settleMilliseconds: 2_000)
        reveal.begin(model.queuedSales)
        try await capture(RootView(questReveal: reveal).environmentObject(model), name: "quest-reveal",
                          settleMilliseconds: 1_800)
        XCTAssertTrue(reveal.itemsVisible)
        XCTAssertTrue(reveal.saved)
        XCTAssertTrue(model.queuedSales.isEmpty)
        XCTAssertEqual(reveal.sales.count, 3)
        try await capture(RootView(questReveal: reveal).environmentObject(model)
            .environment(\.dynamicTypeSize, .accessibility3),
            name: "quest-accessibility", settleMilliseconds: 1_000, scrollToBottom: true)
        reveal.reset()
        try await capture(RootView(questReveal: reveal).environmentObject(model), name: "quest-caught-up")
        XCTAssertTrue(model.queuedSales.isEmpty)
    }

    func testQuestChestMotionAndInterruption() async throws {
        let model = AppModel(loadStoredState: false)
        model.enterPreview()
        let reveal = QuestReveal()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .first { $0.session.role == .windowApplication })
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: RootView(questReveal: reveal).environmentObject(model))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }

        func findChest(in view: UIView) -> QuestChestSceneView? {
            if let chest = view as? QuestChestSceneView { return chest }
            return view.subviews.compactMap { findChest(in: $0) }.first
        }
        func record(_ name: String) throws {
            let screenshot = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: screenshot)
            attachment.name = name
            attachment.lifetime = .keepAlways
            add(attachment)
            let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("native-setup-screens")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try XCTUnwrap(screenshot.pngData()).write(to: directory.appendingPathComponent(name + ".png"))
        }

        // Opening after the ready animation has stopped must restart rendering.
        try await Task.sleep(for: .seconds(3))
        let chest = try XCTUnwrap(findChest(in: host.view))
        XCTAssertFalse(chest.isPlaying)
        try record("chest-motion-ready")
        reveal.begin(model.queuedSales)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(chest.isPlaying)
        try record("chest-motion-unlock")
        try await Task.sleep(for: .milliseconds(300))
        let effects = try XCTUnwrap(chest.scene?.rootNode.childNode(withName: "Reveal light effects", recursively: true))
        let lightSprites = effects.childNodes(passingTest: { node, _ in node.geometry != nil })
        XCTAssertTrue(lightSprites.contains { $0.opacity > 0 }, "Opening should emit the light burst")
        try record("chest-motion-opening")
        try await Task.sleep(for: .milliseconds(300))
        try record("chest-motion-motes")
        try await Task.sleep(for: .milliseconds(1_500))
        try record("chest-motion-settled")
        XCTAssertTrue(reveal.saved)
        XCTAssertTrue(model.queuedSales.isEmpty)
        XCTAssertFalse(chest.isPlaying)
        XCTAssertTrue(lightSprites.allSatisfy { $0.opacity == 0 && !$0.hasActions })
        let hinge = try XCTUnwrap(chest.scene?.rootNode.childNode(withName: "Lid hinge", recursively: true))
        XCTAssertEqual(hinge.eulerAngles.x, -.pi * 95 / 180, accuracy: 0.001)

        // Interrupt a new opening with Reduce Motion, then return to an already
        // open chest. Neither path may replay particles or leave the lid halfway.
        chest.updateMotion(isOpen: false, reduceMotion: false, hasWaitingSales: true, isActive: true)
        chest.updateMotion(isOpen: true, reduceMotion: false, hasWaitingSales: true, isActive: true)
        try await Task.sleep(for: .milliseconds(250))
        chest.updateMotion(isOpen: true, reduceMotion: true, hasWaitingSales: false, isActive: true)
        XCTAssertFalse(chest.isPlaying)
        XCTAssertEqual(hinge.eulerAngles.x, -.pi * 95 / 180, accuracy: 0.001)
        let motes = try XCTUnwrap(chest.scene?.rootNode.childNode(withName: "Reveal gold motes", recursively: true))
        XCTAssertTrue(motes.childNodes.allSatisfy { $0.opacity == 0 && !$0.hasActions })
        XCTAssertTrue(lightSprites.allSatisfy { $0.opacity == 0 && !$0.hasActions })
        try record("chest-motion-reduced")
        chest.updateMotion(isOpen: true, reduceMotion: false, hasWaitingSales: false, isActive: false)
        chest.updateMotion(isOpen: true, reduceMotion: false, hasWaitingSales: false, isActive: true)
        XCTAssertFalse(chest.isPlaying)

        chest.updateMotion(isOpen: false, reduceMotion: false, hasWaitingSales: true, isActive: true)
        try await Task.sleep(for: .milliseconds(900))
        XCTAssertTrue(chest.isPlaying)
        model.showActivity()
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertFalse(chest.isPlaying)

    }

    func testEventFiltersSeparateSalesRefundsAndLifecycleUpdates() {
        let events = PreviewContent.events()
        XCTAssertEqual(events.filter(EventFilter.all.includes).count, 6)
        XCTAssertEqual(events.filter(EventFilter.sales.includes).count, 3)
        XCTAssertEqual(events.filter(EventFilter.refunds.includes).map(\.kind), ["refund"])
        XCTAssertEqual(Set(events.filter(EventFilter.updates.includes).map(\.kind)), ["trial", "auto_renew_disabled"])
    }

    func testEventsJournalAndDetailScreens() async throws {
        let model = AppModel(loadStoredState: false)
        model.enterPreview()
        model.showActivity()
        let queued = model.queuedSales.map(\.id)
        try await capture(RootView().environmentObject(model), name: "events-journal", settleMilliseconds: 1500)
        try await capture(NavigationStack { ActivityView(filter: .refunds) }.environmentObject(model), name: "events-refunds")
        let refund = try XCTUnwrap(model.events.first { $0.kind == "refund" })
        try await capture(NavigationStack { EventDetailView(event: refund) }.environmentObject(model), name: "events-detail")
        try await capture(RootView().environmentObject(model).environment(\.dynamicTypeSize, .accessibility3),
                          name: "events-large-text", scrollToBottom: true)
        XCTAssertEqual(model.queuedSales.map(\.id), queued, "Browsing events must not consume chest sales")
        XCTAssertEqual(model.events.count, 6)
    }

    func testEarlyRenewalTimestampScreens() async throws {
        let event = ActivityEvent(id: "early-renewal", appId: "timestamp-fixture", appName: "Timestamp fixture",
                                  kind: "renewal", title: "Subscription renewed", detail: "Synthetic timestamp fixture.",
                                  amountMilliunits: 4990, currency: "USD", productId: "monthly", transactionId: "fixture",
                                  environment: "Production", occurredAt: "2026-09-14T15:15:08.000Z",
                                  receivedAt: "2026-09-14T07:16:38.056Z", notificationType: "DID_RENEW",
                                  subtype: nil, isMonetary: true)
        try await capture(NavigationStack { EventDetailView(event: event) }, name: "early-renewal-detail")
        try await capture(NavigationStack { EventDetailView(event: event) }.environment(\.timeZone, DisplayTimeZone.utc.timeZone),
                          name: "early-renewal-utc")
        try await capture(NavigationStack { EventDetailView(event: event) }.environment(\.dynamicTypeSize, .accessibility3),
                          name: "early-renewal-large-text", scrollToBottom: true)
    }

    func testQuestAppsAndSettingsScreens() async throws {
        let waiting = fixture.replacingOccurrences(of: "setup-app", with: "waiting-app")
            .replacingOccurrences(of: "Orbit Journal", with: "Pocket Focus")
            .replacingOccurrences(of: "com.example.orbit", with: "com.example.focus")
        let connected = fixture.replacingOccurrences(of: "\"lastProductionEventAt\":null",
            with: "\"lastProductionEventAt\":\"2026-09-14T12:00:00Z\"")
        let preferences = String(decoding: try JSONEncoder().encode(PreviewContent.preferences), as: UTF8.self)
        SetupURLProtocol.handler = { request in
            switch request.url?.path {
            case "/api/apps": return (200, Data("{\"apps\":[\(connected),\(waiting)]}".utf8))
            case "/api/config": return (200, Data(#"{"serviceName":"Questline","registrationEnabled":true,"demoEnabled":false,"apnsConfigured":true,"publicUrl":"https://example.com"}"#.utf8))
            case "/api/devices": return (200, Data(#"{"devices":[]}"#.utf8))
            case "/api/preferences": return (200, Data("{\"preferences\":\(preferences)}".utf8))
            default: return (404, Data("{}".utf8))
            }
        }
        defer { SetupURLProtocol.handler = nil }
        let account = model()
        await account.loadApps()
        await account.loadSettings()
        XCTAssertEqual(account.apps.count, 2)
        XCTAssertNotNil(account.preferences)
        try await capture(AppsView().environmentObject(account), name: "quest-apps")
        try await capture(AppsView().environmentObject(account).environment(\.dynamicTypeSize, .accessibility3), name: "quest-apps-large-text")
        try await capture(SettingsView().environmentObject(account), name: "quest-settings")
        try await capture(SettingsView().environmentObject(account), name: "quest-settings-account", scrollToBottom: true)
        try await capture(SettingsView().environmentObject(account).environment(\.dynamicTypeSize, .accessibility3), name: "quest-settings-large-text", scrollToBottom: true)
        let demo = AppModel(loadStoredState: false)
        demo.enterPreview()
        demo.selectedTab = "apps"
        try await capture(RootView().environmentObject(demo), name: "marketing-demo-apps")
        demo.selectedTab = "settings"
        try await capture(RootView().environmentObject(demo), name: "quest-settings-demo")
    }

    private func salesFixture() -> SalesResponse {
        let amounts = [25990, 45980, 14990, 74960, 99950, 59970, 114930, 39980, 69960, 154900, 89950, 179880, 124920, 87940]
        let total = amounts.reduce(0, +)
        let days = amounts.enumerated().map { SalesDay(date: String(format: "2026-09-%02d", $0.offset + 1), sales: String($0.element), unknownCount: 0) }
        let usd = SalesCurrency(currency: "USD", purchases: String(total - 459900), renewals: "459900", refunds: "-54900", reversals: "0",
            sales: String(total), afterRefunds: String(total - 54900), unknownCount: 0, days: days,
            apps: [SalesApp(appId: "demo-orbit", appName: "Orbit Journal", sales: String(total - 459900)),
                   SalesApp(appId: "demo-focus", appName: "Pocket Focus", sales: "459900")])
        return SalesResponse(from: "2026-09-01T07:00:00Z", to: "2026-09-15T06:59:59Z", timeZone: "America/Vancouver",
            firstRecordedAt: "2026-09-01T12:00:00Z", coverage: "demo", unassignedCount: 0, currencies: [usd])
    }

    func testSalesGraphBucketsAndExactMoney() throws {
        let response = salesFixture()
        let currency = try XCTUnwrap(response.currencies.first)
        let chart = SalesChartData(response: response, currency: currency)
        XCTAssertFalse(chart.monthly)
        XCTAssertEqual(chart.points.count, 14)
        XCTAssertEqual(chart.points.reduce(Decimal.zero) { $0 + $1.amount }, SalesMoney.value(currency.sales))
        XCTAssertEqual(SalesMoney.value("18014398509481982"), Decimal(string: "18014398509481.982"))
        let year = SalesResponse(from: "2026-01-01T08:00:00Z", to: response.to, timeZone: response.timeZone,
            firstRecordedAt: response.firstRecordedAt, coverage: response.coverage, unassignedCount: 0, currencies: response.currencies)
        let monthly = SalesChartData(response: year, currency: currency)
        XCTAssertTrue(monthly.monthly)
        XCTAssertEqual(monthly.points.count, 9)
        XCTAssertEqual(monthly.points.first?.amount, 0)
        XCTAssertEqual(monthly.points.reduce(Decimal.zero) { $0 + $1.amount }, SalesMoney.value(currency.sales))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Vancouver")!
        let now = try XCTUnwrap(Timestamp.date("2026-11-01T09:30:00Z"))
        XCTAssertEqual(SalesPeriod.today.start(now: now, calendar: calendar), Timestamp.date("2026-11-01T07:00:00Z"))
        XCTAssertEqual(SalesPeriod.month.start(now: now, calendar: calendar), Timestamp.date("2026-11-01T07:00:00Z"))
        XCTAssertNil(SalesPeriod.recorded.start(now: now))
        let midnight = SalesResponse(from: "2026-09-01T07:00:00Z", to: "2026-09-15T07:00:00Z", timeZone: response.timeZone,
            firstRecordedAt: response.firstRecordedAt, coverage: response.coverage, unassignedCount: 0, currencies: response.currencies)
        XCTAssertEqual(SalesChartData(response: midnight, currency: currency).points.count, 14)

    }

    func testSingleDaySalesUseHourlyBucketsAndDSTKeepsBothHours() throws {
        let now = try XCTUnwrap(Timestamp.date("2026-09-14T23:30:00Z"))
        let today = SalesResponse.demo(events: PreviewContent.events(now: now), period: .today, now: now)
        let currency = try XCTUnwrap(today.currencies.first)
        let graph = SalesChartData(response: today, currency: currency)
        XCTAssertTrue(graph.hourly)
        XCTAssertGreaterThan(graph.points.count, 1)
        XCTAssertEqual(graph.points.reduce(Decimal.zero) { $0 + $1.amount }, SalesMoney.value(currency.sales))
        var dstCurrency = currency
        dstCurrency.hours = [SalesDay(date: "2026-11-01T08:00:00Z", sales: "12990", unknownCount: 0),
                             SalesDay(date: "2026-11-01T09:00:00Z", sales: "4990", unknownCount: 0)]
        let response = SalesResponse(from: "2026-11-01T07:00:00Z", to: "2026-11-02T08:00:00Z", timeZone: "America/Los_Angeles",
            firstRecordedAt: nil, coverage: "demo", unassignedCount: 0, currencies: [dstCurrency])
        let dst = SalesChartData(response: response, currency: dstCurrency)
        XCTAssertTrue(dst.hourly)
        XCTAssertEqual(dst.points.count, 25)
        XCTAssertEqual(dst.points.filter { $0.amount > 0 }.count, 2)
        let firstHour = try XCTUnwrap(dst.points.dropFirst().first)
        let secondHour = try XCTUnwrap(dst.points.dropFirst(2).first)
        XCTAssertNotEqual(dst.label(firstHour.date), dst.label(secondHour.date))
        XCTAssertEqual(dst.points.reduce(Decimal.zero) { $0 + $1.amount }, Decimal(string: "17.98"))
    }

    func testSalesRequestFiltersAndUnavailableServerClearsTotals() async throws {
        let account = model()
        account.selectedEnvironment = .sandbox
        SetupURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/sales")
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
            XCTAssertEqual(query.first { $0.name == "environment" }?.value, "Sandbox")
            XCTAssertNotNil(query.first { $0.name == "from" })
            XCTAssertEqual(query.first { $0.name == "timeZone" }?.value, "UTC")
            return (404, Data(#"{"error":"Not found"}"#.utf8))
        }
        defer { SetupURLProtocol.handler = nil }
        let sales = SalesModel(response: salesFixture())
        XCTAssertNotEqual(sales.source(account, timeZone: TimeZone(identifier: "America/Vancouver")!), sales.source(account, timeZone: DisplayTimeZone.utc.timeZone))
        await sales.load(account, timeZone: DisplayTimeZone.utc.timeZone)
        XCTAssertNil(sales.response)
        XCTAssertEqual(sales.error, "Sales totals are not available on this server yet.")
        XCTAssertFalse(sales.isLoading)
    }

    func testSalesTimezoneMatchingResolvesAutomaticLocalZone() {
        let local = SalesModel(response: SalesResponse.demo(events: [], period: .month, timeZone: .autoupdatingCurrent))
        XCTAssertTrue(local.hasResponse(in: .autoupdatingCurrent))
        let utc = SalesModel(response: SalesResponse.demo(events: [], period: .month, timeZone: DisplayTimeZone.utc.timeZone))
        XCTAssertTrue(utc.hasResponse(in: DisplayTimeZone.utc.timeZone))
        XCTAssertFalse(utc.hasResponse(in: TimeZone(identifier: "America/Vancouver")!))
    }

    func testSalesSummaryAndLedgerScreens() async throws {
        let model = AppModel(loadStoredState: false)
        model.enterPreview()
        model.showActivity()
        let response = salesFixture(), sales = SalesModel(response: salesFixture())
        XCTAssertEqual(SalesResponse.demo(events: model.events, period: .recorded).currencies.first?.sales, "19970")
        try await capture(RootView().environmentObject(model), name: "sales-activity", settleMilliseconds: 1500)
        try await capture(NavigationStack { SalesLedgerView(sales: sales) }.environmentObject(model), name: "sales-ledger")
        let now = try XCTUnwrap(Timestamp.date("2026-09-14T23:30:00Z"))
        let today = SalesModel(response: SalesResponse.demo(events: PreviewContent.events(now: now), period: .today, now: now))
        today.period = .today
        try await capture(NavigationStack { SalesLedgerView(sales: today) }.environmentObject(model), name: "sales-ledger-today")

        try await capture(NavigationStack { SalesLedgerView(sales: sales) }.environmentObject(model), name: "sales-ledger-breakdown", scrollToBottom: true)
        try await capture(NavigationStack { SalesLedgerView(sales: sales) }.environmentObject(model).environment(\.dynamicTypeSize, .accessibility3), name: "sales-ledger-large-text")
        let empty = SalesModel(response: SalesResponse(from: response.from, to: response.to, timeZone: response.timeZone,
            firstRecordedAt: nil, coverage: "observed", unassignedCount: 0, currencies: []))
        try await capture(NavigationStack { SalesLedgerView(sales: empty) }.environmentObject(model), name: "sales-ledger-empty")

        let priorZone = UserDefaults.standard.string(forKey: DisplayTimeZone.storageKey)
        defer {
            if let priorZone { UserDefaults.standard.set(priorZone, forKey: DisplayTimeZone.storageKey) }
            else { UserDefaults.standard.removeObject(forKey: DisplayTimeZone.storageKey) }
        }
        UserDefaults.standard.set(DisplayTimeZone.utc.rawValue, forKey: DisplayTimeZone.storageKey)
        try await capture(RootView().environmentObject(model), name: "timezone-events-utc", settleMilliseconds: 1000)
        let utcSales = SalesModel(response: SalesResponse.demo(events: model.events, period: .month, timeZone: DisplayTimeZone.utc.timeZone))
        try await capture(NavigationStack { SalesLedgerView(sales: utcSales) }.environmentObject(model)
            .environment(\.timeZone, DisplayTimeZone.utc.timeZone), name: "timezone-ledger-utc")
        try await capture(RootView().environmentObject(model).environment(\.dynamicTypeSize, .accessibility3),
                          name: "timezone-events-large-text", settleMilliseconds: 1000)
        try await capture(NavigationStack { SalesLedgerView(sales: utcSales) }.environmentObject(model)
            .environment(\.timeZone, DisplayTimeZone.utc.timeZone).environment(\.dynamicTypeSize, .accessibility3), name: "timezone-ledger-large-text")
    }

    private func capture<V: View>(_ view: V, name: String, settleMilliseconds: Int = 600, scrollToBottom: Bool = false) async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .first { $0.session.role == .windowApplication })
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: view)
        window.rootViewController = host
        window.makeKeyAndVisible()
        // Keep the reference viewport stable even when Simulator has an external display scene.
        window.frame = CGRect(x: 0, y: 0, width: 440, height: 956)
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(settleMilliseconds))
        host.view.layoutIfNeeded()
        if scrollToBottom {
            func scrollView(in view: UIView) -> UIScrollView? {
                if let scroll = view as? UIScrollView { return scroll }
                return view.subviews.compactMap { scrollView(in: $0) }.first
            }
            let scroll = try XCTUnwrap(scrollView(in: host.view))
            // Native Forms estimate off-screen row heights. Settle those estimates before the final capture.
            for _ in 0..<4 {
                scroll.setContentOffset(CGPoint(x: 0, y: max(0, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)), animated: false)
                try await Task.sleep(for: .milliseconds(150))
                host.view.layoutIfNeeded()
            }
        }
        let format = UIGraphicsImageRendererFormat()
        format.preferredRange = .standard
        let screenshot = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
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

@MainActor
final class SalesQueueTests: XCTestCase {
    private let account = "queue-account"
    private let server = "https://example.com"
    private var directories: [URL] = []

    override func tearDown() {
        SetupURLProtocol.handler = nil
        SetupURLProtocol.holdEventsRead = nil
        SetupURLProtocol.holdAppsRead = nil
        for directory in directories { try? FileManager.default.removeItem(at: directory) }
        directories = []
        super.tearDown()
    }

    private func store() -> SalesQueueStore {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        directories.append(directory)
        return SalesQueueStore(directory: directory)
    }

    private func event(_ id: String, at seconds: Double, kind: String = "sale", amount: Int64? = 1_990,
                       currency: String? = "USD", environment: String = "Production", occurred: Double? = nil,
                       appID: String = "test-app") -> ActivityEvent {
        let formatter = ISO8601DateFormatter()
        return ActivityEvent(id: id, appId: appID, appName: "Test App", kind: kind, title: kind, detail: "Test sale",
            amountMilliunits: amount, currency: currency, productId: "test-product", transactionId: id,
            environment: environment, occurredAt: formatter.string(from: Date(timeIntervalSince1970: occurred ?? seconds)),
            receivedAt: formatter.string(from: Date(timeIntervalSince1970: seconds)), notificationType: "TEST_FIXTURE",
            subtype: nil, isMonetary: ["sale", "renewal", "refund"].contains(kind))
    }

    private func page(_ events: [ActivityEvent], next: String? = nil) throws -> Data {
        struct Page: Encodable { let events: [ActivityEvent]; let nextCursor: String? }
        return try JSONEncoder().encode(Page(events: events, nextCursor: next))
    }

    private func baseline() throws -> SalesQueue {
        try SalesQueue.begin(with: [event("baseline", at: 100)], now: Date(timeIntervalSince1970: 100))
    }

    private func model(_ store: SalesQueueStore) -> AppModel {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SetupURLProtocol.self]
        return AppModel(session: SavedSession(serverURL: server, token: String(repeating: "a", count: 43),
            user: Account(id: account, email: "queue@example.com")), transport: URLSession(configuration: config), queueStore: store)
    }

    func testEligibilityExcludesRefundsTrialsSandboxAndMissingMoney() throws {
        var queue = try baseline()
        try queue.ingest([
            event("sale", at: 101), event("renewal", at: 102, kind: "renewal"),
            event("refund", at: 103, kind: "refund", amount: -1_990), event("trial", at: 104, kind: "trial", amount: 0),
            event("sandbox", at: 105, environment: "Sandbox"), event("demo", at: 106, environment: "Demo"),
            event("missing", at: 107, amount: nil), event("zero", at: 108, amount: 0),
            event("no-currency", at: 109, currency: "  "), event("import", at: 110, occurred: 50)
        ])
        XCTAssertEqual(queue.pending.map(\.id), ["sale", "renewal"])
    }

    func testAcknowledgedIDsStayConsumedAndBoundaryIDsCanStillArrive() throws {
        var queue = try baseline()
        let first = event("first", at: 101)
        try queue.ingest([first, first])
        queue.acknowledge(ids: [first.id])
        try queue.ingest([first, event("same-time", at: 101), event("later", at: 102)])
        XCTAssertEqual(queue.pending.map(\.id), ["same-time", "later"])
    }

    func testTotalsKeepCurrenciesSeparateWithoutFloatingPointRounding() {
        let totals = TreasureTotal.summarize([event("a", at: 101, amount: 100), event("b", at: 102, amount: 200),
                                             event("c", at: 103, amount: 1_990, currency: "EUR")])
        XCTAssertEqual(totals.map(\.id), ["EUR", "USD"])
        XCTAssertEqual(totals.map(\.amount), [Decimal(1_990), Decimal(300)])
    }

    func testPersistenceAndAccountServerIsolation() throws {
        let store = store()
        var queue = try baseline()
        try queue.ingest([event("sale", at: 101)])
        try store.write(queue, server: server, account: account)
        XCTAssertEqual(try store.read(server: server, account: account)?.pending.map(\.id), ["sale"])
        XCTAssertNil(try store.read(server: server, account: "other"))
        XCTAssertNil(try store.read(server: "https://other.example.com", account: account))
        try store.remove(server: server, account: account)
        try store.remove(server: server, account: account)
        XCTAssertNil(try store.read(server: server, account: account))
    }

    func testRemovingAppPreservesOtherSalesAndCheckpoint() throws {
        var queue = try baseline()
        try queue.ingest([event("removed", at: 101), event("retained", at: 102, appID: "other-app")])
        queue.retainApps(["other-app"])
        XCTAssertEqual(queue.pending.map(\.id), ["retained"])
        XCTAssertEqual(queue.watermark, Date(timeIntervalSince1970: 102))
        XCTAssertEqual(queue.boundaryIDs, ["retained"])
    }

    func testAppRemovalPrunesDiskAndRejectsLateSalesResponse() async throws {
        let store = store()
        var queue = try baseline()
        try queue.ingest([event("removed", at: 101), event("retained", at: 102, appID: "other-app")])
        try store.write(queue, server: server, account: account)
        let model = model(store)
        let waiting = expectation(description: "sales refresh started")
        var held: SetupURLProtocol?
        SetupURLProtocol.holdEventsRead = { request in held = request; waiting.fulfill() }
        let refresh = Task { await model.refreshQueuedSales() }
        await fulfillment(of: [waiting], timeout: 3)
        SetupURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/apps")
            return (200, Data(#"{"apps":[{"id":"other-app","name":"Other App","bundleId":"example.other","appleId":"123","source":"apple","iconUrl":null,"createdAt":"2026-09-15T00:00:00Z","webhookUrls":{"production":"https://example.com/production","sandbox":"https://example.com/sandbox"},"lastProductionEventAt":null,"lastSandboxEventAt":null,"forwardingUrl":null}]}"#.utf8))
        }
        await model.loadApps()
        XCTAssertEqual(model.queuedSales.map(\.id), ["retained"])
        XCTAssertEqual(try store.read(server: server, account: account)?.pending.map(\.id), ["retained"])
        held?.complete(status: 200, data: try page([event("late-removed", at: 103)]))
        await refresh.value
        XCTAssertEqual(model.queuedSales.map(\.id), ["retained"])
        XCTAssertEqual(try store.read(server: server, account: account)?.pending.map(\.id), ["retained"])
        SetupURLProtocol.handler = { _ in (200, Data(#"{"apps":[]}"#.utf8)) }
        await model.loadApps()
        XCTAssertTrue(model.queuedSales.isEmpty)
        XCTAssertTrue(try XCTUnwrap(store.read(server: server, account: account)).pending.isEmpty)
    }

    func testNativeRemovalClearsOnlyRemovedAppSales() async throws {
        let store = store()
        var queue = try baseline()
        try queue.ingest([event("removed", at: 101), event("retained", at: 102, appID: "other-app")])
        try store.write(queue, server: server, account: account)
        let model = model(store)
        SetupURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "DELETE")
            XCTAssertEqual(request.url?.path, "/api/apps/test-app")
            return (200, Data(#"{"ok":true}"#.utf8))
        }
        try await model.removeApp(id: "test-app")
        XCTAssertEqual(model.queuedSales.map(\.id), ["retained"])
        XCTAssertEqual(try store.read(server: server, account: account)?.pending.map(\.id), ["retained"])
    }

    func testFailedNativeRemovalPreservesSales() async throws {
        let store = store()
        var queue = try baseline()
        try queue.ingest([event("pending", at: 101)])
        try store.write(queue, server: server, account: account)
        let model = model(store)
        SetupURLProtocol.handler = { _ in (503, Data(#"{"error":"Unavailable"}"#.utf8)) }
        do { try await model.removeApp(id: "test-app"); XCTFail("Removal must fail") }
        catch {}
        XCTAssertEqual(model.queuedSales.map(\.id), ["pending"])
        XCTAssertEqual(try store.read(server: server, account: account)?.pending.map(\.id), ["pending"])
    }

    func testFailedAppListDoesNotDiscardCachedSales() async throws {
        let store = store()
        var queue = try baseline()
        try queue.ingest([event("retained", at: 101)])
        try store.write(queue, server: server, account: account)
        let model = model(store)
        SetupURLProtocol.handler = { _ in (503, Data(#"{"error":"Unavailable"}"#.utf8)) }
        await model.loadApps()
        XCTAssertNotNil(model.appsError)
        XCTAssertEqual(model.queuedSales.map(\.id), ["retained"])
        XCTAssertEqual(try store.read(server: server, account: account)?.pending.map(\.id), ["retained"])
    }

    func testNewlyConnectedAppIsVerifiedBeforeAdvancingCheckpoint() async throws {
        let store = store()
        try store.write(baseline(), server: server, account: account)
        let model = model(store)
        SetupURLProtocol.handler = { _ in (200, Data(#"{"apps":[]}"#.utf8)) }
        await model.loadApps()
        let sales = try page([event("new-sale", at: 101)])
        SetupURLProtocol.handler = { request in
            if request.url?.path == "/api/events" { return (200, sales) }
            return (503, Data(#"{"error":"Unavailable"}"#.utf8))
        }
        await model.refreshQueuedSales()
        XCTAssertNotNil(model.queuedSalesError)
        XCTAssertEqual(try store.read(server: server, account: account)?.watermark, Date(timeIntervalSince1970: 100))
        SetupURLProtocol.handler = { request in
            if request.url?.path == "/api/events" { return (200, sales) }
            return (200, Data(#"{"apps":[{"id":"test-app","name":"Test App","bundleId":"example.test","appleId":"123","source":"apple","iconUrl":null,"createdAt":"2026-09-15T00:00:00Z","webhookUrls":{"production":"https://example.com/production","sandbox":"https://example.com/sandbox"},"lastProductionEventAt":null,"lastSandboxEventAt":null,"forwardingUrl":null}]}"#.utf8))
        }
        await model.refreshQueuedSales()
        XCTAssertNil(model.queuedSalesError)
        XCTAssertEqual(model.queuedSales.map(\.id), ["new-sale"])
        XCTAssertEqual(try store.read(server: server, account: account)?.pending.map(\.id), ["new-sale"])
    }

    func testRevokedSessionErasesCacheIncludingOrphanedAccounts() async throws {
        let store = store()
        var queue = try baseline()
        try queue.ingest([event("private-sale", at: 101)])
        try store.write(queue, server: server, account: account)
        try store.write(queue, server: "https://old.example.com", account: "old-account")
        let model = model(store)
        SetupURLProtocol.handler = { _ in (401, Data(#"{"error":"Session revoked"}"#.utf8)) }
        await model.refreshQueuedSales()
        XCTAssertNil(model.user)
        XCTAssertTrue(model.queuedSales.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.directory.path))
        XCTAssertNil(try store.read(server: server, account: account))
        XCTAssertNil(try store.read(server: "https://old.example.com", account: "old-account"))
        try store.removeAll()
    }

    func testAcceptedAccountDeletionErasesCache() async throws {
        let store = store()
        var queue = try baseline()
        try queue.ingest([event("private-sale", at: 101)])
        try store.write(queue, server: server, account: account)
        let model = model(store)
        SetupURLProtocol.handler = { request in
            if request.url?.path == "/api/account/delete" {
                return (202, Data(#"{"ok":true,"status":"deleting","receipt":"synthetic-receipt","message":"Accepted"}"#.utf8))
            }
            XCTAssertEqual(request.url?.path, "/api/account/deletion-status")
            return (200, Data(#"{"status":"complete"}"#.utf8))
        }
        await model.deleteAccount(idToken: "synthetic", rawNonce: "synthetic", authorizationCode: "synthetic")
        XCTAssertNil(model.user)
        XCTAssertNil(model.deletionError)
        XCTAssertTrue(model.queuedSales.isEmpty)
        XCTAssertNil(try store.read(server: server, account: account))
    }

    func testFirstSyncBaselinesAllTiedPagesWithoutQueuingHistory() async throws {
        let store = store()
        let first = try page([event("b", at: 100)], next: "b")
        let second = try page([event("a", at: 100), event("old", at: 99)])
        SetupURLProtocol.handler = { request in
            (200, request.url!.query!.contains("before=") ? second : first)
        }
        let model = model(store)
        await model.refreshQueuedSales()
        XCTAssertNil(model.queuedSalesError)
        XCTAssertTrue(model.queuedSales.isEmpty)
        XCTAssertEqual(try store.read(server: server, account: account)?.boundaryIDs, ["a", "b"])
    }

    func testSyncCrossesMoreThanOnePageAndAlwaysRequestsProduction() async throws {
        let store = store()
        try store.write(baseline(), server: server, account: account)
        let newest = (103...202).reversed().map { event("sale-\($0)", at: Double($0)) }
        let first = try page(newest, next: "sale-103")
        let second = try page([event("sale-102", at: 102), event("sale-101", at: 101), event("baseline", at: 100)])
        SetupURLProtocol.handler = { request in
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
            XCTAssertEqual(query.first { $0.name == "environment" }?.value, "Production")
            XCTAssertEqual(query.first { $0.name == "limit" }?.value, "100")
            return (200, query.contains { $0.name == "before" } ? second : first)
        }
        let model = model(store)
        model.selectedEnvironment = .sandbox
        await model.refreshQueuedSales()
        XCTAssertNil(model.queuedSalesError)
        XCTAssertEqual(model.queuedSales.count, 102)
        XCTAssertEqual(Set(model.queuedSales.map(\.id)).count, 102)
        XCTAssertEqual(model.selectedEnvironment, .sandbox)
    }

    func testFailedSecondPageKeepsCheckpointAndRetryRecoversEverySale() async throws {
        let store = store()
        try store.write(baseline(), server: server, account: account)
        let first = try page([event("newer", at: 102)], next: "newer")
        let second = try page([event("older", at: 101), event("baseline", at: 100)])
        SetupURLProtocol.handler = { request in
            request.url!.query!.contains("before=") ? (500, Data("{}".utf8)) : (200, first)
        }
        let model = model(store)
        await model.refreshQueuedSales()
        XCTAssertNotNil(model.queuedSalesError)
        XCTAssertTrue(model.queuedSales.isEmpty)
        XCTAssertEqual(try store.read(server: server, account: account)?.watermark, Date(timeIntervalSince1970: 100))
        SetupURLProtocol.handler = { request in (200, request.url!.query!.contains("before=") ? second : first) }
        await model.refreshQueuedSales()
        XCTAssertNil(model.queuedSalesError)
        XCTAssertEqual(model.queuedSales.map(\.id), ["older", "newer"])
    }

    func testRevealAcknowledgesOnlyCapturedIDsAndSurvivesRestart() async throws {
        let store = store()
        var queue = try baseline()
        try queue.ingest([event("first", at: 101)])
        try store.write(queue, server: server, account: account)
        let model = model(store)
        let captured = Set(model.queuedSales.map(\.id))
        let response = try page([event("new", at: 102), event("first", at: 101), event("baseline", at: 100)])
        SetupURLProtocol.handler = { _ in (200, response) }
        await model.refreshQueuedSales()
        XCTAssertTrue(model.acknowledgeQueuedSales(ids: captured))
        XCTAssertEqual(model.queuedSales.map(\.id), ["new"])
        let restored = self.model(store)
        XCTAssertEqual(restored.queuedSales.map(\.id), ["new"])
        await restored.refreshQueuedSales()
        XCTAssertEqual(restored.queuedSales.map(\.id), ["new"])
    }

    func testAcknowledgementDuringFetchDoesNotResurrectConsumedSales() async throws {
        let store = store()
        var queue = try baseline()
        try queue.ingest([event("first", at: 101)])
        try store.write(queue, server: server, account: account)
        let model = model(store)
        let waiting = expectation(description: "queue request started")
        var held: SetupURLProtocol?
        SetupURLProtocol.holdEventsRead = { request in held = request; waiting.fulfill() }
        let refresh = Task { await model.refreshQueuedSales() }
        await fulfillment(of: [waiting], timeout: 3)
        XCTAssertTrue(model.acknowledgeQueuedSales(ids: ["first"]))
        held?.complete(status: 200, data: try page([event("new", at: 102), event("first", at: 101), event("old", at: 99)]))
        await refresh.value
        XCTAssertEqual(model.queuedSales.map(\.id), ["new"])
    }

    func testFailedAcknowledgementLeavesPendingBatchAvailable() throws {
        let store = store()
        var queue = try baseline()
        try queue.ingest([event("first", at: 101)])
        try store.write(queue, server: server, account: account)
        let model = model(store)
        try FileManager.default.removeItem(at: store.directory)
        try Data().write(to: store.directory) // A file blocks creation of the storage directory.
        XCTAssertFalse(model.acknowledgeQueuedSales(ids: ["first"]))
        XCTAssertEqual(model.queuedSales.map(\.id), ["first"])
        XCTAssertNotNil(model.queuedSalesError)
    }

    func testCorruptStorageIsNotOverwrittenByANewBaseline() async throws {
        let store = store()
        try store.write(baseline(), server: server, account: account)
        let file = store.fileURL(server: server, account: account)
        let corrupt = Data("broken".utf8)
        try corrupt.write(to: file)
        let model = model(store)
        SetupURLProtocol.handler = { _ in XCTFail("Corrupt storage must not be silently reset"); return (200, Data()) }
        await model.refreshQueuedSales()
        XCTAssertNotNil(model.queuedSalesError)
        XCTAssertEqual(try Data(contentsOf: file), corrupt)
    }

    func testLogoutDiscardsInFlightResponseAndClearsVisibleQueue() async throws {
        let store = store()
        var queue = try baseline()
        try queue.ingest([event("private-sale", at: 101)])
        try store.write(queue, server: server, account: account)
        let model = model(store)
        let waiting = expectation(description: "queue request started")
        var held: SetupURLProtocol?
        SetupURLProtocol.holdEventsRead = { request in held = request; waiting.fulfill() }
        SetupURLProtocol.handler = { _ in (200, Data("{\"ok\":true}".utf8)) }
        let refresh = Task { await model.refreshQueuedSales() }
        await fulfillment(of: [waiting], timeout: 3)
        await model.logout()
        held?.complete(status: 200, data: try page([event("late", at: 101)]))
        await refresh.value
        XCTAssertNil(model.user)
        XCTAssertTrue(model.queuedSales.isEmpty)
        XCTAssertNil(model.queuedSalesError)
        XCTAssertFalse(model.isLoadingQueuedSales)
        XCTAssertNil(try store.read(server: server, account: account))
    }

    func testDemoQueueRemainsOfflineAndDoesNotRefillOnRefresh() async {
        let model = AppModel(loadStoredState: false)
        model.enterPreview()
        XCTAssertEqual(model.queuedSales.count, 3)
        XCTAssertTrue(model.queuedSales.allSatisfy { $0.environment == "Demo" })
        XCTAssertTrue(model.acknowledgeQueuedSales(ids: Set(model.queuedSales.map(\.id))))
        await model.refreshAll()
        XCTAssertTrue(model.queuedSales.isEmpty)
        XCTAssertEqual(model.events.count, 6)
        await model.logout()
        XCTAssertTrue(model.queuedSales.isEmpty)
    }
}
