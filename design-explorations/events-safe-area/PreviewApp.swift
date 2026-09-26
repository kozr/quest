import SwiftUI
import UIKit
import UserNotifications
import AuthenticationServices

@main
struct IAPNotificationsApp: App {
    @StateObject private var model: AppModel = {
        let model = AppModel(loadStoredState: false)
        model.enterPreview()
        return model
    }()
    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(model)
                .environment(\.dynamicTypeSize, ProcessInfo.processInfo.arguments.contains("--large-text") ? .accessibility3 : .large)
                .preferredColorScheme(.dark)
                .task { await capture() }
        }
    }
    @MainActor private func capture() async {
        let output = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("events-safe-area")
        try? FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        try? await Task.sleep(for: .seconds(1))
        let queued = model.queuedSales.map(\.id)
        model.showActivity()
        for section in [ActivitySection.events, .trials] {
            model.activitySection = section
            try? await Task.sleep(for: .seconds(2))
            guard let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap(\.windows).first(where: \.isKeyWindow) else { continue }
            let shot = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            try? shot.pngData()?.write(to: output.appendingPathComponent(section.rawValue.lowercased() + ".png"))
            func controllers(_ controller: UIViewController) -> [UIViewController] {
                [controller] + controller.children.flatMap(controllers)
            }
            if let root = window.rootViewController,
               let navigation = controllers(root).compactMap({ $0 as? UINavigationController }).first(where: { $0.viewControllers.count > 1 }) {
                let checks: [String: Bool] = [
                    "native back bar visible": !navigation.isNavigationBarHidden,
                    "native back stack preserved": navigation.viewControllers.count == 2,
                    "swipe back enabled": navigation.interactivePopGestureRecognizer?.isEnabled == true,
                    "queued sales unchanged": queued == model.queuedSales.map(\.id)
                ]
                try? JSONSerialization.data(withJSONObject: checks, options: [.prettyPrinted, .sortedKeys])
                    .write(to: output.appendingPathComponent(section.rawValue.lowercased() + "-checks.json"))
            }
        }
    }
}
