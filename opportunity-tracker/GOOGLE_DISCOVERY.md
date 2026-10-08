# Google discovery in the listening pipeline

Status: integration brief, October 8, 2026. The Google collector described here is not implemented or enabled yet.

Add Google discovery to the existing seven stages. It should supply existing indexed mentions during onboarding and periodically discover material outside the communities and platforms we actively collect. Keep the existing two-hour Reddit/X monitoring and past-year backfill. Google indexing has no guaranteed delay or completeness, so Google discoveries cannot carry an instant-alert promise.

This addition follows the user's request to generate name, alias, domain, and site-specific searches. It also connects to the shared Mentions, Potential customers, Feedback, and Competitors views. Those purposes classify the same evidence; they are not separate copies of conversations.

## Stage responsibilities

| Stage | Google discovery addition |
| --- | --- |
| 1 Business profile | Supply the reviewed subject name, aliases, official URL/domain, and optional creator names and handles. Keep confirmed identity distinct from inferred audience needs. A book or person can be monitored without manufacturing software capabilities or a sales use case. |
| 2 Search strategy | Save editable identity searches separately from problem/opportunity themes. Generate broad phrase searches and a bounded set of site-specific variants. Reuse these identities for direct platform searches too. |
| 3 Collection | Run initial indexed discovery, daily recent searches, and rotating weekly unrestricted searches. Retrieve original sources after discovery. Share pacing, leases, credit accounting, and deduplication with the existing collector. |
| 4 Qualification | Confirm that the source refers to the intended subject. Keep a relevant mention even without an unmet need or sales opportunity. Record mention relevance separately from direct business fit. |
| 5 Insights | Include verified mentions, praise, criticism, comparisons, and relevant conversations. Deduplicate authors/threads and preserve publication dates when measuring repetition. |
| 6 Action recommendation | Recommend responding only when the conversation is still actionable. Reading, saving, research, or no action can be appropriate for older mentions. |
| 7 Drafting | Use the existing action tier and verified source context; discovery itself never posts or sends messages. |

## Query plan

The current `search-plan.mjs` themes require offering references and need-driven queries. Add a separate optional `mentionQueries` collection instead of forcing identity queries into that shape. Existing saved v2 plans should default to an empty collection and keep working; do not invalidate them merely because this optional capability becomes available.

Each entry should have a stable query ID, an identity reference, a purpose, a phrase or domain, an optional site restriction, and enabled state. Store structured values; compile quotes and site operators in code. Keep existing ordinary-text validation for Reddit/X/LinkedIn opportunity queries. Include all query-affecting identity/settings fields in the appropriate plan hash so edits require review without resetting old evidence or paid-request receipts.

For The Mom Test, a reviewed plan could produce:

```text
"The Mom Test"
"Mom Test" Fitzpatrick
"The Mom Test" site:reddit.com
"The Mom Test" site:news.ycombinator.com
"The Mom Test" site:substack.com
"The Mom Test" site:linkedin.com/posts
```

The unqualified title search remains essential for discovering other sites. Search a verified official domain separately, and retain name/alias searches because mentions need not contain a link. Creator-name-only matches are candidates until context establishes a reference to the monitored work. Add translated titles only when supplied or confirmed. Exclusions should be editable and conservative.

## Collection schedule and limits

Suggested initial limits for implementation, subject to the existing shared allowance:

- Onboarding: four priority queries, at most two result pages each. Start immediately alongside direct-source collection and show results as they are verified. This covers material already indexed; it does not wait for new indexing.
- Daily: three rotating queries, one result page each, with an overlapping recent window. Record progress so lower-priority queries are eventually searched.
- Weekly: rotate the whole enabled query set through searches without date restrictions, at most two pages per query. This recovers older pages indexed late and pages with missing or inaccurate search dates. A recent-only query cannot guarantee that recovery.
- Maintain independent due times and saved progress for Google work. Do not rerun Google every time the two-hour direct monitor runs, and do not let a Google backlog starve direct monitoring or qualification.

Use ScrapeBadger `GET /v1/google/search`, `q`, and `start=0,10,...`. Its current documentation says `num` no longer increases page size. Stop at the page/request budget, repeated results, or exhausted results; record partial coverage. Date filters and pagination are discovery aids, not completeness guarantees.

