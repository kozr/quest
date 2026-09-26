import SwiftUI
import UIKit

struct MarketPeopleView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var store: MarketStore
    let problem: MarketProblem

    private var taskKey: String {
        "\(store.selectedMarketAppID ?? "")|\(store.overview?.profileRevision ?? 0)|\(store.overview?.snapshotId ?? "no-snapshot")|\(problem.id)|\(store.activeProblemFilterID ?? "all")"
    }

    var body: some View {
        ScrollView {
            MarketPeopleList(store: store, problem: problem,
                             people: store.peoplePage?.people ?? [],
                             isLoading: store.isLoadingPeople,
                             error: store.peopleError,
                             onFilterClear: { store.selectProblemFilter(nil) },
                             onSource: handleSource,
                             onRetry: { Task { await loadPeople() } },
                             onLoadMore: { Task { await loadPeople(more: true) } })
                .padding(.top, 12)
                .padding(.bottom, 24)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            MarketTabBarBackdrop()
        }
        .background(QuestStyle.navy)
        .scrollIndicators(.hidden)
        .refreshable { await refreshMarket() }
        .navigationTitle("People")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbar(.visible, for: .tabBar)
        .task(id: taskKey) {
            await loadPeople()
        }
        .onDisappear { store.cancelPeopleRequests() }
        .alert("Sample source", isPresented: $showingSampleSource) {
            Button("OK", role: .cancel) { }
        } message: {
            Text("This is a sample record for the Market demo. It is not a real Reddit post, and the quote is not linked to a real account.")
        }
        .alert("Source unavailable", isPresented: $showingUnavailableSource) {
            Button("OK", role: .cancel) { }
        } message: {
            Text("This source link could not be verified. Refresh Market to load the current evidence.")
        }
    }

    @State private var showingSampleSource = false
    @State private var showingUnavailableSource = false

    private func loadPeople(more: Bool = false) async {
        await store.loadPeople(fetch: { appID, revision, snapshotId, problemID, page in
            try await model.marketPeople(appID: appID, revision: revision, snapshotId: snapshotId,
                                         problemID: problemID, page: page)
        }, loadingMore: more, refreshOverview: { appID in
            try await model.marketOverview(appID: appID)
        })
    }

    private func refreshMarket() async {
        await store.loadOverview { appID in try await model.marketOverview(appID: appID) }
        store.resumeScanPolling()
        await loadPeople()
    }

    private func handleSource(_ source: MarketSourceDTO) {
        switch MarketPeopleDestination.forSource(source) {
        case .open(let url): UIApplication.shared.open(url)
        case .sampleExplanation: showingSampleSource = true
        case .unavailable: showingUnavailableSource = true
        }
    }
}

