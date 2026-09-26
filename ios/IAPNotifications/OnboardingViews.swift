import SwiftUI
import UIKit
import UserNotifications

enum QuestPageInk {
    static let navy = Color(red: 0.035, green: 0.12, blue: 0.19)
    static let secondary = Color(red: 0.29, green: 0.36, blue: 0.40)
    static let gold = Color(red: 0.76, green: 0.53, blue: 0.12)
    static let lightGold = Color(red: 1, green: 0.80, blue: 0.34)
    static let rule = Color(red: 0.70, green: 0.64, blue: 0.51)
    static let paper: Image = {
        guard let image = UIImage(named: "QuestJournalPaper"), let pixels = image.cgImage else { return Image("QuestJournalPaper") }
        return Image(uiImage: UIImage(cgImage: pixels, scale: CGFloat(pixels.width) / 390, orientation: .up))
    }()
}

/// The journal fills the same viewport on every step; only its contents scroll.
struct QuestJournalPage<Content: View, Footer: View>: View {
    let backTitle: String
    let back: () -> Void
    var spacing: CGFloat = 24
    var contentLeading: CGFloat = 68
    var footerBottom: CGFloat = 24
    @ViewBuilder var content: Content
    @ViewBuilder var footer: Footer

    var body: some View {
        VStack(spacing: 8) {
            Button(action: back) {
                Label(backTitle, systemImage: "chevron.left")
                    .font(.title3.weight(.semibold))
                    .lineLimit(1).minimumScaleFactor(0.65)
                    .foregroundStyle(QuestPageInk.lightGold)
                    .shadow(color: .black.opacity(0.75), radius: 3, y: 1)
                    .padding(.horizontal, 18)
                    .frame(height: 48, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("onboarding.back")
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: spacing) { content }
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                        .padding(.leading, contentLeading)
                        .padding(.trailing, 28)
                        .padding(.top, 26)
                        .padding(.bottom, 16)
                }
                .scrollDismissesKeyboard(.interactively)
                .scrollIndicators(.hidden)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                footer
                    .padding(.leading, 48)
                    .padding(.trailing, 28)
                    .padding(.top, 12)
                    .padding(.bottom, footerBottom)
                    .layoutPriority(1)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background {
                QuestPageInk.paper.resizable(capInsets: EdgeInsets(top: 64, leading: 64, bottom: 24, trailing: 14), resizingMode: .stretch)
                    .accessibilityHidden(true)
            }
            .padding(.bottom, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            GeometryReader { geometry in
                // The source fades to navy at the bottom; display its illustrated portion here.
                Image("QuestLandscape").resizable()
                    .frame(width: geometry.size.width, height: geometry.size.height * 1.85)
                    .offset(y: -geometry.size.height * 0.18)
                    .frame(height: geometry.size.height, alignment: .top).clipped()
            }.ignoresSafeArea().accessibilityHidden(true)
        }
        .foregroundStyle(QuestPageInk.navy)
        .tint(QuestPageInk.gold)
        .preferredColorScheme(.light)
    }
}

/// Reserve identical action slots even when a step has no caption or secondary action.
private struct QuestJournalFooter<Primary: View, Secondary: View>: View {
    var caption: String? = nil
    var compact = false
    @ViewBuilder var primary: Primary
    @ViewBuilder var secondary: Secondary
    @ScaledMetric(relativeTo: .headline) private var primaryHeight = 52
    @ScaledMetric(relativeTo: .footnote) private var captionHeight = 40
    @ScaledMetric(relativeTo: .subheadline) private var secondaryHeight = 44

    var body: some View {
        VStack(spacing: 4) {
            ZStack { Color.clear; primary }.frame(height: primaryHeight)
            // Measure the longest disclosure on every page so larger text never truncates it.
            if !compact || caption != nil {
                Text("No payment details. No automatic charge.")
                .font(.footnote)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, minHeight: captionHeight)
                .hidden().accessibilityHidden(true)
                .overlay {
                    if let caption {
                        Text(caption).font(.footnote).foregroundStyle(QuestPageInk.secondary)
                            .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            ZStack { Color.clear; secondary }.frame(height: secondaryHeight)
        }
    }
}

struct QuestPageTitle: View {
    let eyebrow: String
    let title: String
    var singleLine = false
    var eyebrowLeading: CGFloat = 0
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .largeTitle) private var size = 34
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 16) {
                Text(eyebrow.uppercased()).font(.system(.footnote, design: .serif, weight: .semibold)).tracking(1.6).layoutPriority(1)
                Rectangle().fill(QuestPageInk.rule.opacity(0.4)).frame(height: 0.5)
            }.padding(.leading, eyebrowLeading)
            if !title.isEmpty {
                Text(title).font(.system(size: size, weight: .bold, design: .serif))
                    .lineLimit(singleLine && !typeSize.isAccessibilitySize ? 1 : nil).minimumScaleFactor(0.75)
                    .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
            }
        }
    }
}

struct QuestPageRule: View {
    var body: some View {
        HStack(spacing: 8) {
            Rectangle().frame(height: 0.5)
            Image(systemName: "sparkle").font(.system(size: 9))
            Rectangle().frame(height: 0.5)
        }.foregroundStyle(QuestPageInk.rule.opacity(0.65)).accessibilityHidden(true)
    }
}

