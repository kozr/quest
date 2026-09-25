import Foundation
import XCTest
@testable import IAPNotifications

@MainActor
final class MarketTests: XCTestCase {
    private let firstAppID = "market-app-one"
    private let secondAppID = "market-app-two"

    func testSampleProblemAndPeopleCountsShareTheSameEvidence() {
        let overview = MarketExamples.overview()
        let allPeople = MarketExamples.people(for: overview)
        XCTAssertEqual(allPeople.people.count, 14)
        XCTAssertTrue(allPeople.people.allSatisfy(\.isSample))
        XCTAssertTrue(overview.evidence.allSatisfy(\.isSample))
        XCTAssertTrue(overview.evidence.allSatisfy { $0.source.isSample })
        XCTAssertTrue(overview.evidence.allSatisfy { $0.source.url == nil })

        for problem in overview.problems {
            let evidence = overview.evidence.filter { $0.problemId == problem.id }
            let people = MarketExamples.people(for: overview, problemID: problem.id).people
            XCTAssertEqual(people.count, problem.peopleCount, problem.title)
            XCTAssertEqual(evidence.count, problem.observationCount, problem.title)
            XCTAssertEqual(Set(evidence.map(\.source.threadId)).count,
                           problem.conversationCount, problem.title)
        }
        XCTAssertEqual(MarketExamples.people(for: overview, problemID: MarketExamples.problemTrackingID).people.count, 7)
    }

    func testLiveSourceLinksRequireMatchingRedditIdentityAndCanonicalPath() throws {
        let post = source(id: "reddit:post:abc123", kind: .post, thread: "abc123",
                          url: "https://www.reddit.com/r/productivity/comments/abc123/focus_timer/")
        XCTAssertEqual(MarketPeopleDestination.forSource(post),
                       .open(try XCTUnwrap(URL(string: "https://www.reddit.com/r/productivity/comments/abc123/focus_timer/"))))

        let comment = source(id: "reddit:comment:def456", kind: .comment, thread: "t3_abc123",
                             parent: "t3_abc123",
                             url: "https://www.reddit.com/r/productivity/comments/abc123/focus_timer/def456/")
        XCTAssertNotNil(comment.verifiedRedditURL)

        let impostorHost = source(id: "reddit:post:abc123", kind: .post, thread: "abc123",
                                  url: "https://www.reddit.com.example.net/r/productivity/comments/abc123/focus_timer/")
        XCTAssertNil(impostorHost.verifiedRedditURL)

        let commentShapedAsPost = source(id: "reddit:post:abc123", kind: .post, thread: "abc123",
                                         url: "https://www.reddit.com/r/productivity/comments/abc123/focus_timer/def456/")
        XCTAssertNil(commentShapedAsPost.verifiedRedditURL)

        let commentMissingItsNativeID = source(id: "reddit:comment:def456", kind: .comment, thread: "abc123",
                                               url: "https://www.reddit.com/r/productivity/comments/abc123/def456/")
        XCTAssertNil(commentMissingItsNativeID.verifiedRedditURL)
        XCTAssertEqual(MarketPeopleDestination.forSource(commentMissingItsNativeID), .unavailable)
    }

    func testSampleSourceShowsExplanationInsteadOfOpeningURL() {
        let sample = source(id: "sample-source-1", kind: .post, thread: "sample-thread",
                            url: "https://www.reddit.com/r/productivity/comments/abc123/focus_timer/",
                            isSample: true)
        XCTAssertEqual(MarketPeopleDestination.forSource(sample), .sampleExplanation)
    }

