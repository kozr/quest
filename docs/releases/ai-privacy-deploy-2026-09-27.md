# AI request privacy deployment — September 27, 2026

Deployed the AI payload allowlists from main to the three workers that execute reply generation and Market analysis. The release was built from each worker’s downloaded production package and changes only its AI module and source map. Other production code was preserved.

| Function | Active revision | Verified files | Traffic |
| --- | --- | --- | --- |
| processLeadReply | processleadreply-00007-len | 88 | 100% |
| recoverLeadJobs | recoverleadjobs-00017-bad | 88 | 100% |
| processMarketScan | processmarketscan-00021-bec | 92 | 100% |

All ten checks against the exact candidate packages passed. Deployed source manifests match those candidates. Billing/Sandbox flags, secret bindings, service identities, memory, timeouts, scaling, and triggers are unchanged. Six production health/config/authentication checks passed across the direct API and hosted origin. No paid AI calls or changes to production user records were needed for verification.

The public privacy policy and App Store draft metadata were published in the preceding task. Tavern 1.0.2 (33), containing the native disclosures and privacy manifest, has finished Apple processing with status VALID.

Evidence: `test-results/ai-privacy-deploy/`. Remaining publishing questions in `publishing-readiness-2026-09-26.md` (source rights, questionnaire, moderation, real Apple purchase acceptance) are not represented as resolved by this deployment.
