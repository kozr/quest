# IAP Notifications

## Confirmed brief

- Audience: independent iOS developers.
- Product: a small hosted Apple IAP/subscription sales and refund notification service, configured in the browser, with a native iPhone alerting companion.
- No SDK required in the customer's app; coexist with RevenueCat via Apple's signed-notification forwarding.
- Current instruction: build the core MVP now; the user will supply design direction later.
- Sign in with Apple on mobile first; scan the QR displayed on the desktop and approve it on the phone. Apple is the only identity provider. The desktop has no separate credential login.

## MVP implementation choices

The user selected Firebase for the backend. The MVP uses Firebase Auth, Firestore, Cloud Functions and Cloud Tasks; Vercel serves the web UI. Native Apple sign-in replaces email/password; desktop continues using two-minute, single-use QR pairing. Conventional web forms/native SwiftUI lists, production/sandbox/demo separation and direct APNs delivery remain intentional. This pass proves the durable receive → activity → push loop, not branding or analytics.

## Explicitly deferred

Visual identity, automatic Apple URL configuration, in-app account deletion/Apple token revocation (a release prerequisite), public billing, historical imports and production deployment. Local demo activity is synthetic and must never look like verified Apple revenue or mark a connection verified.
