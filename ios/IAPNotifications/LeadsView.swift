import SwiftUI
import UIKit

struct LeadsView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var billing: MarketingStore
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var setupApp: ConnectedApp?
    @State private var showingQuestTrial = false
    @State private var journalPath: [LeadJournalSession] = []
    private var marketingAllowed: Bool { model.isPreviewMode || !billing.isEnabled || billing.canAccess(appID: model.selectedLeadAppID ?? "") }
    #if DEBUG
    @State private var didOpenPreviewJournal = false
    #endif

    var body: some View {
        NavigationStack(path: $journalPath) {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    compactHeader

                    appPicker
                    if marketingAllowed {
                        scanProgress
                        board.padding(.top, 14)
                    } else { MarketingCoverageNotice() }
                    if let locked = model.lockedQuests, marketingAllowed {
                        Button { showingQuestTrial = true } label: {
                            HStack {
                                Label(locked.title, systemImage: "lock.fill")
                                Spacer()
                                Text("Explore ›")
                            }.font(.subheadline.weight(.semibold)).padding().frame(minHeight: 48)
                        }.buttonStyle(.plain).foregroundStyle(QuestStyle.gold)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .background(QuestStyle.navy)
            .foregroundStyle(.white)
            .tint(QuestStyle.gold)
            .refreshable { if marketingAllowed { await model.refreshLeadBoard() } }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                undoBanner
            }
            .task(id: "\(model.selectedLeadAppID ?? ""): \(model.selectedTab): \(scenePhase): \(marketingAllowed)") {
                guard marketingAllowed, scenePhase == .active, model.selectedTab == "leads", model.selectedLeadAppID != nil else { return }
                await model.refreshLeadBoard()
            }
            .task(id: "\(model.selectedLeadAppID ?? ""): \(model.selectedTab): \(scenePhase): \(model.leadProfile?.revision ?? 0): \(needsProgressPolling)") {
                guard scenePhase == .active, model.selectedTab == "leads", needsProgressPolling else { return }
                while !Task.isCancelled, !model.isPreviewMode, model.leadProfile?.enabled == true,
                      model.leadBoardError == nil, model.leadAccess?.aiAvailable == true {
                    let progress = model.leadProfileStatus.progress
                    guard progress?.shouldPoll == true || progress == nil && model.leadProfileStatus.code == "waiting" else { break }
                    do { try await Task.sleep(for: .seconds(progress?.isWorking == true ? 6 : 20)) }
                    catch { return }
                    guard !Task.isCancelled else { return }
                    if setupApp == nil { await model.refreshLeadBoard(background: true) }
                }
            }
            .fullScreenCover(isPresented: $showingQuestTrial) { MoreQuestsPage(standalone: true).environmentObject(model) }
            .sheet(item: $setupApp) { app in
                LeadsSetupView(app: app)
                    .environmentObject(model)
                    .preferredColorScheme(.dark)
            }
            .navigationDestination(for: LeadJournalSession.self) { session in
                LeadJournalView(session: session).environmentObject(model)
            }
            .task {
                #if DEBUG
                if !didOpenPreviewJournal, model.isPreviewMode,
                   ProcessInfo.processInfo.arguments.contains("--quest-journal-preview") {
                    didOpenPreviewJournal = true
                    journalPath = [LeadJournalExamples.halloweenSession()]
                }
                #endif
            }
            .navigationTitle("Quest board")
            .toolbar(.hidden, for: .navigationBar)
            .toolbar(journalPath.isEmpty ? .visible : .hidden, for: .tabBar)
            .toolbarBackground(QuestStyle.navy, for: .tabBar)
            .toolbarBackground(.visible, for: .tabBar)
            .toolbarColorScheme(.dark, for: .tabBar)
        }
        .background(QuestStyle.navy.ignoresSafeArea())
        .accessibilityIdentifier("leadsRoot")
        .onChange(of: model.requestedLeadSetupAppID) { _, _ in openRequestedSetupIfNeeded() }
        .onChange(of: model.selectedTab) { _, tab in
            if tab == "leads" { openRequestedSetupIfNeeded() }
        }
        .onAppear { openRequestedSetupIfNeeded() }
        .onChange(of: model.leadUndoAction?.id) { _, actionId in
            guard let actionId else { return }
            Task {
                try? await Task.sleep(for: .seconds(8))
                model.clearLeadUndo(id: actionId)
            }
        }
    }

    private func openRequestedSetupIfNeeded() {
        guard model.selectedTab == "leads",
              let appID = model.requestedLeadSetupAppID,
              let app = model.apps.first(where: { $0.id == appID }) else { return }
        setupApp = app
        model.requestedLeadSetupAppID = nil
    }

    private var compactHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 10) {
                QuestMainPageTitle(title: "High-intent leads", systemImage: "pin.fill")
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(action: presentSetup) {
                    Image(systemName: "slider.horizontal.3")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(QuestStyle.gold)
                        .frame(width: 44, height: 44)
                        .background(QuestStyle.navy.opacity(0.88), in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(QuestStyle.gold.opacity(0.42), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Set up lead profile")
                .accessibilityHint("Review what this app does and choose communities to monitor.")
                .accessibilityIdentifier("leadsProfileSettings")
            }
            if model.isPreviewMode {
                Label("Demo · Sample leads", systemImage: "sparkles")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(QuestStyle.gold)
                    .accessibilityIdentifier("leadsDemoBadge")
            }
        }
        .padding(.top, 38)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            GeometryReader { geometry in
                Image("QuestLandscape").resizable().scaledToFill()
                    .frame(width: geometry.size.width + 48, height: geometry.size.height + 90, alignment: .top)
                    .clipped()
                    .overlay(LinearGradient(stops: [
                        .init(color: QuestStyle.navy.opacity(0.1), location: 0),
                        .init(color: QuestStyle.navy.opacity(0.3), location: 0.45),
                        .init(color: QuestStyle.navy, location: 1)
                    ], startPoint: .top, endPoint: .bottom))
                    .offset(x: -24, y: -60)
            }.allowsHitTesting(false).accessibilityHidden(true)
        }
    }

    private var needsProgressPolling: Bool {
        guard model.leadProfile?.enabled == true, model.leadBoardError == nil, model.leadAccess?.aiAvailable == true else { return false }
        return model.leadProfileStatus.progress?.shouldPoll ?? (model.leadProfileStatus.code == "waiting")
    }

    private var visibleProgress: LeadScanProgress? {
        guard model.leadProfile?.enabled == true, model.leadBoardError == nil,
              model.leadAccess?.aiAvailable != false, model.leadProfileStatus.limited != true else { return nil }
        return model.leadProfileStatus.progress
    }

    @ViewBuilder
    private var scanProgress: some View {
        if !model.isPreparingLeadBoard, let progress = visibleProgress, progress.isWorking || progress.phase == "queued" {
            VStack(alignment: .leading, spacing: 9) {
                Text(progress.background == true ? "Searching in the background" : progress.isWorking ? "Finding relevant posts…" : "Waiting to start…")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.white)
                LeadsScanBar(fraction: progress.normalizedFraction,
                             moving: progress.isWorking, reduceMotion: reduceMotion)
                    .frame(height: 8)
                if progress.background == true {
                    Text(!model.leadItems.isEmpty || model.deviceId == nil
                         ? "You can leave this screen. Matching posts will appear here as we find them."
                         : "You can leave this screen. We’ll notify you when your first match is ready.")
                        .font(.footnote)
                        .foregroundStyle(.white.opacity(0.85))
                }
            }
            .padding(.horizontal, 4)
            .padding(.top, 3)
            .padding(.bottom, 8)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(progress.background == true ? "Searching in the background. You can leave this screen." : progress.isWorking ? "Finding relevant posts" : "Waiting to start")
            .accessibilityIdentifier("leadsScanProgress")
        }
    }

    @ViewBuilder
    private var reviewingPost: some View {
        if let progress = visibleProgress, progress.isWorking || progress.phase == "queued", let post = progress.post {
            LeadsPinnedPaper {
                VStack(alignment: .leading, spacing: 8) {
                    Text(post.state == "reviewing" ? "Reviewing a post" : "Last reviewed")
                        .font(.caption)
                        .foregroundStyle(LeadInk.secondary)
                    HStack(spacing: 7) {
                        Image("RedditLogo").resizable().scaledToFit().frame(width: 20, height: 20).accessibilityHidden(true)
                        Text("r/\(post.community)").font(.footnote.weight(.semibold)).foregroundStyle(LeadInk.secondary)
                    }
                    Text(post.title)
                        .font(.body.weight(.semibold)).foregroundStyle(LeadInk.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    if !post.excerpt.isEmpty {
                        Text(post.excerpt).font(.subheadline).foregroundStyle(LeadInk.secondary)
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                    }
                }
            }
            .accessibilityIdentifier("leadsReviewingPost")
        }
    }

    @ViewBuilder
    private var undoBanner: some View {
        if let undo = model.leadUndoAction, undo.appId == model.selectedLeadAppID {
            HStack(spacing: 12) {
                Text("Lead dismissed").font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                Spacer(minLength: 4)
                Button {
                    Task { await model.undoLeadDismissal() }
                } label: {
                    HStack(spacing: 7) {
                        if model.leadPendingPostID == undo.lead.postId { ProgressView().tint(QuestStyle.navy) }
                        Text("Undo")
                    }
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(QuestStyle.navy)
                    .padding(.horizontal, 15).frame(minHeight: 44)
                    .background(QuestStyle.gold, in: Capsule())
                }
                .disabled(model.leadPendingPostID != nil)
                .accessibilityIdentifier("leadDismissUndo")
            }
            .padding(.horizontal, 16).padding(.vertical, 5)
            .background(QuestStyle.navy.opacity(0.93), in: Capsule())
            .overlay(Capsule().stroke(QuestStyle.gold.opacity(0.45)))
            .accessibilityElement(children: .contain)
        }
    }

    private var appPicker: some View {
        Group {
            if let app = model.apps.first(where: { $0.id == model.selectedLeadAppID }) {
                Menu {
                    ForEach(model.apps) { option in
                        Button {
                            model.selectLeadApp(option.id)
                        } label: {
                            if option.id == app.id {
                                Label(option.name, systemImage: "checkmark")
                            } else {
                                Text(option.name)
                            }
                        }
                        .accessibilityIdentifier("leadAppOption-\(option.id)")
                    }
                } label: {
                    HStack(spacing: 12) {
                        LeadAppArtwork(app: app, size: 28)
                        Text(app.name)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: "chevron.down")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(QuestStyle.muted)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .frame(maxWidth: .infinity, minHeight: 46)
                    .background(QuestStyle.navy.opacity(0.94), in: RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color(red: 0.19, green: 0.38, blue: 0.55), lineWidth: 1))
                }
                .accessibilityLabel("Selected app, \(app.name)")
                .accessibilityHint("Choose which connected app this board is for.")
                .accessibilityIdentifier("leadAppPicker")
            } else if model.isLoadingApps {
                HStack(spacing: 10) {
                    ProgressView().tint(QuestStyle.gold)
                    Text("Loading connected apps…").font(.subheadline)
                }
                .foregroundStyle(QuestStyle.muted)
                .frame(maxWidth: .infinity, minHeight: 58, alignment: .leading)
            }
        }
    }

    @ViewBuilder
    private var board: some View {
        VStack(spacing: 8) {
            HStack(spacing: 12) {
                Text("QUEST BOARD")
                    .font(.system(.caption, design: .serif).weight(.semibold))
                    .tracking(2.5)
                    .fixedSize(horizontal: false, vertical: true)
                    .layoutPriority(1)
                    .accessibilityAddTraits(.isHeader)
                if !dynamicTypeSize.isAccessibilitySize {
                    Rectangle().fill(LeadInk.rule.opacity(0.35)).frame(height: 0.5)
                    Image("JournalQuill")
                        .renderingMode(.template).resizable().scaledToFit()
                        .frame(width: 20, height: 24)
                        .accessibilityHidden(true)
                }
            }
            .foregroundStyle(LeadInk.secondary)
            .padding(.horizontal, 18)
            .padding(.top, 10)
            .padding(.trailing, 14)

            if let mutationError = model.leadMutationError {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Color(red: 0.58, green: 0.21, blue: 0.10))
                    VStack(alignment: .leading, spacing: 6) {
                        Text(mutationError).font(.subheadline.weight(.semibold))
                        if model.leadFailedDismissal != nil {
                            Button("Try again") { Task { await model.retryLeadDismissal() } }
                                .font(.subheadline.weight(.bold))
                                .frame(minHeight: 44)
                        }
                    }
                }
                .foregroundStyle(LeadInk.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(Color(red: 1, green: 0.91, blue: 0.76), in: RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal, 12)
            }

            if model.isPreparingLeadBoard {
                LeadsLoadingPlaceholder(isActive: scenePhase == .active && model.selectedTab == "leads")
            } else if model.apps.isEmpty && !model.isLoadingApps {
                LeadsPinnedPaper {
                    LeadsBoardMessage(
                        title: "Connect an app to begin",
                        message: "Choose an app from Apps to build an app-specific lead profile.",
                        symbol: "square.grid.2x2"
                    ) {
                        Button("Open Apps") { model.selectedTab = "apps" }
                            .buttonStyle(LeadsPrimaryButtonStyle())
                    }
                }
            } else if let error = model.leadBoardError {
                LeadsPinnedPaper {
                    LeadsBoardMessage(
                        title: "The board could not load",
                        message: error,
                        symbol: "exclamationmark.arrow.triangle.2.circlepath"
                    ) {
                        Button("Try again") { Task { await model.refreshLeadBoard() } }
                            .buttonStyle(LeadsPrimaryButtonStyle())
                    }
                }
            } else if let access = model.leadAccess, !access.enabled && !model.isPreviewMode {
                LeadsPinnedPaper {
                    LeadsBoardMessage(
                        title: "High-intent leads aren’t available yet",
                        message: access.reasonCode == "BETA_ACCESS_REQUIRED"
                            ? "This account isn’t in the invited beta. Your connected apps and Activity are unchanged."
                            : "Lead discovery is not enabled for this account yet.",
                        symbol: "lock.shield"
                    ) {
                        Button("Refresh access") { Task { await model.refreshLeadBoard() } }
                            .buttonStyle(LeadsPrimaryButtonStyle())
                    }
                }
            } else if model.leadProfile == nil {
                LeadsPinnedPaper {
                    LeadsBoardMessage(
                        title: "Set up this app’s profile",
                        message: "Describe the problems this app solves and choose communities. Questline asks you to review everything before monitoring begins.",
                        symbol: "doc.text.magnifyingglass"
                    ) {
                        Button("Set up profile", action: presentSetup)
                            .buttonStyle(LeadsPrimaryButtonStyle())
                    }
                }
            } else if model.leadProfile?.enabled == false {
                LeadsPinnedPaper {
                    LeadsBoardMessage(
                        title: "Lead discovery is paused",
                        message: "Your app profile is saved. Turn monitoring on when you’re ready.",
                        symbol: "pause.circle"
                    ) {
                        Button("Review profile", action: presentSetup)
                            .buttonStyle(LeadsPrimaryButtonStyle())
                    }
                }
            } else {
                if let statusText = statusMessage {
                    LeadsPinnedPaper {
                        LeadsBoardMessage(title: statusTitle, message: statusText,
                                          symbol: statusSymbol) {
                            if model.leadProfile?.enabled == true {
                                Button("Refresh board") { Task { await model.refreshLeadBoard() } }
                                    .buttonStyle(LeadsPrimaryButtonStyle())
                            } else {
                                Button("Set up profile", action: presentSetup)
                                    .buttonStyle(LeadsPrimaryButtonStyle())
                            }
                        }
                    }
                    .accessibilityIdentifier("leadsStatusNote")
                }

                reviewingPost

                ForEach(model.leadItems) { lead in
                    if let app = model.apps.first(where: { $0.id == lead.appId }) {
                        LeadCardView(lead: lead, app: app,
                                     isDismissing: model.leadPendingPostID == lead.postId,
                                     onPickUp: { openLead(lead) },
                                     onDismiss: { Task { await model.dismissLead(lead) } })
                            .accessibilityIdentifier("leadCard-\(lead.id)")
                        if lead.id != model.leadItems.last?.id {
                            HStack(spacing: 10) {
                                Rectangle().frame(height: 0.5)
                                Image(systemName: "sparkle").font(.system(size: 10))
                                Rectangle().frame(height: 0.5)
                            }
                            .foregroundStyle(LeadInk.rule.opacity(0.4))
                            .padding(.horizontal, 18)
                            .accessibilityHidden(true)
                        }
                    }
                }

                if model.leadItems.isEmpty && statusMessage == nil && !(visibleProgress?.shouldPoll ?? false) {
                    LeadsPinnedPaper {
                        LeadsBoardMessage(title: "No matching leads yet",
                                          message: "Leads appear when a conversation connects to a goal your app can help with.",
                                          symbol: "text.magnifyingglass") {
                            if !((model.leadAccess?.aiAvailable) ?? false) {
                                Button("Review setup") { presentSetup() }
                                    .buttonStyle(LeadsPrimaryButtonStyle())
                            } else {
                                Button("Check again") { Task { await model.refreshLeadBoard() } }
                                    .buttonStyle(LeadsPrimaryButtonStyle())
                            }
                        }
                    }
                    .accessibilityIdentifier("leadsEmpty")
                }

                if model.leadNextCursor != nil {
                    Button {
                        Task { await model.loadMoreLeads() }
                    } label: {
                        HStack(spacing: 8) {
                            if model.isLoadingMoreLeads { ProgressView().tint(QuestStyle.gold) }
                            Text(model.isLoadingMoreLeads ? "Loading more leads…" : "Load more")
                        }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .background(QuestStyle.navy.opacity(0.9), in: Capsule())
                        .overlay(Capsule().stroke(QuestStyle.gold.opacity(0.45)))
                    }
                    .disabled(model.isLoadingMoreLeads)
                    .padding(.horizontal, 12)
                }
            }
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity)
        .frame(minHeight: visibleProgress?.shouldPoll == true ? 440 : nil, alignment: .top)
        .background {
            GeometryReader { proxy in
                Image("LeadsSharedBoard")
                    .resizable(capInsets: EdgeInsets(top: 70, leading: 20, bottom: 24, trailing: 48),
                               resizingMode: .stretch)
                    .frame(width: proxy.size.width, height: proxy.size.height)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("leadsWoodBoard")
    }

    private var statusTitle: String {
        let code = model.leadProfileStatus.code.lowercased()
        if model.leadAccess?.aiAvailable == false { return "AI assessment is unavailable" }
        if model.leadProfileStatus.limited == true || code == "limited" { return "AI assessment is paused by usage limits" }
        if model.leadProfileStatus.progress?.phase == "interrupted" { return "Checking was interrupted" }
        if model.leadProfileStatus.progress?.phase == "paused" { return "Lead discovery is paused" }
        if model.leadProfileStatus.progress?.phase == "unavailable" { return "Progress is unavailable" }
        if code == "waiting" || model.leadProfileStatus.progress?.phase == "waiting" { return "Waiting for recent posts" }
        return "Checking recent posts"
    }

    private var statusText: String? {
        guard !model.isPreviewMode else { return nil }
        let code = model.leadProfileStatus.code.lowercased()
        if model.leadAccess?.aiAvailable == false {
            return "Your confirmed profile and existing leads stay here. New posts can’t be assessed while AI is unavailable."
        }
        if model.leadProfileStatus.limited == true || code == "limited" {
            return "Current AI usage limits have paused new assessments. Existing leads remain available; setup and monitoring can continue manually."
        }
        if let progress = model.leadProfileStatus.progress {
            if progress.phase == "interrupted" { return "The scan stopped before it finished. Refresh to check its status." }
            if progress.phase == "paused" { return "Your profile is saved. New assessments are paused." }
            if progress.phase == "unavailable" { return "We couldn’t confirm the current scan’s progress. You can still browse existing leads or refresh its status." }
            if progress.phase == "waiting" && model.leadItems.isEmpty { return "Your profile is saved. There isn’t an active scan for this app yet." }
            if progress.shouldPoll { return nil }
        } else if model.leadItems.isEmpty && code == "waiting" {
            return "Your profile is saved. Refresh to check for matching posts."
        }
        if model.leadProfileStatus.partial {
            return "Search coverage is limited; some relevant conversations may be missing."
        }
        return nil
    }

    private var statusMessage: String? {
        statusText
    }

    private var statusSymbol: String {
        if model.leadAccess?.aiAvailable == false { return "sparkles" }
        if model.leadProfileStatus.limited == true { return "hourglass" }
        return "text.magnifyingglass"
    }

    private func presentSetup() {
        guard let app = model.apps.first(where: { $0.id == model.selectedLeadAppID }) else {
            model.selectedTab = "apps"
            return
        }
        model.prepareLeadProfileEdit(appId: app.id)
        setupApp = app
    }

    private func openLead(_ lead: LeadItem) {
        guard let app = model.apps.first(where: { $0.id == lead.appId }) else { return }
        journalPath.append(model.journal(for: lead, appName: app.name))
    }
}

