# Firebase backend + Vercel web deployment

## Add App UX deployment — September 13, 2026

Published the tested **Find → Confirm → Connect** flow to `https://quest-liart-iota.vercel.app` after explicit production deployment authorization. Vercel deployment `quest-a10aj0wqo-kozrs-projects.vercel.app` is aliased to production. This release updates static web assets and uses the existing Firebase API; no backend or database migration was needed. Previous deployment: `quest-i9r8gekkz-kozrs-projects.vercel.app`.

Live `index.html`, `app.js`, and `styles.css` match the tested build byte-for-byte. `/healthz` and `/api/config` return **200**, and unauthenticated `/api/apps/search` returns **401**. The preceding local validation passed all **44 desktop/mobile browser checks** and **30 native tests**. Evidence: `test-results/add-app-prod/vercel.log` and `verification.json`.

## Add app search deployment — September 12, 2026

Published automatic URL/Apple ID lookup, US App Store title search, and the signed-in Add app form to `https://quest-liart-iota.vercel.app`. Firebase API revision `api-00007-pak` is **ACTIVE**. Vercel deployment `quest-i9r8gekkz-kozrs-projects.vercel.app` is aliased to production. Only `dist/app.js`, `dist/metadata.js`, and their source maps differed from the prior production backend.

Live HTML, JavaScript, and CSS match the tested workspace files byte-for-byte. `/healthz` and `/api/config` return 200; unauthenticated `/api/apps/search` returns 401. The search helper successfully queried Apple's public API for Numbers and returned valid app/developer/Bundle ID results. The authenticated flow was previously covered by local API and desktop/mobile tests; no production user session or customer data was used for deployment testing. Build 7 opens this hosted form without another iOS upload.

Release evidence: `test-results/search-deploy/`. Previous API revision: `api-00006-tel`; previous Vercel deployment: `dpl_J9kmEXKtwD45WZ5DcV7kwN6j7S32` (`quest-24u2pr3q1-kozrs-projects.vercel.app`).

## Questline account-deletion release — September 10, 2026

The account-deletion API, cleanup/recovery functions, and existing delivery/cleanup workers with deletion guards are deployed to `the-app-quest`, following the owner's explicit approval. All ten functions report **ACTIVE**, and the account-deletion recovery schedule is **ENABLED** every 30 minutes. The receipt TTL configuration is active. A read-only predeployment aggregation found zero `account_deletions` documents; no production account was deleted for testing. See [App Store readiness](APP_STORE.md) for the remaining release gates.

Deployment completed in this order: `cleanupAccount` and `recoverAccountDeletion`, existing delivery/cleanup workers, then `api`. The functions operate only on a durable pending deletion marker created after same-account Apple confirmation and successful authorization revocation. Cleanup is idempotent, uses bounded batches, retains failed requests for retry, and keeps only a seven-day status receipt after success. Never seed a production deletion marker as a health probe. Live health/config requests return 200, unauthenticated deletion returns 401, invalid receipts return 400, and an unknown well-formed receipt returns `unavailable`.

On September 11, registered and downloaded **Questline Sign in with Apple**, key **5KT3HJ52M5**, after the owner's final confirmation. Apple's saved key details confirm Sign in with Apple restricted to `ZMNPR5G4ZL.com.kozr.quest`. Configured `appleSignInConfig.codeFlowConfig` directly in Firebase with team `ZMNPR5G4ZL`, the new key ID, and private material; the provider remains enabled. Set native `clientId` and `appleSignInConfig.bundleIds` to `com.kozr.quest`. Firebase requires a client ID for code flow, and Apple's token endpoint accepts the App ID for native authorization codes. Read-back verified all non-secret fields. The local backup is `/Users/nicholaswong/Downloads/AuthKey_5KT3HJ52M5.p8`, mode `0600`; no private material was printed or added to source. Other apps' keys and the Questline APNs key were untouched. Real fresh Apple authorization and revocation/deletion on a disposable account still require a physical-device acceptance test.

The website is published at `https://quest-liart-iota.vercel.app`, with the approved `eggheadlabs.dev@gmail.com` contact on `/privacy/` and `/support/`. Deployment `quest-bacekr429-kozrs-projects.vercel.app` is aliased to production. Both pages and the main HTML/JS/CSS match the local build byte-for-byte and return 200 without contact placeholders. The canonical privacy/support URLs are saved in App Store Connect. The Vercel build continues to reject missing contact details.

## Live deployment — September 8, 2026

