import SwiftUI

private struct EditableLeadRow: Identifiable, Equatable {
    let id: UUID
    var profileId: String?
    var text: String
    var evidenceQuote: String?
    var rationale: String?

    init(id: UUID = UUID(), profileId: String? = nil, text: String = "",
         evidenceQuote: String? = nil, rationale: String? = nil) {
        self.id = id
        self.profileId = profileId
        self.text = text
        self.evidenceQuote = evidenceQuote
        self.rationale = rationale
    }
}

struct LeadsSetupView: View {
    let app: ConnectedApp

    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var problems = [EditableLeadRow()]
    @State private var capabilities = [EditableLeadRow()]
    @State private var communitiesText = ""
    @State private var keywordsText = ""
    @State private var isEnabled = false
    @State private var hasReviewed = false
    @State private var isAdvancedExpanded = false
    @State private var isHydrated = false
    @State private var appliedDraftId: String?
    @State private var localError: String?
    @State private var expectedRevision = 0

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 23) {
                    appIdentity
                    accessNotice
                    suggestionSection
                    textRowsSection(
                        title: "Problems this app solves",
                        explanation: "Describe the specific needs someone might post about.",
                        rows: $problems,
                        maximum: 8,
                        placeholder: "For example, “keep a daily reflection habit”",
                        addTitle: "Add a problem"
                    )
                    textRowsSection(
                        title: "What this app can do",
                        explanation: "Only confirmed capabilities are used to assess fit.",
                        rows: $capabilities,
                        maximum: 8,
                        placeholder: "For example, “write and revisit journal entries”",
                        addTitle: "Add a capability"
                    )

                    DisclosureGroup(isExpanded: $isAdvancedExpanded) {
                        VStack(alignment: .leading, spacing: 15) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Communities")
                                    .font(.headline)
                                    .foregroundStyle(.white)
                                Text("Add at least one community to enable lead discovery. Suggestions are never monitored automatically.")
                                    .font(.footnote)
                                    .foregroundStyle(QuestStyle.muted)
                                TextField("journaling, productivity", text: $communitiesText, axis: .vertical)
                                    .textFieldStyle(LeadsEditorTextFieldStyle())
                                    .lineLimit(1...3)
                                    .accessibilityLabel("Communities, separated by commas")
                                if isEnabled && communityValues.isEmpty {
                                    Text("Choose at least one community to enable monitoring.")
                                        .font(.footnote.weight(.semibold))
                                        .foregroundStyle(QuestStyle.gold)
                                        .accessibilityIdentifier("leadCommunityRequired")
                                }
                            }
                            suggestedCommunities

                            VStack(alignment: .leading, spacing: 6) {
                                Text("Optional keywords")
                                    .font(.headline)
                                    .foregroundStyle(.white)
                                Text("Keywords narrow candidate discovery. They don’t confirm intent.")
                                    .font(.footnote)
                                    .foregroundStyle(QuestStyle.muted)
                                TextField("journal, focus timer", text: $keywordsText, axis: .vertical)
                                    .textFieldStyle(LeadsEditorTextFieldStyle())
                                    .lineLimit(1...3)
                                    .accessibilityLabel("Optional keywords, separated by commas")
                            }
                            suggestedKeywords
                        }
                        .padding(.top, 14)
                    } label: {
                        Label("Advanced · communities and keywords", systemImage: "slider.horizontal.3")
                            .font(.headline)
                            .foregroundStyle(QuestStyle.gold)
                    }
                    .padding(.vertical, 4)
                    .accessibilityIdentifier("leadAdvancedSettings")

                    VStack(alignment: .leading, spacing: 12) {
                        Toggle(isOn: $isEnabled) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text("Monitor for high-intent leads")
                                    .font(.headline)
                                    .foregroundStyle(.white)
                                Text("Find recent posts about problems and needs your app can help solve.")
                                    .font(.footnote)
                                    .foregroundStyle(QuestStyle.muted)
                            }
                        }
                        .tint(QuestStyle.gold)
                        .accessibilityIdentifier("leadMonitoringToggle")

                        Toggle(isOn: $hasReviewed) {
                            Text("I reviewed and confirm this app profile")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.white)
                        }
                        .tint(QuestStyle.gold)
                        .accessibilityIdentifier("leadProfileConfirmation")
                    }
                    .padding(.top, 3)

                    if let issue = localError ?? model.leadProfileSaveError {
                        VStack(alignment: .leading, spacing: 10) {
                            Label(issue, systemImage: "exclamationmark.triangle.fill")
                                .font(.subheadline)
                                .foregroundStyle(Color(red: 1, green: 0.79, blue: 0.63))
                            if (model.leadProfileSaveError ?? "").contains("changed on another device") {
                                Button("Reload profile and review") {
                                    Task {
                                        await model.refreshLeadBoard()
                                        hydrate(force: true)
                                        model.prepareLeadProfileEdit(appId: app.id)
                                    }
                                }
                                .buttonStyle(LeadsSecondaryActionStyle())
                            }
                        }
                        .accessibilityIdentifier("leadProfileSaveError")
                    }

                    Button(action: saveProfile) {
                        HStack(spacing: 8) {
                            if model.isSavingLeadProfile { ProgressView().tint(QuestStyle.navy) }
                            Text(isEnabled ? "Save and enable leads" : "Save profile")
                        }
                        .font(.headline.weight(.bold))
                        .foregroundStyle(QuestStyle.navy)
                        .frame(maxWidth: .infinity, minHeight: 54)
                        .background(QuestStyle.gold, in: RoundedRectangle(cornerRadius: 15))
                    }
                    .disabled(!canSave)
                    .opacity(canSave ? 1 : 0.52)
                    .accessibilityIdentifier("leadProfileSave")

                    Text("Public Reddit posts are assessed against the profile you confirm. Questline never posts or writes replies.")
                        .font(.footnote)
                        .foregroundStyle(QuestStyle.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 22)
                .padding(.top, 14)
                .padding(.bottom, 30)
            }
            .background(QuestStyle.navy)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("App profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(QuestStyle.gold)
                        .frame(minHeight: 44)
                }
            }
            .toolbarBackground(QuestStyle.navy, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .preferredColorScheme(.dark)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationBackground(QuestStyle.navy)
        .task(id: app.id) {
            for _ in 0..<300 where model.isLoadingLeadBoard {
                do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
            }
            if model.leadAccess == nil && !model.isPreviewMode && !model.isLoadingLeadBoard {
                await model.refreshLeadBoard()
            }
            hydrate()
        }
        .onChange(of: model.leadAccess?.enabled) { _, _ in hydrate() }
        .onChange(of: model.leadProfile?.revision) { _, _ in hydrate() }
        .onChange(of: model.leadDraft?.id) { _, _ in applyDraftIfReady() }
        .onChange(of: problems) { _, _ in hasReviewed = false }
        .onChange(of: capabilities) { _, _ in hasReviewed = false }
        .onChange(of: communitiesText) { _, _ in hasReviewed = false }
        .onChange(of: keywordsText) { _, _ in hasReviewed = false }
        .onChange(of: isEnabled) { _, enabled in
            hasReviewed = false
            if enabled && communityValues.isEmpty { isAdvancedExpanded = true }
        }
        .onDisappear { model.cancelLeadDraftPolling(appId: app.id) }
    }

    private var appIdentity: some View {
        HStack(alignment: .center, spacing: 14) {
            AppArtwork(url: app.iconUrl, name: app.name, bundledIconName: app.bundledIconName)
                .padding(5)
                .background(QuestStyle.navy, in: RoundedRectangle(cornerRadius: 15))
                .overlay(RoundedRectangle(cornerRadius: 15).stroke(QuestStyle.gold, lineWidth: 2))
            VStack(alignment: .leading, spacing: 3) {
                Text("App-specific lead profile")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(QuestStyle.gold)
                Text(app.name)
                    .font(.system(.title2, design: .serif).bold())
                    .foregroundStyle(.white)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Review each suggestion before it is saved.")
                    .font(.footnote)
                    .foregroundStyle(QuestStyle.muted)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("leadSetupAppIdentity")
    }

    @ViewBuilder
    private var accessNotice: some View {
        if model.isPreviewMode {
            Label("Demo · Sample profile. Changes aren’t saved.", systemImage: "sparkles")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(QuestStyle.gold)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("leadDemoProfileNotice")
        } else if let access = model.leadAccess, !access.enabled {
            Label(access.reasonCode == "BETA_ACCESS_REQUIRED"
                  ? "This account isn’t in the invited beta."
                  : "Lead discovery is not enabled for this account.",
                  systemImage: "lock.shield")
                .font(.subheadline)
                .foregroundStyle(Color(red: 1, green: 0.79, blue: 0.63))
                .fixedSize(horizontal: false, vertical: true)
        } else if !model.isPreviewMode, model.leadAccess?.aiAvailable == false {
            Label("AI suggestions are unavailable. You can still enter and confirm this profile manually.",
                  systemImage: "sparkles")
                .font(.subheadline)
                .foregroundStyle(QuestStyle.gold)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("leadAIUnavailable")
        }
    }

    private var suggestionSection: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Start from the App Store description")
                        .font(.headline)
                        .foregroundStyle(.white)
                    Text("Questline drafts suggestions for you to review.")
                        .font(.footnote)
                        .foregroundStyle(QuestStyle.muted)
                }
                Spacer(minLength: 5)
                if model.isRequestingLeadDraft { ProgressView().tint(QuestStyle.gold) }
            }
            if model.leadAccess?.aiAvailable == true {
                Button {
                    Task {
                        if model.leadDraftJobID != nil && model.leadDraftStatus != "succeeded" {
                            await model.retryLeadDraftStatus(appId: app.id)
                        } else {
                            await model.requestLeadDraft(appId: app.id)
                        }
                    }
                } label: {
                    Label(suggestionButtonTitle, systemImage: model.leadDraftJobID == nil ? "sparkles" : "arrow.clockwise")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(QuestStyle.gold)
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(QuestStyle.gold.opacity(0.6)))
                }
                .buttonStyle(.plain)
                .disabled(model.isRequestingLeadDraft)
                .accessibilityIdentifier("leadDraftRequest")
            }
            if let message = model.leadSetupMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(model.leadDraftStatus == "succeeded" ? QuestStyle.gold : QuestStyle.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("leadDraftStatus")
            }
            if let draft = model.leadDraft {
                VStack(alignment: .leading, spacing: 5) {
                    Label("Drafted from the public App Store description", systemImage: "text.quote")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(QuestStyle.gold)
                    Text("Capabilities include evidence from the source description. Edit anything that doesn’t fit.")
                        .font(.footnote)
                        .foregroundStyle(QuestStyle.muted)
                    Text("\(draft.problems.count) problems · \(draft.capabilities.count) capabilities suggested")
                        .font(.caption)
                        .foregroundStyle(QuestStyle.muted)
                }
                .accessibilityIdentifier("leadDraftProvenance")
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var suggestedCommunities: some View {
        let draftSuggestions = model.leadDraft?.suggestedCommunities ?? []
        let legacySuggestions = model.leadLegacySuggestions?.communities ?? []
        let suggestions = unique(draftSuggestions + legacySuggestions)
        if !suggestions.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(draftSuggestions.isEmpty ? "Unconfirmed community suggestions" : "Suggested communities · tap to add")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(QuestStyle.muted)
                FlexibleChips(values: suggestions, prefix: "r/", accessibilityPrefix: "community") { value in
                    append(value, to: &communitiesText)
                    hasReviewed = false
                }
            }
        }
    }

    @ViewBuilder
    private var suggestedKeywords: some View {
        let legacyKeywords = model.leadLegacySuggestions?.keywords ?? []
        if !legacyKeywords.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Unconfirmed keyword suggestions · tap to add")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(QuestStyle.muted)
                FlexibleChips(values: legacyKeywords, prefix: "", accessibilityPrefix: "keyword") { value in
                    append(value, to: &keywordsText)
                    hasReviewed = false
                }
            }
        }
    }

    private func textRowsSection(title: String, explanation: String, rows: Binding<[EditableLeadRow]>,
                                 maximum: Int, placeholder: String, addTitle: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(.title3, design: .serif).bold())
                    .foregroundStyle(.white)
                Text(explanation)
                    .font(.footnote)
                    .foregroundStyle(QuestStyle.muted)
            }
            ForEach(rows) { $row in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .top, spacing: 8) {
                        TextField(placeholder, text: $row.text, axis: .vertical)
                            .textFieldStyle(LeadsEditorTextFieldStyle())
                            .lineLimit(2...4)
                            .onChange(of: row.text) { _, value in
                                if value.count > 240 { row.text = String(value.prefix(240)) }
                            }
                        if rows.wrappedValue.count > 1 {
                            Button(role: .destructive) {
                                rows.wrappedValue.removeAll { $0.id == row.id }
                            } label: {
                                Image(systemName: "minus.circle")
                                    .font(.title3)
                                    .foregroundStyle(QuestStyle.muted)
                                    .frame(width: 44, height: 44)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Remove item")
                        }
                    }
                    if let quote = row.evidenceQuote, !quote.isEmpty {
                        Text("App Store evidence: “\(quote)”")
                            .font(.caption)
                            .foregroundStyle(QuestStyle.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    } else if let rationale = row.rationale, !rationale.isEmpty {
                        Text(rationale)
                            .font(.caption)
                            .foregroundStyle(QuestStyle.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            if rows.wrappedValue.count < maximum {
                Button {
                    rows.wrappedValue.append(EditableLeadRow())
                } label: {
                    Label(addTitle, systemImage: "plus.circle")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(QuestStyle.gold)
                        .frame(minHeight: 44)
                }
                .buttonStyle(.plain)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var canSave: Bool {
        let validProblems = problems.map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { $0.count >= 3 }
        let validCapabilities = capabilities.map { $0.text.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { $0.count >= 3 }
        return isHydrated && hasReviewed && validProblems.count > 0 && validCapabilities.count > 0 &&
            (!isEnabled || !communityValues.isEmpty) && model.leadAccess?.enabled == true &&
            !model.isSavingLeadProfile
    }

    private var communityValues: [String] {
        normalizedValues(communitiesText, communities: true)
    }

    private var keywordValues: [String] {
        normalizedValues(keywordsText, communities: false)
    }

    private var suggestionButtonTitle: String {
        if model.leadDraftStatus == "pending" || model.leadDraftStatus == "limited" { return "Check suggestion status" }
        if model.leadDraftStatus == "unavailable" && model.leadDraftJobID == nil { return "Retry suggestion request" }
        return model.leadDraft == nil ? "Suggest setup with AI" : "Suggest again"
    }

    private func saveProfile() {
        guard canSave else { return }
        localError = nil
        let problemInputs = problems.compactMap { row -> LeadProfileRowInput? in
            let text = row.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard text.count >= 3 else { return nil }
            return LeadProfileRowInput(id: row.profileId, text: text)
        }
        let capabilityInputs = capabilities.compactMap { row -> LeadProfileRowInput? in
            let text = row.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard text.count >= 3 else { return nil }
            return LeadProfileRowInput(id: row.profileId, text: text)
        }
        let request = LeadProfileSaveRequest(
            expectedRevision: expectedRevision,
            enabled: isEnabled,
            problems: problemInputs,
            capabilities: capabilityInputs,
            communities: communityValues,
            keywords: keywordValues,
            draftId: appliedDraftId
        )
        Task {
            do {
                try await model.saveLeadProfile(appId: app.id, request: request)
                dismiss()
            } catch is CancellationError {
                return
            } catch {
                localError = model.leadProfileSaveError ?? error.localizedDescription
            }
        }
    }

    private func hydrate(force: Bool = false) {
        guard force || !isHydrated else { return }
        guard !model.isLoadingLeadBoard else { return }
        guard model.leadAccess != nil || model.isPreviewMode else { return }
        if let profile = model.leadProfile, profile.appId == app.id {
            expectedRevision = profile.revision
            problems = profile.problems.map { EditableLeadRow(profileId: $0.id, text: $0.text) }
            capabilities = profile.capabilities.map {
                EditableLeadRow(profileId: $0.id, text: $0.text, evidenceQuote: $0.evidenceQuote)
            }
            communitiesText = profile.communities.joined(separator: ", ")
            keywordsText = profile.keywords.joined(separator: ", ")
            isEnabled = profile.enabled
        } else {
            expectedRevision = 0
            problems = [EditableLeadRow()]
            capabilities = [EditableLeadRow()]
            communitiesText = ""
            keywordsText = ""
            isEnabled = false
        }
        hasReviewed = false
        appliedDraftId = nil
        isHydrated = true
        if model.leadAccess?.enabled != true && !model.isPreviewMode {
            localError = nil
        }
    }

    private func applyDraftIfReady() {
        guard isHydrated, let draft = model.leadDraft, draft.id != appliedDraftId else { return }
        problems = draft.problems.map { EditableLeadRow(text: $0.text, rationale: $0.rationale) }
        capabilities = draft.capabilities.map {
            EditableLeadRow(text: $0.text, evidenceQuote: $0.evidenceQuote, rationale: $0.rationale)
        }
        appliedDraftId = draft.id
        isAdvancedExpanded = true
        hasReviewed = false
    }

    private func normalizedValues(_ value: String, communities: Bool) -> [String] {
        var seen = Set<String>()
        return value.split(separator: ",").compactMap { part in
            var item = part.trimmingCharacters(in: .whitespacesAndNewlines)
            if communities {
                if item.lowercased().hasPrefix("r/") { item.removeFirst(2) }
                item = item.lowercased()
            }
            guard !item.isEmpty, seen.insert(item.lowercased()).inserted else { return nil }
            return item
        }
    }

    private func append(_ value: String, to text: inout String) {
        let existing = normalizedValues(text, communities: false)
        guard !existing.contains(where: { $0.caseInsensitiveCompare(value) == .orderedSame }) else { return }
        text = (existing + [value]).joined(separator: ", ")
    }

    private func unique(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { seen.insert($0.lowercased()).inserted }
    }
}

private struct LeadsEditorTextFieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .font(.body)
            .foregroundStyle(.white)
            .padding(.horizontal, 13)
            .padding(.vertical, 11)
            .background(QuestStyle.navy.opacity(0.84), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(QuestStyle.muted.opacity(0.35), lineWidth: 1))
    }
}

private struct LeadsSecondaryActionStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(QuestStyle.gold)
            .frame(minHeight: 44)
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}

private struct FlexibleChips: View {
    let values: [String]
    let prefix: String
    let accessibilityPrefix: String
    let action: (String) -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        ViewThatFits(in: .horizontal) {
            chipRow
            ScrollView(.horizontal) { chipRow }
                .scrollIndicators(.hidden)
        }
    }

    private var chipRow: some View {
        HStack(spacing: 8) {
            ForEach(values, id: \.self) { value in
                Button {
                    action(value)
                } label: {
                    Text("\(prefix)\(value) +")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(QuestStyle.gold)
                        .padding(.horizontal, 11)
                        .frame(minHeight: 42)
                        .overlay(Capsule().stroke(QuestStyle.gold.opacity(0.48)))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Add suggested \(accessibilityPrefix) \(value)")
            }
        }
        .fixedSize(horizontal: true, vertical: false)
        .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : nil, alignment: .leading)
    }
}
