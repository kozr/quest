import XCTest
import SwiftUI
@testable import IAPNotifications

@MainActor
final class TrialsTests: XCTestCase {
    func testLiveTrialIncludesCancelledRenewalButExcludesExactExpiry() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let records = TrialsResponse.demo(now: now).trials
        let cancelled = try XCTUnwrap(records.first { $0.renewalStatus == .off })
        XCTAssertTrue(cancelled.isLive(at: now))
        XCTAssertFalse(cancelled.isLive(at: try XCTUnwrap(Timestamp.date(cancelled.endsAt))))
        XCTAssertFalse(cancelled.isLive(at: now.addingTimeInterval(-172_800)))
    }

    func testDemoBreakdownAndEndingSoonCountsAreConsistent() {
        let now = Date()
        let records = TrialsResponse.demo(now: now).trials
        XCTAssertEqual(records.count, 128)
        XCTAssertEqual(records.filter { $0.renewalStatus == .on }.count, 96)
        XCTAssertEqual(records.filter { $0.renewalStatus == .off }.count, 24)
        XCTAssertEqual(records.filter { $0.renewalStatus == .unknown }.count, 8)
        let ending = records.filter { Timestamp.date($0.endsAt)! <= now.addingTimeInterval(86_400) }
        XCTAssertEqual(ending.count, 18)
        XCTAssertEqual(ending.filter { $0.renewalStatus == .on }.count, 14)
        XCTAssertEqual(ending.filter { $0.renewalStatus == .off }.count, 3)
        XCTAssertEqual(ending.filter { $0.renewalStatus == .unknown }.count, 1)
    }

    func testFutureRenewalEnumsRemainUnknown() throws {
        let status = try JSONDecoder().decode(TrialRenewalStatus.self, from: Data("\"future-state\"".utf8))
        XCTAssertEqual(status, .unknown)
    }

    func testDemoFetchDoesNotCallLiveAPIOrChangeQueuedSales() async throws {
        let model = AppModel(loadStoredState: false)
        model.enterPreview()
        let pending = model.queuedSales.map(\.id)
        let response = try await model.fetchTrials()
        XCTAssertEqual(response.coverage, "demo")
        XCTAssertEqual(response.trials.count, 128)
        XCTAssertEqual(model.queuedSales.map(\.id), pending)
    }

    func testLiveFetchUsesSelectedEnvironmentAndShowsFailureWithoutFabricatingZero() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TrialsURLProtocol.self]
        let model = AppModel(session: SavedSession(serverURL: "https://example.com", token: "test-session",
            user: Account(id: "trial-tests", email: "trials@example.com")), transport: URLSession(configuration: configuration))
        model.selectedEnvironment = .sandbox
        TrialsURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/trials")
            XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "Sandbox")
            return (503, Data("{\"error\":\"Try later\"}".utf8))
        }
        defer { TrialsURLProtocol.handler = nil }
        let trials = TrialsModel()
        await trials.load(model)
        XCTAssertNotNil(trials.error)
        XCTAssertNil(trials.response)
        XCTAssertFalse(trials.isLoading)
    }

    func testFailedRefreshKeepsPreviousCountsAndEnvironmentChangeClearsThem() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TrialsURLProtocol.self]
        let model = AppModel(session: SavedSession(serverURL: "https://example.com", token: "test-session",
            user: Account(id: "trial-tests", email: "trials@example.com")), transport: URLSession(configuration: configuration))
        let json = #"{"asOf":"2026-09-13T12:00:00Z","coverage":"observed","truncated":false,"unverifiedCount":0,"trials":[{"id":"opaque","appId":"app","appName":"Example","productId":"annual","startedAt":"2026-09-12T12:00:00Z","endsAt":"2026-09-19T12:00:00Z","renewalStatus":"off","lastUpdatedAt":"2026-09-13T12:00:00Z"}]}"#
        TrialsURLProtocol.handler = { _ in (200, Data(json.utf8)) }
        defer { TrialsURLProtocol.handler = nil }
        let trials = TrialsModel()
        await trials.load(model)
        XCTAssertEqual(trials.response?.trials.count, 1)
        TrialsURLProtocol.handler = { _ in (503, Data("{}".utf8)) }
        await trials.load(model)
        XCTAssertNotNil(trials.error)
        XCTAssertEqual(trials.response?.trials.count, 1)
        model.selectedEnvironment = .sandbox
        await trials.load(model)
        XCTAssertNil(trials.response)
        XCTAssertNotNil(trials.error)
    }

    func testEmptyObservedResponseLoadsThroughClientAndClearsPreviousError() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TrialsURLProtocol.self]
        let model = AppModel(session: SavedSession(serverURL: "https://example.com", token: "test-session",
            user: Account(id: "trial-tests", email: "trials@example.com")), transport: URLSession(configuration: configuration))
        let trials = TrialsModel()
        defer { TrialsURLProtocol.handler = nil }
        TrialsURLProtocol.handler = { _ in (503, Data("{}".utf8)) }
        await trials.load(model)
        XCTAssertNotNil(trials.error)
        TrialsURLProtocol.handler = { _ in
            (200, Data(#"{"asOf":"2026-09-16T19:47:10.000Z","coverage":"observed","truncated":false,"unverifiedCount":0,"trials":[]}"#.utf8))
        }
        await trials.load(model)
        XCTAssertNil(trials.error)
        XCTAssertEqual(trials.response?.coverage, "observed")
        XCTAssertEqual(trials.response?.trials.count, 0)
        XCTAssertFalse(trials.isLoading)
    }

    func testOverviewEndingSoonAndAccessibilityRender() async throws {
        let model = AppModel(loadStoredState: false)
        model.enterPreview()
        try await capture(NavigationStack { TrialsDashboardView(section: .constant(.trials)) }.environmentObject(model), name: "trials-overview")
        try await capture(NavigationStack {
            TrialListView(trials: TrialsModel(response: .demo()), endingSoon: true).environmentObject(model)
        }, name: "trials-ending-soon")
        try await capture(NavigationStack { TrialsDashboardView(section: .constant(.trials)) }.environmentObject(model)
            .environment(\.dynamicTypeSize, .accessibility3), name: "trials-accessibility")
        try await capture(NavigationStack {
            TrialListView(trials: TrialsModel(response: .demo()), endingSoon: true).environmentObject(model)
                .environment(\.dynamicTypeSize, .accessibility3)
        }, name: "trials-list-accessibility")
    }

    func testCancelledRefreshIsSilentAndNetworkFailuresExplainTheCause() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TrialsURLProtocol.self]
        let model = AppModel(session: SavedSession(serverURL: "https://example.com", token: "test-session",
            user: Account(id: "trial-tests", email: "trials@example.com")), transport: URLSession(configuration: configuration))
        let trials = TrialsModel()
        defer { TrialsURLProtocol.failure = nil; TrialsURLProtocol.handler = nil }
        TrialsURLProtocol.handler = { _ in
            (200, Data(#"{"asOf":"2026-09-16T19:47:10.000Z","coverage":"observed","truncated":false,"unverifiedCount":0,"trials":[]}"#.utf8))
        }
        await trials.load(model)
        TrialsURLProtocol.failure = URLError(.cancelled)
        await trials.load(model)
        XCTAssertNil(trials.error)
        XCTAssertEqual(trials.response?.coverage, "observed")
        XCTAssertFalse(trials.isLoading)
        TrialsURLProtocol.failure = URLError(.timedOut)
        await trials.load(model)
        XCTAssertEqual(trials.error, "Trial refresh timed out. Try again.")
        XCTAssertNotNil(trials.response)
        TrialsURLProtocol.failure = nil
        TrialsURLProtocol.handler = { _ in (200, Data("{}".utf8)) }
        await trials.load(model)
        XCTAssertEqual(trials.error, "The server returned trial data that could not be read. Try again.")
    }

    private func capture<V: View>(_ view: V, name: String) async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .first { $0.session.role == .windowApplication })
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: view)
        window.rootViewController = host
        window.makeKeyAndVisible()
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(800))
        host.view.layoutIfNeeded()
        let format = UIGraphicsImageRendererFormat(); format.preferredRange = .standard
        let screenshot = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: screenshot); attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
        let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("trial-screens")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try XCTUnwrap(screenshot.pngData()).write(to: directory.appendingPathComponent(name + ".png"))
        print("TRIAL_SCREEN \(directory.appendingPathComponent(name + ".png").path)")
    }
}

private final class TrialsURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) -> (Int, Data))?
    static var failure: Error?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if let failure = Self.failure { client?.urlProtocol(self, didFailWithError: failure); return }
        guard let handler = Self.handler else { client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse)); return }
        let (status, data) = handler(request)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
