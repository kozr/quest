import Foundation
import StoreKit
import Combine

enum MarketingCoverage: String, CaseIterable, Identifiable, Codable {
    case one, three
    var id: String { rawValue }
    var appLimit: Int { self == .one ? 1 : 3 }
    var title: String { self == .one ? "1 app" : "Up to 3 apps" }
}

enum MarketingPeriod: String, CaseIterable, Identifiable, Codable {
    case monthly, annual
    var id: String { rawValue }
    var title: String { self == .monthly ? "Monthly" : "Annual" }
    var billingUnit: String { self == .monthly ? "month" : "year" }
}

struct MarketingPlan: Hashable, Identifiable {
    let coverage: MarketingCoverage
    let period: MarketingPeriod
    var productID: String { "com.kozr.quest.marketing.\(coverage.rawValue).\(period.rawValue)" }
    var id: String { productID }

    static let all = MarketingCoverage.allCases.flatMap { coverage in
        MarketingPeriod.allCases.map { MarketingPlan(coverage: coverage, period: $0) }
    }

    init(coverage: MarketingCoverage, period: MarketingPeriod) {
        self.coverage = coverage
        self.period = period
    }

    init?(productID: String) {
        guard let plan = Self.all.first(where: { $0.productID == productID }) else { return nil }
        self = plan
    }

    func accepts(appIDs: [String]) -> Bool {
        !appIDs.isEmpty && appIDs.count <= coverage.appLimit &&
        Set(appIDs).count == appIDs.count && appIDs.allSatisfy { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }
}

/// Only the authenticated server's verified entitlement can grant marketing access.
struct MarketingSubscription: Codable, Equatable {
    let enabled: Bool
    let active: Bool
    let appLimit: Int
    let appIDs: [String]
    let appAccountToken: String
    let productID: String?
    /// Milliseconds since the Unix epoch, matching the API response.
    let expiresAt: Double?

    var plan: MarketingPlan? { productID.flatMap(MarketingPlan.init(productID:)) }
    var accountToken: UUID? { UUID(uuidString: appAccountToken) }
    var expirationDate: Date? {
        guard let expiresAt, expiresAt.isFinite else { return nil }
        return Date(timeIntervalSince1970: expiresAt / 1_000)
    }

    func isActive(at date: Date = Date()) -> Bool {
        enabled && active && accountToken != nil && plan?.coverage.appLimit == appLimit &&
        expirationDate.map { $0 > date } == true
    }

    func grantsAccess(to appID: String, at date: Date = Date()) -> Bool {
        isActive(at: date) && appIDs.contains(appID)
    }

    func validated() throws -> Self {
        guard accountToken != nil, [0, 1, 3].contains(appLimit),
              appIDs.count <= appLimit, Set(appIDs).count == appIDs.count,
              appIDs.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }),
              expiresAt.map({ $0.isFinite }) ?? true else { throw ClientError.invalidResponse }
        if active {
            guard plan?.coverage.appLimit == appLimit, expirationDate != nil else {
                throw ClientError.invalidResponse
            }
        }
        return self
    }

    func removingAccess() -> Self {
        Self(enabled: enabled, active: false, appLimit: appLimit, appIDs: appIDs,
             appAccountToken: appAccountToken, productID: productID, expiresAt: expiresAt)
    }
}

@MainActor
final class MarketingStore: ObservableObject {
    @Published private(set) var subscription: MarketingSubscription?
    @Published private(set) var products: [String: Product] = [:]
    @Published private(set) var isLoading = false
    @Published private(set) var isPurchasing = false
    @Published private(set) var isRestoring = false
    @Published private(set) var isUpdatingApps = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var statusMessage: String?
    @Published private(set) var isPreview = false

    // Session-only and restrictive: debug can hide access, never invent a purchase.
    @Published private(set) var simulatesNoPurchase = false
    @Published private(set) var allowsPaywallDebug = false

    func setPaywallDebugAvailable(_ available: Bool) {
        allowsPaywallDebug = available && userID != nil && !isPreview
        if !allowsPaywallDebug { simulatesNoPurchase = false }
    }

