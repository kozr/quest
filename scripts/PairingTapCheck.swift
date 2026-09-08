// Offline simulator harness: compile with the real PairingView.swift, NOT the app.
// Stub callbacks only count taps. No network, credentials or authentication bypass.
import SwiftUI

struct CheckAccount { let email = "tap-check@example.invalid" }
struct CheckServer { let url = "https://example.invalid" }
struct PairingReview {
    let id = "tap-check"
    let code = "123456"
    let browserName = "Offline tap check"
    let expiration: Date? = Date().addingTimeInterval(900)
}
@MainActor final class AppModel: ObservableObject {
    let user: CheckAccount? = CheckAccount()
    let serverSettings = CheckServer()
    @Published var pairingReview: PairingReview? = PairingReview()
    @Published var pairingNotice: String?
    @Published var pairingError: String?
    @Published var pairingIsBusy = false
    @Published var isPairingPresented = true
    @Published var approvals = 0
    @Published var denials = 0
    @Published var resets = 0
    func closePairing() {}
    func resetPairing() { resets += 1 }
    func approvePairing() async { approvals += 1 }
    func denyPairing() async { denials += 1 }
    func inspectPairingLink(_ value: String) async {}
}
@main struct PairingTapCheck: App {
    @StateObject private var model = AppModel()
    var body: some Scene {
        WindowGroup {
            PairingView().environmentObject(model)
                .safeAreaInset(edge: .bottom) {
                    Text("Approve: \(model.approvals) · Deny: \(model.denials) · Reset: \(model.resets)")
                        .font(.footnote.monospacedDigit()).padding(8)
                        .frame(maxWidth: .infinity).background(.bar)
                        .accessibilityIdentifier("tapCounts")
                }
        }
    }
}
