# iPhone companion — core MVP

A dependency-free SwiftUI app for iOS 17 or later. Open `IAPNotifications.xcodeproj` and choose the shared **IAPNotifications** scheme. No XcodeGen, CocoaPods, or Swift packages are required. The initial interface uses native forms, lists, and tabs; design direction is intentionally deferred.

## Run locally

1. Start the backend from the repository root (see the root README).
2. In Xcode select an installed iPhone simulator and Run. Debug defaults to `http://localhost:4317`. You can edit this address before signing in.
3. Create an account or sign in on the phone.
4. Open the web app on your computer and display its phone sign-in QR code. In the companion use **Settings → Sign in on computer**, scan that QR, compare the six-digit matching code, and explicitly approve. No desktop password is needed.
5. Add an app in the signed-in browser, return to the companion, and pull to refresh.

Unsigned simulator build:

```sh
xcodebuild -project ios/IAPNotifications.xcodeproj -scheme IAPNotifications \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ios/build CODE_SIGNING_ALLOWED=NO build
```

Unit tests are in the shared scheme. Choose an installed simulator in Xcode and use **Product → Test**, or provide its exact ID to `xcodebuild test`. Tests cover origin validation, insecure-address rejection, timestamps, forwarding metadata, future event kinds, notification routing, and strict pairing-link/challenge parsing. `build-for-testing` can compile them without launching a simulator.

## Mobile-approved desktop sign-in

- Sign in on the phone before scanning. The phone never auto-approves a browser.
- Review the signed-in email, server, browser hint, matching six-digit code, and expiration; confirm the code matches a browser you opened yourself, then tap **Approve browser sign-in**. Browser hints are not verified identity.
- **Deny request** rejects the challenge. Simply closing the sheet abandons it locally; it expires on the server.
- Camera access is requested only after **Scan desktop QR code**. Scanning uses VisionKit on supported iPhones, stops when backgrounded/dismissed or a QR is read, and never uploads camera frames. Camera-denied, restricted, or unsupported devices (including simulators) can paste the **full QR link** instead. The six-digit matching code is not a credential.
- The registered `iapnotifications://pair` scheme also opens the review flow, but still requires sign-in and explicit approval. Links opened while signed out are discarded with an instruction to sign in and scan again.
- The QR origin must match the phone's signed-in API origin (default ports normalize). Inspection, approval, and denial always use the existing Keychain-bound API client, never a scanned URL. For local development, configure the browser and phone to use the same reachable origin; `localhost`, `127.0.0.1`, and a LAN address are different origins.
- Pairing challenge credentials exist only in memory during review. They are not account bearer tokens and are cleared on completion, dismissal, or logout. Approval means the server accepted authorization; the desktop still completes its one-time session exchange.

## Physical phone and push delivery

The project intentionally contains no development team, signing credentials, or real bundle identifier.

1. Replace `com.example.IAPNotifications` with your unique bundle identifier and select your Apple Developer team under **Signing & Capabilities**. Keep **Push Notifications** enabled.
2. Configure the backend APNs credentials and topic to match that bundle identifier. Debug builds register against sandbox APNs; Release builds register against production APNs. These APNs environments describe the companion build, independently of an event's Apple Production/Sandbox environment.
3. Use an HTTPS backend reachable by the phone. `localhost` on a physical phone means the phone, not your Mac. For trusted local development only, Debug permits a private IPv4 or `.local` address when **Allow local development HTTP** is enabled. The backend must listen on a reachable interface and the phone must permit Local Network access. Release has no HTTP exceptions and requires HTTPS.
4. In **Settings**, tap **Enable notifications**. This is the only action that prompts for notification permission. Previously registered phones refresh APNs registration automatically; a phone disconnected in the web app must be explicitly re-enabled.
5. Tap **Send test push**. “Queued” only confirms that the server accepted the job. It is not proof of APNs acceptance or device display. Verify the actual notification and inspect the web delivery log if needed. If APNs is not configured, the companion explicitly explains why this button is unavailable.

Simulator compilation is not a real-device push test. Real APNs requires a correctly signed/provisioned build and server credentials. The app does not claim Apple is connected until a signed event arrives; Demo never changes connection state.

## Implemented

- Email/password register and login; bearer session and selected origin stored in device-only Keychain.
- Activity feed with refresh, cursor pagination, Production/Sandbox/Demo filters, and event detail.
- Read-only connected app status and browser setup handoff.
- Camera/paste QR scanning and explicit mobile approval for passwordless desktop sign-in.
- Account-wide alert preferences, APNs registration, explicit permission prompt, test push.
- Logout unregisters this backend device, revokes the bearer session, and clears local notification/session state. A network failure keeps the account open so revocation can be retried safely.
- No shared browser cookies, no account bearer token in a URL, no cross-origin redirects, no arbitrary HTTP exception, and no TLS trust bypass.

## Intentionally deferred

Sign in with Apple, native app setup forms, password recovery, app icon/brand design, quiet hours, widgets, billing, and App Store distribution assets. This is a local/beta foundation, not an App Store release package.

Apple references used for networking and notification setup: [local-network ATS](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking), [local network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy), and [APNs registration](https://developer.apple.com/documentation/uikit/uiapplication/registerforremotenotifications()).

Camera integration follows Apple's [VisionKit scanning lifecycle](https://developer.apple.com/documentation/visionkit/scanning-data-with-the-camera).