    func simulateNoPurchase(_ enabled: Bool) {
        simulatesNoPurchase = allowsPaywallDebug && enabled
    }

    var needsPaywall: Bool {
        simulatesNoPurchase || !hasActiveSubscription || subscription?.appIDs.isEmpty != false
    }

    private var client: APIClient?
    private var userID: String?
    private var accountRevision = UUID()
    private var statusRequestID = UUID()
    private var loadRequestID = UUID()
    private var updatesTask: Task<Void, Never>?
    private var expiryTask: Task<Void, Never>?
    private var pendingAppIDs: [String]?

    var hasActiveSubscription: Bool { !simulatesNoPurchase && subscription?.isActive() == true }
    var isEnabled: Bool { subscription?.enabled == true }
    var isBusy: Bool { isLoading || isPurchasing || isRestoring || isUpdatingApps }

    init(observeTransactions: Bool = true) {
        if observeTransactions {
            updatesTask = Task { [weak self] in
                for await result in Transaction.updates {
                    guard !Task.isCancelled else { return }
                    await self?.receive(result)
                }
            }
        }
    }

    deinit {
        updatesTask?.cancel()
        expiryTask?.cancel()
    }

    func configure(client: APIClient?, userID: String?, preview: Bool = false) {
        #if DEBUG
        let preview = preview
        #else
        let preview = false
        #endif
        let changed = self.userID != userID || self.client?.baseURL != client?.baseURL ||
            self.client?.token != client?.token || isPreview != preview
        self.client = preview ? nil : client
        self.userID = userID
        guard changed else { return }
        accountRevision = UUID()
        statusRequestID = UUID()
        loadRequestID = UUID()
        expiryTask?.cancel()
        subscription = nil
        simulatesNoPurchase = false
        allowsPaywallDebug = false
        products = [:]
        pendingAppIDs = nil
        isLoading = false
        isPurchasing = false
        isRestoring = false
        isUpdatingApps = false
        errorMessage = nil
        statusMessage = nil
        isPreview = preview
    }

    func canAccess(appID: String) -> Bool {
        !isPreview && !simulatesNoPurchase && subscription?.grantsAccess(to: appID) == true
    }

    func displayPrice(for plan: MarketingPlan) -> String? {
        #if DEBUG
        if isPreview {
            switch (plan.coverage, plan.period) {
            case (.one, .monthly): return "$29.99"
            case (.one, .annual): return "$299.00"
            case (.three, .monthly): return "$74.99"
            case (.three, .annual): return "$749.99"
            }
        }
        #endif
        return products[plan.productID]?.displayPrice
    }

    func canPurchase(_ plan: MarketingPlan, appIDs: [String]) -> Bool {
        !isPreview && !isBusy && client != nil && userID != nil &&
        isEnabled && subscription?.isActive() != true && subscription?.accountToken != nil &&
        products[plan.productID] != nil && plan.accepts(appIDs: appIDs)
    }

    func load() async {
        guard !isPreview, client != nil, userID != nil, !isLoading else { return }
        let revision = accountRevision
        let request = UUID()
        loadRequestID = request
        isLoading = true
        errorMessage = nil
        defer { if revision == accountRevision && request == loadRequestID { isLoading = false } }
        await refresh()
        guard revision == accountRevision, request == loadRequestID, isEnabled else { return }
        do {
            let available = try await Product.products(for: MarketingPlan.all.map(\.productID))
            guard revision == accountRevision, request == loadRequestID else { return }
            products = Dictionary(uniqueKeysWithValues: available.filter { product in
                guard let plan = MarketingPlan(productID: product.id), product.type == .autoRenewable,
                      let period = product.subscription?.subscriptionPeriod else { return false }
                return period.value == 1 && period.unit == (plan.period == .monthly ? .month : .year)
            }.map { ($0.id, $0) })
            if products.isEmpty {
                errorMessage = "Subscriptions are unavailable from the App Store right now. You can continue with free sales tracking."
            }
            // Retry unfinished transactions after network failures and reconcile purchases on another device.
            try await synchronizeCurrentEntitlements(revision: revision, restoring: false)
        } catch {
            report(error, revision: revision)
        }
    }

