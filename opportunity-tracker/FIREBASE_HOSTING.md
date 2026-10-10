# Firebase dashboard deployment

HearWhispers has a separate Firebase Hosting site and two gen2 functions in the existing `the-app-quest` project. This does not deploy or replace the root Quest API, iPhone functions, default Hosting site or OVH collector.

Target site: `hearwhispers-dashboard`. Functions: `hearwhispers-api` (entry point `hearwhispersApi`) and `hearwhispers-worker` (entry point `hearwhispersWorker`), region `us-central1`, Node 22. Deploy function source with gcloud; the entry points use Google's Functions Framework. Do not use the root `firebase deploy` command for this service.

The runtime reads pinned Google Secret Manager `HEARWHISPERS_RUNTIME_CONFIG`, using the existing dashboard runtime identity and Application Default Credentials. The configuration must select `the-app-quest` / database `opportunity-tracker` / workspace `personal`, with `TRACKER_RECORD_STORAGE_ENABLED=true`. A mismatched target fails closed. No local database or stale snapshot is uploaded.

The Hosting configuration serves `public` and rewrites `/api/**` to the new API. The API is publicly reachable at the HTTPS transport layer, with the same invited Google account list, signed sessions and CSRF enforcement. Set `TRACKER_AUTH_COOKIE_MODE=firebase-hosting` and exact `TRACKER_PUBLIC_ORIGINS` for the two Hosting domains. Firebase Hosting forwards only `__session`; the authentication implementation handles the signed challenge and session in that cookie. The existing `host` cookie mode remains the default on other platforms.

Configure both new Hosting origins in the existing Google client before declaring authenticated operation verified. Firebase Hosting's API proxy has a 60-second timeout; long collection and review work runs through the private worker. The worker must remain IAM-private and use a five-minute Scheduler tick, without changing persisted plan eligibility, provider limits or pilot budgets. A `POST` with body `{"mode":"status"}` performs a read-only readiness check; ordinary `POST` checks due jobs through existing leases and budgets.

Prepared deployment: minimum zero instances; API maximum two / concurrency eight / 180-second function timeout; worker maximum one / concurrency one / 540-second timeout; each 1 CPU / 1 GiB. Existing owner-approved Blaze billing is already enabled.

The migration package is prepared and locally verified, **not deployed**. Credential transfer, recipient secret-access IAM, private-worker invocation and new Google origins require the specific pending approval. Production data, credentials, schedules and budgets have not been changed by preparation.
