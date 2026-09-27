import Foundation
import SwiftUI

@MainActor
final class MarketStore: ObservableObject {
    @Published private(set) var apps: [ConnectedApp] = []
    @Published private(set) var selectedMarketAppID: String?
    @Published var selectedSegment: MarketSegment = .problems
    @Published private(set) var overview: MarketOverview?
    @Published private(set) var peoplePage: MarketPeoplePageDTO?
    @Published private(set) var isLoadingOverview = false
    @Published private(set) var isLoadingPeople = false
    @Published private(set) var isLoadingMorePeople = false
    @Published private(set) var isStartingScan = false
    @Published private(set) var scanPollingEpoch = 0
    @Published private(set) var errorMessage: String?
    @Published private(set) var loadErrorCode: String?
    @Published private(set) var peopleError: String?
    @Published private(set) var scanError: String?
    @Published private(set) var activeProblemFilterID: String?

    private var accountID: String?
    private var profileRevision: Int?
    private var isPreviewMode = false
    private var overviewRequestID = UUID()
    private var peopleRequestID = UUID()
    private var scanRequestID = UUID()
    private var loadedPeopleCursor: String?

    var selectedApp: ConnectedApp? { apps.first { $0.id == selectedMarketAppID } }
    var isSample: Bool { overview?.isSample == true }
    var hasNextPeoplePage: Bool { peoplePage?.nextCursor != nil }

    func configure(accountID: String?, apps availableApps: [ConnectedApp], preferredAppID: String?, preview: Bool) {
        let nextApps = preview ? [MarketExamples.app] : availableApps
        let nextIdentity = accountID ?? (preview ? "sample-preview" : nil)
        let identityChanged = self.accountID != nextIdentity || self.isPreviewMode != preview
        let nextSelectedID: String?
        if let selectedMarketAppID, nextApps.contains(where: { $0.id == selectedMarketAppID }) {
            nextSelectedID = selectedMarketAppID
        } else if let preferredAppID, nextApps.contains(where: { $0.id == preferredAppID }) {
            nextSelectedID = preferredAppID
        } else {
            nextSelectedID = nextApps.first?.id
        }
        let appChanged = nextSelectedID != selectedMarketAppID

        if identityChanged {
            resetVisibleData()
            overviewRequestID = UUID()
            peopleRequestID = UUID()
            scanRequestID = UUID()
        } else if appChanged {
            resetVisibleData()
            overviewRequestID = UUID()
            peopleRequestID = UUID()
            scanRequestID = UUID()
        }
        self.accountID = nextIdentity
        self.isPreviewMode = preview
        self.apps = nextApps
        self.selectedMarketAppID = nextSelectedID
    }

    func selectApp(_ appID: String) {
        guard apps.contains(where: { $0.id == appID }), appID != selectedMarketAppID else { return }
        selectedMarketAppID = appID
        clearAppData()
        overviewRequestID = UUID()
        peopleRequestID = UUID()
        scanRequestID = UUID()
    }

    func selectSegment(_ segment: MarketSegment) {
        guard selectedSegment != segment else { return }
        if selectedSegment == .people {
            peopleRequestID = UUID()
            isLoadingPeople = false
            isLoadingMorePeople = false
        }
        selectedSegment = segment
    }

    func cancelPeopleRequests() {
        peopleRequestID = UUID()
        isLoadingPeople = false
        isLoadingMorePeople = false
    }

    func resumeScanPolling() {
        scanPollingEpoch += 1
        scanError = nil
    }

    func selectProblemFilter(_ problemID: String?) {
        guard activeProblemFilterID != problemID else { return }
        activeProblemFilterID = problemID
        peoplePage = nil
        loadedPeopleCursor = nil
        peopleError = nil
        peopleRequestID = UUID()
    }

