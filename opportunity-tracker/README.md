# HearWhispers product tracker

A standalone personal web tracker (HearWhispers) for products you build. Add a website or App Store link, confirm the product details and the problems it solves, then find public opportunities and mentions. On-demand analysis adds Problems, Landscape, People, match-fit assessments, and reply suggestions adapted from Tavern. The interface uses the selected Review Desk design, with React, shadcn components, and warm neutral colors. There are no sales, purchase, billing, or game features.

## Run

From this repository, install the tracker’s own dependencies and start it:

```sh
npm ci --prefix opportunity-tracker
npm start --prefix opportunity-tracker
```

Open **http://127.0.0.1:4322**. No iPhone, Firebase emulator, account, or API key is required. `TRACKER_PORT` changes the port. This is a local personal app; it binds to loopback and rejects other Host values.

## Build the Review Desk frontend

The Vite source lives in `ui/`. The server serves the compiled `public/index.html` and `public/assets/`; these are committed so the Express deployment does not need frontend dependencies at runtime.

```sh
npm ci --prefix opportunity-tracker/ui
npm run build:ui --prefix opportunity-tracker
```

Rebuild and commit the output after changing the UI. For development, run the Express server with `TRACKER_PORT=4175` and use `npm run dev --prefix opportunity-tracker/ui` (Vite proxies `/api` to that server). Production uses Google-only sign-in; a local loopback server remains accessible without login.

The frontend reads the existing private APIs. It includes platform filters, five-row pagination, source context and relevance evidence, saved/dismissed decisions, notes, cloud drafts, product editing, past-year search progress, research, and backup settings. On mobile, opening a conversation focuses its source and draft; **All conversations** returns to the queue. No response is posted automatically. The collection algorithm and its budgets are separate from the frontend build.

`test/hearwhispers.browser.mjs` verifies the built UI against local fixture APIs without paid requests. It requires Playwright and a local Chrome installation. Google signing and allowlist enforcement are covered by the API tests; the browser test stubs the Google button for its login transition.

## Deploy on Vercel

The tracker is an independently installable Express application. Use the **`opportunity-tracker` directory**, rather than the repository root, for this Vercel project. The repository root contains the separate Quest deployment.

