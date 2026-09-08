# MVP validation — September 8, 2026

## Production deployment verification

- All 115 API/security and 10 desktop/mobile browser tests rerun successfully using isolated Firebase emulators and project-local Java 21; no live customer fixtures were used.
- Updated iOS Release simulator build succeeds with `com.kozr.quest`, beta app icon, and production HTTPS default. Signed archive reached codesign but has not completed; this is not a TestFlight upload.
- Vercel production health check returns HTTP 200 through Firebase with a real Firestore read. Production config reports Apple-only authentication, demo disabled, correct HTTPS origin, and APNs explicitly unavailable pending the Apple key.
- Live QR smoke test returns 201, correct production origin, Secure/HttpOnly/SameSite=Strict cookie, and browser-bound status HTTP 200. Foreign-origin creation returns 403. The test created only a short-lived unauthenticated pairing challenge; no Apple account login was simulated in production.
- All five Firebase functions deployed; four composite indexes READY and four TTL policies ACTIVE. Cloud Task queue RUNNING; no public invoker on delivery function. Apple device login, APNs acceptance/display, App Store Connect and TestFlight remain unverified/incomplete.

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
