import SwiftUI

private enum MarketInk {
    static let primary = Color(red: 0.055, green: 0.145, blue: 0.225)
    static let secondary = Color(red: 0.36, green: 0.42, blue: 0.43)
    static let mutedBlue = Color(red: 0.59, green: 0.71, blue: 0.82)
    static let rule = Color(red: 0.70, green: 0.60, blue: 0.37)
    static let softGold = Color(red: 0.82, green: 0.55, blue: 0.09)
}

struct MarketView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var billing: MarketingStore
    @StateObject private var store = MarketStore()
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var navigationPath: [MarketPeopleRoute] = []
    @State private var showingSampleSource = false
    @State private var showingUnavailableSource = false
    @State private var showingTavern = false
    @ScaledMetric(relativeTo: .subheadline) private var scaledSegmentHeight: CGFloat = 37
    private var marketingAllowed: Bool { model.isPreviewMode || billing.canAccess(appID: store.selectedMarketAppID ?? "") }

    private var configurationKey: String {
        [model.user?.id ?? "signed-out", String(model.isPreviewMode),
         model.apps.map(\.id).sorted().joined(separator: ",")].joined(separator: "|")
    }

    private var isActive: Bool { scenePhase == .active && model.selectedTab == "market" }
    private var contextKey: String {
        [configurationKey, store.selectedMarketAppID ?? "", String(marketingAllowed),
         String(isActive)].joined(separator: "|")
    }

    private var peopleTaskKey: String {
        [contextKey, String(store.overview?.profileRevision ?? 0),
         store.overview?.snapshotId ?? "no-snapshot", store.selectedSegment.rawValue,
         store.activeProblemFilterID ?? "all"].joined(separator: "|")
    }

    private var scanTaskKey: String {
        [contextKey, String(store.overview?.profileRevision ?? 0),
         store.overview?.scan?.id ?? "no-scan", String(store.scanPollingEpoch)].joined(separator: "|")
    }

    private var constrainedPreviewWidth: CGFloat? {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("--quest-market-width-375") ? 375 : nil
        #else
        nil
        #endif
    }

    var body: some View {
        NavigationStack(path: $navigationPath) {
            ScrollView {
                VStack(spacing: 0) {
                    appPicker
                    if marketingAllowed {
                        segmentControl.padding(.top, QuestPageLayout.sectionSpacing)
                        mainContent
                            .padding(.horizontal, QuestPageLayout.margin - 3)
                            .padding(.top, QuestPageLayout.sectionSpacing)
                            .padding(.bottom, 18)
                    } else { MarketingCoverageNotice() }
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                QuestMainPageHeader(title: "Market", systemImage: "chart.bar.xaxis",
                                    subtitle: store.isSample ? "Sample data" : nil) {
                    if model.tavernEnabled {
                        Button { showingTavern = true } label: {
                            Image(systemName: "bubble.left.and.bubble.right.fill")
                                .font(.system(size: 18, weight: .semibold))
                                .foregroundStyle(QuestStyle.gold)
                                .frame(width: 44, height: 44)
                                .background(QuestStyle.navy.opacity(0.88), in: RoundedRectangle(cornerRadius: 12))
                                .overlay(RoundedRectangle(cornerRadius: 12).stroke(QuestStyle.gold.opacity(0.42)))
                        }.buttonStyle(.plain)
                            .accessibilityLabel("Tavern global chat")
                            .accessibilityIdentifier("openTavern")
                    }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                MarketTabBarBackdrop()
            }
            .background(QuestStyle.navy)
            .scrollIndicators(.hidden)
            .refreshable { if marketingAllowed { await refreshMarket() } }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: MarketPeopleRoute.self) { route in
                if let problem = store.overview?.problems.first(where: { $0.id == route.problemID }) {
                    MarketPeopleView(store: store, problem: problem)
                } else {
                    MarketUnavailablePeopleView()
                }
            }
            .navigationDestination(isPresented: $showingTavern) {
                if model.tavernEnabled { TavernView() }
            }
        }
        .frame(width: constrainedPreviewWidth)
        .frame(maxWidth: .infinity)
        .background(QuestStyle.navy.ignoresSafeArea())
        .tint(QuestStyle.gold)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .toolbarBackground(QuestStyle.navy, for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
        .toolbarColorScheme(.dark, for: .tabBar)
        .onChange(of: configurationKey, initial: true) { _, _ in
            store.configure(accountID: model.user?.id, apps: model.apps,
                            preferredAppID: model.selectedLeadAppID, preview: model.isPreviewMode)
        }
        .task(id: contextKey) {
            guard isActive, marketingAllowed, store.selectedMarketAppID != nil else { return }
            await store.loadOverview { appID in try await model.marketOverview(appID: appID) }
        }
        .task(id: peopleTaskKey) {
            guard isActive, marketingAllowed, store.selectedSegment == .people, store.overview != nil else { return }
            await loadPeople()
        }
        .task(id: scanTaskKey) {
            guard isActive, marketingAllowed, store.overview?.scan?.status.isActive == true else { return }
            await store.pollScan(
                fetch: { appID, scanID in try await model.marketScan(appID: appID, scanID: scanID) },
                refresh: { appID in try await model.marketOverview(appID: appID) }
            )
        }
        .alert("Sample source", isPresented: $showingSampleSource) {
            Button("OK", role: .cancel) { }
        } message: {
            Text("This is a sample record for the Market demo. It is not a real Reddit post, and the quote is not linked to a real account.")
        }
        .alert("Source unavailable", isPresented: $showingUnavailableSource) {
            Button("OK", role: .cancel) { }
        } message: {
            Text("This source link could not be verified. Refresh the Market evidence before opening it.")
        }
        .accessibilityIdentifier("marketRoot")
        .onChange(of: model.tavernEnabled) { _, enabled in if !enabled { showingTavern = false } }
    }

    private var appPicker: some View {
        Group {
            if let app = store.selectedApp {
                Menu {
                    ForEach(store.apps) { option in
                        Button {
                            store.selectApp(option.id)
                        } label: {
                            if option.id == app.id {
                                Label(option.name, systemImage: "checkmark")
                            } else {
                                Text(option.name)
                            }
                        }
                        .accessibilityIdentifier("marketAppOption-\(option.id)")
                    }
                } label: {
                    QuestAppPickerLabel(app: app)
                }
                .accessibilityLabel("Selected app, \(app.name)")
                .accessibilityHint("Choose which app’s market insights to view.")
                .accessibilityIdentifier("marketAppPicker")
            } else if model.isLoadingApps {
                HStack(spacing: 10) {
                    ProgressView().tint(QuestStyle.gold)
                    Text("Loading connected apps…").font(QuestTypography.secondary)
                }
                .foregroundStyle(QuestStyle.muted)
                .frame(maxWidth: .infinity, minHeight: 46, alignment: .leading)
            }
        }
        .padding(.horizontal, QuestPageLayout.margin)
    }

    private var segmentControl: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(spacing: 8) {
                    ForEach(MarketSegment.allCases) { segment in
                        Button {
                            store.selectSegment(segment)
                        } label: {
                            Text(segment.rawValue)
                                .font(QuestTypography.secondaryAction)
                                .foregroundStyle(store.selectedSegment == segment ? MarketInk.primary : MarketInk.mutedBlue)
                                .multilineTextAlignment(.center)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .padding(.vertical, 8)
                                .background(store.selectedSegment == segment ? QuestStyle.gold : QuestStyle.navy,
                                            in: RoundedRectangle(cornerRadius: 12))
                                .overlay(RoundedRectangle(cornerRadius: 12)
                                    .stroke(Color(red: 0.13, green: 0.34, blue: 0.51), lineWidth: 1))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(store.selectedSegment == segment ? .isSelected : [])
                        .accessibilityIdentifier("marketSegment-\(segment.rawValue.lowercased())")
                    }
                }
            } else {
                standardSegmentControl
            }
        }
        .padding(.horizontal, QuestPageLayout.margin)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Market view")
        .accessibilityIdentifier("marketSegments")
    }

    private var standardSegmentControl: some View {
        HStack(spacing: 2) {
            ForEach(MarketSegment.allCases) { segment in
                Button {
                    store.selectSegment(segment)
                } label: {
                    Text(segment.rawValue)
                        .font(QuestTypography.secondaryAction)
                        .foregroundStyle(store.selectedSegment == segment ? MarketInk.primary : MarketInk.mutedBlue)
                        .frame(maxWidth: .infinity, minHeight: segmentVisualHeight)
                        .fixedSize(horizontal: false, vertical: true)
                        .background(alignment: .top) {
                            if store.selectedSegment == segment {
                                RoundedRectangle(cornerRadius: 12)
                                    .fill(QuestStyle.gold)
                                    .frame(height: segmentVisualHeight - 5)
                                    .padding(.top, 2.5)
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: segmentHitHeight, alignment: .top)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(store.selectedSegment == segment ? .isSelected : [])
                .accessibilityIdentifier("marketSegment-\(segment.rawValue.lowercased())")
            }
        }
        .frame(maxWidth: .infinity, minHeight: segmentHitHeight)
        .background(alignment: .top) {
            RoundedRectangle(cornerRadius: 14)
                .fill(QuestStyle.navy.opacity(0.3))
                .frame(height: segmentVisualHeight)
        }
        .overlay(alignment: .top) {
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color(red: 0.13, green: 0.34, blue: 0.51), lineWidth: 1)
                .frame(height: segmentVisualHeight)
        }
    }

    private var segmentVisualHeight: CGFloat {
        max(37, scaledSegmentHeight)
    }

    private var segmentHitHeight: CGFloat {
        max(44, segmentVisualHeight + 7)
    }

    @ViewBuilder
    private var mainContent: some View {
        if store.apps.isEmpty && !model.isLoadingApps {
            MarketPaperBoard {
                MarketBoardMessage(title: "Connect an app to begin",
                                   message: "Choose an app from Apps to see the problems people discuss.",
                                   symbol: "square.grid.2x2") {
                    Button("Open Apps") { model.selectedTab = "apps" }
                        .buttonStyle(MarketPrimaryButtonStyle())
                }
            }
            .accessibilityIdentifier("marketNoApps")
        } else if store.isLoadingOverview && store.overview == nil {
            MarketPaperBoard {
                VStack(alignment: .leading, spacing: 12) {
                    ProgressView("Gathering market insights…")
                        .tint(MarketInk.primary)
                        .foregroundStyle(MarketInk.primary)
                        .accessibilityIdentifier("marketLoading")
                }
            }
        } else if store.overview == nil {
            MarketPaperBoard {
                MarketBoardMessage(
                    title: statusTitle,
                    message: store.errorMessage ?? "Market insights could not be loaded.",
                    symbol: store.loadErrorCode == "MISSING_PROFILE" ? "person.crop.circle.badge.questionmark" : "exclamationmark.arrow.triangle.2.circlepath"
                ) {
                    if store.loadErrorCode == "MISSING_PROFILE", let appID = store.selectedMarketAppID {
                        Button("Set up app profile") { model.requestLeadProfileSetup(appID: appID) }
                            .buttonStyle(MarketPrimaryButtonStyle())
                    } else {
                        Button("Try again") { Task { await refreshOverview() } }
                            .buttonStyle(MarketPrimaryButtonStyle())
                    }
                }
            }
            .accessibilityIdentifier(store.loadErrorCode == "FEATURE_UNAVAILABLE" ? "marketUnavailable" : "marketLoadError")
        } else if let overview = store.overview {
            if let error = store.errorMessage {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(QuestStyle.gold)
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Market data could not refresh").font(QuestTypography.secondaryAction)
                        Text(error).font(QuestTypography.metadata)
                        Button("Retry") { Task { await refreshOverview() } }
                            .font(QuestTypography.secondaryAction).frame(minHeight: 44)
                    }
                    Spacer(minLength: 0)
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 18)
                .padding(.bottom, 12)
            }
            if store.selectedSegment == .problems {
                if let research = overview.research {
                    MarketPaperBoard { researchBoard(research, overview: overview) }
                        .accessibilityIdentifier("marketResearchBoard")
                } else if let featured = overview.featuredProblem {
                    MarketPaperBoard {
                        problemBoard(overview: overview, featured: featured)
                    }
                    .accessibilityIdentifier("marketProblemsBoard")
                } else {
                    MarketPaperBoard {
                        MarketBoardMessage(title: emptyMarketTitle(for: overview),
                                           message: emptyMarketMessage(for: overview),
                                           symbol: "sparkle.magnifyingglass") {
                            scanControls(overview: overview)
                        }
                    }
                    .accessibilityIdentifier("marketEmptyState")
                }
            } else if store.selectedSegment == .landscape {
                MarketPaperBoard { landscapeBoard(overview: overview) }
                    .accessibilityIdentifier("marketLandscapeBoard")
            } else {
                MarketPeopleList(store: store, problem: nil, people: store.peoplePage?.people ?? [],
                                 isLoading: store.isLoadingPeople, error: store.peopleError,
                                 onFilterClear: { store.selectProblemFilter(nil) },
                                 onSource: handleSource, onRetry: { Task { await loadPeople() } },
                                 onLoadMore: { Task { await loadPeople(more: true) } })
                    .accessibilityIdentifier("marketPeopleList")
            }
        }
    }

    private func landscapeBoard(overview: MarketOverview) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("What already exists")
                .font(QuestTypography.paperTitle)
                .foregroundStyle(MarketInk.primary)
                .accessibilityAddTraits(.isHeader)
            Text("Competitors, alternatives, and the workarounds people use.")
                .font(QuestTypography.secondary).foregroundStyle(MarketInk.secondary)
            if let findings = store.isSample ? MarketExamples.landscape : overview.research?.landscape, !findings.isEmpty {
                ForEach(Array(findings.enumerated()), id: \.offset) { _, finding in
                    VStack(alignment: .leading, spacing: 10) {
                        Text(finding.title).font(QuestTypography.cardTitle)
                        Text(finding.summary).font(QuestTypography.body)
                        ForEach(Array(finding.sources.enumerated()), id: \.offset) { _, source in
                            if let url = source.publicURL {
                                Link(destination: url) {
                                    Label(source.title, systemImage: "arrow.up.right.square")
                                        .font(QuestTypography.secondary).multilineTextAlignment(.leading)
                                        .frame(minHeight: 44, alignment: .leading)
                                }
                            }
                        }
                    }
                    .foregroundStyle(MarketInk.primary)
                    Divider().overlay(MarketInk.rule)
                }
            } else {
                Text(overview.research?.landscape == nil
                     ? "Run a new Market search to explore the landscape for this app."
                     : "This search did not find enough supported landscape information. Try another search or refine your app profile.")
                    .foregroundStyle(MarketInk.primary)
            }
            scanControls(overview: overview)
        }
        .padding(.horizontal, 38)
        .padding(.top, 31)
        .padding(.bottom, 17)
    }

    private var statusTitle: String {
        switch store.loadErrorCode {
        case "MISSING_PROFILE": return "Set up this app’s profile"
        case "FEATURE_UNAVAILABLE": return "Market is not available yet"
        default: return "The market board could not load"
        }
    }

    private func researchBoard(_ research: MarketResearch, overview: MarketOverview) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("MARKET RESEARCH")
                .font(QuestTypography.overline)
                .tracking(1.7).foregroundStyle(MarketInk.secondary)
            Text("Problems worth exploring")
                .font(QuestTypography.paperTitle)
                .foregroundStyle(MarketInk.primary)
                .accessibilityAddTraits(.isHeader)
            Text("Early findings from Reddit and the wider web, including older discussions. These are research summaries, not verified counts of people or recurring demand.")
                .font(QuestTypography.secondary).foregroundStyle(MarketInk.secondary)
            if research.findings.isEmpty {
                Text("The search did not find enough evidence to suggest a problem yet. You can run another search or refine your app profile.")
                    .foregroundStyle(MarketInk.primary)
            }
            ForEach(Array(research.findings.enumerated()), id: \.offset) { _, finding in
                VStack(alignment: .leading, spacing: 10) {
                    Text(finding.title).font(QuestTypography.cardTitle)
                        .foregroundStyle(MarketInk.primary)
                    Text(finding.summary).font(QuestTypography.body).foregroundStyle(MarketInk.primary)
                    ForEach(Array(finding.sources.enumerated()), id: \.offset) { _, source in
                        if let url = source.publicURL {
                            Link(destination: url) {
                                Label(source.title, systemImage: "arrow.up.right.square")
                                    .font(QuestTypography.secondary).multilineTextAlignment(.leading)
                                    .frame(minHeight: 44, alignment: .leading)
                            }
                            .foregroundStyle(MarketInk.primary)
                        }
                    }
                }
                Divider().overlay(MarketInk.rule)
            }
            scanControls(overview: overview)
        }
        .padding(.horizontal, 38)
        .padding(.top, 31)
        .padding(.bottom, 17)
    }

    private func problemBoard(overview: MarketOverview, featured: MarketProblem) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Text(featured.peopleCount >= 2 ? "RECURRING PROBLEM" : "EARLY SIGNAL")
                    .font(QuestTypography.overline)
                    .tracking(1.7)
                    .foregroundStyle(MarketInk.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .layoutPriority(1)
                Rectangle().fill(MarketInk.rule.opacity(0.72)).frame(height: 1)
            }
            .padding(.bottom, 11)

            Text(featured.title)
                .font(QuestTypography.paperTitle)
                .foregroundStyle(MarketInk.primary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .padding(.bottom, 7)

            Text("\(featured.peopleCount) people · \(featured.conversationCount) conversations")
                .font(QuestTypography.secondary.weight(.semibold))
                .foregroundStyle(MarketInk.secondary)
                .padding(.bottom, 8)

            Text(featured.summary)
                .font(QuestTypography.body)
                .lineSpacing(3)
                .foregroundStyle(MarketInk.primary.opacity(0.9))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 10)

            if let evidence = overview.evidence(for: featured) {
                Button { handleSource(evidence.source) } label: {
                    HStack(alignment: .center, spacing: 13) {
                        Capsule().fill(MarketInk.softGold).frame(width: 4)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("“\(evidence.quote)”")
                                .font(QuestTypography.body).fontDesign(.serif).italic()
                                .lineSpacing(1)
                                .foregroundStyle(MarketInk.primary)
                                .fixedSize(horizontal: false, vertical: true)
                            Text(evidence.source.authorDisplayName.map { "\($0) in r/\(evidence.source.community)" }
                                 ?? "A collector in r/\(evidence.source.community)")
                                .font(QuestTypography.metadata)
                                .foregroundStyle(MarketInk.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open source, \(evidence.quote). \(evidence.isSample ? "Sample record" : "Reddit")")
                .accessibilityHint(evidence.isSample ? "Explains why the sample source is not a real conversation." : "Opens the original public conversation.")
                .accessibilityIdentifier("marketFeaturedSource")
                .padding(.bottom, 14)
            }

            Button {
                store.selectProblemFilter(featured.id)
                navigationPath.append(MarketPeopleRoute(problemID: featured.id))
            } label: {
                HStack(spacing: 10) {
                    Spacer(minLength: 0)
                    Text("View \(featured.peopleCount) people")
                        .fixedSize(horizontal: false, vertical: true)
                    Image(systemName: "arrow.right")
                    Spacer(minLength: 0)
                }
                .font(QuestTypography.primaryAction)
                .foregroundStyle(QuestStyle.gold)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(QuestStyle.navy, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(QuestStyle.gold, lineWidth: 1.2))
                .contentShape(RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("marketFeaturedPeople")
            .padding(.bottom, 9)

            MarketRuleDivider()
                .padding(.bottom, 6)

            let rows = overview.problems.filter { $0.id != featured.id }
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, problem in
                if index > 0 {
                    Rectangle().fill(MarketInk.rule.opacity(0.55)).frame(height: 0.7)
                        .padding(.vertical, 4)
                }
                MarketProblemRow(problem: problem) {
                    store.selectProblemFilter(problem.id)
                    navigationPath.append(MarketPeopleRoute(problemID: problem.id))
                }
                .accessibilityIdentifier("marketProblem-\(problem.id)")
            }

            if !overview.isSample {
                scanControls(overview: overview).padding(.top, 12)
            }
            if !overview.isSample && overview.coverage == .partial {
                Text("Partial coverage · \(overview.sources.map { "\($0.provider.capitalized) \($0.collectedCount)" }.joined(separator: ", ")) collected")
                    .font(QuestTypography.metadata)
                    .foregroundStyle(MarketInk.secondary)
                    .padding(.top, 10)
            }
        }
        .padding(.horizontal, 38)
        .padding(.top, 31)
        .padding(.bottom, 17)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func scanControls(overview: MarketOverview) -> some View {
        if let scan = overview.scan, scan.status.isActive {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .tint(MarketInk.primary)
                    Text(scanLabel(scan.status))
                }
                .font(QuestTypography.secondaryAction)
                .foregroundStyle(MarketInk.secondary)
                .frame(minHeight: 44)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("marketScanProgress")
                if let scanError = store.scanError {
                    Text(scanError).font(QuestTypography.metadata).foregroundStyle(MarketInk.secondary)
                    Button("Check scan status") { Task { await refreshOverview() } }
                        .buttonStyle(MarketPrimaryButtonStyle())
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                if let scan = overview.scan {
                    Text("Last scan · \(scanLabel(scan.status))")
                        .font(QuestTypography.metadata).foregroundStyle(MarketInk.secondary)
                }
                if let scanError = store.scanError {
                    Text(scanError).font(QuestTypography.metadata).foregroundStyle(MarketInk.secondary)
                }
                Button {
                    Task { await store.beginScan { try await model.startMarketScan(appID: $0, revision: $1, idempotencyKey: $2) } }
                } label: {
                    HStack(spacing: 8) {
                        if store.isStartingScan { ProgressView().tint(QuestStyle.navy) }
                        Text(store.isStartingScan ? "Starting scan…" : "Research market")
                    }
                }
                .buttonStyle(MarketPrimaryButtonStyle())
                .disabled(store.isStartingScan || model.isPreviewMode || (overview.scan?.status == .failed && overview.scan?.canRetry == false))
                .accessibilityIdentifier("marketScan")
            }
        }
    }

    private func scanLabel(_ status: MarketScanStatus) -> String {
        switch status {
        case .queued: return "Waiting to start"
        case .collecting: return "Collecting public conversations"
        case .analyzing: return "Researching market problems"
        case .complete: return "Complete"
        case .failed: return "Could not complete"
        case .cancelled: return "Cancelled"
        }
    }

    private func emptyMarketTitle(for overview: MarketOverview) -> String {
        if overview.scan?.status.isActive == true { return "Researching your market" }
        if overview.scan?.status == .failed { return "Scan could not finish" }
        if overview.scan?.status == .cancelled { return "Scan cancelled" }
        if overview.scan == nil && overview.snapshotId == nil { return "Discover your market" }
        if overview.sources.allSatisfy({ $0.collectedCount == 0 }) { return "No conversations collected" }
        return "No recurring problems yet"
    }

    private func emptyMarketMessage(for overview: MarketOverview) -> String {
        if let scan = overview.scan, scan.status.isActive {
            return "A scan is in progress. Market will show recurring problems after enough evidence is collected."
        }
        if overview.scan?.status == .failed {
            return "The scan stopped before research could finish. Try again to collect and review conversations."
        }
        if overview.scan?.status == .cancelled {
            return "Research was cancelled before it finished. Start a new scan to try again."
        }
        if overview.scan == nil && overview.snapshotId == nil {
            return "Start your first scan to search Reddit and the wider web for problems people discuss, including older conversations."
        }
        if overview.sources.allSatisfy({ $0.collectedCount == 0 }) {
            return "This scan collected no matching conversations, so AI analysis did not run. Try another scan or review your app’s communities and keywords."
        }
        if overview.problems.contains(where: { $0.peopleCount == 1 || $0.conversationCount == 1 }) {
            return "There are conversations to review, but not enough evidence from distinct people to call a problem recurring."
        }
        return "No recurring problems have been supported by the collected conversations yet. Your scan window and source coverage are shown below."
    }

    private func refreshOverview() async {
        await store.loadOverview { appID in try await model.marketOverview(appID: appID) }
        store.resumeScanPolling()
    }

    private func refreshMarket() async {
        await refreshOverview()
        if store.selectedSegment == .people, store.overview != nil {
            await loadPeople()
        }
    }

    private func loadPeople(more: Bool = false) async {
        await store.loadPeople(fetch: { appID, revision, snapshotId, problemID, page in
            try await model.marketPeople(appID: appID, revision: revision, snapshotId: snapshotId,
                                         problemID: problemID, page: page)
        }, loadingMore: more, refreshOverview: { appID in
            try await model.marketOverview(appID: appID)
        })
    }

    private func handleSource(_ source: MarketSourceDTO) {
        switch MarketPeopleDestination.forSource(source) {
        case .open(let url): openURL(url)
        case .sampleExplanation: showingSampleSource = true
        case .unavailable: showingUnavailableSource = true
        }
    }
}

private struct MarketAppArtwork: View {
    let app: ConnectedApp
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 36

    var body: some View {
        Group {
            if let asset = app.bundledIconName {
                Image(asset).resizable().scaledToFill()
            } else {
                AsyncImage(url: app.iconUrl.flatMap(URL.init(string:))) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Image(systemName: "app.fill").resizable().scaledToFit().foregroundStyle(QuestStyle.gold)
                }
            }
        }
        .frame(width: min(size, 48), height: min(size, 48))
        .clipShape(RoundedRectangle(cornerRadius: 5))
        .accessibilityHidden(true)
    }
}

