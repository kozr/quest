import SwiftUI
import SceneKit

enum QuestStyle {
    static let navy = Color(red: 7/255, green: 30/255, blue: 50/255)
    static let gold = Color(red: 255/255, green: 204/255, blue: 93/255)
    static let muted = Color(red: 194/255, green: 211/255, blue: 227/255)
}

struct QuestMainPageTitle: View {
    let title: String
    let systemImage: String
    @ScaledMetric(relativeTo: .title3) private var iconWidth: CGFloat = 24

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: systemImage)
                .foregroundStyle(QuestStyle.gold)
                .font(.title3)
                .frame(width: iconWidth)
                .accessibilityHidden(true)
            Text(title)
                .font(.system(.largeTitle, design: .rounded, weight: .bold))
                .foregroundStyle(.white)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
        }
    }
}

/// Shared geometry for the utility tabs. Activity retains its immersive layout.
enum QuestPageLayout {
    static let margin: CGFloat = 16
    static let sectionSpacing: CGFloat = 16
}

struct QuestMainPageHeader<Actions: View>: View {
    let title: String
    let systemImage: String
    var subtitle: String? = nil
    @ViewBuilder var actions: Actions
    @ScaledMetric(relativeTo: .largeTitle) private var titleHeight: CGFloat = 44

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 12) {
                QuestMainPageTitle(title: title, systemImage: systemImage)
                    .frame(maxWidth: .infinity, alignment: .leading)
                actions
            }
            // Keep the title row aligned with the 44-point page actions.
            .frame(minHeight: titleHeight, alignment: .topLeading)
            Text(subtitle ?? " ")
                .font(.caption.weight(.medium))
                .foregroundStyle(QuestStyle.gold)
                .accessibilityHidden(subtitle == nil)
        }
        .padding(QuestPageLayout.margin)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            GeometryReader { geometry in
                Image("QuestLandscape").resizable().scaledToFill()
                    .frame(width: geometry.size.width, height: geometry.size.height + 60, alignment: .top)
                    .clipped()
                    .overlay(LinearGradient(colors: [QuestStyle.navy.opacity(0.3), QuestStyle.navy],
                                            startPoint: .top, endPoint: .bottom))
                    .offset(y: -60)
            }
            .allowsHitTesting(false).accessibilityHidden(true)
        }
        .background(QuestStyle.navy)
    }
}

