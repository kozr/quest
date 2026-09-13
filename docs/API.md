# Core MVP API contract

Same-origin JSON API, all timestamps ISO-8601 UTC. Errors are `{ "error": "Useful message" }` with a non-2xx status. IDs are opaque strings. See `src/types.ts` for exact shared response fields.

## Authentication

- `GET /api/config` → `{ serviceName, registrationEnabled, demoEnabled, apnsConfigured, publicUrl }` (public)
- `POST /api/auth/apple`, `{ idToken, rawNonce, client: "ios" }` → `{ user: {id,email}, token }`. `idToken` is the native Apple credential, not a Firebase token. Generate 32 cryptographically random bytes as a 43-character unpadded base64url nonce; send its SHA-256 hex hash to Apple and its raw value here. Credentials must be issued within five minutes, unexpired, and unused. A retry after success requires a fresh Apple sign-in. This endpoint returns a native bearer token and never a browser cookie. Store the service token in Keychain, never UserDefaults.
- `POST /api/auth/register` and `/api/auth/login` return **410**. Password authentication is removed.
- `GET /api/auth/me` → `{ user }`
- `POST /api/auth/logout` → `{ ok: true }`, revokes this session. Native app should unregister its device before logout.
- Native requests use `Authorization: Bearer <token>`. Web uses same-origin cookies; do not put tokens in localStorage. Mutating cookie requests must have the matching Origin.
- Apple verification is delegated to Firebase Auth over HTTPS; the returned Firebase ID token is verified and must identify `apple.com` with a verified email (including private relay). Returned opaque service tokens are **not Firebase ID tokens**. Firebase UID is the user ID. Every authenticated request checks Apple session provenance plus Firebase disabled/deleted/revoked-account and linked Apple-provider state. Legacy password sessions stop working; existing accounts/data are not deleted. No Firebase client SDK or `GoogleService-Info.plist` is required for this server-brokered MVP, but its bundle ID must still be registered with Firebase and Apple.

### Account deletion

- `POST /api/account/delete`, `{ idToken, rawNonce, client: "ios", authorizationCode }` → HTTP 202 `{ ok: true, status: "deleting", receipt, message }`. Requires the current service session and a fresh native Apple confirmation from the **same account**. A previously consumed sign-in nonce cannot authorize deletion. Apple authorization must be revoked successfully before deletion is accepted; an upstream failure leaves the account intact and asks the user to try again.
- Acceptance creates a durable account marker that immediately invalidates sessions, connected-app endpoints, device registration, and future delivery work. `cleanupAccount` and `recoverAccountDeletion` remove the account’s active/inactive apps, event and delivery records, owned endpoint/device mappings, preferences, browser pairings, sessions, service profile, and Firebase Auth user in resumable batches. Requests already in flight cannot be recalled.
- `POST /api/account/deletion-status`, `{ receipt }` → `{ status: "deleting" | "complete" | "unavailable" }` (public, rate-limited). The 43-character random receipt reveals only completion status; it cannot authenticate or expose account information. Only its hash is retained server-side. Completed receipts expire after seven days; pending cleanup requests have no TTL.
- The phone stores the receipt in Keychain, clears its session after acceptance, and checks completion when reopened. Deleting data does not delete customers’ Apple apps or purchases. Restore Apple notification URLs/remove RevenueCat forwarding before deleting the account.
- Native Apple token revocation requires the Firebase Apple provider’s `appleSignInConfig.codeFlowConfig` to contain the operator’s Questline-scoped Sign in with Apple key. An APNs key or App Store Connect API key is not a substitute. Configure private material directly in Firebase, never tracked source or application logs.
- Production cleanup requires the deployed Firestore trigger/recovery schedule. Running only `src/server.ts` with Auth/Firestore emulators does not run Cloud Functions; local deletion integration tests invoke the shared cleanup routine directly.

### Phone-approved desktop sign-in

The only flow is **sign in with Apple on the phone → scan the desktop QR → explicitly approve on the phone → desktop opens the account**. No desktop credential form or password fallback exists.

