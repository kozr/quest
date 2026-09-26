# Tavern 1.0.2 (31)

Restores consistent Activity, Leads, Market, Apps, and Settings headers after the build-26 design restoration reverted their alignment. Leads and Market use matching pickers and board margins. The existing artwork, paywall, and Market features remain.

This native release checkpoints the source already shipped in build 30, restores the verified header changes, and includes the subsequently committed paywall benefit labels and TestFlight purchase-gate/debug-toggle changes. Native app and notification extension build numbers are 31. The four configured subscription products retain their StoreKit identifiers and localized pricing.

Header validation: actual Release simulator build passed, plus 15 native captures across compact/large iPhones and accessibility text. Subsequent paywall changes passed 14 native billing tests and 8 backend billing tests in their task; combined signed archive validation is recorded in `test-results/build31-upload/`.

Paid Marketing stays locked without a verified purchase. Real Apple Sandbox checkout still requires coordinated backend billing configuration and lifecycle verification; this archive/upload does not enable server billing.

Pushed source commit `0dc2b77c803d918d08f42e231ca30eccf6b38ee1` to GitHub main and independently verified the remote ref before archiving. All 75 frozen native files match that commit exactly. Both app/extension signatures and versions, source hashes, and exclusion of debug preview launch flags passed.

Uploaded September 26, 2026 at **3:24 PM PDT**. Xcode confirmed **Upload succeeded** and **EXPORT SUCCEEDED**. Apple processing completed: **VALID**, build ID `d127172f-5f18-4345-9045-497ddf986446`.

Archive: `ios/build/Tavern-1.0.2-build31.xcarchive`. Evidence: `test-results/build31-upload/`. No App Review submission or backend billing activation was performed.