    func loadOverview(fetch: (String) async throws -> MarketOverview) async {
        guard !Task.isCancelled else { return }
        guard let appID = selectedMarketAppID else {
            overview = nil
            return
        }
        let requestID = UUID()
        overviewRequestID = requestID
        let account = accountID
        let preview = isPreviewMode
        errorMessage = nil
        loadErrorCode = nil
        if !preview && overview?.appId != appID { overview = nil }
        isLoadingOverview = true
        defer { if overviewRequestID == requestID { isLoadingOverview = false } }
        do {
            let result = preview ? MarketExamples.overview() : try await fetch(appID)
            guard !Task.isCancelled, overviewRequestID == requestID, accountID == account,
                  selectedMarketAppID == appID, isPreviewMode == preview else { return }
            guard result.appId == appID,
                  result.isSample == preview,
                  preview || result.evidence.allSatisfy({ !$0.isSample && !$0.source.isSample }),
                  result.problems.allSatisfy({
                      $0.peopleCount >= 0 && $0.conversationCount >= 0 && $0.observationCount >= 0 &&
                      $0.peopleCount <= $0.observationCount && $0.conversationCount <= $0.observationCount
                  }) else { throw ClientError.invalidResponse }
            let revisionChanged = profileRevision != result.profileRevision
            let snapshotChanged = overview?.snapshotId != result.snapshotId
            if revisionChanged || snapshotChanged {
                peoplePage = nil
                loadedPeopleCursor = nil
                peopleRequestID = UUID()
                isLoadingPeople = false
                isLoadingMorePeople = false
            }
            if revisionChanged {
                scanRequestID = UUID()
                isStartingScan = false
            }
            overview = result
            profileRevision = result.profileRevision
            errorMessage = nil
            loadErrorCode = nil
            if activeProblemFilterID != nil,
               !result.problems.contains(where: { $0.id == activeProblemFilterID }) {
                activeProblemFilterID = nil
            }
        } catch {
            guard !Task.isCancelled, !(error is CancellationError),
                  (error as? URLError)?.code != .cancelled else { return }
            guard !Task.isCancelled, overviewRequestID == requestID, accountID == account,
                  selectedMarketAppID == appID, isPreviewMode == preview else { return }
            let clientError = error as? ClientError
            loadErrorCode = clientError?.isNotFound == true
                ? "FEATURE_UNAVAILABLE"
                : clientError?.serverCode
            if overview?.appId != appID { overview = nil }
            errorMessage = error.localizedDescription
        }
    }

    func loadPeople(fetch: (String, Int, String?, String?, MarketPaginationRequest) async throws -> MarketPeoplePageDTO,
                    loadingMore: Bool = false,
                    refreshOverview: ((String) async throws -> MarketOverview)? = nil) async {
        guard let appID = selectedMarketAppID, let profileRevision, let overview else { return }
        if loadingMore, isLoadingMorePeople { return }
        let requestID = UUID()
        peopleRequestID = requestID
        let account = accountID
        let filterID = activeProblemFilterID
        let preview = isPreviewMode
        let snapshotId = overview.snapshotId
        let cursor = loadingMore ? peoplePage?.nextCursor : nil
        if loadingMore, cursor == nil { return }
        peopleError = nil
        if loadingMore { isLoadingMorePeople = true } else { isLoadingPeople = true }
        defer {
            if peopleRequestID == requestID {
                isLoadingPeople = false
                isLoadingMorePeople = false
            }
        }
        do {
            let result: MarketPeoplePageDTO
            if preview {
                let current = overview
                result = MarketExamples.people(for: current, problemID: filterID)
            } else {
                result = try await fetch(appID, profileRevision, snapshotId, filterID,
                                         MarketPaginationRequest(cursor: cursor, limit: 20))
            }
            guard peopleRequestID == requestID, accountID == account,
                  selectedMarketAppID == appID, activeProblemFilterID == filterID,
                  self.profileRevision == profileRevision, self.overview?.snapshotId == snapshotId,
                  isPreviewMode == preview else { return }
            guard result.appId == appID, result.profileRevision == profileRevision,
                  result.snapshotId == snapshotId, result.problemId == filterID,
                  preview || result.people.allSatisfy({
                      !$0.isSample && $0.evidence.allSatisfy({ !$0.isSample && !$0.source.isSample })
                  }) else { throw ClientError.invalidResponse }
            if loadingMore, let previous = peoplePage {
                var seen = Set(previous.people.map(\.id))
                peoplePage = MarketPeoplePageDTO(
                    appId: result.appId, profileRevision: result.profileRevision,
                    snapshotId: result.snapshotId,
                    problemId: result.problemId,
                    people: previous.people + result.people.filter { seen.insert($0.id).inserted },
                    nextCursor: result.nextCursor, coverage: result.coverage,
                    windowStart: result.windowStart, windowEnd: result.windowEnd
                )
            } else {
                peoplePage = result
            }
            loadedPeopleCursor = result.nextCursor
        } catch {
            guard !Task.isCancelled, !(error is CancellationError),
                  (error as? URLError)?.code != .cancelled else { return }
            guard peopleRequestID == requestID, accountID == account,
                  selectedMarketAppID == appID, activeProblemFilterID == filterID,
                  self.profileRevision == profileRevision, self.overview?.snapshotId == snapshotId,
                  isPreviewMode == preview else { return }
            let serverCode = (error as? ClientError)?.serverCode
            if serverCode == "STALE_PROFILE" || serverCode == "STALE_SNAPSHOT" {
                peoplePage = nil
                loadedPeopleCursor = nil
                peopleError = nil
                if let refreshOverview {
                    await loadOverview(fetch: refreshOverview)
                } else {
                    peopleError = "The app profile changed. Refresh Market to load current evidence."
                }
                return
            }
            peopleError = error.localizedDescription
        }
    }

