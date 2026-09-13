## Questline 1.0 release preparation — September 10, 2026

## Add app search deployment — September 12, 2026

Published automatic URL/Apple ID lookup, US App Store title search, and the signed-in Add app form to `https://quest-liart-iota.vercel.app`. Firebase API revision `api-00007-pak` is **ACTIVE**. Vercel deployment `quest-i9r8gekkz-kozrs-projects.vercel.app` is aliased to production. Only `dist/app.js`, `dist/metadata.js`, and their source maps differed from the prior production backend.

Live HTML, JavaScript, and CSS match the tested workspace files byte-for-byte. `/healthz` and `/api/config` return 200; unauthenticated `/api/apps/search` returns 401. The search helper successfully queried Apple's public API for Numbers and returned valid app/developer/Bundle ID results. The authenticated flow was previously covered by local API and desktop/mobile tests; no production user session or customer data was used for deployment testing. Build 7 opens this hosted form without another iOS upload.

Release evidence: `test-results/search-deploy/`. Previous API revision: `api-00006-tel`; previous Vercel deployment: `dpl_J9kmEXKtwD45WZ5DcV7kwN6j7S32` (`quest-24u2pr3q1-kozrs-projects.vercel.app`).

## Build 7 archive and upload — September 11, 2026

App and notification-extension versions are **1.0 (7)**. Signed Release archive `ios/build/Quest-1.0-build7.xcarchive` succeeded; both bundle versions and deep/strict signatures passed verification. Xcode Organizer confirmed **App upload complete** and **Uploaded to Apple**, build **7**, at **10:07 PM Pacific**. Archive log: `test-results/build7-upload/archive.log`. The immediate App Store Connect API check had not listed build 7 yet; processing/TestFlight availability remains unverified.

This upload includes the Browser/Mobile chooser and signed-in web quick links, superseding the older native-upload-pending notes below. Hosted web/API deployment completed on September 12, including automatic lookup and app-title search. Title-search validation passed 6 metadata tests, 1 authenticated API test, 16 desktop/mobile browser tests, TypeScript checking, and JavaScript syntax checking. No App Review submission was made.

## Browser or Mobile setup — September 11, 2026

- **Apps → Add app** starts with **Browser — Highly recommended** and **Mobile**. Browser offers a shareable/copyable dashboard link for a computer and the existing QR sign-in flow. The chooser closes before presenting the scanner. Mobile opens the signed-in dashboard on the phone.
- Web Add app leads with **Open App Store**, **Open App Store Connect**, and **Paste link & fill details**. Lookup fills name, Bundle ID, and Apple ID; manual fields open only on request, successful lookup for review, or lookup failure. Clipboard reads happen only after tapping Paste. Denied/unavailable clipboard access offers direct paste into the link field. The initial page does not focus an input or summon the keyboard.
- **34 browser checks pass** (17 desktop + 17 mobile) using local Firebase emulators. Tests cover synthetic clipboard/metadata autofill followed by real emulator app creation, direct provider links, manual fallback, clipboard denial, and preserving Add app through desktop QR sign-in. Existing setup, forwarding, history, preferences, and pairing regressions pass.
- **30 iOS tests pass** after the final layout correction (`ios/build/setup-choice-final.xcresult`), and the final **Release simulator build passes**.
- Native chooser, browser instructions, desktop/mobile lookup screens, and large-text dark appearance were rendered and inspected. A native label contrast/layout issue was corrected in one follow-up pass. Evidence is in ignored `test-results/setup-choice/` and `.impeccable/review/add-app-shortcuts-*.png`.
- TypeScript, JavaScript syntax, and whitespace checks pass. The UI detector used a degraded regex fallback and flagged only the pre-existing hidden QR image whose source is supplied at runtime; it does not establish contrast/accessibility.
- Subsequently shipped in uploaded build **1.0 (7)** and the September 12 web/API deployment. Physical-device sharing, camera scanning, and WebKit clipboard permission interaction remain unverified.

