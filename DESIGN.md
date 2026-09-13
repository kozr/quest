# IAP Notifications — iPhone design

A restrained, professional native iPhone app for sales and refund notifications.

- Use San Francisco through semantic SwiftUI text styles, supporting Dynamic Type.
- Use native Activity, Apps, and Settings tabs, large navigation titles, inset grouped lists, and Forms.
- Use adaptive system backgrounds, secondary labels, and one system blue action tint. Preserve native red destructive actions.
- Activity uses calendar-day sections and app artwork with neutral fallbacks. App names and tabular transaction amounts share the first line; event titles, details, and times follow. Accessibility text sizes stack artwork above content, cap artwork at 64 points, and allow full multiline descriptions. The selected Demo/Sandbox environment has an explicit non-sales notice. Offline demo mode stays on sample activity without live environment filters and uses a shared Demo mode notice.
- Event details emphasize the transaction amount and retain Apple metadata in a separate section.
- Connected apps show app name, bundle ID, and a written connection status. Green supplements the Connected label.
- Add app offers **On a computer — Recommended** and **On this iPhone**, with a clear forward affordance on both. Computer setup is numbered: share/open the dashboard, then scan its sign-in QR. Keep the raw address behind a disclosure. Mobile replaces the chooser within the same sheet, preserves sign-in, and uses Close for dismissal. The web flow is **Find → Confirm → Connect**: one search field first, app identity confirmation with optional editing second, and Apple/RevenueCat connection choice third. External shortcuts, clipboard paste, and unpublished-app entry live under “Can’t find your app?”. Keep native app details focused on provider shortcuts and recent connection status; refresh native data on return.
- The welcome screen uses a concise introduction, Apple's native sign-in button, and a prominent offline demo action. It has no server configuration or connection diagnostics. Both actions share restrained rounded corners; the Apple button adapts to light and dark appearances.
- Keep platform navigation, SF Symbols, standard controls, and accessible touch targets. No custom fonts, gradients, or decorative animation.

Scope: native iPhone app. Web styling is outside this design pass. The approved concept is the three-screen Activity, Apps, and Settings mockup. Keep all existing individual alert preferences, even where the concept abbreviated them.