- `POST /api/pairing/start`, `{}` → `{ pairing: { id, qrUrl, qrImageUrl, code, expiresAt, publicUrl, pollIntervalMs: 2000 } }` (201). Requires the service's exact Origin and a signed-out browser. Sets a separate HttpOnly, SameSite=Strict `iap_pairing` cookie. QR is encoded locally as a PNG data URL. Starting again cancels the previous request for that cookie.
- QR value: `iapnotifications://pair?v=1&server=<encoded public origin>&id=<opaque id>&token=<one-time approval token>`. The native client must reject a server origin different from its signed-in server; never forward credentials to a URL supplied by a QR.
- `POST /api/pairing/inspect`, `{ id, token }` → `{ pairing: { id, code, expiresAt, publicUrl, browserName } }`. **Bearer authentication required**, even if a browser cookie is present. The phone displays the signed-in account, server, matching six-digit code, and an explicit approval warning. `browserName` is an untrusted user-agent hint, not device identity.
- `POST /api/pairing/approve` or `/api/pairing/deny`, `{ id, token }` → `{ ok: true }`. Bearer authentication required. Scanning or inspecting alone never approves a browser.
- `GET /api/pairing/status?id=<id>` → `{ status, expiresAt }`, bound to the creating browser's pairing cookie. States: `pending`, `approved`, `denied`, `expired`, `consumed`, `cancelled`. No account information is returned while waiting. Poll at most once every two seconds and stop when hidden, expired or finished.
- `POST /api/pairing/redeem`, `{ id }` → `{ user }`, sets the normal HttpOnly session cookie and clears the pairing cookie. Requires the creating browser's secret, matching Origin, a signed-out browser, and an approved, unexpired request whose approving phone session is still valid. No session token is returned in JSON.
- `POST /api/pairing/cancel`, `{ id }` → `{ ok: true }`, bound to the browser cookie and Origin. Browser logout also invalidates that browser's outstanding request.

Requests expire after **two minutes** and can be approved/redeemed only once, using Firestore transactions. The six-digit code is a visual comparison aid, not a credential. QR and browser secrets are independent and stored only as hashes; spent approval hashes are cleared. Firestore TTL eventually removes expired records, but authorization always checks expiry synchronously. Browser sessions last up to 30 days and are independent of subsequent phone logout. They inherit the phone's original Firebase authentication time, so account-wide Firebase revocation also invalidates paired browsers. Sign out separately on a shared computer.

Origin checks, short expiry, and explicit comparison/approval reduce accidental authorization but cannot make QR relay phishing impossible: approve only a browser you personally opened. This is a first-party pairing protocol, not an OAuth implementation or a claim of phishing-resistant authentication.

## Apps

- `GET /api/apps` → `{ apps: ConnectedApp[] }`
- `POST /api/apps/lookup`, `{ url }` → `{ name, bundleId, appleId, iconUrl, appStoreUrl }`. Lookup is optional and failure must allow manual entry. Only recognized Apple URLs or numeric IDs are accepted. It imports public metadata, not ownership.
- `POST /api/apps/search`, `{ term }` → `{ apps: [{ name, developer, bundleId, appleId, iconUrl, appStoreUrl }] }`. Searches public US App Store apps with a 2–100 character title and returns up to 10 matches for explicit selection. Requires sign-in and shares the lookup rate limit. Other storefronts remain available through URL lookup; manual entry is always available.
- `POST /api/apps`, `{ name, bundleId, appleId, source: "apple" | "revenuecat", iconUrl?: string }` → `{ app: ConnectedApp }` (201).
- `DELETE /api/apps/:id` → `{ ok: true }`; immediately retires endpoints and hides activity. A retrying cloud trigger purges events and jobs; a tombstone remains.
- `POST /api/apps/:id/rotate-webhook` → `{ app }`; explicit confirmation, old endpoint immediately stops accepting events.
- App includes `webhookUrls.production`, `.sandbox`, separate `lastProductionEventAt` / `lastSandboxEventAt`. Until first signed event, show “Waiting for Apple”. Demo events never update these fields.
- Source `revenuecat`: instruct user to retain RevenueCat’s Apple URLs and configure its Apple notification forwarding URL. RevenueCat forwarding can contain both environments: use the special URL returned as `forwardingUrl` alongside app data (same connection, routing based on untrusted hint only followed by full verification).

## Optional Apple connection test

- `POST /api/apps/:id/apple-test`, `{ environment: "Sandbox" | "Production", keyId, issuerId, privateKey }` → `{ testNotificationToken }` (202). Authenticated, owner-only, five requests per user per minute. Requests an Apple TEST notification; does not mark the app connected.
- `POST /api/apps/:id/apple-test/status`, same credentials plus `testNotificationToken` → `{ state: "waiting" | "received", receivedAt, appleDelivery }`. Thirty checks per user per minute. Verifies Apple’s returned signed TEST payload against the account’s app/environment and looks up the matching committed webhook receipt, bound to the current endpoint generation. Does not write activity or connection status.
- Credentials are request-scoped and never persisted. The web client clears the key after completion/cancellation and polls for at most one minute. Apple errors are sanitized; no Apple error body or key is returned. No notification URL/app ID can be supplied to redirect outbound calls.