struct QuestPageButton: View {
    let title: String
    var symbol: String? = nil
    var symbolLeading = false
    var busy = false
    var disabled = false
    let action: () -> Void
    @ScaledMetric(relativeTo: .headline) private var height = 52
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                if busy { ProgressView().tint(QuestPageInk.lightGold) }
                if let symbol, symbolLeading, !busy { Image(systemName: symbol) }
                Text(title).font(.headline)
                if let symbol, !symbolLeading, !busy { Image(systemName: symbol) }
            }
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, minHeight: height)
            .padding(.horizontal, 12)
            .foregroundStyle(QuestPageInk.lightGold)
            .background(QuestPageInk.navy, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(QuestPageInk.gold, lineWidth: 1.5))
            .opacity(disabled ? 0.55 : 1)
        }.buttonStyle(.plain).disabled(disabled || busy)
    }
}

private struct QuestPageError: View {
    let message: String?
    var body: some View {
        if let message {
            Label(message, systemImage: "exclamationmark.circle")
                .font(.footnote).foregroundStyle(QuestPageInk.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("onboarding.error")
        }
    }
}

private struct QuestAppIcon: View {
    let iconURL: String?
    let bundledName: String?
    var size: CGFloat = 44
    var body: some View {
        Group {
            if let bundledName { Image(bundledName).resizable().scaledToFit() }
            else {
                AsyncImage(url: iconURL.flatMap(URL.init(string:))) { image in image.resizable().scaledToFit() }
                placeholder: { Image(systemName: "app").resizable().scaledToFit().padding(8).foregroundStyle(QuestPageInk.gold) }
            }
        }.frame(width: size, height: size).clipShape(RoundedRectangle(cornerRadius: size * 0.22)).accessibilityHidden(true)
    }
}

private struct QuestCommunity: View {
    let name: String
    var locked = false
    var body: some View {
        HStack(spacing: 12) {
            Image("RedditLogo").resizable().scaledToFit().frame(width: 34, height: 34).accessibilityHidden(true)
            Text("r/\(name)").font(.headline).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if locked { Image(systemName: "lock.fill").foregroundStyle(QuestPageInk.gold).accessibilityLabel("Locked quest") }
        }
    }
}

struct QuestOnboardingView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var billing: MarketingStore
    private var stage: OnboardingStage { model.onboarding?.stage ?? .app }
    var body: some View {
        Group {
            switch stage {
            case .app: FindQuestAppPage()
            case .quest:
                if billing.subscription == nil && !billing.simulatesNoPurchase && !model.isPreviewMode { MarketingConnectionView() }
                else if !model.isPreviewMode && !billing.canAccess(appID: model.selectedLeadAppID ?? "") { MoreQuestsPage(startResearch: true) }
                else { LoadQuestPage() }
            case .first:
                if billing.subscription == nil && !billing.simulatesNoPurchase && !model.isPreviewMode { MarketingConnectionView() }
                else if !model.isPreviewMode && !billing.canAccess(appID: model.selectedLeadAppID ?? "") { MoreQuestsPage(startResearch: true) }
                else if let lead = model.leadItems.first,
                   let app = model.apps.first(where: { $0.id == model.selectedLeadAppID }) {
                    FirstQuestPage(session: model.journal(for: lead, appName: app.name), app: app)
                } else { FindingFirstQuestPage() }
            case .trial: QuestTrialEntryPage()
            case .notifications: SalesConnectionPage()
            case .complete: EmptyView()
            }
        }
        .id(stage)
        .task(id: "\(model.selectedLeadAppID ?? "")|\(stage.rawValue)") {
            guard stage == .first, model.isPreviewMode || billing.subscription != nil && billing.canAccess(appID: model.selectedLeadAppID ?? "") else { return }
            while !Task.isCancelled {
                await model.refreshLeadBoard(background: true)
                do { try await Task.sleep(for: .seconds(6)) } catch { return }
            }
        }
    }
}