/// One stretchable wooden frame, parchment, and brass bookmark for both boards.
struct QuestBoardBackground: View {
    var body: some View {
        GeometryReader { geometry in
            Image("LeadsSharedBoard")
                .resizable(capInsets: EdgeInsets(top: 70, leading: 20, bottom: 24, trailing: 48),
                           resizingMode: .stretch)
                .frame(width: geometry.size.width, height: geometry.size.height)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

struct QuestAppPickerLabel: View {
    let app: ConnectedApp
    @ScaledMetric(relativeTo: .subheadline) private var rowHeight: CGFloat = 48

    var body: some View {
        HStack(spacing: 12) {
            Group {
                if let asset = app.bundledIconName {
                    Image(asset).resizable().scaledToFill()
                } else {
                    AsyncImage(url: app.iconUrl.flatMap(URL.init(string:))) { image in
                        image.resizable().scaledToFill()
                    } placeholder: {
                        Image(systemName: "app.fill").foregroundStyle(QuestStyle.gold)
                    }
                }
            }
            .frame(width: 32, height: 32)
            .clipShape(RoundedRectangle(cornerRadius: 7)).accessibilityHidden(true)
            Text(app.name)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
                .fixedSize(horizontal: false, vertical: true)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.down")
                .font(.subheadline.weight(.bold)).foregroundStyle(QuestStyle.muted)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: rowHeight)
        .background(QuestStyle.navy, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14)
            .stroke(Color(red: 0.19, green: 0.38, blue: 0.55), lineWidth: 1))
    }
}

@MainActor
final class QuestReveal: ObservableObject {
    @Published private(set) var sales: [ActivityEvent] = []
    @Published var selectedID: String?
    @Published var itemsVisible = false
    @Published private(set) var batchID = UUID()
    @Published var saved = false

    var isOpen: Bool { !sales.isEmpty }
    var selected: ActivityEvent? { sales.first { $0.id == selectedID } ?? sales.first }

    func begin(_ events: [ActivityEvent]) {
        guard !events.isEmpty else { return }
        sales = events
        selectedID = events.first?.id
        itemsVisible = false
        saved = false
        batchID = UUID()
    }

    func reset() {
        sales = []
        selectedID = nil
        itemsVisible = false
        saved = false
        batchID = UUID()
    }
}

struct QuestView: View {
    @Environment(\.timeZone) private var timeZone
    @EnvironmentObject private var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var typeSize
    @StateObject private var reveal: QuestReveal
    @State private var haptic = 0
    @State private var chestIsVisible = false

    init(reveal: QuestReveal? = nil) {
        _reveal = StateObject(wrappedValue: reveal ?? QuestReveal())
    }

    var body: some View {
        GeometryReader { geometry in
            let stageHeight = max(355, min(465, geometry.size.height * 0.59))
            ScrollView {
                VStack(spacing: 0) {
                    header
                    let sceneLayout = typeSize.isAccessibilitySize
                        ? AnyLayout(VStackLayout(spacing: 16))
                        : AnyLayout(ZStackLayout(alignment: .bottom))
                    sceneLayout {
                        if reveal.isOpen {
                            VStack(spacing: 12) {
                                lootSlots(width: geometry.size.width - 40)
                                if let selected = reveal.selected {
                                    VStack(spacing: 4) {
                                        Text(selected.appName).font(.headline)
                                        Text("\(selected.kind == "renewal" ? "Transaction date · \(Timestamp.display(selected.occurredAt, timeZone: timeZone))" : "Purchase") · \(selected.amountDescription ?? "")")
                                            .font(.subheadline).foregroundStyle(QuestStyle.muted)
                                    }
                                    .multilineTextAlignment(.center)
                                    .padding(.horizontal, 18).padding(.vertical, 12)
                                    .frame(maxWidth: 310)
                                    .background(QuestStyle.navy.opacity(0.96), in: RoundedRectangle(cornerRadius: 12))
                                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(QuestStyle.gold.opacity(0.55), lineWidth: 1))
                                    .opacity(reveal.itemsVisible ? 1 : 0)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.top, 16)
                            .zIndex(1) // Keep purchase details above the raised chest lid.
                        } else {
                            VStack {
                                Label(model.queuedSales.isEmpty ? "Your journey continues" : "\(model.queuedSales.count) new \(model.queuedSales.count == 1 ? "sale" : "sales")", systemImage: "sparkle")
                                    .font(.subheadline.weight(.semibold))
                                    .padding(.horizontal, 16).padding(.vertical, 10)
                                    .background(QuestStyle.navy.opacity(0.88), in: Capsule())
                                Spacer()
                            }.padding(.top, 44)
                        }

                        ZStack(alignment: .bottom) {
                        if reveal.itemsVisible {
                            Ellipse().fill(QuestStyle.gold.opacity(0.45)).blur(radius: 22)
                                .frame(width: 150, height: 65).padding(.bottom, 100)
                                .accessibilityHidden(true)
                        }
                        Button(action: openChest) {
                            QuestChest(isOpen: reveal.isOpen, reduceMotion: reduceMotion,
                                       hasWaitingSales: !model.queuedSales.isEmpty,
                                       isActive: scenePhase == .active && model.selectedTab == "activity"
                                           && !model.isActivityPresented && chestIsVisible)
                                .frame(height: 240).allowsHitTesting(false).accessibilityHidden(true)
                                .contentShape(Rectangle())
                                .background {
                                    GeometryReader { chestGeometry in
                                        Color.clear.preference(key: QuestChestFrameKey.self,
                                            value: chestGeometry.frame(in: .named("questViewport")))
                                    }
                                }
                        }
                        .buttonStyle(.plain)
                        // Ignore repeat taps without applying the button's disabled dimming to the reveal.
                        .allowsHitTesting(!reveal.isOpen && !model.queuedSales.isEmpty)
                        .opacity(!reveal.isOpen && model.queuedSales.isEmpty ? 0.45 : 1)
                        .accessibilityLabel("Open your chest")
                        .accessibilityIdentifier("questChest")
                        .accessibilityHidden(reveal.isOpen || model.queuedSales.isEmpty)
                        }.frame(height: 240)
                    }
                    .frame(height: typeSize.isAccessibilitySize ? nil : stageHeight)
                    .padding(.horizontal, 20)
                    footer.padding(.horizontal, 24).padding(.bottom, 24)
                        .background {
                            LinearGradient(stops: [.init(color: QuestStyle.navy.opacity(0), location: 0),
                                                   .init(color: QuestStyle.navy.opacity(0.97), location: 0.22),
                                                   .init(color: QuestStyle.navy, location: 1)],
                                           startPoint: .top, endPoint: .bottom)
                                .padding(.top, -70)
                        }
                }
                .frame(maxWidth: .infinity, minHeight: geometry.size.height, alignment: .top)
            }
            .coordinateSpace(name: "questViewport")
            .onPreferenceChange(QuestChestFrameKey.self) { frame in
                chestIsVisible = frame.intersects(CGRect(origin: .zero, size: geometry.size))
            }
            .background {
                Image("QuestLandscape").resizable().scaledToFill()
                    .frame(width: geometry.size.width, height: geometry.size.height + geometry.safeAreaInsets.top)
                    .clipped()
                    .overlay(alignment: .bottom) {
                        LinearGradient(stops: [.init(color: .clear, location: 0),
                                               .init(color: QuestStyle.navy, location: 0.8)],
                                       startPoint: .top, endPoint: .bottom).frame(height: 230)
                    }
                    .ignoresSafeArea(edges: .top)
            }
        }
        .background(QuestStyle.navy.ignoresSafeArea())
        .foregroundStyle(.white)
        .tint(QuestStyle.gold)
        .toolbarBackground(QuestStyle.navy, for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
        .toolbarColorScheme(.dark, for: .tabBar)
        .sensoryFeedback(.success, trigger: haptic)
        .task(id: reveal.batchID) {
            guard reveal.isOpen, !reveal.saved else { return }
            do {
                if !reduceMotion { try await Task.sleep(for: .milliseconds(450)) }
                withAnimation(reduceMotion ? nil : .spring(duration: 0.65, bounce: 0.18)) {
                    reveal.itemsVisible = true
                }
                if !reduceMotion { try await Task.sleep(for: .milliseconds(700)) }
                try Task.checkCancellation()
                reveal.saved = model.acknowledgeQueuedSales(ids: Set(reveal.sales.map(\.id)))
                haptic += 1
            } catch { /* Leaving before the reveal completes keeps these sales queued. */ }
        }
        .onChange(of: model.user?.id) { _, _ in reveal.reset() }
    }

    private var header: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
            : AnyLayout(HStackLayout(spacing: 9))
        return layout {
            QuestMainPageTitle(title: "Activity", systemImage: "diamond.fill")
            if !typeSize.isAccessibilitySize { Spacer() }
            if model.isPreviewMode {
                Text("Demo").font(.caption.weight(.semibold))
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(QuestStyle.navy.opacity(0.75), in: Capsule())
            }
        }
        .shadow(color: QuestStyle.navy.opacity(0.7), radius: 8, y: 2)
        .padding(.horizontal, 24).padding(.top, 10).padding(.bottom, 6)
    }

    private func lootSlots(width: CGFloat) -> some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 16) {
                ForEach(Array(reveal.sales.enumerated()), id: \.element.id) { index, sale in
                    Button {
                        reveal.selectedID = sale.id
                    } label: {
                        VStack(spacing: 7) {
                            AppArtwork(url: model.apps.first { $0.id == sale.appId }?.iconUrl, name: sale.appName, bundledIconName: model.apps.first { $0.id == sale.appId }?.bundledIconName)
                                .tint(QuestStyle.gold)
                                .padding(6)
                                .background(QuestStyle.navy, in: SlotShape())
                                .overlay(SlotShape().stroke(reveal.selectedID == sale.id ? QuestStyle.gold : Color.white.opacity(0.45), lineWidth: 2))
                                .shadow(color: reveal.selectedID == sale.id ? QuestStyle.gold.opacity(0.55) : .clear, radius: 8)
                            Text(sale.amountDescription ?? "").font(.caption.weight(.bold)).monospacedDigit()
                                .padding(.horizontal, 6).padding(.vertical, 4)
                                .background(QuestStyle.navy.opacity(0.92), in: RoundedRectangle(cornerRadius: 5))
                            Image(systemName: "diamond.fill").font(.system(size: 7))
                                .opacity(reveal.selectedID == sale.id ? 1 : 0)
                        }
                        .foregroundStyle(.white)
                        .offset(y: reveal.itemsVisible || reduceMotion ? 0 : 150)
                        .scaleEffect(reveal.itemsVisible || reduceMotion ? 1 : 0.88)
                        .opacity(reveal.itemsVisible ? 1 : 0)
                        .animation(reduceMotion ? nil : .spring(duration: 0.5, bounce: 0.16)
                            .delay(min(Double(index) * 0.07, 0.21)), value: reveal.itemsVisible)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(sale.appName), \(sale.kind == "renewal" ? "transaction date, \(Timestamp.display(sale.occurredAt, timeZone: timeZone))" : "purchase"), \(sale.amountDescription ?? "")")
                    .accessibilityAddTraits(reveal.selectedID == sale.id ? [.isSelected] : [])
                    .accessibilityIdentifier("loot-\(sale.id)")
                }
            }
            .padding(.horizontal, 12).padding(.top, 12)
            .frame(minWidth: width)
        }
        .scrollIndicators(.hidden)
        .fixedSize(horizontal: false, vertical: true)
        .safeAreaPadding(.horizontal, 0)
    }

