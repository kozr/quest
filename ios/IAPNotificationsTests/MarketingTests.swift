import XCTest
@testable import IAPNotifications

@MainActor
final class MarketingTests: XCTestCase {
    private let accountToken = "928201C4-758C-4914-9124-E8F9A9D68428"
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    override func tearDown() {
        MarketingURLProtocol.handler = nil
        MarketingURLProtocol.hold = nil
        super.tearDown()
    }

    func testOnlyTheFourConfiguredProductsMapToMarketingPlans() {
        XCTAssertEqual(Set(MarketingPlan.all.map(\.productID)), [
            "com.kozr.quest.marketing.one.monthly", "com.kozr.quest.marketing.one.annual",
            "com.kozr.quest.marketing.three.monthly", "com.kozr.quest.marketing.three.annual"
        ])
        XCTAssertEqual(MarketingPlan(productID: "com.kozr.quest.marketing.three.annual")?.coverage.appLimit, 3)
        for unknown in ["com.kozr.quest.marketing.one.weekly", "com.kozr.quest.marketing.one.monthly.fake", "", "monthly"] {
            XCTAssertNil(MarketingPlan(productID: unknown))
        }
    }

    func testAppCoverageRejectsEmptyDuplicateAndExcessSelections() {
        let one = MarketingPlan(coverage: .one, period: .monthly)
        let three = MarketingPlan(coverage: .three, period: .annual)
        XCTAssertTrue(one.accepts(appIDs: ["a"]))
        XCTAssertFalse(one.accepts(appIDs: ["a", "b"]))
        XCTAssertTrue(three.accepts(appIDs: ["a", "b", "c"]))
        for selection in [[], [" "], ["a", "a"], ["a", "b", "c", "d"]] {
            XCTAssertFalse(three.accepts(appIDs: selection))
        }
    }

    func testExpirationIsMillisecondsAndAccessStopsAtExactExpiry() throws {
        let expiry = now.addingTimeInterval(60)
        let subscription = status(expiresAt: expiry.timeIntervalSince1970 * 1_000)
        XCTAssertEqual(subscription.expirationDate, expiry)
        XCTAssertTrue(subscription.isActive(at: now))
        XCTAssertTrue(subscription.grantsAccess(to: "a", at: now))
        XCTAssertFalse(subscription.grantsAccess(to: "uncovered-app", at: now))
        XCTAssertFalse(subscription.isActive(at: expiry))
        XCTAssertFalse(subscription.isActive(at: expiry.addingTimeInterval(1)))
        XCTAssertFalse(subscription.removingAccess().isActive(at: now))
    }

    func testUnrecognizedOrMalformedEntitlementsCannotGrantAccess() throws {
        let malformed = [
            status(productID: "unknown"),
            status(appLimit: 3),
            status(appIDs: ["a", "a"]),
            status(appIDs: ["a", "b"]),
            status(appAccountToken: "not-a-uuid"),
            status(expiresAt: nil),
            status(expiresAt: .infinity)
        ]
        for subscription in malformed { XCTAssertThrowsError(try subscription.validated()) }
        XCTAssertFalse(status(enabled: false).isActive(at: now))
        XCTAssertFalse(status(active: false).isActive(at: now))
        XCTAssertFalse(status(productID: "unknown").isActive(at: now))
        XCTAssertFalse(status(appAccountToken: "not-a-uuid").isActive(at: now))
    }

