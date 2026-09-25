import Foundation

enum MarketExamples {
    static let problemTrackingID = "sample-problem-keeping-track-of-missing-figures"
    static let problemSubscriptionsID = "sample-problem-subscription-frustration"
    static let problemSeriesID = "sample-problem-missing-series"
    static let app = ConnectedApp(
        id: "sample-blind-box-tracker",
        name: "Blind Box Tracker",
        bundleId: "example.questline.blindboxtracker",
        appleId: "0",
        source: "sample",
        iconUrl: nil,
        createdAt: "2026-09-01T12:00:00Z",
        webhookUrls: .init(production: "", sandbox: ""),
        lastProductionEventAt: nil,
        lastSandboxEventAt: nil,
        forwardingUrl: nil,
        bundledIconName: "BlindBoxTrackerMarketIcon"
    )

    static func overview(now: Date = Date()) -> MarketOverview {
        let trackingEvidence = trackingEvidence(now: now)
        let subscriptionEvidence = subscriptionEvidence(now: now)
        let missingSeriesEvidence = missingSeriesEvidence(now: now)
        let problems = [
            MarketProblem(id: problemTrackingID, title: "Keeping track of missing figures",
                          summary: "Collectors use Notes and spreadsheets to remember what they own.",
                          signalKind: .recurringProblem, peopleCount: 7, conversationCount: 4,
                          observationCount: trackingEvidence.count,
                          representativeEvidenceId: trackingEvidence.first?.id,
                          lastObservedAt: trackingEvidence.first?.source.createdAt),
            MarketProblem(id: problemSubscriptionsID, title: "Subscription frustration",
                          summary: "Collectors want a clear way to manage recurring charges.",
                          signalKind: .competitorComplaint, peopleCount: 4, conversationCount: 2,
                          observationCount: subscriptionEvidence.count,
                          representativeEvidenceId: subscriptionEvidence.first?.id,
                          lastObservedAt: subscriptionEvidence.first?.source.createdAt),
            MarketProblem(id: problemSeriesID, title: "Missing series",
                          summary: "Collectors have trouble finding complete series checklists.",
                          signalKind: .workaround, peopleCount: 3, conversationCount: 2,
                          observationCount: missingSeriesEvidence.count,
                          representativeEvidenceId: missingSeriesEvidence.first?.id,
                          lastObservedAt: missingSeriesEvidence.first?.source.createdAt)
        ]
        return MarketOverview(
            appId: app.id, profileRevision: 1,
            snapshotId: nil,
            generatedAt: ISO8601DateFormatter().string(from: now),
            windowStart: ISO8601DateFormatter().string(from: now.addingTimeInterval(-30 * 86_400)),
            windowEnd: ISO8601DateFormatter().string(from: now),
            coverage: .partial,
            sources: [.init(provider: "reddit", collectedCount: 14)],
            featuredProblemId: problemTrackingID,
            problems: problems,
            evidence: trackingEvidence + subscriptionEvidence + missingSeriesEvidence,
            scan: nil,
            isSample: true
        )
    }

    static func people(for overview: MarketOverview, problemID: String? = nil) -> MarketPeoplePageDTO {
        let examples: [(String, String, MarketProspectStatus, String, String, Int)] = [
            (problemTrackingID, "I couldn’t find a better way to catalogue my collection.", .needsReview,
             "Sample evidence only; review the source before drawing a conclusion.", "SonnyAngel", 0),
            (problemTrackingID, "I still keep a note so I can remember which figures I own.", .potentialFit,
             "The sample describes an unresolved tracking need.", "SonnyAngel", 1),
            (problemTrackingID, "My checklist lives in a spreadsheet I update by hand.", .potentialFit,
             "The sample describes an unresolved tracking need.", "SonnyAngel", 2),
            (problemTrackingID, "I have to search old photos to check what is missing.", .needsReview,
             "Sample evidence only; review the source before drawing a conclusion.", "SonnyAngel", 3),
            (problemTrackingID, "I use Notes to remember the series I already opened.", .potentialFit,
             "The sample describes an unresolved tracking need.", "SonnyAngel", 4),
            (problemTrackingID, "Tracking duplicates and missing ones takes a lot of notes.", .needsReview,
             "Sample evidence only; review the source before drawing a conclusion.", "SonnyAngel", 5),
            (problemTrackingID, "I made a small list to keep track of my collection.", .potentialFit,
             "The sample describes an unresolved tracking need.", "SonnyAngel", 6),
            (problemSubscriptionsID, "I wish the recurring plan was easier to manage.", .notAProspect,
             "Sample complaint; this does not establish buying intent.", "blindbox", 7),
            (problemSubscriptionsID, "The subscription settings are hard to find.", .needsReview,
             "Sample evidence only; review the source before drawing a conclusion.", "blindbox", 8),
            (problemSubscriptionsID, "I cancelled because I only needed one collection.", .notAProspect,
             "This sample describes a resolved request.", "blindbox", 9),
            (problemSubscriptionsID, "The monthly charge was a surprise.", .needsReview,
             "Sample evidence only; review the source before drawing a conclusion.", "blindbox", 10),
            (problemSeriesID, "I can never find a complete list of each series.", .potentialFit,
             "The sample describes an unresolved tracking need.", "SonnyAngel", 11),
            (problemSeriesID, "I save screenshots because the checklist is incomplete.", .needsReview,
             "Sample evidence only; review the source before drawing a conclusion.", "SonnyAngel", 12),
            (problemSeriesID, "I made my own checklist after missing a figure.", .potentialFit,
             "The sample describes an unresolved tracking need.", "SonnyAngel", 13)
        ]

        let all = examples.enumerated().compactMap { index, item -> MarketPersonDTO? in
            guard problemID == nil || problemID == item.0,
                  let evidence = overview.evidence.first(where: { $0.id == "sample-evidence-\(item.5)" }) else { return nil }
            return MarketPersonDTO(
                id: "sample-person-\(item.5)", authorKey: nil,
                authorDisplayName: "Sample person \(index + 1)",
                prospectStatus: item.2, prospectReason: item.3,
                problemIds: [item.0], evidence: [evidence], isSample: true
            )
        }
        return MarketPeoplePageDTO(appId: overview.appId, profileRevision: overview.profileRevision,
                                   snapshotId: overview.snapshotId,
                                   problemId: problemID, people: all, nextCursor: nil,
                                   coverage: overview.coverage, windowStart: overview.windowStart,
                                   windowEnd: overview.windowEnd)
    }