    private func openChest() {
        guard !reveal.isOpen, !model.queuedSales.isEmpty else { return }
        reveal.begin(model.queuedSales)
    }

    private var footer: some View {
        VStack(spacing: 14) {
            Text(reveal.isOpen ? "Your discoveries." : model.queuedSales.isEmpty ? "Ready for what’s next." : "Adventure awaits.")
                .font(.system(.largeTitle, design: .serif, weight: .semibold))
                .tracking(-0.6)
                .accessibilityAddTraits(.isHeader)
            if reveal.isOpen {
                ForEach(TreasureTotal.summarize(reveal.sales)) { total in
                    Text(total.formatted).font(.title2.bold()).monospacedDigit()
                }
                Text("\(reveal.sales.count) \(reveal.sales.count == 1 ? "sale" : "sales") · Purchases and paid renewals")
                    .font(.subheadline).foregroundStyle(QuestStyle.muted)
            } else {
                Text(model.isLoadingQueuedSales && model.queuedSales.isEmpty ? "Checking for new sales…" : model.queuedSales.isEmpty ? "New sales will be waiting here. Explore your activity in the meantime." : "\(model.queuedSales.count) \(model.queuedSales.count == 1 ? "sale is" : "sales are") waiting inside.")
                    .font(.body).foregroundStyle(QuestStyle.muted)
            }
            if let error = model.queuedSalesError {
                Text(error).font(.footnote).foregroundStyle(QuestStyle.muted)
                Button("Try again") {
                    if reveal.isOpen {
                        reveal.saved = model.acknowledgeQueuedSales(ids: Set(reveal.sales.map(\.id)))
                    } else { Task { await model.refreshQueuedSales() } }
                }.frame(minHeight: 44)
            }
            Button {
                if reveal.isOpen || model.queuedSales.isEmpty { model.showActivity() }
                else { openChest() }
            } label: {
                HStack {
                    Text(reveal.isOpen || model.queuedSales.isEmpty ? "View activity" : "Open your chest")
                    Image(systemName: reveal.isOpen || model.queuedSales.isEmpty ? "arrow.right" : "sparkles")
                }
                .font(.headline).foregroundStyle(QuestStyle.navy)
                .frame(maxWidth: .infinity, minHeight: 54)
                .background(LinearGradient(colors: [Color(red: 1, green: 0.85, blue: 0.43), QuestStyle.gold], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 14))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier(reveal.isOpen || model.queuedSales.isEmpty ? "questActivity" : "openTreasure")
            Text(model.isPreviewMode ? "Sample sales · No real money" : "Gross sales before fees and refunds")
                .font(.caption).foregroundStyle(QuestStyle.muted)
            if !reveal.isOpen, !model.queuedSales.isEmpty {
                Button("View activity") { model.showActivity() }
                    .font(.subheadline).foregroundStyle(QuestStyle.muted).frame(minHeight: 44)
                    .accessibilityIdentifier("questActivity")
            } else if reveal.isOpen, reveal.saved, !model.queuedSales.isEmpty {
                Button("\(model.queuedSales.count) more sales waiting") { reveal.reset() }
                    .font(.subheadline).frame(minHeight: 44)
            }
        }
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
    }
}

struct SlotShape: Shape {
    func path(in rect: CGRect) -> Path {
        let cut: CGFloat = 6
        return Path { p in
            p.move(to: CGPoint(x: cut, y: 0)); p.addLine(to: CGPoint(x: rect.maxX-cut, y: 0))
            p.addLine(to: CGPoint(x: rect.maxX, y: cut)); p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY-cut))
            p.addLine(to: CGPoint(x: rect.maxX-cut, y: rect.maxY)); p.addLine(to: CGPoint(x: cut, y: rect.maxY))
            p.addLine(to: CGPoint(x: 0, y: rect.maxY-cut)); p.addLine(to: CGPoint(x: 0, y: cut)); p.closeSubpath()
        }
    }
}

