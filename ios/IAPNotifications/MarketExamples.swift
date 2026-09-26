import Foundation

enum MarketExamples {
    // Fictional demo summaries only; never used as a fallback for live research.
    // These names and statements are fictional; they are not real users or testimonials.
    private static let peopleNames = ["Alex Chen", "Sam Rivera", "Jordan Lee", "Taylor Brooks", "Morgan Ellis", "Casey Park", "Riley Evans", "Jamie Patel", "Avery Kim", "Drew Carter", "Robin Lane", "Cameron Reed", "Quinn Hayes", "Blair Morgan"]
    static let landscape: [MarketResearch.Finding] = [
        .init(title: "Focus timer apps", summary: "Sample landscape: focus timers offer work intervals and breaks. Compare setup effort, flexibility, and how easily someone can begin a session.", sources: []),
        .init(title: "Phone timers and planners", summary: "Sample landscape: students combine phone timers with paper planners. This works, but planning breaks and restarting each session takes extra effort.", sources: [])
    ]
    static let problemTrackingID = "sample-problem-starting-study"
    static let problemSubscriptionsID = "sample-problem-timer-setup"
    static let problemSeriesID = "sample-problem-planning-breaks"
    static let app = ConnectedApp(
        id: "sample-pocket-focus",
        name: "Pocket Focus",
        bundleId: "com.example.focus",
        appleId: "0",
        source: "sample",
        iconUrl: nil,
        createdAt: "2026-09-01T12:00:00Z",
        webhookUrls: .init(production: "", sandbox: ""),
        lastProductionEventAt: nil,
        lastSandboxEventAt: nil,
        forwardingUrl: nil,
        bundledIconName: "DemoFocusIcon"
    )