private struct FindQuestAppPage: View {
    @EnvironmentObject private var model: AppModel
    @State private var query = ""
    @State private var results: [AppStoreMatch] = []
    @State private var selected: AppStoreMatch?
    @State private var searched = false
    @State private var searching = false
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        QuestJournalPage(backTitle: "Back", back: { finish() }) {
            QuestPageTitle(eyebrow: model.isPreviewMode ? "Your app · Sample" : "Your app", title: "Find your app")
            VStack(alignment: .leading, spacing: 10) {
                Text("App name or App Store link").font(.subheadline).foregroundStyle(QuestPageInk.secondary)
                HStack(spacing: 12) {
                    Image(systemName: "magnifyingglass").font(.title2)
                    TextField("Search the App Store", text: $query)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                        .submitLabel(.search).focused($focused).onSubmit { focused = false }
                        .accessibilityIdentifier("onboarding.appSearch")
                    if !query.isEmpty {
                        Button { query = ""; selected = nil } label: { Image(systemName: "xmark.circle.fill") }
                            .foregroundStyle(QuestPageInk.secondary).frame(minWidth: 44, minHeight: 44).accessibilityLabel("Clear search")
                    }
                }
                .padding(.leading, 12).padding(.trailing, 4).frame(minHeight: 48)
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(QuestPageInk.secondary, lineWidth: 1))
            }.padding(.top, 8)
            QuestPageRule()
            if searching { ProgressView("Searching the App Store…").font(.subheadline) }
            ForEach(results) { match in
                Button {
                    selected = match; focused = false
                } label: {
                    HStack(spacing: 14) {
                        QuestAppIcon(iconURL: match.iconUrl, bundledName: match.bundledIconName, size: 46)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(match.name).font(.headline)
                            if let developer = match.developer { Text(developer).font(.footnote).foregroundStyle(QuestPageInk.secondary) }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: selected?.id == match.id ? "checkmark.circle.fill" : "circle")
                            .font(.title2).foregroundStyle(QuestPageInk.gold)
                    }.frame(minHeight: 52).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityAddTraits(selected?.id == match.id ? .isSelected : [])
                QuestPageRule()
            }
            if searched && !searching && results.isEmpty && error == nil {
                Text("No apps found. Try the App Store link.").font(.subheadline).foregroundStyle(QuestPageInk.secondary)
            }
            QuestPageError(message: error ?? model.onboardingError)
            if model.onboardingError != nil {
                Button("Retry connection") { Task { await model.loadOnboarding() } }.frame(minHeight: 44)
            }
        } footer: {
            QuestJournalFooter {
                QuestPageButton(title: "Continue", symbol: "arrow.right", busy: busy, disabled: selected == nil || model.onboardingError != nil) {
                    guard let selected else { return }
                    busy = true
                    Task {
                        do { try await model.chooseOnboardingApp(selected) }
                        catch { self.error = error.localizedDescription }
                        busy = false
                    }
                }.accessibilityIdentifier("onboarding.continue")
            } secondary: { EmptyView() }
        }
        .task {
            results = model.apps.map(AppStoreMatch.init)
            if model.isPreviewMode { query = "Orbit Journal"; selected = results.first }
        }
        .task(id: query) {
            let input = query.trimmingCharacters(in: .whitespacesAndNewlines)
            guard input.count >= 2 else { results = model.apps.map(AppStoreMatch.init); searched = false; searching = false; return }
            searching = true; error = nil
            do {
                try await Task.sleep(for: .milliseconds(400))
                let matches = try await model.searchOnboardingApps(input)
                try Task.checkCancellation()
                results = matches; searched = true; searching = false
                if !matches.contains(where: { $0.id == selected?.id }) { selected = nil }
            } catch is CancellationError { }
            catch { if !Task.isCancelled { self.error = error.localizedDescription; searching = false } }
        }
    }
    private func finish() {
        Task { do { try await model.moveOnboarding(to: .notifications) } catch { self.error = error.localizedDescription } }
    }
}