    func beginScan(start: (String, Int, String) async throws -> MarketScanDTO) async {
        guard let appID = selectedMarketAppID, let profileRevision,
              !isPreviewMode, !isStartingScan, overview?.scan?.status.isActive != true else { return }
        let requestID = UUID()
        scanRequestID = requestID
        let account = accountID
        isStartingScan = true
        scanError = nil
        defer { if scanRequestID == requestID { isStartingScan = false } }
        do {
            let scan = try await start(appID, profileRevision, UUID().uuidString)
            guard scanRequestID == requestID, accountID == account,
                  selectedMarketAppID == appID, self.profileRevision == profileRevision,
                  scan.profileRevision == profileRevision else { return }
            isStartingScan = false
            if let overview {
                self.overview = overview.replacingScan(scan)
            }
        } catch {
            guard scanRequestID == requestID, accountID == account,
                  selectedMarketAppID == appID, self.profileRevision == profileRevision else { return }
            scanError = error.localizedDescription
        }
    }

    func pollScan(fetch: (String, String) async throws -> MarketScanDTO,
                  refresh: (String) async throws -> MarketOverview,
                  maximumDuration: TimeInterval = 180) async {
        guard !isPreviewMode, let appID = selectedMarketAppID,
              let revision = profileRevision, let scan = overview?.scan,
              scan.status.isActive else { return }

        let requestID = UUID()
        scanRequestID = requestID
        let account = accountID
        let deadline = Date().addingTimeInterval(maximumDuration)
        scanError = nil

        while !Task.isCancelled, Date() < deadline {
            guard scanRequestID == requestID, accountID == account,
                  selectedMarketAppID == appID, profileRevision == revision else { return }
            do {
                let latest = try await fetch(appID, scan.id)
                guard scanRequestID == requestID, accountID == account,
                      selectedMarketAppID == appID, profileRevision == revision else { return }
                guard latest.id == scan.id, latest.profileRevision == revision else {
                    throw ClientError.invalidResponse
                }
                scanError = nil
                if let overview { self.overview = overview.replacingScan(latest) }
                guard !latest.status.isActive else {
                    let delay = pollingDelay(for: latest)
                    try await Task.sleep(for: .seconds(delay))
                    continue
                }
                await loadOverview(fetch: refresh)
                return
            } catch {
                guard !Task.isCancelled, !(error is CancellationError),
                      (error as? URLError)?.code != .cancelled else { return }
                guard scanRequestID == requestID, accountID == account,
                      selectedMarketAppID == appID, profileRevision == revision else { return }
                scanError = error.localizedDescription
                return
            }
        }

        if scanRequestID == requestID, accountID == account,
           selectedMarketAppID == appID, profileRevision == revision, !Task.isCancelled {
            scanError = "This scan is still running. Refresh the board to check its status."
        }
    }

    private func resetVisibleData() {
        clearAppData()
        profileRevision = nil
    }

    private func clearAppData() {
        overview = nil
        peoplePage = nil
        profileRevision = nil
        activeProblemFilterID = nil
        errorMessage = nil
        loadErrorCode = nil
        peopleError = nil
        scanError = nil
        isLoadingOverview = false
        isLoadingPeople = false
        isLoadingMorePeople = false
        isStartingScan = false
        loadedPeopleCursor = nil
    }

    private func pollingDelay(for scan: MarketScanDTO) -> TimeInterval {
        for timestamp in [scan.retryAfter, scan.nextRunAt].compactMap({ $0 }) {
            if let date = Timestamp.date(timestamp) {
                return min(max(date.timeIntervalSinceNow, 2), 15)
            }
            if let seconds = TimeInterval(timestamp), seconds.isFinite, seconds > 0 {
                return min(max(seconds, 2), 15)
            }
        }
        return 3
    }
}

private extension MarketOverview {
    func replacingScan(_ scan: MarketScanDTO) -> MarketOverview {
        MarketOverview(
            appId: appId, profileRevision: profileRevision, snapshotId: snapshotId,
            generatedAt: generatedAt, windowStart: windowStart, windowEnd: windowEnd,
            coverage: coverage, sources: sources, featuredProblemId: featuredProblemId,
            problems: problems, evidence: evidence, scan: scan, isSample: isSample, research: research
        )
    }
}