## Signed-in web quick links — September 11, 2026

- Replaced the duplicate native setup forms with **Add app**, **Manage connection**, and **Open dashboard**. The embedded dashboard opens the requested form/app and refreshes native data when dismissed. Provider shortcuts open App Store Connect or RevenueCat.
- The existing native session enters a fresh, nonpersistent WebKit store as an origin-bound HttpOnly/SameSite=Strict cookie (Secure on HTTPS). No credentials enter URLs or page scripts; dismissing clears the store. Navigation and native messages are origin checked. Expired sessions return to the app without starting QR pairing. Web confirmation dialogs remain supported.
- **30 iOS XCTest checks pass**, including destination encoding, cookie flags/isolation/cleanup, cross-origin rejection, demo/signed-out isolation, and rendered quick-link screens. Result: `ios/build/quick-links-final.xcresult`. **Release simulator build passes** for app and notification extension.
- **32 browser checks pass** (16 desktop + 16 mobile) against local Firebase emulators. New checks use a synthetic native service session as an HttpOnly cookie to add an app and open its connection details, verify no QR requests or credentials in page scripts/URLs, reject unknown app links, and hand expired sessions back to the app. Existing setup, forwarding, history, preferences, and desktop pairing regressions pass.
- Inspected native app list, empty state, connection details, and dark/accessibility-size connection details. Captures: ignored `test-results/quick-links/`. TypeScript check, JavaScript syntax check, whitespace check, and Impeccable detector pass.
- Subsequently shipped in uploaded build **1.0 (7)** and the September 12 web/API deployment. Physical-device Apple sign-in, in-app Files interaction, and live Apple/APNs delivery are not established by these checks.

## Build 6 archive and upload — September 11, 2026

App and notification-extension build numbers bumped to **6**, retaining marketing version **1.0**. Signed Release archive `ios/build/Quest-1.0-build6.xcarchive` succeeded; bundle versions and deep/strict signatures verified. Xcode Organizer completed App Store Connect upload and recorded **Uploaded to Apple**, **1.0 (6)**, at **2:13 PM Pacific**. Archive log is in `test-results/native-setup-upload/archive.log`. Processing/TestFlight availability remains unverified; no App Review submission was made.

## Native app setup — September 11, 2026

