# Marketing subscriptions

Sales analytics, customer purchase/trial analytics, and sales push notifications stay free. Marketing requires an active, server-verified Quest subscription for a selected connected app. Missing or disabled billing configuration denies paid access. This includes lead results, suggested replies, Market results, scans, background AI qualification/discovery, and lead push notifications. App connection and marketing profile preparation remain available before purchase. When billing is enabled, the legacy account-level Reddit feed reads only communities and keywords from enabled profiles of currently covered apps; its account-level settings editor directs users to those app profiles.

## Product configuration

Create these auto-renewable products in **one subscription group** for the Quest bundle `com.kozr.quest`. One-app and three-app coverage have the same features. Configure tier levels so Apple's upgrades/downgrades behave as intended. Prices below are the proposed US base prices; the app displays StoreKit-localized prices.

| Product ID | Coverage | Period | Proposed base price |
| --- | --- | --- | --- |
| `com.kozr.quest.marketing.one.monthly` | 1 app | 1 month | $29.99 |
| `com.kozr.quest.marketing.one.annual` | 1 app | 1 year | $299.00 |
| `com.kozr.quest.marketing.three.monthly` | Up to 3 apps | 1 month | $74.99 |
| `com.kozr.quest.marketing.three.annual` | Up to 3 apps | 1 year | $749.99 |

No free trial, introductory rescue offer, or Family Sharing is configured by this implementation. Apple-signed family-shared transactions are rejected because coverage belongs to one Quest account.

## Explicit rollout controls

Purchasing stays **disabled by default**. Paid access stays locked, including for beta accounts, until billing is configured and a verified subscription covers the app. The native offer replaces the old trial page; it never starts a free trial. Both of these must be present:

- `MARKETING_BILLING_ENABLED=true`
- `MARKETING_APP_APPLE_ID=<Quest's own numeric App Store ID>`

`MARKETING_ALLOW_SANDBOX=true` is an explicit testing opt-in; production otherwise rejects Sandbox transactions. Do not substitute a customer's connected app ID. Use isolated test accounts for Sandbox purchases.

Apply the same settings to the API **and all lead/Market/collection/push workers** before enabling billing; inconsistent environment rollout could leave an old worker processing beta jobs. Existing provider feature flags, operational budgets, and rate limits still apply to paying accounts. Paid products must not be launched while those controls make the advertised service unavailable.

This implementation does not change App Store Connect, production environment variables, certificates, secrets, or deployments. It does not add automatic fortnightly Market refresh. Market scans remain requested by the user; lead monitoring retains its existing schedule.

Deploy the new API with billing disabled before shipping the native update. The updated app waits for a known subscription response before opening marketing, so an older API without this endpoint cannot establish access. Sales remains reachable from the connection-error screen.

## API contract

Authenticated `GET /api/marketing/subscription` creates a stable, random UUID `appAccountToken` for the signed-in Quest account and returns:

```json
{"enabled":true,"active":true,"appLimit":1,"appIDs":["connected-app-uuid"],"appAccountToken":"account-uuid","productID":"com.kozr.quest.marketing.one.monthly","expiresAt":1800000000000}
```

`expiresAt` is Unix milliseconds. Inactive accounts have `appLimit: 0` and no covered `appIDs`. A restored active subscription can have an empty selection until the user chooses apps. Native purchase must use the returned UUID as StoreKit's `appAccountToken`.

`POST /api/marketing/subscription` accepts `{signedTransaction, appIDs}`. The signed transaction is verified by Apple's App Store Server Library against locally configured Apple roots, online certificate status, Quest bundle ID, own App Store ID, and allowed environment. The server then validates the product whitelist, auto-renewable type, purchased ownership, account token, original transaction ownership, timestamps, expiry, revocation and upgrade state. Client-supplied prices, plan limits, and entitlement booleans are never accepted.

`appIDs: []` is allowed during restore. Lifecycle sync safely drops removed/unowned IDs and truncates selection to the new plan limit, so an app deletion or downgrade cannot prevent a verified refund/renewal from being recorded. `PUT /api/marketing/subscription/apps` is the strict coverage-edit endpoint: it accepts `{appIDs}` with 1–3 distinct owned connected app UUIDs, requires an active subscription, and rejects selections exceeding the tier limit.