- Production web: https://quest-liart-iota.vercel.app, Vercel project `kozrs-projects/quest`, connected to `kozr/quest`.
- Dedicated Firebase project `the-app-quest`: Apple-only provider enabled, owner-approved Blaze billing with CAD 10 email budget alert (not a spending cap).
- Firestore Standard database in `us-central1`: deny-all client rules deployed, four composite indexes READY, four expiry policies ACTIVE.
- All five functions deployed. Live Vercel `/healthz` returns HTTP 200 with a successful Firestore read. Private `deliverPush` queue is RUNNING with the declared limits; its Cloud Run IAM policy has no public invoker.
- Firebase iOS registration: `com.kozr.quest`, app ID `1:539152982713:ios:a44b20d6ee50a09ede3168`.
- App Store Connect record created via Xcode: **Quest — App Revenue Alerts**, bundle `com.kozr.quest`. Production archive `ios/build/Quest-production.xcarchive` successfully uploaded on September 8 at 13:26 Pacific; Xcode reported `Upload succeeded` and `Uploaded package is processing` for version `0.1.0 (1)`.
- **Not complete:** live Apple sign-in/device notification verification, Apple processing completion and tester availability/invitation. Apple Developer website still requires owner sign-in; TestFlight upload itself is complete.
- APNs is configured in production (`apnsConfigured: true`). Quest-only production key `HJMXAS9W95` is stored in Secret Manager as `APNS_PRIVATE_KEY`, version 1. Team `ZMNPR5G4ZL`, topic `com.kozr.quest`; both `api` and `deliverPush` redeployed successfully. This key supports TestFlight/App Store companion builds. Debug APNs sandbox builds need a separate sandbox key configuration.
- Google provisioned the default runtime account with Editor; a dedicated least-privilege runtime identity remains a hardening task before public launch. Container build images have a one-day cleanup policy.

Existing unrelated projects must not be reused by assumption.

## Optional test controls deployed — September 8, 2026

- Updated `iap-notifications:api` in `the-app-quest` (`us-central1`) and published Vercel production deployment `quest-nqphdnkjc-kozrs-projects.vercel.app`, aliased to `https://quest-liart-iota.vercel.app`.
- Production `/healthz` and `/api/config` return 200. Live `app.js` and `styles.css` exactly match the tested workspace assets. Apple-test request/status and phone-test endpoints reject unauthenticated requests with 401.
- Optional Apple connection testing is available in app setup. APNs was initially unconfigured; the subsequent setup below enabled Send test alert. No live Apple TEST or physical-phone delivery was attempted.

## Quest APNs provisioned — September 8, 2026

- Created **Quest Push Notifications**, a Production, Topic Specific key restricted to `com.kozr.quest`. Existing app keys were not modified.
- Uploaded its private material directly from the downloaded .p8 file to `projects/539152982713/secrets/APNS_PRIVATE_KEY/versions/1`. The retained Downloads backup has user-only file permissions. No private material is in tracked source or dotenv.
- Set non-secret APNs metadata in `.env.the-app-quest`, then deployed `api` and `deliverPush`. The runtime identity received secret access; no worker public-invoker access was added.
- Live `/healthz` returns 200 and `/api/config` now returns `apnsConfigured: true`. Chrome was signed out of Quest, so actual phone delivery remains unverified. Sign in using the TestFlight companion, enable notifications, and use Send test alert.

## Architecture

- Firebase Auth verifies native Apple ID tokens and raw nonces through `accounts:signInWithIdp`. The service pins `apple.com`, verifies the returned Firebase ID token/provider, and atomically consumes each nonce with session creation. No passwords or Firebase refresh tokens are retained. Sessions must carry Apple provenance; old password sessions fail closed. Each authenticated request also checks Firebase's account, Apple-provider and revocation state.
- Firestore is server-only (deny-all client rules). An Apple webhook transaction writes the receipt, normalized event, economic dedupe marker and outbox jobs atomically before returning HTTP 200.
- `queuePush` reacts to committed outbox jobs and enqueues a named Cloud Task. `deliverPush` claims a fenced lease, validates the device/session/preferences, and sends APNs. `recoverPush` runs every five minutes to recover stranded work. Task delivery is at-least-once; APNs collapse IDs reduce duplicates but cannot guarantee exactly-once display after a crash.
- `cleanupApp` performs resumable, bounded deletion after app tombstoning. Sessions, pairing challenges, Apple nonce replay records and rate-limit buckets have TTL policies. Expiry checks do not rely on the TTL deletion schedule.
- Vercel serves `web/` and rewrites `/api/*`, `/webhooks/*`, and `/healthz` to the Firebase `api` function. Browser cookies remain same-origin. The phone and generated QR both use the final Vercel/custom-domain origin.

## Project setup (operator action)