private struct LoadQuestPage: View {
    @EnvironmentObject private var model: AppModel
    @State private var problems = ""
    @State private var capabilities = ""
    @State private var communities = ""
    @State private var draftID: String?
    @State private var editing = false
    @State private var loading = true
    @State private var busy = false
    @State private var error: String?
    private var app: ConnectedApp? { model.apps.first { $0.id == model.selectedLeadAppID } }
    private var problemRows: [String] { rows(problems) }
    private var capabilityRows: [String] { rows(capabilities) }
    private var communityRows: [String] {
        Array(Set(communities.split(whereSeparator: { $0 == "," || $0.isNewline }).map {
            $0.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "r/", with: "").lowercased()
        }.filter { !$0.isEmpty })).sorted()
    }
    private var valid: Bool {
        !problemRows.isEmpty && problemRows.count <= 8 && !capabilityRows.isEmpty && capabilityRows.count <= 8 &&
        (problemRows + capabilityRows).allSatisfy { (3...240).contains($0.count) } && !communityRows.isEmpty && communityRows.count <= 10 &&
        communityRows.allSatisfy { $0.range(of: "^[a-z0-9_]{2,21}$", options: .regularExpression) != nil }
    }
    var body: some View {
        QuestJournalPage(backTitle: "Back", back: { move(.app) }) {
            QuestPageTitle(eyebrow: model.isPreviewMode ? "Your quest · Sample" : "Your quest", title: "")
            HStack(spacing: 12) {
                QuestAppIcon(iconURL: app?.iconUrl, bundledName: app?.bundledIconName)
                Text(app?.name ?? "Your app").font(.system(.title, design: .serif, weight: .bold))
                Spacer(minLength: 0)
                if !loading { Button(editing ? "Done" : "Edit") { editing.toggle() }.font(.subheadline).frame(minHeight: 44) }
            }
            if loading {
                Spacer(minLength: 20)
                ProgressView("Loading your quest…").font(.subheadline)
                Text("Reading your app’s description.").font(.footnote).foregroundStyle(QuestPageInk.secondary)
            } else if editing {
                field("The problem", text: $problems, prompt: "What problem does your app solve?")
                field("Your app helps", text: $capabilities, prompt: "What can your app do?")
                field("Where to look", text: $communities, prompt: "journaling, productivity")
                Text("One problem or capability per line. Separate communities with commas.").font(.footnote).foregroundStyle(QuestPageInk.secondary)
            } else {
                section("The problem", text: problemRows.joined(separator: "\n\n"))
                section("Your app helps", text: capabilityRows.joined(separator: "\n\n"))
                QuestPageRule()
                Text("Where to look").font(.system(.title2, design: .serif, weight: .bold))
                ForEach(communityRows, id: \.self) { QuestCommunity(name: $0) }
            }
            QuestPageError(message: error)
            if !loading && model.leadAccess?.enabled == false {
                Text("Discovery is not available for this account yet. You can still set up sales alerts.").font(.subheadline).foregroundStyle(QuestPageInk.secondary)
            }
        } footer: {
            QuestJournalFooter {
                QuestPageButton(title: "Continue", symbol: "arrow.right", busy: busy, disabled: loading || !valid || model.leadAccess?.enabled == false) { save() }
            } secondary: {
                Button("Set up sales alerts instead") { move(.notifications) }.font(.footnote).frame(maxWidth: .infinity, minHeight: 44)
            }
        }
        .task {
            await model.refreshLeadBoard()
            if let profile = model.leadProfile {
                problems = profile.problems.map(\.text).joined(separator: "\n")
                capabilities = profile.capabilities.map(\.text).joined(separator: "\n")
                communities = Array(Set(profile.communities.map { $0.lowercased() })).joined(separator: ", ")
            } else if let app {
                await model.requestLeadDraft(appId: app.id)
                guard !Task.isCancelled else { return }
                if let draft = model.leadDraft {
                    draftID = draft.id
                    problems = draft.problems.map(\.text).joined(separator: "\n")
                    capabilities = draft.capabilities.map(\.text).joined(separator: "\n")
                    communities = draft.suggestedCommunities.joined(separator: ", ")
                } else { editing = true; error = model.leadSetupMessage ?? model.leadBoardError }
            }
            loading = false
        }
        .onDisappear { if let app { model.cancelLeadDraftPolling(appId: app.id) } }
    }
    private func rows(_ text: String) -> [String] { text.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty } }
    private func section(_ title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.system(.title2, design: .serif, weight: .bold))
            Text(text).font(.body).foregroundStyle(QuestPageInk.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }
    private func field(_ title: String, text: Binding<String>, prompt: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.headline)
            TextField(prompt, text: text, axis: .vertical).lineLimit(2...5).padding(12)
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(QuestPageInk.rule, lineWidth: 1))
        }
    }
    private func move(_ stage: OnboardingStage) { Task { do { try await model.moveOnboarding(to: stage) } catch { self.error = error.localizedDescription } } }
    private func save() {
        guard let app, valid else { return }
        busy = true; error = nil
        Task {
            do {
                if !model.isPreviewMode {
                    try await model.saveLeadProfile(appId: app.id, request: LeadProfileSaveRequest(
                        expectedRevision: model.leadProfile?.revision ?? 0, enabled: true,
                        problems: problemRows.map { LeadProfileRowInput(text: $0) }, capabilities: capabilityRows.map { LeadProfileRowInput(text: $0) },
                        communities: communityRows, keywords: model.leadProfile?.keywords ?? [], draftId: draftID))
                }
                try await model.moveOnboarding(to: .first)
            } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}

private struct FindingFirstQuestPage: View {
    @EnvironmentObject private var model: AppModel
    @State private var error: String?
    private var paused: Bool { model.leadProfileStatus.limited == true || model.leadProfileStatus.progress?.phase == "paused" }
    private var interrupted: Bool { ["interrupted", "unavailable"].contains(model.leadProfileStatus.progress?.phase ?? "") }
    private var working: Bool { !paused && !interrupted && (model.isLoadingLeadBoard || model.leadProfileStatus.progress?.shouldPoll == true) }
    private var title: String {
        if model.leadBoardError != nil { return "Couldn’t load quests" }
        if paused { return "Quest search paused" }
        if interrupted { return "Quest search interrupted" }
        return working ? "Finding your first quest" : "No matches yet"
    }
    var body: some View {
        QuestJournalPage(backTitle: "Your quest", back: { move(.quest) }, spacing: 12) {
            QuestPageTitle(eyebrow: model.isPreviewMode ? "Your first quest · Sample" : "Your first quest", title: title)
            if working { ProgressView("Finding relevant posts…").font(.subheadline) }
            else if paused { Text("Your profile is saved. Discovery is temporarily paused.").foregroundStyle(QuestPageInk.secondary) }
            else if interrupted { Text("The search hasn’t finished. Check back shortly.").foregroundStyle(QuestPageInk.secondary) }
            else if model.leadBoardError == nil { Text("We’ll keep looking with your app’s criteria.").foregroundStyle(QuestPageInk.secondary) }
            if let profile = model.leadProfile {
                QuestPageRule()
                Text("Where to look").font(.system(.title2, design: .serif, weight: .bold))
                ForEach(Array(Set(profile.communities.map { $0.lowercased() })).sorted(), id: \.self) { QuestCommunity(name: $0) }
            }
            if let fraction = model.leadProfileStatus.progress?.fraction, working {
                ProgressView(value: fraction).tint(QuestPageInk.gold)
            }
            QuestPageError(message: error ?? model.leadBoardError)
            if model.leadBoardError != nil { Button("Try again") { Task { await model.refreshLeadBoard() } }.frame(minHeight: 44) }
        } footer: {
            QuestJournalFooter(caption: paused || interrupted ? "You can continue into the app." : "You can carry on while we search.") {
                QuestPageButton(title: "Continue", symbol: "arrow.right") { move(.notifications) }
            } secondary: { EmptyView() }
        }
    }
    private func move(_ stage: OnboardingStage) { Task { do { try await model.moveOnboarding(to: stage) } catch { self.error = error.localizedDescription } } }
}

private struct FirstQuestPage: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var billing: MarketingStore
    @Environment(\.openURL) private var openURL
    @ObservedObject var session: LeadJournalSession
    let app: ConnectedApp
    @State private var editingID: String?
    @State private var sourceNotice = false
    @State private var error: String?
    @ScaledMetric(relativeTo: .title) private var titleSize = 29

    var body: some View {
        QuestJournalPage(backTitle: "Your quest", back: { move(.quest) }, spacing: 12) {
            QuestPageTitle(eyebrow: model.isPreviewMode ? "Your first quest · Sample" : "Your first quest", title: "")
            QuestCommunity(name: session.lead.community)
            Text(session.lead.title).font(.system(size: titleSize, weight: .bold, design: .serif)).fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
            Text(session.lead.excerpt).foregroundStyle(QuestPageInk.secondary).fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .top, spacing: 10) {
                QuestAppIcon(iconURL: app.iconUrl, bundledName: app.bundledIconName, size: 28)
                Text("Matches: \(session.lead.whyItFits)").font(.subheadline).foregroundStyle(QuestPageInk.secondary)
            }
            QuestPageRule()
            HStack(spacing: 10) {
                Image("JournalQuill").resizable().scaledToFit().frame(width: 24, height: 28).foregroundStyle(QuestPageInk.gold).accessibilityHidden(true)
                Text("Choose your words").font(.system(.title2, design: .serif, weight: .bold))
            }
            if session.isLoading { ProgressView("Preparing your replies…").font(.subheadline) }
            if let plan = session.plan {
                ForEach(Array(plan.replies.enumerated()), id: \.element.id) { index, reply in
                    replyRow(reply, number: index + 1)
                }
            }
            QuestPageError(message: session.error ?? error)
            if session.error != nil { Button("Retry replies") { Task { await model.prepareJournal(session) } }.frame(minHeight: 44) }
        } footer: {
            QuestJournalFooter(caption: billing.isEnabled ? "Review your reply before posting." : "This quest stays free.") {
                if session.onboardingSelection.copiedID != nil {
                    QuestPageButton(title: "Open post", symbol: "arrow.up.right", action: openPost)
                        .accessibilityIdentifier("onboarding.openPost")
                } else {
                    Button(action: openPost) { Label("View original post", systemImage: "arrow.up.right").font(.headline).frame(maxWidth: .infinity, minHeight: 48) }
                }
            } secondary: {
                HStack {
                    Label(billing.hasActiveSubscription ? "Your marketing is ready" : (model.lockedQuests?.title ?? "More quests"), systemImage: billing.hasActiveSubscription ? "checkmark" : "lock.fill").font(.subheadline.weight(.semibold))
                    Spacer(minLength: 4)
                    Button(billing.hasActiveSubscription ? "Continue ›" : "Explore ›") { move(billing.hasActiveSubscription ? .notifications : .trial) }.font(.subheadline.weight(.semibold)).frame(minHeight: 44)
                        .accessibilityIdentifier("onboarding.explore")
                }
            }
        }
        .task {
            await model.prepareJournal(session)
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--onboarding-copied"), let reply = session.plan?.replies.first { session.onboardingSelection.copied(reply.id) }
            #endif
        }
        .alert(model.isPreviewMode ? "Sample quest" : "Post unavailable", isPresented: $sourceNotice) {
            Button("OK", role: .cancel) { }
        } message: { Text(model.isPreviewMode ? "This is an offline example. Your real quests open the original Reddit post." : "This post can no longer be opened. Your reply is still available to copy.") }
    }

    private func replyRow(_ reply: LeadReplyOption, number: Int) -> some View {
        let expanded = session.onboardingSelection.expandedID == reply.id
        let copied = session.onboardingSelection.copiedID == reply.id
        return VStack(alignment: .leading, spacing: 12) {
            Button { session.onboardingSelection.toggle(reply.id); editingID = nil } label: {
                HStack(spacing: 16) {
                    Text("\(number)").font(.title2.weight(.medium)).frame(width: 34, height: 34)
                        .overlay(Circle().stroke(copied || expanded ? QuestPageInk.gold : QuestPageInk.secondary, lineWidth: 2))
                        .foregroundStyle(copied || expanded ? QuestPageInk.gold : QuestPageInk.secondary)
                    Text("Reply \(number)").font(.headline)
                    Spacer(minLength: 0)
                    if copied { Text("Copied").font(.caption).foregroundStyle(QuestPageInk.secondary) }
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.subheadline)
                }.frame(minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityValue(expanded ? "Expanded" : copied ? "Copied, collapsed" : "Collapsed")
                .accessibilityIdentifier("onboarding.reply.\(number)")
            if expanded {
                VStack(alignment: .leading, spacing: 12) {
                    if editingID == reply.id {
                        TextField("Your reply", text: Binding(get: { session.drafts[reply.id] ?? reply.body }, set: { session.drafts[reply.id] = $0 }), axis: .vertical)
                            .lineLimit(4...12).padding(10).overlay(RoundedRectangle(cornerRadius: 8).stroke(QuestPageInk.rule))
                    } else {
                        Text(session.drafts[reply.id] ?? reply.body).foregroundStyle(QuestPageInk.secondary)
                            .fixedSize(horizontal: false, vertical: true).padding(.leading, 12)
                            .overlay(alignment: .leading) { Rectangle().fill(QuestPageInk.gold).frame(width: 2) }
                    }
                    Button(editingID == reply.id ? "Done editing" : "Edit reply") { editingID = editingID == reply.id ? nil : reply.id }.font(.footnote).frame(minHeight: 44)
                    QuestPageButton(title: "Use this reply", symbol: "doc.on.doc", disabled: (session.drafts[reply.id] ?? reply.body).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                        UIPasteboard.general.string = session.drafts[reply.id] ?? reply.body
                        session.selectedID = reply.id
                        session.onboardingSelection.copied(reply.id); editingID = nil
                        UIAccessibility.post(notification: .announcement, argument: "Reply copied. Open post is ready.")
                    }.padding(.leading, -20).accessibilityIdentifier("onboarding.copyReply.\(number)")
                }.padding(.leading, 50)
            }
        }
    }
    private func openPost() {
        switch LeadURL.destination(for: session.lead) {
        case .reddit(let url): openURL(url)
        case .sampleExplanation, .unavailable: sourceNotice = true
        }
    }
    private func move(_ stage: OnboardingStage) { Task { do { try await model.moveOnboarding(to: stage) } catch { self.error = error.localizedDescription } } }
}