    func refresh() async {
        guard !isPreview, let client, userID != nil else { return }
        let revision = accountRevision
        let request = UUID()
        statusRequestID = request
        do {
            let response: MarketingSubscription = try await client.request("/api/marketing/subscription")
            guard revision == accountRevision, request == statusRequestID else { return }
            apply(try response.validated())
            errorMessage = nil
        } catch {
            guard request == statusRequestID else { return }
            report(error, revision: revision)
        }
    }

    func purchase(_ plan: MarketingPlan, appIDs: [String]) async {
        guard canPurchase(plan, appIDs: appIDs), let product = products[plan.productID],
              let token = subscription?.accountToken else { return }
        let revision = accountRevision
        isPurchasing = true
        errorMessage = nil
        statusMessage = nil
        pendingAppIDs = appIDs
        defer {
            if revision == accountRevision {
                isPurchasing = false
                pendingAppIDs = nil
            }
        }
        do {
            // Apple IDs can differ from Quest accounts. Do not sell a second subscription to an
            // Apple ID that already has an active marketing purchase belonging to another account.
            for await result in Transaction.currentEntitlements {
                guard revision == accountRevision else { return }
                if case .unverified(let transaction, _) = result,
                   MarketingPlan(productID: transaction.productID) != nil {
                    throw ClientError.message("Apple could not verify your existing Marketing purchase. Try Restore purchases before subscribing again.")
                }
                guard case .verified(let transaction) = result,
                      MarketingPlan(productID: transaction.productID) != nil,
                      transaction.revocationDate == nil, !transaction.isUpgraded,
                      transaction.expirationDate.map({ $0 > Date() }) == true else { continue }
                if transaction.appAccountToken == token {
                    try await synchronize(result, appIDs: appIDs, revision: revision)
                    guard revision == accountRevision else { return }
                    statusMessage = "Your existing Marketing subscription has been restored."
                } else {
                    throw ClientError.message("This Apple account already has a Marketing subscription. Sign in to the Quest account used for that purchase, then restore it.")
                }
                return
            }
            guard revision == accountRevision else { return }
            switch try await product.purchase(options: [.appAccountToken(token)]) {
            case .success(let result):
                try await synchronize(result, appIDs: appIDs, revision: revision)
                guard revision == accountRevision else { return }
                statusMessage = hasActiveSubscription ? "Marketing is ready for your selected apps." : "Your purchase is being verified. Try Restore purchases if it does not appear."
            case .userCancelled:
                break
            case .pending:
                guard revision == accountRevision else { return }
                statusMessage = "Your purchase is awaiting approval. Marketing will unlock after Apple confirms payment."
            @unknown default:
                throw ClientError.message("The App Store could not complete this purchase. Please try again.")
            }
        } catch {
            report(error, revision: revision)
        }
    }

    func restore() async {
        guard !isPreview, !isBusy, client != nil, userID != nil else { return }
        let revision = accountRevision
        isRestoring = true
        errorMessage = nil
        statusMessage = nil
        defer { if revision == accountRevision { isRestoring = false } }
        await refresh()
        guard revision == accountRevision, isEnabled else { return }
        do {
            try await AppStore.sync()
            guard revision == accountRevision else { return }
            try await synchronizeCurrentEntitlements(revision: revision, restoring: true)
            guard revision == accountRevision else { return }
            statusMessage = hasActiveSubscription
                ? "Your Marketing subscription has been restored."
                : "No active Marketing subscription was found for this account."
        } catch {
            report(error, revision: revision)
        }
    }

    func updateApps(_ appIDs: [String]) async {
        guard !isPreview, !isBusy, let client, hasActiveSubscription,
              subscription?.plan?.accepts(appIDs: appIDs) == true else { return }
        let revision = accountRevision
        isUpdatingApps = true
        errorMessage = nil
        statusMessage = nil
        defer { if revision == accountRevision { isUpdatingApps = false } }
        do {
            let response: MarketingSubscription = try await client.send("/api/marketing/subscription/apps", method: "PUT",
                body: SelectionRequest(appIDs: appIDs))
            guard revision == accountRevision else { return }
            statusRequestID = UUID()
            apply(try response.validated())
            statusMessage = "Marketing coverage updated."
        } catch {
            report(error, revision: revision)
        }
    }

