# Questline iPhone companion

A dependency-free SwiftUI app for iPhone on iOS 17 or later. Open `IAPNotifications.xcodeproj` and use the shared **IAPNotifications** scheme. No CocoaPods, Swift packages, Firebase client SDK, or generated project is required.

The latest uploaded candidate is **1.0 (8)**, display name **Questline**, bundle ID `com.kozr.quest`, with a matching notification-extension version. It includes the simplified Add App device chooser and single-sheet mobile handoff. Xcode Organizer confirmed **Uploaded to Apple** on September 13 at **2:04 AM Pacific**. App Store processing is complete; build 8 is assigned to the internal devs group and was submitted for App Review on September 13. The version is **Waiting for Review**. The matching Find → Confirm → Connect web flow is deployed to production. See [App Store readiness](../docs/APP_STORE.md).

The updated hosted dashboard and API, including automatic lookup and US App Store title search, were deployed on September 12. Build 7 uses the live hosted form; no additional iOS upload is needed for these web changes.

## Welcome and reviewer demo

The welcome screen offers native **Sign in with Apple** and **Explore demo**, plus privacy and support links. It does not check the service at signed-out launch or show server settings, beta messages, or connection diagnostics. Both Debug and Release use the configured production service by default.

**Explore demo** is available to everyone without an account or network connection. It contains sample purchases, renewals, refunds, trials, and auto-renew changes. Activity and app details identify sample data explicitly. The demo does not show live environment filters, fake Apple connection states, placeholder Apple IDs, account controls, or disabled browser-management actions.

Settings includes temporary alert preferences and an on-screen sample notification. **Hide amounts in notifications** updates that preview. **Exit demo** returns to the welcome screen and resets sample preferences. Refresh keeps sample timestamps stable during the visit. Demo mode does not register a device, request push permission, approve QR links, create an account, or call the account API. Incoming live notification taps do not change its environment.

The demo is independent of the backend's development-only `ENABLE_DEMO` setting. It is documented in [App Review notes](AppStoreMetadata/review-notes.txt), with no hidden reviewer login or authentication bypass.

## Build and test

```sh
xcodebuild -project ios/IAPNotifications.xcodeproj -scheme IAPNotifications \
  -configuration Release -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ios/build/simulator CODE_SIGN_IDENTITY=- build
```

Use normal simulator signing for Keychain access. An unsigned build may compile but return secure-storage error `-34018` at runtime.

Select an installed simulator in Xcode and use **Product → Test**, or supply its ID to `xcodebuild test`. The suite covers offline welcome/demo behavior, preference reset, push/QR isolation, origin validation, Apple nonce generation, event decoding, timestamps, pairing challenge validation, and notification artwork.

For local API development only, set `QUESTLINE_API_URL` in the Debug scheme's environment (for example `http://localhost:4317`). HTTP is allowed only for validated local addresses. Release ignores this override and requires HTTPS. There is no server editor in the app. Sessions from a different configured origin are discarded rather than reused.

## Live account flow

- Native Apple sign-in uses a random nonce, SHA-256 binding, callback state validation, and a Firebase-backed service-session exchange. Hide My Email is supported; full names are not collected. Raw Apple/Firebase credentials are not retained.
- Activity supports refresh, cursor pagination, and Production/Sandbox/Demo feeds. Connected apps show their actual Apple-event status.
- **Apps → Add app** offers **On a computer — Recommended** or **On this iPhone**. Computer setup explains two ordered steps: share/open the dashboard, then scan its sign-in QR after closing the chooser. iPhone setup stays signed in and replaces the chooser within the same sheet. The web flow separates finding an app, confirming its identity, and choosing the connection provider. Optional App Store shortcuts, clipboard paste, and manual entry are under **Can’t find your app?**. **Manage connection** and **Open dashboard** remain direct signed-in quick links. Closing the sheet refreshes apps, activity, and preferences. The September 13 native refinements are included in uploaded build 8; the matching web flow is deployed to production.
- Desktop access remains optional. **Settings → Sign in on computer** scans or accepts a pasted QR link and requires explicit confirmation of the matching six-digit code. Camera access is optional and requested only when scanning. QR origins must match the configured service; requests use the existing Keychain-bound client. Links never auto-approve a browser.
- Notification permission is requested automatically after sign-in or when an existing signed-in session launches. Granted permission triggers automatic device registration, including when returning from iPhone Settings. If permission was denied, use **Open notification settings**; if the phone was disconnected in the browser, use **Enable notifications** to reconnect. **Send test push** confirms queue acceptance, not device delivery. Debug uses sandbox APNs; Release uses production APNs, independently of the event's environment.
- Sign-out unregisters this device and revokes its session before clearing local state. A network failure preserves the session so the user can retry.
- **Delete account** explains consequences and requires fresh confirmation with the same Apple Account. The backend revokes Apple authorization before accepting durable cleanup. A minimal Keychain receipt lets the app check deletion progress when reopened. Forwarding users are told to restore their notification endpoints before deleting.
- Account tokens are stored in device-only Keychain. Each dashboard sheet receives a one-hour, origin-bound HttpOnly/SameSite=Strict cookie in a fresh, nonpersistent WebKit store (Secure over HTTPS). The store is cleared on dismissal and is not shared with Safari. Tokens never appear in URLs or page scripts. Navigation is restricted to the configured origin; explicit provider/help links open externally. An expired web session returns to native sign-in.

## Signing and notification artwork

The project uses developer team `ZMNPR5G4ZL` with Push Notifications and Sign in with Apple for `com.kozr.quest`. The service is `https://quest-liart-iota.vercel.app`; Firebase project `the-app-quest` performs native Apple identity exchange and revocation. Private signing keys are not stored in the repository.

The embedded `NotificationService` extension uses bundle ID `com.kozr.quest.NotificationService`. For eligible event pushes, it downloads Apple-hosted HTTPS artwork and attaches a 256-pixel PNG thumbnail. The system notification icon remains Questline's icon. Missing artwork, redirects, invalid images, oversized downloads, and timeouts fall back to the text alert. Demo/Sandbox labels and the hide-amounts preference remain in effect.

Compilation and simulator checks do not establish physical Apple sign-in, APNs display/tap, rich-notification delivery, or real Apple authorization revocation. Complete the device acceptance checklist in the release document before submission.

## TestFlight paywall testing

Open **Settings → TestFlight → Simulate no Marketing purchase** to force the unpaid Marketing gate, and use **Open Marketing paywall** to inspect the offer. Switch simulation off to restore actual Sandbox purchase status; this never fabricates a subscription or grants server access. The override is session-only and unavailable in App Store installations. Activity and sales tracking stay free. Real TestFlight checkout requires coordinated server Sandbox billing configuration; see `docs/MARKETING_BILLING.md`.
