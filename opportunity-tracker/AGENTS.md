# HearWhispers tracker UI

## Shared dashboard target — October 8, 2026

Read `../AGENTS.md` before continuing dashboard work. This is the canonical dashboard checkout. All dashboard chats share **http://127.0.0.1:50740/** for fixture review; ports 4322 and 4173 serve separate older development copies. Build and verify this checkout, and preserve other chats' scoped edits.

## Workspace startup — October 8, 2026

- Keep the existing sidebar, product selector, navigation groups, pinned Settings, header breadcrumbs, and toolbar in the loading shell. The user explicitly rejected removing that chrome. Only the main loading content is a single skeleton list; place its status near the top and fill the available height. Hide placeholders from assistive technology, respect reduced motion, and retain compact error/retry behavior. Do not alter the loaded dashboard layout for a loading-screen request.

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


## Database pagination — October 9, 2026

- Startup and background polls request `/api/state?light=1`; rich tool data loads on demand. Conversation pagination reads a compact filter index and selected immutable row payloads, preserving full source text, review identities, notes and drafts. Exact entity mentions remain separate from keyword matches.
- Optional derived read views bind to the current primary root and publish in the same manifest CAS. Raw records, writer integrity, queues, receipts, leases and budgets are unchanged. Missing views use the authoritative full reader; mismatched roots or corrupt nodes fail closed. Account workspaces never use the private read views. Normal writes rebuild projections; an initial projection refresh must read live data and preserve the primary root, never import a stale local snapshot.
- Keep clock-sensitive budget days, monthly periods, schedule and review-lease expiry evaluated at request time. Background polls coalesce pending requests; a post-save manual refresh invalidates the pre-save request. Cloud record reads batch up to 128 and share in-flight immutable reads.