1. Create/select a **dedicated** Firebase project and choose its Firestore location before adding production data. Functions default to `us-central1`; choose a nearby region if required and set `IAP_FUNCTION_REGION` consistently for Firebase and Vercel. A region change after deployment is a separate migration.
2. Enable **Apple only** under Firebase Authentication; leave Email/Password and all other providers disabled. Register the companion's final iOS bundle ID as a Firebase Apple app. The native-only credential flow does not require a web Services ID; desktop authenticates by QR, never an Apple web redirect. Configure Sign in with Apple for the same App ID in Apple Developer and retain the Xcode entitlement. Create a Firestore **Standard / Native mode** database. Deployment replaces this project's Firestore rules with deny-all rules, so do not use an unrelated existing app's database.
3. Enable the billing plan required by Functions, Cloud Tasks, and Scheduler, with explicit owner approval. Configure billing alerts (alerts are not hard spending caps), conservative quotas and monitoring. Local emulator development requires no billing.
4. Pick the final Vercel/custom-domain URL and copy the Firebase project's Web API Key from project settings. The API key identifies the project; it is not an Admin credential. Use Application Default Credentials/service identities for server access, never a committed service-account key.
5. Configure the companion's Apple team, bundle ID, Sign in with Apple and Push Notifications entitlements, and obtain its APNs `.p8` key. This is separate from customers' apps. Apple sign-in keys and APNs keys have different roles; never reuse one by assumption. Before App Store release, implement account deletion and Apple token revocation and configure the required Apple OAuth code-flow credentials for revocation.

## Function environment

Use a gitignored `.env.<your-project-id>` in the repository root (Functions source). Example:

```dotenv
PUBLIC_URL=https://your-web-domain.example
IAP_FIREBASE_WEB_API_KEY=your-firebase-web-api-key
IAP_FUNCTION_REGION=us-central1
ALLOW_REGISTRATION=true
ENABLE_DEMO=false
APNS_TEAM_ID=your-apple-team
APNS_KEY_ID=your-apns-key-id
APNS_TOPIC=your.companion.bundle
```

Do not include `PORT`, `GCLOUD_PROJECT`, any custom `FIREBASE_*` key, or emulator settings in deployed dotenv files; Firebase reserves those names and supplies its project ID automatically. `.env.local` is for local development only. Avoid a shared `.env` containing development settings: Firebase merges `.env` into production configuration. Production always requires HTTPS and rejects emulator hosts.

Store the APNs key as a secret, not plaintext dotenv:

```sh
npx firebase functions:secrets:set APNS_PRIVATE_KEY --project YOUR_PROJECT_ID --data-file /absolute/path/to/AuthKey.p8
npx firebase deploy --project YOUR_PROJECT_ID --only firestore,functions
```

The `api` and `deliverPush` functions bind this secret. Public Apple root certificates are generated during predeploy and included in the function package; no customer/private Apple keys are needed to verify incoming notifications. Secret rotation requires redeploying consumers. Don't commit downloaded private keys, Admin credentials or environment files.

Verify service identities have only the needed Firestore/Firebase Auth permissions, queue-enqueue permission for `queuePush`/`recoverPush` and `queueForward`/`recoverForward`, and task-invoker/service-account-use permissions required by Firebase task queues. **Do not make `deliverPush` or `deliverForward` publicly invokable**. Confirm the Cloud Task queue exists with the declared retry/rate limits and inspect actual enqueue/delivery logs after deployment. The emulator tests validate the delivery logic, not cloud IAM.

If TTL/index deployment prompts, verify the five `expireAt` policies (including `forwarding_jobs`) and all six composite indexes in `firestore.indexes.json`; wait until all indexes are ready. Emulator tests do not enforce production composite-index requirements.

## Vercel setup

Import `kozr/quest`, branch `main`, repository root. `vercel.json` selects the Build Output API build. Configure:

```dotenv
FIREBASE_PROJECT_ID=YOUR_PROJECT_ID
IAP_FUNCTION_REGION=us-central1
```

The build refuses missing or demo project IDs. It emits static assets and API/webhook rewrites to `https://REGION-PROJECT.cloudfunctions.net/api`. No Firebase Admin credentials or APNs key belongs in Vercel. Deploy Firebase first, then Vercel; its final origin must exactly equal the Firebase `PUBLIC_URL` (no path, query, or trailing domain mismatch).

Preview deployments must not silently pair into production. Their origin will be rejected by production Origin checks; use a dedicated staging backend for functional previews. Disable redirecting login pages/deployment protection on the production Apple webhook paths so Apple's POST requests actually reach the handler.

## Smoke checks before inviting testers