    func testProductionFailureOrSampleMarkedPayloadNeverBecomesDemoData() async {
        let store = MarketStore()
        store.configure(accountID: "account-one", apps: [app(firstAppID)],
                        preferredAppID: firstAppID, preview: false)

        await store.loadOverview { _ in throw ClientError.codedServer(status: 404,
                                                                       message: "Market is unavailable.",
                                                                       code: "FEATURE_UNAVAILABLE") }
        XCTAssertNil(store.overview)
        XCTAssertFalse(store.isSample)
        XCTAssertEqual(store.loadErrorCode, "FEATURE_UNAVAILABLE")

        let markedSample = MarketOverview(
            appId: firstAppID, profileRevision: 1, snapshotId: nil,
            generatedAt: nil, windowStart: nil, windowEnd: nil,
            coverage: .partial, sources: [], featuredProblemId: nil,
            problems: [], evidence: [], scan: nil, isSample: true
        )
        await store.loadOverview { _ in markedSample }
        XCTAssertNil(store.overview)
        XCTAssertFalse(store.isSample)
        XCTAssertNotNil(store.errorMessage)

        let fixtures = MarketExamples.overview()
        let sampleEvidenceInLiveResponse = MarketOverview(
            appId: firstAppID, profileRevision: 1, snapshotId: "snapshot-one",
            generatedAt: nil, windowStart: nil, windowEnd: nil,
            coverage: .partial, sources: [], featuredProblemId: fixtures.featuredProblemId,
            problems: fixtures.problems, evidence: fixtures.evidence, scan: nil, isSample: false
        )
        await store.loadOverview { _ in sampleEvidenceInLiveResponse }
        XCTAssertNil(store.overview)
        XCTAssertFalse(store.isSample)
        XCTAssertNotNil(store.errorMessage)
    }

    func testAppSwitchWhileOverviewIsInFlightCannotRestoreOldApp() async {
        let store = MarketStore()
        store.configure(accountID: "account-one", apps: [app(firstAppID), app(secondAppID)],
                        preferredAppID: firstAppID, preview: false)
        var heldOverview: CheckedContinuation<MarketOverview, Never>?

        let oldRequest = Task {
            await store.loadOverview { appID in
                if appID == self.firstAppID {
                    return await withCheckedContinuation { heldOverview = $0 }
                }
                return self.liveOverview(appID)
            }
        }
        await Task.yield()
        XCTAssertNotNil(heldOverview)

        store.selectApp(secondAppID)
        await store.loadOverview { self.liveOverview($0) }
        heldOverview?.resume(returning: liveOverview(firstAppID))
        await oldRequest.value

        XCTAssertEqual(store.selectedMarketAppID, secondAppID)
        XCTAssertEqual(store.overview?.appId, secondAppID)
    }

    func testAccountChangeWhileOverviewIsInFlightCannotRestorePreviousSession() async {
        let store = MarketStore()
        store.configure(accountID: "account-one", apps: [app(firstAppID)],
                        preferredAppID: firstAppID, preview: false)
        var heldOverview: CheckedContinuation<MarketOverview, Never>?

        let oldRequest = Task {
            await store.loadOverview { appID in
                return await withCheckedContinuation { heldOverview = $0 }
            }
        }
        await Task.yield()
        XCTAssertNotNil(heldOverview)

        store.configure(accountID: "account-two", apps: [app(secondAppID)],
                        preferredAppID: secondAppID, preview: false)
        await store.loadOverview { self.liveOverview($0) }
        heldOverview?.resume(returning: liveOverview(firstAppID))
        await oldRequest.value

        XCTAssertEqual(store.selectedMarketAppID, secondAppID)
        XCTAssertEqual(store.overview?.appId, secondAppID)
    }

    func testProfileRevisionChangeInvalidatesInFlightPeoplePage() async {
        let store = MarketStore()
        store.configure(accountID: "account-one", apps: [app(firstAppID)],
                        preferredAppID: firstAppID, preview: false)
        await store.loadOverview { self.liveOverview($0, revision: 1, snapshotId: "snapshot-one") }
        var heldPage: CheckedContinuation<MarketPeoplePageDTO, Never>?

        let oldRequest = Task {
            await store.loadPeople(fetch: { appID, revision, snapshotId, problemID, _ in
                return await withCheckedContinuation { heldPage = $0 }
            })
        }
        await Task.yield()
        XCTAssertNotNil(heldPage)

        await store.loadOverview { self.liveOverview($0, revision: 2, snapshotId: "snapshot-two") }
        heldPage?.resume(returning: self.livePeoplePage(firstAppID, revision: 1,
                                                         snapshotId: "snapshot-one"))
        await oldRequest.value

        XCTAssertNil(store.peoplePage)
        XCTAssertEqual(store.overview?.profileRevision, 2)
        XCTAssertEqual(store.overview?.snapshotId, "snapshot-two")
    }

