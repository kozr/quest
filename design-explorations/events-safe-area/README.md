# Events and Trials top spacing

Events and Trials previously added an 80-point scenic-header spacer below the native navigation bar. Both now request 16 points from the same Activity header component. The system continues to own the status-bar safe area and native back bar; no negative content offsets or ignored control safe areas were added. Other scenic headers retain their existing spacing.

Validation: the isolated Debug simulator app compiled successfully. Default and accessibility-3 captures were inspected on the 375 × 667-point iPhone simulator. The page headings and Events/Trials selector align between both screens. Runtime checks passed in both text sizes for the visible native back bar, two-controller back stack, enabled swipe-back gesture, and unchanged queued sales.

Captures: [default](default.png) and [accessibility](accessibility.png); per-page screenshots and check results are in their corresponding folders. These captures include the concurrent local typography updates; the production-source change committed here is limited to top spacing.

Reproduce with `python3 design-explorations/events-safe-area/create-preview.py`, build the generated `ios/build/events-safe-area-preview-src/IAPNotifications.xcodeproj`, and launch `com.kozr.quest.eventsinsetpreview`. Append `--large-text` for accessibility text. The demo automatically opens Events then Trials and writes captures/checks to its `tmp/events-safe-area` directory. No upload or deployment was performed.
