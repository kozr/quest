# Tavern 1.0.2 (33)

Fixes interrupted Leads and Market requests displaying cancellation errors, preserves loaded results, and allows fresh requests to replace cancelled work. The paywall sky extends with the navy strip during pull-down and returns with it. Subscription cards keep equal widths when switching between one app and up to three apps. The annual savings chip uses localized StoreKit prices. Benefits content and styling remain unchanged.

Both app and notification extension use build 33. Validation: production Release simulator and isolated Debug preview builds passed. Seven targeted loading regression methods passed 41 assertions in an isolated simulator harness. XCTest targets compiled, but the runner stalled at readiness; no full-suite pass is claimed. Native compact, large, and accessibility previews covered scrolling, pull-down, return, and both subscription tiers. Evidence: `test-results/marketing-loading-bounce/`.

Signed archive and upload evidence will be recorded in `test-results/build33-upload/`.

Publishing follow-up adds a Settings EULA link, clearer AI profile-sharing disclosure, and a bundled privacy manifest. See publishing-readiness-2026-09-26.md. The first archive attempt failed at code signing while the Mac was locked; refresh the frozen source before retrying. No build 33 upload is claimed.