    func testPeoplePaginationUsesOneSnapshotForEveryPage() async {
        let store = MarketStore()
        store.configure(accountID: "account-one", apps: [app(firstAppID)],
                        preferredAppID: firstAppID, preview: false)
        await store.loadOverview { self.liveOverview($0, revision: 4, snapshotId: "snapshot-four") }
        var firstSnapshot: String?
        var firstCursor: String?

        await store.loadPeople(fetch: { appID, revision, snapshotId, problemID, page in
            firstSnapshot = snapshotId
            firstCursor = page.cursor
            return self.livePeoplePage(appID, revision: revision, snapshotId: snapshotId,
                                       people: [self.livePerson("person-one")], nextCursor: "cursor-one")
        })
        XCTAssertEqual(firstSnapshot, "snapshot-four")
        XCTAssertNil(firstCursor)
        XCTAssertEqual(store.peoplePage?.snapshotId, "snapshot-four")

        var nextPageSnapshot: String?
        var nextPageCursor: String?
        await store.loadPeople(fetch: { appID, revision, snapshotId, problemID, page in
            nextPageSnapshot = snapshotId
            nextPageCursor = page.cursor
            return self.livePeoplePage(appID, revision: revision, snapshotId: snapshotId,
                                       people: [self.livePerson("person-two")])
        }, loadingMore: true)
        XCTAssertEqual(nextPageSnapshot, "snapshot-four")
        XCTAssertEqual(nextPageCursor, "cursor-one")
        XCTAssertEqual(store.peoplePage?.people.map(\.id), ["person-one", "person-two"])
        XCTAssertNil(store.peoplePage?.nextCursor)
    }

    func testExpiredPeopleSnapshotClearsPagesAndRefreshesOverview() async {
        let store = MarketStore()
        store.configure(accountID: "account-one", apps: [app(firstAppID)],
                        preferredAppID: firstAppID, preview: false)
        await store.loadOverview { self.liveOverview($0, revision: 4, snapshotId: "snapshot-four") }
        await store.loadPeople(fetch: { appID, revision, snapshotId, problemID, _ in
            self.livePeoplePage(appID, revision: revision, snapshotId: snapshotId,
                                people: [self.livePerson("person-one")], nextCursor: "cursor-one")
        })
        XCTAssertEqual(store.peoplePage?.people.map(\.id), ["person-one"])

        await store.loadPeople(fetch: { _, _, _, _, _ in
            throw ClientError.codedServer(status: 409,
                                          message: "This evidence snapshot has expired.",
                                          code: "STALE_SNAPSHOT")
        }, loadingMore: true, refreshOverview: { appID in
            self.liveOverview(appID, revision: 4, snapshotId: "snapshot-five")
        })

        XCTAssertNil(store.peoplePage)
        XCTAssertEqual(store.overview?.snapshotId, "snapshot-five")
        XCTAssertNil(store.peopleError)
    }

    func testScanResponseFromPriorProfileCannotUpdateBoard() async {
        let store = MarketStore()
        store.configure(accountID: "account-one", apps: [app(firstAppID)],
                        preferredAppID: firstAppID, preview: false)
        await store.loadOverview { self.liveOverview($0, revision: 1, snapshotId: "snapshot-one") }
        var heldScan: CheckedContinuation<MarketScanDTO, Never>?
        var startCalls = 0

        let scanRequest = Task {
            await store.beginScan { appID, revision, _ in
                startCalls += 1
                return await withCheckedContinuation { heldScan = $0 }
            }
        }
        await Task.yield()
        XCTAssertNotNil(heldScan)
        XCTAssertTrue(store.isStartingScan)

        await store.beginScan { _, _, _ in
            XCTFail("A second scan should be blocked while the first request is pending.")
            return self.scan(id: "wrong", revision: 1)
        }
        XCTAssertEqual(startCalls, 1)

        await store.loadOverview { self.liveOverview($0, revision: 2, snapshotId: "snapshot-two") }
        heldScan?.resume(returning: scan(id: "scan-one", revision: 1))
        await scanRequest.value

        XCTAssertNil(store.overview?.scan)
        XCTAssertFalse(store.isStartingScan)
        XCTAssertEqual(store.overview?.profileRevision, 2)
    }