private struct QuestChestFrameKey: PreferenceKey {
    static var defaultValue: CGRect = .zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) { value = nextValue() }
}

struct QuestChest: UIViewRepresentable {
    let isOpen: Bool
    let reduceMotion: Bool
    var hasWaitingSales = false
    var isActive = true

    func makeUIView(context: Context) -> QuestChestSceneView {
        let view = QuestChestSceneView()
        view.backgroundColor = .clear
        view.isOpaque = false
        view.antialiasingMode = .multisampling4X
        view.preferredFramesPerSecond = 30
        let scene = (try? SCNScene(url: Bundle.main.url(forResource: "quest-chest", withExtension: "scn")!)) ?? SCNScene()
        scene.background.contents = UIColor.clear
        let camera = SCNNode()
        camera.camera = SCNCamera()
        camera.camera?.usesOrthographicProjection = true
        camera.camera?.orthographicScale = 1.35
        camera.camera?.wantsHDR = true
        camera.camera?.wantsExposureAdaptation = false
        camera.camera?.exposureOffset = -0.25
        camera.camera?.screenSpaceAmbientOcclusionIntensity = 1.1
        camera.camera?.screenSpaceAmbientOcclusionRadius = 0.18
        camera.camera?.screenSpaceAmbientOcclusionBias = 0.015
        camera.position = SCNVector3(4.2, 3, 7.6)
        camera.look(at: SCNVector3(0, 0.95, 0))
        scene.rootNode.addChildNode(camera)
        let key = SCNNode()
        key.light = SCNLight(); key.light?.type = .directional; key.light?.intensity = 1_300
        key.light?.color = UIColor(red: 1, green: 0.95, blue: 0.85, alpha: 1)
        key.light?.castsShadow = true
        key.light?.shadowMode = .forward
        key.light?.shadowMapSize = CGSize(width: 1_024, height: 1_024)
        key.light?.shadowRadius = 3
        key.light?.shadowColor = UIColor.black.withAlphaComponent(0.45)
        key.position = SCNVector3(-3, 7, 5); key.look(at: SCNVector3Zero)
        scene.rootNode.addChildNode(key)
        let fill = SCNNode()
        fill.light = SCNLight(); fill.light?.type = .ambient; fill.light?.intensity = 130
        scene.rootNode.addChildNode(fill)
        // A standard-range map avoids extended-color conversion in SceneKit.
        // A localized bright sky patch gives the brass a highlight instead of a flat yellow fill.
        let format = UIGraphicsImageRendererFormat()
        format.preferredRange = .standard
        format.scale = 1
        let reflection = UIGraphicsImageRenderer(size: CGSize(width: 1_024, height: 512), format: format).image { context in
            let colors = [UIColor(red: 0.55, green: 0.70, blue: 0.86, alpha: 1).cgColor,
                          UIColor(red: 0.12, green: 0.22, blue: 0.32, alpha: 1).cgColor,
                          UIColor(red: 0.07, green: 0.11, blue: 0.13, alpha: 1).cgColor]
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 0.65, 1])!
            context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: 512), options: [])
            let sunlight = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [
                UIColor(red: 1, green: 0.96, blue: 0.84, alpha: 1).cgColor,
                UIColor(red: 1, green: 0.96, blue: 0.84, alpha: 0).cgColor] as CFArray, locations: [0, 1])!
            context.cgContext.drawRadialGradient(sunlight, startCenter: CGPoint(x: 230, y: 130), startRadius: 30,
                                                endCenter: CGPoint(x: 230, y: 130), endRadius: 240, options: [])
        }
        scene.lightingEnvironment.contents = reflection
        scene.lightingEnvironment.intensity = 0.7

        // Contact shadows live on the model's ground plane, so they follow its camera projection.
        let shadowImage = UIGraphicsImageRenderer(size: CGSize(width: 128, height: 128), format: format).image { context in
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [
                UIColor.black.withAlphaComponent(0.7).cgColor,
                UIColor.black.withAlphaComponent(0.35).cgColor,
                UIColor.clear.cgColor] as CFArray, locations: [0, 0.5, 1])!
            context.cgContext.drawRadialGradient(gradient, startCenter: CGPoint(x: 64, y: 64), startRadius: 0,
                                                endCenter: CGPoint(x: 64, y: 64), endRadius: 64, options: [])
        }
        func contactShadow(width: CGFloat, depth: CGFloat, x: Float, z: Float, opacity: CGFloat) {
            let plane = SCNPlane(width: width, height: depth)
            let material = SCNMaterial()
            material.lightingModel = .constant
            material.diffuse.contents = shadowImage
            material.writesToDepthBuffer = false
            material.isDoubleSided = true
            plane.materials = [material]
            let node = SCNNode(geometry: plane)
            node.name = "Ground contact shadow"
            node.position = SCNVector3(x, 0.005, z)
            node.eulerAngles.x = -.pi/2
            node.opacity = opacity
            node.castsShadow = false
            scene.rootNode.addChildNode(node)
        }
        contactShadow(width: 2.45, depth: 1.6, x: 0.12, z: -0.03, opacity: 0.7)
        for x: Float in [-0.77, 0.77] {
            for z: Float in [-0.43, 0.43] {
                contactShadow(width: 0.44, depth: 0.37, x: x, z: z, opacity: 0.9)
            }
        }
        view.scene = scene
        view.pointOfView = camera
        view.prepareMotion()
        return view
    }

    func updateUIView(_ view: QuestChestSceneView, context: Context) {
        view.updateMotion(isOpen: isOpen, reduceMotion: reduceMotion,
                          hasWaitingSales: hasWaitingSales, isActive: isActive)
    }

    static func dismantleUIView(_ view: QuestChestSceneView, coordinator: ()) {
        view.stopMotion()
    }
}

