# Tavern 1.0.2 (32)

Fixes the paywall artwork separating at the top when scrolling: one continuous fixed header spans the safe area, while benefits scroll underneath. The close action stays visible. Changes the benefit label to “Latest market news” and explicitly preserves dark appearance for Settings so its native form text stays legible on navy.

Both app and notification extension use build 32. No billing logic or product pricing changed. Validation: Debug preview and production Release simulator builds passed; compact and large iPhones reviewed at initial, scrolled, and overscroll positions, including accessibility text. Settings was verified under an inherited light appearance. Evidence: `test-results/paywall-top-fix/`.

Signed archive and upload evidence: `test-results/build32-upload/`. Release status will be recorded after upload verification.