struct MarketPeopleList: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ObservedObject var store: MarketStore
    let problem: MarketProblem?
    let people: [MarketPersonDTO]
    let isLoading: Bool
    let error: String?
    let onFilterClear: () -> Void
    let onSource: (MarketSourceDTO) -> Void
    let onRetry: () -> Void
    let onLoadMore: () -> Void

    var body: some View {
        let filteredProblem = problem.flatMap { store.activeProblemFilterID == $0.id ? $0 : nil }
        MarketPaperBoard {
            VStack(alignment: .leading, spacing: 0) {
                Text(filteredProblem?.title ?? "People")
                    .font(QuestTypography.paperTitle)
                    .foregroundStyle(MarketPeopleInk.primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)

                Text(filteredProblem.map { "\($0.peopleCount) people · \($0.conversationCount) conversations" }
                     ?? "\(people.count) people observed")
                    .font(QuestTypography.secondary.weight(.semibold))
                    .foregroundStyle(MarketPeopleInk.secondary)
                    .padding(.top, 6)
                    .padding(.bottom, 12)

                if let filterID = store.activeProblemFilterID,
                   let filterTitle = store.overview?.problems.first(where: { $0.id == filterID })?.title {
                    Button(action: onFilterClear) {
                        HStack(spacing: 7) {
                            Text("Problem · \(filterTitle)")
                                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                                .fixedSize(horizontal: false, vertical: true)
                            Image(systemName: "xmark.circle.fill")
                                .accessibilityHidden(true)
                        }
                        .font(QuestTypography.secondaryAction)
                        .foregroundStyle(MarketPeopleInk.primary)
                        .padding(.horizontal, 11)
                        .frame(minHeight: 44)
                        .background(QuestStyle.gold.opacity(0.28), in: Capsule())
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Filtered by \(filterTitle). Clear filter.")
                    .accessibilityIdentifier("marketPeopleFilter")
                    .padding(.bottom, 12)
                }

                if let error {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("People could not load", systemImage: "exclamationmark.arrow.triangle.2.circlepath")
                            .font(QuestTypography.sectionTitle)
                            .foregroundStyle(MarketPeopleInk.primary)
                        Text(error).font(QuestTypography.body).foregroundStyle(MarketPeopleInk.secondary)
                        Button("Try again", action: onRetry).buttonStyle(MarketPrimaryButtonStyle())
                    }
                    .padding(.vertical, 14)
                } else if isLoading && people.isEmpty {
                    ProgressView("Loading people and evidence…")
                        .tint(MarketPeopleInk.primary)
                        .foregroundStyle(MarketPeopleInk.primary)
                        .frame(maxWidth: .infinity, minHeight: 120, alignment: .center)
                        .accessibilityIdentifier("marketPeopleLoading")
                } else if people.isEmpty {
                    Text("No people with identified author accounts were found in this view.")
                        .font(QuestTypography.body).foregroundStyle(MarketPeopleInk.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.vertical, 16)
                } else {
                    ForEach(Array(people.enumerated()), id: \.element.id) { index, person in
                        if index > 0 {
                            Rectangle().fill(MarketPeopleInk.rule.opacity(0.6)).frame(height: 0.7)
                                .padding(.vertical, 11)
                        }
                        MarketPersonEvidenceCard(person: person, onSource: onSource)
                    }

                    if store.hasNextPeoplePage {
                        Button(action: onLoadMore) {
                            HStack(spacing: 8) {
                                if store.isLoadingMorePeople { ProgressView().tint(QuestStyle.navy) }
                                Text(store.isLoadingMorePeople ? "Loading more…" : "Load more people")
                            }
                        }
                        .buttonStyle(MarketPrimaryButtonStyle())
                        .disabled(store.isLoadingMorePeople)
                        .accessibilityIdentifier("marketPeopleLoadMore")
                        .padding(.top, 15)
                    }
                }

                if let page = store.peoplePage, page.coverage == .partial {
                    Text(store.overview?.research?.peopleCoverage ?? (people.contains(where: { $0.researchProspect != nil }) ? "Partial coverage · public sources may include older conversations" : "Partial coverage · evidence collected from \(page.windowStart.map(MarketDate.label) ?? "the last 30 days")"))
                        .font(QuestTypography.metadata)
                        .foregroundStyle(MarketPeopleInk.secondary)
                        .padding(.top, 13)
                }
            }
            .padding(.horizontal, 38)
            .padding(.top, 28)
            .padding(.bottom, 22)
        }
    }
}

private struct MarketPersonEvidenceCard: View {
    let person: MarketPersonDTO
    let onSource: (MarketSourceDTO) -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var showingDetails = false

    private var author: String {
        guard let prospect = person.researchProspect else {
            return person.authorDisplayName ?? "Community member"
        }
        if prospect.provider == "reddit" {
            return prospect.publicHandle.lowercased().hasPrefix("u/")
                ? prospect.publicHandle : "u/\(prospect.publicHandle)"
        }
        return prospect.displayName
    }

    private var matchSummary: String {
        guard let prospect = person.researchProspect else { return person.prospectReason }
        switch prospect.matchType {
        case "exact": return "Same problem · \(prospect.problem)"
        case "similar": return "Similar problem · \(prospect.problem)"
        default: return prospect.fitReason
        }
    }