Reserve provider costs before dispatch using the existing shared ledger and measured response credits. Verify the endpoint's current credit schedule when implementing its reservation; do not assume Reddit rates apply. Retain conservative holds for unknown outcomes and avoid replaying uncertain paid calls. No increase to the 3,333-credit daily workspace cap or the existing AI allowance is part of this addition.

## Source evidence and deduplication

Keep `discoverySource=google` and `provider=scrapebadger` separate from the original content source. A Reddit post found through Google belongs in Reddit and the relevant purpose views; an article belongs in Web. Google is a discovery method, not a conversation platform.

Save the discovery query ID, discovered URL, search title/snippet, `firstDiscoveredAt`, and a bounded discovery history. Treat search snippets as unverified discovery evidence. Retrieve original text through the existing platform adapter where supported or a bounded public-page fetcher before verifying the mention. Search titles/snippets must not become fabricated author quotes, complete conversation text, or proof of current reply availability. Unavailable originals remain explicitly unverified discoveries.

Support generic web articles in evidence storage and restore validation; current `conversation-evidence.mjs` accepts Reddit/X/LinkedIn hosts only. Preserve existing safe URL checks, body limits, redirect checks, and private-address restrictions when fetching new domains.

Use native post/comment IDs where available and conservative canonical URLs elsewhere. Preserve query parameters that identify content, such as a YouTube video ID; remove only known tracking parameters. Merge a Google rediscovery with the directly collected record and retain both provenance entries. Do not overwrite verified original text with a shorter search snippet, duplicate qualification, or reset saves, dismissals, notes, drafts, and first-discovery time.

Keep `publishedAt`, `firstDiscoveredAt`, and `lastFetchedAt` distinct. Unknown publication dates stay null. An old article discovered today is a newly found mention, not a new conversation. Unknown-date pages may enter Mentions but cannot count as dated recent demand.

## Qualification and presentation

A positive review such as “I loved The Mom Test” qualifies as a mention even when no need is expressed. It should not have to satisfy Tavern's sales-fit rules. Ambiguous names require source context; keyword presence alone does not establish the intended subject.

The source verification state and purpose classification must survive file/Firestore storage and backup export/restore. Both direct collection and Google collection should feed the same reviewed evidence and purpose classifier. Findings about repeated questions still require the existing independent-thread and author checks; several search queries returning one article count once.

Use clear coverage text such as “Found through Google; indexing may be delayed” and show source publication date separately from discovery date. In the monitoring settings, describe Google as periodic web discovery. Retain the original platform filter, with a separate discovery-method filter only if useful. The Google backlog must not block the first usable onboarding results.

## Acceptance checks

1. Existing v1 products and saved v2 plans continue to load, switch, collect, and restore unchanged.
2. Identity queries are saved, editable, safely compiled, and invalidated when their reviewed identity changes.
3. An indexed historic mention appears during onboarding; an old page found later remains historic; an unknown-date mention keeps its unknown date.
4. The same Reddit comment found directly and through Google yields one evidence record and preserves review state.
5. An unavailable original remains an unverified discovery and cannot support a literal source quote or confirmed repeated-question finding.
6. A genuine mention without a sales need appears in Mentions; an unrelated namesake does not.
7. Concurrent workers dispatch one paid call, daily/weekly jobs resume from saved progress, and the shared budget/pacing rules apply on success, failure, and uncertain outcomes.
8. Generic web evidence and discovery provenance survive restore. URL deduplication preserves identity-bearing query parameters.
9. Direct monitoring remains on its existing cadence and keeps progressing during Google backfill.

## References

- [Google crawling and indexing](https://developers.google.com/search/docs/fundamentals/how-search-works): indexing and search visibility are not guaranteed.
- [ScrapeBadger Google search](https://docs.scrapebadger.com/api-reference/google/google-search/google-web-search): query operators, pagination, and time filters.
- [ScrapeBadger Google overview](https://docs.scrapebadger.com/google/overview): current endpoint pricing is available through its public pricing service.

Integration points: `search-plan.mjs`, `collection.mjs`, `backfill.mjs`, `conversation-evidence.mjs`, v2 qualification, store/restore validation, and the production purpose views. These are also being changed by the ongoing stage redesign; integrate this brief there before changing shared interfaces in parallel.
