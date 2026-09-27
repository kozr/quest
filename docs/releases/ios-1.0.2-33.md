# Tavern 1.0.2 (33)

Fixes interrupted Leads and Market requests displaying cancellation errors, preserves loaded results, and allows fresh requests to replace cancelled work. The paywall sky extends with the navy strip during pull-down and returns with it. Subscription cards keep equal widths when switching between one app and up to three apps. The annual savings chip uses localized StoreKit prices. Benefits content and styling remain unchanged.

Both app and notification extension use build 33. Validation: production Release simulator and isolated Debug preview builds passed. Seven targeted loading regression methods passed 41 assertions in an isolated simulator harness. XCTest targets compiled, but the runner stalled at readiness; no full-suite pass is claimed. Native compact, large, and accessibility previews covered scrolling, pull-down, return, and both subscription tiers. Evidence: `test-results/marketing-loading-bounce/`.

Signed archive and upload evidence is recorded in `test-results/build33-upload/`.

Publishing follow-up adds a Settings EULA link, clearer AI profile-sharing disclosure, and a bundled privacy manifest. See publishing-readiness-2026-09-26.md. The archive was refreshed from main commit `6b5dad8fec3b295c6e3ddc9b0400eba367344392`; all 76 native files, both signatures, and the bundled privacy manifest passed verification. Xcode confirmed **Upload succeeded** and **EXPORT SUCCEEDED** on September 27, 2026 at **12:38 AM PDT**. Apple processing is **VALID**, build ID `5b477a20-9366-480a-96b0-7cd225df6b60`. An earlier network-route failure was resolved by a clean upload retry. No App Review submission or backend deployment was performed.
