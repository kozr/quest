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
3. Connect **Neon Postgres** through the project's **Storage** tab / [Vercel Marketplace](https://vercel.com/marketplace/neon/neon). It supplies `DATABASE_URL` (or supply a Neon connection string yourself; `POSTGRES_URL` is also accepted). The tracker creates its own `product_tracker_state` table on first access.
4. Add **`TRACKER_PASSWORD`** (a unique password with at least 16 characters) and **`TRACKER_SESSION_SECRET`** (a random secret with at least 32 characters) to the project environment. Generate the session secret with `openssl rand -hex 32`. Keep secrets in Vercel settings; do not commit them.
5. Deploy and sign in with your tracker password. Optional `OPENAI_API_KEY` and `OPPORTUNITY_OPENAI_MODEL` enable broader web search; they are not required for the public sources.

Vercel serves the `public` files directly and imports the default Express export in `server.mjs`, as described in [Express on Vercel](https://vercel.com/docs/frameworks/backend/express). Production uses Postgres and never falls back to a function's temporary filesystem. Products, matches, statuses, and notes remain after cold starts and deployments. Optimistic revisions prevent simultaneous updates from overwriting one another; search leases coordinate separate function instances.

Use a separate database for Preview deployments, or keep the default workspace separation (`preview` versus `personal`). `TRACKER_WORKSPACE` overrides that name; do not assign a production workspace to untrusted preview code. Changing `TRACKER_SESSION_SECRET` signs out existing sessions. Sign-in attempts are limited across function instances.

To move your existing local tracker data online, **Export backup** locally, sign in to the Vercel version, then **Restore backup**. Local data and credentials are excluded from Git and deployment uploads. The hosted interface uses the same plain CSS and adds only the password sign-in and sign-out controls.

## Use

1. Choose **Add product**, paste its website or App Store link, and optionally **Import details from link**. If a site blocks import, fill in the name and description yourself.
2. Enter specific opportunity phrases, one per line, describing problems the product actually solves. Add distinctive product names or alternate spellings to watch for mentions; website domains are included automatically.
3. **Save and find matches** searches public sources. Subsequent searches run when you choose **Find matches**; there is no background monitoring or automatic posting.
4. Review the excerpt, matching reason, date, and original discussion. Save useful matches, dismiss irrelevant ones, and add notes. The New, Saved, and Dismissed filters support restoring decisions.
5. Use **Export backup** before moving computers. **Restore backup** replaces the current records after confirmation.

## Sources and match behavior

- **Hacker News:** public Algolia search, including posts and comments. Opportunity searches use recent results; known opportunity dates older than 90 days are excluded. Exact mentions can include older results.
- **Reddit:** bounded public JSON searches. Reddit may block automated access. A failure appears in Search coverage with links to search the same phrases manually; failed searches never become fake results or zero-coverage successes.
- **Broader web:** optional server-side OpenAI web search. Without configuration, manual search links remain available.

Opportunity matches require a confirmed phrase/topic in the same request or difficulty statement. Earlier achievements and unrelated requests in another clause do not qualify. Mentions require an exact confirmed alias or website domain; use a distinctive alias to disambiguate common product names. Exclusions remove matching phrases. This is conservative text matching, not a guarantee of product fit or a complete internet crawl. Every result requires review. Web excerpts are search-supported and explicitly not independently verified conversation text.

Searches are bounded to six queries per public source, 30 results per query, and a 12-second source deadline. The combined inbox takes up to 100 deduplicated matches per search. Repeated searches preserve saved/dismissed statuses and notes. A source returning only part of a search reports that limitation. No mock data is used in the running app.

## Optional web discovery

Copy `.env.example` to `.env` in this directory and configure both `OPENAI_API_KEY` and `OPPORTUNITY_OPENAI_MODEL` with a model available to your API project that supports Responses web search. Restart the tracker. The key stays on the server. Live web discovery makes billable API requests; one search is capped at six web tool calls and 3,600 output tokens. There is no monthly spending ledger in this personal tool. Leave the optional provider unset to use the free sources and manual links.

## Data

In local mode, records live in `opportunity-tracker/.local/tracker.json`, ignored by Git. Updates replace the file atomically; data remains after restarting the server. `TRACKER_DATA_DIR` can point to another local data directory. Do not run two local tracker processes against the same data directory. The Vercel version stores records in its configured Postgres database. Neither mode synchronizes with the existing iPhone account.

Website imports validate public addresses, pin DNS results, revalidate redirects, and cap response sizes. External content is displayed as text. Local mutations require a per-process token; hosted mutations require a signed session and session-bound CSRF token that works across instances. Both reject cross-origin requests. App Store metadata uses Apple's public lookup endpoint; no Apple private key is needed.

## Checks

```sh
npm test --prefix opportunity-tracker
node opportunity-tracker/test/browser-check.mjs
```

Tests use temporary stores, in-process Postgres, and scripted discovery results; no paid requests or real outreach are involved. Hosted tests execute the actual SQL against PGlite and cover concurrent mutations, instance-independent sessions, shared search locks, and credential-safe failures. The browser check uses the repository's installed Playwright and Chrome when available. Separate public network smoke checks verify actual source/metadata responses.
