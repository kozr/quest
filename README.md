# Questline: IAP Notifications

A small notification server and native iPhone app for indie iOS developers, with an optional browser dashboard. No SDK or customer Apple private key is needed to **receive** App Store Server Notifications V2. Design is deliberately provisional.

See [App Store readiness](docs/APP_STORE.md) for the 1.0 release candidate, verified listing assets, and remaining submission requirements. The native app includes signed-in quick links to web setup and connection management, a public offline demo, and account deletion; its Firebase Apple revocation key is configured, with physical-device acceptance still pending. Public privacy/support pages use the approved `supportEmail` in `web/contact.json`; the Vercel build deliberately rejects a missing contact instead of publishing placeholders.

## Run the web app and server

Requires Node **22.13+** and **Java 21+** for Firebase's local emulators. No cloud credentials or billing are needed for local tests.

```sh
npm install
npm run certificates
npm run emulators
```

In another terminal, copy `.env.example` to `.env.local`, then:

```sh
npm run dev
```

Open **http://localhost:4317** to see a sign-in QR. Sign in with Apple in the iPhone companion, then use **Settings → Sign in on computer** to scan and approve the desktop QR. The desktop opens the same account without asking for credentials. Apple is the only identity provider; there is no email/password fallback. Automated tests use explicitly synthetic Apple credentials accepted only by the local Firebase Auth emulator. A real Apple sheet requires the Apple/Firebase setup described in [the iOS guide](ios/README.md). Then add an app by searching its title, pasting its public Apple URL, entering its Apple ID, or entering details manually and open its connection details. Nothing is pre-seeded. The default server listens only on your Mac; **Apple cannot send events to localhost**.

`npm run dev` and `npm start` load `.env.local`. Both Auth and Firestore emulators must be running for the default `demo-iap-notifications` project. Local emulator data is ephemeral unless explicitly exported. Never commit keys or environment files. Production rejects emulator settings.

For a compiled run:

```sh
npm run build
npm start
```

## What works

- Native Sign in with Apple, verified by Firebase Auth; SHA-256-bound, single-use nonces; hashed revocable service sessions, HttpOnly QR browser cookies, native bearer tokens, origin protection, and shared rate limiting. Apple/Firebase credentials are not retained in Firestore or Keychain. Legacy password sessions are rejected; accounts/data are not deleted.
- Mobile-approved desktop QR sign-in: two-minute single-use requests, locally generated QR images, independent browser/approval secrets, code comparison and explicit phone approval. No second desktop password is required.
- Public US App Store title search and automatic URL/Apple ID metadata import with manual fallback; per-account app management and separate production/sandbox endpoints.
- Direct Apple V2 intake, reliable forwarding to existing production/sandbox servers, and RevenueCat's **Apple-notification forwarding** (not RevenueCat's differently shaped normalized webhook API).
- Apple's official signature verifier, pinned locally configured Apple public root certificates, online certificate-status checks, all included nested JWS verification, and app/environment binding. Invalid events never become sales. No unsigned or development-bypass webhook.
- Firestore transactions commit activity, notification UUID/economic-transition deduplication and push outbox jobs before acknowledging Apple. Cloud Functions enqueue Cloud Tasks; tasks retry APNs delivery with fenced leases and a scheduled recovery sweep. Local emulators use a small polling runner for the same delivery logic.
- Purchases, renewals, upgrades, trials, full/partial refunds, refund reversals, billing and renewal-status activity. Unknown fields/events degrade safely. Family Sharing and free transactions are not sales.
- Account-wide notification controls for new purchases, renewals, free trials, refunds, refund reversals, auto-renew off/on, billing issues, expiry, and other App Store updates, plus sandbox alerts and lock-screen amount privacy. Existing grouped preferences carry over to the individual controls; these settings affect future pushes, not activity history.
- APNs HTTP/2 delivery, persisted retry/backoff, failed-delivery visibility, invalid-token retirement, and device/session revocation.
- Native SwiftUI iPhone app: Apple login, signed-in web quick links for adding apps and managing connections, activity, preferences, push registration, test push, and optional desktop QR sign-in. Add app offers Browser (highly recommended) with computer-link sharing and QR sign-in, or Mobile with a signed-in dashboard and paste-to-fill app details. In-app web setup refreshes native data on return. See [the iOS setup guide](ios/README.md).

## Try the demo pipeline

