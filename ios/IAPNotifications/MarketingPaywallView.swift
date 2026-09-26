import SwiftUI
import StoreKit

/// The offer uses the same journal artwork as onboarding. Prices always come from StoreKit.
struct MarketingPaywallView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var billing: MarketingStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var coverage: MarketingCoverage = .one
    @State private var period: MarketingPeriod = .annual
    @State private var selectedApps: Set<String> = []
    @State private var choosingApps = false
    @State private var managingSubscription = false
    @ScaledMetric(relativeTo: .largeTitle) private var titleSize = 32
    var onClose: (() -> Void)? = nil
    var onSubscribed: (() -> Void)? = nil

    private var plan: MarketingPlan { MarketingPlan(coverage: coverage, period: period) }
    private var appLimit: Int { billing.hasActiveSubscription ? (billing.subscription?.appLimit ?? 1) : coverage.appLimit }
    private var selectedAppIDs: [String] { model.apps.filter { selectedApps.contains($0.id) }.map(\.id) }
    private var selectedAppNames: String { model.apps.filter { selectedApps.contains($0.id) }.map(\.name).joined(separator: ", ") }

    var body: some View {
        GeometryReader { geometry in
            Group {
                if typeSize.isAccessibilitySize {
                    scrollingPage
                } else {
                    ViewThatFits(in: .vertical) {
                        splitPage
                        scrollingPage
                    }
                }
            }
            .clipped()
            .overlay(alignment: .top) {
                // Continue the header artwork through the status bar while keeping scrolling text below it.
                Image("QuestLandscape").resizable()
                    .frame(width: geometry.size.width, height: geometry.size.width * 1844 / 853)
                    .offset(y: -geometry.size.width * 0.36 + geometry.safeAreaInsets.top)
                    .frame(height: geometry.safeAreaInsets.top, alignment: .top).clipped()
                    .offset(y: -geometry.safeAreaInsets.top)
                    .allowsHitTesting(false).accessibilityHidden(true)
            }
        }
        .background {
            Image("MarketParchmentTexture").resizable().ignoresSafeArea().accessibilityHidden(true)
        }
        .foregroundStyle(QuestPageInk.navy)
        .tint(QuestPageInk.gold)
        .preferredColorScheme(.light)
        .interactiveDismissDisabled(billing.isBusy)
        .manageSubscriptionsSheet(isPresented: $managingSubscription)
        .onChange(of: managingSubscription) { _, showing in
            if !showing { Task { await billing.load() } }
        }
        .onChange(of: billing.hasActiveSubscription) { wasActive, active in
            if !wasActive && active { onSubscribed?() }
        }
        .onChange(of: coverage) { _, _ in
            selectedApps = Set(selectedAppIDs.prefix(appLimit))
            if selectedApps.isEmpty { selectInitialApps() }
        }
        .task {
            selectInitialApps()
            await billing.load()
            if let subscription = billing.subscription, billing.hasActiveSubscription, !subscription.appIDs.isEmpty {
                selectedApps = Set(subscription.appIDs)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("marketing.paywall")
    }

    /// Benefits can grow without pushing the plan choices or purchase action offscreen.
    private var splitPage: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 0) {
                    benefits
                    legal
                        .padding(.horizontal, 24).padding(.bottom, 24)
                        .frame(maxWidth: 620).frame(maxWidth: .infinity)
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollIndicatorsFlash(onAppear: true)
            .accessibilityIdentifier("paywall.benefits")
            .frame(minHeight: 220, idealHeight: 220, maxHeight: .infinity)
            .clipped()

            VStack(spacing: 12) {
                purchaseSelection
                if !billing.hasActiveSubscription {
                    HStack(spacing: 8) {
                        planRow(.annual, title: "Annual", cadence: "year", compact: true)
                        planRow(.monthly, title: "Monthly", cadence: "month", compact: true)
                    }.disabled(billing.isBusy)
                }
                messages
                checkout
            }
            .padding(.horizontal, 24).padding(.top, 12).padding(.bottom, 8)
            .frame(maxWidth: 620).frame(maxWidth: .infinity)
            .fixedSize(horizontal: false, vertical: true)
            .background { Image("MarketParchmentTexture").resizable().ignoresSafeArea(edges: .bottom).accessibilityHidden(true) }
            .overlay(alignment: .top) { Divider().overlay(QuestPageInk.rule) }
        }
    }

    /// Short screens, expanded controls, and large text use one scroll area rather than nested scrolling.
    private var scrollingPage: some View {
        ScrollViewReader { proxy in
        ScrollView {
            VStack(spacing: 0) {
                benefits
                VStack(spacing: 16) {
                    VStack(spacing: 16) { purchaseSelection }
                        .id("paywall.purchaseSelection")
                    if !billing.hasActiveSubscription { plans }
                    messages
                    if typeSize.isAccessibilitySize { checkout }
                    legal
                }
                .padding(.horizontal, 24).padding(.bottom, 24)
                .frame(maxWidth: 620).frame(maxWidth: .infinity)
            }
        }
        .task(id: choosingApps) {
            if choosingApps {
                await Task.yield()
                proxy.scrollTo("paywall.purchaseSelection", anchor: .top)
            }
        }
        }
        .clipped()
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !typeSize.isAccessibilitySize {
                checkout
                    .padding(.horizontal, 24).padding(.top, 12).padding(.bottom, 8)
                    .background { Image("MarketParchmentTexture").resizable().ignoresSafeArea(edges: .bottom).accessibilityHidden(true) }
                    .overlay(alignment: .top) { Divider().overlay(QuestPageInk.rule) }
            }
        }
    }

    private var benefits: some View {
        VStack(spacing: 0) {
            header
            VStack(spacing: 16) {
                introduction
                comparison
                Text("Initial research, then ongoing lead discovery.")
                    .font(.footnote).foregroundStyle(QuestPageInk.secondary)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 24).padding(.top, 22).padding(.bottom, 24)
            .frame(maxWidth: 620).frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder private var purchaseSelection: some View {
        if billing.hasActiveSubscription {
            Label("Marketing is active", systemImage: "checkmark.seal.fill")
                .font(.headline).accessibilityIdentifier("paywall.active")
        } else {
            coveragePicker
        }
        appSelection
    }

    private var header: some View {
        VStack(spacing: 0) {
            GeometryReader { geometry in
                Image("QuestLandscape").resizable()
                    .frame(width: geometry.size.width, height: geometry.size.width * 1844 / 853)
                    .offset(y: -geometry.size.width * 0.36)
                    .frame(height: 56, alignment: .top).clipped()
            }.frame(height: 56).accessibilityHidden(true)
            HStack(spacing: 10) {
                Image(systemName: "sparkle").font(.title3).accessibilityHidden(true)
                Text(typeSize.isAccessibilitySize ? "MARKETING" : "QUESTLINE MARKETING")
                    .font(.system(.caption, design: .serif, weight: .semibold)).tracking(1.5)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Button(action: close) {
                    Image(systemName: "xmark").font(.title3.weight(.medium)).frame(width: 44, height: 44)
                }.buttonStyle(.plain).disabled(billing.isBusy)
                    .accessibilityLabel("Continue with free sales tracking")
                    .accessibilityIdentifier("paywall.close")
            }
            .padding(.leading, 24).padding(.trailing, 12)
            .foregroundStyle(QuestPageInk.lightGold).background(QuestPageInk.navy)
        }
    }

    private var introduction: some View {
        VStack(spacing: 10) {
            Text("Your next users\nare out there.")
                .font(.system(size: titleSize, weight: .bold, design: .serif))
                .tracking(-0.5).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
            Text("Find people looking for an app like yours.")
                .font(.subheadline).foregroundStyle(QuestPageInk.secondary)
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        }
    }

    private var comparison: some View {
        VStack(spacing: 0) {
            if !typeSize.isAccessibilitySize {
                HStack {
                    Text("Included").frame(maxWidth: .infinity, alignment: .leading)
                    Text("Free").frame(width: 42)
                    Text("Marketing").frame(width: 84)
                }.font(.caption.weight(.semibold)).foregroundStyle(QuestPageInk.secondary).padding(.bottom, 9)
            }
            feature("Sales analytics", free: true)
            feature("Sales push alerts", free: true)
            feature("Ongoing lead discovery", free: false)
            feature("New lead alerts", free: false)
            feature("Suggested replies", free: false)
            feature("Customer problems", free: false)
            feature("Competitors & alternatives", free: false)
            feature("Source-backed research", free: false)
        }
    }

    private func feature(_ title: String, free: Bool) -> some View {
        VStack(spacing: 0) {
            Divider().overlay(QuestPageInk.rule.opacity(0.35))
            if typeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 5) {
                    Text(title).font(.body.weight(.medium))
                    Text(free ? "Included with Free and Marketing" : "Included with Marketing")
                        .font(.subheadline).foregroundStyle(QuestPageInk.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 10)
            } else {
                HStack(spacing: 8) {
                    Text(title).font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: free ? "checkmark" : "minus")
                        .foregroundStyle(free ? QuestPageInk.navy : QuestPageInk.secondary).frame(width: 42)
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(QuestPageInk.gold).frame(width: 84)
                }.font(.body.weight(.semibold)).padding(.vertical, 9)
            }
        }.accessibilityElement(children: .ignore)
            .accessibilityLabel("\(title). \(free ? "Included with Free and Marketing" : "Included with Marketing")")
    }

    @ViewBuilder private var coveragePicker: some View {
        if typeSize.isAccessibilitySize {
            VStack(spacing: 10) {
                ForEach(MarketingCoverage.allCases) { option in
                    Button { coverage = option } label: {
                        HStack(spacing: 14) {
                            Image(systemName: coverage == option ? "checkmark.circle.fill" : "circle")
                            Text(option.title).frame(maxWidth: .infinity, alignment: .leading)
                        }.font(.body).frame(minHeight: 44)
                    }.buttonStyle(.plain).accessibilityAddTraits(coverage == option ? .isSelected : [])
                }
            }
        } else {
            Picker("Marketing coverage", selection: $coverage) {
                Text("1 app").tag(MarketingCoverage.one)
                Text("Up to 3 apps").tag(MarketingCoverage.three)
            }.pickerStyle(.segmented).accessibilityIdentifier("paywall.coverage")
        }
    }

    private var appSelection: some View {
        DisclosureGroup(isExpanded: $choosingApps) {
            VStack(spacing: 4) {
                ForEach(model.apps) { app in
                    Button {
                        if selectedApps.contains(app.id) { selectedApps.remove(app.id) }
                        else if appLimit == 1 { selectedApps = [app.id] }
                        else if selectedApps.count < appLimit { selectedApps.insert(app.id) }
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: selectedApps.contains(app.id) ? "checkmark.circle.fill" : "circle")
                            Text(app.name).frame(maxWidth: .infinity, alignment: .leading)
                        }.frame(minHeight: 44).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                        .disabled(billing.isBusy || (!selectedApps.contains(app.id) && appLimit > 1 && selectedApps.count >= appLimit))
                        .accessibilityAddTraits(selectedApps.contains(app.id) ? .isSelected : [])
                }
                Text("Choose up to \(appLimit) \(appLimit == 1 ? "app" : "apps") for marketing. Sales tracking stays free for all your apps.")
                    .font(.footnote).foregroundStyle(QuestPageInk.secondary)
            }.padding(.top, 8)
        } label: {
            Text(selectedAppNames.isEmpty ? "Choose your app" : selectedAppNames)
                .font(.subheadline.weight(.medium)).fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityIdentifier("paywall.apps")
    }

    private var plans: some View {
        VStack(spacing: 8) {
            planRow(.annual, title: "Annual", cadence: "year")
            planRow(.monthly, title: "Monthly", cadence: "month")
        }.disabled(billing.isBusy)
    }

    private func planRow(_ value: MarketingPeriod, title: String, cadence: String, compact: Bool = false) -> some View {
        let option = MarketingPlan(coverage: coverage, period: value)
        let price = billing.displayPrice(for: option)
        return Button { period = value } label: {
            Group {
                if compact {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 8) {
                            Image(systemName: period == value ? "largecircle.fill.circle" : "circle")
                                .foregroundStyle(period == value ? QuestPageInk.gold : QuestPageInk.secondary)
                            Text(title).font(.headline)
                        }
                        Text(price.map { "\($0) / \(cadence)" } ?? (billing.isLoading ? "Loading price…" : "Price unavailable"))
                            .font(.footnote.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    HStack(spacing: 12) {
                        Image(systemName: period == value ? "largecircle.fill.circle" : "circle")
                            .font(.title2).foregroundStyle(period == value ? QuestPageInk.gold : QuestPageInk.secondary)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(title).font(.headline)
                            Text(price.map { "\($0) / \(cadence)" } ?? (billing.isLoading ? "Loading price…" : "Price unavailable"))
                                .font(.body.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                        if period == value { Image(systemName: "checkmark").accessibilityHidden(true) }
                    }
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.white.opacity(period == value ? 0.40 : 0.16), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(period == value ? QuestPageInk.gold : QuestPageInk.rule.opacity(0.4), lineWidth: period == value ? 1.5 : 1))
        }.buttonStyle(.plain).accessibilityAddTraits(period == value ? .isSelected : [])
            .accessibilityIdentifier("paywall.\(cadence)")
    }

    @ViewBuilder private var messages: some View {
        if !billing.isPreview && !billing.isEnabled && !billing.isLoading {
            Text("Marketing subscriptions are currently unavailable. You can continue with free sales tracking.")
                .font(.footnote).foregroundStyle(QuestPageInk.secondary)
        }
        if model.apps.isEmpty {
            Button("Connect an app") { close(); model.selectedTab = "apps" }.frame(minHeight: 44)
        }
        if let error = billing.errorMessage {
            Text(error).font(.footnote).foregroundStyle(QuestPageInk.navy)
                .accessibilityIdentifier("paywall.error")
            Button("Try again") { Task { await billing.load() } }.frame(minHeight: 44)
        }
        if let status = billing.statusMessage { Text(status).font(.footnote).foregroundStyle(QuestPageInk.secondary) }
    }

    private var actions: some View {
        VStack(spacing: 8) {
            if billing.hasActiveSubscription {
                QuestPageButton(title: "Save selected apps", busy: billing.isBusy, disabled: selectedApps.isEmpty) {
                    Task { await billing.updateApps(selectedAppIDs) }
                }
                Button("Manage subscription") { managingSubscription = true }.frame(minHeight: 44)
            } else {
                QuestPageButton(title: "Subscribe to Marketing", symbol: "arrow.right", busy: billing.isPurchasing,
                                disabled: !billing.canPurchase(plan, appIDs: selectedAppIDs)) {
                    Task { await billing.purchase(plan, appIDs: selectedAppIDs) }
                }.accessibilityIdentifier("paywall.subscribe")
            }
            Button(action: close) {
                Text(billing.hasActiveSubscription ? "Continue" : "Continue with free sales tracking")
                    .font(.subheadline.weight(.semibold)).multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }.buttonStyle(.plain).disabled(billing.isBusy).accessibilityIdentifier("paywall.continueFree")
        }
    }

    private var checkout: some View {
        VStack(spacing: 8) {
            if !billing.hasActiveSubscription, let price = billing.displayPrice(for: plan) {
                Text("\(price) / \(period == .annual ? "year" : "month") · Billed \(period == .annual ? "annually" : "monthly")")
                    .font(.footnote.weight(.semibold)).multilineTextAlignment(.center)
                    .accessibilityIdentifier("paywall.selectedPrice")
                Text("Renews automatically. Cancel anytime.")
                    .font(.caption).foregroundStyle(QuestPageInk.secondary).multilineTextAlignment(.center)
            }
            actions
        }
    }

    private var legal: some View {
        VStack(spacing: 4) {
            if !billing.hasActiveSubscription, let price = billing.displayPrice(for: plan) {
                Text("\(price) billed \(period == .annual ? "annually" : "monthly"). Payment is charged at confirmation. Renews automatically unless canceled in App Store settings.")
                    .font(.caption).foregroundStyle(QuestPageInk.secondary)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 18) { legalLinks }
                VStack(spacing: 0) { legalLinks }
            }
        }
    }

    @ViewBuilder private var legalLinks: some View {
        Button("Restore purchases") { Task { await billing.restore() } }
            .font(.footnote).frame(minHeight: 44)
            .disabled(billing.isBusy || billing.isPreview).accessibilityIdentifier("paywall.restore")
        Link("Terms", destination: URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!)
            .font(.footnote).frame(minHeight: 44)
        Link("Privacy", destination: model.privacyURL)
            .font(.footnote).frame(minHeight: 44)
    }

    private func selectInitialApps() {
        let preferred = model.onboarding?.appId ?? model.selectedLeadAppID
        let ids = model.apps.map(\.id)
        selectedApps = Set((preferred.flatMap { ids.contains($0) ? [$0] : nil } ?? Array(ids.prefix(1))).prefix(appLimit))
    }

    private func close() { if let onClose { onClose() } else { dismiss() } }
}