private struct LeadsLoadingPlaceholder: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let isActive: Bool

    var body: some View {
        VStack(spacing: 12) {
            LeadsPinnedPaper {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 10) {
                        if reduceMotion || !isActive {
                            Image(systemName: "hourglass")
                        } else {
                            ProgressView().tint(LeadInk.primary)
                        }
                        Text("Loading leads…")
                            .font(.system(.title3, design: .serif).weight(.bold))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .foregroundStyle(LeadInk.primary)
                    placeholderLines
                }
                .padding(.vertical, 10)
            }
            LeadsPinnedPaper {
                placeholderLines
                    .padding(.vertical, 18)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading leads")
        .accessibilityIdentifier("leadsLoading")
    }

    private var placeholderLines: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion || !isActive)) { context in
            let phase = context.date.timeIntervalSinceReferenceDate * .pi
            let opacity = reduceMotion || !isActive ? 0.12 : 0.12 + 0.06 * (sin(phase) + 1) / 2
            VStack(alignment: .leading, spacing: 12) {
                line(width: 0.36, height: 10)
                line(width: 0.92, height: 16)
                line(width: 0.72, height: 16)
                line(width: 0.84, height: 10)
            }
            .foregroundStyle(LeadInk.primary.opacity(opacity))
        }
        .accessibilityHidden(true)
    }

    private func line(width: CGFloat, height: CGFloat) -> some View {
        GeometryReader { geometry in
            RoundedRectangle(cornerRadius: 3)
                .frame(width: geometry.size.width * width)
        }
        .frame(height: height)
    }
}