After connecting an app, select **Create demo sale** or **Create demo refund** in the browser. Inspect it under **Activity → Demo**. Demo activity is labelled and never verifies the Apple connection or appears in the Production feed. Disable these endpoints with `ENABLE_DEMO=false`.

The phone can read that activity from the local server in Simulator. Simulator has no camera: copy the desktop's QR link and use the companion's paste-link fallback. Both clients must use the exact server origin configured by `PUBLIC_URL`; a QR never switches the phone to a different server. For a physical phone, use a reachable HTTPS service (or explicitly configured local-network Debug setup), not the phone's own `localhost`.

APNs delivery is separate: a real test push requires credentials and a provisioned companion app. Without credentials the UI explicitly says push is not configured; no fake delivery success is recorded.

## Connect an actual App Store app

1. Deploy Firebase Auth, Firestore, and Cloud Functions, with the web UI on Vercel. Follow [Firebase deployment](docs/FIREBASE.md). Set `PUBLIC_URL` to the final HTTPS web origin. No persistent application disk is required. Nothing has been cloud-deployed by this migration.
2. Allow outbound HTTPS to Apple certificate-status services and outbound HTTP/2 to APNs. Install Apple's public root certificates using `npm run certificates`.
3. **StoreKit directly:** if you already have server URLs in App Store Connect, open **Forward to your existing server**, paste each existing URL into its matching environment, and select **Save forwarding** first. Then paste Quest’s generated production and sandbox URLs into App Store Connect’s **App Information → App Store Server Notifications**, choose **Version 2**, and save. The existing receiver must accept V2 signed notifications; forwarding does not convert V2 to V1.
4. **Already using RevenueCat:** leave RevenueCat's Apple URLs in App Store Connect. Copy this service's **forwarding URL** into RevenueCat's **Apple Server Notification Forwarding URL**. The shared forwarding endpoint verifies and separates both environments.
5. Wait for a real, signed Apple event. A sandbox purchase verifies **sandbox only**. A demo or phone test push verifies neither Apple environment. For an immediate connection check, open **Optional: test your Apple connection** in app setup. Supply an In-App Purchase .p8 key, Key ID, and Issuer ID, then choose Sandbox or Production. Credentials are used only during the test and are not persisted. To recover past activity, open **Import past notifications**, supply the same In-App Purchase credentials, and click **Import past notifications**. The service automatically imports Apple’s maximum available window (180 days production, 30 days sandbox), without a date picker. Keep the page open until completion. Re-running skips duplicates; imports never send phone pushes or verify the live webhook connection. Only notifications Apple previously attempted to send are available. Keys are request-scoped and cleared from the form when finished or stopped.

The optional Docker image can serve the API against Firestore using Application Default Credentials, but production push processing still requires the deployed Firebase functions/queue. Generate public trust certificates first and mount them read-only at `/app/certificates`. The image contains no database or private keys. Firebase Functions is the supported MVP deployment path.

Never equate a public app URL with ownership. Only incoming Apple-signed app/environment-matched events update connection status. Endpoint secrets can be rotated; rotation invalidates old URLs and resets setup status.

## Forward to an existing server

The browser setup keeps one optional HTTPS forwarding destination per environment. After saving the existing URLs, set Quest’s URLs in App Store Connect. Quest verifies each incoming notification and atomically saves a forwarding job before returning success to Apple. Forwarding uses the original JSON body and Apple signature; it never sends browser cookies, service tokens, or incoming authorization headers. Existing receivers must authenticate Apple’s signature themselves. Their entitlement processing remains their responsibility.

Every distinct live Apple notification is forwarded, including TEST and events suppressed from phone alerts or deduplicated in the activity feed. UUID retries do not create duplicate jobs. Sandbox never falls back to the production destination. Demo activity and historical imports never forward; a later live delivery of an imported notification can still forward once.

Deliveries run independently of APNs through `queueForward`, `deliverForward`, and `recoverForward`. Network errors and unsuccessful HTTP responses retry with exponential backoff for up to 24 hours (30 attempts maximum). HTTP 200–206 counts as accepted; redirects are never followed. Delivery is at least once: a crash after the receiver accepts a request can cause a repeat, so receivers must deduplicate by Apple notification UUID. View recent outcomes under **Forwarding deliveries → Refresh forwarding deliveries**. Accepted means the server acknowledged the request, not that its business processing completed.

