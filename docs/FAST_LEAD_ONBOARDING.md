# Fast lead onboarding

This implementation is local and has not been deployed or timed against live providers. The 20 to 30 second first-match goal remains a target.

## Search and matching

New initial-scan receipts use a progressive search. The first round requests one or two focused queries, permits up to two search tool calls, and returns at most five candidates. The remaining two rounds permit six search calls and 20 candidates each. All three rounds run regardless of the match count, subject to existing spending limits and provider availability. Historical search has no date cutoff.

Both passes use the same configured model, medium reasoning effort, app profile, fetched source text, qualification prompt, evidence checks and output allowance. Only discovery breadth changes. The first pass can miss posts that the broader pass later finds; identical qualification rules do not establish identical search coverage or measured quality.

Three qualification jobs can run concurrently across immediate dispatch and recovery. Discovery has its own slot. Durable per-job claims and budget transactions prevent duplicate paid reviews. Expired slot leases recover capacity, and lease tokens prevent an old worker from releasing a replacement worker's slot.

Accepted posts enter the existing board as each review settles. After 30 seconds, the next progress response identifies the search as background work. Later rounds and scans with a first match also show this state. This changes the presentation only; it does not cancel or restart the search. Existing receipts retain their search policy and paid-job identities, and completed scans do not restart.

## Lead notifications

Every newly qualified post queues an alert through the existing delivery outbox for each active device, during both setup and ongoing monitoring. An initial scan is not required. The assessment, per-app/post notification receipt, and delivery jobs commit in one transaction, so a successful qualification cannot lose its notification between writes. Retries and requalification of the same post do not create another alert. Receipts are removed with the app or account. Tapping an alert opens that app's lead board. Ownership, profile revision, source content, expiry and dismissal are checked both when queuing and before delivery; existing trial/free-quest access checks still apply. The scan's round completion step can retry queuing any qualified results that lack a receipt. APNs retries use the existing delivery worker.

The scan stores `firstMatchAt` and the first `notificationQueuedAt` as progress timestamps, not notification limits. Time to first accepted match is `firstMatchAt - requestedAt`. Search jobs retain their quick/background phase, query traces and round identity for later evaluation. Posts discovered before any device is registered do not create a notification receipt unless a later queue attempt finds an active device.

## Configuration and rollout

The example environment selects `gpt-6-sol`; search and qualification already use medium reasoning. Its token-price ceilings are 2 USD input and 10 USD output per million tokens. The example account cap is 4 USD, allowing room for conservative search reservations; the shared example cap remains 5 USD. These are budget limits, not estimates of the cost of one setup. Runtime defaults and production settings have not been changed. Feature gates remain off in the example.

Backend rollout requires the changed API and lead workers, the qualification task queue concurrency of three, and the existing delivery worker. The native progress copy and notification routing require a new app build. No new provider secret or database index is required. Model or budget changes need to be applied deliberately to the target environment.

## Local verification

- TypeScript checking passed.
- All 39 focused lead tests passed, including matching-request equivalence, parallel qualification, duplicate handling, lease recovery, background progress and notification validation.
- The complete backend suite passed 239 of 240 tests. The remaining trial test hit a Firestore emulator transaction lock timeout; all three tests in that file passed on an isolated rerun.
- The iOS Release simulator build passed. Native runtime routing and physical APNs delivery have not been exercised for this change.
- No live search, model-quality comparison or latency measurement was run.

## Empty searches and setup allowance

Setup source reviews do not consume or depend on the regular 300-review daily monitoring allowance. Eligibility comes from the durable initial scan’s fetched post IDs and current app/profile revision, including posts already queued by monitoring. Existing monetary budgets and qualification evidence requirements still apply.

When a completed round has no qualified matches, the next distinct search round waits 30 seconds, then 60 seconds. The retry timestamp is persistent, so refreshes and concurrent tasks cannot accelerate or duplicate paid work. The existing three-round bound remains; ordinary monitoring continues afterward. A cap pause or provider interruption must not be presented as a completed empty search. Reordering unchanged profile rows or communities does not create a new matching revision.
