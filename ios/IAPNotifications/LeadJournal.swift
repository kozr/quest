import SwiftUI
import UIKit

struct LeadReplyOption: Codable, Equatable, Identifiable {
    let id: String
    let title: String
    let summary: String
    let body: String

}

struct LeadReplyPlan: Codable, Equatable {
    let title: String
    let objective: String
    let replies: [LeadReplyOption]

    var isValid: Bool {
        replies.count == 2 && replies.map(\.id) == ["resource", "light"] &&
        replies.allSatisfy { !$0.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }
}

struct LeadReplyResponse: Decodable {
    let jobId: String
    let status: String
    let plan: LeadReplyPlan?
    let reasonCode: String?
}

@MainActor
final class LeadJournalSession: ObservableObject, Identifiable, Hashable {
    nonisolated static func == (lhs: LeadJournalSession, rhs: LeadJournalSession) -> Bool {
        lhs === rhs
    }

    nonisolated func hash(into hasher: inout Hasher) {
        hasher.combine(ObjectIdentifier(self))
    }

    let id: String
    let lead: LeadItem
    let appName: String
    let profileRevision: Int?
    @Published var plan: LeadReplyPlan?
    @Published var onboardingSelection = OnboardingReplySelection()
    @Published var selectedID = "light"
    @Published var drafts: [String: String] = [:]
    @Published var isBookmarked = false
    @Published var isEditing = false
    @Published var isLoading = false
    @Published var error: String?
    var jobID: String?

    init(lead: LeadItem, appName: String, revision: Int?, plan: LeadReplyPlan? = nil) {
        id = "\(lead.appId)|\(revision ?? 0)|\(lead.id)"
        self.lead = lead
        self.appName = appName
        self.profileRevision = revision
        if let plan, plan.isValid { self.plan = plan }
    }

    var selectedReply: LeadReplyOption? { plan?.replies.first { $0.id == selectedID } }
    var replyText: String {
        get { drafts[selectedID] ?? selectedReply?.body ?? "" }
        set { drafts[selectedID] = newValue }
    }

    func accept(_ response: LeadReplyResponse) throws -> Bool {
        jobID = response.jobId
        if response.status == "succeeded" {
            guard let value = response.plan, value.isValid else { throw ClientError.invalidResponse }
            plan = value
            return true
        }
        if response.reasonCode == "BUDGET_PAUSED" || response.reasonCode == "DAILY_LIMIT" {
            throw ClientError.message("Reply suggestions are paused by usage limits. You can still view the original post.")
        }
        if ["failed", "uncertain", "cancelled"].contains(response.status) {
            throw ClientError.message("These suggestions couldn’t be prepared. You can still view the original post.")
        }
        return false
    }
}

private enum JournalInk {
    static let primary = Color(red: 0.035, green: 0.12, blue: 0.19)
    static let secondary = Color(red: 0.29, green: 0.36, blue: 0.40)
    static let gold = Color(red: 0.78, green: 0.56, blue: 0.12)
    static let rule = Color(red: 0.70, green: 0.66, blue: 0.54)
}

private enum JournalArtwork {
    static let page: Image = {
        guard let source = UIImage(named: "QuestJournalPaper"), let pixels = source.cgImage else { return Image("QuestJournalPaper") }
        return Image(uiImage: UIImage(cgImage: pixels, scale: CGFloat(pixels.width) / 390, orientation: .up))
    }()
}

struct LeadJournalView: View {
    @ObservedObject var session: LeadJournalSession

    var body: some View {
        LeadJournalPage(session: session, isEditing: false)
            .navigationTitle("Quest journal")
            .navigationDestination(isPresented: $session.isEditing) {
                LeadJournalPage(session: session, isEditing: true)
                    .navigationTitle("Your reply")
            }
    }
}

private struct LeadJournalPage: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    @Environment(\.dynamicTypeSize) private var typeSize
    @ObservedObject var session: LeadJournalSession
    let isEditing: Bool
    @State private var copiedText: String?
    @State private var showSourceNotice = false
    @State private var expandedRequest = false
    @State private var expandedReplyID: String?
    @FocusState private var editorFocused: Bool
    @ScaledMetric(relativeTo: .title) private var titleSize = 27
    @ScaledMetric(relativeTo: .subheadline) private var choiceSize = 15
    @ScaledMetric(relativeTo: .subheadline) private var summarySize = 14

