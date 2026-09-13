# Questline App Store posters

Four English marketing posters, exported as **1320 × 2868 opaque RGB PNGs** for the existing 6.9-inch screenshot set.

**Current direction: bright orange (`#F05A16`).** The user refined the brief to emphasize excitement. The main exports, preview, and upload ZIP now use bright orange with white and pale-yellow headlines and neutral phone frames.

1. Purchase notifications. In real time.
2. Every purchase. Every renewal.
3. All your apps. One activity feed.
4. Choose what deserves an alert.

Upload the four numbered files from `exports/iphone-6.9/` in that order. `questline-app-store-posters.zip` contains only those four upload images. `preview.png` is a contact sheet for review, not an upload asset.

## Sources and editing

### Lock-screen notification concept

`lockscreen-poster.html` and `lockscreen-poster-concept.png` show an optional lead poster with six sample purchase/renewal alerts. `lockscreen-poster-preview.png` is its smaller review image. The 1320 × 2868 poster uses the existing orange layout and a built-in image_gen lock-screen mockup in `assets/lockscreen-notifications-mockup.png`; its exact prompt is in `lockscreen-prompt.txt`. It is explicitly labeled as a mockup. Notification titles, environment prefixes, and amount formatting follow `src/apns.ts` and `src/normalize.ts`.

This is an illustrative marketing concept, not an authentic iOS screenshot or evidence of APNs delivery. It remains separate from the four-image upload ZIP. A real simulator capture was attempted: the current app built and installed and simctl accepted a sample push, but lock-screen UI control could not be completed reliably. No production notifications were sent. Regenerate the composition with `node scripts/render-lockscreen-poster.mjs`.

### Color studies

`color-options.html` compares green (`#087F5B`), orange (`#F05A16`), and charcoal (`#222428`) using the same first-poster layout and simpler backgrounds. Click a poster to see its complete four-poster campaign. `color-comparison.png` is the side-by-side preview. Each option has four full-size 1320 × 2868 RGB PNGs in `color-options/<color>/`.

These variants use editable CSS colors with a subtle light treatment, neutral device frames, and the unchanged original screen images. Re-render the studies with `node scripts/render-app-store-colors.mjs`. The original cobalt design remains accessible at `posters.html?theme=cobalt`; the main upload ZIP now contains the current orange set.

### Campaign sources

- Editable composition: `posters.html`. The brand, typography, device framing, image crops, and placement are authored in HTML/CSS.
- Original app captures: `../en-CA/screenshots/iphone-6.9/`. These remain unchanged. The enlarged purchase and renewal cards are crops of the original activity capture. All sample data and demo notices remain accurately identified.
- Current background: bright orange CSS with a subtle light treatment. The earlier cobalt study uses `assets/cobalt-pulse.png`, generated with the built-in image_gen tool; its prompt is preserved in `background-prompt.txt`. No generated app UI is used.
- App icon: the established white Q mark on matching orange (`#F05A16`), updated in the native asset catalog. The 1024 × 1024 opaque PNG uses an explicit sRGB profile. Regenerate with `swift scripts/make-beta-icon.swift ios/IAPNotifications/Assets.xcassets/AppIcon.appiconset/AppIcon.png`. `logo-preview.png` shows the icon and wordmark. The icon is a local source change and will require a new iOS build to reach installed apps or App Store Connect.

Re-render from the repository root with `node scripts/render-app-store-posters.mjs`. Uses the existing Playwright package and installed Google Chrome in a temporary headless profile. No network connection or signed-in browser profile is needed.

The renderer verifies image loading, title width, and canvas dimensions, then creates the four exports, contact sheet, and manifest. The full set was visually reviewed together for typography, image crops, and consistent composition. PNG headers were checked for dimensions and RGB format.

Created September 11, 2026. **These posters have not been uploaded to App Store Connect.** The previously uploaded native captures remain the current remote set.