private struct LeadsScanBar: View {
    let fraction: Double?
    let moving: Bool
    let reduceMotion: Bool

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Color(red: 0.07, green: 0.20, blue: 0.30))
                if let fraction {
                    Capsule().fill(QuestStyle.gold)
                        .frame(width: geometry.size.width * fraction)
                        .shadow(color: QuestStyle.gold.opacity(0.35), radius: 3)
                        .animation(reduceMotion ? nil : .easeInOut(duration: 0.65), value: fraction)
                } else if moving {
                    // Collection has no known denominator. Sweep instead of inventing completion.
                    TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
                        let cycle = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.8) / 1.8
                        Capsule().fill(QuestStyle.gold)
                            .frame(width: geometry.size.width * 0.25)
                            .offset(x: reduceMotion ? geometry.size.width * 0.35 : geometry.size.width * (cycle * 1.25 - 0.25))
                    }
                }
            }
            .clipShape(Capsule())
            .overlay(Capsule().stroke(Color(red: 0.19, green: 0.38, blue: 0.55), lineWidth: 0.5))
        }
        .accessibilityHidden(true)
    }
}

private enum LeadInk {
    static let primary = Color(red: 0.075, green: 0.15, blue: 0.23)
    static let secondary = Color(red: 0.24, green: 0.31, blue: 0.37)
    static let rule = Color(red: 0.76, green: 0.54, blue: 0.13)
    static let fit = Color(red: 0.45, green: 0.27, blue: 0.04)
}

