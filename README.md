# IAP Notifications — core MVP

A small notification server, browser setup UI, and native iPhone companion for indie iOS developers. No SDK or customer Apple private key is needed to **receive** App Store Server Notifications V2. Design is deliberately provisional.

## Run the web app and server

Requires Node **22.13+** with built-in `node:sqlite` (Node 22 prints an experimental SQLite warning).

```sh
npm install
npm run certificates
npm run dev
```

Open **http://localhost:4317** to see a sign-in QR. Create an account/sign in in the iPhone companion, then use **Settings → Sign in on computer** to scan and approve the desktop QR. The desktop opens the same account without asking for credentials. For web-only local testing, **Use email instead** is available as a fallback. Then add an app by its public Apple URL or manually and open its connection details. Nothing is pre-seeded. The default server listens only on your Mac; **Apple cannot send events to localhost**.

Optional configuration: copy `.env.example` to `.env` and change the values. `npm run dev` and `npm start` load `.env`. Never commit a private key or `.env`.

For a compiled run:

```sh
npm run build
npm start
```

## What works

- Email/password accounts with scrypt passwords, hashed revocable sessions, HttpOnly browser cookies, native bearer tokens, origin protection, and basic rate limiting.
- Mobile-approved desktop QR sign-in: two-minute single-use requests, locally generated QR images, independent browser/approval secrets, code comparison and explicit phone approval. No second desktop password is required.
- Public App Store URL metadata import with manual fallback; per-account app management and separate production/sandbox endpoints.
- Direct Apple V2 intake and RevenueCat's **Apple-notification forwarding** (not RevenueCat's differently shaped normalized webhook API).
- Apple's official signature verifier, pinned locally configured Apple public root certificates, online certificate-status checks, all included nested JWS verification, and app/environment binding. Invalid events never become sales. No unsigned or development-bypass webhook.
- Durable SQLite WAL activity and push jobs committed before acknowledging Apple, notification UUID and economic-transition deduplication, and newer-snapshot handling.
- Purchases, renewals, upgrades, trials, full/partial refunds, refund reversals, billing and renewal-status activity. Unknown fields/events degrade safely. Family Sharing and free transactions are not sales.
- Account-wide sales/refund/lifecycle/sandbox notification preferences and lock-screen amount privacy.
- APNs HTTP/2 delivery, persisted retry/backoff, failed-delivery visibility, invalid-token retirement, and device/session revocation.
- Native SwiftUI iPhone companion: login, desktop QR scanning/approval, activity, app status, preferences, push registration, and test push. See [the iOS setup guide](ios/README.md).

## Try the pipeline without credentials

After connecting an app, select **Create demo sale** or **Create demo refund** in the browser. Inspect it under **Activity → Demo**. Demo activity is labelled and never verifies the Apple connection or appears in the Production feed. Disable these endpoints with `ENABLE_DEMO=false`.

The phone can read that activity from the local server in Simulator. Simulator has no camera: copy the desktop's QR link and use the companion's paste-link fallback. Both clients must use the exact server origin configured by `PUBLIC_URL`; a QR never switches the phone to a different server. For a physical phone, use a reachable HTTPS service (or explicitly configured local-network Debug setup), not the phone's own `localhost`.

APNs delivery is separate: a real test push requires credentials and a provisioned companion app. Without credentials the UI explicitly says push is not configured; no fake delivery success is recorded.

## Connect an actual App Store app

1. Host this service on a persistent server behind HTTPS. Set `NODE_ENV=production`, `PUBLIC_URL=https://your-domain`, and `HOST=0.0.0.0` when appropriate for your reverse proxy/container. Preserve the database and certificate directory across restarts. The repository includes a Dockerfile, but nothing is deployed automatically.
2. Allow outbound HTTPS to Apple certificate-status services and outbound HTTP/2 to APNs. Install Apple's public root certificates using `npm run certificates`.
3. **StoreKit directly:** paste the generated production and sandbox URLs into App Store Connect's **App Information → App Store Server Notifications**, choose **Version 2**, and save. Do not overwrite another production backend's URL.
4. **Already using RevenueCat:** leave RevenueCat's Apple URLs in App Store Connect. Copy this service's **forwarding URL** into RevenueCat's **Apple Server Notification Forwarding URL**. The shared forwarding endpoint verifies and separates both environments.
5. Wait for a real, signed Apple event. A sandbox purchase verifies **sandbox only**. A demo or phone test push verifies neither Apple environment. Apple API-triggered test notifications and history recovery require separate In-App Purchase credentials and are not implemented in this keyless MVP.