struct MarketTabBarBackdrop: View {
    var body: some View {
        QuestStyle.navy
            .frame(height: 8)
            // Keep parchment and evidence text out of the translucent native tab bar.
            .background(QuestStyle.navy.ignoresSafeArea(.container, edges: .bottom))
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

struct MarketPaperBoard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .background { MarketBoardDecoration() }
            .padding(.horizontal, 3)
    }
}

private struct MarketBoardDecoration: View {
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Image("LeadsWoodBoard")
                    .resizable(capInsets: EdgeInsets(top: 20, leading: 20, bottom: 20, trailing: 20), resizingMode: .stretch)
                    .frame(width: geometry.size.width, height: geometry.size.height)
                let paperWidth = max(0, geometry.size.width - 25)
                let paperHeight = max(0, geometry.size.height - 20)
                let paperShape = RoundedRectangle(cornerRadius: 11, style: .continuous)
                paperShape.fill(Color(red: 0.96, green: 0.90, blue: 0.81))
                    .frame(width: paperWidth, height: paperHeight)
                Image("LeadsParchment")
                    .resizable()
                    .scaledToFill()
                    .frame(width: paperWidth, height: paperHeight)
                    .clipped()
                    .colorMultiply(Color(red: 0.996, green: 0.987, blue: 0.98))
                    .clipShape(paperShape)
                paperShape.stroke(Color(red: 0.68, green: 0.52, blue: 0.30).opacity(0.42), lineWidth: 0.8)
                    .frame(width: paperWidth, height: paperHeight)
            }
            .accessibilityHidden(true)
        }
    }
}