    static func overview(now: Date = Date()) -> MarketOverview {
        let trackingEvidence = trackingEvidence(now: now)
        let subscriptionEvidence = subscriptionEvidence(now: now)
        let missingSeriesEvidence = missingSeriesEvidence(now: now)
        let problems = [
            MarketProblem(id: problemTrackingID, title: "Getting started is the hard part",
                          summary: "Students want a simple way to start a focused study session.",
                          signalKind: .recurringProblem, peopleCount: 7, conversationCount: 4,
                          observationCount: trackingEvidence.count,
                          representativeEvidenceId: trackingEvidence.first?.id,
                          lastObservedAt: trackingEvidence.first?.source.createdAt),
            MarketProblem(id: problemSubscriptionsID, title: "Too much timer setup",
                          summary: "Complicated timer settings get in the way of beginning work.",
                          signalKind: .competitorComplaint, peopleCount: 4, conversationCount: 2,
                          observationCount: subscriptionEvidence.count,
                          representativeEvidenceId: subscriptionEvidence.first?.id,
                          lastObservedAt: subscriptionEvidence.first?.source.createdAt),
            MarketProblem(id: problemSeriesID, title: "Planning breaks by hand",
                          summary: "Students combine alarms and notes to plan work and breaks.",
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
            (problemTrackingID, "I sit down to study, then spend twenty minutes putting off the first task.", .needsReview,
             "Sample evidence only; review the source before drawing a conclusion.", "study", 0),
            (problemTrackingID, "Is there a simple timer that helps me start studying and reminds me to take a break?", .potentialFit,
             "The sample describes an unresolved need relevant to Pocket Focus.", "study", 1),
            (problemTrackingID, "I write study blocks in my planner, then set a separate alarm for each one.", .potentialFit,
             "The sample describes an unresolved need relevant to Pocket Focus.", "study", 2),
            (problemTrackingID, "I keep planning long study sessions instead of starting a small task.", .needsReview,
             "Sample evidence only; review the source before drawing a conclusion.", "study", 3),
            (problemTrackingID, "I want one button to start a short focus session.", .potentialFit,
             "The sample describes an unresolved need relevant to Pocket Focus.", "study", 4),
            (problemTrackingID, "It takes me ages to get started, even when I know what to study.", .needsReview,
             "Sample evidence only; review the source before drawing a conclusion.", "study", 5),
            (problemTrackingID, "I need a timer that makes work and break times easy to follow.", .potentialFit,
             "The sample describes an unresolved need relevant to Pocket Focus.", "study", 6),
            (problemSubscriptionsID, "I tried a focus timer, but there were too many settings to configure.", .notAProspect,
             "Sample complaint; this does not establish buying intent.", "productivity", 7),
            (problemSubscriptionsID, "My timer makes me build a whole routine before I can start.", .needsReview,
             "Sample evidence only; review the source before drawing a conclusion.", "productivity", 8),
            (problemSubscriptionsID, "I stopped using timer apps after finding a paper routine that works for me.", .notAProspect,
             "This sample describes a resolved request.", "productivity", 9),
            (problemSubscriptionsID, "I wish I could change the work interval without digging through menus.", .needsReview,
             "Sample evidence only; review the source before drawing a conclusion.", "productivity", 10),
            (problemSeriesID, "I set phone alarms for breaks, but keep forgetting to restart the timer.", .potentialFit,
             "The sample describes an unresolved need relevant to Pocket Focus.", "study", 11),
            (problemSeriesID, "I use a planner for study blocks and a separate timer for breaks.", .needsReview,
             "Sample evidence only; review the source before drawing a conclusion.", "study", 12),
            (problemSeriesID, "I made a checklist to remind myself when to work and when to take a break.", .potentialFit,
             "The sample describes an unresolved need relevant to Pocket Focus.", "study", 13)
        ]

        let all = examples.enumerated().compactMap { index, item -> MarketPersonDTO? in
            guard problemID == nil || problemID == item.0,
                  let evidence = overview.evidence.first(where: { $0.id == "sample-evidence-\(item.5)" }) else { return nil }
            return MarketPersonDTO(
                id: "sample-person-\(item.5)", authorKey: nil,
                authorDisplayName: peopleNames[index],
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
            "I sit down to study, then spend twenty minutes putting off the first task.",
            "Is there a simple timer that helps me start studying and reminds me to take a break?",
            "I write study blocks in my planner, then set a separate alarm for each one.",
            "I keep planning long study sessions instead of starting a small task.",
            "I want one button to start a short focus session.",
            "It takes me ages to get started, even when I know what to study.",
            "I need a timer that makes work and break times easy to follow."
        ]
        return quotes.enumerated().map { index, quote in
            let conversationIndex = index < 2 ? 0 : (index < 4 ? 1 : (index < 6 ? 2 : 3))
            return evidence(index: index, problemID: problemTrackingID, kind: .recurringProblem,
                            quote: quote, explanation: "Students want a simple way to start a focused study session.",
                            status: [0, 3, 5].contains(index) ? .needsReview : .potentialFit,
                            community: "study", thread: "sample-thread-tracking-\(conversationIndex)",
                            now: now, age: Double(index * 1_800))
        }
    }

    private static func subscriptionEvidence(now: Date) -> [MarketEvidenceDTO] {
        let quotes = [
            "I tried a focus timer, but there were too many settings to configure.",
            "My timer makes me build a whole routine before I can start.",
            "I stopped using timer apps after finding a paper routine that works for me.",
            "I wish I could change the work interval without digging through menus."
        ]
        return quotes.enumerated().map { index, quote in
            evidence(index: index + 7, problemID: problemSubscriptionsID, kind: .competitorComplaint,
                     quote: quote, explanation: "Students describe friction with complicated focus timers.",
                     status: index == 0 || index == 2 ? .notAProspect : .needsReview,
                     community: "productivity", thread: "sample-thread-subscription-\(index < 2 ? 0 : 1)",
                     now: now, age: Double((index + 7) * 1_800))
        }
    }

    private static func missingSeriesEvidence(now: Date) -> [MarketEvidenceDTO] {
        let quotes = [
            "I set phone alarms for breaks, but keep forgetting to restart the timer.",
            "I use a planner for study blocks and a separate timer for breaks.",
            "I made a checklist to remind myself when to work and when to take a break."
        ]
        return quotes.enumerated().map { index, quote in
            evidence(index: index + 11, problemID: problemSeriesID, kind: .workaround,
                     quote: quote, explanation: "Students plan work sessions and breaks manually.",
                     status: index == 1 ? .needsReview : .potentialFit,
                     community: "study", thread: "sample-thread-series-\(index < 2 ? 0 : 1)",
                     now: now, age: Double((index + 11) * 1_800))
        }
    }

    private static func evidence(index: Int, problemID: String, kind: MarketSignalKind,
                                 quote: String, explanation: String, status: MarketProspectStatus,
                                 community: String, thread: String, now: Date, age: TimeInterval) -> MarketEvidenceDTO {
        let date = ISO8601DateFormatter().string(from: now.addingTimeInterval(-age))
        let source = MarketSourceDTO(
            id: "sample-source-\(index)", provider: "reddit", kind: .post,
            threadId: thread, parentId: nil, authorKey: nil, authorDisplayName: peopleNames[index],
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