1. Import [the tracker branch](https://github.com/kozr/quest/tree/codex/opportunity-tracker-vercel) into a new Vercel project, or clone that branch and run `vercel` from its `opportunity-tracker` directory. For continuous deployment, choose `codex/opportunity-tracker-vercel` as the project's production branch until the change is merged into `main`.
2. Set **Root Directory** to **`opportunity-tracker`**, **Framework Preset** to **Express**, and **Install Command** to **`npm ci`**. Leave Build Command and Output Directory at the Express defaults. The included `vercel.json` sets the function duration to 180 seconds and security headers.
3. Use your **Firebase project** with a **Cloud Firestore** database. Set **`FIREBASE_PROJECT_ID`** and optionally **`FIREBASE_DATABASE_ID`** (defaults to `(default)`) in Vercel. For a keyless connection, set **`GCP_WIF_PROVIDER`** to `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/providers/PROVIDER_ID` and **`GCP_SERVICE_ACCOUNT_EMAIL`** to the tracker’s service identity. Configure the Google identity pool to trust only this Vercel project and environment, with issuer `https://oidc.vercel.com/TEAM_SLUG`, audience `https://vercel.com/TEAM_SLUG`, and the exact subject `owner:TEAM_SLUG:project:PROJECT_NAME:environment:production`. Grant that principal `roles/iam.workloadIdentityUser` on the service account and grant the service account `roles/datastore.user`, restricted to the tracker’s named database. This follows [Vercel’s Google Cloud OIDC setup](https://vercel.com/docs/oidc/gcp). The app exchanges Vercel identity tokens for short-lived Google credentials; no service-account private key is needed. An alternative is **`FIREBASE_SERVICE_ACCOUNT_JSON`** in Vercel's server environment, following [Firebase's server setup](https://firebase.google.com/docs/admin/setup); never put those credentials in Git or browser code. A Firebase web API key alone cannot authorize server access. The tracker writes only to `opportunityTrackers/{workspace}` and its `stateChunks` subcollection.
4. Create a **Web application** client in [Google Auth Platform](https://console.cloud.google.com/auth/clients), with the deployed dashboard origin in **Authorized JavaScript origins**. Set **`TRACKER_GOOGLE_CLIENT_ID`** to the resulting client ID and **`TRACKER_GOOGLE_ALLOWED_EMAILS`** to the comma-separated Gmail or Google Workspace accounts invited to this private workspace. Alternatively, use **`TRACKER_GOOGLE_ALLOWED_SUBJECTS`** for stable Google account IDs; this is required for Google accounts with third-party email addresses. This remains one shared private workspace, not public multi-tenant registration. Google sign-in is enabled in the shared Firebase project; the separate iPhone API still requires Apple identities.
5. Set **`TRACKER_SESSION_SECRET`** to a random secret of at least 32 characters (`openssl rand -hex 32`). Keep it in Vercel settings; do not commit it. No Google client secret is needed: the server verifies the Google ID token signature, audience, issuer, expiry, verified identity, allowlist, and browser-bound nonce before issuing an HttpOnly session. Old password sessions cannot authenticate after this migration. Remove the obsolete `TRACKER_PASSWORD` deployment variable after rollout.
6. Deploy and select **Continue with Google**. ScrapeBadger collection and Sol qualification require the existing server credentials described below.

Vercel serves the `public` files directly and imports the default Express export in `server.mjs`, as described in [Express on Vercel](https://vercel.com/docs/frameworks/backend/express). Production uses Firebase Cloud Firestore and never falls back to a function's temporary filesystem. Products, matches, statuses, and notes remain after cold starts and deployments. Firestore transactions and optimistic revisions prevent simultaneous updates from overwriting one another; search leases coordinate separate function instances.

Provision Preview access separately if needed; the recommended production federation denies preview identities. Use a separate Firebase project or database for Preview deployments, or keep the default workspace separation (`preview` versus `personal`). `TRACKER_WORKSPACE` overrides that name; do not assign a production workspace to untrusted preview code. Changing `TRACKER_SESSION_SECRET` signs out existing sessions. Sign-in attempts are limited across function instances. Keep direct client access to `opportunityTrackers` denied in Firestore rules; the existing repository rules already deny all direct access. Do not replace unrelated Firebase rules to deploy this tracker. Vercel must not include any emulator environment variables. Only the configured Google accounts can access the workspace. Removing an account from both allowlists invalidates its existing sessions on the next request. The personal Google login is separate from the existing iPhone Firebase Authentication flow.

To move your existing local tracker data online, **Export backup** locally, sign in to the Vercel version, then **Restore backup**. Local data and credentials are excluded from Git and deployment uploads. The hosted interface uses the same Review Desk frontend and adds Google sign-in and sign-out controls.

### Configured Firebase Google sign-in

Firebase Google sign-in is enabled in `the-app-quest` for the **HearWhispers** web app (`1:539152982713:web:45a6a266257f52aede3168`). The existing `opportunity-tracker` Firestore database and Vercel workload identity connection remain in use. Both production tracker domains are authorized in Firebase. `firebase.auth.json` records only the Google provider configuration; it does not deploy database rules, functions, or other sign-in providers. It requires Firebase CLI 15.33.0 or newer.

The tracker validates Google ID tokens directly and creates its own protected server session. Configure the resulting web client ID as `TRACKER_GOOGLE_CLIENT_ID` and explicitly allow the intended owner with `TRACKER_GOOGLE_ALLOWED_EMAILS`. Secrets and allowed account values stay in Vercel. Quest's separate API continues to require Apple identities.

## Use

1. Choose **Add product**, paste its website or App Store link, and optionally **Import details from link**. If a site blocks import, fill in the name and description yourself.
2. Choose **Continue**, then optionally **Suggest tracking details**. Review the suggested capabilities, needs, search phrases, and subreddit watchlist. Edit the suggestions and check community accessibility; add distinctive product names to watch for mentions.
3. Choose **Continue**, then **Start tracking**. Automatic checks are optional: Reddit and X monitoring runs every two hours; LinkedIn runs at 8 a.m. and 8 p.m. Pacific. **Check now** starts a bounded collection cycle immediately. There is no automatic posting.
4. Review the excerpt, matching reason, date, and original discussion. Save useful matches, dismiss irrelevant ones, and add notes. Write a response and choose **Save draft** to persist it in the same workspace. Unsaved edits survive switching conversations; leaving the page warns before discarding them. The New, Saved, and Dismissed filters support restoring decisions.
5. Use **Export backup** before moving computers. **Restore backup** replaces the current records after confirmation.

## Sources and match behavior

- **Hacker News:** public Algolia search, including posts and comments. Opportunity searches use recent results; known opportunity dates older than 90 days are excluded. Exact mentions can include older results.
- **Reddit:** `scrapebadger` uses the dedicated Reddit API for searches, subreddit feeds, and selected comment trees. `public-json` and the authenticated OVH `redlib` adapter remain available through explicit configuration. Provider failures remain visible, with manual search links; adapters never silently fall back to another provider.
- **LinkedIn:** opt in with **Check LinkedIn posts** when reviewing a product's tracking profile. Apify's `harvestapi/linkedin-post-search` searches a rotating topic from the saved phrases or confirmed needs, plus an exact product name/domain, up to 30 posts per search. No LinkedIn cookies or login are required. Opportunity searches use the past month; exact mentions can include older posts. Local filters accept supported related wording in a request or difficulty; exact keyword presence alone is insufficient. Matches use the existing inbox, notes, save/dismiss decisions, and source coverage. Existing products retain their saved settings until edited.
- **Broader web:** manual search links. Paid web tools and AI profile suggestions are disabled in the tracker so they cannot bypass its qualification budget.

Opportunity matches require a confirmed phrase/topic in the same request or difficulty statement. Earlier achievements and unrelated requests in another clause do not qualify. Mentions require an exact confirmed alias or website domain; use a distinctive alias to disambiguate common product names. Exclusions remove matching phrases. This is conservative text matching, not a guarantee of product fit or a complete internet crawl. Every result requires review. Web excerpts are search-supported and explicitly not independently verified conversation text.

Searches are bounded to six queries per public source, 30 results per query, and a 12-second source deadline for Hacker News/web, 40 seconds for ScrapeBadger/Redlib search, and 35 seconds for watchlist collection. The combined inbox takes up to 100 deduplicated matches per search. Repeated searches preserve saved/dismissed statuses and notes. A source returning only part of a search reports that limitation. No mock data is used in the running app.

### ScrapeBadger Reddit adapter

Set the following in the tracker's server environment (Vercel Production for the hosted app):

```dotenv
REDDIT_PROVIDER=scrapebadger
SCRAPEBADGER_API_KEY=<enter the key securely in Vercel settings>
```

The key is used only in the `X-API-Key` header to `https://scrapebadger.com/v1/reddit/`. Never put it in chat, Git, browser JavaScript, URLs, or logs. Add it through Vercel's encrypted Environment Variables UI or interactively with `vercel env add SCRAPEBADGER_API_KEY production`. Redeploy after changing provider settings. In local mode, use the ignored `opportunity-tracker/.env` and restart the server. A key automatically selects ScrapeBadger when `REDDIT_PROVIDER` is unset; explicitly selecting it without a key fails visibly.

`reddit/scrapebadger.mjs` implements the same `search`, `list`, and `thread` adapter contract. Search and subreddit listing use cursor pagination, at most two pages and 30 posts per query. Searches visit up to three selected threads; watchlists revisit up to four recent/relevant threads. A thread retrieves its original post and up to 100 normalized comments, with a provider depth ceiling of ten. Comments retain their own text, author, parent, timestamp, and exact canonical permalink. Deleted, closed, malformed, or contradictory sources are omitted. Existing qualification, notes, saved/dismissed states, backups, and two-hour Reddit monitoring keep their existing behavior.

Calls are limited to two concurrent requests per adapter and a 12-second per-request deadline within the existing overall collection deadlines. Validated responses cache for 60 seconds, with a 200-entry cap and shared in-flight requests. Failed schemas are not cached. Ambiguous paid requests are never retried automatically within a collection. Partial thread failures retain the original post and expose incomplete coverage. This is bounded discovery; it is not a complete comment stream.

Coverage includes the provider's `X-Credits-Used` value when present; missing or uncertain accounting is `null`, and cache hits report zero new credits. ScrapeBadger publishes PAYG at $0.15 per 1,000 credits, with base Reddit costs of two credits for searches/posts and three for comment reads. Its general pricing page also describes per-item charges, so verify deductions in a live smoke test before treating base costs as the total bill. These scraping credits are separate from the tracker's existing AI budget. See [ScrapeBadger Reddit docs](https://docs.scrapebadger.com/reddit/overview) and [pricing](https://scrapebadger.com/pricing).

LinkedIn is configured separately with `LINKEDIN_PROVIDER` and `APIFY_TOKEN`; changing `REDDIT_PROVIDER` does not change its provider. The legacy OVH/Querylane gateway remains available through explicit `LINKEDIN_PROVIDER=linkedin-mcp`.

### Redlib adapter

The `reddit/adapters.mjs` contract is `search({query, signal, limit}) -> {rows, coverage}`. Discovery accepts an injected `redditAdapter` for tests and selects the production adapter using environment variables. The Redlib HTML adapter additionally implements `list({subreddit, sort, signal, limit})` and `thread({path, signal, limit})` for watchlist collection and bounded thread revisits. The separate worker polls due products; it does not provide a continuous Reddit-wide feed.

Configure the tracker, including Vercel's **server-only** environment:

```dotenv
REDDIT_PROVIDER=redlib
REDLIB_BRIDGE_URL=https://vps-d6b1b25d.vps.ovh.us
REDLIB_BRIDGE_TOKEN=<random secret of at least 32 characters>
```

The same token must be installed privately in `reddit/.env` on the OVH bridge. Never commit it or expose it to browser JavaScript. `REDDIT_PROVIDER=public-json` explicitly restores the original adapter. An incomplete Redlib configuration is an error, not permission to use another provider. The local tracker reads its own `.env` on startup; restart it after configuration changes.

The collector is a separate Docker Compose service deployed to `/home/foray/apps/opportunity-redlib-bridge`, using `reddit/compose.yaml` and `reddit/ovh-deploy.json`. It joins the existing private Redlib and Caddy Docker networks. Redlib's host port remains bound to loopback. The bridge exposes only authenticated normalized JSON endpoints (`POST /v1/search`, `/v1/list`, `/v1/thread`) and a non-sensitive health endpoint. Its local diagnostic port is `127.0.0.1:18081`. Caddy serves HTTPS for the VPS hostname and proxies to `opportunity-redlib-bridge:8081`.

HTML collection uses Cheerio, ordinary HTTP, and actual page links, never `.json`, a browser, or an LLM. Post/comment IDs, separate author/text attribution, parent IDs when observable, original Reddit URLs, and collection timestamps survive classification, storage, and backup restore. Successful normalized pages are cached for 60 seconds with a 200-page cap and in-flight request sharing; failed pages are not cached. Deduplication uses Reddit IDs inside the collector and canonical Reddit URLs in the tracker.

Each query collects at most two listing pages / 30 posts, then visits at most three returned threads. Each thread is bounded to two HTML pages / 200 records. These are mechanical limits, not a claim to retrieve all comments. Coverage reports continuation limits, failed pages, and visible comment counts below the advertised count. It always marks thread completeness as unverified. Comment matches come from selected post threads, **not global comment search**. Cache timestamps retain the original collection time.

The bridge allows two active collection jobs and 60 requests per minute, with a 25-second job deadline. The tracker queues its searches with two concurrent requests and a 40-second overall Reddit deadline; healthy sources and partial collected results remain usable. Individual HTML requests have eight-second timeouts and at most two transient retries with backoff. Long upstream Retry-After values cause an explicit failure instead of early retry. Redirects and external pagination links are rejected, response sizes are bounded, and unrecognized/error HTML cannot become a successful empty collection.

## Optional web discovery

### LinkedIn post search on Apify

Use [HarvestAPI's LinkedIn Post Search](https://apify.com/harvestapi/linkedin-post-search), actor `harvestapi/linkedin-post-search`. This fits the tracker's topic/need discovery and exact product mentions: it searches posts and returns their own content, author, original permalink, and publication date. It does not require LinkedIn session cookies. Search results are a limited sample shaped by LinkedIn's search algorithm, not a complete post stream.

Set these **server-only** variables in Vercel Production, then redeploy:

```dotenv
LINKEDIN_PROVIDER=apify
APIFY_TOKEN=<enter an Apify API token securely in Vercel settings>
```

Use Vercel's encrypted Environment Variables UI or `vercel env add APIFY_TOKEN production`; never put the token in chat, Git, browser code, or URLs. Local development uses the ignored tracker `.env` and a server restart. A token automatically selects Apify when `LINKEDIN_PROVIDER` is unset. An explicit provider with missing credentials fails visibly and never falls back. Product-level LinkedIn opt-in and the existing 08:00/20:00 Pacific cadence remain in place.

`linkedin/apify.mjs` calls Apify's REST API with bearer authorization. Each search starts `harvestapi~linkedin-post-search` once, caps `maxPosts` at 30, sorts by newest, uses `postedLimit=month` for opportunity searches and `any` for exact mentions, and selects the free `short` author profile mode. Comments, reactions, and profile enrichment are disabled. The actor has a 45-second remote timeout, `maxTotalChargeUsd=0.10`, and `restartOnError=false`. The adapter polls that run's ID within a 50-second deadline and attempts to abort a known run on cancellation. An ambiguous start is never retried within the collection. If its run ID was not received, the remote timeout and charge cap still apply.

Only supported top-level posts with consistent source IDs, LinkedIn permalinks, author profile/company URLs, and timestamps enter matching. Quoted/reposted text and nested records are not joined to the outer author's evidence. Failed/timed-out runs can retain valid partial posts while reporting incomplete coverage. Publication dates are provider-reported; missing dates remain unknown. Original source identity survives inbox storage and backup restore, and existing AI qualification deduplicates by LinkedIn post ID. Warm workers share identical in-flight requests and cache validated successful searches for five minutes (100 entries, two active runs per adapter); failures are not cached.

Pricing checked 2026-10-06: $2 per 1,000 posts on Free/Bronze, $1.75 on Silver, and $1.50 on Gold or higher. Actor starts cost $0.00005 at the default memory; empty queries cost $0.001. See the [published pricing](https://apify.com/harvestapi/linkedin-post-search/pricing) and [public actor pricing metadata](https://api.apify.com/v2/acts/harvestapi~linkedin-post-search). Two searches of 30 posts twice a day would yield 3,600 posts and about **$7.20 per product per 30 days**, plus small start charges, at the base rate. Fewer returned posts cost less; manual searches and enrichment would add cost. The configured per-run caps bound scheduled actor charges to $12 per product per 30 days. These scraping charges are separate from the existing $2/day AI budget. Immediate run cost figures may be preliminary, so coverage marks reported costs as non-final. A one-post live smoke test succeeded on 2026-10-06 using the existing Firebase `APIFY_TOKEN` secret. The local tracker has been configured and restarted; hosted activation still requires installing the token in that Vercel project and redeploying.

### Legacy LinkedIn gateway

Select `LINKEDIN_PROVIDER=linkedin-mcp` to use the original OVH/Querylane collector. Apify is not used in this mode.

`POST /v1/linkedin/search` accepts only `{query, limit, datePosted}`. It uses the
existing `REDLIB_BRIDGE_URL` and server-only `REDLIB_BRIDGE_TOKEN`; no new secret,
browser credential, paid provider, or Querylane token purchase is required. The
OVH bridge joins `querylane-linkedin-mcp_default` and reaches the private
`http://querylane-linkedin-mcp-mcp-1:8080/mcp` endpoint. The MCP host port remains
bound to loopback. The gateway invokes only the read-only `search_posts` tool;
it provides no generic MCP proxy or messaging, connection, inbox, or login route.

The upstream 4.26.2 response contains page text and unordered permalink
references. The collector only accepts a single observed author profile slug
with a single matching `/posts/` permalink, and skips ambiguous posts rather
than pairing by order. Skipped counts and partial coverage are visible in Search
coverage. Comments and publication dates are unverified; dates stay null and
the existing matcher asks for review. Provider failures and expired sessions
remain visible. To renew a session, use Querylane's existing manual OVH login
process. There is no automatic login or provider fallback.

LinkedIn work is serialized, limited to 12 gateway requests per minute, and has
a 30-second collection deadline per request / 55-second overall source deadline.
Successful searches cache for five minutes (up to 100 queries); failures do not.
Only two searches per product check are sent. The existing monitor checks Reddit
every two hours and LinkedIn at 08:00/20:00 in `America/Los_Angeles`, including daylight-saving
changes. Source attempt times and coverage receipts are independent: Reddit checks
do not rerun LinkedIn or replace its last receipt. Failed LinkedIn checks wait for
the next slot; delayed workers check the latest slot once without a backlog.
Manual searches remain available and count toward the current LinkedIn slot.
Both sources share search leases. Backups preserve source identity, attempt
timestamps, status, and notes.
Related-topic filters are bounded rules for confirmed collection, subscription,
reading, habit, meal, or trip needs; they are not unrestricted semantic search.
They require a domain and relevant function in the same requested clause and
retain exclusions, age checks, deduplication, and review-needed evidence.
Collection uses bounded request counts and source coverage. Sol qualification
adds the separate durable spending ledger described below.

### Experiment pipeline in production

Set `TRACKER_COLLECTION_PIPELINE=experiment-v1` and `TRACKER_AI_MODE=ongoing` in production. Existing server-only `SCRAPEBADGER_API_KEY` and `TRACKER_OPENAI_API_KEY` credentials are reused. The stopped local cost experiment is never resumed. Regular Reddit and X collection starts every **120 minutes** for products with monitoring enabled. LinkedIn retains its independent 08:00/20:00 Pacific slots. Manual Find matches starts or continues a cycle immediately.

The deployed pipeline uses `collection.mjs`: a durable Firestore queue advances one provider request per worker call. The worker checks for due or unfinished cycles once a minute. Each request reserves credits and records its claim before dispatch; a shared 15-second spacing respects the five-request-per-minute account limit. Crashes/timeouts consume a conservative unknown-cost hold and do not replay that task. Actual `X-Credits-Used` receipts are retained. The workspace limit is 3,333 credits per Pacific day (at most $0.50 PAYG-equivalent); it cannot be raised through environment settings. Subscription/free credits can change actual cash billing. Restore preserves existing collection receipts and budget holds.

Per cycle: up to two listing pages per selected subreddit, four selected recent comment trees, and two X searches with at most two pages each. Editable X queries default to the first two product search phrases. Queries should combine the product's topic with supported needs; no test business is hard-coded. Reddit listing rows supply post data, avoiding duplicate detail calls. Pagination stops at the previous successful check minus a 15-minute overlap. X uses a rolling `since:` day plus an exact local cutoff. Unchanged comment counts skip a tree until a daily refresh, which helps recover edits without count changes. Successful pages cache across products for 15 minutes. Truncation, failures and unassessed candidates stay visible; this is partial coverage, including for busy communities and old threads.

New posts, comments and meaningful content revisions use **GPT-6.1 Sol medium**, standard tier, no tools or retries, with Tavern's full text qualification and comment policies. `qualification-policy.mjs` contains the verbatim policy from `src/leads-ai.ts`; a parity test checks it against Tavern when both projects are present. Both single and batch requests use this policy (`tracker-tavern-evidence-v3`). Batches contain up to ten candidates; at most 60 new candidates per collection cycle are staged. Parent context can clarify a comment, but selectable evidence comes only from its author. Batch passage IDs are scoped to each candidate and resolved back to literal source text. Qualified results must reference confirmed capability IDs. Canonical source identity plus content hash deduplicates processed versions; updating the prompt does not reset receipts or re-review existing matches automatically. Saved/dismissed statuses and notes survive updates. Regular cycles initially inspect a bounded recent feed (one-day date window). New products also queue the separate past-year onboarding backfill below.

Qualification and existing manual analysis share the pre-existing **$2 per Pacific day** AI budget and 2,000-call ceiling. Sol reserves serialized request bytes plus 4,096 tokens at the cache-write rate and the full 4,096-output-token cap before dispatch. Confirmed usage settles at $2/million input, $0.10/million cached input, $2.50/million cache-write input and $10/million output ([official model pricing](https://developers.openai.com/api/docs/models/gpt-6.1-sol), checked 2026-10-08). Reasoning tokens are part of output. Unknown outcomes retain conservative spending, never automatic paid retries. Overruns stop dispatch. `TRACKER_AI_ENABLED=false` disables model dispatch. No credentials from the separate iPhone/Tavern system are accessed.

The UI separates platforms with a filter and shows collection progress, partial coverage, AI decisions and daily credit usage. No outreach or posting is performed. The monitor's Sol timeout is 110 seconds around a 90-second provider deadline; Vercel's function limit remains 180 seconds. On-demand Problems/Landscape/People and fit/replies remain on their existing Luna model and accounting.

## Swappable v2 business profile (stage 1)

In the product editor's **Tracking profile** step, select **Detailed breakdown (v2)** and generate a business breakdown. This first v2 stage separates supported offerings, potential audiences, customer needs, documented constraints, and important unknowns. It works with local businesses and physical offerings as well as software. The separate Listening view provides the v2 search plan, collection and qualification stages described below.

The breakdown reads the supplied description and one official website/App Store page. It records their provenance and observation date, labels inferred audiences/needs as hypotheses, validates every source quote against the retrieved text, and reports inaccessible or truncated pages. It does not perform a complete website crawl. Quote validation establishes attribution, not the truth of an interpretation: review the breakdown, remove unsupported entries, and select the review checkbox before saving. Removing an offering also removes references to it. A changed business name, URL, or description requires regenerating the active v2 profile.

The server keeps `profileV1` and `businessProfileV2` alongside `profileVersion`. Saving v2 projects reviewed offering excerpts and needs into the fields used by today's collectors; documented constraints also reach both single and batch qualification and on-demand analysis. Switching to v1 restores its saved capabilities and needs. Keywords, sources, monitoring, saved conversations, notes and drafts retain their existing settings. Switching never replays previously processed qualification requests. Confirmed profiles survive file/Firestore storage and backup export/restore; transient generation previews are not part of backups.

`POST /api/profile` retains the legacy behavior when `version` is absent or `v1`. With `version: "v2"`, it returns `{version, profile, cached}`. The server uses only the existing `TRACKER_OPENAI_API_KEY`, Sol medium, and the shared `TRACKER_AI_*` allowance. Requests reserve conservatively before model dispatch, use strict structured output, and make no automatic retries. They share the 20-analysis-request daily limit. Unknown outcomes consume the reservation. Identical inputs reuse a 30-day preview; `refresh: true` requests a new generation. At most ten previews are retained. Cross-instance leases and an atomic second cache check prevent duplicate ordinary generation requests.

The intended stage boundary is business profile → search strategy → collection → qualification → insights. Action planning and post/reply generation can consume those outputs in a separate action tier. This change implements the first stage and its compatibility path only.

## On-demand analysis

Select a product and choose **Problems**, **Landscape**, or **People**, then **Run research**. One request produces all three views. Problems summarizes source-supported needs and workflows; Landscape covers competitors, alternatives, and workarounds; People shows public Reddit authors and commenters describing the same or a similar problem, including later resolution when observed. Source links, dates when available, and collection limits remain visible. Switching views does not run another request.

On a collected match, choose **Analyze fit & replies**. The assessment uses the saved title/excerpt and confirmed capabilities, with an exact supporting quote and limitations. Strong or possible fits receive two suggestions: practical help and an optional product mention. You can edit and copy them. Generated results are saved; reply edits stay in the current page until a full reload. Posting remains manual.

Analysis uses the existing server-only `TRACKER_OPENAI_API_KEY`, `gpt-6-luna`, and `TRACKER_AI_*` settings. No new key is needed. Research requests at most three web tool calls and 8,000 output tokens, with a 150-second deadline; match analysis has a 30-second deadline and 2,500 output-token cap. A timeout or invalid result keeps saved results and is never automatically retried.

Analysis runs only when requested, including in test mode. It shares qualification's **$2 per Pacific day** budget and call limit. A transaction reserves up to $1.10 for research or $0.02 for fit/replies before dispatch. Successful responses settle from reported usage using conservative Luna long-context cache-write and web-tool rates, releasing the unused hold. An uncertain dispatch retains the reservation as spending; expired reservations and deleted products cannot refund it. This may pause work earlier than the actual provider bill. There is also a persistent 20-analysis-request daily limit per workspace (Pacific). Concurrent instances cannot overlap analysis for the same product. Results cache for 30 days; refresh makes a new billable request. Profile or source changes invalidate match assessments; older research stays visible with a refresh notice.

Research citations must belong to returned web search/opened sources; unsupported citations are omitted. People require an attributed username, verbatim excerpt, original permalink, and valid capability IDs. Web search evidence is not independent platform verification or confirmed current demand. Match quotes must occur in the collected source text. Personal notes and review decisions are excluded from provider inputs. Analysis uses the existing private store, is removed with its product, and is included in backup export. Restored analysis is validated and labeled imported; restoring cannot reset the daily allowance.

```sh
node opportunity-tracker/test/analysis.browser.mjs
```

This browser check uses explicitly labeled scripted data and verifies the three research views, product scoping, resolution labels, editable/copyable replies, saved results, and desktop/mobile layouts. It makes no paid provider requests.

## Storage

In local mode, records live in `opportunity-tracker/.local/tracker.json`, ignored by Git. Updates replace the file atomically; data remains after restarting the server. `TRACKER_DATA_DIR` can point to another local data directory. Do not run two local tracker processes against the same data directory. The Vercel version stores records in its configured Firebase Firestore database. Its transactional JSON chunks support snapshots larger than Firestore’s individual document limit, with an 8 MiB total limit per personal workspace. Neither mode synchronizes with the existing iPhone account.

Website imports validate public addresses, pin DNS results, revalidate redirects, and cap response sizes. External content is displayed as text. Local mutations require a per-process token; hosted mutations require a signed session and session-bound CSRF token that works across instances. Both reject cross-origin requests. App Store metadata uses Apple's public lookup endpoint; no Apple private key is needed.

## Checks

```sh
npm test --prefix opportunity-tracker
node opportunity-tracker/test/browser-check.mjs
node opportunity-tracker/test/browser-qualification-check.mjs
```

Tests use temporary stores, the local Firestore emulator, and scripted discovery results; no paid requests or real outreach are involved. Hosted integration tests execute actual Firebase Admin transactions and cover concurrent mutations, instance-independent sessions, shared search/analysis locks, snapshots larger than one document, and credential-safe failures. To include the Firestore integration tests, start the repository’s Firestore emulator and run `FIRESTORE_EMULATOR_HOST=127.0.0.1:8088 npm test --prefix opportunity-tracker`. Without the emulator, database integration tests are explicitly skipped. They use the demo project `demo-opportunity-tracker` and unique fixture workspaces, never a cloud database. Browser checks use the repository's installed Playwright and Chrome when available. Separate public network smoke checks verify actual source/metadata responses.


## Product setup and continuous Reddit checks

Adding a product has three steps: import or enter details, review an editable tracking profile, and start tracking. The profile saves confirmed capabilities, user needs, search phrases, product aliases, exclusions, and up to ten subreddit names. Starter suggestions use the product description and curated topic vocabulary and need no paid model. Community checks retrieve recent public posts and explicitly distinguish accessible feeds from unverified suggestions. They do not establish the completeness or reliability of future collection.

Automatic tracking is optional and can be paused in Edit product. Existing products and older backups remain in manual mode until their watchlist is reviewed and enabled. Both file and Firebase stores preserve the profile. Source attempts are recorded atomically without overwriting edits; failures wait until the next source interval or slot. Searches share leases with manual runs, retain saved statuses and notes, and never send replies.

On this computer, `npm start` runs a monitor loop alongside the local server; automatic checks require that server to remain running. Hosted checks run independently of the browser through the OVH Compose `monitor` service. Set a separate server-only `TRACKER_MONITOR_TOKEN` of at least 32 characters in Vercel production and in the VPS `reddit/.env`, plus `TRACKER_MONITOR_URL=https://product-opportunity-tracker.vercel.app` in the VPS environment. The worker asks the authenticated `GET /api/monitor` endpoint for due IDs once a minute and calls `POST /api/monitor/:id` sequentially. That protected response also reports the active source schedules. These endpoints accept the monitor bearer token, never a browser session or client-side credential. There is no Vercel cron-plan dependency. Reddit and X are eligible every two hours; LinkedIn is eligible once per morning/evening Pacific slot. Failures, upstream delays, and a long queue can delay checks. The first manual check occurs when a new product is saved through the UI.

The regular monitor uses the bounded Reddit/X pipeline above. Coverage is partial: old/unselected threads, pages beyond the cap, image-only needs and overloaded queues may be missed. Check original conversations and source coverage before acting. LinkedIn uses its existing independent source adapter. Legacy Redlib remains available for free community availability checks; regular Reddit collection uses ScrapeBadger directly.

## Past-year onboarding search

Saving a new product atomically creates a durable one-time backfill, including when regular monitoring is off. Existing products can choose **Search the past year**. Repeating that action returns the same job and does not restart paid work. The hosted worker advances it between regular two-hour checks; the browser can close.

`backfill.mjs` builds product-specific query families from confirmed capabilities, needs and keywords. Reddit uses `search/posts`, `t=year`, relevance order and cursors, including topical searches outside the saved communities. X divides its configured queries across twelve date windows. Both enforce a fixed 365-day interval on normalized results. Reddit relevance pagination does not stop just because one result is old. Selected historical threads contribute comments and parent context. Archived/locked discussions remain historical evidence and are labelled closed in the inbox; regular collection still excludes them. Today’s confirmed features establish relevance, not historical availability of those features.

Backfill and ongoing work alternate provider requests under the existing global 15-second spacing, 3,333-credit Pacific-day scraper cap and shared AI allowance. AI reviews stream during collection with GPT-6.1 Sol medium. Historical skips can enter review; settled/uncertain content versions and legacy processed matches are reused without another charge. Regular watermarks are unchanged. Pending review backpressure (150), storage checks and the existing history ceiling stop collection from overrunning the transactional store. Daily budget holds retain the cursor and resume on later days.

Each first pass is bounded to 200 provider requests, 2,000 new review candidates, eight pages per query/window and 24 selected comment threads. This is partial search-index coverage, never a promise of every post in the year. The UI reports individual query/window status, returned results, duplicates, review counts, limits and failures; completion waits for pending reviews. Ambiguous paid requests keep conservative credit holds and are not retried. Profile changes stop an existing plan and are shown explicitly. LinkedIn retains its existing independent monitoring and is not included in this historical pass.


## V2 listening and action stages

HearWhispers contains stages 1–5. ActOnWhispers contains action recommendations and drafts in stages 6–7 within the same app and workspace. The sidebar groups tools under **HearWhispers** and **ActOnWhispers**. A product switcher at the top selects the shared product context for conversations, listening, insights, research and actions. Conversations and Saved also support All products. There is no in-app plan comparison or explanatory plan copy.

Set `TRACKER_ACTIONS_ENABLED=false` to disable action generation and draft editing on a listening-only server. This is a server capability gate; billing and account-level subscriptions are not integrated. Existing v1 profiles, keywords and collectors remain usable.

| Stage | Saved output | Review or next step |
| --- | --- | --- |
| 1. Understand the business | Sourced offerings, audience/need hypotheses, constraints and unknowns | Review in Products → Edit |
| 2. Plan listening | Offering-linked themes, keywords, long-tail questions and up to 12 executable queries | Edit and explicitly activate in Listening |
| 3. Collect | Original excerpts, authors, thread identity, dates, URLs, closed/crosspost flags and query provenance | Existing bounded collection worker |
| 4. Qualify | Topical relevance, direct fit, need category, exact author quote, resolution and offering references | Up to 30 pending conversations per batch |
| 5. Find insights | Repeated questions, complaints, workarounds and unmet needs, with dated source links | Generate from current qualified evidence |
| 6. Recommend actions | Useful answer, fresh guide, clearer information, offering improvement or observe | Review in Actions & drafts (ActOnWhispers) |
| 7. Prepare drafts | Editable, copyable posts and replies using advice-first language | Human review and publication |

`profileVersion` selects the business breakdown; `listeningVersion` independently selects v1 or v2 search/qualification. Generated stage-2 output is a draft. Activating a reviewed `searchPlanV2` does not overwrite v1 keywords, communities or X queries. Switching back restores their use. Changing the business profile or enabled sources can make the active plan stale; v2 collection then pauses until a new plan is reviewed. Saved conversations, notes and drafts remain.

V2 collection requires `TRACKER_COLLECTION_PIPELINE=experiment-v1` and the existing server-only `SCRAPEBADGER_API_KEY`. It executes the reviewed Reddit/X queries through the existing durable queue, pacing, cursor cache and daily scraper budget. LinkedIn uses the reviewed queries through its existing configured adapter and independent schedule. The past-year search uses the same plan, with bounded pages. A finished historical scan can be started again after a plan change; repeated starts for the same plan do not replay it. Scheduled monitoring can qualify pending v2 evidence; insights, recommendations and drafts are explicit on-demand stages.

Relevant complaints are retained even when the offering does not fit. Direct fits also appear in Conversations. The evidence store holds at most 120 conversations per business, 600 across the workspace, and 2 MB of collected evidence, keeping the most recently observed records. Excerpts are capped at 2,200 characters. These are sampled search results, not an exhaustive archive. Insights receive collected replies when available; missing replies never establish that a question is unanswered. A repeated-question claim requires three known distinct authors in three distinct threads within one subreddit. Identical substantial bodies, crossposts, unknown authors and promotions do not add independent observations. Dates, counts, links and selected quotes are assembled or checked in code. Semantic grouping and fit still need human review.

All AI stages use Sol medium, strict JSON schemas, source/ID validation, per-stage input hashes and the existing shared `TRACKER_AI_*` allowance and analysis request limit. Stages reserve their worst-case allowance before dispatch; unknown failures consume the reservation and are not automatically retried. File and Firestore storage share the same atomic stage methods. Ordinary collection refreshes do not invalidate unchanged source text; a changed business or changed evidence prevents a stale model response from being committed. Outputs are cached for 30 days when their inputs are unchanged. Action recommendations also include a daily freshness boundary for reply eligibility. Generating a downstream stage never silently regenerates upstream stages.

The action layer uses a Tavern-style advice-first contract: practical help first, a business mention only when a documented offering fits, explicit affiliation, no invented first-person experience, and no staged alternate-account exchange. Replies must target recent open discussions. Fresh posts should add a concrete guide or useful information. Nothing is published by these endpoints.

- `POST /api/products/:id/stages/:stage`, where stage is `search_plan`, `qualify`, `insights`, `actions`, or `drafts`; optional `{refresh:true}`.
- `PUT /api/products/:id/search-plan` with `{plan,version:"v1"|"v2"}`; v2 requires a reviewed current plan.
- `PUT /api/products/:id/stages/drafts` saves validated human draft edits.
- Existing `/search`, `/backfill` and `/qualification/run` routes retain their v1 behavior and honor the active v2 plan.
- `/api/state` exposes `pipeline.stages` and per-business evidence/progress. Exports include all saved stages and retained evidence. Restored model outputs are marked historical, and conversations require requalification before those results can drive new downstream stages. This prevents a backup from injecting trusted fit decisions; user-edited draft text remains available to copy.

Validation: `node --test test/*.test.mjs` and `npm run build:ui`. `node test/pipeline-preview.mjs` starts a disposable cafe fixture for UI review without external model or scraper requests. Tests cover stage isolation, v1 switching, collection query/watermark identity, closed evidence, non-fit complaints, independent-thread counting, quote attribution, stale-result rejection, shared spending, cloud CAS concurrency, export/restore and the action capability gate. Live provider output quality is not established by fixture tests.