## Activity

- `GET /api/events?appId=<optional>&environment=Production|Sandbox|Demo|all&before=<optional event ID>&limit=50` → `{ events: ActivityEvent[], nextCursor: string | null }`. Default environment Production; descending received order. Max 100 per page.
- `POST /api/apps/:id/demo`, `{ kind: "sale" | "refund" }` → `{ event: ActivityEvent }` (201). Requires auth and server demo feature enabled. It writes an explicitly labelled Demo event and may enqueue a real demo push; it never marks Apple connected. No unsigned input is accepted on Apple webhook routes.

## Preferences and devices

- `GET /api/preferences` → `{ preferences: Preferences }`
- `PATCH /api/preferences`, partial Preferences → `{ preferences }`
- Defaults sales/refunds true; lifecycle/sandbox/hideAmounts false.
- `GET /api/devices` → `{ devices: RegisteredDevice[] }`
- `POST /api/devices`, `{ token: "<APNs hex token>", name, environment: "production" | "sandbox" }` → `{ device }`. Account-bound, called again when token changes. HTTP should not be used on a physical phone except explicit local development.
- `DELETE /api/devices/:id` → `{ ok: true }`; immediately disables device; the worker marks pending jobs cancelled when it processes them, before any new APNs send. A push already accepted by APNs cannot be recalled. Remote disconnection also revokes the phone's service session. Self-disconnection permits the phone to complete logout. Device/job audit records remain private to the original account.
- `POST /api/devices/:id/test` → `{ queued: true }` (202), or actionable 503 when server APNs credentials are missing.
- `GET /api/deliveries?limit=30` → `{ deliveries: [{ id, eventId, deviceId, deviceName, state, attempts, lastError, createdAt, updatedAt }] }`. States pending/processing/sent/failed/cancelled. `sent` means APNs accepted, not proved device display.

## Existing server forwarding

- `PUT /api/apps/:id/forwarding`, `{ productionUrl: string | null, sandboxUrl: string | null }` → `{ app }`. Owner-only; both keys required; unknown fields rejected. Empty strings clear a destination. Twenty saves per user per minute. Public HTTPS port 443 only; DNS validation also runs at dispatch. Direct Apple apps only; RevenueCat apps retain the RevenueCat → Quest configuration.
- App data includes `forwarding: { productionUrl, sandboxUrl }`, defaulting to null for existing connections. This is separate from `forwardingUrl`, which is Quest’s incoming URL for forwarded notifications.
- `GET /api/apps/:id/forwarding/deliveries` → `{ deliveries }`. Owner-only; latest 20 records with `id`, `environment`, `state`, `attempts`, `statusCode`, `lastError`, `createdAt`, `updatedAt`. States: pending, processing, sent, failed, cancelled. Payloads, destination secrets and receiver response bodies are never returned in delivery history. Records expire after seven days via asynchronous TTL.
- Each verified live notification gets its own durable job before HTTP 200, independent of economic dedupe and phone preferences. Original JSON/signedPayload is preserved. History/demo do not forward. Network/non-success responses retry up to 24 hours/30 attempts; HTTP 200–206 succeeds, redirects fail without following. At-least-once delivery requires receiver UUID deduplication. Destination changes invalidate queued jobs for that environment; in-flight requests may finish.

## Public webhook

`POST /webhooks/apple/:secret/production|sandbox|forward`, JSON `{ signedPayload }` only. Apple V2 signature, nested signatures, bundle/app/environment checks are mandatory. Return 200 only after durable recording. Duplicate deliveries return 200 without duplicating activity, pushes, or forwarding jobs. Invalid signatures → 400; unknown endpoint → 404; unavailable verifier/storage → 503. Never log secrets/payload/customer identifiers. Production and sandbox stay separate.

## Deferred

In-app account deletion/Apple token revocation (required before App Store release), automatic Apple URL setup/history, billing, analytics, quiet-hours scheduling, native app setup forms beyond browser handoff. These are a local/beta foundation, not a claim of a complete public SaaS launch.