/// Keeps the animation clock local to the chest. Quiet frames, hidden tabs and
/// Reduce Motion do not leave a continuously rendering SceneKit view running.
final class QuestChestSceneView: SCNView, SCNSceneRendererDelegate {
    private struct MotionState: Equatable {
        let isOpen: Bool
        let reduceMotion: Bool
        let hasWaitingSales: Bool
        let isActive: Bool
    }

    private var motionState: MotionState?
    private var motionTask: Task<Void, Never>?
    private var hasRenderedFirstFrame = false
    private var wantsMotion = false
    private var chest: SCNNode?
    private var hinge: SCNNode?
    private var hasp: SCNNode?
    private let treasureLight = SCNNode()
    private let motes = SCNNode()
    private let lightEffects = SCNNode()
    private let openingFlare = SCNNode()
    private let shockwave = SCNNode()
    private let burstStreaks = SCNNode()
    private let openAngle = -Float.pi * 95 / 180

    func prepareMotion() {
        delegate = self
        chest = scene?.rootNode.childNode(withName: "Quest master chest", recursively: true)
        hinge = chest?.childNode(withName: "Lid hinge", recursively: true)
        hasp = chest?.childNode(withName: "Hasp pivot", recursively: true)
        treasureLight.name = "Treasure light"
        treasureLight.light = SCNLight()
        treasureLight.light?.type = .omni
        treasureLight.light?.color = UIColor(red: 1, green: 0.72, blue: 0.28, alpha: 1)
        treasureLight.light?.intensity = 0
        treasureLight.light?.attenuationStartDistance = 0.1
        treasureLight.light?.attenuationEndDistance = 2.4
        treasureLight.position = SCNVector3(0, 1.12, 0.12)
        chest?.addChildNode(treasureLight)
        motes.name = "Reveal gold motes"
        chest?.addChildNode(motes)
        prepareLightEffects()

        motes.position = SCNVector3(0, 1.03, 0.35)
        motes.constraints = [SCNBillboardConstraint()]
        let gold = SCNMaterial()
        gold.lightingModel = .physicallyBased
        gold.diffuse.contents = UIColor(red: 1, green: 0.68, blue: 0.12, alpha: 1)
        gold.metalness.contents = 0.55
        gold.roughness.contents = 0.38
        gold.emission.contents = UIColor(red: 0.28, green: 0.12, blue: 0.01, alpha: 1)
        for index in 0..<28 {
            let isCoin = index.isMultiple(of: 4)
            let geometry: SCNGeometry
            if isCoin {
                let coin = SCNCylinder(radius: 0.065, height: 0.018)
                coin.radialSegmentCount = 12
                geometry = coin
            } else {
                geometry = SCNBox(width: 0.035, height: 0.075, length: 0.015, chamferRadius: 0.003)
            }
            geometry.materials = [gold]
            let mote = SCNNode(geometry: geometry)
            mote.name = isCoin ? "Reward coin" : "Gold spark"
            mote.opacity = 0
            mote.castsShadow = false
            motes.addChildNode(mote)
        }
    }