1. `/healthz` returns 200 and `/api/config` shows the exact final origin and expected feature flags.
2. Sign in with Apple on the native companion at that origin. Test both shared email and Hide My Email, cancellation, repeated sign-in and a revoked/disabled account. Scan/approve a desktop QR; only that waiting browser should sign in. Confirm logout and remote device removal. Emulator credentials are synthetic and do not prove live Apple audience/signature validation.
3. Create an app and request a test push. Confirm a durable job, Cloud Task dispatch, APNs acceptance and actual physical-phone display.
4. Deliver an Apple-signed sandbox notification. Verify Sandbox connection status only, then resend to confirm no extra event/push.
5. Check Firestore rules, Auth revocation, TTL/index readiness, task IAM, failed-job alerts, backups/retention and cleanup-function retries. Configure edge abuse controls and validate trusted-proxy/client-IP behavior; default Express does not trust arbitrary forwarding headers.
6. Lock down cloud request logs: webhook URLs contain endpoint secrets. The application avoids logging paths/payloads, but infrastructure request logging must also have appropriate access/retention/exclusion policies.

## Existing SQLite installations

The old SQLite file is untouched, not imported or deleted. This MVP migration starts a new Firebase account/data store. For populated installations, stop and perform a separate reviewed account/event import, session invalidation and webhook cutover; do not silently discard history. Emulator accounts are disposable test data and are never uploaded into production.

References: [Firebase Auth REST](https://firebase.google.com/docs/reference/rest/auth), [task queue functions](https://firebase.google.com/docs/functions/task-functions), [function environment/secrets](https://firebase.google.com/docs/functions/config-env), [Vercel Build Output routes](https://vercel.com/docs/build-output-api/configuration).

## Existing server forwarding rollout — deployed September 9, 2026

Deploy the updated `api`, `queueForward`, `deliverForward`, `recoverForward`, and `cleanupApp`, plus the web assets and `firestore.indexes.json`. The three new forwarding functions are independent of APNs secrets. Their task queue must remain private and the enqueue identities need task-creation permissions. Enable outbound DNS and HTTPS to public customer-configured receivers. Forwarding is off by default for all existing apps.

Wait for the two forwarding composite indexes to be READY and `forwarding_jobs.expireAt` TTL to be ACTIVE. Payload/destination field indexing is disabled. Queued raw signed payloads are cleared on completion/cancellation/failure; the seven-day TTL is a fallback and removes delivery metadata as well. Extend request-log exclusions and backup retention controls to these sensitive payloads and destination URL tokens.

Before onboarding an existing receiver, save its production/sandbox URLs in Quest, update the Apple V2 URLs, request an Apple TEST, and confirm both Quest’s receipt and the matching forwarding outcome. Also verify a deliberate receiver outage retries successfully through Cloud Tasks and the recovery sweep. Local emulator tests cannot verify cloud IAM, deployed indexes, or external receiver readiness. The deployment and infrastructure checks below are complete; forwarding a real Apple notification to a customer receiver remains an onboarding check.

### Verified production release

- Published the tested API and all delivery/cleanup functions to `the-app-quest` in `us-central1`. All eight functions are ACTIVE; API revision `api-00004-foy` became active at 09:38 UTC on September 9, 2026.
- All six composite indexes are READY and all five TTL policies are ACTIVE, including `forwarding_jobs.expireAt`.
- `deliverForward` queue is RUNNING with 10 concurrent dispatches, 20 dispatches/second, and a 24-hour queue retry window. Its worker has no public IAM binding and rejects unauthenticated invocation with HTTP 403. The application applies its own 30-attempt/24-hour delivery limit.
- A temporary production probe, containing no Apple payload or destination and referring to a nonexistent app, successfully traversed Firestore → `queueForward` → Cloud Tasks → `deliverForward`. The worker cancelled it as expected, and the probe record was deleted. No customer notification was forwarded by this test.
- `firebase-schedule-recoverForward-us-central1` is ENABLED on its five-minute schedule. An explicit scheduler run returned HTTP 200 from `recoverforward-00001-tet`.
- Promoted Vercel deployment `dpl_EpP7hLLYi4LiTc67tiCHMQ7xu4xW` (`quest-3eqav4ibp-kozrs-projects.vercel.app`) to `https://quest-liart-iota.vercel.app`. The previous web deployment is `dpl_CUfNQWnZy5tq6vnJPK6yRx8z5Z4M` for rollback reference.
- Live `/`, `/app.js`, and `/styles.css` return HTTP 200 and exactly match the tested workspace files. `/healthz` and `/api/config` return 200; APNs remains configured, demo remains disabled, and the public origin is unchanged. Forwarding settings/history reject unauthenticated requests with 401.
- No app’s existing forwarding destinations or App Store Connect URLs were changed. Existing apps remain forwarding-off until their owners save destinations.