The subscription original transaction ID can belong to only one Quest account. A different login cannot claim it, even with a valid Apple transaction. Sign in to the original Quest account to restore. New renewals supersede older purchases; replaying an old restore cannot remove a newer refund/upgrade or restore an older tier. A revoked transaction stays revoked; a new valid renewal may restore access. Billing grace period is not implemented: access ends at the verified expiration time.

## Apple lifecycle endpoint

Configure Quest's **App Store Server Notifications V2**, for production and (if opted in) Sandbox, to:

`https://<API origin>/webhooks/marketing/apple`

This is distinct from customer sales-forwarding endpoints. It verifies the outer notification and every nested signed payload using the official library. Verified renewals, refunds and revocations update the server entitlement even when the app is closed. App-account token mappings exist before purchase, so a webhook arriving before the phone sync can activate the correct account. Notifications without transactions are acknowledged without granting access.

Enabling subscriptions requires this webhook to be configured and verified end to end. No App Store Server API periodic reconciliation is implemented; a missed/delayed notification can delay refund or upgrade recognition until a later signed transaction sync. Ordinary expiration is enforced on every access check, independent of webhook delivery. Restore and foreground native refresh provide additional transaction sync.

Account deletion removes token/account records and retained transaction payload fields. A nonidentifying hashed original-ID tombstone remains to prevent reassignment of a deleted account's subscription. Deleting a Quest account does not cancel Apple billing; the native account deletion flow must tell users to manage their subscription in Apple Settings.

## Verification and release

Automated tests cover disabled rollout, semantic signature-payload validation, original ownership, app-account binding, selected-app limits, expiry boundaries, out-of-order renewal/refund replay, deleted apps, downgrade pruning, restore without selection, forged input rejection, verified lifecycle routing, subscription gates and disabled legacy trials. Integration tests use the local Firebase emulator and server-only verifier fixtures, not real purchases.

Before enabling real billing, test actual Apple Sandbox purchase, cancellation, pending approval, renewal, expiry, refund/revocation, restore on another device, wrong-Quest-account restore, 1↔3 coverage changes, and product localization. Confirm Terms, Privacy, Restore, and Manage Subscription links; show annual total billing amount prominently. Confirm sales analytics and sales push still function without a subscription. These are release checks; they are not represented as completed by local unit/integration tests.

## TestFlight paywall gate — September 26, 2026

The native Marketing tabs, per-app screens, and onboarding no longer treat `enabled: false` as free access. The API access helper also denies access when configuration is missing/disabled. Legacy Reddit feeds require a verified subscription, and the collector no longer discovers communities from unpaid account-level beta settings. Sales tracking remains free. Deploy these changes to the API and workers together; earlier deployment notes above describe the former beta bypass.

On a detected TestFlight installation, **Settings → TestFlight → Simulate no Marketing purchase** forces the unpaid UI even for a subscribed tester. **Open Marketing paywall** opens the offer directly. Turn simulation off (also available within the paywall) to return to the real purchase status. Simulation never grants server access, changes an entitlement, or allows a duplicate subscription when the server already reports an active purchase. It resets when the account/server changes or the app restarts and is unavailable in App Store installations. To exercise the purchased state, complete a real Apple Sandbox purchase first.

TestFlight uses Apple's Sandbox. Configure `MARKETING_BILLING_ENABLED=true`, `MARKETING_APP_APPLE_ID=6809939942`, and `MARKETING_ALLOW_SANDBOX=true` consistently on the API and marketing workers before testing purchases. The app cannot enable server billing through its debug switch. Do not interpret a disabled purchase button while billing is unavailable as a successful Sandbox purchase test.

Validation: 14 billing XCTest cases passed in the macOS harness using the current native billing sources; all Release iOS Swift sources passed direct typechecking; 8 backend billing unit/integration tests passed with isolated Firebase Auth/Firestore emulators, including Sandbox opt-in, app coverage, expiry, disabled configuration, and legacy feed denial. These tests use fixture transactions and do not establish real Apple Sandbox checkout. Logs: `test-results/paywall-testflight/`. Xcode's full Release build stalled during compiler probing; no archive, TestFlight upload, or backend deployment is claimed for this change.
