# App Store preparation — September 11, 2026

Status: **1.0 (8) submitted September 13, 2026 — Waiting for Review.** Apple confirmed **1 Item Submitted**. Privacy is published; free pricing, worldwide availability, copyright and content rights are configured. Live physical-device acceptance remains unverified in this session.

## Submission setup — September 13, 2026

- App Store Connect shows build **1.0 (8)** upload processing **Complete** and TestFlight **Ready to Submit**, assigned to the internal `devs` group. Build 8 was selected and saved in the iOS 1.0 submission draft.
- Copyright saved as **2026 Nicholas Wong**. Review notes updated for the final device chooser, Find → Confirm → Connect setup, automatic notification permission after sign-in, and public offline demo. The reviewer-credentials checkbox is off because no shared username/password exists and demo entry needs no account; the notes explain real Apple sign-in separately.
- All seven App Privacy categories were completed with **App Functionality**, **linked to the user**, and **no tracking**. The owner explicitly confirmed Apple's accuracy/update declaration. App Store Connect verified **Published a few seconds ago by Nicholas Wong**.
- Owner confirmed **free in all supported countries/regions**. The zero-price schedule was confirmed for all 175 storefronts and availability read back as **175 Available**, with territory rows showing **Available on App Release**.
- Owner confirmed necessary rights/permission for connected-app names, icons and purchase data. Content Rights now reads **Yes, this app has the necessary rights to its third-party content**.
- The existing app-level DSA status reads **non-trader**; it was not changed.
- A Questline-only physical-device query confirms the paired iPhone 15 Pro has **1.0 (8)** installed. This does not verify real Apple sign-in, pairing, APNs delivery/taps, signed-event forwarding, or account-deletion completion; owner acceptance results are still pending.
- Apple’s Add for Review validation passed. The owner-authorized **Submit for Review** action succeeded; App Store Connect showed **1 Item Submitted** and version **1.0 Waiting for Review**. Submission ID: `0addc181-ea02-43e4-b9c9-0398bb9f0234`. Existing automatic release after approval remains selected.
- Production `/healthz` returned `{"ok":true}`. No live account was deleted and no device acceptance result was inferred from installation.

## Build 8 upload and production web release — September 13

- Bumped the app and notification extension to **1.0 (8)**, keeping bundle identifiers and marketing version unchanged.
- Signed Release archive: `ios/build/Quest-1.0-build8.xcarchive`. Both archived bundle versions were verified and deep/strict signature checks passed.
- Xcode displayed **App upload complete: IAPNotifications 1.0 (8) uploaded**. Organizer recorded **Uploaded to Apple**, build **8**, at **2:04 AM Pacific**.
- The simplified web setup is live at `https://quest-liart-iota.vercel.app`, deployment `quest-a10aj0wqo-kozrs-projects.vercel.app`. Live HTML, JavaScript and CSS match the tested build; health/config return 200 and unauthenticated app search returns 401.
- Evidence: `test-results/build8-upload/` and `test-results/add-app-prod/`. Prior validation passed 30 native tests and 44 desktop/mobile browser checks. No App Review submission was made.

## Add App UX refinement — September 13

The native chooser now uses **On a computer — Recommended** and **On this iPhone**, consistent forward affordances, stronger supporting text, and **Close**. Computer instructions are numbered and the raw address is collapsed. Mobile replaces the chooser in the same sheet instead of stacking another sheet.

The web Add App page is now **Find → Confirm → Connect**. Search is primary; optional external shortcuts, clipboard paste, and unpublished-app entry are grouped under help. Results support real app icons, confirmation shows the selected identity with optional editing, and provider selection comes afterward. Back navigation preserves edits; failures stay in the relevant step. Existing Apple/RevenueCat configuration and forwarding protections remain available.

The initially local refinement was subsequently released through the authorized production deployment and build 8 upload recorded above.

## Setup chooser and quick-link upload — build 7

- Bumped app and notification extension to **1.0 (7)**. The signed Release archive is `ios/build/Quest-1.0-build7.xcarchive`; both bundle versions and deep/strict signatures were verified.
- Xcode Organizer confirmed **App upload complete: IAPNotifications 1.0 (7) uploaded**, then **Uploaded to Apple**, build **7**, at **10:07 PM Pacific** on September 11.
- Archive log: `test-results/build7-upload/archive.log`. The immediate App Store Connect API check had not yet listed build 7; processing and TestFlight availability remain unverified.
- This build includes the Browser/Mobile chooser and signed-in web sheets. Automatic lookup, title search, and the updated hosted setup flow were subsequently deployed on September 12. No App Review submission or store-metadata publication was performed.

