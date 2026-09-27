# Tavern publishing review — September 26, 2026

The pending 1.0.2 App Store description (en-CA) and App Review notes were updated and read back successfully. Both local English descriptions now include the Apple standard EULA, privacy URL, monthly/annual Marketing subscriptions, no free trial, free sales features, renewal/cancellation information, and one-app/three-app coverage. No App Review submission was made.

The corrected privacy policy is published at https://quest-liart-iota.vercel.app/privacy/. Deployment https://quest-osywwclu6-kozrs-projects.vercel.app changes only the policy from a snapshot of the existing production site. The other five public files were preserved byte-for-byte. EULA, support, and API health remain reachable.

## AI data-flow findings and changes

- Public App Store metadata goes to OpenAI for profile suggestions. Discovery uses app capabilities and communities; qualification uses profile text and public post text and up to two post images. Replies use app capabilities, goals, and the public post. Reply edits stay on-device.
- Market analysis formerly serialized entire stored source/problem records, despite narrower TypeScript annotations. That could include internal account/app linkage. Explicit field allowlists now remove that linkage and unnecessary author-name fields at the provider boundary; the cost estimator uses the same projection. Reply input also uses an explicit post-field allowlist.
- People detail extraction still intentionally processes public names, handles, links, and excerpts. Public content is not anonymous. Neither this change nor a Tavern user's permission establishes rights over another person's content.
- Profile confirmation now explicitly describes sharing with OpenAI; onboarding offers “Allow AI and continue” with the sales-only alternative. This is not a server-enforced consent migration for existing profiles. Public listing suggestions still run before profile confirmation. No claim is made that every possible personal-data input is detected, anonymized, or consent-gated.
- The policy describes web search, source evidence, OpenAI/Apify, AI fallibility, reply generation, and provider retention. `store:false` is not represented as zero retention.

## Native and privacy checks

- Existing paywall Terms, Privacy, Restore, full billing amount, renewal copy, and subscription-management actions retained. Added Terms of Use to Settings; benefits unchanged.
- Added PrivacyInfo.xcprivacy to the app resources. Declares app-local UserDefaults with CA92.1 and seven existing collected-data categories, linked to the account for app functionality, without tracking. Built Release app contains the parsed manifest as expected.
- Updated the App Privacy answer sheet for Marketing purchases and profile/research data. App Store Connect's privacy URL is correct. The published questionnaire itself still needs a current UI check; the answer sheet and manifest do not publish privacy labels.
- Account deletion includes fresh Apple authorization, revocation, account cleanup, and a notice that deleting the account does not cancel subscriptions. Restore uses AppStore.sync. Nine isolated emulator integration checks passed for account deletion and subscription behavior. These are not actual Apple Sandbox purchase/restore/renewal tests.
- Fourteen AI and billing unit checks passed, including a regression proving full database records cannot leak account linkage through Market AI payloads. TypeScript check and production Release simulator build passed. Mobile policy layout has no horizontal overflow.

## Remaining submission gates

1. Confirm the commercial/source rights for Reddit/Apify ingestion and retained public source content. No agreement was supplied or verified in this task. Reddit's Data API terms require a separate commercial-use agreement where they apply. Product Hunt's API is not used by this implementation; its API permission requirement must not be mistaken for proof that linked web excerpts are licensed. Show HN/Product Hunt are reference sources, not permission to reproduce arbitrary content. Do not claim ownership of third-party content in the App Store questionnaire without a basis.
2. Review moderation/reporting and the age-rating questionnaire against the actual public-discussion evidence shown in the app (Apple 1.2). Dismissal and links back to a source alone do not establish a complete report/block/filter system. This review did not certify that requirement.
3. Verify the published privacy questionnaire and whether the final personal-data processing requires additional server-enforced permission for existing users and scheduled jobs under 5.1.2. A policy or local confirmation alone is not blanket consent.
4. Exercise real Apple Sandbox purchases, restore, renewal, refund, and coverage changes against the release backend, and ensure App Review can access those features. Draft reviewer instructions are updated; successful fixture tests are not live acceptance.
5. Ship the native disclosures/manifest and backend payload allowlists. They are validated source changes, not included in a new uploaded archive or deployed backend yet. Build 33's earlier frozen source predates this pass and must be refreshed before archiving. Signing was previously blocked by the locked Mac.

## Primary references

- Apple review guidelines, including 1.2, 3.1.2, 5.1.1, 5.1.2, and 5.2.2: https://developer.apple.com/app-store/review/guidelines/
- Subscription disclosure and pricing: https://developer.apple.com/app-store/subscriptions/
- Standard EULA: https://developer.apple.com/help/app-store-connect/manage-app-information/provide-a-custom-license-agreement
- App privacy definitions (including generic free-form text as Other User Content): https://developer.apple.com/app-store/app-privacy-details/
- Required-reason APIs / CA92.1: https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype
- Reddit Data API terms: https://redditinc.com/policies/data-api-terms
- Product Hunt terms and API: https://www.producthunt.com/legal and https://api.producthunt.com/v2/docs
- Hacker News posting rules (including generated text): https://news.ycombinator.com/newsguidelines.html

Evidence is in test-results/publishing-review/. Initial tests without emulators and an initial Java 17 emulator attempt failed for environment setup; the final isolated Java 21 integration run passed. No full native XCTest suite or physical-device acceptance is claimed.