- Added **Apps → Add app** with public App Store/App Store Connect lookup and manual entry. Successful creation opens native connection details. The existing Apple-authenticated bearer session handles all setup requests; browser pairing is optional desktop access.
- Connection details support separate Apple production/sandbox URLs, RevenueCat forwarding URLs, existing-server forwarding settings, status refresh, Apple connection tests using a request-scoped .p8 file, iPhone test alerts, URL replacement, and app removal. Destructive actions explain immediate URL invalidation or permanent history deletion and require confirmation. Details read the current app record, so replacement URLs appear immediately.
- **32 iOS XCTest checks pass**, including eight native setup checks covering authenticated endpoint flow, failed-save recovery, explicit null forwarding settings, app identifier validation, signed-out/demo isolation, Apple acceptance versus verified receipt, stale refresh protection, and simulator screen rendering.
- **Release simulator build passes** for the app and notification extension. Simulator-rendered screens inspected for add, Apple connection, RevenueCat connection, forwarding, and Apple tests, plus dark appearance/accessibility text sizes. Captures are in ignored `test-results/native-setup/`; the final XCTest result is `ios/build/native-setup-final.xcresult`.
- Local Xcode's compiler discovery blocked writing verbose Clang diagnostics to its stderr pipe. A temporary `CC=/tmp/quest-clang` wrapper invokes the stock Xcode Clang with `2>&1`; this resolved the stall without changing compiler arguments, project build settings, or generated app behavior. Both successful verification commands used it.
- No backend changes, real Apple credentials, provider configuration changes, or production mutations were required. Live Apple/APNs delivery and physical-device interaction remain unverified for this change. The subsequent authorized upload shipped this native update as **1.0 (6)**; see the upload entry below.
- Setup wording checked against [Apple's notification URL guide](https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/enter-server-urls-for-app-store-server-notifications/) and [RevenueCat's Apple forwarding guide](https://www.revenuecat.com/docs/platform-resources/server-notifications/apple-server-notifications).


## History import timeout recovery — September 11, 2026

Two production history requests returned 502 after 10.49–10.57 seconds, matching the upstream 10-second deadline. History requests now allow Apple 30 seconds; the browser allows 55 seconds for the API to verify/store a page within its existing 60-second limit. Timeout, network, malformed-response and pagination errors are distinguished. The browser offers Retry import, explains reselecting the cleared .p8 key, and includes deduplication guidance once.

All 145 API/unit tests and 8 targeted desktop/mobile tests passed, including timeout recovery with a fresh key, cancellation, pagination, and credential clearing. TypeScript check/build and JavaScript syntax checks passed. Dark desktop/mobile error screenshots were inspected.

Deployed API revision `api-00006-tel` from the previous deployed source archive, changing only `dist/apple-history.js` and its source map; unrelated local backend edits were excluded. Vercel deployment `quest-24u2pr3q1-kozrs-projects.vercel.app` is aliased to production. Live app.js matches the tested file, health/config checks pass, and unauthenticated history import returns 401. Actual customer-history retrieval under the longer timeout still requires the user to select their key again and retry; no customer credentials were used for verification.


Current status is recorded in [APP_STORE.md](APP_STORE.md); older entries below are historical.

- **September 11 key setup:** Created and downloaded **Questline Sign in with Apple**, key **5KT3HJ52M5**, after the owner's final confirmation. Apple's saved detail page confirms Sign in with Apple for `ZMNPR5G4ZL.com.kozr.quest`. Firebase read-back verifies provider enabled, client ID `com.kozr.quest`, the same allowed bundle ID, team `ZMNPR5G4ZL`, and key `5KT3HJ52M5`. Firebase initially rejected the key-only update because a code-flow client ID was required; adding the native App ID resolved the validation error. The downloaded key parses as P-256 and its local backup permissions are `0600`. No live user token was revoked and no production account was deleted for this verification.

- **144 backend tests** pass with Auth/Firestore emulators and the actual deny-all rules. New deletion cases cover fresh same-account revocation, replay and owner checks, revocation failure, immediate access shutdown, anonymous status receipts, cleanup over 400 records, other-owner isolation, and resumption after Auth deletion fails.
- **19 native tests** pass on iPhone 17 Pro Max / iOS 26.4. An initial demo-exit test exposed unnecessary Keychain deletion in the unsigned simulator; the public offline demo now exits without touching a stored session. The rerun passed all tests. A properly signed simulator release opens without the unsigned build's Keychain entitlement error.
- **26 desktop/mobile browser checks** pass across separate runs. A combined run hit the intentional 20-sign-in limit across both device suites. The browser script now restarts its test server/namespace between desktop and mobile; the mobile rerun passed 13/13. Production rate limits remain unchanged.
- Release builds and the signed **1.0 (4)** archive succeed, including the matching notification extension. App Store Connect upload succeeded at approximately 12:41 Pacific. Apple processed it as **VALID**, it is selected in the draft, and internal TestFlight reports **IN_BETA_TESTING**. Four real public-demo screenshots processed successfully at 1320 × 2868. Listing name/subtitle/category/copy/review notes/age rating are saved.
- At the owner's request, copied the four App Review contact fields from Blind Box Tracker **4.0.1** to Questline **1.0** and verified exact equality through a separate read. No other Blind Box Tracker settings or credentials were copied.
- TypeScript check/build and diff whitespace checks pass. The Impeccable detector ran once with optional HTML parsers unavailable, so only regex checks were available. Native welcome/demo/activity/detail/apps/settings were visually inspected; final artwork fallbacks were confirmed. Privacy/support pages were inspected at 1440px and 390px without horizontal overflow, then published with the owner-supplied `eggheadlabs.dev@gmail.com`. Live HTML, JS, CSS, and both contact pages match the local build; no placeholders remain. Canonical support/privacy URLs are saved in App Store Connect.
- Following explicit owner approval, production cleanup/recovery, guarded workers, and API deployments completed. All ten functions are ACTIVE; account-deletion recovery is ENABLED every 30 minutes. The receipt TTL configuration is active. Live health/config return 200; unauthenticated deletion returns 401; invalid receipts return 400; an unknown valid receipt returns `unavailable`. No production account data was deleted for testing. Apple revocation key registration and Firebase configuration are now complete, as verified above.
- Physical Apple sign-in, revocation/deletion, camera pairing, APNs display/tap, and real Apple notification/forwarding still require acceptance. The paired iPhone 15 Pro is detected, but its Questline-only app query fails with `kAMDMobileImageMounterDeviceLocked`; unlock the phone to continue. No live purchase or token-revocation success is claimed.

## Build 3 signing and upload — September 9, 2026

- Signed archive `ios/build/Quest-build3.xcarchive` succeeded as 0.1.0 (3), including `com.kozr.quest.NotificationService` at the same version.
- Signing succeeded using the separate Developer-Signing keychain (originally IAP-Signing). The login keychain remains the default. After successful upload, the user requested cleanup: the working private key was labeled “Apple Development Signing” and the two old local Apple Development identities were removed from login. No server-side revocation was performed.
- Command-line upload failed with “Failed to Use Accounts”; Xcode Organizer upload subsequently succeeded. Organizer confirmed “IAPNotifications 0.1.0 (3) uploaded” on September 9, 2026. TestFlight processing and tester availability have not yet been checked.

# MVP validation — September 8, 2026

## Production deployment verification

### Native approval tap-target fix — build 2

- Removed multiple opposing actions from a single `TimelineView`/Form row. Countdown and Approve have separate rows; Approve, Deny and Reset now have independent sections and explicit button styles with minimum 44-point labels.
- Preserved code-match, expiration and in-flight guards; server approval/denial logic is unchanged.
- `scripts/PairingTapCheck.swift` is an offline simulator harness compiled alongside the real `PairingView.swift`, instead of the production model/app. It cannot sign in or make network requests and is not included in the application target.
- Computer-use verification on the IAP Notifications MVP simulator: Approve disabled before code match; enabled after matching; tap Approve → counts `1/0/0`; tap Deny → `1/1/0`; tap Reset → `1/1/1`. Distinct accessible buttons and visible separate sections confirmed.
- Signed Release archive `ios/build/Quest-approval-fix.xcarchive` completed successfully as `0.1.0 (2)`.

- All 115 API/security and 10 desktop/mobile browser tests rerun successfully using isolated Firebase emulators and project-local Java 21; no live customer fixtures were used.
- Updated iOS Release simulator build and signed production archive succeed with `com.kozr.quest`, beta app icon, and production HTTPS default. App Store Connect record **Quest — App Revenue Alerts** was created through Xcode. Version `0.1.0 (1)` upload succeeded September 8 at 13:26 Pacific; Apple reported the package processing. Tester availability and processing completion remain unverified.
- Vercel production health check returns HTTP 200 through Firebase with a real Firestore read. Production config reports Apple-only authentication, demo disabled, correct HTTPS origin, and APNs explicitly unavailable pending the Apple key.
- Live QR smoke test returns 201, correct production origin, Secure/HttpOnly/SameSite=Strict cookie, and browser-bound status HTTP 200. Foreign-origin creation returns 403. The test created only a short-lived unauthenticated pairing challenge; no Apple account login was simulated in production.
- All five Firebase functions deployed; four composite indexes READY and four TTL policies ACTIVE. Cloud Task queue RUNNING; no public invoker on delivery function. Apple device login, APNs acceptance/display, and TestFlight tester availability remain unverified/incomplete.

The sections below record historical baselines and do not override the deployment status above.

## Apple-only authentication

- **115 API/unit/security tests + 10 desktop/mobile browser tests pass**, zero failures/skips. The 108-test Firebase baseline was retained and updated to Apple emulator credentials. Seven additional cases cover single-use concurrent replay, raw credential non-persistence, nonce/issuer/time rejection, native-only contract and removed password routes, legacy/provider-removed sessions, private relay email, Firebase exchange nonce serialization, and provider/email/revocation rejection (some grouped within one case).
- Browser authentication now uses the real phone-approved QR endpoints in every workflow, including returning to an existing account after logout. No email/password form or fallback exists. The first browser run exposed a test-helper navigation issue; preserving the current URL fixed it, and the complete rerun passed.
- iPhone **Debug build-for-testing** and **Release Simulator build** compile. All 15 native XCTest cases compile; XCTest runtime itself was not repeated because the prior runner stalled. Actual shared Swift runtime smoke checks pass **28/28 Debug + 28/28 Release**, now including secure Apple nonce generation/encoding/uniqueness and the SHA-256 known vector.
- Installed/launched the Debug build on the existing IAP Notifications MVP simulator; visually verified the native Apple button and removal of password fields. Desktop/mobile QR screenshots are readable without horizontal overflow. This verifies the app screen, not an Apple system authorization sheet or physical-device login.
- The Impeccable detector ran once in degraded regex mode (optional parser modules unavailable). Its missing-image-source warning refers to the intentionally hidden, dynamically populated QR image; browser tests verify a loaded PNG with nonzero natural dimensions. No visual redesign was performed.
- TypeScript check/build and JavaScript syntax checks pass. Existing QR approval, revocation, origin isolation, device removal and push-worker behavior remain covered.
- **Live setup remains pending:** Arc shows the Apple provider form in `the-app-quest`, disabled and unsaved. No provider/billing change was saved, no Apple app identifier/signing credentials were provisioned, and nothing was deployed to Vercel or TestFlight in this change. Real Apple signature/audience validation, device sign-in, APNs, cloud IAM and production routing remain unverified. In-app deletion/Apple token revocation remains an App Store release prerequisite.

## Firebase migration (previous baseline)

- The previous 97 API/unit/security tests pass with Firebase Auth and Firestore emulators replacing SQLite. No tests were disabled. The 22 QR security cases still cover browser binding, approval/redemption races, expiry and account isolation.
- 11 additional Firebase tests pass: concurrent receipt/economic deduplication, app uniqueness, fenced task leases, tombstone/purge behavior, Auth disable/revocation, closed-beta admission, deny-all Firestore rules (including an authenticated owner), and production emulator rejection.
- 10 desktop/mobile browser tests pass against the Firebase-backed API, including real phone-bearer approval and automatic desktop sign-in. Browser tests now use a fresh Firestore namespace per run.
- Final combined run: **108 API/unit/security tests + 10 browser tests passed**, zero failures/skips. TypeScript check/build and Vercel Build Output generation pass. Firebase function exports compile; local tests exercise the delivery worker and cleanup code, not deployed Cloud Tasks/IAM.
- Local verification used Firebase CLI 15.29.0, Auth emulator, Firestore emulator 1.22.0 and a temporary Java 21 runtime. No production Firebase data was read/written by tests. The old SQLite file was left untouched.
- **Not verified/deployed:** Firebase project provisioning, cloud IAM/index readiness, live Tasks/Functions delivery, Vercel production routing, physical APNs, or TestFlight. Project selection/billing approval and Apple signing/APNs credentials remain prerequisites.
- The native client contract is unchanged, so no Firebase SDK/plist is needed in this server-brokered version. Native signing/runtime limitations below still apply.
- Computer Use reloaded the live localhost preview and confirmed a fresh two-minute QR with “Waiting for you to scan and approve on your iPhone.”
- Dependency installation reported 15 moderate advisories across the full dependency tree. Two subsequent production-only `npm audit` requests timed out at the npm advisory endpoint, so an up-to-date production advisory assessment remains unresolved; recheck before public launch. No forced/breaking dependency upgrades were applied.

## Earlier SQLite/native baseline (historical)

- `npm run check` and `npm run build`: pass.
- `npm test`: **97 passed**, zero failed/skipped. Includes 22 QR-pairing security tests (independent browser/approval secrets, expiry, single-use races, origin enforcement, revoked phone sessions, regeneration and manual-auth invalidation), actual ephemeral ES256 chain/nested-signature tampering, API auth/CSRF/tenant isolation, event normalization/deduplication, persistence, APNs queue behavior, and device rotation/revocation races. No real Apple sale or APNs credentials were used.
- `npm run test:browser`: **10 passed** across desktop (1440px) and mobile (390px). Real local phone-bearer approval automatically signs the browser into the matching account without desktop credentials. Denial, missing-cookie regeneration, session persistence, and existing account/app/demo/preference flows pass. Separately labelled synthetic fixtures cover expiry presentation, delivery failures and pagination. QR screenshots inspected with no horizontal overflow. Tests use port 4318 and an isolated test database; the main workspace is not seeded with test accounts.
- iOS Debug/test-target compilation and Release build: pass, including the new native scanner/approval views and both updated plists. The earlier core build directly launched on a dedicated iPhone 17 / iOS 26.4 simulator and connected to `http://localhost:4317`; that is not evidence of interactive QR approval or camera capture.
- Shared native parser **runtime smoke checks: 27/27 Release and 27/27 Debug**, compiling the actual `APIClient.swift`, `Models.swift`, and `Pairing.swift` unchanged into a small macOS test executable. Covers origin binding, malformed/ambiguous links, local-HTTP restrictions and request expiry/review validation. Generated helper/binaries are under ignored `test-results/native/`.
- **Native XCTest execution and physical camera scanning remain unverified.** All 14 XCTest cases compile, but the earlier Xcode runner stalled before test execution, including one bounded retry; runners were stopped and not retried for this change. The separate macOS parser checks do not validate native views, Keychain behavior or a physical camera.
- Real Apple webhook delivery, signing/provisioning, physical-device APNs, HTTPS production hosting, and the optional Docker deployment recipe remain unverified. These require the operator's credentials/infrastructure; no external app configuration or deployment was performed.

The web UI and native forms are intentionally provisional per the user's instruction to defer design direction.

## Optional Apple connection tests and iPhone test alerts — September 8, 2026

- Added request-scoped In-App Purchase credentials and Sandbox/Production TEST requests. No key, JWT, test token, or raw Apple payload is persisted. Matching verified webhook receipts, including endpoint-generation binding, are required for successful test status.
- App setup now exposes a separate Send test alert action, with active-device selection and explicit missing-APNs/no-phone/queued states. Settings uses the same label.
- `npm run check`, `npm run build`, JavaScript syntax and diff checks passed. All 118 unit/API/security tests passed using isolated Firebase emulators and temporary Java 21.
- Browser suite: 12 of 14 passed initially; the two failures expected the old button label. After updating that expectation, both desktop/mobile checks passed in a targeted rerun. All four new desktop/mobile flow checks passed, including waiting/receipt status, file clearing, cancellation, and phone selection. Desktop/mobile setup screenshots inspected; no horizontal overflow. Impeccable detector reported no findings on changed UI files.
- Apple API and browser notification responses used synthetic fixtures. No real Apple test or physical APNs delivery was performed. The subsequent authorized production deployment succeeded (see docs/FIREBASE.md); health/config checks passed, web assets matched exactly, and test endpoints required authentication.


### Production APNs setup follow-up

Quest-only production APNs key provisioned in Secret Manager and both API/push worker redeployed successfully. Live health/config checks passed with `apnsConfigured: true`. Key scope covers `com.kozr.quest` in TestFlight/App Store builds; no physical-phone delivery was claimed.

## Existing server forwarding — September 9, 2026

- Added per-app production/sandbox forwarding settings, an atomic signed-payload outbox, independent Cloud Tasks delivery/recovery, and browser delivery status. Existing apps default to forwarding off; the RevenueCat → Quest setup is preserved.
- All **139 API/unit/security tests pass**, including nine forwarding cases covering public-address validation, DNS pinning, exact request-body preservation, redirects, ownership, distinct notification versus economic dedupe, retry persistence, concurrent/expired leases, destination changes, app cleanup, history/demo exclusion, storage rollback, and payload scrubbing.
- All **26 desktop/mobile browser cases pass across targeted regression runs**. The new forwarding test covers persistence, unsafe-URL errors, delivery empty state, and independent environment disabling. An older demo smoke test was corrected to reopen its completed/collapsed setup step before creating a refund; the affected desktop/mobile tests were rerun successfully. The interrupted mobile regression remainder also passed.
- TypeScript check/build, web JavaScript syntax, function export discovery, and diff whitespace checks pass. The declared schema contains six composite indexes and five TTL policies. Tests used isolated local Firebase emulators with the actual deny-all Firestore rules, synthetic identities, and injected outbound forwarding transport/DNS fixtures; no customer receiver was contacted.
- Desktop/mobile forwarding screenshots are in `.impeccable/review/forwarding-desktop.png` and `forwarding-mobile.png`. The Impeccable detector returned no findings. Its independent finish review returned `ship` for this narrow UI extension; documentation review found no material omissions.
- **Not deployed by this change.** Live Apple delivery, destination readiness, Cloud Tasks/IAM, production indexes/TTL, and recovery scheduling still require deployment verification described in `docs/FIREBASE.md`. No live App Store notification URL was changed.

## Forwarding production release — September 9, 2026

The subsequent user-authorized production release supersedes the implementation-only deployment limitation above. All eight Firebase functions are ACTIVE, six indexes READY, and five TTL policies ACTIVE. The new private worker rejects public invocation (403); the Firestore-to-Cloud-Tasks production probe passed and was deleted. Scheduled recovery was explicitly invoked and returned HTTP 200. Vercel deployment `dpl_EpP7hLLYi4LiTc67tiCHMQ7xu4xW` is READY and serves the production domain; all three live web files match the tested workspace exactly. Health/config and forwarding authentication checks pass. Production APNs remains enabled and demo disabled. No real Apple/customer payload was sent as part of deployment verification. See `docs/FIREBASE.md` for the release record.


## September 11 — native submission cleanup (1.0 build 5)

Release simulator build and signed device archive passed; 21 native tests passed with no failures. New coverage checks local welcome startup, offline demo preference reset, and demo isolation from incoming pairing links, push callbacks, and foreground work. Live-account tests never use a real user's Keychain. Deep/strict archive signature verification passed with access to the system trust store.

Visual inspection covered welcome, demo Activity, Apps, and app detail on the dedicated iPhone 17 Pro Max simulator, including dark appearance and maximum accessibility text on welcome/activity. Simulator coordinate automation failed; full Settings touch and landscape checks remain outstanding. The design scan returned no findings. Evidence and logs: `test-results/app-store-polish/`.

Local App Store export failed because no iOS Distribution certificate/private-key identity is installed. The development-signed archive is `ios/build/Quest-1.0-build5.xcarchive`; it has not been uploaded. See `docs/APP_STORE.md` for the remaining distribution, store-field, and physical-device gates.


### Build 5 upload

On September 11, after explicit upload authorization, Xcode Organizer successfully signed and uploaded the archive through App Store Connect distribution. Xcode displayed “App upload complete” for **1.0 (5)** and Organizer recorded **Uploaded to Apple**, build **5**, at approximately **1:13 PM Pacific**. This resolves the upload blocker from local command-line distribution signing. Final processing/TestFlight availability was not verified because the App Store Connect browser session required sign-in. No App Review submission was made.

## September 11 — sales campaign v2 screenshot upload

Uploaded four approved poster derivatives (opaque RGB PNG, 1320 × 2868) to Questline’s iOS 1.0 draft, English (Canada), iPhone 6.9-inch. Reloading Media Manager verified all four processed posters persisted first in numbered campaign order, followed by all four original screenshots; the 6.5-inch set inherits this order. Local upload manifest records file hashes and the verified order. No App Review submission was made.

## September 13 — Add App UX simplification (local)

The native Add App chooser now names devices directly, clarifies the two-step computer handoff, uses Close, and keeps mobile setup in one sheet. Web setup separates Find, Confirm and Connect, preserves optional shortcuts/manual entry under help, shows app identity before editable details, and retains back navigation and lookup recovery.

**30 native tests and 44 desktop/mobile browser tests passed.** Browser coverage includes manual app creation for Apple and RevenueCat, lookup failures/retries, clipboard denial, delayed and superseded lookup responses, cancellation, identity edits/validation, back navigation, same-phone cookie sign-in, expired sessions and QR recovery. Browser app and QR groups now start separate test servers at each viewport so the suite does not exhaust the unchanged production sign-in limits. TypeScript check/build, JavaScript syntax and diff whitespace checks passed.

Visual inspection covered native chooser/computer handoff and large-text dark native layout, plus desktop/mobile search, confirmation and light/dark connection screens. The design scan was degraded to regex; its one finding was the existing hidden QR image that receives its source before display. This is not proof of accessibility compliance. Physical VoiceOver, system permissions and live Apple/APNs delivery were not validated. No web deployment, archive upload, build-number change or App Store submission was performed. Evidence: `test-results/add-app-fix/README.md`.

## September 13 — build 8 upload and Add App production deployment

Following explicit release authorization, the host app and extension were bumped to **1.0 (8)**, a signed Release archive succeeded, and both bundle versions plus deep/strict signatures were verified. Xcode confirmed upload completion and Organizer recorded Uploaded to Apple, build 8, at **2:04 AM Pacific**. App Store processing/TestFlight availability remains unverified; no App Review submission was made.

Production Vercel deployment `quest-a10aj0wqo-kozrs-projects.vercel.app` is aliased to `https://quest-liart-iota.vercel.app`. Live HTML/JS/CSS exactly match the tested workspace build, public health/config return 200, and unauthenticated app search returns 401. Evidence: `test-results/build8-upload/` and `test-results/add-app-prod/`.

## September 13 — App Store submission

App Store Connect confirmed build **1.0 (8)** processing complete. The build was selected in iOS 1.0, review notes and copyright were saved, all seven App Privacy categories were completed and published after owner confirmation, content rights were confirmed by the owner and saved, and free pricing/worldwide availability were configured for all 175 storefronts. Apple’s Add for Review validation passed, followed by **1 Item Submitted** and **Waiting for Review**. Submission ID: `0addc181-ea02-43e4-b9c9-0398bb9f0234`. Automatic release after approval remains selected.

A Questline-only query verified 1.0 (8) installed on the paired iPhone 15 Pro. Live Apple sign-in, pairing, APNs delivery/taps, signed-event forwarding, and account deletion were not verified in this session. Production health returned `{"ok":true}` and `git diff --check` passed. Prior native/browser validation is recorded above; no new binary was built.