## Native setup upload — build 6

**Follow-up:** build 7 now contains signed-in web quick links in place of the native setup forms. The updated hosted dashboard was deployed on September 12.

- Bumped the app and notification extension from **1.0 (5)** to **1.0 (6)**. This archive includes the native add-app, connection, forwarding, and notification-testing flow.
- Signed Release archive succeeded at `ios/build/Quest-1.0-build6.xcarchive`. Both bundle versions were read back as 1.0 (6), and deep/strict signature verification passed.
- Xcode Organizer reported **App upload complete: IAPNotifications 1.0 (6) uploaded** and recorded **Uploaded to Apple**, build **6**, at **2:13 PM Pacific** on September 11.
- The preceding feature validation passed **32 native tests**, a Release simulator build, and simulator visual checks including dark appearance and large text. Archive log: `test-results/native-setup-upload/archive.log`.
- App Store Connect processing and TestFlight availability are not yet verified. No App Review submission or store-metadata publication was performed.

## Uploaded submission cleanup — build 5

The September 11 pass preserves live Apple sign-in and app management while removing server configuration and connection-status chatter from the iPhone experience. The welcome screen has a concise introduction, native Apple button, prominent **Explore demo** action, and privacy/support links. Signed-out startup performs no service check, so demo entry works without waiting for a network timeout. Debug and Release use the fixed production service by default; developers may override Debug through the Xcode scheme environment.

The public offline demo is isolated from QR pairing, APNs callbacks, live notification taps, and account API operations. It stays on sample activity, keeps event timestamps stable during the visit, and resets preferences when exited. Demo apps no longer expose placeholder Apple IDs, pending live-connection states, or disabled browser-management buttons. Settings shows temporary alert preferences and an on-screen notification preview that responds to **Hide amounts in notifications**. Demo account/server rows and duplicate exit actions are removed.

Validation for this candidate:

- **21 native tests passed**, including signed-out launch, demo data isolation, local preferences/reset, and ignored external pairing/notification entry points. Tests instantiate isolated models without reading a real Keychain session.
- Release simulator build succeeded with normal simulator signing. The welcome screen, demo Activity, Apps, and sample app details were inspected on the dedicated iPhone 17 Pro Max/iOS 26.4 simulator. Light/dark appearance and the largest accessibility text size were inspected on welcome/activity. Touch-coordinate automation failed for scrolling and some tab actions; the complete Settings touch walkthrough and landscape check remain unverified in this pass. Do not treat source inspection or model tests as a substitute for those interactions.
- Design scan returned no findings; it does not prove native accessibility or contrast. `git diff --check` passed.
- Signed archive succeeded at `ios/build/Quest-1.0-build5.xcarchive`, and deep/strict code-signature verification passed against the system trust store. Host app and notification extension are both **1.0 (5)**.
- Initial command-line `.ipa` export failed because this Mac has no local iOS Distribution identity. After the user authorized upload, Xcode Organizer's App Store Connect distribution flow successfully signed and uploaded **1.0 (5)**. Xcode displayed **App upload complete** and **Uploaded to Apple**, with build number **5** and upload time **1:13 PM**. No manual certificate/key creation or App Review submission was performed. Final App Store Connect processing/TestFlight availability has not been verified; the browser session required sign-in.
- Build/test/archive/export logs and visual evidence are in `test-results/app-store-polish/`. Updated review instructions are in `ios/AppStoreMetadata/review-notes.txt`; they have **not** been synchronized to App Store Connect.

Before submission, verify the latest build 6 finishes processing, select it in the draft, update the review notes, finish the store fields below, and complete physical-device acceptance. Existing screenshot/marketing exports have not been replaced in this pass.

Apple's current [review guidelines](https://developer.apple.com/app-store/review/guidelines/) require full review access and live backend services for account features. The demo is a public way to inspect sample behavior; it does not replace validation of real Apple sign-in, pushes, pairing, and account deletion. Follow Apple's demo-access instructions and discuss any review-access requirements with App Review.

