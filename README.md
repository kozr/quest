# IAP Notifications — core MVP

A small notification server, browser setup UI, and native iPhone companion for indie iOS developers. No SDK or customer Apple private key is needed to **receive** App Store Server Notifications V2. Design is deliberately provisional.

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

Open **http://localhost:4317** to see a sign-in QR. Create an account/sign in in the iPhone companion, then use **Settings → Sign in on computer** to scan and approve the desktop QR. The desktop opens the same account without asking for credentials. For web-only local testing, **Use email instead** is available as a fallback. Then add an app by its public Apple URL or manually and open its connection details. Nothing is pre-seeded. The default server listens only on your Mac; **Apple cannot send events to localhost**.

`npm run dev` and `npm start` load `.env.local`. Both Auth and Firestore emulators must be running for the default `demo-iap-notifications` project. Local emulator data is ephemeral unless explicitly exported. Never commit keys or environment files. Production rejects emulator settings.

For a compiled run:

```sh
npm run build
npm start
```

## What works

- Firebase Auth email/password accounts, hashed revocable service sessions, HttpOnly browser cookies, native bearer tokens, origin protection, and Firestore-backed shared rate limiting. Firebase manages passwords; the app database never stores them.
- Mobile-approved desktop QR sign-in: two-minute single-use requests, locally generated QR images, independent browser/approval secrets, code comparison and explicit phone approval. No second desktop password is required.
- Public App Store URL metadata import with manual fallback; per-account app management and separate production/sandbox endpoints.
- Direct Apple V2 intake and RevenueCat's **Apple-notification forwarding** (not RevenueCat's differently shaped normalized webhook API).
- Apple's official signature verifier, pinned locally configured Apple public root certificates, online certificate-status checks, all included nested JWS verification, and app/environment binding. Invalid events never become sales. No unsigned or development-bypass webhook.
- Firestore transactions commit activity, notification UUID/economic-transition deduplication and push outbox jobs before acknowledging Apple. Cloud Functions enqueue Cloud Tasks; tasks retry APNs delivery with fenced leases and a scheduled recovery sweep. Local emulators use a small polling runner for the same delivery logic.
- Purchases, renewals, upgrades, trials, full/partial refunds, refund reversals, billing and renewal-status activity. Unknown fields/events degrade safely. Family Sharing and free transactions are not sales.
- Account-wide sales/refund/lifecycle/sandbox notification preferences and lock-screen amount privacy.
- APNs HTTP/2 delivery, persisted retry/backoff, failed-delivery visibility, invalid-token retirement, and device/session revocation.
- Native SwiftUI iPhone companion: login, desktop QR scanning/approval, activity, app status, preferences, push registration, and test push. See [the iOS setup guide](ios/README.md).

## Try the pipeline without credentials

After connecting an app, select **Create demo sale** or **Create demo refund** in the browser. Inspect it under **Activity → Demo**. Demo activity is labelled and never verifies the Apple connection or appears in the Production feed. Disable these endpoints with `ENABLE_DEMO=false`.

The phone can read that activity from the local server in Simulator. Simulator has no camera: copy the desktop's QR link and use the companion's paste-link fallback. Both clients must use the exact server origin configured by `PUBLIC_URL`; a QR never switches the phone to a different server. For a physical phone, use a reachable HTTPS service (or explicitly configured local-network Debug setup), not the phone's own `localhost`.

APNs delivery is separate: a real test push requires credentials and a provisioned companion app. Without credentials the UI explicitly says push is not configured; no fake delivery success is recorded.

## Connect an actual App Store app

1. Deploy Firebase Auth, Firestore, and Cloud Functions, with the web UI on Vercel. Follow [Firebase deployment](docs/FIREBASE.md). Set `PUBLIC_URL` to the final HTTPS web origin. No persistent application disk is required. Nothing has been cloud-deployed by this migration.
2. Allow outbound HTTPS to Apple certificate-status services and outbound HTTP/2 to APNs. Install Apple's public root certificates using `npm run certificates`.
3. **StoreKit directly:** paste the generated production and sandbox URLs into App Store Connect's **App Information → App Store Server Notifications**, choose **Version 2**, and save. Do not overwrite another production backend's URL.
4. **Already using RevenueCat:** leave RevenueCat's Apple URLs in App Store Connect. Copy this service's **forwarding URL** into RevenueCat's **Apple Server Notification Forwarding URL**. The shared forwarding endpoint verifies and separates both environments.
5. Wait for a real, signed Apple event. A sandbox purchase verifies **sandbox only**. A demo or phone test push verifies neither Apple environment. Apple API-triggered test notifications and history recovery require separate In-App Purchase credentials and are not implemented in this keyless MVP.

The optional Docker image can serve the API against Firestore using Application Default Credentials, but production push processing still requires the deployed Firebase functions/queue. Generate public trust certificates first and mount them read-only at `/app/certificates`. The image contains no database or private keys. Firebase Functions is the supported MVP deployment path.

Never equate a public app URL with ownership. Only incoming Apple-signed app/environment-matched events update connection status. Endpoint secrets can be rotated; rotation invalidates old URLs and resets setup status.

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

The phone requests notification permission only after the user taps **Enable notifications**. Its APNs environment follows the build (Debug sandbox, Release production), independently of whether an event is an Apple Sandbox or Production event.

**Queued** means the job is persisted. **Sent / APNs accepted** means Apple accepted the push, not that the phone displayed it. Offline devices, system settings, Focus, and APNs policy can delay or suppress display. Activity remains available in the inbox. Jobs older than 24 hours are cancelled to prevent old bursts; retries are at-least-once, with a stable APNs collapse ID to reduce duplicate alerts.

## Data and semantics

- Firebase Auth owns account credentials; Firestore stores profiles, apps, activity, preferences, hashed sessions/pairings, devices, and delivery jobs. Direct client access is denied by Firestore rules; all access uses the authenticated server API. Configure Firestore backups/retention before onboarding customers.
- The previous `data/iap.sqlite` file is untouched and no longer read. Existing SQLite accounts/data are **not automatically imported**; a separate reviewed migration would be needed for a populated installation. Local emulator accounts are not production accounts.
- Raw Apple signed payloads and app customer account tokens are not stored. The service retains normalized event details and transaction IDs; treat the database as sensitive. There is no automatic retention/purge policy yet.
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
- Email/password mobile auth with QR desktop handoff; no Sign in with Apple, email verification, password reset, MFA, or billing yet. QR approval is not phishing-proof: compare codes and approve only a browser you opened yourself. Paired browser sessions are independent after redemption; sign out separately on shared computers. Do not onboard paying public users until account recovery, deletion, abuse protection, backup/retention and operational policies are ready.
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