private struct MarketRuleDivider: View {
    var body: some View {
        HStack(spacing: 10) {
            Rectangle().fill(MarketInk.rule.opacity(0.78)).frame(height: 0.8)
            Image(systemName: "sparkle")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(MarketInk.rule)
            Rectangle().fill(MarketInk.rule.opacity(0.78)).frame(height: 0.8)
        }
        .accessibilityHidden(true)
    }
}

private struct MarketProblemRow: View {
    let problem: MarketProblem
    let action: () -> Void

    private var symbol: String {
        switch problem.id {
        case MarketExamples.problemSubscriptionsID: return "doc.text"
        case MarketExamples.problemSeriesID: return "shippingbox"
        default: return "magnifyingglass"
        }
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: symbol)
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(MarketInk.softGold)
                    .frame(width: 39, height: 39)
                    .background(QuestStyle.gold.opacity(0.19), in: Circle())
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(problem.title)
                        .font(QuestTypography.editorialTitle)
                        .foregroundStyle(MarketInk.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("\(problem.peopleCount) people")
                        .font(QuestTypography.metadata)
                        .foregroundStyle(MarketInk.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right")
                    .font(.system(size: 19, weight: .medium))
                    .foregroundStyle(MarketInk.primary.opacity(0.86))
                    .accessibilityHidden(true)
            }
            .frame(maxWidth: .infinity, minHeight: 58, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(problem.title), \(problem.peopleCount) people")
        .accessibilityHint("Opens the people and evidence for this problem.")
    }
}

struct MarketBoardMessage<Actions: View>: View {
    let title: String
    let message: String
    let symbol: String
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: symbol)
                .font(QuestTypography.sectionTitle)
                .foregroundStyle(MarketInk.primary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text(message)
                .font(QuestTypography.body).foregroundStyle(MarketInk.secondary)
                .fixedSize(horizontal: false, vertical: true)
            actions
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 38)
        .padding(.top, 30)
        .padding(.bottom, 26)
    }
}

struct MarketPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(QuestTypography.primaryAction)
            .fixedSize(horizontal: false, vertical: true)
            .foregroundStyle(QuestStyle.gold)
            .frame(maxWidth: .infinity, minHeight: 44)
            .padding(.horizontal, 14)
            .background(QuestStyle.navy.opacity(configuration.isPressed ? 0.84 : 1), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(QuestStyle.gold, lineWidth: 1.1))
    }
}

struct MarketPeopleRoute: Hashable {
    let problemID: String
}

private struct MarketUnavailablePeopleView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("This problem is no longer available")
                .font(QuestTypography.sectionTitle)
            Text("Refresh Market to load the current evidence.")
                .foregroundStyle(QuestStyle.muted)
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(QuestStyle.navy.ignoresSafeArea())
        .foregroundStyle(.white)
        .navigationTitle("People")
        .navigationBarTitleDisplayMode(.inline)
    }
}