## Saved in App Store Connect

App **6809939942**, bundle **com.kozr.quest**, primary locale **English (Canada)**, draft version **1.0**:

- Title: **Questline: IAP Notifications** (28 characters).
- Subtitle: **In App Purchase Notifiers** (25 characters).
- Primary category: **Developer Tools**.
- Description, keywords, promotional text, and review instructions saved from `ios/AppStoreMetadata/`.
- App Review first name, last name, phone, and email copied from Blind Box Tracker's current **4.0.1** draft at the owner's request. All four fields were read back and verified to match exactly. Private contact values are retained in App Store Connect, not this document.
- Age-rating questionnaire completed from the utility's actual content and features: **4+**.
- Four native screenshots uploaded and processed successfully, each **1320 × 2868**: activity, event detail, connected apps, and alert settings. Apple's API calls the display set `APP_IPHONE_67`; it accepted these 6.9-inch screenshots with no errors. Files are in `ios/AppStoreMetadata/en-CA/screenshots/iphone-6.9/`.

The public demo is available to all users from **Explore demo**, with clearly labeled sample data and temporary preferences. Review notes describe both the demo and real Apple sign-in, pairing, push, and account-deletion flows. No fake reviewer credentials or hidden authentication bypass were added.

## Previously uploaded build 4 and validation

- Display name **Questline**, native version **1.0 (4)**, matching notification-extension version. Bundle identifiers remain unchanged.
- Signed archive: `ios/build/Quest-1.0-build4.xcarchive`.
- Xcode's App Store Connect export/upload succeeded September 10 at approximately 12:41 Pacific. Apple finished processing the build with state **VALID**; build ID `3ee41da7-e5de-4dd1-9e45-3b889c6fb15d`. Non-exempt encryption is declared false because the app uses Apple's operating-system encryption only.
- Build **1.0 (4)** is selected in the draft version and is **IN_BETA_TESTING** for internal TestFlight. External beta remains **READY_FOR_BETA_SUBMISSION**; no external beta review was submitted.
- The earlier **0.1.0 (3)** build also finished TestFlight processing. The existing internal `devs` group showed one invite, one install, and one session. This does not establish physical Apple sign-in, push, or deletion success.
- **144 backend tests** pass, including same-account Apple revocation, nonce replay protection, failed revocation preserving the account, immediate access revocation, cross-account isolation, bounded data removal, status receipts, and retry after a cleanup failure.
- **19 native tests** pass on the dedicated iPhone 17 Pro Max/iOS 26.4 simulator. Release compilation, signed simulator launch, and archive succeeded. Fixed a demo-exit issue found by the native test and added readable app-artwork fallbacks.
- **26 browser checks** pass across desktop and mobile. The device suites now run separately so each gets a fresh test namespace and does not consume the other suite's sign-in rate-limit allowance. Production limits were not loosened.
- Native welcome, demo, event, app, and settings layouts were inspected. Privacy/support pages rendered correctly at 1440px and 390px without horizontal overflow. The design detector ran in degraded regex mode because its optional HTML parsers were unavailable; it did not evaluate computed contrast or replace the visual check.

## Implemented release fixes

- Native **Settings → Delete account** explains consequences and requires fresh confirmation with the same Apple Account.
- The API revokes Apple authorization before accepting cleanup, immediately invalidates service access, and removes account data with retryable batches. A minimal receipt lets the signed-out phone check completion when reopened. Pending requests do not expire silently.
- Privacy and support links are available before sign-in and in Settings.
- Policy/support pages describe the actual account, device, purchase-event, forwarding, retention, and deletion behavior. They are live at `https://quest-liart-iota.vercel.app/privacy/` and `/support/`, with the approved public email `eggheadlabs.dev@gmail.com`. Both URLs are saved in App Store Connect and live assets match the verified local build. The Vercel build refuses missing contact details.
- Production account-deletion cleanup/recovery, guarded delivery/cleanup workers, and API deployed successfully after explicit owner approval. All ten functions are ACTIVE and recovery runs every 30 minutes. Health/config and protected-route checks pass; no live account was deleted for testing.
- On September 11, created **Questline Sign in with Apple**, key ID **5KT3HJ52M5**, and configured it in Firebase project `the-app-quest`. Apple's saved key details show only Sign in with Apple for `ZMNPR5G4ZL.com.kozr.quest`. Firebase read-back confirms Apple enabled, native client ID/bundle ID `com.kozr.quest`, team `ZMNPR5G4ZL`, and the new key ID. The private key is stored in the Firebase Apple provider; the Downloads backup has user-only permissions. This is the standard Sign in with Apple key type. Native identity-token login did not need a developer private key; server-side authorization revocation does. No live user authorization was revoked during configuration.
- App Privacy disclosures are prepared in `ios/AppStoreMetadata/privacy-disclosures.md`. The questionnaire is partially saved with six data categories; add User ID and complete the purpose/linking/tracking questions for all seven. Browser control was interrupted while adding the last category. Nothing was published.

