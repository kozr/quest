import SwiftUI

struct TavernView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var store = TavernStore()
    @State private var showingSettings = false
    @State private var showingRanks = false
    @State private var reporting: TavernMessage?
    @State private var deleting: TavernMessage?
    var openSettings = false

    private var context: String { "\(model.user?.id ?? "")|\(model.tavernEnabled)|\(scenePhase == .active)" }
    var body: some View {
        Group {
            if model.tavernEnabled && !store.unavailable {
                conversation
            } else {
                VStack {
                    Button("Back") { dismiss() }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal)
                    ContentUnavailableView("Tavern is unavailable", systemImage: "bubble.left.and.bubble.right", description: Text(store.error ?? "This feature is not enabled."))
                }
            }
        }
        .background(QuestStyle.navy.ignoresSafeArea())
        .foregroundStyle(.white)
        .tint(QuestStyle.gold)
        .toolbar(.hidden, for: .navigationBar, .tabBar)
        .preferredColorScheme(.dark)
        .task(id: context) {
            store.configure(client: model.tavernClient, accountID: model.user?.id)
            guard model.tavernEnabled, scenePhase == .active else { return }
            await model.refreshTavernFlag()
            guard model.tavernEnabled, !Task.isCancelled else { return }
            await store.loadSettings()
            if openSettings { showingSettings = true }
            await store.refresh()
            var tick = 0
            while !Task.isCancelled && model.tavernEnabled && !store.unavailable {
                do { try await Task.sleep(for: .seconds(10)) } catch { break }
                guard !Task.isCancelled else { break }
                tick += 1
                if tick % 3 == 0 {
                    await model.refreshTavernFlag()
                    guard model.tavernEnabled, !Task.isCancelled else { break }
                    await store.loadSettings()
                }
                if !store.viewingHistory { await store.refresh() }
            }
        }
        .onChange(of: model.tavernEnabled) { _, enabled in
            if !enabled { showingSettings = false; showingRanks = false; reporting = nil; deleting = nil; store.configure(client: nil, accountID: nil); dismiss() }
        }
        .onDisappear { store.configure(client: nil, accountID: nil) }
        .sheet(isPresented: $showingSettings) {
            if model.tavernEnabled && !store.unavailable { TavernSettingsView(store: store).environmentObject(model) }
        }
        .sheet(isPresented: $showingRanks) {
            if model.tavernEnabled && !store.unavailable { TavernRankDetails() }
        }
        .confirmationDialog("Report message", isPresented: Binding(get: { reporting != nil }, set: { if !$0 { reporting = nil } }), titleVisibility: .visible) {
            ForEach(["Spam", "Harassment", "Inappropriate", "Other"], id: \.self) { reason in
                Button(reason) { if let message = reporting { Task { await store.report(message, reason: reason.lowercased()) } }; reporting = nil }
            }
            Button("Cancel", role: .cancel) { reporting = nil }
        }
        .confirmationDialog("Delete this message?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete message", role: .destructive) { if let message = deleting { Task { await store.remove(message) } }; deleting = nil }
            Button("Cancel", role: .cancel) { deleting = nil }
        }
        .accessibilityIdentifier("tavernRoot")
    }

    private var conversation: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    header
                    if let error = store.error {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(error).font(.subheadline)
                            Button("Retry") { Task { await model.refreshTavernFlag(); await store.loadSettings(); await store.refresh() } }
                        }.padding().accessibilityIdentifier("tavernError")
                    }
                    if let notice = store.notice { Text(notice).font(.subheadline).foregroundStyle(QuestStyle.gold).padding() }
                    if store.settings == nil && store.error == nil {
                        ProgressView("Opening Tavern…").frame(maxWidth: .infinity).padding(30)
                    } else if store.settings?.profile == nil {
                        VStack(alignment: .leading, spacing: 14) {
                            Text("A place for people building apps.").font(.title3.bold())
                            Text("Choose a name to join the global conversation. Your revenue badge is optional.").foregroundStyle(QuestStyle.muted)
                            Button("Choose your Tavern name") { showingSettings = true }.buttonStyle(.borderedProminent)
                        }.padding(22)
                    } else {
                        if store.nextCursor != nil {
                            Button("Load earlier messages") { Task { await store.refresh(older: true) } }
                                .frame(maxWidth: .infinity, minHeight: 44).disabled(store.isLoading || store.isBusy)
                        }
                        if store.viewingHistory {
                            Button("Back to latest") { Task { await store.refresh() } }.frame(maxWidth: .infinity, minHeight: 44)
                        }
                        if store.messages.isEmpty && !store.isLoading {
                            ContentUnavailableView("Start the conversation", systemImage: "bubble.left", description: Text("Ask a question, share what worked, or celebrate a small win."))
                        }
                        ForEach(Array(store.messages.enumerated()), id: \.element.id) { index, message in
                            if index == 0 || !Calendar.current.isDate(message.date, inSameDayAs: store.messages[index - 1].date) {
                                HStack {
                                    Rectangle().frame(height: 1)
                                    Text(Calendar.current.isDateInToday(message.date) ? "Today" : message.date.formatted(date: .abbreviated, time: .omitted)).fixedSize()
                                    Rectangle().frame(height: 1)
                                }.font(.footnote).foregroundStyle(QuestStyle.muted.opacity(0.7)).padding(.vertical, 16)
                            }
                            messageRow(message).id(message.id)
                        }
                        .padding(.horizontal, 20)
                        Color.clear.frame(height: 4).id("tavernBottom")
                    }
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await model.refreshTavernFlag(); await store.loadSettings(); await store.refresh() }
            .onChange(of: store.messages.last?.id) { _, _ in
                if !store.viewingHistory { withAnimation { proxy.scrollTo("tavernBottom", anchor: .bottom) } }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { if store.settings?.profile != nil { composer } }
        }
    }
    private var header: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Button { dismiss() } label: { Label("Back", systemImage: "chevron.left") }.frame(minHeight: 44)
                Spacer()
                Button { showingSettings = true } label: { Image(systemName: "ellipsis").frame(width: 44, height: 44).background(QuestStyle.navy.opacity(0.8), in: Circle()) }
                    .accessibilityLabel("Tavern settings")
            }.padding(.bottom, 30)
            QuestMainPageTitle(title: "Tavern", systemImage: "bubble.left.and.bubble.right.fill")
            Text("Global chat · \(store.onlineCount)\(store.onlineCountCapped ? "+" : "") online").font(.subheadline).foregroundStyle(QuestStyle.muted)
            Button { showingRanks = true } label: {
                Text("Ranks: best 30-day sales\nPast 3 months · USD").font(.footnote).multilineTextAlignment(.leading).foregroundStyle(QuestStyle.muted)
            }.accessibilityHint("Explains the revenue ranks")
        }
        .padding(.horizontal, 22).padding(.top, 8).padding(.bottom, 22)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            GeometryReader { geometry in
                Image("QuestLandscape").resizable().scaledToFill()
                    .frame(width: geometry.size.width, height: geometry.size.height, alignment: .top).clipped()
                    .overlay(LinearGradient(colors: [.clear, QuestStyle.navy.opacity(0.65), QuestStyle.navy], startPoint: .top, endPoint: .bottom))
            }.accessibilityHidden(true)
        }
    }
    private func messageRow(_ message: TavernMessage) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { author(message); Spacer(minLength: 0); timestamp(message) }
                VStack(alignment: .leading, spacing: 6) { author(message); timestamp(message) }
            }
            if let reply = message.reply {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Replying to \(reply.name)").font(.caption.bold())
                    Text(reply.text).font(.subheadline).lineLimit(3)
                }.foregroundStyle(QuestStyle.muted).padding(.leading, 10)
                    .overlay(alignment: .leading) { Rectangle().fill(QuestStyle.muted.opacity(0.5)).frame(width: 2) }
            }
            Text(message.text).font(QuestTypography.body).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 15) { reactions(message); replyButton(message) }
                VStack(alignment: .leading, spacing: 8) { reactions(message); replyButton(message) }
            }.font(.subheadline).foregroundStyle(QuestStyle.muted).disabled(store.isBusy)
            Divider().overlay(QuestStyle.muted.opacity(0.2)).padding(.top, 6)
        }.padding(.vertical, 12)
        .contextMenu {
            Button("Reply", systemImage: "arrowshape.turn.up.left") { store.replyingTo = message }
            if message.isMine { Button("Delete message", systemImage: "trash", role: .destructive) { deleting = message } }
            else {
                Button("Report message", systemImage: "flag") { reporting = message }
                Button("Block \(message.author.name)", systemImage: "person.slash", role: .destructive) { Task { await store.block(message.author.id) } }
            }
        }
    }
    private func author(_ message: TavernMessage) -> some View {
        HStack(spacing: 9) {
            Text(message.author.name).font(.headline).fixedSize(horizontal: false, vertical: true)
            if let rank = message.author.rank { Button { showingRanks = true } label: { TavernBadge(rank: rank) }.buttonStyle(.plain) }
        }
    }
    private func timestamp(_ message: TavernMessage) -> some View { Text(message.date, style: .relative).font(.caption).foregroundStyle(QuestStyle.muted).fixedSize() }
    private func reactions(_ message: TavernMessage) -> some View {
        HStack(spacing: 12) {
            reaction(message, kind: "helpful", title: "Helpful", symbol: "heart", count: message.helpful)
            reaction(message, kind: "celebrate", title: "Celebrate", symbol: "party.popper", count: message.celebrate)
        }
    }
    private func reaction(_ message: TavernMessage, kind: String, title: String, symbol: String, count: Int) -> some View {
        Button { Task { await store.react(message, kind: kind) } } label: {
            HStack(spacing: 5) {
                Image(systemName: symbol)
                if count > 0 { Text("\(count)") }
            }.padding(.horizontal, 10).frame(minHeight: 36)
                .background(message.myReaction == kind ? QuestStyle.gold.opacity(0.18) : .clear, in: Capsule())
                .overlay(Capsule().stroke(QuestStyle.muted.opacity(0.3)))
        }
        .foregroundStyle(message.myReaction == kind ? QuestStyle.gold : QuestStyle.muted)
        .accessibilityLabel("\(title), \(count) reactions")
        .accessibilityAddTraits(message.myReaction == kind ? .isSelected : [])
    }
    private func replyButton(_ message: TavernMessage) -> some View {
        Button { store.replyingTo = message } label: { Label("Reply", systemImage: "arrowshape.turn.up.left").frame(minHeight: 44) }
    }
    private var composer: some View {
        VStack(spacing: 8) {
            Button { showingSettings = true } label: {
                HStack(spacing: 7) {
                    if let rank = store.settings?.rank?.rank, store.settings?.profile?.showRank == true { TavernBadge(rank: rank) }
                    Text(store.settings?.profile?.showRank == true ? "Your badge · Visible" : "Your badge · Hidden")
                    Image(systemName: "chevron.down")
                }.font(.footnote).foregroundStyle(QuestStyle.muted).frame(minHeight: 32)
            }
            if let message = store.replyingTo {
                HStack {
                    Text("Replying to \(message.author.name)").font(.footnote).lineLimit(1)
                    Spacer()
                    Button { store.replyingTo = nil } label: { Image(systemName: "xmark.circle.fill").frame(width: 32, height: 32) }.accessibilityLabel("Cancel reply")
                }.foregroundStyle(QuestStyle.muted)
            }
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Share something…", text: $store.draft, axis: .vertical).lineLimit(1...5)
                    .padding(.vertical, 12).accessibilityIdentifier("tavernComposer")
                Button { Task { await store.send() } } label: {
                    Group { if store.isBusy { ProgressView().tint(QuestStyle.navy) } else { Image(systemName: "arrow.up").font(.title2.bold()) } }
                        .frame(width: 44, height: 44).background(QuestStyle.gold, in: Circle()).foregroundStyle(QuestStyle.navy)
                }.accessibilityLabel("Send message")
                    .disabled(store.isBusy || store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.draft.count > 2000)
            }.padding(.leading, 16).padding(.trailing, 6).padding(.vertical, 6)
                .background(QuestStyle.muted.opacity(0.06), in: RoundedRectangle(cornerRadius: 25))
                .overlay(RoundedRectangle(cornerRadius: 25).stroke(QuestStyle.muted.opacity(0.3)))
            if store.draft.count > 1800 { Text("\(store.draft.count)/2000 characters").font(.caption).foregroundStyle(store.draft.count > 2000 ? .red : QuestStyle.muted) }
        }.padding(.horizontal, 18).padding(.top, 8).padding(.bottom, 8).background(QuestStyle.navy)
    }
}

