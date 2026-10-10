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


## HearWhispers Firebase deployed; Google origin registration pending — October 9, 2026

- This supersedes the prepared migration's pending-approval / not-deployed status. The user explicitly replied **yes** to the specific isolated site/API/private worker, existing APIFY_TOKEN/SCRAPEBADGER_API_KEY and Google OPENAI_API_KEY sources, new HEARWHISPERS_RUNTIME_CONFIG destination, runtime service-account secret access/private-worker invocation, and two new Google origins. Approved provisioning and deployments succeeded; no additional credential source/recipient change is authorized by this note.
- Production Firebase site: **https://hearwhispers-dashboard.web.app/**, project `the-app-quest`, isolated site `hearwhispers-dashboard`. New gen2 functions in `us-central1`: API revision `hearwhispers-api-00001-niq` and private worker `hearwhispers-worker-00001-not`, runtime identity `vercel-opportunity-tracker@the-app-quest.iam.gserviceaccount.com`, pinned secret `HEARWHISPERS_RUNTIME_CONFIG:1`. Hosting version `sites/hearwhispers-dashboard/versions/4b8d5531200b9ca4` was published at `2026-10-10T01:06:20.901Z`. Use scoped function deploys and this isolated Hosting site; do not run a root Firebase deploy or replace Quest/default Hosting/OVH services.
- Scoped Firebase runtime commit `0b40ca8a6df429076ac3f52209dde233e0caee00` and Hosting-cache/documentation commit `c4470fa8e5c2778516d8f66c1394ecd08e88d10d` are verified on GitHub `kozr/quest` main, based on pagination release `76d886a4`. Runtime fingerprint remains `2ac3773d542525967f9d7cbff08902f4911f95ac0183a0d24c3fc47ba6239dab`. Current HTML and referenced `index-Ky4jyANN.js` / `index-5BsPxnIJ.css` match the tested package. The legacy Vercel URL remains separate; Git push does not prove its serving restriction resolved.
- At `2026-10-10T01:07:16.736Z`, the Firebase login route returned 200 with secure HttpOnly Strict `__session`; unauthenticated data returned 401 and foreign-origin login returned 403. The worker has no public IAM binding, rejects unauthenticated invocation with 403, and an authenticated status-only call confirmed existing records at revision 8141. Existing 21 gen2 Quest functions, six scheduler jobs and default Hosting releases match the recorded baseline.
- **Google sign-in and authenticated HTTP pagination remain unverified.** Google rejects the new origin, and both client-settings views failed to load in the connected browser. The user was asked to add `https://hearwhispers-dashboard.web.app` and `https://hearwhispers-dashboard.firebaseapp.com` to the existing client `539152982713-8hprmeloailnkajhpp1c91lvklv2p70g.apps.googleusercontent.com`, preserving prior origins. Readiness is not authenticated application availability. No scheduled collection/AI worker is enabled; the guarded `enable-scheduler.mjs` awaits real sign-in and pagination verification. Existing authorization permits completing these exact settings and the private schedule after verification without another permission request.
- Read-only current-manifest verification confirmed 1,713 retained sources, 13 exact mentions (11 BBT / two Wren), five-node summary and distinct first/next five-row pages with entity identity evidence. No database import, manifest CAS, queue/receipt/lease reset, historical allowance, paid provider dispatch or budget increase occurred. Preserve the `opportunity-tracker` database / `personal` record manifest and `TRACKER_RECORD_STORAGE_ENABLED=true`; all prior cumulative and daily caps remain.
- Full isolated suite: 522 passed, zero failed, 12 existing emulator skips; canonical focused checks: 47 passed, three existing emulator skips; isolated canonical build and actual Functions Framework route verification passed. Unpublished canonical UI/account/video/outreach changes, served public assets and shared preview 50740 were preserved. Canonical checkout remains on its older base with pending work; reconcile current main before the next release.
- Evidence and pending work: original-workspace `implementation/hearwhispers-firebase-2026-10-09/FIREBASE_MIGRATION.md`, deployment/verification JSON records and source manifest. No manual paid runner or extra schedule is active.
