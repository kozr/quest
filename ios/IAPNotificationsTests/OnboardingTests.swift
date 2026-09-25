import XCTest
@testable import IAPNotifications

final class OnboardingTests: XCTestCase {
    private func app(production: String? = nil, sandbox: String? = nil,
                     productionURL: String = "https://api.example.com/webhooks/apple/secret/production",
                     forwardingURL: String = "https://api.example.com/webhooks/apple/secret/forward") -> ConnectedApp {
        ConnectedApp(id: "app-1", name: "Example", bundleId: "com.example.app", appleId: "1234", source: "apple",
            iconUrl: nil, createdAt: "2026-09-24", webhookUrls: .init(production: productionURL, sandbox: ""),
            lastProductionEventAt: production, lastSandboxEventAt: sandbox, forwardingUrl: forwardingURL)
    }

    func testSavedSetupAndSandboxDoNotVerifyProduction() {
        let progress = StoreConnectionProgress(step: .status, pushPromptSeen: true, started: true)
        XCTAssertEqual(progress.step, .status)
        XCTAssertFalse(app().hasVerifiedProductionConnection)
        XCTAssertFalse(app(sandbox: "2026-09-24T12:00:00Z").hasVerifiedProductionConnection)
        XCTAssertFalse(app(production: " ").hasVerifiedProductionConnection)
        XCTAssertTrue(app(production: "2026-09-24T12:00:00Z").hasVerifiedProductionConnection)
    }

    func testProvidersUseCorrectEndpointAndRejectUntrustedURLs() {
        XCTAssertEqual(StoreConnectionProvider.apple.notificationURL(for: app(), serverURL: "https://api.example.com")?.lastPathComponent, "production")
        XCTAssertEqual(StoreConnectionProvider.revenuecat.notificationURL(for: app(), serverURL: "https://api.example.com")?.lastPathComponent, "forward")
        for value in ["https://evil.example/webhooks/apple/secret/production",
                      "http://api.example.com/webhooks/apple/secret/production",
                      "https://user:password@api.example.com/webhooks/apple/secret/production",
                      "https://api.example.com/webhooks/apple/secret/sandbox",
                      "https://api.example.com/webhooks/apple/secret/production?token=bad"] {
            XCTAssertNil(StoreConnectionProvider.apple.notificationURL(for: app(productionURL: value), serverURL: "https://api.example.com"))
        }
        XCTAssertEqual(StoreConnectionProvider.revenuecat.dashboardURL(appleID: "1234").host, "app.revenuecat.com")
        XCTAssertEqual(StoreConnectionProvider.apple.dashboardURL(appleID: "../bad").path, "/apps")
    }

    func testSetupProgressPersistsAndIsScopedToAccountAppAndServer() throws {
        let original = StoreConnectionProgress(provider: .revenuecat, step: .status, pushPromptSeen: true, started: true)
        let decoded = try JSONDecoder().decode(StoreConnectionProgress.self, from: JSONEncoder().encode(original))
        XCTAssertEqual(decoded, original)
        let key = StoreConnectionProgress.key(server: "https://one", userID: "a", appID: "app")
        XCTAssertNotEqual(key, StoreConnectionProgress.key(server: "https://two", userID: "a", appID: "app"))
        XCTAssertNotEqual(key, StoreConnectionProgress.key(server: "https://one", userID: "b", appID: "app"))
        XCTAssertNotEqual(key, StoreConnectionProgress.key(server: "https://one", userID: "a", appID: "other"))
    }

    #if DEBUG
    @MainActor
    func testPreviewProviderNavigationCannotConfirmStoreOrRegisterPhone() async throws {
        let model = AppModel(loadStoredState: false)
        await model.enterOnboardingPreview(stage: .notifications)
        let app = try XCTUnwrap(model.apps.first)
        XCTAssertFalse(model.connectionProgress(for: app).pushPromptSeen)
        model.updateConnectionProgress(for: app) { $0.provider = .revenuecat; $0.step = .status; $0.started = true; $0.pushPromptSeen = true }
        XCTAssertEqual(model.connectionProgress(for: app).provider, .revenuecat)
        XCTAssertFalse(app.hasVerifiedProductionConnection)
        await model.enableNotifications()
        XCTAssertFalse(model.phoneAlertsReady)
        XCTAssertNil(model.deviceId)
        try await model.finishOnboarding()
        XCTAssertNil(model.unfinishedStoreSetup, "Demo never shows a real connection reminder")
    }
    #endif

    func testCopyCollapsesReplyAndKeepsSelectionWhenReopened() {
        var state = OnboardingReplySelection()
        state.toggle("resource")
        XCTAssertEqual(state.expandedID, "resource")
        state.copied("resource")
        XCTAssertNil(state.expandedID)
        XCTAssertEqual(state.copiedID, "resource")
        state.toggle("resource")
        XCTAssertEqual(state.expandedID, "resource")
        XCTAssertEqual(state.copiedID, "resource")
        state.toggle("light")
        XCTAssertEqual(state.copiedID, "resource")
        state.copied("light")
        XCTAssertEqual(state.copiedID, "light")
        XCTAssertNil(state.expandedID)
    }

    func testLockedCountDoesNotInventOpportunities() throws {
        let zero = LockedQuests(count: 0, hasMore: false, previews: [])
        XCTAssertEqual(zero.title, "More quests")
        XCTAssertEqual(LockedQuests(count: 1, hasMore: false, previews: []).title, "1 more quest")
        XCTAssertEqual(LockedQuests(count: 100, hasMore: true, previews: []).title, "100+ more quests")
        let json = #"{"count":2,"hasMore":false,"previews":[{"id":"abc","community":"journaling"}]}"#.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(LockedQuests.self, from: json)
        XCTAssertEqual(decoded.count, 2)
        XCTAssertEqual(decoded.previews.first?.community, "journaling")
    }

    func testTrialDeadlineOverridesStaleServerFlag() {
        var state = QuestOnboardingState(stage: .complete)
        state.trialActive = true
        state.trialEndsAt = Date().addingTimeInterval(-1).timeIntervalSince1970 * 1000
        XCTAssertFalse(state.hasActiveTrial)
        state.trialEndsAt = Date().addingTimeInterval(60).timeIntervalSince1970 * 1000
        XCTAssertTrue(state.hasActiveTrial)
    }

    #if DEBUG
    @MainActor
    func testOfflineFlowKeepsPreviewIsolatedAndFinishesInLeads() async throws {
        let model = AppModel(loadStoredState: false)
        await model.enterOnboardingPreview(stage: .trial)
        XCTAssertTrue(model.isPreviewMode)
        XCTAssertTrue(model.shouldShowOnboarding)
        XCTAssertNil(model.deviceId)
        try await model.moveOnboarding(to: .notifications)
        XCTAssertEqual(model.onboarding?.stage, .notifications)
        XCTAssertNil(model.onboarding?.trialStartedAt, "Skipping never starts a trial")
        try await model.finishOnboarding()
        XCTAssertFalse(model.shouldShowOnboarding)
        XCTAssertEqual(model.selectedTab, "leads")
        XCTAssertNil(model.deviceId)
    }
    #endif
}