    func testDisabledServerLoadsWithoutInventedPricesOrPurchaseEligibility() async throws {
        let store = makeStore()
        let body = try encoded(status(enabled: false, active: false, appLimit: 0, appIDs: [], productID: nil, expiresAt: nil))
        MarketingURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/marketing/subscription")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer marketing-test")
            return (200, body)
        }
        await store.load()
        XCTAssertFalse(store.isEnabled)
        XCTAssertFalse(store.hasActiveSubscription)
        XCTAssertFalse(store.isLoading)
        XCTAssertNil(store.errorMessage)
        for plan in MarketingPlan.all {
            XCTAssertNil(store.displayPrice(for: plan))
            XCTAssertFalse(store.canPurchase(plan, appIDs: ["a"]))
        }
    }

    func testActiveServerEntitlementCoversOnlySelectedAppsAndPreventsDuplicatePurchase() async throws {
        let store = makeStore()
        let body = try encoded(status(expiresAt: Date().addingTimeInterval(600).timeIntervalSince1970 * 1_000))
        MarketingURLProtocol.handler = { _ in (200, body) }
        await store.refresh()
        XCTAssertTrue(store.hasActiveSubscription)
        XCTAssertTrue(store.canAccess(appID: "a"))
        XCTAssertFalse(store.canAccess(appID: "b"))
        for plan in MarketingPlan.all { XCTAssertFalse(store.canPurchase(plan, appIDs: ["a"])) }
    }

    func testTestFlightToggleHidesRealCoverageAndRestoresItWithoutMutatingEntitlement() async throws {
        let store = makeStore()
        let body = try encoded(status(expiresAt: Date().addingTimeInterval(600).timeIntervalSince1970 * 1_000))
        MarketingURLProtocol.handler = { _ in (200, body) }
        await store.refresh()
        XCTAssertFalse(store.needsPaywall)
        store.simulateNoPurchase(true)
        XCTAssertFalse(store.simulatesNoPurchase, "Unavailable debug controls cannot change access")
        store.setPaywallDebugAvailable(true)
        store.simulateNoPurchase(true)
        XCTAssertTrue(store.needsPaywall)
        XCTAssertFalse(store.hasActiveSubscription)
        XCTAssertFalse(store.canAccess(appID: "a"))
        XCTAssertTrue(store.subscription?.isActive() == true)
        await store.refresh()
        XCTAssertTrue(store.needsPaywall, "Refresh must preserve the debug state")
        store.simulateNoPurchase(false)
        XCTAssertTrue(store.canAccess(appID: "a"))
        XCTAssertFalse(store.canAccess(appID: "b"))
        store.simulateNoPurchase(true)
        store.configure(client: nil, userID: nil)
        XCTAssertFalse(store.simulatesNoPurchase)
        XCTAssertFalse(store.allowsPaywallDebug)
        XCTAssertTrue(store.needsPaywall)
    }

    func testDebugToggleCannotGrantAnUnpaidAccountAccess() async throws {
        let store = makeStore()
        let body = try encoded(status(enabled: false, active: false, appLimit: 0, appIDs: [], productID: nil, expiresAt: nil))
        MarketingURLProtocol.handler = { _ in (200, body) }
        await store.refresh()
        store.setPaywallDebugAvailable(true)
        for enabled in [true, false] {
            store.simulateNoPurchase(enabled)
            XCTAssertTrue(store.needsPaywall)
            XCTAssertFalse(store.canAccess(appID: "a"))
        }
        store.setPaywallDebugAvailable(false)
        XCTAssertFalse(store.simulatesNoPurchase)
    }

    func testServerMarkedActiveButExpiredNeverUnlocksMarketing() async throws {
        let store = makeStore()
        let body = try encoded(status(expiresAt: Date().addingTimeInterval(-1).timeIntervalSince1970 * 1_000))
        MarketingURLProtocol.handler = { _ in (200, body) }
        await store.refresh()
        XCTAssertFalse(store.hasActiveSubscription)
        XCTAssertFalse(store.canAccess(appID: "a"))
    }

    func testAppSelectionUsesAuthenticatedPutAndWaitsForServerAcceptance() async throws {
        let store = makeStore()
        let expiry = Date().addingTimeInterval(600).timeIntervalSince1970 * 1_000
        let original = try encoded(status(expiresAt: expiry))
        MarketingURLProtocol.handler = { _ in (200, original) }
        await store.refresh()
        MarketingURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "PUT")
            XCTAssertEqual(request.url?.path, "/api/marketing/subscription/apps")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer marketing-test")
            return (503, Data(#"{"error":"Try later"}"#.utf8))
        }
        await store.updateApps(["b"])
        XCTAssertEqual(store.subscription?.appIDs, ["a"])
        XCTAssertNotNil(store.errorMessage)
        let replacement = try encoded(status(appIDs: ["b"], expiresAt: expiry))
        MarketingURLProtocol.handler = { _ in (200, replacement) }
        await store.updateApps(["b"])
        XCTAssertEqual(store.subscription?.appIDs, ["b"])
        XCTAssertFalse(store.canAccess(appID: "a"))
        XCTAssertTrue(store.canAccess(appID: "b"))
        XCTAssertNil(store.errorMessage)
    }

    func testExpiredResponseAndUnauthorizedSessionRemoveExistingAccess() async throws {
        let store = makeStore()
        let active = try encoded(status(expiresAt: Date().addingTimeInterval(600).timeIntervalSince1970 * 1_000))
        MarketingURLProtocol.handler = { _ in (200, active) }
        await store.refresh()
        XCTAssertTrue(store.hasActiveSubscription)
        let revoked = try encoded(status(active: false))
        MarketingURLProtocol.handler = { _ in (200, revoked) }
        await store.refresh()
        XCTAssertFalse(store.hasActiveSubscription)
        MarketingURLProtocol.handler = { _ in (200, active) }
        await store.refresh()
        MarketingURLProtocol.handler = { _ in (401, Data(#"{"error":"Session expired"}"#.utf8)) }
        await store.refresh()
        XCTAssertNil(store.subscription)
        XCTAssertFalse(store.canAccess(appID: "a"))
    }

    func testLogoutDiscardsLateSubscriptionResponse() async throws {
        let store = makeStore()
        let waiting = expectation(description: "Subscription request started")
        var held: MarketingURLProtocol?
        MarketingURLProtocol.hold = { request in held = request; waiting.fulfill() }
        let refresh = Task { await store.refresh() }
        await fulfillment(of: [waiting], timeout: 3)
        store.configure(client: nil, userID: nil)
        held?.complete(status: 200, data: try encoded(status(expiresAt: Date().addingTimeInterval(600).timeIntervalSince1970 * 1_000)))
        await refresh.value
        XCTAssertNil(store.subscription)
        XCTAssertNil(store.errorMessage)
        XCTAssertFalse(store.canAccess(appID: "a"))
    }

    func testChangingServerOrSessionClearsOldAccountCoverage() async throws {
        let store = makeStore()
        let body = try encoded(status(expiresAt: Date().addingTimeInterval(600).timeIntervalSince1970 * 1_000))
        MarketingURLProtocol.handler = { _ in (200, body) }
        await store.refresh()
        XCTAssertTrue(store.hasActiveSubscription)
        store.configure(client: APIClient(baseURL: URL(string: "https://other.example.com")!, token: "marketing-test"), userID: "marketing-tests")
        XCTAssertNil(store.subscription)
        XCTAssertFalse(store.canAccess(appID: "a"))
        XCTAssertTrue(store.products.isEmpty)
    }

    #if DEBUG
    func testPreviewPricesAreExplicitAndNeverAllowPurchasingOrNetworkRequests() async {
        let store = MarketingStore(observeTransactions: false)
        store.configure(client: client(), userID: "preview", preview: true)
        MarketingURLProtocol.handler = { _ in XCTFail("Preview must stay offline"); return (500, Data()) }
        await store.load()
        await store.refresh()
        await store.restore()
        await store.updateApps(["a"])
        for plan in MarketingPlan.all {
            XCTAssertNotNil(store.displayPrice(for: plan))
            XCTAssertFalse(store.canPurchase(plan, appIDs: ["a"]))
            await store.purchase(plan, appIDs: ["a"])
        }
        XCTAssertFalse(store.canAccess(appID: "a"))
        XCTAssertNil(store.subscription)
    }
    #endif

    private func status(enabled: Bool = true, active: Bool = true, appLimit: Int = 1,
                        appIDs: [String] = ["a"], appAccountToken: String? = nil,
                        productID: String? = "com.kozr.quest.marketing.one.monthly",
                        expiresAt: Double? = 1_800_000_060_000) -> MarketingSubscription {
        MarketingSubscription(enabled: enabled, active: active, appLimit: appLimit, appIDs: appIDs,
            appAccountToken: appAccountToken ?? accountToken, productID: productID, expiresAt: expiresAt)
    }

    private func encoded(_ status: MarketingSubscription) throws -> Data { try JSONEncoder().encode(status) }

    private func client() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MarketingURLProtocol.self]
        return APIClient(baseURL: URL(string: "https://marketing.example.com")!, token: "marketing-test",
                         transport: URLSession(configuration: configuration))
    }

    private func makeStore() -> MarketingStore {
        let store = MarketingStore(observeTransactions: false)
        store.configure(client: client(), userID: "marketing-tests")
        return store
    }
}

private final class MarketingURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) -> (Int, Data))?
    static var hold: ((MarketingURLProtocol) -> Void)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if let hold = Self.hold { hold(self); return }
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let (status, data) = handler(request)
        complete(status: status, data: data)
    }
    func complete(status: Int, data: Data) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
