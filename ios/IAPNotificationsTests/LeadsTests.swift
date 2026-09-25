import Foundation
import SwiftUI
import XCTest
@testable import IAPNotifications

// Isolated transport for the Leads client tests. No live service is contacted.
private final class LeadsTestURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    static var holdNextAccess: ((LeadsTestURLProtocol) -> Void)?
    static var holdNextFeed: ((LeadsTestURLProtocol) -> Void)?
    static var requests: [URLRequest] = []

    static func reset() {
        handler = nil
        holdNextAccess = nil
        holdNextFeed = nil
        requests = []
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.requests.append(request)
        if request.url?.path == "/api/leads/access", let hold = Self.holdNextAccess {
            Self.holdNextAccess = nil
            hold(self)
            return
        }
        if request.url?.path.hasSuffix("/leads") == true, let hold = Self.holdNextFeed {
            Self.holdNextFeed = nil
            hold(self)
            return
        }
        do {
            guard let handler = Self.handler else {
                complete(status: 500, data: Data(#"{"error":"No Leads test response configured"}"#.utf8))
                return
            }
            let (status, data) = try handler(request)
            complete(status: status, data: data)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    func complete(status: Int, data: Data) {
        guard let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil,
                                             headerFields: ["Content-Type": "application/json"]) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}

private func leadsRequestBody(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { throw ClientError.invalidResponse }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while true {
        let count = buffer.withUnsafeMutableBufferPointer { pointer in
            stream.read(pointer.baseAddress!, maxLength: pointer.count)
        }
        if count < 0 { throw stream.streamError ?? ClientError.invalidResponse }
        if count == 0 { break }
        data.append(contentsOf: buffer.prefix(count))
    }
    return data
}

@MainActor
final class LeadsTests: XCTestCase {
    private let firstAppID = "lead-app-one"
    private let secondAppID = "lead-app-two"
    private let leadID = String(repeating: "a", count: 64)
    private let postID = "abc123"

    func testJournalKeepsSeparateEditsForBothApproaches() {
        let journal = LeadJournalExamples.halloweenSession()
        XCTAssertEqual(journal.selectedID, "light")
        journal.replyText = "My edited checklist reply."
        journal.selectedID = "resource"
        XCTAssertEqual(journal.replyText, LeadJournalExamples.halloween.replies[0].body)
        journal.replyText = "My edited official-list reply."
        journal.selectedID = "light"
        XCTAssertEqual(journal.replyText, "My edited checklist reply.")
        journal.isEditing = false
        journal.isEditing = true
        XCTAssertEqual(journal.replyText, "My edited checklist reply.")
    }

    func testJournalRejectsMalformedCompletedPlansAndPreservesEditsOnRefresh() throws {
        let journal = LeadJournalExamples.halloweenSession()
        journal.replyText = "An edit that must survive loading."
        let invalid = LeadReplyPlan(title: "A quest", objective: "Help someone", replies: [])
        XCTAssertThrowsError(try journal.accept(LeadReplyResponse(jobId: "job", status: "succeeded", plan: invalid, reasonCode: nil)))
        XCTAssertTrue(try journal.accept(LeadReplyResponse(jobId: "job", status: "succeeded", plan: LeadJournalExamples.halloween, reasonCode: nil)))
        XCTAssertEqual(journal.replyText, "An edit that must survive loading.")
        XCTAssertThrowsError(try journal.accept(LeadReplyResponse(jobId: "job", status: "uncertain", plan: nil, reasonCode: "PROVIDER_UNCERTAIN")))
    }

    func testDemoJournalPreparesWithoutNetworkAndIsScopedToTheQuest() async throws {
        let model = AppModel(loadStoredState: false)
        model.enterPreview()
        await model.refreshLeadBoard()
        let lead = try XCTUnwrap(model.leadItems.first)
        let first = model.journal(for: lead, appName: "Orbit Journal")
        await model.prepareJournal(first)
        XCTAssertNotNil(first.plan)
        XCTAssertTrue(LeadsTestURLProtocol.requests.isEmpty)
        first.replyText = "An edit to this quest only."
        XCTAssertTrue(first === model.journal(for: lead, appName: "Orbit Journal"))
        let second = model.journal(for: try XCTUnwrap(model.leadItems.last), appName: "Orbit Journal")
        XCTAssertNotEqual(second.replyText, first.replyText)
    }

    override func tearDown() {
        LeadsTestURLProtocol.reset()
        super.tearDown()
    }

    private func jsonData(_ object: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    private func model() -> AppModel {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LeadsTestURLProtocol.self]
        return AppModel(session: SavedSession(serverURL: "https://example.com", token: String(repeating: "t", count: 43),
                                              user: Account(id: "leads-test-user", email: "leads@example.test")),
                        transport: URLSession(configuration: configuration))
    }

    private func app(_ id: String, name: String) -> [String: Any] {
        ["id": id, "name": name, "bundleId": "com.example.\(id)", "appleId": "123456789",
         "source": "apple", "iconUrl": NSNull(), "createdAt": "2026-09-23T10:00:00.000Z",
         "webhookUrls": ["production": "", "sandbox": ""], "lastProductionEventAt": NSNull(),
         "lastSandboxEventAt": NSNull(), "forwardingUrl": NSNull()]
    }

    private func appsResponse(_ ids: [String]) throws -> Data {
        try jsonData(["apps": ids.map { app($0, name: "Connected \($0)") }])
    }

    private func profileResponse(_ appID: String, revision: Int = 1) throws -> Data {
        let profile: [String: Any] = [
            "appId": appID, "schemaVersion": 1, "revision": revision, "enabled": true,
            "problems": [["id": "problem-\(appID)", "text": "Stay focused during study sessions"]],
            "capabilities": [["id": "capability-\(appID)", "text": "Plan focused work blocks", "source": "user_confirmed"]],
            "communities": ["productivity"], "keywords": ["focus"], "descriptionSource": NSNull(),
            "confirmedAt": "2026-09-23T10:00:00.000Z", "updatedAt": "2026-09-23T10:00:00.000Z"
        ]
        return try jsonData(["profile": profile, "legacySuggestions": NSNull(), "status": [
            "code": "ready", "lastCollectedAt": "2026-09-23T10:15:00.000Z",
            "lastQualifiedAt": "2026-09-23T10:14:00.000Z", "nextCheckAt": "2026-09-23T10:20:00.000Z",
            "partial": false, "limited": false
        ]])
    }

    private func accessResponse(enabled: Bool) throws -> Data {
        try jsonData(["enabled": enabled, "aiAvailable": false, "reasonCode": NSNull()])
    }

    private func leadPageResponse(_ appID: String) throws -> Data {
        let item: [String: Any] = [
            "id": leadID, "appId": appID, "postId": postID, "community": "productivity",
            "title": "Looking for a focus timer", "excerpt": "I need a timer for focused work blocks and breaks.",
            "url": "https://www.reddit.com/r/productivity/comments/\(postID)/",
            "createdAt": "2026-09-23T10:00:00.000Z", "whyItFits": "It supports planned focus blocks.",
            "qualifiedAt": "2026-09-23T10:05:00.000Z"
        ]
        return try jsonData(["leads": [item], "nextCursor": NSNull(),
                             "status": ["code": "ready", "partial": false, "limited": false]])
    }

    private func installLeadServer(appIDs: [String],
                                   leadHandler: ((URLRequest) throws -> (Int, Data))? = nil) {
        LeadsTestURLProtocol.handler = { [self] request in
            let path = request.url?.path ?? ""
            if path == "/api/apps" { return (200, try appsResponse(appIDs)) }
            if path == "/api/leads/access" { return (200, try accessResponse(enabled: true)) }
            if path.hasSuffix("/leads/profile"), request.httpMethod == "GET" {
                let appID = path.split(separator: "/").dropFirst(2).first.map(String.init) ?? ""
                return (200, try profileResponse(appID))
            }
            if path.hasSuffix("/leads"), request.httpMethod == "GET" {
                let appID = path.split(separator: "/").dropFirst(2).first.map(String.init) ?? ""
                return (200, try leadPageResponse(appID))
            }
            if let leadHandler { return try leadHandler(request) }
            return (404, try jsonData(["error": "Not found"]))
        }
    }

    func testProfileStatusDecodesISO8601NextCheckTimestamp() throws {
        let payload = try jsonData(["profile": NSNull(), "legacySuggestions": NSNull(), "status": [
            "code": "ready", "lastCollectedAt": "2026-09-23T10:15:00.000Z",
            "lastQualifiedAt": NSNull(), "nextCheckAt": "2026-09-23T10:20:00.000Z",
            "partial": false, "limited": true
        ]])

        let response = try JSONDecoder().decode(LeadProfileResponse.self, from: payload)
        XCTAssertEqual(response.status.nextCheckAt, "2026-09-23T10:20:00.000Z")
        XCTAssertNotNil(Timestamp.date(try XCTUnwrap(response.status.nextCheckAt)))
        XCTAssertEqual(response.status.limited, true)
        XCTAssertNil(response.status.progress, "Older API responses must remain compatible")
    }

    func testBoardRefreshRetainsProgressAndReplacesItOnCompletion() async throws {
        var phase = "assessing"
        LeadsTestURLProtocol.handler = { [self] request in
            let path = request.url?.path ?? ""
            if path == "/api/apps" { return (200, try appsResponse([firstAppID])) }
            if path == "/api/leads/access" {
                return (200, try jsonData(["enabled": true, "aiAvailable": true]))
            }
            if path.hasSuffix("/leads/profile") { return (200, try profileResponse(firstAppID)) }
            if path.hasSuffix("/leads") {
                let progress: [String: Any] = ["phase": phase, "batchId": "batch-a", "fraction": 0.5,
                    "post": ["id": postID, "community": "productivity", "title": "Looking for a focus timer",
                             "excerpt": "I need a timer.", "state": "reviewing"]]
                return (200, try jsonData(["leads": [], "nextCursor": NSNull(),
                    "status": ["code": "waiting", "partial": false, "limited": false, "progress": progress]]))
            }
            return (404, try jsonData(["error": "Not found"]))
        }
        let account = model()
        await account.loadApps()
        await account.refreshLeadBoard()
        XCTAssertEqual(account.leadProfileStatus.progress?.normalizedFraction, 0.5)
        XCTAssertEqual(account.leadProfileStatus.progress?.post?.id, postID)
        XCTAssertEqual(account.leadProfileStatus.progress?.isWorking, true)
        phase = "complete"
        await account.refreshLeadBoard(background: true)
        XCTAssertEqual(account.leadProfileStatus.progress?.isWorking, false)
        XCTAssertEqual(account.leadProfileStatus.progress?.shouldPoll, false)
        XCTAssertTrue(account.leadItems.isEmpty)
    }

    func testEmptyUnattemptedBoardAutomaticallyStartsOnceAndCompletedEmptyBoardDoesNotRestart() async throws {
        var started = false
        var startCalls = 0
        LeadsTestURLProtocol.handler = { [self] request in
            let path = request.url?.path ?? ""
            if path == "/api/apps" { return (200, try appsResponse([firstAppID])) }
            if path == "/api/leads/access" { return (200, try jsonData(["enabled": true, "aiAvailable": true])) }
            if path.hasSuffix("/leads/profile") { return (200, try profileResponse(firstAppID)) }
            if path.hasSuffix("/leads/scan") {
                XCTAssertEqual(request.httpMethod, "POST")
                let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: leadsRequestBody(request)) as? [String: Any])
                XCTAssertEqual(body["expectedRevision"] as? Int, 1)
                startCalls += 1
                started = true
                return (202, try jsonData(["started": true, "progress": ["phase": "queued", "canStart": false]]))
            }
            if path.hasSuffix("/leads") {
                return (200, try jsonData(["leads": [], "status": ["code": "waiting", "partial": false,
                    "progress": ["phase": started ? "complete" : "waiting", "canStart": !started]]]))
            }
            return (404, try jsonData(["error": "Not found"]))
        }
        let account = model()
        await account.loadApps()
        await account.refreshLeadBoard()
        XCTAssertEqual(startCalls, 1)
        XCTAssertEqual(account.leadProfileStatus.progress?.phase, "queued")
        await account.refreshLeadBoard(background: true)
        await account.refreshLeadBoard()
        XCTAssertEqual(startCalls, 1)
        XCTAssertEqual(account.leadProfileStatus.progress?.phase, "complete")
        XCTAssertTrue(account.leadItems.isEmpty)
    }

    func testPickupUsesOnlyCanonicalRedditURLAndExplainsSampleWithoutOpening() throws {
        let real = LeadItem(id: leadID, appId: firstAppID, postId: postID, community: "productivity",
                            title: "Looking for a focus timer", excerpt: "A post excerpt.",
                            url: "https://reddit.com/r/productivity/comments/abc123/", createdAt: "2026-09-23T10:00:00Z",
                            whyItFits: "It supports focus sessions.")
        let canonical = try XCTUnwrap(URL(string: "https://www.reddit.com/r/productivity/comments/abc123/"))
        XCTAssertEqual(LeadURL.destination(for: real), .reddit(canonical))
        var opened: [URL] = []
        XCTAssertEqual(LeadURL.performPickUp(for: real) { opened.append($0) }, .opened(canonical))
        XCTAssertEqual(opened, [canonical])

        for unsafeURL in ["https://reddit.com.evil.test/r/productivity/comments/abc123/",
                          "https://reddit.com/r/productivity/comments/other/",
                          "https://reddit.com/r/productivity/comments/abc123/?redirect=https://evil.test",
                          "http://reddit.com/r/productivity/comments/abc123/"] {
            let unsafe = LeadItem(id: real.id, appId: real.appId, postId: real.postId, community: real.community,
                                  title: real.title, excerpt: real.excerpt, url: unsafeURL, createdAt: real.createdAt,
                                  whyItFits: real.whyItFits)
            XCTAssertEqual(LeadURL.destination(for: unsafe), .unavailable, unsafeURL)
        }

        let sample = try XCTUnwrap(LeadPreviewFixtures.leads(app: PreviewContent.apps[0]).first)
        var sampleOpenCount = 0
        XCTAssertEqual(LeadURL.performPickUp(for: sample) { _ in sampleOpenCount += 1 }, .sampleExplanation)
        XCTAssertEqual(sampleOpenCount, 0)
    }

    func testPickupDoesNotMutateBoardCard() async throws {
        installLeadServer(appIDs: [firstAppID])
        let account = model()
        await account.loadApps()
        await account.refreshLeadBoard()
        let lead = try XCTUnwrap(account.leadItems.first)

        let result = LeadURL.performPickUp(for: lead) { _ in }

        XCTAssertEqual(result, .opened(try XCTUnwrap(URL(string: "https://www.reddit.com/r/productivity/comments/abc123/"))))
        XCTAssertTrue(account.leadItems.contains(where: { $0.id == lead.id }))
        XCTAssertNil(account.leadMutationError)
        XCTAssertFalse(LeadsTestURLProtocol.requests.contains { $0.httpMethod == "PUT" || $0.httpMethod == "DELETE" })
    }

    func testOfflinePreviewDismissUndoAndAppIsolationMakeNoAPIRequests() async throws {
        let account = model()
        LeadsTestURLProtocol.handler = { _ in (200, Data(#"{"ok":true}"#.utf8)) }
        await account.logout()
        XCTAssertNil(account.user)
        XCTAssertEqual(LeadsTestURLProtocol.requests.map { $0.url?.path }, ["/api/auth/logout"],
                       "The injected transport must be observed before switching to offline preview")
        LeadsTestURLProtocol.requests = []
        account.enterPreview()
        await account.refreshLeadBoard()
        XCTAssertTrue(account.isPreviewMode)
        XCTAssertEqual(account.selectedLeadAppID, "demo-orbit")
        let first = try XCTUnwrap(account.leadItems.first)
        XCTAssertEqual(account.leadItems.count, 2)

        await account.dismissLead(first)
        XCTAssertFalse(account.leadItems.contains(where: { $0.id == first.id }))
        XCTAssertEqual(account.leadUndoAction?.appId, "demo-orbit")
        await account.undoLeadDismissal()
        XCTAssertTrue(account.leadItems.contains(where: { $0.id == first.id }))
        XCTAssertNil(account.leadUndoAction)

        await account.dismissLead(first)
        account.selectLeadApp("demo-focus")
        await account.refreshLeadBoard()
        XCTAssertEqual(account.leadItems.count, 2)
        XCTAssertTrue(account.leadItems.allSatisfy { $0.appId == "demo-focus" })
        account.selectLeadApp("demo-orbit")
        await account.refreshLeadBoard()
        XCTAssertEqual(account.leadItems.count, 1)
        XCTAssertTrue(account.leadItems.allSatisfy { $0.appId == "demo-orbit" })
        XCTAssertFalse(account.leadItems.contains(where: { $0.id == first.id }))
        XCTAssertNil(account.leadBoardError)
        XCTAssertNil(account.leadMutationError)
        XCTAssertTrue(LeadsTestURLProtocol.requests.isEmpty)
    }

    func testGenericFeatureNotFoundDoesNotRemoveConnectedApp() async throws {
        installLeadServer(appIDs: [firstAppID])
        LeadsTestURLProtocol.handler = { [self] request in
            if request.url?.path == "/api/apps" { return (200, try appsResponse([firstAppID])) }
            if request.url?.path == "/api/leads/access" { return (404, Data(#"{"error":"Not found"}"#.utf8)) }
            return (404, Data(#"{"error":"Not found"}"#.utf8))
        }
        let account = model()
        await account.loadApps()
        await account.refreshLeadBoard()

        XCTAssertEqual(account.apps.map(\.id), [firstAppID])
        XCTAssertEqual(account.selectedLeadAppID, firstAppID)
        XCTAssertNil(account.leadProfile)
        XCTAssertTrue(account.leadBoardError?.contains("Not found") == true)
    }

    func testBoardLoadingCoversFeedFetchAndRetryWithoutHidingExistingLeads() async throws {
        installLeadServer(appIDs: [firstAppID, secondAppID])
        let account = model()
        await account.loadApps()
        XCTAssertTrue(account.isPreparingLeadBoard, "The initial render must not flash setup before its task starts")

        let waiting = expectation(description: "profile loaded; feed is still pending")
        var held: LeadsTestURLProtocol?
        LeadsTestURLProtocol.holdNextFeed = { request in
            held = request
            waiting.fulfill()
        }
        let refresh = Task { await account.refreshLeadBoard() }
        await fulfillment(of: [waiting], timeout: 3)
        XCTAssertNotNil(account.leadProfile)
        XCTAssertTrue(account.isPreparingLeadBoard, "Loading must continue after the profile arrives")
        account.selectedTab = "leads"
        try await captureLoading(account, name: "leads-loading")
        try await captureLoading(account, name: "leads-loading-large-text", largeText: true)

        held?.complete(status: 503, data: Data(#"{"error":"Temporarily unavailable"}"#.utf8))
        await refresh.value
        XCTAssertFalse(account.isPreparingLeadBoard)
        XCTAssertNotNil(account.leadBoardError, "A completed failure still offers retry")

        let retryWaiting = expectation(description: "retry feed is pending")
        LeadsTestURLProtocol.holdNextFeed = { request in
            held = request
            retryWaiting.fulfill()
        }
        let retry = Task { await account.refreshLeadBoard() }
        await fulfillment(of: [retryWaiting], timeout: 3)
        XCTAssertNil(account.leadBoardError)
        XCTAssertTrue(account.isPreparingLeadBoard, "Retry must show loading even with a cached profile")
        held?.complete(status: 200, data: try leadPageResponse(firstAppID))
        await retry.value
        XCTAssertFalse(account.isPreparingLeadBoard)
        XCTAssertEqual(account.leadItems.count, 1)

        let refreshWaiting = expectation(description: "existing leads are refreshing")
        LeadsTestURLProtocol.holdNextFeed = { request in
            held = request
            refreshWaiting.fulfill()
        }
        let nextRefresh = Task { await account.refreshLeadBoard() }
        await fulfillment(of: [refreshWaiting], timeout: 3)
        XCTAssertFalse(account.isPreparingLeadBoard, "Existing cards stay visible during refresh")
        XCTAssertEqual(account.leadItems.count, 1)
        held?.complete(status: 200, data: try leadPageResponse(firstAppID))
        await nextRefresh.value

        account.selectLeadApp(secondAppID)
        XCTAssertTrue(account.isPreparingLeadBoard, "Switching apps must show loading immediately")
    }

    private func captureLoading(_ model: AppModel, name: String, largeText: Bool = false) async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let host = UIHostingController(rootView: LeadsView().environmentObject(model)
            .environment(\.colorScheme, .dark)
            .environment(\.dynamicTypeSize, largeText ? .accessibility3 : .large))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(300))
        host.view.layoutIfNeeded()
        let screenshot = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("leads-loading-screens")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try XCTUnwrap(screenshot.pngData()).write(to: directory.appendingPathComponent(name + ".png"))
    }

    func testLateBoardResponseIsDiscardedAfterSwitchingApps() async throws {
        installLeadServer(appIDs: [firstAppID, secondAppID])
        let waiting = expectation(description: "first app access request is held")
        var held: LeadsTestURLProtocol?
        LeadsTestURLProtocol.holdNextAccess = { request in
            held = request
            waiting.fulfill()
        }
        let account = model()
        await account.loadApps()
        XCTAssertEqual(account.selectedLeadAppID, firstAppID)
        let firstRefresh = Task { await account.refreshLeadBoard() }
        await fulfillment(of: [waiting], timeout: 3)

        account.selectLeadApp(secondAppID)
        await account.refreshLeadBoard()
        XCTAssertEqual(account.leadProfile?.appId, secondAppID)
        XCTAssertEqual(account.leadItems.map(\.appId), [secondAppID])

        held?.complete(status: 200, data: try accessResponse(enabled: false))
        await firstRefresh.value
        XCTAssertEqual(account.selectedLeadAppID, secondAppID)
        XCTAssertEqual(account.leadAccess?.enabled, true)
        XCTAssertEqual(account.leadProfile?.appId, secondAppID)
        XCTAssertEqual(account.leadItems.map(\.appId), [secondAppID])
    }

    func testFailedDismissalRollsBackAndUndoUsesExactMutationToken() async throws {
        var dismissalBodies: [[String: Any]] = []
        var putAttempts = 0
        installLeadServer(appIDs: [firstAppID], leadHandler: { [self] request in
            if request.url?.path.hasSuffix("/dismissal") == true {
                let body = try leadsRequestBody(request)
                guard let object = try JSONSerialization.jsonObject(with: body) as? [String: Any] else {
                    throw ClientError.invalidResponse
                }
                dismissalBodies.append(object)
                if request.httpMethod == "PUT" {
                    putAttempts += 1
                    if putAttempts == 1 { return (503, Data(#"{"error":"Unavailable"}"#.utf8)) }
                    return (200, try jsonData(["ok": true, "mutationId": object["mutationId"] ?? NSNull()]))
                }
                return (200, try jsonData(["ok": true]))
            }
            return (404, try jsonData(["error": "Not found"]))
        })
        let account = model()
        await account.loadApps()
        await account.refreshLeadBoard()
        let lead = try XCTUnwrap(account.leadItems.first)

        await account.dismissLead(lead)
        XCTAssertTrue(account.leadItems.contains(where: { $0.id == lead.id }), "Failed dismissal must restore the card")
        XCTAssertEqual(account.leadFailedDismissal?.id, lead.id)
        XCTAssertNil(account.leadUndoAction)

        await account.retryLeadDismissal()
        XCTAssertFalse(account.leadItems.contains(where: { $0.id == lead.id }))
        let action = try XCTUnwrap(account.leadUndoAction)
        XCTAssertEqual(dismissalBodies.count, 2)
        XCTAssertEqual(dismissalBodies[1]["mutationId"] as? String, action.mutationId)
        let requestsBeforeRefresh = LeadsTestURLProtocol.requests.count
        await account.refreshLeadBoard(background: true)
        XCTAssertEqual(LeadsTestURLProtocol.requests.count, requestsBeforeRefresh)
        XCTAssertEqual(account.leadUndoAction?.id, action.id, "Automatic progress refresh must preserve undo")
        XCTAssertFalse(account.leadItems.contains(where: { $0.id == lead.id }))
        account.clearLeadUndo(id: UUID())
        XCTAssertEqual(account.leadUndoAction?.id, action.id, "An unrelated undo token must not clear this action")

        await account.undoLeadDismissal()
        XCTAssertEqual(dismissalBodies.count, 3)
        XCTAssertEqual(dismissalBodies[2]["mutationId"] as? String, action.mutationId)
        XCTAssertTrue(account.leadItems.contains(where: { $0.id == lead.id }))
        XCTAssertNil(account.leadUndoAction)
        XCTAssertNil(account.leadPendingPostID)
    }

    func testProfileRevisionConflictIsSurfacedForReview() async throws {
        installLeadServer(appIDs: [firstAppID], leadHandler: { [self] request in
            if request.url?.path.hasSuffix("/leads/profile") == true, request.httpMethod == "PUT" {
                return (409, try jsonData(["error": "This profile changed on another device.", "code": "STALE_PROFILE"]))
            }
            return (404, try jsonData(["error": "Not found"]))
        })
        let account = model()
        await account.loadApps()
        await account.refreshLeadBoard()
        XCTAssertEqual(account.leadProfile?.revision, 1)
        let request = LeadProfileSaveRequest(expectedRevision: 1, enabled: true,
            problems: [LeadProfileRowInput(id: "problem-\(firstAppID)", text: "Stay focused during study sessions")],
            capabilities: [LeadProfileRowInput(id: "capability-\(firstAppID)", text: "Plan focused work blocks")],
            communities: ["productivity"], keywords: ["focus"], draftId: nil)

        do {
            try await account.saveLeadProfile(appId: firstAppID, request: request)
            XCTFail("The stale profile save should fail")
        } catch {
            XCTAssertEqual(account.leadProfileSaveError,
                           "This profile changed on another device. Reload it and review your edits before saving.")
        }
        XCTAssertEqual(account.leadProfile?.revision, 1)
    }
}