    private static func trackingEvidence(now: Date) -> [MarketEvidenceDTO] {
        let quotes = [
            "I couldn’t find a better way to catalogue my collection.",
            "I still keep a note so I can remember which figures I own.",
            "My checklist lives in a spreadsheet I update by hand.",
            "I have to search old photos to check what is missing.",
            "I use Notes to remember the series I already opened.",
            "Tracking duplicates and missing ones takes a lot of notes.",
            "I made a small list to keep track of my collection."
        ]
        return quotes.enumerated().map { index, quote in
            let conversationIndex = index < 2 ? 0 : (index < 4 ? 1 : (index < 6 ? 2 : 3))
            return evidence(index: index, problemID: problemTrackingID, kind: .recurringProblem,
                            quote: quote, explanation: "Collectors use Notes and spreadsheets to remember what they own.",
                            status: [0, 3, 5].contains(index) ? .needsReview : .potentialFit,
                            community: "SonnyAngel", thread: "sample-thread-tracking-\(conversationIndex)",
                            now: now, age: Double(index * 1_800))
        }
    }

    private static func subscriptionEvidence(now: Date) -> [MarketEvidenceDTO] {
        let quotes = [
            "I wish the recurring plan was easier to manage.",
            "The subscription settings are hard to find.",
            "I cancelled because I only needed one collection.",
            "The monthly charge was a surprise."
        ]
        return quotes.enumerated().map { index, quote in
            evidence(index: index + 7, problemID: problemSubscriptionsID, kind: .competitorComplaint,
                     quote: quote, explanation: "Collectors describe friction with recurring plans.",
                     status: index == 0 || index == 2 ? .notAProspect : .needsReview,
                     community: "blindbox", thread: "sample-thread-subscription-\(index < 2 ? 0 : 1)",
                     now: now, age: Double((index + 7) * 1_800))
        }
    }

    private static func missingSeriesEvidence(now: Date) -> [MarketEvidenceDTO] {
        let quotes = [
            "I can never find a complete list of each series.",
            "I save screenshots because the checklist is incomplete.",
            "I made my own checklist after missing a figure."
        ]
        return quotes.enumerated().map { index, quote in
            evidence(index: index + 11, problemID: problemSeriesID, kind: .workaround,
                     quote: quote, explanation: "Collectors create their own series checklists.",
                     status: index == 1 ? .needsReview : .potentialFit,
                     community: "SonnyAngel", thread: "sample-thread-series-\(index < 2 ? 0 : 1)",
                     now: now, age: Double((index + 11) * 1_800))
        }
    }

    private static func evidence(index: Int, problemID: String, kind: MarketSignalKind,
                                 quote: String, explanation: String, status: MarketProspectStatus,
                                 community: String, thread: String, now: Date, age: TimeInterval) -> MarketEvidenceDTO {
        let date = ISO8601DateFormatter().string(from: now.addingTimeInterval(-age))
        let source = MarketSourceDTO(
            id: "sample-source-\(index)", provider: "reddit", kind: .post,
            threadId: thread, parentId: nil, authorKey: nil, authorDisplayName: nil,
            title: nil, text: quote, community: community, url: nil,
            createdAt: date, fetchedAt: ISO8601DateFormatter().string(from: now),
            contentHash: "sample-content-hash-\(index)",
            expiresAt: ISO8601DateFormatter().string(from: now.addingTimeInterval(30 * 86_400)),
            isSample: true
        )
        return MarketEvidenceDTO(
            id: "sample-evidence-\(index)", problemId: problemID, signalKind: kind,
            quote: quote, explanation: explanation,
            prospectStatus: status,
            prospectReason: status == .potentialFit ? "Possible unresolved need; sample record." : "Sample record for review.",
            matchedCapabilityIds: [], competitorName: nil, sourceContentHash: source.contentHash,
            source: source, isSample: true
        )
    }
}
