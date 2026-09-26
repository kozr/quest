# Tavern 1.0.2 (31)

Restores consistent Activity, Leads, Market, Apps, and Settings headers after the build-26 design restoration reverted their alignment. Leads and Market use matching pickers and board margins. The existing artwork, paywall, and Market features remain.

This native release checkpoints the source already shipped in build 30, restores the verified header changes, and includes the subsequently committed paywall benefit labels and TestFlight purchase-gate/debug-toggle changes. Native app and notification extension build numbers are 31. The four configured subscription products retain their StoreKit identifiers and localized pricing.

Header validation: actual Release simulator build passed, plus 15 native captures across compact/large iPhones and accessibility text. Subsequent paywall changes passed 14 native billing tests and 8 backend billing tests in their task; combined signed archive validation is recorded in `test-results/build31-upload/`.

Paid Marketing stays locked without a verified purchase. Real Apple Sandbox checkout still requires coordinated backend billing configuration and lifecycle verification; this archive/upload does not enable server billing.

Status: prepared for main push, signed archive, and App Store Connect upload. Final upload and processing evidence will be saved under `test-results/build31-upload/`.
