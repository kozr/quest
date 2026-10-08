# Design QA — HearWhispers Review Desk

Date: October 7, 2026

final result: passed

## Visual target and scope

The user selected the third displayed generated design. Source of truth: `evidence/review-desk/selected-design.png`. Implemented the conversation queue above a source/context and draft workspace in the existing local dashboard. Production app code and hosting configuration were not changed.

Implementation URL: http://127.0.0.1:4173/#conversations

Source image: 1487 × 1058 pixels. Normalized to 1440 × 1024 for comparison, with only rounding-level aspect-ratio difference. Browser CSS viewport and screenshot: 1440 × 1024; screenshot density is one image pixel per CSS pixel. State: All active, both historical examples present, first conversation selected, blank draft, sidebar expanded, no toast or modal.

Final screenshot: `evidence/review-desk/desktop-final.png`.

Full-view comparison: `evidence/review-desk/comparison-final.jpg`.
Focused comparisons: `evidence/review-desk/comparison-detail.jpg` and `evidence/review-desk/comparison-colors.jpg`. Source is on the left; implementation is on the right. All were opened and inspected together.

## Findings and comparison history

1. Initial comparison: `evidence/review-desk/comparison-initial.jpg` with `desktop-initial.png`. P2: selected-row tint was more beige than the source, and the accent was browner. P2: smaller metadata and longer fit explanation weakened the selected hierarchy; quotation wrapped differently. The layout and familiar sidebar were already in place.
2. Corrected the background to nearly white, selection to rose-clay, accent to a restrained terracotta, increased body/metadata sizing, and used the selected design's concise fit explanation. `desktop-refined.png` records this iteration.
3. Limited the quote measure to 30ch to match the selected two-line wrapping. Recaptured `desktop-final.png`; inspected the full and focused comparisons. No actionable P0/P1/P2 issues remain.

## Required fidelity surfaces

- **Fonts and typography:** Existing locally served Geist Variable retained; browser confirmed this font. 32px page title, 23px section headings, 26px quote, 16px summary, 14px attribution. Clear hierarchy and readable secondary content. Generated-font raster details differ slightly from actual browser typography; minor P3 only.
- **Spacing and layout:** 240px official sidebar; compact two-row queue; source and drafting below a thin divider; large editable draft; primary source action at the foot of the source column. Everything fits at the reference desktop height. Minor vertical differences of roughly 20–30px from the generated mock are P3; main regions and all actions remain visible.
- **Colors and tokens:** Main surface `#FEFDFC`, sidebar `#F8F7F5`, selected row `#F4ECE9`, primary clay `#995C50`, primary text `#262523`, secondary text `#686661`. The input and table retain fine neutral borders. CSS-computed text contrast: white/primary button 5.25:1; secondary text/page 5.64:1; source metadata/selected row 5.26:1; main text/page 15.07:1. These are text checks, not a claim of complete accessibility compliance. Screenshot capture and generated-image color rendering introduce small visual variations; rendered CSS values are authoritative for contrast.
- **Image quality and assets:** No raster illustration is required by the selected design. Reused the existing Lucide icon set and existing brand mark; no new invented art or asset placeholders. The generated source is archived in the project.
- **Copy and content:** Exact product capitalization, authentic source authors, historical dates, quoted text and original links retained. The first fit explanation uses the selected concise wording without asserting buying intent. Historical-data disclosure is now at the top; the current displayed date is computed, not hardcoded. Device-only draft persistence remains explicit.

## Responsive and interaction verification

Evidence: `mobile-list.png` (390 × 844), `mobile-detail.png` (390px-wide full page), `mobile-320.png` (320 × 740).

- Desktop row selection updates the source, link and draft target.
- Draft editing enables copy; copy produces the success confirmation.
- Saved status and draft text persist through reload.
- Search returns the correct row; no-results state and View all active recovery work.
- Dismiss, Dismissed filtering, and Restore work.
- Mobile selection opens the readable source and stacked draft; All conversations returns focus to the selected row.
- Mobile sidebar opens; Add product opens the existing form; Cancel returns to the dashboard.
- At 390px and 320px, document scroll width equals viewport width. Desktop content fits 1440 × 1024.
- Test draft and review-state mutations were restored after verification.
- Browser warnings and errors: none in the inspected final session.
- Build: `npm run build` passed.

## Open questions and limits

No blocking design questions. This is a local preview with historical conversations and local storage. Live discovery, account persistence and external posting are not connected. No new product-form validation logic or backend behavior was introduced. This was a targeted browser and visual verification, not a full screen-reader audit.

## Implementation checklist

- [x] Archive the exact selected third design and record the decision in AGENTS.md.
- [x] Implement the queue and review workspace without replacing shadcn navigation.
- [x] Compare and correct color, type and layout differences.
- [x] Verify key interactions and responsive views.
- [x] Restore local test changes and capture final evidence.

## Follow-up polish

P3 only: generated typography and button widths have minor differences from the real Geist/shadcn components; the source image is not a pixel-exact browser specification. No additional changes are required for this preview.

Previous QA history is preserved in `evidence/review-desk/previous-design-qa.md`.
