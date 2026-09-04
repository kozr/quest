import XCTest
@testable import IAPNotifications

final class ClientTests: XCTestCase {
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