    var body: some View {
        VStack(spacing: 0) {
            Color.clear.frame(height: isEditing || typeSize.isAccessibilitySize ? 16 : 32)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if isEditing { editor } else { briefing }
                }
                .padding(.leading, typeSize.isAccessibilitySize ? 36 : 48)
                .padding(.trailing, 24)
                .padding(.top, 25)
                .padding(.bottom, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background {
                    JournalArtwork.page
                        .resizable(capInsets: EdgeInsets(top: 64, leading: 64, bottom: 24, trailing: 14))
                        .accessibilityHidden(true)
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .tint(JournalInk.primary)
        }
        .background {
            ZStack(alignment: .top) {
                QuestStyle.navy
                GeometryReader { geometry in
                    Image("QuestLandscape").resizable().scaledToFill()
                        .frame(width: geometry.size.width, height: 240, alignment: .top)
                        .clipped()
                        .accessibilityHidden(true)
                }
            }
            .ignoresSafeArea()
        }
        .foregroundStyle(JournalInk.primary)
        .tint(QuestStyle.gold)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        .toolbarBackground(.hidden, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { session.isBookmarked.toggle() } label: {
                    Image(systemName: session.isBookmarked ? "bookmark.fill" : "bookmark")
                        .foregroundStyle(QuestStyle.gold)
                }
                .accessibilityLabel(session.isBookmarked ? "Unbookmark quest" : "Bookmark quest")
                .accessibilityValue(session.isBookmarked ? "Saved for this session" : "Not saved")
                .accessibilityIdentifier("journalBookmark")
            }
        }
        .preferredColorScheme(.dark)
        .environment(\.colorScheme, .light)
        .task { await model.prepareJournal(session) }
        .alert(session.lead.isSample ? "Example quest" : "Post unavailable", isPresented: $showSourceNotice) {
            Button("OK", role: .cancel) { }
        } message: {
            Text(session.lead.isSample ? "This demo lets you try the reply flow without opening a real conversation." : "The original post’s link could not be opened.")
        }
        .onChange(of: session.replyText) { _, _ in copiedText = nil }
        .onChange(of: session.isEditing) { _, editing in
            if !editing, expandedReplyID != nil { expandedReplyID = session.selectedID }
        }
        .accessibilityIdentifier("questJournal")
    }