struct MoreQuestsPage: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    var standalone = false
    var startResearch = false
    @State private var error: String?
    var body: some View {
        MarketingPaywallView(onClose: { finish(research: false) }, onSubscribed: { finish(research: startResearch) })
            .alert("Couldn’t continue", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK") { error = nil }
            } message: { Text(error ?? "Please try again.") }
    }
    private func finish(research: Bool) {
        if standalone { dismiss(); return }
        Task {
            do { try await model.moveOnboarding(to: research ? .quest : .notifications) }
            catch { self.error = error.localizedDescription }
        }
    }
}

private struct QuestTrialEntryPage: View {
    @EnvironmentObject private var model: AppModel
    private var app: ConnectedApp? { model.apps.first { $0.id == model.onboarding?.appId } }
    var body: some View {
        if let app, !model.phoneAlertsReady, !model.connectionProgress(for: app).pushPromptSeen {
            QuestPushPermissionPage(app: app)
        } else { MoreQuestsPage() }
    }
}

private struct QuestPushPermissionPage: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    let app: ConnectedApp
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        QuestJournalPage(backTitle: "Back", back: {
            Task { do { try await model.moveOnboarding(to: .first) } catch { self.error = error.localizedDescription } }
        }) {
            QuestPageTitle(eyebrow: "Stay in the loop", title: "Catch your next opportunity")
            Text("New matches and store events, right on your phone.").foregroundStyle(QuestPageInk.secondary)
            QuestPageRule()
            VStack(alignment: .leading, spacing: 24) {
                notificationExample(symbol: "bubble.left.and.bubble.right", title: "A new buying signal", detail: "Someone is looking for an app like yours.")
                notificationExample(symbol: "bell.badge", title: "A new sale for \(app.name)", detail: "Sales, renewals, and refunds after you connect your store.")
            }
            Text("Example notifications").font(.caption).foregroundStyle(QuestPageInk.secondary)
            QuestPageError(message: error ?? model.pushError)
        } footer: {
            QuestJournalFooter(compact: true) {
                QuestPageButton(title: model.permissionStatus == .denied ? "Open Settings" : "Enable notifications", symbol: "bell", busy: busy || model.isRegisteringDevice) {
                    if model.isPreviewMode { continueFlow(); return }
                    if model.permissionStatus == .denied, let url = URL(string: UIApplication.openSettingsURLString) {
                        openURL(url); return
                    }
                    busy = true
                    Task {
                        await model.enableNotifications()
                        busy = false
                        if model.pushError == nil { continueFlow() }
                    }
                }.accessibilityIdentifier("onboarding.enablePush")
            } secondary: {
                Button("Not now") { continueFlow() }.frame(maxWidth: .infinity, minHeight: 44)
                    .accessibilityIdentifier("onboarding.skipPush")
            }
        }
        .onChange(of: model.phoneAlertsReady) { _, ready in if ready { continueFlow() } }
    }

    private func continueFlow() {
        model.updateConnectionProgress(for: app) { $0.pushPromptSeen = true }
    }

    private func notificationExample(symbol: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol).font(.title2).foregroundStyle(QuestPageInk.gold).frame(width: 30)
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.headline)
                Text(detail).font(.subheadline).foregroundStyle(QuestPageInk.secondary)
            }
        }
    }
}