private struct LeadsPinnedPaper<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 18)
            .padding(.vertical, 10)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct LeadAppArtwork: View {
    let app: ConnectedApp
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 28

    init(app: ConnectedApp, size: CGFloat) {
        self.app = app
        _size = ScaledMetric(wrappedValue: size, relativeTo: .body)
    }

    var body: some View {
        Group {
            if let asset = app.bundledIconName {
                Image(asset).resizable().scaledToFill()
            } else {
                AsyncImage(url: app.iconUrl.flatMap(URL.init(string:))) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Image(systemName: "app.fill")
                        .resizable().scaledToFit().foregroundStyle(QuestStyle.gold)
                }
            }
        }
        .frame(width: min(size, 44), height: min(size, 44))
        .clipShape(RoundedRectangle(cornerRadius: 5))
        .accessibilityHidden(true)
    }
}

private struct LeadsBoardMessage<Actions: View>: View {
    let title: String
    let message: String
    let symbol: String
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: symbol)
                .font(.system(.title3, design: .serif).weight(.bold))
                .foregroundStyle(LeadInk.primary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text(message)
                .font(.body)
                .foregroundStyle(LeadInk.secondary)
                .fixedSize(horizontal: false, vertical: true)
            actions
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct LeadCardView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let lead: LeadItem
    let app: ConnectedApp
    let isDismissing: Bool
    let onPickUp: () -> Void
    let onDismiss: () -> Void

    @ScaledMetric(relativeTo: .body) private var titleSize = 16
    @ScaledMetric(relativeTo: .subheadline) private var bodySize = 14
    @ScaledMetric(relativeTo: .footnote) private var fitSize = 13
    @ScaledMetric(relativeTo: .caption) private var metadataSize = 12

    var body: some View {
        LeadsPinnedPaper {
            VStack(alignment: .leading, spacing: 10) {
                Group {
                    if dynamicTypeSize.isAccessibilitySize {
                        VStack(alignment: .leading, spacing: 3) {
                            communityLabel
                            Text(ageDescription)
                                .font(.system(size: metadataSize))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    } else {
                        HStack(alignment: .center, spacing: 6) {
                            communityLabel
                            Spacer(minLength: 4)
                            Text(ageDescription)
                                .font(.system(size: metadataSize))
                                .lineLimit(1)
                                .layoutPriority(1)
                        }
                    }
                }
                .foregroundStyle(LeadInk.secondary)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Reddit, r/\(lead.community), \(ageDescription)")

                Text(lead.title)
                    .font(.system(size: titleSize, weight: .semibold))
                    .foregroundStyle(LeadInk.primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)

                Text(lead.excerpt)
                    .font(.system(size: bodySize))
                    .foregroundStyle(LeadInk.secondary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(alignment: .top, spacing: 8) {
                    LeadAppArtwork(app: app, size: 22)
                    Text("Matches: \(lead.whyItFits)")
                        .font(.system(size: fitSize))
                        .foregroundStyle(LeadInk.secondary)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                        .truncationMode(.tail)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(app.name). AI-assessed fit. \(lead.whyItFits)")

                let actionsLayout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(spacing: 6))
                    : AnyLayout(HStackLayout(spacing: 6))
                actionsLayout {
                    Button(action: onPickUp) {
                        HStack(spacing: 5) {
                            Image(systemName: "arrow.up.right").accessibilityHidden(true)
                            Text("Pick Up Quest")
                                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                                .minimumScaleFactor(0.9)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .font(.system(size: fitSize, weight: .semibold))
                        .foregroundStyle(QuestStyle.gold)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .padding(.horizontal, 7)
                        .padding(.vertical, dynamicTypeSize.isAccessibilitySize ? 6 : 0)
                        .background(QuestStyle.navy, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(LeadInk.rule, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .disabled(isDismissing)
                    .accessibilityIdentifier("leadPickUp-\(lead.id)")

                    Button(action: onDismiss) {
                        Label("Not relevant", systemImage: "xmark")
                            .font(.system(size: fitSize, weight: .medium))
                            .foregroundStyle(LeadInk.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(minWidth: 44, maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : 108, minHeight: 44)
                    }
                    .buttonStyle(.plain)
                    .disabled(isDismissing)
                    .accessibilityIdentifier("leadDismiss-\(lead.id)")
                }
            }
            .foregroundStyle(LeadInk.primary)
            .overlay {
                if isDismissing {
                    ProgressView().tint(LeadInk.primary).padding(12)
                        .background(Color.white.opacity(0.86), in: Capsule())
                }
            }
        }
    }

    private var communityLabel: some View {
        HStack(alignment: .center, spacing: 7) {
            Image("RedditLogo").resizable().scaledToFit()
                .frame(width: 18, height: 18)
                .accessibilityHidden(true)
            Text("r/\(lead.community)")
                .font(.system(size: metadataSize, weight: .semibold))
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var ageDescription: String {
        guard let date = Timestamp.date(lead.createdAt) else { return "recent" }
        let minutes = max(0, Int(Date().timeIntervalSince(date) / 60))
        if minutes < 1 { return "just now" }
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h ago" }
        let days = hours / 24
        if days == 1 { return "1d ago" }
        return "\(days)d ago"
    }
}

private struct LeadsPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.bold))
            .foregroundStyle(QuestStyle.gold)
            .padding(.horizontal, 17)
            .frame(minHeight: 48)
            .background(QuestStyle.navy, in: RoundedRectangle(cornerRadius: 13))
            .overlay(RoundedRectangle(cornerRadius: 13).stroke(LeadInk.rule, lineWidth: 1.3))
            .opacity(configuration.isPressed ? 0.82 : 1)
    }
}