    private var briefing: some View {
        Group {
            HStack(spacing: 10) {
                Text("QUEST JOURNAL").font(.system(.caption, design: .serif).weight(.semibold)).tracking(1.5)
                    .fixedSize(horizontal: false, vertical: true)
                if !typeSize.isAccessibilitySize {
                    Rectangle().fill(JournalInk.rule.opacity(0.6)).frame(height: 0.5)
                }
            }
            .foregroundStyle(JournalInk.secondary)
            .padding(.leading, 26).padding(.bottom, 12)

            Text(session.plan?.title ?? session.lead.title)
                .font(.system(size: titleSize, weight: .bold, design: .serif))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .padding(.leading, 26)
                .padding(.bottom, 8)
            Text("r/\(session.lead.community)" + (session.lead.isSample ? " · Example post" : ""))
                .font(.subheadline.weight(.semibold)).foregroundStyle(JournalInk.secondary)
                .padding(.leading, 26).padding(.bottom, 14)

            heading("The request")
            HStack(alignment: .top, spacing: 12) {
                RoundedRectangle(cornerRadius: 2).fill(JournalInk.secondary.opacity(0.4)).frame(width: 3)
                Text("“\(requestText)”")
                    .font(.system(.body, design: .serif).italic())
                    .lineSpacing(3)
                    .lineLimit(expandedRequest || typeSize.isAccessibilitySize ? nil : 5)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 8).padding(.bottom, 12)
            if requestText.count > 230 {
                Button(expandedRequest ? "Show less" : "Read more") { expandedRequest.toggle() }
                    .font(.subheadline.weight(.medium)).padding(.bottom, 14)
            }
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "safari").font(.system(size: 35, weight: .light))
                    .foregroundStyle(JournalInk.gold).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Objective").font(.headline)
                    Text(session.plan?.objective ?? "Help with the request above.")
                        .font(.subheadline).foregroundStyle(JournalInk.secondary)
                }
            }
            rule.padding(.vertical, 10)
            HStack(spacing: 8) {
                Image("JournalQuill").resizable().scaledToFit().frame(width: 21, height: 21)
                    .foregroundStyle(JournalInk.gold).accessibilityHidden(true)
                heading("Choose your words")
            }
            .padding(.bottom, 6)
            if let plan = session.plan {
                ForEach(Array(plan.replies.enumerated()), id: \.element.id) { index, reply in
                    choice(reply, index: index)
                    if index == 0 { Divider().overlay(JournalInk.rule.opacity(0.4)) }
                }
                rule.padding(.top, 8).padding(.bottom, 10)
                Text("For \(session.appName)").font(.system(.footnote, design: .serif))
                    .foregroundStyle(JournalInk.secondary).padding(.bottom, 10)
            } else {
                loadingOrError.padding(.vertical, 20)
            }
            sourceButton.padding(.top, 7)
        }
    }

    private var requestText: String {
        let excerpt = session.lead.excerpt.trimmingCharacters(in: .whitespacesAndNewlines)
        return excerpt.isEmpty ? session.lead.title : excerpt
    }

    private func choice(_ reply: LeadReplyOption, index: Int) -> some View {
        let expanded = expandedReplyID == reply.id
        let text = session.drafts[reply.id] ?? reply.body
        return VStack(alignment: .leading, spacing: 12) {
            Button {
                session.selectedID = reply.id
                expandedReplyID = expanded ? nil : reply.id
                copiedText = nil
            } label: {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: "\(index + 1).circle" + (expanded ? ".fill" : ""))
                        .font(.system(size: 28, weight: .regular))
                        .foregroundStyle(expanded ? JournalInk.gold : JournalInk.secondary)
                        .frame(width: 30).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 8) {
                            Text("Reply \(index + 1)").font(.system(size: choiceSize, weight: .semibold))
                            Spacer(minLength: 8)
                            Image(systemName: expanded ? "checkmark" : "chevron.down")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(expanded ? JournalInk.gold : JournalInk.secondary)
                                .accessibilityHidden(true)
                        }
                        Text(text).font(.system(size: summarySize)).lineSpacing(3)
                            .foregroundStyle(JournalInk.secondary)
                            .lineLimit(expanded ? nil : 3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(minHeight: 44, alignment: .top)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Reply \(index + 1)")
            .accessibilityValue(expanded ? "Expanded. \(text)" : "Collapsed. \(text)")
            .accessibilityHint(expanded ? "Collapse this reply." : "Read the full reply.")
            .accessibilityAddTraits(.isButton)
            .accessibilityAddTraits(expanded ? .isSelected : [])
            .accessibilityIdentifier("journalChoice-\(reply.id)")
            if expanded {
                primary("Use this reply", symbol: "arrow.right") {
                    session.selectedID = reply.id
                    session.isEditing = true
                }
                    .accessibilityHint("Edit Reply \(index + 1) before copying it.")
                    .accessibilityIdentifier("journalPrepareReply")
            }
        }
        .padding(.vertical, 12).padding(.leading, 12)
        .overlay(alignment: .leading) {
            if expanded { RoundedRectangle(cornerRadius: 2).fill(JournalInk.gold).frame(width: 2).padding(.vertical, 12) }
        }
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 18) {
            heading("Your reply").padding(.leading, 24)
            if let plan = session.plan {
                Picker("Reply", selection: $session.selectedID) {
                    ForEach(Array(plan.replies.enumerated()), id: \.element.id) { index, reply in
                        Text("Reply \(index + 1)").tag(reply.id)
                    }
                }
                .pickerStyle(.segmented).accessibilityIdentifier("journalReplyPicker")
            }
            TextEditor(text: Binding(get: { session.replyText }, set: { session.replyText = $0 }))
                .font(.body).lineSpacing(5)
                .scrollContentBackground(.hidden)
                .frame(minHeight: typeSize.isAccessibilitySize ? 400 : 280)
                .focused($editorFocused)
                .accessibilityLabel("Reply text")
                .accessibilityIdentifier("journalReplyEditor")
            rule
            if editorFocused {
                Button("Done editing") { editorFocused = false }.font(.body.weight(.semibold))
            }
            primary(copiedText == session.replyText ? "Copied" : "Copy reply", symbol: copiedText == session.replyText ? "checkmark" : "doc.on.doc") {
                editorFocused = false
                UIPasteboard.general.string = session.replyText
                copiedText = session.replyText
                UIAccessibility.post(notification: .announcement, argument: "Reply copied")
            }
            .disabled(session.replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityIdentifier("journalCopyReply")
            sourceButton
        }
    }

    private var loadingOrError: some View {
        VStack(alignment: .leading, spacing: 12) {
            if session.isLoading {
                ProgressView("Preparing two replies…").tint(JournalInk.primary)
            } else {
                Text(session.error ?? "Prepare two suggestions for this request.")
                    .font(.subheadline).foregroundStyle(JournalInk.secondary)
                Button(session.error == nil ? "Prepare suggestions" : "Check again") {
                    Task { await model.prepareJournal(session) }
                }.font(.body.weight(.semibold))
            }
        }
    }

    private var sourceButton: some View {
        Button {
            switch LeadURL.destination(for: session.lead) {
            case .reddit(let url): openURL(url) { success in if !success { showSourceNotice = true } }
            case .sampleExplanation, .unavailable: showSourceNotice = true
            }
        } label: {
            Label(isEditing ? "Open Reddit" : "View original post", systemImage: "arrow.up.right")
                .font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 44)
        }
        .accessibilityIdentifier("journalOpenPost")
    }

    private func heading(_ title: String) -> some View {
        Text(title).font(.system(.title3, design: .serif).weight(.bold)).accessibilityAddTraits(.isHeader)
    }

    private var rule: some View {
        HStack(spacing: 8) {
            Rectangle().fill(JournalInk.rule.opacity(0.7)).frame(height: 0.5)
            Image(systemName: "sparkle").font(.system(size: 8)).foregroundStyle(JournalInk.rule)
            Rectangle().fill(JournalInk.rule.opacity(0.7)).frame(height: 0.5)
        }.accessibilityHidden(true)
    }

    private func primary(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) { Text(title); Image(systemName: symbol) }
                .font(.body.weight(.semibold)).foregroundStyle(QuestStyle.gold)
                .frame(maxWidth: .infinity, minHeight: 48).padding(.horizontal, 12)
                .background(QuestStyle.navy, in: RoundedRectangle(cornerRadius: 11))
                .overlay(RoundedRectangle(cornerRadius: 11).stroke(JournalInk.gold, lineWidth: 1))
        }.buttonStyle(.plain)
    }
}