/// Keeps the free Activity and Apps tabs reachable when marketing isn't subscribed.
struct MarketingAccessView<Content: View>: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var billing: MarketingStore
    @ViewBuilder var content: Content
    var body: some View {
        if billing.subscription == nil && !model.isPreviewMode {
            MarketingConnectionView()
        } else if billing.isEnabled && (!billing.hasActiveSubscription || billing.subscription?.appIDs.isEmpty == true) && !model.isPreviewMode {
            MarketingPaywallView(onClose: { model.selectedTab = "activity" })
        } else { content }
    }
}

struct MarketingConnectionView: View {
    @EnvironmentObject private var model: AppModel
    @EnvironmentObject private var billing: MarketingStore
    @State private var continuationError: String?
    var body: some View {
        VStack(spacing: 20) {
            if billing.isLoading { ProgressView("Checking Marketing access…") }
            else {
                Text("Couldn’t check Marketing access").font(.headline)
                Text(billing.errorMessage ?? "Please try again.").font(.subheadline).multilineTextAlignment(.center)
                Button("Try again") { Task { await billing.load() } }.frame(minHeight: 44)
            }
            Button("Continue with free sales tracking") {
                if model.shouldShowOnboarding {
                    Task {
                        do { try await model.moveOnboarding(to: .notifications) }
                        catch { continuationError = error.localizedDescription }
                    }
                }
                else { model.selectedTab = "activity" }
            }.frame(minHeight: 44)
            if let continuationError { Text(continuationError).font(.footnote).multilineTextAlignment(.center) }
        }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
            .foregroundStyle(.white).background(QuestStyle.navy).tint(QuestStyle.gold)
    }
}

struct MarketingCoverageNotice: View {
    @State private var showingPaywall = false
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "sparkles").font(.title)
            Text("Choose this app for Marketing").font(.system(.title2, design: .serif, weight: .semibold))
            Text("Manage the apps covered by your subscription to see leads and market insights here.")
                .font(.subheadline).multilineTextAlignment(.center)
            Button("Manage Marketing apps") { showingPaywall = true }
                .font(.headline).frame(minHeight: 44)
        }.padding(24).frame(maxWidth: .infinity).foregroundStyle(QuestStyle.gold)
            .fullScreenCover(isPresented: $showingPaywall) { MarketingPaywallView() }
    }
}