    func testInFlightScanStatusCannotRestorePreviousApp() async {
        let store = MarketStore()
        store.configure(accountID: "account-one", apps: [app(firstAppID), app(secondAppID)],
                        preferredAppID: firstAppID, preview: false)
        let overviewWithScan = MarketOverview(
            appId: firstAppID, profileRevision: 1, snapshotId: "snapshot-one",
            generatedAt: nil, windowStart: nil, windowEnd: nil,
            coverage: .partial, sources: [], featuredProblemId: nil,
            problems: [], evidence: [], scan: scan(id: "scan-one", revision: 1), isSample: false
        )
        await store.loadOverview { _ in overviewWithScan }
        var heldStatus: CheckedContinuation<MarketScanDTO, Never>?

        let polling = Task {
            await store.pollScan(fetch: { _, _ in
                await withCheckedContinuation { heldStatus = $0 }
            }, refresh: { self.liveOverview($0) })
        }
        await Task.yield()
        XCTAssertNotNil(heldStatus)

        store.selectApp(secondAppID)
        await store.loadOverview { self.liveOverview($0) }
        heldStatus?.resume(returning: scan(id: "scan-one", revision: 1))
        await polling.value

        XCTAssertEqual(store.selectedMarketAppID, secondAppID)
        XCTAssertEqual(store.overview?.appId, secondAppID)
        XCTAssertNil(store.overview?.scan)
    }

    private func app(_ id: String) -> ConnectedApp {
        ConnectedApp(id: id, name: "Connected \(id)", bundleId: "example.\(id)", appleId: "123",
                     source: "apple", iconUrl: nil, createdAt: "2026-09-24T00:00:00Z",
                     webhookUrls: .init(production: "", sandbox: ""),
                     lastProductionEventAt: nil, lastSandboxEventAt: nil,
                     forwardingUrl: nil, bundledIconName: nil)
    }

    private func liveOverview(_ appID: String, revision: Int = 1,
                              snapshotId: String? = "snapshot-one") -> MarketOverview {
        MarketOverview(appId: appID, profileRevision: revision, snapshotId: snapshotId,
                       generatedAt: nil, windowStart: nil, windowEnd: nil,
                       coverage: .partial, sources: [], featuredProblemId: nil,
                       problems: [], evidence: [], scan: nil, isSample: false)
    }

    private func livePeoplePage(_ appID: String, revision: Int = 1, snapshotId: String? = "snapshot-one",
                               people: [MarketPersonDTO] = [], nextCursor: String? = nil) -> MarketPeoplePageDTO {
        MarketPeoplePageDTO(appId: appID, profileRevision: revision, snapshotId: snapshotId,
                            problemId: nil, people: people, nextCursor: nextCursor,
                            coverage: .partial, windowStart: nil, windowEnd: nil)
    }

    private func livePerson(_ id: String) -> MarketPersonDTO {
        MarketPersonDTO(id: id, authorKey: id, authorDisplayName: nil,
                        prospectStatus: .needsReview, prospectReason: "Review this public evidence.",
                        problemIds: [], evidence: [], isSample: false)
    }

    private func scan(id: String, revision: Int) -> MarketScanDTO {
        MarketScanDTO(id: id, status: .queued, profileRevision: revision,
                      requestedAt: nil, startedAt: nil, finishedAt: nil, nextRunAt: nil,
                      retryAfter: nil, reasonCode: nil, canRetry: false)
    }

    private func source(id: String, kind: MarketSourceKind, thread: String, parent: String? = nil,
                        url: String, isSample: Bool = false) -> MarketSourceDTO {
        MarketSourceDTO(id: id, provider: "reddit", kind: kind, threadId: thread,
                        parentId: parent, authorKey: nil, authorDisplayName: nil,
                        title: nil, text: "A valid sample quote.", community: "productivity",
                        url: url, createdAt: nil, fetchedAt: nil, contentHash: "hash",
                        expiresAt: nil, isSample: isSample)
    }
}
