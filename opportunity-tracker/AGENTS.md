# HearWhispers tracker UI

## Shared dashboard target — October 8, 2026

Read `../AGENTS.md` before continuing dashboard work. This is the canonical dashboard checkout. All dashboard chats share **http://127.0.0.1:50740/** for fixture review; ports 4322 and 4173 serve separate older development copies. Build and verify this checkout, and preserve other chats' scoped edits.

## Workspace startup — October 8, 2026

- The user subsequently selected the skeleton dashboard loading concept and asked for shadcn. Use the existing shadcn Skeleton component for a soft-gray sidebar, header, and source/draft placeholder shell, with the approved charcoal BrandIcon and one clear loading status. On phones, show the brand in the header and simplify to one placeholder pane. Hide placeholders from assistive technology and respect reduced motion. Keep startup errors in the compact centered brand layout with a clear retry action.

## Header hierarchy — October 8, 2026

- The header breadcrumb reads **[selected app] / [sidebar group] / [current tab]**, for example **Blind Box Tracker / HearWhispers / Potential customers**. Use ActOnWhispers for its tabs, and All products when that context is selected. Keep the app label synchronized with the product switcher.
- Keep the header compact: 56px high, 24px desktop side padding, and 8px gaps between controls and breadcrumb segments. Use 16px side padding and 6px breadcrumb gaps on phones.

## Sidebar placement — October 8, 2026

- Purpose views (Mentions, Potential customers, Feedback, Competitors) and Add/Manage purpose belong inside the existing **HearWhispers** sidebar group. Do not introduce a separate Purposes sidebar group.
- Use selected purposes as the inbox navigation; do not show Saved or an aggregate Conversations entry. HearWhispers contains only selected purposes and Add/Manage purpose. Keep product details behind the product selector, monitoring under Settings, and Patterns/Explore inside the relevant purpose. Preserve the product selector and Settings footer.
- Give each purpose its own route. Open the last selected enabled purpose by default, falling back to the first enabled purpose. Filter resets must stay within that purpose. Legacy #conversations links resolve to an enabled purpose.
- Keep **ActOnWhispers** separate, with Actions, Auto-draft replies, and Videos & captions.
- Conversation and purpose views share conversation identity, saved/dismissed status, notes, and manual drafts. Changing a view must not duplicate conversations or discard unsaved edits.
- The Conversations review layout uses a collapsible queue, source/draft panes, and visible action bars. Page-specific changes must preserve the shared sidebar.

## Approved brand icon — October 8, 2026

- The user selected the listening-bubble mark with two inner whisper curves and then chose charcoal. Use the shared `BrandIcon` component for dashboard branding, startup/error states and sign-in.
- The approved artwork is `ui/src/assets/hearwhispers-icon-charcoal.png`; its provenance sidecar records the built-in imagegen prompt. The favicon and Apple touch icon use the same artwork.
- Preserve the existing white, charcoal and soft-gray dashboard palette. The earlier clay exploration is superseded by the charcoal choice.

## Purpose-only navigation — October 8, 2026

- The user explicitly approved removing Products, Listening, Insights and Research as standalone destinations. This supersedes the earlier read-only overlap review.
- Preserve the collection/analysis APIs and saved results. Patterns must retain their source attribution and counts, and be supported by conversations matching the selected purpose. Explore is a separate web search: Feedback uses problems, Competitors uses alternatives, and Potential customers uses public people/need evidence. Do not present market research as brand-mention monitoring.