struct TavernBadge: View {
    let rank: TavernRank
    var body: some View {
        Label("\(rank.title) · \(rank.threshold)", systemImage: rank.symbol)
            .font(.footnote).foregroundStyle(rank.color).fixedSize(horizontal: false, vertical: true)
    }
}

private struct TavernRankDetails: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Your rank uses your highest sales total over any consecutive 30 days within the past three months.")
                    Text("The window moves with time, so ranks can rise or fall. Below $1, no rank is shown.")
                }
                Section("Revenue tiers · USD") { ForEach(TavernRank.allCases, id: \.self) { TavernBadge(rank: $0) } }
                Section("How sales are counted") {
                    Text("Recorded production purchases and renewals across your connected apps. Gross sales before refunds, fees and taxes; sandbox and demo activity do not count.")
                    Text("Other currencies use historical exchange rates. Missing history can understate sales; unavailable amounts or exchange rates hide the badge until it can be calculated.")
                    Text("Other members see only your tier when you choose to show it, never your exact sales total.")
                }
            }.navigationTitle("Revenue ranks").toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.tint(QuestStyle.gold).preferredColorScheme(.dark)
    }
}

private struct TavernSettingsView: View {
    @ObservedObject var store: TavernStore
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var showRank = false
    @State private var accepted = false
    @State private var showingRanks = false
    var body: some View {
        NavigationStack {
            if model.tavernEnabled && !store.unavailable {
                Form {
                    Section("Public profile") {
                        TextField("Display name", text: $name).textContentType(.nickname).autocorrectionDisabled()
                        Toggle("Show my revenue badge", isOn: $showRank)
                        Text("Your name and messages are visible to all Tavern members. No profile photo is used.").font(.footnote)
                    }
                    Section("Revenue rank") {
                        if let rank = store.settings?.rank?.rank { TavernBadge(rank: rank) }
                        else { Text(store.settings?.rank?.status == "unavailable" ? "Rank temporarily unavailable" : "No rank yet") }
                        Button("How ranks work") { showingRanks = true }
                    }
                    Section("Tavern rules") {
                        Text("Be kind. Share useful experience. No harassment, spam, or unsolicited promotion. Report messages that break these rules; block anyone you do not want to interact with.")
                        if store.settings?.profile == nil { Toggle("I agree to the Tavern rules", isOn: $accepted) }
                    }
                    if let blocked = store.settings?.blocked, !blocked.isEmpty {
                        Section("Blocked members") {
                            ForEach(blocked) { member in
                                HStack { Text(member.name); Spacer(); Button("Unblock") { Task { await store.block(member.id, remove: true) } }.disabled(store.isBusy) }
                            }
                        }
                    }
                    if store.settings?.isModerator == true {
                        Section("Moderation") { NavigationLink("Reported messages") { TavernModerationView(store: store).environmentObject(model) } }
                    }
                    if let error = store.error { Section { Text(error).foregroundStyle(.red) } }
                    Section {
                        Button(store.settings?.profile == nil ? "Join Tavern" : "Save settings") {
                            Task { if await store.save(name: name, showRank: showRank) { dismiss() } }
                        }.disabled(store.isBusy || name.trimmingCharacters(in: .whitespacesAndNewlines).count < 2 || name.count > 30 || (store.settings?.profile == nil && !accepted))
                    }
                }
                .navigationTitle("Tavern settings")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
                .onAppear { name = store.settings?.profile?.name ?? ""; showRank = store.settings?.profile?.showRank ?? false }
                .sheet(isPresented: $showingRanks) { if model.tavernEnabled { TavernRankDetails() } }
            }
        }.preferredColorScheme(.dark).tint(QuestStyle.gold)
        .onChange(of: model.tavernEnabled) { _, enabled in if !enabled { dismiss() } }
        .onChange(of: store.unavailable) { _, unavailable in if unavailable { dismiss() } }
    }
}

private struct TavernModerationView: View {
    @ObservedObject var store: TavernStore
    @EnvironmentObject private var model: AppModel
    var body: some View {
        Group {
            if model.tavernEnabled && !store.unavailable && store.settings?.isModerator == true {
                List {
                    if let error = store.error { Text(error).foregroundStyle(.red) }
                    if store.reports.isEmpty { Text("No open reports.") }
                    ForEach(store.reports) { report in
                        VStack(alignment: .leading, spacing: 10) {
                            Text(report.name).font(.headline)
                            Text(report.text)
                            Text(report.reason.capitalized).font(.caption).foregroundStyle(.secondary)
                            Menu("Review report") {
                                Button("Dismiss report") { Task { await store.moderate(report, action: "dismiss") } }
                                Button("Remove message", role: .destructive) { Task { await store.moderate(report, action: "remove") } }
                                Button("Ban member and remove message", role: .destructive) { Task { await store.moderate(report, action: "ban") } }
                            }.disabled(store.isBusy)
                        }.padding(.vertical, 6)
                    }
                }.task { await store.loadReports() }.refreshable { await store.loadReports() }
            }
        }.navigationTitle("Reported messages")
    }
}