    var body: some View {
        let headerLayout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
        VStack(alignment: .leading, spacing: 8) {
            headerLayout {
                Text(author)
                    .font(QuestTypography.editorialTitle)
                    .foregroundStyle(MarketPeopleInk.primary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    if person.isSample {
                        Text("SAMPLE")
                            .font(QuestTypography.overline)
                            .foregroundStyle(MarketPeopleInk.secondary)
                    }
                    if person.researchProspect?.needStatus == "subsequently_resolved" {
                        Text("Resolved")
                            .font(QuestTypography.metadata.weight(.semibold))
                            .foregroundStyle(MarketPeopleInk.primary)
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(QuestStyle.gold.opacity(0.28), in: Capsule())
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityLabel("Reported finding a solution")
                    }
                }
            }

            if let prospect = person.researchProspect, let evidence = prospect.evidence.first {
                quote(evidence.excerpt, isVideo: prospect.provider == "youtube", compact: true)
            } else if let evidence = person.evidence.first {
                quote(evidence.quote, compact: true)
            }

            Text(matchSummary)
                .font(QuestTypography.secondary)
                .foregroundStyle(MarketPeopleInk.secondary)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                .fixedSize(horizontal: false, vertical: true)

            if let prospect = person.researchProspect, let evidence = prospect.evidence.first {
                researchLink(evidence, provider: prospect.provider)
            } else if let evidence = person.evidence.first {
                conversationButton(evidence)
            }

            DisclosureGroup(isExpanded: $showingDetails) {
                VStack(alignment: .leading, spacing: 12) {
                    MarketProspectPill(status: person.prospectStatus)
                    if let prospect = person.researchProspect {
                        Text(prospect.fitReason)
                        Text("\(prospect.platformLabel) · \(prospect.relationshipLabel)")
                            .fontWeight(.semibold)
                        Text(prospect.problem)
                        if let status = prospect.needStatusLabel { Text(status) }
                        if let profileURL = prospect.profileURL {
                            Link(prospect.provider == "youtube" ? "View channel" : "View profile", destination: profileURL)
                                .frame(minHeight: 44, alignment: .leading)
                        }
                        ForEach(Array(prospect.evidence.enumerated()), id: \.offset) { _, evidence in
                            VStack(alignment: .leading, spacing: 7) {
                                quote(evidence.excerpt, isVideo: prospect.provider == "youtube")
                                Text(evidence.verification == "web_search" ? "Found in web search · not independently verified" : evidence.verification == "video_metadata" ? "Video title · channel verified" : "Public post excerpt · author verified")
                                    .font(QuestTypography.metadata)
                                Text(evidence.publishedAt.map(MarketDate.label) ?? "Publication date unavailable")
                                    .font(QuestTypography.metadata)
                                researchLink(evidence, provider: prospect.provider)
                            }
                        }
                        if prospect.provider == "youtube" {
                            Text("Creator topic match; personal need and video transcript have not been verified.")
                                .font(QuestTypography.metadata)
                        }
                    } else {
                        Text(person.prospectReason)
                    }
                    ForEach(person.evidence) { evidence in
                        VStack(alignment: .leading, spacing: 7) {
                            quote(evidence.quote)
                            Text("r/\(evidence.source.community)")
                                .font(QuestTypography.metadata)
                            if let date = evidence.source.createdAt {
                                Text(MarketDate.label(date)).font(QuestTypography.metadata)
                            }
                            conversationButton(evidence, inDetails: true)
                        }
                    }
                }
                .font(QuestTypography.secondary)
                .foregroundStyle(MarketPeopleInk.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 8)
            } label: {
                Text("Details").font(QuestTypography.secondaryAction)
                    .frame(minHeight: 44, alignment: .leading)
            }
            .tint(MarketPeopleInk.fit)
            .accessibilityIdentifier("marketPersonDetails-\(person.id)")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("marketPerson-\(person.id)")
    }

    private func quote(_ text: String, isVideo: Bool = false, compact: Bool = false) -> some View {
        Text(isVideo ? text : "“\(text)”")
            .font(QuestTypography.body).fontDesign(.serif)
            .foregroundStyle(MarketPeopleInk.primary)
            .lineSpacing(2)
            .lineLimit(compact && !dynamicTypeSize.isAccessibilitySize ? 4 : nil)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder
    private func researchLink(_ evidence: MarketResearchProspect.Evidence, provider: String) -> some View {
        if let url = evidence.publicURL {
            Link(provider == "youtube" ? "View video" : "View conversation", destination: url)
                .font(QuestTypography.secondaryAction)
                .foregroundStyle(MarketPeopleInk.fit)
                .frame(minHeight: 44, alignment: .leading)
        }
    }

    private func conversationButton(_ evidence: MarketEvidenceDTO, inDetails: Bool = false) -> some View {
        Button { onSource(evidence.source) } label: {
            Text(evidence.isSample ? "View sample conversation" : "View conversation")
                .font(QuestTypography.secondaryAction)
                .foregroundStyle(MarketPeopleInk.fit)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("marketSource-\(evidence.id)\(inDetails ? "-details" : "")")
    }
}

private struct MarketProspectPill: View {
    let status: MarketProspectStatus

    private var label: String {
        switch status {
        case .potentialFit: return "Possible fit"
        case .needsReview: return "Review"
        case .notAProspect: return "Not a lead"
        }
    }

    var body: some View {
        Text(label)
            .font(QuestTypography.metadata.weight(.semibold))
            .foregroundStyle(MarketPeopleInk.primary)
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(QuestStyle.gold.opacity(0.28), in: Capsule())
            .accessibilityLabel("Prospect status: \(label)")
    }
}

private enum MarketPeopleInk {
    static let primary = Color(red: 0.055, green: 0.145, blue: 0.225)
    static let secondary = Color(red: 0.36, green: 0.42, blue: 0.43)
    static let fit = Color(red: 0.45, green: 0.27, blue: 0.04)
    static let rule = Color(red: 0.70, green: 0.60, blue: 0.37)
}

private enum MarketDate {
    static func label(_ raw: String) -> String {
        guard let date = Timestamp.date(raw) else { return "date unavailable" }
        return date.formatted(.dateTime.month(.abbreviated).day().year())
    }
}
