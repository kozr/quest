# Product tracker

A standalone personal web tracker for products you build. Add a website or App Store link, confirm the product details and the problems it solves, then find public opportunities and mentions. The interface uses plain HTML, JavaScript, and CSS. There are no sales, purchase, billing, or game features.

## Run

From this repository, install the tracker’s own dependencies and start it:

```sh
npm ci --prefix opportunity-tracker
npm start --prefix opportunity-tracker
```

Open **http://127.0.0.1:4322**. No iPhone, Firebase emulator, account, or API key is required. `TRACKER_PORT` changes the port. This is a local personal app; it binds to loopback and rejects other Host values.

## Deploy on Vercel

The tracker is an independently installable Express application. Use the **`opportunity-tracker` directory**, rather than the repository root, for this Vercel project. The repository root contains the separate Quest deployment.

1. Import [the tracker branch](https://github.com/kozr/quest/tree/codex/opportunity-tracker-vercel) into a new Vercel project, or clone that branch and run `vercel` from its `opportunity-tracker` directory. For continuous deployment, choose `codex/opportunity-tracker-vercel` as the project's production branch until the change is merged into `main`.
2. Set **Root Directory** to **`opportunity-tracker`**, **Framework Preset** to **Express**, and **Install Command** to **`npm ci`**. Leave Build Command and Output Directory at the Express defaults. The included `vercel.json` sets the function duration to 60 seconds and security headers.
3. Use your **Firebase project** with a **Cloud Firestore** database. Set **`FIREBASE_PROJECT_ID`** and optionally **`FIREBASE_DATABASE_ID`** (defaults to `(default)`) in Vercel. For a keyless connection, set **`GCP_WIF_PROVIDER`** to `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/providers/PROVIDER_ID` and **`GCP_SERVICE_ACCOUNT_EMAIL`** to the tracker’s service identity. Configure the Google identity pool to trust only this Vercel project and environment, with issuer `https://oidc.vercel.com/TEAM_SLUG`, audience `https://vercel.com/TEAM_SLUG`, and the exact subject `owner:TEAM_SLUG:project:PROJECT_NAME:environment:production`. Grant that principal `roles/iam.workloadIdentityUser` on the service account and grant the service account `roles/datastore.user`, restricted to the tracker’s named database. This follows [Vercel’s Google Cloud OIDC setup](https://vercel.com/docs/oidc/gcp). The app exchanges Vercel identity tokens for short-lived Google credentials; no service-account private key is needed. An alternative is **`FIREBASE_SERVICE_ACCOUNT_JSON`** in Vercel's server environment, following [Firebase's server setup](https://firebase.google.com/docs/admin/setup); never put those credentials in Git or browser code. A Firebase web API key alone cannot authorize server access. The tracker writes only to `opportunityTrackers/{workspace}` and its `stateChunks` subcollection.
4. Add **`TRACKER_PASSWORD`** (a unique password with at least 16 characters) and **`TRACKER_SESSION_SECRET`** (a random secret with at least 32 characters) to the project environment. Generate the session secret with `openssl rand -hex 32`. Keep secrets in Vercel settings; do not commit them.
5. Deploy and sign in with your tracker password. Optional `OPENAI_API_KEY` and `OPPORTUNITY_OPENAI_MODEL` enable broader web search; they are not required for the public sources.

Vercel serves the `public` files directly and imports the default Express export in `server.mjs`, as described in [Express on Vercel](https://vercel.com/docs/frameworks/backend/express). Production uses Firebase Cloud Firestore and never falls back to a function's temporary filesystem. Products, matches, statuses, and notes remain after cold starts and deployments. Firestore transactions and optimistic revisions prevent simultaneous updates from overwriting one another; search leases coordinate separate function instances.

Provision Preview access separately if needed; the recommended production federation denies preview identities. Use a separate Firebase project or database for Preview deployments, or keep the default workspace separation (`preview` versus `personal`). `TRACKER_WORKSPACE` overrides that name; do not assign a production workspace to untrusted preview code. Changing `TRACKER_SESSION_SECRET` signs out existing sessions. Sign-in attempts are limited across function instances. Keep direct client access to `opportunityTrackers` denied in Firestore rules; the existing repository rules already deny all direct access. Do not replace unrelated Firebase rules to deploy this tracker. Vercel must not include any emulator environment variables. The current personal password login is separate from the existing iPhone Firebase Authentication flow.

To move your existing local tracker data online, **Export backup** locally, sign in to the Vercel version, then **Restore backup**. Local data and credentials are excluded from Git and deployment uploads. The hosted interface uses the same plain CSS and adds only the password sign-in and sign-out controls.

## Use

1. Choose **Add product**, paste its website or App Store link, and optionally **Import details from link**. If a site blocks import, fill in the name and description yourself.
2. Enter specific opportunity phrases, one per line, describing problems the product actually solves. Add distinctive product names or alternate spellings to watch for mentions; website domains are included automatically.
3. **Save and find matches** searches public sources. Subsequent searches run when you choose **Find matches**; there is no background monitoring or automatic posting.
4. Review the excerpt, matching reason, date, and original discussion. Save useful matches, dismiss irrelevant ones, and add notes. The New, Saved, and Dismissed filters support restoring decisions.
5. Use **Export backup** before moving computers. **Restore backup** replaces the current records after confirmation.

## Sources and match behavior

- **Hacker News:** public Algolia search, including posts and comments. Opportunity searches use recent results; known opportunity dates older than 90 days are excluded. Exact mentions can include older results.
- **Reddit:** interchangeable adapters. `public-json` keeps the original bounded Reddit JSON search; `redlib` calls the authenticated OVH HTML collector. Provider failures remain visible, with manual search links; neither adapter silently falls back to another provider.
- **Broader web:** optional server-side OpenAI web search. Without configuration, manual search links remain available.

Opportunity matches require a confirmed phrase/topic in the same request or difficulty statement. Earlier achievements and unrelated requests in another clause do not qualify. Mentions require an exact confirmed alias or website domain; use a distinctive alias to disambiguate common product names. Exclusions remove matching phrases. This is conservative text matching, not a guarantee of product fit or a complete internet crawl. Every result requires review. Web excerpts are search-supported and explicitly not independently verified conversation text.

Searches are bounded to six queries per public source, 30 results per query, and a 12-second source deadline. The combined inbox takes up to 100 deduplicated matches per search. Repeated searches preserve saved/dismissed statuses and notes. A source returning only part of a search reports that limitation. No mock data is used in the running app.

### Redlib adapter

The `reddit/adapters.mjs` contract is `search({query, signal, limit}) -> {rows, coverage}`. Discovery accepts an injected `redditAdapter` for tests and selects the production adapter using environment variables. The Redlib HTML adapter additionally implements `list({subreddit, sort, signal, limit})` and `thread({path, signal, limit})` for later monitoring workers. No scheduler or continuous Reddit-wide feed is introduced by this integration.

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

Copy `.env.example` to `.env` in this directory and configure both `OPENAI_API_KEY` and `OPPORTUNITY_OPENAI_MODEL` with a model available to your API project that supports Responses web search. Restart the tracker. The key stays on the server. Live web discovery makes billable API requests; one search is capped at six web tool calls and 3,600 output tokens. There is no monthly spending ledger in this personal tool. Leave the optional provider unset to use the free sources and manual links.

## Data

In local mode, records live in `opportunity-tracker/.local/tracker.json`, ignored by Git. Updates replace the file atomically; data remains after restarting the server. `TRACKER_DATA_DIR` can point to another local data directory. Do not run two local tracker processes against the same data directory. The Vercel version stores records in its configured Firebase Firestore database. Its transactional JSON chunks support snapshots larger than Firestore’s individual document limit, with an 8 MiB total limit per personal workspace. Neither mode synchronizes with the existing iPhone account.

Website imports validate public addresses, pin DNS results, revalidate redirects, and cap response sizes. External content is displayed as text. Local mutations require a per-process token; hosted mutations require a signed session and session-bound CSRF token that works across instances. Both reject cross-origin requests. App Store metadata uses Apple's public lookup endpoint; no Apple private key is needed.

## Checks

```sh
npm test --prefix opportunity-tracker
node opportunity-tracker/test/browser-check.mjs
```

Tests use temporary stores, the local Firestore emulator, and scripted discovery results; no paid requests or real outreach are involved. Hosted integration tests execute actual Firebase Admin transactions and cover concurrent mutations, instance-independent sessions, shared search locks, snapshots larger than one document, and credential-safe failures. To include the Firestore integration tests, start the repository’s Firestore emulator and run `FIRESTORE_EMULATOR_HOST=127.0.0.1:8088 npm test --prefix opportunity-tracker`. Without the emulator, those four integration tests are explicitly skipped. They use the demo project `demo-opportunity-tracker` and unique fixture workspaces, never a cloud database. The browser check uses the repository's installed Playwright and Chrome when available. Separate public network smoke checks verify actual source/metadata responses.
