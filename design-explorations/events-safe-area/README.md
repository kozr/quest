# Events and Trials top spacing

Events and Trials previously added an 80-point scenic-header spacer below the native navigation bar. Both now request 16 points from the same Activity header component. The landscape is now a shared full-screen background that extends behind the status bar and native back button. The navigation bar background is transparent, so no navy strip remains at the top. Only the decorative background ignores the safe area; controls and scrolling content retain the system insets. Other scenic headers retain their existing layout.

Validation: the isolated Debug simulator app compiled successfully. Default and accessibility-3 captures were inspected on the 375 × 667-point iPhone simulator. The page headings and Events/Trials selector align between both screens. Runtime checks passed in both text sizes for the visible native back bar, two-controller back stack, enabled swipe-back gesture, and unchanged queued sales.

Captures: [default](default.png) and [accessibility](accessibility.png); per-page screenshots and check results are in their corresponding folders. These captures include the concurrent local typography updates; the production-source change committed here is limited to top spacing and the full-screen decorative background.

Reproduce with `python3 design-explorations/events-safe-area/create-preview.py`, build the generated `ios/build/events-safe-area-preview-src/IAPNotifications.xcodeproj`, and launch `com.kozr.quest.eventsinsetpreview`. Append `--large-text` for accessibility text. The demo automatically opens Events then Trials and writes captures/checks to its `tmp/events-safe-area` directory. No upload or deployment was performed.
