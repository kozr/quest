import XCTest
@testable import IAPNotifications

@MainActor
final class TavernTests: XCTestCase {
    private let settings = #"{"profile":{"id":"public-a","name":"Alice","showRank":false},"rank":{"rank":"platinum","peakMilliunits":"1250000","status":"available","calculatedAt":"2026-09-26T12:00:00.000Z","currency":"USD"},"blocked":[],"isModerator":false}"#
    private let feed = #"{"messages":[{"id":"m1","author":{"id":"public-b","name":"Bob","rank":null},"text":"Hello","createdAt":"2026-09-26T12:00:00.000Z","reply":null,"helpful":0,"celebrate":0,"myReaction":"helpful","isMine":false}],"nextCursor":null,"onlineCount":2,"onlineCountCapped":false}"#
    override func tearDown() { TavernTestProtocol.handler = nil; TavernTestProtocol.hold = nil; super.tearDown() }
    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [TavernTestProtocol.self]
        return APIClient(baseURL: URL(string: "https://example.com")!, token: "test", transport: URLSession(configuration: configuration))
    }
    private func store() -> TavernStore {
        let store = TavernStore(); store.configure(client: client(), accountID: "alice"); return store
    }
    private func response(_ text: String) -> (Int, Data) { (200, Data(text.utf8)) }

    func testMissingFalseAndFailedFeatureConfigurationStayClosed() async throws {
        let base = #"{"serviceName":"Quest","registrationEnabled":false,"demoEnabled":false,"apnsConfigured":true,"publicUrl":"https://example.com"}"#
        XCTAssertNil(try JSONDecoder().decode(ServerConfig.self, from: Data(base.utf8)).tavernEnabled)
        let client = client()
        let model = AppModel(session: SavedSession(serverURL: "https://example.com", token: "test", user: Account(id: "alice", email: "a@example.test")), transport: client.transport!)
        XCTAssertFalse(model.tavernEnabled); XCTAssertNil(model.tavernClient)
        TavernTestProtocol.handler = { _ in (200, Data(base.dropLast().appending(",\"tavernEnabled\":true}").utf8)) }
        await model.refreshTavernFlag(); XCTAssertTrue(model.tavernEnabled)
        TavernTestProtocol.handler = { _ in (200, Data(base.utf8)) }
        await model.refreshTavernFlag(); XCTAssertFalse(model.tavernEnabled); XCTAssertNil(model.tavernClient)
        TavernTestProtocol.handler = { _ in (500, Data(#"{"error":"Offline"}"#.utf8)) }
        await model.refreshTavernFlag(); XCTAssertFalse(model.tavernEnabled)
        let demo = AppModel(loadStoredState: false); demo.enterPreview(); XCTAssertFalse(demo.tavernEnabled)
    }
    func testDisabledStoreMakesNoTavernRequestsAndClearsDraftOnDisable() async {
        TavernTestProtocol.handler = { _ in XCTFail("Disabled Tavern must make no requests"); return (500, Data()) }
        let store = TavernStore(); store.draft = "Private draft"
        await store.loadSettings(); await store.refresh(); await store.send()
        store.configure(client: client(), accountID: "alice"); store.draft = "Private draft"
        store.configure(client: nil, accountID: nil)
        XCTAssertTrue(store.draft.isEmpty); XCTAssertTrue(store.messages.isEmpty); XCTAssertNil(store.settings)
        await store.loadSettings(); await store.refresh(); await store.send()
    }
    func testFailedSendKeepsDraftAndRetriesSameMessageIdentifier() async throws {
        let store = store(); let settings = self.settings, feed = self.feed
        var ids: [String] = []
        TavernTestProtocol.handler = { request in
            if request.httpMethod == "POST" {
                let object = try! JSONSerialization.jsonObject(with: TavernTestProtocol.body(request)) as! [String: Any]
                ids.append(object["id"] as! String)
                return ids.count == 1 ? (500, Data(#"{"error":"Try again"}"#.utf8)) : (201, Data(#"{"ok":true}"#.utf8))
            }
            return (200, Data((request.url!.path.hasSuffix("settings") ? settings : feed).utf8))
        }
        await store.loadSettings(); store.draft = "A small win"
        await store.send(); XCTAssertEqual(store.draft, "A small win"); XCTAssertNotNil(store.error)
        await store.send(); XCTAssertEqual(ids.count, 2); XCTAssertEqual(ids[0], ids[1]); XCTAssertTrue(store.draft.isEmpty)
    }
    func testClearingReactionSendsExplicitNull() async {
        let store = store(); let settings = self.settings, feed = self.feed
        var payload: Data?
        TavernTestProtocol.handler = { request in
            if request.httpMethod == "PUT" { payload = TavernTestProtocol.body(request); return (200, Data(#"{"ok":true}"#.utf8)) }
            return (200, Data((request.url!.path.hasSuffix("settings") ? settings : feed).utf8))
        }
        await store.loadSettings(); await store.refresh()
        await store.react(store.messages[0], kind: "helpful")
        let object = try? JSONSerialization.jsonObject(with: payload ?? Data()) as? [String: Any]
        XCTAssertTrue(object?["kind"] is NSNull)
    }
    func testDisabledServerClearsOpenConversationAndPreventsFurtherRequests() async {
        let store = store(), settings = self.settings, feed = self.feed
        TavernTestProtocol.handler = { request in (200, Data((request.url!.path.hasSuffix("settings") ? settings : feed).utf8)) }
        await store.loadSettings(); await store.refresh(); XCTAssertEqual(store.messages.count, 1)
        store.draft = "Private draft"
        TavernTestProtocol.handler = { _ in (404, Data(#"{"error":"Unavailable","code":"TAVERN_DISABLED"}"#.utf8)) }
        await store.refresh()
        XCTAssertTrue(store.unavailable); XCTAssertTrue(store.messages.isEmpty); XCTAssertTrue(store.draft.isEmpty); XCTAssertNil(store.settings)
        TavernTestProtocol.handler = { _ in XCTFail("Revoked client must stop requests"); return (500, Data()) }
        await store.refresh(); await store.loadSettings()
    }
    func testLateFeedCannotRestoreDataAfterAccountChange() async {
        let store = store(), settings = self.settings, feed = self.feed
        TavernTestProtocol.handler = { _ in (200, Data(settings.utf8)) }
        await store.loadSettings()
        let waiting = expectation(description: "Feed pending")
        var held: TavernTestProtocol?
        TavernTestProtocol.hold = { request in held = request; waiting.fulfill() }
        let task = Task { await store.refresh() }
        await fulfillment(of: [waiting], timeout: 2)
        store.configure(client: nil, accountID: nil)
        held?.finish(200, Data(feed.utf8)); await task.value
        XCTAssertTrue(store.messages.isEmpty); XCTAssertNil(store.settings); XCTAssertFalse(store.isLoading)
    }
}

private final class TavernTestProtocol: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) -> (Int, Data))?
    static var hold: ((TavernTestProtocol) -> Void)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if let hold = Self.hold { hold(self); return }
        let result = Self.handler?(request) ?? (500, Data()); finish(result.0, result.1)
    }
    func finish(_ status: Int, _ data: Data) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
    static func body(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(buffer, count: count) }
        return data
    }
}