    private func receive(_ result: VerificationResult<Transaction>) async {
        guard !isPreview, client != nil, userID != nil else { return }
        let revision = accountRevision
        guard case .verified(let transaction) = result,
              MarketingPlan(productID: transaction.productID) != nil else { return }
        if subscription == nil { await refresh() }
        guard revision == accountRevision, isEnabled,
              transaction.appAccountToken == subscription?.accountToken else { return }
        if transaction.revocationDate != nil || transaction.expirationDate.map({ $0 <= Date() }) == true {
            if subscription?.productID == transaction.productID, let subscription {
                apply(subscription.removingAccess())
            }
        }
        do {
            try await synchronize(result, appIDs: pendingAppIDs ?? subscription?.appIDs ?? [], revision: revision)
        } catch {
            report(error, revision: revision)
        }
    }

    private func synchronizeCurrentEntitlements(revision: UUID, restoring: Bool) async throws {
        guard revision == accountRevision, isEnabled else { return }
        var otherAccount = false
        for await result in Transaction.currentEntitlements {
            guard revision == accountRevision else { return }
            if case .unverified(let transaction, _) = result,
               MarketingPlan(productID: transaction.productID) != nil {
                throw ClientError.message("Apple could not verify your Marketing purchase. Please try Restore purchases again.")
            }
            guard case .verified(let transaction) = result,
                  MarketingPlan(productID: transaction.productID) != nil,
                  !transaction.isUpgraded else { continue }
            guard transaction.appAccountToken == subscription?.accountToken else {
                otherAccount = true
                continue
            }
            try await synchronize(result, appIDs: subscription?.appIDs ?? [], revision: revision)
        }
        if restoring, otherAccount, !hasActiveSubscription {
            throw ClientError.message("A Marketing purchase belongs to another Quest account. Sign in to the account used for that purchase to restore it.")
        }
    }

    private func synchronize(_ result: VerificationResult<Transaction>, appIDs: [String], revision: UUID) async throws {
        guard revision == accountRevision, let client else { return }
        guard case .verified(let transaction) = result,
              let plan = MarketingPlan(productID: transaction.productID),
              transaction.appAccountToken == subscription?.accountToken else {
            throw ClientError.message("Apple could not verify this purchase for your account. Please try Restore purchases.")
        }
        let response: MarketingSubscription = try await client.send("/api/marketing/subscription",
            body: TransactionRequest(signedTransaction: result.jwsRepresentation,
                                     appIDs: Array(appIDs.prefix(plan.coverage.appLimit))))
        guard revision == accountRevision else { return }
        let verified = try response.validated()
        guard verified.accountToken == transaction.appAccountToken else { throw ClientError.invalidResponse }
        // Server verification and account binding must succeed before acknowledging delivery.
        statusRequestID = UUID()
        apply(verified)
        await transaction.finish()
    }

    private func apply(_ value: MarketingSubscription) {
        subscription = value
        expiryTask?.cancel()
        guard value.isActive(), let expiry = value.expirationDate else { return }
        let revision = accountRevision
        expiryTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(max(0, expiry.timeIntervalSinceNow))) }
            catch { return }
            guard let self, self.accountRevision == revision, self.subscription == value else { return }
            self.subscription = value.removingAccess()
            await self.refresh()
        }
    }

    private func report(_ error: Error, revision: UUID) {
        guard revision == accountRevision else { return }
        if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
        if case StoreKitError.userCancelled = error { return }
        if (error as? ClientError)?.isUnauthorized == true {
            expiryTask?.cancel()
            subscription = nil
            products = [:]
        }
        errorMessage = error.localizedDescription
    }

    private struct TransactionRequest: Encodable { let signedTransaction: String; let appIDs: [String] }
    private struct SelectionRequest: Encodable { let appIDs: [String] }
}
