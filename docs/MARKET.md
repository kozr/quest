# Market insights: API and operations

Market reports source-backed product problems, alternative-product complaints, and workarounds. It is a market research feature, not a Lead qualification alias. It keeps evidence that is useful even when an author is not a prospect, counts people and conversations in code, and never contacts an author.

## Access and configuration

Production Market is enabled for all signed-in accounts. New scans use Luna Max web research across Reddit and the wider public web, including historical discussions with no publication-date cutoff. The API requires all of the following:

- `MARKET_ENABLED=true`.
- `REDDIT_MONITORING_ENABLED=true` and the existing Reddit beta access (`REDDIT_PUBLIC_ACCESS=true` or the account's ID in `REDDIT_BETA_USER_IDS`).
- An owned active app and its confirmed, current Lead profile. Market reads the profile's problems, capabilities, communities, and keywords but does not change Lead selection or profile state.
- For scan creation, `MARKET_AI_ENABLED=true`, a configured supported `LEADS_MODEL_ID`, positive `LEADS_INPUT_PRICE_CEILING_USD_PER_MILLION` and `LEADS_OUTPUT_PRICE_CEILING_USD_PER_MILLION`, and provider credentials.

Keep `APIFY_TOKEN`, `OPENAI_API_KEY`, and `MARKET_CURSOR_SECRET` in Firebase Secret Manager. The cursor secret must be high entropy and at least 32 characters. The API binds Apify and the cursor secret only when `MARKET_ENABLED` is true, and binds OpenAI only when the Market AI gate is also true. `processMarketScan` binds Apify and conditionally OpenAI under the same gates. Those feature values are evaluated when functions are defined/deployed; deploy the affected functions after changing a gate so the appropriate secret bindings are present. No provider secret belongs in the iOS client or a checked-in environment file.

Market's AI calls share `lead_ai_budgets` with Leads and use the same model allow-list, price ceilings, global cap, and account cap. Code defaults are $5 global and $1 per account per UTC month; production uses the user-approved $2 per-account cap as of September 25, 2026, overridden by the existing `LEADS_AI_GLOBAL_CAP_USD` and `LEADS_AI_ACCOUNT_CAP_USD`. Reddit collection uses the existing `reddit_budgets` monthly account-wide cap (`REDDIT_MONTHLY_BUDGET_USD`, default $15). A Market request does not create a separate budget. Each Apify start reserves at most $0.50; uncertain starts are settled conservatively and never repeated blindly. Shared provider pause state blocks new paid calls.

## Web research scans

New scans begin with the Responses API `web_search` tool, required at `reasoning.effort=max`. Research searches across the wider web with no Reddit-only domain filter or recent-date restriction. It returns up to six early findings, each with one to five citations verified against the search tool's returned sources. Equivalent public URL aliases are matched back to the exact searched link. A finding with any unverified citation is excluded, while other fully cited findings can survive; an entirely unverified response fails. Findings are summaries, not exact quotations or verified people counts; they are displayed separately from collected Reddit evidence. People counts and conversation counts are never invented. A successful search with no findings is distinct from a scan that never ran or failed.

Research requests a three-tool-call limit and 64,000 output tokens. The provider has returned four searches for that limit, so reservations include one additional in-flight search/context. Every returned search is charged; the final reported dollar cost must fit the reservation before findings can be saved. A cost overrun fails the scan and pauses further paid work. Reservations remain within the shared account/global caps. An uncertain dispatched call is settled conservatively and not blindly replayed. The provider deadline is 420 seconds; the worker and task deadline are 480 seconds. Provider responses that include usage settle the reported cost even when the output is incomplete or invalid. Research lives in the existing owner/profile-scoped Market snapshot with the existing 30-day retention and deletion behavior. That retention concerns the research cache, not the publication age of linked pages.

Existing queued collector scans retain their legacy path. Completed or interrupted runs with usable validated source rows can be analyzed with partial coverage. Interrupted runs with no usable evidence remain failures. Legacy source analysis also uses maximum reasoning.

## Legacy collection and retention

Each scan covers at most 30 days. It requests up to 100 search posts, then selects no more than eight relevant threads and requests up to ten comments per selected thread. Search and comment collection are separate durable steps. A source run is checkpointed before polling; an ambiguous paid start is fenced rather than issued a second time. Coverage remains partial when provider/model bounds truncate input. A post and its comments represent one conversation; only stable known author identities contribute to distinct-person counts. A group is labeled recurring only with at least two distinct known authors.

Public normalized Reddit posts and comments live in `market_sources`, shared as source cache. Observations, canonical problems, scans, reservation records, snapshots, cursors' snapshot heads, and app/account indexing are kept in dedicated collections. User/app-specific records are private and removed by the explicit app/account deletion paths. The source and associated analysis use a 30-day retention window; Firestore TTL is eventual cleanup, while API reads synchronously reject expired sources, changed content, and invalid snapshots.

Open AI and Reddit reservation rows intentionally omit `expireAt`. Settlement writes an expiry timestamp, preventing TTL from erasing an unresolved charge before recovery or deletion can account for it. The five-minute recovery schedule fences expired scans and settles orphaned reservations. App/account deletion performs the same fence and settlement before purging scoped data. Shared `market_sources` rows are not purged with one account because other users may use the public cache.

## Firestore configuration

`firestore.indexes.json` declares the two compound indexes used by Market scan recovery:

- `market_scans`: `state ASC`, `nextAttemptAt ASC` for due work.
- `market_scans`: `state ASC`, `expireAt ASC` for expired work.

The same file declares TTL on `expireAt` for `market_sources`, `market_observations`, `market_problems`, `market_snapshots`, `market_snapshot_heads`, `market_scans`, `market_scan_keys`, `market_scan_heads`, `market_ai_reservations`, and `market_collection_reservations`. Deploy the indexes and wait for them to be READY; enable/verify TTL policies are ACTIVE. Local emulator tests do not prove production index readiness or TTL activation.

## API behavior

All endpoints are authenticated and app-owner scoped. Full request/response fields are in [API.md](API.md#market-insights-beta).

- `GET /api/apps/:appId/market` returns the latest valid snapshot and scan state, or a valid empty overview before the first scan.
- `GET /api/apps/:appId/market/people` returns bounded distinct-author pages. The cursor is HMAC-signed and bound to user, app, profile revision, snapshot, and optional problem filter. Continue a page sequence with its returned `snapshotId`; a replaced/expired snapshot returns `STALE_SNAPSHOT`.
- `POST /api/apps/:appId/market/scan` takes the confirmed profile revision and UUID idempotency key. Repeated keys are stable; concurrent requests for an app/revision coalesce.
- `GET /api/apps/:appId/market/scans/:scanId` returns a plain scan status DTO for lifecycle-bound polling.

Quotes must be exact substrings of the validated source. Permalinks are checked against native Reddit post/comment identities. `isSample:false` is explicit in live DTOs; offline examples are used only in demo/preview mode. Feature or provider unavailability never silently falls back to samples.

## Rollout boundary

Production release evidence and current deployment revisions are recorded in `docs/FIREBASE.md`. The new native research view includes source links and an animated progress indicator. Build and upload status is recorded in `docs/APP_STORE.md`.

## Public authors and YouTube discovery — September 25, 2026

Research explicitly targets Reddit, public X posts, YouTube videos, forums and reviews. It proposes at most four author/channel candidates using original source links and existing app capability IDs. A candidate must link to a searched URL and then pass a separate, bounded public-platform lookup. Reddit post/comment JSON verifies the author and excerpt; X public embeds verify author attribution and the original post excerpt. YouTube public video metadata verifies the channel and title only. Video metadata can create a creator-partner candidate, never a claim about personal need or a transcript quote. Inaccessible, deleted, mismatched, unsupported or unverified candidates are omitted. A separate fallback checks at most four searched YouTube videos: verified title metadata must overlap at least two meaningful capability words before a review-only creator record can be saved. This fallback does not depend on model-proposed author fields and does not infer a personal need.

Records store a stable platform/profile/relationship ID, platform, public handle, display name, public profile URL, potential-user versus creator-partner relationship, initial `needs_review` status, expressed problem or creator topic, app-fit explanation, matching capability IDs, and evidence (original URL, title, short verified excerpt, publication date when available, verification time and method). App fit is a research suggestion, not confirmed purchase intent. No inferred private identity, email, sensitive attributes, or follower counts are collected. Unknown publication dates stay null.

Records are stored inside the existing owner/app/profile-scoped research snapshot, with its 30-day retention and account/app deletion behavior. The same author is deduplicated within a scan, and its ID is stable across scans for the same app. This is a discovery record, not a permanent CRM or outreach log; no contact or message is sent. People supports existing ownership checks, snapshot cursors, and problem filtering. The native cards show the relationship and verification scope and link to the public profile and original post/video.


### Web-search People discovery (local implementation, September 25)

Research candidates now use the cited web-search sources directly. The model returns public identity fields only when exposed in search/opened source content; unavailable identities stay unknown. Source URL membership and capability IDs remain checked. New evidence uses `verification: web_search` and the native card says “Found in web search · not independently verified.” The legacy `verifiedAt` field records processing time for these rows, not independent verification. No direct Reddit JSON/X embed/YouTube metadata request is made by the research path. The automatic keyword-only creator fallback is no longer invoked. The tested refined People instructions are used with separate potential-user and creator criteria. Existing stored records retain their original verification labels.

This change has not been deployed or shipped in the native app.

### Sol assessment / Luna details pipeline (local implementation)

Set `MARKET_RESEARCH_PIPELINE=sol-luna` to enable the split in the configured Market provider. Sol (`gpt-6-sol`, high) performs web search, chooses and orders candidates, and writes fit assessments. Luna (`gpt-6-luna`, max) makes one tool-free extraction call over the source evidence passed by Sol. It cannot change fit, relationship, source URLs, capability matches, or ordering. Extracted non-null details must occur verbatim in the supplied evidence; missing fields stay unknown. No direct platform fetch is required. This remains model-reported web evidence, not independently verified identity.

The output ceiling is twenty People candidates rather than four; these are not quotas. Search-call limits remain bounded at three requested calls with a fourth reserved for the provider's extra in-flight search. Raising candidate capacity alone does not guarantee broader coverage.

The Market settings pin Sol pricing independently of Leads at conservative $2.50/M input and $10/M output. The existing shared monthly account/global caps are preserved. Reservation includes $0.06 for Luna; settlement adds Luna's reported token cost at $0.125/M input and $0.50/M output. Unknown extraction outcomes charge that reserved amount and retain Sol candidates with unknown details, without retrying the paid call. Sol is bounded to 300 seconds and Luna to 120 seconds within the existing 480-second worker allowance. Empty candidate lists skip Luna.

The example configuration enables this path when copied; existing deployed environments remain unchanged until explicitly rolled out with the flag. No new paid trial or production deployment was performed for this implementation.

### Deployment update — September 25

The split pipeline and web-search discovery are now live on the API and Market worker. This supersedes the earlier local-only notes above. The live Market functions use the approved $4 account and unchanged $5 global caps. Native label changes have not been distributed. No paid production smoke scan was run; see `test-results/market-split-release/health.json`, per-function `final.json`, and `budget-check.json` for verification and current reservation headroom.

### Owner-only Market cap override — September 25

`processmarketscan-00018-hug` supports admin-only `market_account_limits/{sha256(userId)}` records with a positive integer `capMicroUsd`. Overrides apply only to Market's reservation for the matching account; other accounts retain the environment default. The effective override is bounded by the unchanged global cap. Invalid values fall back to the default. Shared spending/reservation counters are never reset by a limit update.

The owner's account is approved for $5/month for Market; the Market default remains $4 and the shared global ceiling remains $5. Leads worker defaults remain unchanged. Account-scoping, invalid overrides, global exhaustion, and cost settlement passed 16 isolated worker tests. Release evidence and current headroom: `test-results/market-account-cap-release/account-limit.json`. No paid scan was started by this change.

### Problems / Landscape / People — local implementation, September 25

The native Market switcher now contains Problems, Landscape, and People. Landscape has its own optional `research.landscape` list of cited findings, reusing the title/summary/sources format. Old snapshots remain readable and show a prompt to run a new search when Landscape is absent. An explicitly empty list shows an insufficient-evidence state. Demo Landscape summaries are labeled sample content and are selected only in demo mode.

The two existing Problems instruction paragraphs, `market-ai.ts`, and `market-aggregation.ts` were preserved exactly. Landscape instructions request competitors, alternatives, workarounds, positioning, sourced pricing, and relevant developments; product claims should come from official listings and remain distinct from user reports. Landscape citations are validated independently, and these findings are not mapped into the Problems list.

The latest local Landscape prompt explicitly searches Product Hunt product/launch pages and Show HN discussions for reference links, alongside Reddit and relevant public forums for alternatives, workarounds, and user experiences. References must point to specific pages, with supported launch dates and maker claims distinguished from user evidence. This source expansion is not yet deployed; it does not change Problems, People, search limits, or scheduling.

People discovery now focuses on Reddit authors and commenters explicitly describing the same or a similar problem, including contextual agreement replies. It no longer searches for creator partners. New records carry `matchType` (`exact` or `similar`), `needStatus` (`unresolved_at_posting`, `subsequently_resolved`, `unclear`), and publication dates when available. Empty capability matches are allowed for problem matches whose product coverage is unconfirmed. A new counted person must have a named Reddit author and an excerpt contained in the attributed source passage. Comment links exposed by a cited parent thread are accepted only when the exact comment URL is also present in that passage. This is web-search-supported evidence, not independent platform verification. Legacy records retain their previous format and remain readable.

Deduplication is case-insensitive for Reddit usernames and retains a later resolution rather than treating every author as an unresolved lead. The native card shows the match and resolution, while `research.peopleCoverage` describes the inspected search scope. Output remains bounded to twenty authors per response. Existing models, three-call web tool limit, shared budget controls, and scheduling are unchanged; the prior manual pilot used more browsing effort and is not a production recall benchmark.

Validation: TypeScript check and all 68 Market backend tests passed against local Firebase emulators. The native simulator app built successfully; the compact-width Problems and Landscape screens were inspected, and the Landscape tab works. Standalone compiled Swift checks passed for old/new research decoding and People match/resolution labels. The focused XCTest run built its targets but stalled before test results and was interrupted after roughly two minutes, so it is not counted as passed. Backend deployment and App Store upload were not performed.

### Landscape and People release — September 25

The implementation above is now deployed as `api-00031-kov` and `processmarketscan-00019-rep`. Isolated production packages passed 67 applicable API tests and all 68 worker tests, and both deployed source archives matched all 100 expected files. Problems instructions, spending controls, and scheduling remain unchanged. All four live health/config endpoints returned HTTP 200. No paid scan was triggered. Native **1.0.2 (28)** uploaded successfully to App Store Connect, with processing status recorded in `APP_STORE.md`. This supersedes the local-only release notes above.
