# Firebase backend + Vercel web deployment

## Live deployment — September 8, 2026

- Production web: https://quest-liart-iota.vercel.app, Vercel project `kozrs-projects/quest`, connected to `kozr/quest`.
- Dedicated Firebase project `the-app-quest`: Apple-only provider enabled, owner-approved Blaze billing with CAD 10 email budget alert (not a spending cap).
- Firestore Standard database in `us-central1`: deny-all client rules deployed, four composite indexes READY, four expiry policies ACTIVE.
- All five functions deployed. Live Vercel `/healthz` returns HTTP 200 with a successful Firestore read. Private `deliverPush` queue is RUNNING with the declared limits; its Cloud Run IAM policy has no public invoker.
- Firebase iOS registration: `com.kozr.quest`, app ID `1:539152982713:ios:a44b20d6ee50a09ede3168`.
- App Store Connect record created via Xcode: **Quest — App Revenue Alerts**, bundle `com.kozr.quest`. Production archive `ios/build/Quest-production.xcarchive` successfully uploaded on September 8 at 13:26 Pacific; Xcode reported `Upload succeeded` and `Uploaded package is processing` for version `0.1.0 (1)`.
- **Not complete:** APNs key configuration, live Apple sign-in/device notification verification, Apple processing completion and tester availability/invitation. Apple Developer website still requires owner sign-in; TestFlight upload itself is complete.
- APNs is explicitly disabled in production (`apnsConfigured: false`). Functions bind `APNS_PRIVATE_KEY` only when `APNS_TOPIC` is configured. Set all APNs metadata and the real secret, then redeploy; do not use dummy credentials.
- Google provisioned the default runtime account with Editor; a dedicated least-privilege runtime identity remains a hardening task before public launch. Container build images have a one-day cleanup policy.

Existing unrelated projects must not be reused by assumption.

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

Verify service identities have only the needed Firestore/Firebase Auth permissions, queue-enqueue permission for `queuePush`/`recoverPush`, and task-invoker/service-account-use permissions required by Firebase task queues. **Do not make `deliverPush` publicly invokable**. Confirm the Cloud Task queue exists with the declared retry/rate limits and inspect actual enqueue/delivery logs after deployment. The emulator tests validate the delivery logic, not cloud IAM.

If TTL/index deployment prompts, verify the four `expireAt` policies and composite indexes in `firestore.indexes.json`; wait until all indexes are ready. Emulator tests do not enforce production composite-index requirements.

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