    private enum EffectTexture { case flash, ring, streak }

    private func effectMaterial(texture: UIImage) -> SCNMaterial {
        let material = SCNMaterial()
        material.lightingModel = .constant
        material.diffuse.contents = texture
        material.blendMode = .add
        material.isDoubleSided = true
        material.writesToDepthBuffer = false
        return material
    }

    /// The burst uses a broad flash, a ring and short radial streaks. Each light
    /// sprite is generated once; the effect never needs camera-wide bloom.
    private func effectTexture(kind: EffectTexture) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.preferredRange = .standard
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: 128, height: 128), format: format).image { renderer in
            let context = renderer.cgContext
            let gold = UIColor(red: 1, green: 0.65, blue: 0.08, alpha: 1)
            if kind == .streak {
                context.move(to: CGPoint(x: 0, y: 64))
                context.addLine(to: CGPoint(x: 25, y: 42))
                context.addLine(to: CGPoint(x: 128, y: 64))
                context.addLine(to: CGPoint(x: 25, y: 86))
                context.closePath()
                context.clip()
                let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [
                    gold.withAlphaComponent(0.85).cgColor, gold.withAlphaComponent(0.4).cgColor,
                    UIColor.clear.cgColor
                ] as CFArray, locations: [0, 0.45, 1])!
                context.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 128, y: 0), options: [])
            } else {
                let colors: [CGColor]
                let locations: [CGFloat]
                if kind == .ring {
                    colors = [UIColor.clear.cgColor, UIColor.clear.cgColor,
                              gold.withAlphaComponent(0.3).cgColor, gold.cgColor,
                              gold.withAlphaComponent(0.3).cgColor, UIColor.clear.cgColor]
                    locations = [0, 0.68, 0.75, 0.8, 0.84, 0.92]
                } else {
                    colors = [UIColor(red: 1, green: 0.88, blue: 0.35, alpha: 0.9).cgColor,
                              gold.withAlphaComponent(0.55).cgColor, UIColor.clear.cgColor]
                    locations = [0, 0.35, 1]
                }
                let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                                          colors: colors as CFArray, locations: locations)!
                context.drawRadialGradient(gradient, startCenter: CGPoint(x: 64, y: 64), startRadius: 0,
                                           endCenter: CGPoint(x: 64, y: 64), endRadius: 64, options: [])
            }
        }
    }

    private func prepareLightEffects() {
        lightEffects.name = "Reveal light effects"
        chest?.addChildNode(lightEffects)

        let flash = SCNPlane(width: 2.35, height: 1.35)
        flash.materials = [effectMaterial(texture: effectTexture(kind: .flash))]
        openingFlare.geometry = flash
        openingFlare.name = "Opening gold flash"
        openingFlare.position = SCNVector3(0, 1.04, 0.35)
        openingFlare.constraints = [SCNBillboardConstraint()]
        openingFlare.opacity = 0
        openingFlare.castsShadow = false
        lightEffects.addChildNode(openingFlare)

        let ring = SCNPlane(width: 2, height: 2)
        ring.materials = [effectMaterial(texture: effectTexture(kind: .ring))]
        shockwave.geometry = ring
        shockwave.name = "Reward shockwave"
        shockwave.position = SCNVector3(0, 1.04, 0.36)
        shockwave.constraints = [SCNBillboardConstraint()]
        shockwave.opacity = 0
        shockwave.castsShadow = false
        lightEffects.addChildNode(shockwave)

        burstStreaks.name = "Radial reward streaks"
        burstStreaks.position = SCNVector3(0, 1.04, 0.34)
        burstStreaks.constraints = [SCNBillboardConstraint()]
        lightEffects.addChildNode(burstStreaks)
        let streakMaterial = effectMaterial(texture: effectTexture(kind: .streak))
        for index in 0..<16 {
            let plane = SCNPlane(width: index.isMultiple(of: 2) ? 0.38 : 0.25, height: 0.085)
            plane.materials = [streakMaterial]
            let streak = SCNNode(geometry: plane)
            streak.name = "Outward gold streak"
            streak.opacity = 0
            streak.castsShadow = false
            burstStreaks.addChildNode(streak)
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil else {
            stopMotion()
            return
        }
        if let state = motionState {
            motionState = nil
            updateMotion(isOpen: state.isOpen, reduceMotion: state.reduceMotion,
                         hasWaitingSales: state.hasWaitingSales, isActive: state.isActive)
        }
    }

    nonisolated func renderer(_ renderer: SCNSceneRenderer, didRenderScene scene: SCNScene, atTime time: TimeInterval) {
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.hasRenderedFirstFrame else { return }
            self.hasRenderedFirstFrame = true
            self.setPlayback(self.wantsMotion)
        }
    }

    private func setPlayback(_ playing: Bool) {
        wantsMotion = playing
        // Even a static/reduced-motion chest needs one completed Metal frame.
        isPlaying = window != nil && (playing || !hasRenderedFirstFrame)
    }

    func updateMotion(isOpen: Bool, reduceMotion: Bool, hasWaitingSales: Bool, isActive: Bool) {
        let next = MotionState(isOpen: isOpen, reduceMotion: reduceMotion,
                               hasWaitingSales: !isOpen && hasWaitingSales, isActive: isActive)
        guard next != motionState else { return }
        let shouldReveal = motionState?.isOpen == false && isOpen
        motionState = next
        stopMotion()
        settle(isOpen: isOpen)
        guard isActive, !reduceMotion else { return }

        if shouldReveal {
            hinge?.eulerAngles.x = 0
            hasp?.eulerAngles.x = 0
            treasureLight.light?.intensity = 0
            playReveal()
            motionTask = Task { @MainActor [weak self] in
                do { try await Task.sleep(for: .milliseconds(2_050)) }
                catch { return }
                self?.stopMotion()
                self?.settle(isOpen: true)
            }
        } else if !isOpen, hasWaitingSales {
            motionTask = Task { @MainActor [weak self] in
                do {
                    try await Task.sleep(for: .milliseconds(800))
                    while !Task.isCancelled {
                        self?.playWaitingNudge()
                        try await Task.sleep(for: .milliseconds(850))
                        self?.setPlayback(false)
                        try await Task.sleep(for: .seconds(5))
                    }
                } catch { /* Visibility and preference changes cancel the idle nudge. */ }
            }
        }
    }

    func stopMotion() {
        motionTask?.cancel()
        motionTask = nil
        chest?.enumerateHierarchy { node, _ in node.removeAllActions() }
        setPlayback(false)
    }

    private func settle(isOpen: Bool) {
        SCNTransaction.begin()
        SCNTransaction.disableActions = true
        chest?.position = SCNVector3Zero
        chest?.eulerAngles = SCNVector3Zero
        hinge?.eulerAngles.x = isOpen ? openAngle : 0
        hasp?.eulerAngles.x = isOpen ? -.pi / 5 : 0
        treasureLight.light?.intensity = isOpen ? 18 : 0
        motes.childNodes.forEach { $0.opacity = 0 }
        openingFlare.opacity = 0
        shockwave.opacity = 0
        burstStreaks.childNodes.forEach { $0.opacity = 0 }
        SCNTransaction.commit()
        setNeedsDisplay()
    }

    private func rotate(_ angle: CGFloat, duration: TimeInterval) -> SCNAction {
        let action = SCNAction.rotateTo(x: angle, y: 0, z: 0, duration: duration)
        action.timingMode = .easeInEaseOut
        return action
    }

    private func rock(duration: TimeInterval, strength: Float) -> SCNAction {
        .customAction(duration: duration) { node, elapsed in
            let progress = min(Float(elapsed) / Float(duration), 1)
            let envelope = sin(progress * .pi)
            let angle = sin(progress * .pi * 6) * envelope * strength
            node.eulerAngles.z = angle
            // Lift the low corner just enough to keep the feet above the ground.
            node.position.y = abs(sin(angle)) * 0.98
            if progress >= 1 {
                node.eulerAngles = SCNVector3Zero
                node.position = SCNVector3Zero
            }
        }
    }

    private func playWaitingNudge() {
        setPlayback(true)
        chest?.runAction(rock(duration: 0.65, strength: 0.023), forKey: "waiting")
        hasp?.runAction(.sequence([
            rotate(-0.09, duration: 0.12), rotate(0, duration: 0.12),
            rotate(-0.045, duration: 0.1), rotate(0, duration: 0.16)
        ]), forKey: "waiting")
    }

    private func playReveal() {
        setPlayback(true)
        chest?.runAction(rock(duration: 0.28, strength: 0.04), forKey: "reveal")
        hasp?.runAction(.sequence([
            rotate(-.pi * 0.42, duration: 0.18),
            rotate(-.pi * 0.16, duration: 0.22),
            rotate(-.pi / 5, duration: 0.18)
        ]), forKey: "reveal")
        let swing = rotate(-.pi * 101 / 180, duration: 0.48)
        swing.timingMode = .easeOut
        hinge?.runAction(.sequence([
            .wait(duration: 0.16), swing,
            rotate(-.pi * 92 / 180, duration: 0.16),
            rotate(CGFloat(openAngle), duration: 0.14)
        ]), forKey: "reveal")
        treasureLight.runAction(.sequence([
            .wait(duration: 0.26),
            .customAction(duration: 0.8) { node, elapsed in
                let progress = min(elapsed / 0.8, 1)
                node.light?.intensity = 18 + 145 * pow(1 - progress, 3)
            }
        ]), forKey: "reveal")
        openingFlare.runAction(.sequence([
            .wait(duration: 0.26),
            .customAction(duration: 0.34) { node, elapsed in
                let progress = min(Float(elapsed) / 0.34, 1)
                let scale = 0.8 + 0.55 * progress
                node.scale = SCNVector3(scale, scale, scale)
                node.opacity = CGFloat(pow(1 - progress, 1.8)) * 0.9
                if progress >= 1 { node.opacity = 0 }
            }
        ]), forKey: "reveal")
        shockwave.runAction(.sequence([
            .wait(duration: 0.28),
            .customAction(duration: 0.7) { node, elapsed in
                let progress = min(Float(elapsed) / 0.7, 1)
                let outward = 1 - pow(1 - progress, 3)
                let scale = 0.4 + 1.4 * outward
                node.scale = SCNVector3(scale, scale * 0.58, 1)
                node.opacity = CGFloat(pow(1 - progress, 1.2)) * 0.8
                if progress >= 1 { node.opacity = 0 }
            }
        ]), forKey: "reveal")
        for (index, streak) in burstStreaks.childNodes.enumerated() {
            let angle = Float(index) * .pi * 2 / 16 + 0.12
            streak.runAction(.sequence([
                .wait(duration: 0.28 + Double(index % 3) * 0.015),
                .customAction(duration: 0.62) { node, elapsed in
                    let progress = min(Float(elapsed) / 0.62, 1)
                    let outward = 1 - pow(1 - progress, 3)
                    let radius = 0.35 + 1.25 * outward
                    node.position = SCNVector3(cos(angle) * radius, sin(angle) * radius * 0.65, 0)
                    node.eulerAngles.z = atan2(sin(angle) * 0.65, cos(angle))
                    node.scale = SCNVector3(1 - progress * 0.65, 1 - progress * 0.65, 1)
                    node.opacity = CGFloat(pow(1 - progress, 1.2)) * 0.9
                    if progress >= 1 { node.opacity = 0 }
                }
            ]), forKey: "reveal")
        }
        // All pieces leave in one short impact, then tumble and fall. Their
        // spread is radial in the camera plane, rather than a vertical emitter.
        for (index, mote) in motes.childNodes.enumerated() {
            let angle = Float(index) * 2.39996
            let spread = Float(0.85 + Double(index % 5) * 0.15)
            let isCoin = index.isMultiple(of: 4)
            mote.runAction(.sequence([
                .wait(duration: 0.28 + Double(index % 3) * 0.018),
                .customAction(duration: 1.15) { node, elapsed in
                    let progress = min(Float(elapsed) / 1.15, 1)
                    let outward = 1 - pow(1 - progress, 3)
                    let radius = 0.2 + spread * outward
                    node.position = SCNVector3(cos(angle) * radius,
                        sin(angle) * radius * 0.62 - 0.3 * progress * progress,
                        0.06 + Float(index % 3) * 0.04)
                    node.eulerAngles = SCNVector3(isCoin ? .pi / 2 + progress * 7 : progress * 4,
                                                 angle + progress * 5, angle + progress * 3)
                    node.opacity = CGFloat(min(progress / 0.045, 1) * pow(1 - progress, 0.7))
                    let scale: Float = isCoin ? 1 : 0.9 + 0.25 * sin(angle)
                    node.scale = SCNVector3(scale, scale, scale)
                    if progress >= 1 { node.opacity = 0 }
                }
            ]), forKey: "reveal")
        }
    }
}
