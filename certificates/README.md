# Apple signature trust anchors

Run `npm run certificates` before accepting Apple notifications. It downloads the
three **public** Apple root certificates from fixed official Apple PKI URLs, checks
they are valid self-signed CA certificates, and prints their SHA-256 fingerprints.
It does not fetch, require, or create a private App Store Connect key.

Expected files in this directory:

- `AppleIncRootCertificate.cer`
- `AppleRootCA-G2.cer`
- `AppleRootCA-G3.cer`

Set `APPLE_ROOT_CERTS_DIR` to use a different absolute directory at runtime and when
running the download script. The script refuses to overwrite a different existing
certificate; review an Apple root rotation deliberately. The server reads these
files and always enables Apple's online revocation/expiry checks. If roots are
missing or online verification temporarily fails, webhooks fail with HTTP 503 so
production delivery can be retried. Signature/app/environment failures are HTTP
400. Do not disable signature checks to make local webhook tests pass; use the
authenticated, explicitly labelled Demo endpoint instead.

Verification covers the notification and its nested transaction/renewal payloads.
The production app ID, bundle ID, and environment must match the saved connection.
Sandbox can omit the App Store ID, but a supplied mismatching ID is rejected.

Sources:

- [Apple PKI roots](https://www.apple.com/certificateauthority/)
- [Apple server library verification](https://github.com/apple/app-store-server-library-node#verification-usage)
- [Apple transaction price semantics](https://developer.apple.com/documentation/appstoreservernotifications/price)
- [Partial refund percentages](https://developer.apple.com/documentation/appstoreservernotifications/revocationpercentage)

Money is stored as integer milliunits in the original currency. Transaction prices
already include consumable quantities. Unknown refund/reversal amounts stay null,
and gross sales are not net proceeds or financial reports.
