# IAP Notifications

## Confirmed brief

- Audience: independent iOS developers.
- Product: a small hosted Apple IAP/subscription sales and refund notification service, configured in the browser, with a native iPhone alerting companion.
- No SDK required in the customer's app; coexist with RevenueCat via Apple's signed-notification forwarding.
- Current instruction: build the core MVP now; the user will supply design direction later.
- Sign in on mobile first; scan the QR displayed on the desktop and approve it on the phone. The desktop must not require a second email/password login.

## MVP implementation choices

These are implementation assumptions, not new user requirements: mobile email/password auth until Apple sign-in is configured, two-minute single-use QR desktop pairing with explicit phone approval (email fallback remains available), a single Node process with SQLite for easy local execution, conventional web forms/native SwiftUI lists, production/sandbox/demo separation, and APNs as the push transport. The purpose of this pass is to prove a safe, durable receive → activity → push loop, not branding or analytics.

## Explicitly deferred

Visual identity, automatic Apple URL configuration, Sign in with Apple, account recovery/email delivery, public billing, historical imports and production deployment. Local demo activity is synthetic and must never look like verified Apple revenue or mark a connection verified.
