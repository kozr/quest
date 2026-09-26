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
    @ObservedObject var store: MarketStore
    let problem: MarketProblem?
    let people: [MarketPersonDTO]
    let isLoading: Bool
    let error: String?
    let onFilterClear: () -> Void
    let onSource: (MarketSourceDTO) -> Void
    let onRetry: () -> Void
    let onLoadMore: () -> Void

    @ScaledMetric(relativeTo: .title3) private var titleSize: CGFloat = 23
    @ScaledMetric(relativeTo: .body) private var bodySize: CGFloat = 15

    var body: some View {
        let filteredProblem = problem.flatMap { store.activeProblemFilterID == $0.id ? $0 : nil }
        MarketPaperBoard {
            VStack(alignment: .leading, spacing: 0) {
                Text(filteredProblem?.title ?? "People")
                    .font(.system(size: titleSize, weight: .bold, design: .serif))
                    .foregroundStyle(MarketPeopleInk.primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)

                Text(filteredProblem.map { "\($0.peopleCount) people · \($0.conversationCount) conversations" }
                     ?? "\(people.count) people observed")
                    .font(.system(size: bodySize, weight: .semibold))
                    .foregroundStyle(MarketPeopleInk.secondary)
                    .padding(.top, 6)
                    .padding(.bottom, 12)

                if let filterID = store.activeProblemFilterID,
                   let filterTitle = store.overview?.problems.first(where: { $0.id == filterID })?.title {
                    Button(action: onFilterClear) {
                        HStack(spacing: 7) {
                            Text("Problem · \(filterTitle)")
                                .lineLimit(2)
                            Image(systemName: "xmark.circle.fill")
                                .accessibilityHidden(true)
                        }
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(MarketPeopleInk.primary)
                        .padding(.horizontal, 11)
                        .frame(minHeight: 36)
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
                            .font(.system(.title3, design: .serif).weight(.bold))
                            .foregroundStyle(MarketPeopleInk.primary)
                        Text(error).font(.body).foregroundStyle(MarketPeopleInk.secondary)
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
                        .font(.body).foregroundStyle(MarketPeopleInk.secondary)
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
                        .font(.system(size: 11, weight: .medium))
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
    @ScaledMetric(relativeTo: .body) private var quoteSize: CGFloat = 15

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(person.authorDisplayName ?? "Community member")
                    .font(.system(.headline, design: .serif).weight(.bold))
                    .foregroundStyle(MarketPeopleInk.primary)
                    .lineLimit(2)
                if person.isSample {
                    Text("SAMPLE")
                        .font(.system(size: 9, weight: .bold))
                        .tracking(1)
                        .foregroundStyle(MarketPeopleInk.secondary)
                        .padding(.horizontal, 6).padding(.vertical, 3)
                        .background(QuestStyle.gold.opacity(0.23), in: Capsule())
                }
                Spacer(minLength: 0)
                MarketProspectPill(status: person.prospectStatus)
            }

            Text(person.prospectReason)
                .font(.footnote)
                .foregroundStyle(MarketPeopleInk.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if let prospect = person.researchProspect {
                Text("\(prospect.platformLabel) · \(prospect.relationshipLabel)")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(MarketPeopleInk.primary)
                Text(prospect.problem)
                    .font(.footnote)
                    .foregroundStyle(MarketPeopleInk.secondary)
                if let status = prospect.needStatusLabel {
                    Text(status).font(.caption).foregroundStyle(MarketPeopleInk.secondary)
                }
                if let profileURL = prospect.profileURL {
                    Link("View \(prospect.provider == "youtube" ? "channel" : "profile") · \(prospect.publicHandle)", destination: profileURL)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(MarketPeopleInk.fit)
                        .frame(minHeight: 44, alignment: .leading)
                }
                ForEach(Array(prospect.evidence.enumerated()), id: \.offset) { _, evidence in
                    VStack(alignment: .leading, spacing: 7) {
                        Text(evidence.verification == "web_search" ? "Found in web search · not independently verified" : evidence.verification == "video_metadata" ? "Video title · channel verified" : "Public post excerpt · author verified")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(MarketPeopleInk.secondary)
                        Text(evidence.excerpt)
                            .font(.system(size: quoteSize, design: .serif))
                            .foregroundStyle(MarketPeopleInk.primary)
                            .fixedSize(horizontal: false, vertical: true)
                        if let date = evidence.publishedAt {
                            Text(MarketDate.label(date)).font(.caption).foregroundStyle(MarketPeopleInk.secondary)
                        } else {
                            Text("Publication date unavailable").font(.caption).foregroundStyle(MarketPeopleInk.secondary)
                        }
                        if let sourceURL = evidence.publicURL {
                            Link(prospect.provider == "youtube" ? "Watch original video" : "Open original conversation", destination: sourceURL)
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(MarketPeopleInk.fit)
                                .frame(minHeight: 44, alignment: .leading)
                        }
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(red: 0.96, green: 0.89, blue: 0.73).opacity(0.38), in: RoundedRectangle(cornerRadius: 10))
                }
                if prospect.provider == "youtube" {
                    Text("Creator topic match; personal need and video transcript have not been verified.")
                        .font(.caption).foregroundStyle(MarketPeopleInk.secondary)
                }
            }

            ForEach(person.evidence) { evidence in
                VStack(alignment: .leading, spacing: 7) {
                    Text("“\(evidence.quote)”")
                        .font(.system(size: quoteSize, weight: .regular, design: .serif).italic())
                        .foregroundStyle(MarketPeopleInk.primary)
                        .lineSpacing(2)
                        .fixedSize(horizontal: false, vertical: true)

                    HStack(spacing: 7) {
                        Image("RedditLogo").resizable().scaledToFit().frame(width: 16, height: 16)
                            .accessibilityHidden(true)
                        Text("r/\(evidence.source.community)")
                            .font(.footnote.weight(.medium))
                        if let date = evidence.source.createdAt {
                            Text("· \(MarketDate.label(date))").font(.footnote)
                        }
                    }
                    .foregroundStyle(MarketPeopleInk.secondary)

                    Button { onSource(evidence.source) } label: {
                        Label(evidence.isSample ? "View sample source details" : "Open original conversation",
                              systemImage: evidence.isSample ? "info.circle" : "arrow.up.right.square")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(MarketPeopleInk.fit)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("marketSource-\(evidence.id)")
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(red: 0.96, green: 0.89, blue: 0.73).opacity(0.38),
                            in: RoundedRectangle(cornerRadius: 10))
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("marketPerson-\(person.id)")
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
            .font(.system(size: 10, weight: .semibold))
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
