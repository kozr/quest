import AVFoundation
import SwiftUI
import VisionKit

struct PairingView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var cameraActive = false
    @State private var cameraMessage: String?
    @State private var cameraDenied = false
    @State private var requestingCamera = false
    @State private var pastedLink = ""
    @State private var codeMatches = false

    var body: some View {
        NavigationStack {
            Form {
                if let message = model.pairingNotice {
                    Section {
                        Label(message, systemImage: "checkmark.circle")
                        Button("Done") { model.closePairing() }
                    }
                } else if let review = model.pairingReview {
                    approvalSections(review)
                } else {
                    scanSections
                }
                if let error = model.pairingError {
                    Section {
                        Label(error, systemImage: "exclamationmark.circle")
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .navigationTitle("Sign in on computer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { model.closePairing() }
                        .disabled(model.pairingIsBusy)
                }
            }
            .interactiveDismissDisabled(model.pairingIsBusy)
            .onChange(of: model.pairingReview?.id) { _, _ in
                cameraActive = false
                codeMatches = false
                pastedLink = ""
            }
            .onDisappear { cameraActive = false; pastedLink = "" }
        }
    }

    @ViewBuilder
    private var scanSections: some View {
        Section {
            Text("Open the web app on your computer and choose to sign in with your phone. Scan the QR code displayed there.")
            LabeledContent("Your server", value: model.serverSettings.url)
            Text("You will review the account and matching code before this phone approves the browser. Never scan a login code sent by someone else.")
                .font(.caption).foregroundStyle(.secondary)
        }
        if model.pairingIsBusy {
            Section { ProgressView("Checking sign-in request…") }
        } else {
            Section("Camera") {
                if cameraActive {
                    DesktopQRScanner(isActive: scenePhase == .active, onScan: inspect, onFailure: { message in
                        cameraActive = false
                        cameraMessage = message
                    })
                    .frame(height: 280)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .accessibilityLabel("Camera viewfinder. Point at your computer's sign-in QR code.")
                    Button("Stop camera") { cameraActive = false }
                } else {
                    Button {
                        Task { await startCamera() }
                    } label: {
                        HStack {
                            Label("Scan desktop QR code", systemImage: "qrcode.viewfinder")
                            Spacer()
                            if requestingCamera { ProgressView() }
                        }
                    }
                    .disabled(requestingCamera)
                }
                if let cameraMessage { Text(cameraMessage).font(.caption).foregroundStyle(.secondary) }
                if cameraDenied {
                    Button("Open camera permission settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    }
                }
            }
            Section {
                TextField("iapnotifications://pair?…", text: $pastedLink, axis: .vertical)
                    .lineLimit(2...4)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .privacySensitive()
                    .accessibilityIdentifier("pairingLink")
                PasteButton(payloadType: String.self) { strings in
                    if let value = strings.first { pastedLink = String(value.prefix(2_049)) }
                }
                Button("Review sign-in request") { inspect(pastedLink) }
                    .disabled(pastedLink.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("inspectPairing")
            } header: {
                Text("Or paste the QR link")
            } footer: {
                Text("Use the full QR link copied from the computer. The six-digit code is only for comparison and cannot sign in by itself.")
            }
        }
    }

    @ViewBuilder
    private func approvalSections(_ review: PairingReview) -> some View {
        Section("Review browser sign-in") {
            LabeledContent("Sign in as", value: model.user?.email ?? "")
            LabeledContent("Server", value: model.serverSettings.url)
            LabeledContent("Browser hint", value: review.browserName)
            Text("The browser label is a hint, not proof of its identity.")
                .font(.caption).foregroundStyle(.secondary)
        }
        Section {
            Text(review.code)
                .font(.system(.largeTitle, design: .monospaced))
                .tracking(5)
                .frame(maxWidth: .infinity)
                .accessibilityLabel("Matching code: \(review.code.map(String.init).joined(separator: " "))")
            Text("Only approve a browser you opened yourself. Compare this code with the six-digit code on that computer.")
            Toggle("The code matches my computer", isOn: $codeMatches)
                .disabled(model.pairingIsBusy)
                .accessibilityIdentifier("pairingCodeMatches")
        } header: {
            Text("Compare the matching code")
        }
        Section {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let expired = review.expiration.map { $0 <= context.date } ?? true
                if expired {
                    Label("This request expired. Get a new QR code on your computer.", systemImage: "clock.badge.exclamationmark")
                } else if let expiration = review.expiration {
                    HStack { Text("Expires in"); Spacer(); Text(expiration, style: .timer).monospacedDigit() }
                }
            }
        }
        // A TimelineView is one Form row. Never put opposing actions inside it:
        // automatic Form button styling can turn that row into a shared target.
        Section {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let expired = review.expiration.map { $0 <= context.date } ?? true
                Button {
                    Task { await model.approvePairing() }
                } label: {
                    HStack {
                        Text("Approve browser sign-in")
                        Spacer()
                        if model.pairingIsBusy { ProgressView() }
                    }
                    .frame(minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!codeMatches || expired || model.pairingIsBusy)
                .accessibilityIdentifier("approvePairing")
            }
        }
        Section {
            Button(role: .destructive) {
                Task { await model.denyPairing() }
            } label: {
                Text("Deny request").frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            }
            .buttonStyle(.borderless)
            .disabled(model.pairingIsBusy)
            .accessibilityIdentifier("denyPairing")
        }
        Section {
            Button { model.resetPairing() } label: {
                Text("Scan another QR code").frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            }
            .buttonStyle(.borderless)
            .disabled(model.pairingIsBusy)
            .accessibilityIdentifier("resetPairing")
        }
    }

    private func inspect(_ value: String) {
        cameraActive = false
        pastedLink = ""
        Task { await model.inspectPairingLink(value) }
    }

    @MainActor
    private func startCamera() async {
        requestingCamera = true
        cameraMessage = nil
        cameraDenied = false
        defer { requestingCamera = false }
        guard DataScannerViewController.isSupported else {
            cameraMessage = "Camera QR scanning is unavailable on this device or simulator. Paste the full QR link below."
            return
        }
        var authorized = AVCaptureDevice.authorizationStatus(for: .video) == .authorized
        if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
            authorized = await AVCaptureDevice.requestAccess(for: .video)
        }
        guard authorized else {
            cameraDenied = AVCaptureDevice.authorizationStatus(for: .video) == .denied
            cameraMessage = "Camera access is disabled or restricted. You can paste the full QR link below instead."
            return
        }
        guard DataScannerViewController.isAvailable else {
            cameraMessage = "The camera is unavailable right now. Try again, or paste the QR link below."
            return
        }
        guard model.isPairingPresented, model.pairingReview == nil, !model.pairingIsBusy else { return }
        cameraActive = true
    }
}

private struct DesktopQRScanner: UIViewControllerRepresentable {
    let isActive: Bool
    let onScan: (String) -> Void
    let onFailure: (String) -> Void

    func makeUIViewController(context: Context) -> DesktopQRScannerController {
        DesktopQRScannerController(onScan: onScan, onFailure: onFailure)
    }

    func updateUIViewController(_ controller: DesktopQRScannerController, context: Context) {
        controller.setActive(isActive)
    }

    static func dismantleUIViewController(_ controller: DesktopQRScannerController, coordinator: ()) {
        controller.stop()
    }
}

@MainActor
private final class DesktopQRScannerController: UIViewController, DataScannerViewControllerDelegate {
    private let scanner = DataScannerViewController(
        recognizedDataTypes: [.barcode(symbologies: [.qr])],
        qualityLevel: .balanced,
        recognizesMultipleItems: false,
        isHighFrameRateTrackingEnabled: false,
        isPinchToZoomEnabled: true,
        isGuidanceEnabled: true,
        isHighlightingEnabled: true)
    private let onScan: (String) -> Void
    private let onFailure: (String) -> Void
    private var shouldScan = true
    private var captured = false

    init(onScan: @escaping (String) -> Void, onFailure: @escaping (String) -> Void) {
        self.onScan = onScan
        self.onFailure = onFailure
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("Storyboard initialization is not supported") }

    override func viewDidLoad() {
        super.viewDidLoad()
        scanner.delegate = self
        addChild(scanner)
        view.addSubview(scanner.view)
        scanner.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            scanner.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scanner.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scanner.view.topAnchor.constraint(equalTo: view.topAnchor),
            scanner.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        scanner.didMove(toParent: self)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        startIfNeeded()
    }

    override func viewWillDisappear(_ animated: Bool) {
        scanner.stopScanning()
        super.viewWillDisappear(animated)
    }

    func setActive(_ active: Bool) {
        shouldScan = active
        if active { startIfNeeded() }
        else { scanner.stopScanning() }
    }

    func stop() {
        shouldScan = false
        scanner.stopScanning()
        scanner.delegate = nil
    }

    private func startIfNeeded() {
        guard shouldScan, !captured, isViewLoaded, view.window != nil, !scanner.isScanning else { return }
        do { try scanner.startScanning() }
        catch {
            captured = true
            onFailure("The camera could not start scanning. Paste the full QR link instead.")
        }
    }

    func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
        for item in addedItems {
            if case .barcode(let barcode) = item, let value = barcode.payloadStringValue {
                capture(value)
                return
            }
        }
    }

    func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
        if case .barcode(let barcode) = item, let value = barcode.payloadStringValue { capture(value) }
    }

    func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
        guard !captured else { return }
        captured = true
        scanner.stopScanning()
        onFailure("Camera scanning became unavailable. Paste the full QR link instead.")
    }

    private func capture(_ value: String) {
        guard !captured, shouldScan else { return }
        captured = true
        scanner.stopScanning()
        onScan(value)
    }
}