Destinations must use public HTTPS on port 443. Private, loopback, reserved, local-network and Quest webhook addresses are rejected; DNS is rechecked at every delivery and pinned to the connection. URL query tokens are supported; URL usernames/passwords and fragments are rejected. URL validation checks syntax and DNS, not endpoint readiness: run an Apple connection test and inspect forwarding delivery afterward. Keep RevenueCat as the primary Apple receiver and configure RevenueCat → Quest forwarding using the existing RevenueCat flow.

Clearing one field and saving disables that environment. Changing or clearing a destination cancels its old queued jobs when processed; requests already in progress may finish. Failed jobs are visible until TTL cleanup but are not replayable because their raw payloads have been cleared. Use your existing backend’s Apple history recovery process if necessary. Deploy the API, all three forwarding functions, Firestore indexes/TTL, and updated web assets together before enabling this in production; see [deployment instructions](docs/FIREBASE.md).

## Optional connection tests

App setup offers two independent checks:

- **Test Apple connection:** requests Apple’s signed TEST notification for the selected environment and checks delivery for up to one minute. Quest reports success only after the matching signed notification has reached its webhook and been committed. Apple accepting delivery to RevenueCat or another backend alone is insufficient; forwarding must reach Quest. TEST activity is not a sale and does not enqueue a phone alert. The .p8 key is held in browser memory for the bounded test, sent to the authenticated backend for each Apple API call, and cleared on completion/cancellation/navigation. No key, JWT, or test token is saved to Firestore or browser storage. When forwarding is enabled, the incoming webhook’s signed payload is temporarily retained in its delivery outbox, as described below. Closing the checker does not cancel an Apple delivery already requested.
- **Send test alert:** sends a real queued APNs test to an active registered iPhone, with a device chooser when several are registered. It requires server APNs configuration and phone permission, and does not verify the Apple webhook. Delivery attempts are available in Settings.

Generate the optional In-App Purchase key in App Store Connect → Users and Access → Integrations → In-App Purchase. Supply it again for a new test. Never enable request-body capture for these credential-bearing API routes in proxies, monitoring, or application logging. The API uses only fixed Apple hosts, short-lived app-bound ES256 tokens, bounded network requests, account ownership checks, and per-user rate limits.

## Enable actual iPhone push

In the iOS project, select your developer team, replace `com.example.IAPNotifications` with your bundle ID, and enable Push Notifications. Configure these server environment variables:

| Variable | Meaning |
| --- | --- |
| `APNS_TEAM_ID` | Your Apple Developer team ID |
| `APNS_KEY_ID` | Key ID for your APNs signing key |
| `APNS_TOPIC` | The companion iPhone app's bundle ID |
| `APNS_PRIVATE_KEY_PATH` | Absolute/local path to your APNs `.p8` private key |

In Cloud Functions, use the `APNS_PRIVATE_KEY` Secret Manager secret instead of a filesystem path.

These credentials belong to **the notification companion**, not to each customer's app. Set all four or none. The service never asks customers for their Apple account password.

After sign-in, the phone automatically requests notification permission and registers with APNs when permission is granted. Existing signed-in users receive the same setup on launch. Returning from iPhone Settings retries registration after permission is enabled. A phone explicitly disconnected in the browser requires **Settings → Enable notifications** to reconnect. Its APNs environment follows the build (Debug sandbox, Release production), independently of whether an event is an Apple Sandbox or Production event.

**Queued** means the job is persisted. **Sent / APNs accepted** means Apple accepted the push, not that the phone displayed it. Offline devices, system settings, Focus, and APNs policy can delay or suppress display. Activity remains available in the inbox. Jobs older than 24 hours are cancelled to prevent old bursts; retries are at-least-once, with a stable APNs collapse ID to reduce duplicate alerts.

## Data and semantics