For the optional Docker image, generate certificates on the host first and mount that `certificates` directory read-only at `/app/certificates`; mount a writable persistent volume at `/app/data`, and the APNs key read-only at its configured path. Supply the HTTPS `PUBLIC_URL` explicitly. The image intentionally contains no keys, database, or downloaded trust files. Container deployment is a recipe, not a deployment performed by this task.

Never equate a public app URL with ownership. Only incoming Apple-signed app/environment-matched events update connection status. Endpoint secrets can be rotated; rotation invalidates old URLs and resets setup status.

## Enable actual iPhone push

In the iOS project, select your developer team, replace `com.example.IAPNotifications` with your bundle ID, and enable Push Notifications. Configure these server environment variables:

| Variable | Meaning |
| --- | --- |
| `APNS_TEAM_ID` | Your Apple Developer team ID |
| `APNS_KEY_ID` | Key ID for your APNs signing key |
| `APNS_TOPIC` | The companion iPhone app's bundle ID |
| `APNS_PRIVATE_KEY_PATH` | Absolute/local path to your APNs `.p8` private key |

These credentials belong to **the notification companion**, not to each customer's app. Set all four or none. The service never asks customers for their Apple account password.

The phone requests notification permission only after the user taps **Enable notifications**. Its APNs environment follows the build (Debug sandbox, Release production), independently of whether an event is an Apple Sandbox or Production event.

**Queued** means the job is persisted. **Sent / APNs accepted** means Apple accepted the push, not that the phone displayed it. Offline devices, system settings, Focus, and APNs policy can delay or suppress display. Activity remains available in the inbox. Jobs older than 24 hours are cancelled to prevent old bursts; retries are at-least-once, with a stable APNs collapse ID to reduce duplicate alerts.

## Data and semantics

- SQLite lives at `data/iap.sqlite` by default. Back up with SQLite's backup tooling or stop the service and copy the database together with any WAL files. Do not copy only a live `.sqlite` file and assume it is complete.
- Raw Apple signed payloads and app customer account tokens are not stored. The service retains normalized event details and transaction IDs; treat the database as sensitive. There is no automatic retention/purge policy yet.
- Amounts use integer **milliunits** (`4990` = `4.99`) and the original currency. Apple's quantity is already included in the price.
- Sales are gross transaction activity, **not net proceeds, payouts, MRR, or accounting revenue**. No cross-currency totals are calculated.
- A partial or unknown refund is never assumed to reverse the full original price. Refund-reversal amounts are left unavailable without corresponding reliable history.
- Turning off auto-renew is not a refund or immediate subscription expiry. Trial conversions aren't guessed without prior trial history.
- App removal permanently deletes that account's app, normalized events, receipt records and delivery jobs from the active database. There is no UI undo; only an existing backup can recover them.

## Checks

```sh
npm run check
npm test
npm run test:browser
npm run build
```

Tests use temporary local HTTP servers and isolated databases. They cover real ES256 verification/tampering, app/environment checks, event semantics, authentication and CSRF, QR browser binding/expiry/replay/approval revocation, tenant isolation, deduplication, persistence, forwarding, push retries and token retirement. Synthetic verification injection exists only in the test constructor and is never an environment or HTTP option.

Browser checks start their own local test server on port 4318 and use an isolated database under `test-results/`; they do not seed accounts in your main workspace. Use an installed Chrome or install Playwright Chromium with `npx playwright install chromium` if necessary. Screenshots and test outputs stay gitignored.

Native build/test instructions are in [ios/README.md](ios/README.md). An unsigned Simulator build is not evidence of real APNs delivery.

## Deployment boundaries / intentionally deferred

This is a **local/private-beta core**, not a completed public SaaS launch. It has not been publicly deployed or connected to a real customer's live revenue.

- Single process + SQLite, not horizontal multi-region infrastructure. The process-local rate limiter is intentionally not distributed. Reverse proxies are not blindly trusted; review exact proxy configuration before a public rollout.
- Production defaults new-account registration and demo endpoints to **off**. Bootstrap an account locally, or temporarily enable `ALLOW_REGISTRATION=true` for a controlled beta. Set it back to false if self-signup is not intended.
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