struct SalesConnectionPage: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var billing: MarketingStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var typeSize
    var appID: String? = nil
    var standalone = false
    @State private var access: DashboardAccess?
    @State private var busy = false
    @State private var copied = false
    @State private var error: String?
    private var app: ConnectedApp? { model.apps.first { $0.id == (appID ?? model.onboarding?.appId) } }

    var body: some View {
        Group {
            if let app {
                if !standalone && !model.phoneAlertsReady && !model.connectionProgress(for: app).pushPromptSeen {
                    QuestPushPermissionPage(app: app)
                } else { connectionPage(app) }
            } else {
                QuestJournalPage(backTitle: "Back", back: { back(nil) }) {
                    QuestPageTitle(eyebrow: "Sales alerts", title: "Choose your app first")
                    Text("Find your app to get its store connection URL.").foregroundStyle(QuestPageInk.secondary)
                    QuestPageError(message: error)
                } footer: {
                    QuestJournalFooter {
                        QuestPageButton(title: "Find your app") {
                            Task { do { try await model.moveOnboarding(to: .app); if standalone { dismiss() } } catch { self.error = error.localizedDescription } }
                        }
                    } secondary: { Button("Set up later") { finish() }.frame(minHeight: 44) }
                }
            }
        }
        .sheet(item: $access, onDismiss: { Task { await model.loadApps() } }) { DashboardSheet(access: $0) }
        .task(id: "\(app?.id ?? "")|\(app.map { model.connectionProgress(for: $0).step.rawValue } ?? "")|\(scenePhase == .active)") {
            guard !model.isPreviewMode, scenePhase == .active, let app,
                  model.connectionProgress(for: app).step == .status, !app.hasVerifiedProductionConnection else { return }
            while !Task.isCancelled {
                await model.loadApps()
                if model.apps.first(where: { $0.id == app.id })?.hasVerifiedProductionConnection == true { return }
                do { try await Task.sleep(for: .seconds(12)) } catch { return }
            }
        }
    }

    private func connectionPage(_ app: ConnectedApp) -> some View {
        let progress = model.connectionProgress(for: app)
        let connected = app.hasVerifiedProductionConnection
        return QuestJournalPage(backTitle: "Back", back: { back(app) }, spacing: 22, contentLeading: 52, footerBottom: 44) {
            QuestPageTitle(eyebrow: eyebrow(progress), title: title(progress, connected: connected), singleLine: progress.step != .guide || progress.provider != .revenuecat, eyebrowLeading: 16)
            appIdentity(app, progress: progress)
            QuestPageRule()
            switch progress.step {
            case .provider: providerChoices(app, progress: progress)
            case .guide: guide(app, provider: progress.provider)
            case .status: status(app, connected: connected)
            }
            QuestPageError(message: error ?? model.appsError ?? model.pushError)
            if let message = model.pushMessage, progress.step == .status {
                Text(message).font(.footnote).foregroundStyle(QuestPageInk.secondary)
            }
        } footer: {
            QuestJournalFooter(caption: copied && progress.step == .guide ? "URL copied. Return here after saving." : nil, compact: true) {
                switch progress.step {
                case .provider:
                    QuestPageButton(title: "Connect store") { setStep(.guide, for: app) }
                        .accessibilityIdentifier("onboarding.connectStore")
                case .guide:
                    QuestPageButton(title: typeSize.isAccessibilitySize ? "Copy URL" : "Copy URL & open\n\(progress.provider.title)", symbol: "doc.on.doc", symbolLeading: true) {
                        copyAndOpen(app, provider: progress.provider)
                    }.accessibilityIdentifier("onboarding.copyStoreURL")
                        .accessibilityLabel("Copy URL and open \(progress.provider.title)")
                case .status:
                    QuestPageButton(title: "Open Questline", symbol: "arrow.right", busy: busy) { finish() }
                        .accessibilityIdentifier("onboarding.openApp")
                }
            } secondary: {
                switch progress.step {
                case .provider:
                    Button("Set up later") { finish() }.frame(maxWidth: .infinity, minHeight: 44)
                        .accessibilityIdentifier("onboarding.deferStore")
                case .guide:
                    Button("I’ve saved it") { setStep(.status, for: app) }.frame(maxWidth: .infinity, minHeight: 44)
                        .accessibilityIdentifier("onboarding.savedStoreURL")
                case .status:
                    if connected && model.phoneAlertsReady {
                        Button(model.isTestingPush ? "Queuing test…" : "Send test notification") {
                            if model.isPreviewMode { error = "Sample mode does not send notifications." }
                            else { Task { await model.sendTestPush() } }
                        }.disabled(model.isTestingPush).frame(maxWidth: .infinity, minHeight: 44)
                    } else {
                        Button("Review setup") { setStep(.guide, for: app) }.frame(maxWidth: .infinity, minHeight: 44)
                    }
                }
            }
        }
        .onAppear { model.updateConnectionProgress(for: app) { $0.started = true } }
    }

    private func eyebrow(_ progress: StoreConnectionProgress) -> String {
        let label = progress.step == .provider ? "Sales alerts" : progress.step == .guide ? progress.provider.title : "Connection status"
        return model.isPreviewMode ? "\(label) · Sample" : label
    }
    private func title(_ progress: StoreConnectionProgress, connected: Bool) -> String {
        switch progress.step {
        case .provider: return "Connect your store"
        case .guide: return progress.provider == .apple ? "Add your URL" : "Forward your\nevents"
        case .status: return connected ? "Store connected" : "Waiting for Apple"
        }
    }

    private func appIdentity(_ app: ConnectedApp, progress: StoreConnectionProgress) -> some View {
        HStack(spacing: 14) {
            QuestAppIcon(iconURL: app.iconUrl, bundledName: app.bundledIconName, size: 48)
            VStack(alignment: .leading, spacing: 6) {
                Text(app.name).font(.headline)
                if progress.step == .provider {
                    Label(model.phoneAlertsReady ? "Phone alerts enabled" : "Phone alerts not enabled", systemImage: model.phoneAlertsReady ? "checkmark.circle.fill" : "bell.slash")
                        .font(.footnote).foregroundStyle(QuestPageInk.secondary)
                } else { Text(progress.step == .guide && progress.provider == .apple ? "Your store connection" : progress.provider.title).font(.subheadline).foregroundStyle(QuestPageInk.secondary) }
            }
        }
    }

    private func providerChoices(_ app: ConnectedApp, progress: StoreConnectionProgress) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Where do you manage purchases?").font(.subheadline).foregroundStyle(QuestPageInk.secondary)
                .padding(.bottom, 8)
            ForEach(StoreConnectionProvider.allCases, id: \.self) { provider in
                let selected = progress.provider == provider
                Button {
                    model.updateConnectionProgress(for: app) { $0.provider = provider; $0.started = true }
                } label: {
                    HStack(spacing: 12) {
                        Group {
                            if provider == .apple {
                                Image("AppStoreConnectIcon").resizable().scaledToFit()
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                            } else {
                                Image(systemName: "link").font(.system(size: 26, weight: .medium))
                                    .foregroundStyle(QuestPageInk.secondary)
                            }
                        }.frame(width: 36, height: 36).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(provider.title).font(.headline)
                            Text(provider.subtitle).font(.footnote).foregroundStyle(QuestPageInk.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: selected ? "checkmark.circle.fill" : "circle").font(.title2)
                            .foregroundStyle(selected ? QuestPageInk.gold : QuestPageInk.secondary)
                    }.padding(.vertical, 16).padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 78)
                        .background(selected ? QuestPageInk.gold.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 9))
                        .overlay(RoundedRectangle(cornerRadius: 9).stroke(selected ? QuestPageInk.gold : .clear, lineWidth: 1))
                        .overlay(alignment: .bottom) { if !selected { Rectangle().fill(QuestPageInk.rule.opacity(0.5)).frame(height: 0.5) } }
                        .contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityIdentifier("onboarding.provider.\(provider.rawValue)")
            }
        }
    }

    private func guide(_ app: ConnectedApp, provider: StoreConnectionProvider) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            if provider == .apple {
                guideStep(1, "Open App Information", "In App Store Connect.")
                Rectangle().fill(QuestPageInk.rule.opacity(0.5)).frame(height: 0.5)
                guideStep(2, "Find Server Notifications", "App Store Server Notifications\nProduction Server URL")
                Rectangle().fill(QuestPageInk.rule.opacity(0.5)).frame(height: 0.5)
                guideStep(3, "Paste, select Version 2, save", "")
                Button("Already have a server URL?") { openConnectionSettings(app) }
                    .font(.footnote.weight(.medium)).underline().frame(maxWidth: .infinity, minHeight: 44)
            } else {
                guideStep(1, "Open your iOS app", "RevenueCat → Apps")
                Rectangle().fill(QuestPageInk.rule.opacity(0.5)).frame(height: 0.5)
                guideStep(2, "Find notification settings", "Apple Server to Server notifications")
                Rectangle().fill(QuestPageInk.rule.opacity(0.5)).frame(height: 0.5)
                guideStep(3, "Paste your Questline URL", "Apple Server Notification Forwarding URL\nSelect Save Changes.")
                Text("Keep RevenueCat’s URLs in App Store Connect.").font(.footnote).foregroundStyle(QuestPageInk.secondary)
            }
        }
    }

    private func guideStep(_ number: Int, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Text("\(number)").font(.title3.weight(.medium)).foregroundStyle(QuestPageInk.gold)
                .frame(width: 38, height: 38).overlay(Circle().stroke(QuestPageInk.gold, lineWidth: 1.5))
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.headline).fixedSize(horizontal: false, vertical: true)
                if !detail.isEmpty { Text(detail).font(.footnote).foregroundStyle(QuestPageInk.secondary).fixedSize(horizontal: false, vertical: true) }
            }
        }
    }

    private func status(_ app: ConnectedApp, connected: Bool) -> some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack(spacing: 14) {
                Image(systemName: model.phoneAlertsReady ? "checkmark.circle.fill" : "bell.slash")
                    .font(.system(size: 28)).foregroundStyle(QuestPageInk.gold).frame(width: 30).accessibilityHidden(true)
                Text(model.phoneAlertsReady ? "Phone alerts enabled" : "Phone alerts not enabled").font(.headline)
            }
            if !model.phoneAlertsReady {
                Button(model.permissionStatus == .denied ? "Open notification settings" : "Enable phone alerts") {
                    if model.isPreviewMode { error = "Sample mode keeps your notification settings unchanged." }
                    else if model.permissionStatus == .denied, let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    else { Task { await model.enableNotifications() } }
                }.font(.subheadline).frame(minHeight: 44).disabled(model.isRegisteringDevice)
            }
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: connected ? "checkmark.circle.fill" : "clock")
                    .font(.system(size: 28)).foregroundStyle(QuestPageInk.gold).frame(width: 30).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 8) {
                    Text(connected ? "Store event received" : "Waiting for a store event").font(.headline)
                    Text(connected ? "Verified from Apple." : "Your connection is confirmed when a production event arrives.")
                        .font(.subheadline).foregroundStyle(QuestPageInk.secondary)
                }
            }
            if !connected && app.lastSandboxEventAt != nil {
                Text("Sandbox event received. We’re still waiting for a production event.")
                    .font(.footnote).foregroundStyle(QuestPageInk.secondary)
            }
            QuestPageRule()
            Text(connected ? "Your store is sending events to Questline." : "You can explore Questline while we wait.")
                .font(.subheadline).foregroundStyle(QuestPageInk.secondary)
        }
    }

    private func setStep(_ step: StoreConnectionStep, for app: ConnectedApp) {
        error = nil; copied = false
        model.updateConnectionProgress(for: app) { $0.step = step; $0.started = true }
    }
    private func copyAndOpen(_ app: ConnectedApp, provider: StoreConnectionProvider) {
        guard !model.isPreviewMode else { error = "Sample mode does not copy a real connection URL."; return }
        guard let url = provider.notificationURL(for: app, serverURL: model.config?.publicUrl ?? model.serverSettings.url) else {
            error = "Your connection URL is unavailable. Refresh and try again."; return
        }
        UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: url.absoluteString]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(600)])
        copied = true; error = nil
        openURL(provider.dashboardURL(appleID: app.appleId)) { accepted in
            if !accepted { error = "URL copied. Open \(provider.title) in your browser to continue." }
        }
    }
    private func openConnectionSettings(_ app: ConnectedApp) {
        guard !model.isPreviewMode else { error = "Sample mode does not change an existing connection."; return }
        do { access = try model.dashboardAccess(for: .connection(app.id)) }
        catch { self.error = error.localizedDescription }
    }
    private func back(_ app: ConnectedApp?) {
        if let app, model.connectionProgress(for: app).step != .provider {
            setStep(model.connectionProgress(for: app).step == .status ? .guide : .provider, for: app)
        } else if standalone { dismiss() }
        else { Task { do { try await model.moveOnboarding(to: model.leadItems.isEmpty ? .app : .trial) } catch { self.error = error.localizedDescription } } }
    }
    private func finish() {
        guard !busy else { return }
        if standalone { dismiss(); return }
        busy = true
        Task {
            do {
                try await model.finishOnboarding()
                if !billing.hasActiveSubscription { model.selectedTab = "activity" }
            }
            catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}