## Historical release gates before September 13 submission

1. **Finish App Privacy.** The public support email and URLs are saved/published, and all private App Review contact fields are saved and verified. The privacy questionnaire still needs its remaining category and purpose/linking/tracking answers.
2. **Finish App Store distribution fields.** Content-rights declaration and copyright are unset and availability is not configured. Confirm the price schedule, territory availability, and required business/trader details. The price schedule relationship exists, but its manual-price resource returned 404 and pricing is not verified. Do not submit a version with these fields unresolved.
3. **Physical-device acceptance.** The paired iPhone 15 Pro is now detected, but the Questline-only installed-version query stopped because the device is locked. Unlock it and use the final TestFlight candidate (build **1.0 (6)** after distribution) to verify Apple sign-in, computer pairing, camera/paste approval, APNs display/tap, and fresh Apple-confirmed deletion through completion using a disposable account. Confirm a real Apple-signed event reaches the feed, device, and a controlled forwarding receiver. Compilation and queue acceptance are not evidence of delivery or token revocation.

The September 13 submission record above supersedes these historical submission blockers. No public iOS release is claimed.

## Marketing posters — September 11, 2026

Four poster compositions are ready in `ios/AppStoreMetadata/marketing/exports/iphone-6.9/`, using the approved benefit headlines and original app screenshots. The user refined the brief to emphasize excitement. The current campaign uses **bright orange (`#F05A16`)**, reflected in the main exports, preview, and upload ZIP; charcoal remains available as a color study. All are opaque RGB PNGs at **1320 × 2868**. The editable HTML/CSS, earlier color studies, preview contact sheet, export manifest, and upload ZIP are in `ios/AppStoreMetadata/marketing/`. Re-render with `node scripts/render-app-store-posters.mjs`.

The set was visually reviewed and checked for image loading, headline fit, export dimensions, and PNG color format. These are **local deliverables, not yet uploaded to App Store Connect**; at that point, the four previously uploaded native screenshots remained the remote set. The subsequent campaign upload is recorded below.

## Sales campaign v2 upload — September 11, 2026

The user explicitly requested upload of the approved four-poster set. Uploaded opaque RGB **1320 × 2868** PNG derivatives from `ios/AppStoreMetadata/marketing/sales-campaign-v2/upload-iphone-6.9/` to app **6809939942**, draft **iOS 1.0**, **English (Canada)**, **iPhone 6.9-inch**. Media Manager was reloaded and all eight screenshots persisted in this order:

1. `01-your-next-sale.png`
2. `02-purchases-renewals-progress.png`
3. `03-all-your-apps.png`
4. `04-choose-your-sales-alerts.png`
5. Original `01-activity.png`
6. Original `02-event.png`
7. Original `03-apps.png`
8. Original `04-alerts.png`

The 6.5-inch set visibly inherits this order. Automatic approval review rejected deleting an existing screenshot as outside the upload request; the original activity screenshot removed before that rejection was restored from its local source, and all originals were retained after the posters. The campaign uses the approved illustrative concepts. Build **6** was observed selected in the draft during this upload task. No App Review submission was made.

## References

- [Apple: account deletion and Sign in with Apple token revocation](https://developer.apple.com/support/offering-account-deletion-in-your-app/).
- [Apple: app information and title/subtitle limits](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information/).
- [Apple: App Privacy definitions](https://developer.apple.com/app-store/app-privacy-details/).
- [Apple: uploading App Store assets](https://developer.apple.com/documentation/appstoreconnectapi/uploading-assets-to-app-store-connect).
- [Apple: App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/).
