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
                .task {
                    let output = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("main-page-headers")
                    try? FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
                    for tab in ["activity", "leads", "market", "apps", "settings"] {
                        model.selectedTab = tab
                        try? await Task.sleep(for: .seconds(2))
                        guard let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap(\.windows).first(where: \.isKeyWindow) else { continue }
                        let screenshot = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                        }
                        try? screenshot.pngData()?.write(to: output.appendingPathComponent(tab + ".png"))
                    }
                }
        }
    }
}