- Firebase Auth owns account credentials; Firestore stores profiles, apps, activity, preferences, hashed sessions/pairings, devices, and delivery jobs. Direct client access is denied by Firestore rules; all access uses the authenticated server API. Configure Firestore backups/retention before onboarding customers.
- The previous `data/iap.sqlite` file is untouched and no longer read. Existing SQLite accounts/data are **not automatically imported**; a separate reviewed migration would be needed for a populated installation. Local emulator accounts are not production accounts.
- With forwarding disabled, only normalized event details and transaction IDs are retained. With forwarding enabled, the original signed payload (which can include customer account tokens) and destination URL are temporarily stored in the server-only forwarding outbox. Both are cleared when a job is sent, fails permanently, expires, or is cancelled. Forwarding job records have a seven-day Firestore TTL; TTL cleanup is asynchronous. Saved destination URLs remain in the app’s settings until cleared or the app is removed. Treat database backups and URL query secrets as sensitive. Other activity has no automatic retention policy yet.
- Amounts use integer **milliunits** (`4990` = `4.99`) and the original currency. Apple's quantity is already included in the price.
- Sales are gross transaction activity, **not net proceeds, payouts, MRR, or accounting revenue**. No cross-currency totals are calculated.
- A partial or unknown refund is never assumed to reverse the full original price. Refund-reversal amounts are left unavailable without corresponding reliable history.
- Turning off auto-renew is not a refund or immediate subscription expiry. Trial conversions aren't guessed without prior trial history.
- App removal immediately retires endpoints and hides activity; a retrying function purges events, receipt/dedupe records and delivery jobs in batches. A small app tombstone remains. Disconnected device records and cancelled delivery history remain account-bound for diagnosis. Local mode enforces tombstones but does not run the cloud cleanup trigger. There is no UI undo.

## Checks

```sh
npm run check
npm run test:all
npm run build
```

`test:all` starts the Auth/Firestore emulators, runs API/unit and browser tests, then stops the emulators. Stop any existing emulator first. Tests use isolated Firestore namespaces and a demo Firebase project; guards prevent them from using cloud storage. They cover actual ES256 verification/tampering, Firebase Auth/rules, tenant isolation, transactional deduplication, QR races, push retry leases and device revocation. Synthetic Apple verification injection is test-only, never an environment or HTTP option.

Browser checks start a separate local server on port 4318 with a fresh Firestore namespace. With emulators already running, set `FIRESTORE_EMULATOR_HOST=127.0.0.1:8088` and `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9098` and run `npm test`; `npm run test:browser` configures these internally. Use installed Chrome or install Playwright Chromium. Screenshots and test outputs stay gitignored.

Native build/test instructions are in [ios/README.md](ios/README.md). An unsigned Simulator build is not evidence of real APNs delivery.

## Deployment boundaries / intentionally deferred

This is a **local/private-beta core**, not a completed public SaaS launch. It has not been publicly deployed or connected to a real customer's live revenue.

- Firestore is shared storage, but this is still a small private beta, not a load-tested multi-region platform. Reverse proxies are not blindly trusted; configure edge abuse protection and verify client IP behavior before public rollout. Firestore reads/writes, Tasks, Scheduler, and Functions can incur costs.
- Production defaults registration and demos to **off**. Temporarily enable `ALLOW_REGISTRATION=true` to create the first production account through the app, then disable it if desired. Directly creating a Firebase Auth user does not admit that user into a closed beta; the app profile must already exist.
- Apple-only mobile auth with QR desktop handoff. No app-managed passwords, alternate providers, or billing. QR approval is not phishing-proof: compare codes and approve only a browser you opened yourself. Paired browser sessions are independent after redemption; sign out separately on shared computers. In-app account deletion with Apple token revocation is still a release prerequisite; do not submit this as an App Store-ready build or onboard paying public users until deletion, abuse protection, backup/retention and operational policies are ready.
- No historical imports, exact proceeds, paid-app download sales, ad revenue, entitlements, paywalls, refund-consumption submissions, or refund decisions.
- No quiet-hours scheduler, widgets, teams, Android, Slack or other integrations.
- Visual direction, branding, App Store assets/signing, HTTPS hosting and live end-to-end Apple/APNs validation remain to be supplied/configured.

API details: [docs/API.md](docs/API.md). Product scope: [PRODUCT.md](PRODUCT.md).

## Primary references

- [RevenueCat Apple server notifications / forwarding](https://www.revenuecat.com/docs/platform-resources/server-notifications/apple-server-notifications)
- [Apple App Store Server Library](https://github.com/apple/app-store-server-library-node)
- [Apple notification delivery and retries](https://developer.apple.com/documentation/appstoreservernotifications/responding-to-app-store-server-notifications)
- [Apple transaction price semantics](https://developer.apple.com/documentation/appstoreservernotifications/price)
- [APNs delivery behavior](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)
- [Firebase Auth REST API](https://firebase.google.com/docs/reference/rest/auth)
- [Firestore transactions](https://firebase.google.com/docs/firestore/manage-data/transactions)
- [Firebase task queue functions](https://firebase.google.com/docs/functions/task-functions)
