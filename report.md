# DBQ console: three concept directions, prior art, panel SQL and a first version

Date: 2026-10-18.
All paths below are relative to `data/dbq-dash-proto-q1/` unless they start with `/`.

## Summary

- I built three clickable concepts for a general DBQ console, each answering a different person's question, plus an index page: open `prototype/index.html`.
  - **A. Control room** (`prototype/console.html`): "Is every queue healthy right now, and if not, which one and what is it doing?" For whoever is on support today, with the page open all day.
  - **B. Flow map** (`prototype/flow.html`): "Where does work pile up between the file and the ledger, and when will it clear?" For pipeline owners, team leads and capacity planning.
  - **C. Triage** (`prototype/triage.html`): "What is wrong, why does the console think so, and what is the safe next step?" For on call and payments operations, written as sentences rather than charts.
- All three replay the same invented Thursday (normal day, poison message, stuck worker, 48,000-row file, backlog plus retry storm, draining, aftermath) with a shared time scrubber, so you can compare how each concept tells the same incident.
- Every panel has real SQL against an assumed generic schema (`sql/schema.sql`), and every query was run on PostgreSQL 17 against 1.6 million synthetic rows that reproduce the same story (`sql/seed.sql`, `sql/panels.sql`, 20 panels plus the consumer-side claim, heartbeat and fenced completion).
- Two partial indexes do almost all of the work: the "ready" index made the oldest-waiting query about 3,400 times faster (0.18 ms against 614-634 ms), and the "claimed" index made stuck-claim detection about 1,300 times faster (0.078 ms against 98-103 ms).
- Running the SQL against a realistic story found six traps a first build would fall into, for example that lag measured on ready items hides retry backoff (ledger.postings showed 1 s lag while 774 items sat in backoff for up to 571 s), and that the textbook poison-message rule flags every victim of a retry storm.
- Recommended first version: a read-only Control room page (queue table, oldest wait against target, stuck claims, throughput, open errors) served by one background snapshot job, built inside the existing Spring Boot estate.
  It is about three weeks for a graduate engineer and can be demoed against `sql/seed.sql` without touching production.
  Actions, the flow map and triage rules come after, in that order of value.
- Every prototype page was checked in headless Chrome at 1440 px desktop and 390 px phone width, in light and dark, with an interaction pass; issues found were fixed (listed under Verification).

## What to open

| Path | What it is |
| --- | --- |
| `prototype/index.html` | Start here: the three concepts, who each is for, the story moments (each link opens that minute in that concept), and links to the files below. |
| `prototype/console.html` | Concept A, Control room. |
| `prototype/flow.html` | Concept B, Flow map. |
| `prototype/triage.html` | Concept C, Triage. |
| `prototype/assets/` | Shared `dbq.css` (tokens, light and dark), `sim.js` (deterministic simulation of the day), `ui.js` (top bar, time scrubber, charts, modal, drawer, guarded action). |
| `sql/schema.sql` | The assumed schema, with each index commented with the panels that need it. |
| `sql/panels.sql` | One query per panel, marked `-- @@ <ID>`, runnable end to end; every write is inside `BEGIN ... ROLLBACK`. |
| `sql/seed.sql` | Deterministic synthetic data (1,645,739 item rows) that reproduces the story. |
| `sql/dialects.md` | Hand translations of the claim query, P1, P2, P8, P10 and the guarded release for Oracle 19c+ and SQL Server 2019+ (not executed). |

The prototypes need no server and make no network requests: `open prototype/index.html` works offline.
Evidence: `grep -rnoE '(src|href)="https?://[^"]*|url\(https?:|fetch\(|XMLHttpRequest|@import' prototype/` returns nothing, and `du -sh prototype` is 800K including six screenshot thumbnails.

Reproduce the SQL results on any PostgreSQL 16 or 17:

```sh
cd sql
psql -v ON_ERROR_STOP=1 -d dbq -f schema.sql -f seed.sql   # about 50 s, 1.6 M rows
psql -v ON_ERROR_STOP=1 -d dbq -f panels.sql               # exits 0; all writes are rolled back
```

## The story in the sample data

Thursday 15 October 2026, invented.
Six queues: `payments.inbound` and `mandates.inbound` (AIS to MMP), `ledger.postings` (MMP to Ledger), `notify.outbound` (MMP to Notifier), `recon.daily` (scheduler to Recon) and `audit.archive` (all services to the archiver, 4-hour target).

| Time | Moment | What a console must make obvious |
| --- | --- | --- |
| 08:30 | Normal day | Files arrive every 15 minutes and drain in seconds; oldest wait is a small sawtooth. |
| 09:00 onward | Poison message | Payment #88120473 fails the same way (creditor IBAN checksum) on every retry, on four different consumers, then is dead-lettered. |
| 10:42 | Stuck worker | `mmp-app-03:4211` stops heartbeating while holding 25 payments claims and 3 mandates claims; counts look fine, capacity is down 25%. |
| 11:15-11:21 | Big file | AIS ingests `DEMO_FPS_BULK_20261015_1112.csv`, 48,000 rows in six minutes. |
| 11:31 | Breach | payments.inbound's oldest waiting item passes its 15-minute target. |
| 11:50 | Retry storm | cbs-gateway times out; ledger.postings fails hundreds of times a minute with one error over thousands of different items, and starts dead-lettering. |
| 12:06 | Default "now" | Everything at once. |
| 12:24 | Draining | The waiting count falls, but the oldest item is still getting older. |
| 13:40 | Aftermath | Backlog gone; stuck claims and dead items still need a human. |

The prototype's simulation (`prototype/assets/sim.js`) and the SQL seed (`sql/seed.sql`) were built separately, so their numbers differ while telling the same story.
At 12:06 the prototype shows payments.inbound 21,760 waiting, oldest 48 minutes, 585 completed a minute, and ledger.postings failing 966 a minute with 621 dead; the seed gives 30,007 waiting, oldest 2,904 s (48.4 minutes), 450 a minute, and 615 failures a minute with 225 dead.
The breach starts at 11:31 in both.

## The three concepts

### A. Control room (`prototype/console.html`)

For whoever is on support today, with the page open all day on a second screen.
It answers "is every queue healthy right now, and if not, which one and what is it doing?" and then lets the operator go one level down at a time: all queues, one queue, one item.

- Six headline tiles: waiting, worst wait against its target, completed and failing per minute, stuck claims, dead letters, each with a sparkline (P1, P2, P5, P8, P11).
- A queue table sorted by "share of wait target used", not by name or count, so the queue in most trouble is always on top (P1, P2); on phone it becomes cards.
- Queue detail: oldest waiting item against the target with a written explanation when the count falls but the age still rises (`prototype/console.html:287`), items by state (P3), throughput (P5), consumers with heartbeat and claims held (P7, P8b), errors grouped by fingerprint with "succeeds on retry" or "same item fails every time" (P10b, P9).
- An items table with tabs (waiting, in flight, stuck, retry scheduled, dead) and an item journey drawer (P16).
- Guarded actions from where the problem is shown: "Release 25 claims..." on the silent consumer, "Pause consuming..." on the queue (P17).
- Borrowed from: RabbitMQ management (one row per queue, ready vs unacknowledged), Sidekiq (latency next to size, the Busy view), Oban Web (actions on what you are looking at), Hangfire (a stale server's jobs are named as probably aborted).

### B. Flow map (`prototype/flow.html`)

For the people who own the pipeline rather than the shift: team leads, service owners, capacity planning.
It answers "where does work pile up between the file and the ledger, and when will it clear?"

- A map with producers on the left, queues in the middle and consumers on the right, drawn from the `producer` and `claimed_by` columns so a new service appears without configuration.
  Lines thicken with items per minute; each queue node fills up as its oldest item uses up its wait target; failing-and-retrying flows are dashed red (P1, P5).
- Burrow-style consumer verdicts instead of thresholds: OK, WARN (lag rising at every sample), STALL (holding, not finishing), STOP (no heartbeat), ERR (more attempts fail than succeed) (P19; prototype rules at `prototype/flow.html:207`).
- End-to-end p95 from file row to ledger posting (P6).
- A drain forecast for the selected queue: when the backlog clears and when the oldest item is back within target (P14), with a what-if: add consumers, or restart the silent one and release its claims.
  It also says when more consumers would not help because throughput is limited by failures (`prototype/flow.html:378`).
- "Who filled it, who drains it": waiting items by upstream file and completions by consumer (P12, P7).
- Upstream files in flight with progress and an ETA per file (P13, P13b), which is the question payments operations actually asks.
- Borrowed from: Kafka UI consumer lag with trend, LinkedIn Burrow's evaluation rules and window completeness, RabbitMQ's consumer capacity hint, service maps.

### C. Triage (`prototype/triage.html`)

For on call and payments operations, who need sentences rather than charts, and for whoever writes the incident ticket.
It answers "what is wrong, why does the console think so, and what is the safe next step?"

- A headline in plain English, for example "payments.inbound is 48 minutes behind its 15-minute target", followed by a paragraph that connects the causes (the 48,000-row file, the silent consumer, the gateway timeouts) and says when it should recover (P1, P2, P12, P14).
- Findings ranked by urgency (at 12:06: the ledger retry storm, payments and ledger past their wait targets, 621 dead postings, mmp-app-03's stuck claims and the poison item; a producer-spike finding fires while the big file lands), each with the facts behind it, numbered safe next steps, a guarded action button, and "How this was detected" showing the plain SQL rule (P2, P8b, P9, P10, P11, P12, P12b, P17).
  The rules are evaluated in `prototype/assets/sim.js:415`.
- Errors by kind: dependency (many items, one error, in a burst: pause, wait, retry in bulk), data (the same item fails the same way on different consumers: repair the item), transient (passes on retry: only a rising rate matters) (P10b, P9).
- "Where is my item?": search by item id, payment reference or file name, with the item's journey (P16).
- A timeline of today and a "Draft incident notes" button that turns the timeline and open findings into Markdown for the ticket.
- Wait target today as 10-minute cells per queue with minutes past target against a daily budget (P20).
- Borrowed from: Hangfire's "Looks like the job was aborted" sentence, GoodJob's Discard Cleaner (errors grouped by class and exception), pg-boss's typed warnings, Burrow's explicit evaluation rules.

### How the three relate

They share the same data, the same scrubber and the same guarded action component, so they can become three tabs of one product rather than three products.
A is the everyday surface, C is what A should open when something is wrong, and B is for the weekly capacity conversation and for explaining an incident to people outside the team.
The prototypes link to each other at the same minute (for example "Open in the control room" on a triage finding).

## Assumed schema (map this to the real DBQ)

I had no access to the real code, schema or data, so `sql/schema.sql` assumes one generic queue table plus optional helper tables.
Only `dbq_item` is assumed to exist today; everything else is a recommendation.

### `dbq_item`, one row per work item (`sql/schema.sql:10`)

| Column | Meaning | Used by | If the real table lacks it |
| --- | --- | --- | --- |
| `id` | Primary key. | All item views, P16, P17. | Required. |
| `queue_name` | Topic, for example `payments.inbound`. | Everything. | If each queue is its own table, generate one `UNION ALL` view with a literal queue name per table. |
| `status` | `QUEUED`, `CLAIMED`, `PROCESSING`, `DONE`, `FAILED` (failed, waiting for its retry), `DEAD`, `CANCELLED` (added by the console's cancel action). | Everything. | Map the real values in one view; see the state mapping below. |
| `priority` | Claim order hint. | Not used by any panel yet. | Optional. |
| `payload_ref` | Business key or pointer to the payload. | P2, P16 search. | Search by id only. |
| `producer` | Who wrote the item, for example AIS. | P12, flow map. | Infer from `queue_name`. |
| `batch_ref` | Upstream file name or batch id. | P12, P13, P13b, triage "86% of the backlog is one file". | The "which file" question cannot be answered; worth adding. |
| `created_at` | When it was written. | P1, P5, P6, P12, P13, P14. | Required. |
| `available_at` | Not claimable before this (retry backoff, delayed delivery). | Claim, P1 waiting vs scheduled, P2, P6, P14. | Without it, waiting and in-backoff cannot be told apart and lag after a retry is wrong. |
| `claimed_by` | Worker id, for example `mmp-app-03:4211` (host:pid). | P7, P8, P17, flow map. | Stuck claims cannot be attributed to a worker. |
| `claimed_at` | When the current attempt was claimed. | P6, P8 fallback. | Required for wait percentiles. |
| `heartbeat_at` | Refreshed by the worker while it holds the claim. | P1 stuck, P8, P17 guard. | Stuck can only be guessed from claim age, which cannot tell a slow item from a dead worker. |
| `attempts`, `max_attempts` | Attempt count and limit. | P2 backoff, P9, P17. | Required for poison and retry views. |
| `last_error` | Message of the last failure. | P10, P17d. | Required for fingerprints. |
| `completed_at` | Set on `DONE`, `DEAD` and `CANCELLED`. | P1, P5, P6, P7, P15. | Required for throughput. |

### Status to console state

| Console state | Predicate |
| --- | --- |
| Waiting | `status IN ('QUEUED','FAILED') AND available_at <= now` |
| Scheduled (retry backoff or delayed) | `status IN ('QUEUED','FAILED') AND available_at > now` |
| In flight | `status IN ('CLAIMED','PROCESSING') AND heartbeat_at >= now - stale_after_s` |
| Stuck | `status IN ('CLAIMED','PROCESSING') AND coalesce(heartbeat_at, claimed_at) < now - stale_after_s` |
| Dead | `status = 'DEAD'` |
| Done | `status = 'DONE'` (kept for a retention window, then purged or archived) |

### Optional helper tables (`sql/schema.sql:57`)

| Table | Purpose | Panels |
| --- | --- | --- |
| `dbq_queue_config` | Per-queue wait target (`slo_wait_s`), stale threshold (`stale_after_s`, default 90 = three missed 30 s heartbeats), `paused` switch, owner team. | P1, P2, P4, P8, P14, P15, P17, claim query. |
| `dbq_worker` | Process heartbeat registry, so a dead consumer is visible even when it holds no claims. | P1 consumers, P7, P17 second guard, P19 STOP. |
| `dbq_attempt` | One row per finished attempt (worker, start, finish, outcome, error). | P7 failures, P9, P10b, P11, P16, P18. |
| `dbq_snapshot` | One row per queue per minute, written by the P18 job, so history never comes from the hot table. | P3, P4, P11 baseline, P15, P19, P20. |
| `dbq_action_audit` | Every operator action with actor, approver, predicate, expected and affected counts, item ids and reason. | P16, P17. |
| `dbq_fingerprint(text)` | `last_error` with quoted values, UUIDs and numbers masked, so identical failures group. | P9, P10, P11, P17d. |

### Consumer-side behaviour the console relies on (`sql/panels.sql:14`)

The console is only as safe as the claim protocol underneath it, so these are worth checking in MMP before anything else.
Simplified from the tested block, which uses literal worker ids and the frozen test clock.

```sql
-- Claim up to 25 ready items, oldest first, skipping rows other workers have locked; respects the pause switch.
WITH next AS (
  SELECT i.id FROM dbq_item i
  WHERE i.queue_name = :queue AND i.status IN ('QUEUED','FAILED') AND i.available_at <= now()
    AND NOT coalesce((SELECT c.paused FROM dbq_queue_config c WHERE c.queue_name = :queue), false)
  ORDER BY i.available_at, i.id
  LIMIT 25
  FOR UPDATE SKIP LOCKED)
UPDATE dbq_item i
SET status = 'PROCESSING', claimed_by = :me, claimed_at = now(), heartbeat_at = now(), attempts = i.attempts + 1
FROM next WHERE i.id = next.id
RETURNING i.id, i.payload_ref, i.attempts;

-- Heartbeat every 30 s while holding claims.
UPDATE dbq_item SET heartbeat_at = now()
WHERE queue_name = :queue AND claimed_by = :me AND status IN ('CLAIMED','PROCESSING');

-- Fenced completion: 0 rows means the claim was released (for example by the console), so do not treat the item as done.
UPDATE dbq_item SET status = 'DONE', completed_at = now()
WHERE id = :id AND claimed_by = :me AND status = 'PROCESSING';
```

Evidence: two sessions claiming at once did not block each other and got consecutive batches (A: ids 85580222-85580248, B: 85580249-85580276); after releasing mmp-app-03's claims, its late completion `UPDATE ... WHERE id = 85541338 AND claimed_by = 'mmp-app-03:4211' AND status = 'PROCESSING'` changed 0 rows.

### Questions to answer when mapping to the real tables

1. Which database engine and version hosts the DBQ (PostgreSQL, Oracle or SQL Server)?
   This decides the index technique (`sql/dialects.md:17`) and whether Grafana needs an Enterprise plugin.
2. One table with a queue column, or one table per queue?
3. Is there a heartbeat column, and how often is it refreshed?
4. Is completion fenced on `claimed_by` and status?
   If not, releasing a stuck claim can make an item run twice, and the release action must wait until it is.
5. Is `claimed_by` kept on `DONE` rows (per-consumer throughput needs it)?
6. How long are `DONE` rows kept, and is there an attempt history anywhere (an audit or log table)?
7. Does the item carry the upstream file name or batch id?

## Prior art: what each shows and what to steal

Checked on 2026-10-16 against official docs, READMEs or source code; anything not confirmed is marked.

| Tool | What it shows that matters here | Steal |
| --- | --- | --- |
| Oban Web (Elixir, Postgres) | Job detail, realtime charts by node, queue, state and worker; bulk cancel, delete or retry on the current filter; pause and scale queues; read-only for non-admins; refresh pauses when the tab is hidden. | Bulk actions defined as "everything matching this filter"; read-only by default; stop polling hidden tabs so idle consoles do not load the shared database. |
| Hangfire Dashboard (.NET) | One page per state; Servers page with a heartbeat column; a processing job on a stale server says "Looks like the job was aborted" and names the server; `IsReadOnlyFunc`. | Join every in-flight row to a worker heartbeat registry and say "probably aborted" on the row; show "claimed but not started" separately; deny by default. |
| Rails Mission Control Jobs with Solid Queue | Failed, in progress, blocked, scheduled, finished; counts capped at 500,000 and shown as infinity above; destructive bulk operations are console-only by design; Solid Queue fails (does not retry) jobs claimed by a dead process because "the job itself might be what's killing the process". | Capped counts keep the landing page cheap; keep destructive bulk actions behind a stronger role; record "claimed by a dead worker" as its own reason. |
| River UI (Go, Postgres) | Per-state counts tagged `exact`, `exact_cached`, `estimated` or `lower_bound` with `observed_at`; a background query cacher refreshes about every 10 s with jitter and backs off when queries are expensive; "Full exact scans are never part of request latency." | Tag every number with its accuracy and age; compute aggregates in one shared background loop, never per page view. This is the strongest single idea for a console on a shared bank database. |
| pg-boss dashboard (Node, Postgres) | Overview with largest backlogs and recent warnings; a typed `warning` table (`slow_query`, `queue_backlog`, `xmin_horizon`, `handler_overrun`); `readyOldestSeconds` as the stall signal because "a queue whose workers have stopped records no waits at all"; read-only mode returns 403 for writes. | Oldest-ready age as the headline; typed warnings in a table; database health (long transactions, vacuum) next to queue health. |
| Sidekiq Web (Redis) | Size and latency per queue; Busy page with each process's threads and current job, Quiet and Stop; metrics with deploy markers. | Latency next to depth on every queue; deploy markers; a "quiet" (stop claiming) control per worker. |
| PGMQ (Postgres extension) | `pgmq.metrics()` returns queue length, visible length, oldest and newest age, total and scrape time; no official UI or exporter found (unconfirmed). | One SQL view returning a row per queue, shared by the UI, Prometheus and Splunk (P1's `dbq_queue_now`). |
| Kafka UI (kafbat) | Consumer group lag with a trend arrow against the previous poll; per-partition lag; RBAC, masking, audit of changes only. | Lag trend arrows; audit only changes. |
| LinkedIn Burrow | "NO THRESHOLDS": each group is evaluated over a sliding window as OK, WARN, STALL, STOP or REWIND, with a `complete` fraction for partial windows. | Verdicts from a window of snapshots (P19), with window completeness. |
| RabbitMQ management | Ready vs unacknowledged; publish, deliver, ack and redeliver rates; consumer capacity "merely a hint"; keeps only recent data and recommends Prometheus for history. | Ready vs claimed split; redeliveries as reclaims after a rescue; a hint that says whether more consumers would help; send long history elsewhere. |
| JobRunr, db-scheduler(-ui), Quartz (Java, database-backed) | Server heartbeats with dead thresholds as missed beats; `consecutive_failures`; picked-but-not-started rows that never heartbeat; db-scheduler-ui's `read-only=true` and a Spring Security example (GET for users, POST for admins). | Dead = N missed heartbeats; Spring Security split by HTTP method, which fits a Spring Boot console. |
| GoodJob (Rails, Postgres) | Queue latency vs execution latency; a Discard Cleaner that groups discarded jobs by class and exception over 1 hour to 7 days. | Errors grouped by normalised signature in time windows (P10, P10b); queue latency and run latency kept separate (P6). |

How other systems rescue stuck work, and the lesson for the DBQ:

- Time-based rescue (Oban Lifeline, River's rescuer, pg-boss expiry) is simple but cannot tell a slow item from a dead worker.
- Per-job heartbeats (pg-boss, db-scheduler, JobRunr) and per-process heartbeats (Solid Queue, Hangfire, Sidekiq Pro) can.
- The robust pattern is: separate "worker died" (heartbeat) from "attempt too long" (expiry), fence stale workers so a late completion changes nothing, and count recoveries so a message that keeps killing workers is quarantined instead of retried forever.

Sources: oban-web.hexdocs.pm/overview.html; docs.hangfire.io (using-dashboard) and the Hangfire `Strings.resx`; github.com/rails/mission_control-jobs and github.com/rails/solid_queue; github.com/riverqueue/riverui (`handler_api_endpoint.go`, `internal/querycacher/query_cacher.go`); pgboss.io/dashboard and github.com/timgit/pg-boss docs; github.com/sidekiq/sidekiq wiki (Monitoring, Metrics, Reliability); pgmq.github.io/pgmq; github.com/kafbat/kafka-ui; github.com/linkedin/Burrow wiki (Consumer Lag Evaluation Rules); rabbitmq.com/docs (management, monitoring, prometheus, consumers); jobrunr.io docs; github.com/kagkarlsson/db-scheduler and github.com/bekk/db-scheduler-ui; quartz-scheduler.org 2.3.0 configuration; github.com/bensheldon/good_job.

## Light bulb ideas

Each idea says where it shows up in the prototypes and which query backs it.

1. **Lag is the age of the oldest waiting item, not the count.**
   A queue with 30,000 items that drains in a minute is fine; a queue with 5 items that has not moved in 20 minutes is not.
   Control room's "Worst wait" tile and the oldest-wait chart (P2, P4); pg-boss and Sidekiq both lead with it.
2. **Lag must include retry backoff, or a dependency outage looks healthy.**
   Measured: ledger.postings showed 1 s lag and "OK" while 774 failed items waited in backoff, the oldest written 571 s ago against a 300 s target.
   P2 returns `in_backoff` and `oldest_backoff_age_s` next to the lag.
3. **"The count is falling but the oldest item is still getting older."**
   In the sample day the payments.inbound count peaks at 45,514 at 11:20 and falls from 11:32, but the wait is not back within target until 12:45: a count chart looks like recovery for over an hour while the target is still breached.
   The console says so in words (`prototype/console.html:287`, P4, P14).
4. **Stuck means a silent heartbeat, and the console names the worker and its claims.**
   At 10:42 nothing looks wrong on counts; the only signal is 28 claims whose heartbeat stopped, all held by `mmp-app-03:4211` (P8, P8b, P7).
   A process registry (`dbq_worker`) also catches a dead consumer that holds no claims, and gives "3 of 4 consumers heartbeating".
5. **Fence completion before you add a release button.**
   Releasing a stuck claim is only safe if the hung worker's late completion changes 0 rows; the release itself re-checks both the claim heartbeat and the worker heartbeat at write time (CONTEXT, P17b).
6. **Tell a poison message from a retry storm.**
   The textbook rule (many attempts, one error, several workers) also matched every one of 4,159 storm victims; the fix is to flag poison only when 3 or fewer items failed with the same fingerprint in 24 hours (P9).
   The two need opposite actions: repair one item, or pause and wait for a dependency.
7. **Error fingerprints, and actions by fingerprint.**
   Masking quoted values, UUIDs and numbers turns 8,750 failures into one line, and "retry the 225 dead postings with this fingerprint" becomes one guarded statement (P10, P10b, P17d).
8. **A retry storm detector with nothing to tune per queue.**
   Failures in the last 10 minutes at least ten times the queue's own 3-hour median and at least 5 a minute, over at least 20 items, with one cause at 80% or more (P11).
   The triage page turns that into "adding consumers or retrying faster will not help".
9. **Verdicts instead of thresholds.**
   Burrow-style OK, WARN, STALL, STOP and ERR from a 10-minute window of snapshots, with window completeness so a new queue is not judged on two samples (P19, flow map).
10. **Name the file.**
    Arrivals by producer and `batch_ref` turn "the queue is big" into "86% of the backlog is DEMO_FPS_BULK_20261015_1112.csv, which landed at 11:15", and a spike detector compares the last hour with the busiest same hour of the previous 7 days (P12, P12b).
11. **Progress and ETA per upstream file.**
    "When will file X be done?" is what payments operations actually asks; FIFO position at the current pace answers it (P13, P13b, flow page).
12. **"Back within target around 12:43", not just "the backlog clears at".**
    People need the time the target is met again, which is not the time the count reaches zero: on the seed, P14 gives back within target at 13:17:49 and the backlog clearing at 13:19:19.
    In the prototype, the 12:06 triage headline says "back within target around 12:43", and the simulated day gets there at 12:45.
    The forecast models the line in FIFO order and falls back to a steady-rate formula when every waiting item will breach (P14), and the flow page's what-if shows what one more consumer, or restarting the silent one, would buy.
13. **Say when more consumers will not help.**
    When more than half of attempts fail, throughput is limited by the dependency, not by capacity, and the flow page says so instead of offering capacity (`prototype/flow.html:378`); RabbitMQ's consumer capacity hint is the same idea.
14. **Classify errors by kind to pick the next step.**
    Dependency (many items, one error, a burst: pause, wait, retry in bulk), data (one item, same error on different consumers: repair the item), transient (passes on retry: watch the rate) (triage "Errors by kind").
15. **Every finding shows its rule.**
    Each triage card has "How this was detected" with the plain SQL; rules are reviewable by the team, portable to Grafana or Splunk alerts, and explain themselves in an audit.
16. **Guarded actions as a component.**
    Dry-run count, the exact SQL, a reason that goes to the audit log, four-eyes for bulk, the predicate re-checked at write time, the audit row written in the same statement with the item ids, capped batches with `SKIP LOCKED`, and retries staggered 200 ms apart so a recovering gateway is not stampeded (P17).
17. **Item journey by any key.**
    Search by id, payment reference or file name, and see created, every attempt with worker and error, the claim and heartbeat, and any operator action taken on it (P16).
18. **The incident timeline writes itself.**
    The day's findings with first-seen times become a timeline and a "Draft incident notes" Markdown export for the ticket (triage page).
19. **Replay any minute.**
    Every view can be rewound to any minute of the day from the snapshot table, and the URL (`#t=11:31`) is shareable, so "what did it look like when the breach started" is a link, not a screenshot (shared scrubber in `prototype/assets/ui.js`).
20. **Every number says how fresh and how exact it is.**
    From River: one background loop computes aggregates for every viewer, and counts are tagged exact, estimated or capped ("500k+") with their age, so a console never adds per-viewer load to a shared bank database.
21. **SLO burn and a wait-target strip per queue.**
    Minutes past target against a 30-day budget with a burn rate (P15), and today as 10-minute cells with "36 min past target, 7.5x the daily budget" (P20).
22. **Put database health and deploys next to queue health (not prototyped).**
    pg-boss's point: a backlog caused by too few consumers looks exactly like one caused by long transactions or vacuum falling behind; show long-running transactions, lock waits and deploy markers (Sidekiq) on the same timeline.

## Panels: SQL, indexes and measured cost

All queries are in `sql/panels.sql` (PostgreSQL 17 dialect); the line is the panel's `-- @@` marker.
"Measured" is the warm run on 1,645,739 item rows and 262,235 attempt rows on an Apple M3 with default settings (`shared_buffers` 128 MB).
`dbq_now()` is a frozen test clock (2026-10-15 12:06:00); production uses `LOCALTIMESTAMP` with every service in UTC.

| ID | Question it answers | Concepts | SQL | Needs | Measured |
| --- | --- | --- | --- | --- | --- |
| CONTEXT | Claim, heartbeat, fenced completion (consumer side). | All | `panels.sql:14` | ready index; `available_at`, `heartbeat_at`, `claimed_by`; `paused` | 1.6 ms for a claim of 25 (SELECT 0.017 ms) |
| P1 | How is every queue doing right now? Waiting, scheduled, in flight, stuck, dead, oldest wait, in and out per minute, consumers. | A, B, C | `panels.sql:48` (view `dbq_queue_now`) | ready, claimed, dead, created, completed indexes; `dbq_queue_config`; `dbq_worker` | 6 rows, 7.4 ms |
| P2 | How old is the oldest waiting item, and how much is hiding in backoff? | A, C | `panels.sql:92` | ready index; `available_at`, `attempts` | 6 rows, 1.6 ms (plan 0.18 ms) |
| P3 | Items by state over time. | A | `panels.sql:119` | `dbq_snapshot` | 306 rows, 0.7 ms |
| P4 | Oldest wait over time against the target. | A, C | `panels.sql:125` | `dbq_snapshot`, `dbq_queue_config` | 306 rows, 0.9 ms |
| P5 | Arrived, completed and dead-lettered per minute, zero-filled. | A, B | `panels.sql:132` | created, completed indexes | 59 rows, 16.8 ms |
| P6 | Wait, processing and end-to-end percentiles. | B | `panels.sql:157` | completed index; `claimed_at` | 1 row, 5.6 ms |
| P7 | Each consumer: heartbeat, claims held, completed and failed in 5 minutes, state. | A, B | `panels.sql:168` | `dbq_worker`; claimed, completed indexes; `dbq_attempt_finished_ix`; `claimed_by` kept on DONE | 4 rows, 3.4 ms |
| P7b | Consumers without a registry. | Fallback | `panels.sql:199` | claimed, completed indexes | 4 rows, 1.6 ms |
| P8 | Which claims are stuck? | A | `panels.sql:213` | claimed index; `heartbeat_at` | 28 rows, 1.3 ms (plan 0.078 ms) |
| P8b | Stuck claims grouped by worker. | A, C | `panels.sql:223` | claimed index | 2 rows, 1.3 ms |
| P9 | Which items are poison, not storm victims? | A, C | `panels.sql:234` | `dbq_attempt`; `dbq_fingerprint` | 50 rows, 110 ms |
| P10 | Open errors (retrying or dead) grouped by fingerprint. | A, C | `panels.sql:265` | ready, dead indexes; `dbq_fingerprint` | 2 rows, 11.9 ms |
| P10b | Error fingerprints over the last 60 minutes of attempts. | A, C | `panels.sql:277` | `dbq_attempt_finished_ix` | 5 rows, 67.3 ms |
| P11 | Is this a retry storm? | A, C | `panels.sql:287` | `dbq_attempt_finished_ix`; `dbq_snapshot.failed_1m` | 6 rows, 34.3 ms |
| P12 | Who filled the queue, by producer and file? | B, C | `panels.sql:314` | created index; `producer`, `batch_ref` | 5 rows, 12.6 ms |
| P12b | Is this an arrival spike against the same hour of the last 7 days? | C | `panels.sql:322` | created index | 6 rows, 19.4 ms |
| P13 | Progress of today's upstream files. | B | `panels.sql:340` | created, batch indexes | 12 rows, 29.2 ms |
| P13b | When will this file's last item be done? | B | `panels.sql:357` | batch, ready, completed indexes | 1 row, 4.9 ms |
| P14 | When does the backlog clear, and when is the oldest item back within target? | A, B, C | `panels.sql:376` | ready, created, completed indexes | 1 row, 20.5 ms |
| P15 | SLO burn over 30 days: breach minutes, budget left, burn rate. | (report) | `panels.sql:412` | `dbq_snapshot` | 6 rows, 1.3 ms |
| P15b | Share of today's completed items that waited longer than the target. | (report) | `panels.sql:427` | completed index | 6 rows, 203.7 ms |
| P16 | One item's journey, by id, business key or file. | A, C | `panels.sql:437` | PK; `dbq_attempt` PK; payload and batch indexes; audit `item_ids` | 1 + 22 rows, 0.6 + 0.8 ms |
| P17 | Actions: preview, release stale claims, retry one, retry dead by fingerprint, cancel, pause. | A, C | `panels.sql:460` | claimed, dead indexes; PK; `dbq_action_audit` | 0.1-5.7 ms each |
| P18 | Snapshot writer, once a minute. | Feeds P3, P4, P11, P15, P19, P20 | `panels.sql:550` | view `dbq_queue_now`; created, completed, attempt indexes | 6 rows, 7.8 ms |
| P19 | Queue verdict over the last 10 minutes (OK, WARN, STALL, ERR) and consumers with no heartbeat (STOP). | B | `panels.sql:566` | `dbq_snapshot`, `dbq_worker` | 6 rows, 1.4 ms |
| P20 | Wait target today in 10-minute cells, and minutes past target against a daily budget. | C | `panels.sql:599` | `dbq_snapshot` | 186 + 6 rows, 1.0 + 0.6 ms |

P19 and P20 were added in this pass for the flow map's verdicts and the triage strip; on the seed they return ledger.postings ERR (6,049 failures against 4,018 completions in 10 minutes), payments.inbound WARN with one consumer STOP, mandates.inbound OK with one consumer STOP, and payments.inbound 35 minutes past target today (7.3 times the daily budget).
After adding them, `psql -v ON_ERROR_STOP=1 -f panels.sql` still exits 0.

### The core queries in full

These are the queries a first version needs, plus the two detectors that most need to be exactly right.
They are copied from `sql/panels.sql` with `dbq_now()` written as `now()`, and literal test values and psql variables written as `:name` parameters.

P1, queue overview, as a view so the snapshot job stores exactly the same numbers (`panels.sql:48`):

```sql
CREATE OR REPLACE VIEW dbq_queue_now AS
SELECT c.queue_name,
       r.waiting, r.scheduled, f.in_flight, f.stuck, d.dead,
       extract(epoch FROM now() - o.oldest_available_at)::int AS oldest_wait_s,
       c.slo_wait_s,
       a.arrived_5m, k.completed_5m,
       round(a.arrived_5m / 5.0, 1)   AS in_per_min,
       round(k.completed_5m / 5.0, 1) AS out_per_min,
       w.consumers_alive, w.consumers_total
FROM dbq_queue_config c
CROSS JOIN LATERAL (
  SELECT count(*) FILTER (WHERE available_at <= now()) AS waiting,
         count(*) FILTER (WHERE available_at >  now()) AS scheduled
  FROM dbq_item WHERE queue_name = c.queue_name AND status IN ('QUEUED','FAILED')) r
CROSS JOIN LATERAL (
  SELECT min(available_at) AS oldest_available_at
  FROM dbq_item WHERE queue_name = c.queue_name AND status IN ('QUEUED','FAILED') AND available_at <= now()) o
CROSS JOIN LATERAL (
  SELECT count(*) FILTER (WHERE heartbeat_at >= now() - c.stale_after_s * interval '1 second') AS in_flight,
         count(*) FILTER (WHERE heartbeat_at IS NULL OR heartbeat_at < now() - c.stale_after_s * interval '1 second') AS stuck
  FROM dbq_item WHERE queue_name = c.queue_name AND status IN ('CLAIMED','PROCESSING')) f
CROSS JOIN LATERAL (
  SELECT count(*) AS dead FROM dbq_item WHERE queue_name = c.queue_name AND status = 'DEAD') d
CROSS JOIN LATERAL (
  SELECT count(*) AS arrived_5m FROM dbq_item
  WHERE queue_name = c.queue_name AND created_at > now() - interval '5 minutes' AND created_at <= now()) a
CROSS JOIN LATERAL (
  SELECT count(*) AS completed_5m FROM dbq_item
  WHERE queue_name = c.queue_name AND completed_at > now() - interval '5 minutes' AND completed_at <= now()
    AND status = 'DONE') k
CROSS JOIN LATERAL (
  SELECT count(*) FILTER (WHERE heartbeat_at >= now() - c.stale_after_s * interval '1 second') AS consumers_alive,
         count(*) AS consumers_total
  FROM dbq_worker WHERE queue_name = c.queue_name) w;
```

Driving every aggregate from the small config table with `LATERAL` is deliberate: PostgreSQL 17 has no skip scan, so one `GROUP BY queue_name` over the item table cannot use the `(queue_name, ...)` indexes, while each `LATERAL` becomes an index range scan on the matching partial index.

P2, oldest waiting item and the backoff it hides (`panels.sql:92`):

```sql
SELECT c.queue_name, o.id AS oldest_item_id, o.payload_ref,
       extract(epoch FROM now() - o.available_at)::int AS oldest_wait_s,
       extract(epoch FROM now() - o.created_at)::int   AS oldest_age_s,
       c.slo_wait_s,
       CASE WHEN o.id IS NULL THEN 'EMPTY'
            WHEN now() - o.available_at > c.slo_wait_s * interval '1 second'       THEN 'BREACH'
            WHEN now() - o.available_at > c.slo_wait_s * 0.5 * interval '1 second' THEN 'WARN'
            ELSE 'OK' END AS lag_status,
       b.in_backoff,
       extract(epoch FROM now() - b.oldest_backoff_created_at)::int AS oldest_backoff_age_s
FROM dbq_queue_config c
LEFT JOIN LATERAL (
  SELECT id, payload_ref, available_at, created_at FROM dbq_item
  WHERE queue_name = c.queue_name AND status IN ('QUEUED','FAILED') AND available_at <= now()
  ORDER BY available_at LIMIT 1) o ON true
CROSS JOIN LATERAL (
  SELECT count(*) AS in_backoff, min(created_at) AS oldest_backoff_created_at FROM dbq_item
  WHERE queue_name = c.queue_name AND status IN ('QUEUED','FAILED') AND available_at > now() AND attempts > 0) b
ORDER BY oldest_wait_s DESC NULLS LAST;
```

P8b, stuck claims grouped by worker (`panels.sql:223`; P8 at `panels.sql:213` lists the items):

```sql
SELECT i.queue_name, i.claimed_by, count(*) AS stuck_claims,
       min(i.claimed_at) AS first_claimed_at, max(i.heartbeat_at) AS last_heartbeat_at,
       extract(epoch FROM now() - max(i.heartbeat_at))::int AS silent_s
FROM dbq_item i
JOIN dbq_queue_config c USING (queue_name)
WHERE i.status IN ('CLAIMED','PROCESSING')
  AND coalesce(i.heartbeat_at, i.claimed_at) < now() - c.stale_after_s * interval '1 second'
GROUP BY i.queue_name, i.claimed_by
ORDER BY stuck_claims DESC;
```

P10, open errors by fingerprint (`panels.sql:265`; the fingerprint function is at `schema.sql:124`):

```sql
SELECT queue_name, dbq_fingerprint(last_error) AS fingerprint,
       count(*) AS items,
       count(*) FILTER (WHERE status = 'DEAD')  AS dead,
       count(*) FILTER (WHERE status <> 'DEAD') AS retrying,
       min(id) AS sample_item_id
FROM dbq_item
WHERE ((status IN ('QUEUED','FAILED') AND last_error IS NOT NULL) OR status = 'DEAD')
GROUP BY 1, 2
ORDER BY items DESC
LIMIT 20;
```

P11, retry storm detector (`panels.sql:287`):

```sql
SELECT c.queue_name, r.failed_10m, r.items_10m, round(r.failed_10m / 10.0, 1) AS failed_per_min,
       b.baseline_per_min, t.top_fingerprint,
       round(t.top_n::numeric / nullif(r.failed_10m, 0), 2) AS top_share,
       (r.failed_10m / 10.0 >= greatest(5, 10 * b.baseline_per_min)
        AND r.items_10m >= 20
        AND t.top_n::numeric / nullif(r.failed_10m, 0) >= 0.8) AS is_storm
FROM dbq_queue_config c
CROSS JOIN LATERAL (
  SELECT count(*) AS failed_10m, count(DISTINCT item_id) AS items_10m FROM dbq_attempt a
  WHERE a.queue_name = c.queue_name AND a.outcome = 'FAILED'
    AND a.finished_at > now() - interval '10 minutes' AND a.finished_at <= now()) r
CROSS JOIN LATERAL (
  SELECT coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY s.failed_1m), 0)::numeric AS baseline_per_min
  FROM dbq_snapshot s WHERE s.queue_name = c.queue_name AND s.taken_at > now() - interval '3 hours') b
LEFT JOIN LATERAL (
  SELECT dbq_fingerprint(a.error) AS top_fingerprint, count(*) AS top_n FROM dbq_attempt a
  WHERE a.queue_name = c.queue_name AND a.outcome = 'FAILED'
    AND a.finished_at > now() - interval '10 minutes' AND a.finished_at <= now()
  GROUP BY 1 ORDER BY 2 DESC LIMIT 1) t ON true
ORDER BY r.failed_10m DESC;
```

P17b, guarded release of a dead worker's claims, audited in the same statement (`panels.sql:472`):

```sql
WITH released AS (
  UPDATE dbq_item i
  SET status = 'QUEUED', claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL   -- available_at kept: front of the line
  FROM dbq_queue_config c
  WHERE c.queue_name = i.queue_name
    AND i.queue_name = :queue AND i.claimed_by = :worker AND i.status IN ('CLAIMED','PROCESSING')
    AND i.heartbeat_at < now() - c.stale_after_s * interval '1 second'
    AND EXISTS (SELECT 1 FROM dbq_worker w
                WHERE w.worker_id = i.claimed_by AND w.queue_name = i.queue_name
                  AND w.heartbeat_at < now() - c.stale_after_s * interval '1 second')
  RETURNING i.id)
INSERT INTO dbq_action_audit (actor, approver, action, queue_name, predicate, expected, affected, item_ids, reason, created_at)
SELECT :actor, :approver, 'RELEASE_STALE_CLAIMS', :queue, :predicate_text, :expected, count(*),
       array_agg(id ORDER BY id), :reason, now()
FROM released
RETURNING expected, affected;
-- The application commits only when affected = expected; otherwise it rolls back and shows a fresh preview.
```

P18, snapshot writer, run once a minute by exactly one scheduler (`panels.sql:550`):

```sql
INSERT INTO dbq_snapshot (queue_name, taken_at, waiting, scheduled, in_flight, stuck, dead, oldest_wait_s,
                          arrived_1m, completed_1m, failed_1m)
SELECT q.queue_name, date_trunc('minute', now()), q.waiting, q.scheduled, q.in_flight, q.stuck, q.dead, q.oldest_wait_s,
       (SELECT count(*) FROM dbq_item a WHERE a.queue_name = q.queue_name
          AND a.created_at > now() - interval '1 minute' AND a.created_at <= now()),
       (SELECT count(*) FROM dbq_item d WHERE d.queue_name = q.queue_name AND d.status = 'DONE'
          AND d.completed_at > now() - interval '1 minute' AND d.completed_at <= now()),
       (SELECT count(*) FROM dbq_attempt f WHERE f.queue_name = q.queue_name AND f.outcome = 'FAILED'
          AND f.finished_at > now() - interval '1 minute' AND f.finished_at <= now())
FROM dbq_queue_now q
ON CONFLICT (queue_name, taken_at) DO NOTHING;
```

The other panels follow the same patterns: time-bucketed counts on the created and completed indexes (P5, P12, P12b), reads of the snapshot table (P3, P4, P15, P19, P20), a FIFO position with `row_number()` over the ready index (P13b, P14), and `UNION ALL` of the item, its attempts and its audit rows (P16).

### Index evidence

| Query | With its index | Without it | Plan without it |
| --- | --- | --- | --- |
| P2 oldest waiting | 0.18 ms, Index Scan on `dbq_item_ready_ix`, 575 buffers | 614-634 ms, about 3,400 times slower | Bitmap scan of the whole queue on `dbq_item_created_ix` (about 274,000 rows per queue), 268,916 rows removed by filter, 194,441 buffers |
| P8 stuck claims | 0.078 ms, Index Scan on `dbq_item_claimed_ix`, 143 buffers | 98-103 ms, about 1,300 times slower | Seq Scan on `dbq_item`, 1,645,323 rows removed, 33,715 buffers |
| Claim of 25 | 0.017 ms, Index Scan, no sort | 6.6 ms with the pause check written as a correlated `NOT EXISTS` | Bitmap Heap Scan of all 30,007 ready rows plus a sort, growing with the backlog |

The partial indexes are tiny because they only hold open rows: ready 2.0 MB, claimed 16 kB, dead 32 kB, against 114-117 MB for the full created and completed indexes (`sql/schema.sql:32`).
The "without" times grow with total table size and the "with" times with the number of open rows, so on a production table holding months of `DONE` history the gap is larger.

The three indexes a first version needs (`sql/schema.sql:35`):

```sql
CREATE INDEX dbq_item_ready_ix   ON dbq_item (queue_name, available_at, id) WHERE status IN ('QUEUED','FAILED');
CREATE INDEX dbq_item_claimed_ix ON dbq_item (queue_name, claimed_by, heartbeat_at) WHERE status IN ('CLAIMED','PROCESSING');
CREATE INDEX dbq_item_completed_ix ON dbq_item (queue_name, completed_at) WHERE completed_at IS NOT NULL;
```

The ready index also speeds up MMP's own claim query, which is a good argument for the DBA review.

### Traps found by running the SQL against the story

1. Backoff hides lag: ready-item lag showed 1 s on ledger.postings while 774 items waited in backoff (fixed in P2 with `in_backoff` and `oldest_backoff_age_s`).
   The time-based SLO (P15) and today's strip (P20) are computed from the same oldest-wait column, so they also miss it: on the seed, ledger.postings shows 0 minutes past target.
   The real build should snapshot the backoff age too and judge the target on the larger of the two, as the prototype already does (triage shows "ledger.postings is 5m 16s behind" its 5-minute target at 12:06).
2. The textbook poison rule matched every storm victim; poison now requires 3 or fewer items with the same fingerprint in 24 hours (P9).
3. The drain forecast returned an empty "back within target" when every waiting item would breach; it now falls back to a steady-rate model (P14).
4. A correlated pause check in the claim query made the planner sort the whole ready set before `LIMIT`; an uncorrelated scalar subquery reads 25 index entries.
5. The retry-storm baseline (median failures per minute) is 0 for every queue, so the floor of 5 a minute is what stops one bad minute from being called a storm (P11).
6. The fingerprint must mask quoted values before numbers, or every IBAN and amount is its own group (`sql/schema.sql:124`).
7. In PostgreSQL, `FOR UPDATE` cannot be combined with window functions (P17d locks in one CTE and numbers rows in the next), and a subquery in the same statement reads the pre-update snapshot (the stagger is checked in a separate statement).
8. Exact counts grow with the backlog: `waiting` read 5,502 index entries per queue on average here; at millions of rows, cap it ("500k+") or read it from the latest snapshot.
9. P15b (203.7 ms) is the slowest query because it aggregates every item completed today; the snapshot job should keep a per-minute "completed over target" counter instead.
10. Per-consumer throughput needs `claimed_by` kept on `DONE` rows, the journey's action lookup needs a GIN index on `dbq_action_audit.item_ids` (or a child table on Oracle and SQL Server), and P9 wants a partial index `dbq_attempt (item_id) WHERE outcome = 'FAILED'` once the attempt log is large.
11. Run the snapshot job from exactly one scheduler (ShedLock or a database lock); the primary key makes duplicates harmless but not free.

### Other databases

`sql/dialects.md` translates the claim query, P1, P2, P8, P10 and the guarded release to Oracle 19c+ and SQL Server 2019+; these were not executed.
The points that matter most:

- Oracle has no partial indexes; index virtual columns that are `NULL` outside the open subset, and filter on those columns (`sql/dialects.md:43`).
- SQL Server filtered indexes work, but queries must repeat the literal predicate, and console reads need `READ_COMMITTED_SNAPSHOT`, or a count can block behind a claim (`sql/dialects.md:456`).
- Oracle's `REGEXP_REPLACE` can compute the fingerprint, but SQL Server has no regex before SQL Server 2025 (`sql/dialects.md:26`); on all three databases the robust answer is for the worker to write an error code or fingerprint column when it records a failure, which also removes the main cost of P9.
- In all three, fenced completion is plain SQL, and that is what makes releasing a stuck claim safe.

## Build options

| | Internal page in the Spring Boot estate | Grafana with a SQL data source | Splunk DB Connect | Micrometer gauges to Prometheus and Grafana |
| --- | --- | --- | --- | --- |
| First demo | 2-3 weeks | Days, if Grafana already reaches the DBQ database | Days, if DB Connect is already set up | About a week, plus dashboards |
| Current state (P1, P2, P8) | Yes | Yes | Yes, limited by the poll interval | Yes, as gauges |
| History | From `dbq_snapshot` | From `dbq_snapshot` with `$__timeFilter` | Strong, once indexed into Splunk | Strong (Prometheus) |
| Alerting | Needs a channel (or export to the others) | Built in; one row per queue becomes one alert instance | Built in | Built in (Alertmanager or Grafana) |
| Item search and journey | Yes | Awkward (table panels and variables) | Awkward, `dbxquery` returns at most 100,000 rows | No |
| Actions (release, retry, pause) | Yes, with Spring Security, four-eyes and audit | No, and it must not have write access | No: `dbxquery` cannot run INSERT or UPDATE | No |
| Load on the shared database | Controlled: one background loop for all viewers | Every panel refresh, viewer and alert rule runs the SQL; point it at a replica or the snapshot table | Each input runs on its schedule; rising inputs suit the append-only attempt log, batch inputs suit snapshots | A SQL-backed gauge runs on every scrape on every replica unless one task caches it |
| Database support | Any JDBC database | PostgreSQL, MySQL and SQL Server built in; Oracle and Db2 are Enterprise plugins | Any JDBC database | Any |
| Access control and audit | Spring Security split by HTTP method, audit table | Grafana roles; use a SELECT-only database user | Splunk roles | Not applicable |

Notes:

- Grafana "does not validate the safety of queries", so give it a SELECT-only user; a table result with one numeric column per row makes each row an alert instance, which suits one row per queue.
- Splunk DB Connect's `dbxquery` must be the first command in a search, returns at most 100,000 rows and times out after 600 s by default; rising-column inputs should not use timestamps as the rising column under high event rates.
- Micrometer gauges are sampled at publish time, and `MultiGauge` is meant for "a well-bounded but slightly changing set of criteria from something like an SQL query"; the safe pattern is for the snapshot job to feed the gauges, plus a snapshot-age gauge.

Recommendation: build the console as an internal page, because the questions that matter most during an incident (which item, which file, release these claims, retry these dead items) need item search and guarded writes, which Grafana and Splunk cannot safely provide.
Have the same snapshot job publish per-queue gauges (oldest wait, stuck, dead, verdict) through Micrometer, so the bank's existing alerting stack pages on them without running SQL per scrape.
If the captain's existing domain dashboards already live in Grafana or Splunk, the read-only panels can be added there first while the page is built; the SQL in `sql/panels.sql` is the same either way.

## Recommended first version (graduate-sized)

Goal: a read-only Control room that answers "which queue is in trouble, how old is its oldest item, is anyone stuck, what is failing" for every DBQ queue, and can be demoed against the seed story.

Scope:

1. **Map the schema.** Fill in the mapping table above with the real table and column names, and create one view (`dbq_item` over the real table or tables) so every query below works unchanged.
2. **Add the three indexes** (ready, claimed, completed) through the DBA, or their Oracle or SQL Server equivalents from `sql/dialects.md`.
3. **Add `dbq_queue_config` and `dbq_snapshot`**, and a scheduled job (Spring `@Scheduled` with ShedLock) that runs P18 once a minute.
4. **One page with five panels**, all read-only:
   - the queue table with waiting, oldest wait against target, in backoff, in flight, stuck, dead, in and out per minute (P1 with P2's backoff columns), sorted by share of target used;
   - oldest wait against target over the last 6 hours (P4) and throughput (P3 or P5);
   - stuck claims grouped by worker (P8b);
   - open errors by fingerprint (P10).
5. **Serve it from one background cache**, refreshed every 15-30 s by one loop for all viewers (River's pattern), with "as of 12:06:05" on the page; viewers never trigger SQL.
6. **Secure it** with Spring Security (read role only in this version) and a SELECT-only database user.
7. **Demo**: load `sql/schema.sql` and `sql/seed.sql` into a local PostgreSQL, replace `dbq_now()` to step through the day, and show the 10:42 stuck worker, the 11:31 breach and the 11:50 storm on the page.

Done means: every queue in the real DBQ appears without configuration beyond its wait target; the page loads in under a second with no per-viewer database load; the stuck-worker and backoff traps above are visible on the demo data.

What comes next, in order of value:

1. Item search and journey (P16), which needs an attempt log (`dbq_attempt`) written by the consumers.
2. Guarded actions (P17): release stale claims first, and only after fenced completion is confirmed in MMP; then pause and retry by fingerprint, with four-eyes and the audit table.
3. Triage findings (P8b, P9, P11, P12b, P14, P19) as rules, published as alerts.
4. The flow map and forecasts, for capacity planning.

## Decisions for the captain

These are product choices the report cannot make; the recommendation is the first option in each.
Both are carried by the captain-held backlog task `dbq-console-v1-d1`.

1. **Which direction to take forward**: the read-only Control room as v1, growing into Triage and actions (recommended); or Triage first as an alerting-and-sentences surface on top of existing dashboards; or the Flow map first if the main audience is management and capacity planning.
2. **How to build it**: an internal Spring Boot page with gauges exported to the existing alerting stack (recommended); or Grafana or Splunk panels using the same SQL, accepting no item search and no actions.

## Verification

### Browser checks

Every page was opened in headless Chrome through `chrome-devtools-axi` at 1440 x 900 (desktop) and 390 x 844 at device pixel ratio 2 with mobile and touch emulation (phone), each in light and dark (`prefers-color-scheme`), with full-page screenshots reviewed at both widths.
The commands were `chrome-devtools-axi emulate --viewport 390x844x2,mobile,touch --color-scheme dark` (or `1440x900x1`, or `light`), then `open file:///.../prototype/<page>.html`, an `eval`, `screenshot --full-page` and `console`.
The `eval` returned the viewport width (`vw`), the page's scroll width (`sw`), whether dark mode was active, and the first five visible non-fixed elements whose right edge passes the viewport:

```text
page     width  scheme       result (identical in light and dark except "dark")
index    1440   light, dark  {"vw":1440,"sw":1440,"overflow":[]}
index     390   light, dark  {"vw":390,"sw":390,"overflow":[]}
console  1440   light, dark  {"vw":1440,"sw":1440,"overflow":[]}
console   390   light, dark  {"vw":390,"sw":390,"overflow":["BUTTON.chip r=414","BUTTON.chip r=558","SPAN.chip-t r=465","BUTTON.chip r=664","SPAN.chip-t r=608"]}
flow     1440   light, dark  {"vw":1440,"sw":1440,"overflow":[]}
flow      390   light, dark  {"vw":390,"sw":390,"overflow":[same five chips]}
triage   1440   light, dark  {"vw":1440,"sw":1440,"overflow":[]}
triage    390   light, dark  {"vw":390,"sw":390,"overflow":[same five chips]}
```

Scroll width equals the viewport on every page, so nothing scrolls sideways; the only elements past the edge on phone are the story chips, which sit in a row that scrolls horizontally on purpose.
`chrome-devtools-axi console` showed no errors or warnings on any page.

Interactions exercised by script, with results read back from the page:

- Control room at 12:06: "Release 25 claims…" opens "Release 25 claims held by mmp-app-03" (dry run, "evaluated at 12:06", "2 people required", the `UPDATE`, a reason for the audit log); Cancel closes it; the "Stuck 25" tab lists #88131865 first, and selecting it opens its journey drawer.
- Flow map at 12:06: the forecast reads "At today's rate the backlog clears at 12:43"; "+1 consumer" or "Restart mmp-app-03 and release its claims" each add "or at 12:34 with the what-if (9 min sooner)"; both together give 12:28 (15 minutes sooner).
- Triage at 12:06: the headline is "payments.inbound is 48 minutes behind its 15-minute target", with "86% of the backlog is one file, DEMO_FPS_BULK_20261015_1112.csv"; the strip shows payments.inbound 36 minutes past target (7.5 times the daily budget) and ledger.postings 2 minutes.
  Searching `PAY-DEMO-1030-0412` finds #88131877 (stuck, payments.inbound, row 412 of `DEMO_FPS_20261015_1030.csv`, claimed by mmp-app-03 at 10:41:58).
  "Pause ledger.postings…", "Retry 621 dead postings…" and "Release its claims…" open guarded modals for 9,334 items, 621 postings and 28 claims.
  Earlier in the pass, "Draft incident notes" produced the Markdown notes and the theme toggle switched to dark and back.

### Fixes made during verification

- `prototype/triage.html`: SQL snippets and rule text brought in line with the tested `sql/panels.sql` (fingerprint masking, poison vs storm spread, storm thresholds, guarded release, staggered retry by fingerprint, `CANCELLED`).
- `prototype/triage.html`: headline status icons were invisible in dark mode (a white glyph drawn on the text colour, which is white in dark mode); each icon now takes its severity colour.
- `prototype/console.html` (phone): headline tile subtitles were cut off with an ellipsis and now wrap; worker ids such as `mmp-app-03:4211` no longer wrap inside table cells; the items table hides the heartbeat column at phone width; a duplicated "Showing" footer was merged; queue cards no longer touch the tiles above them; spacing between wrapped facts in queue cards was tightened.
- `prototype/flow.html` (phone): section totals such as "8,808 total" broke over two lines and now stay on one.
- `prototype/triage.html` (phone): the search placeholder was clipped mid-token and is now "#88120473 or PAY-DEMO-…" (the "Try" chips below still show a file example).
- `prototype/assets/ui.js`: guarded-action titles broke host names at the hyphen ("mmp-app-" then "03"); hyphenated identifiers in titles are now kept whole (`keepWhole`, `prototype/assets/ui.js:439`).
- `prototype/assets/ui.js` (desktop): at 12:06 the scrubber handle sat on the "12:00" hour label and left fragments of it showing on both sides; a label the handle would cover is now left out (`prototype/assets/ui.js:188`), checked at 10:58, 12:06 and 13:40.
- `prototype/console.html`: the journey drawer split `payload_ref` at a hyphen ("…/PAY-" then "DEMO-1030-0400.json"); it now breaks only after a slash, so the file name stays whole at 390 px and in the 1440 px side drawer.
- `prototype/index.html`: created, with light and dark thumbnails of each concept that follow the theme.
- `sql/panels.sql`: P19 and P20 added and run, so the flow map's verdicts and the triage strip have tested SQL behind them.

Left as designed: on phone, the SQL inside guarded-action modals scrolls sideways rather than wrapping, so the statement keeps its shape.
The simulation treats a minute as ending at its 59th second, so at 12:06 a journey's "still claimed" step reads 12:06:59, inside the minute the clock shows.

### SQL evidence

- PostgreSQL 17.8 (Homebrew), private cluster on 127.0.0.1, Apple M3, default settings, stopped after use.
- `psql -v ON_ERROR_STOP=1 -f schema.sql -f seed.sql` loads in about 50 s; `dbq_item` 1,645,739 rows (263 MB heap, 634 MB with indexes), `dbq_attempt` 262,235 rows (8,836 failed), 306 snapshot minutes per queue.
- `psql -v ON_ERROR_STOP=1 -f panels.sql` exits 0, including P19 and P20 added in this pass.
- Timings are the warm (second) run of each block in its own session; plans are `EXPLAIN (ANALYZE, BUFFERS)` warm runs.
- What the panels return at 12:06 on the seed (P1):

```text
 queue_name       | waiting | scheduled | in_flight | stuck | dead | oldest_wait_s | slo_wait_s | in_per_min | out_per_min | consumers
 payments.inbound |   30007 |         0 |        75 |    25 |    1 |          2904 |        900 |        0.0 |       450.2 | 3/4
 recon.daily      |    1024 |         0 |         1 |     0 |    0 |           359 |       3600 |        0.0 |        30.0 | 1/1
 audit.archive    |    1200 |         0 |         0 |     0 |    0 |           360 |      14400 |      199.8 |         0.0 | 1/1
 ledger.postings  |       7 |       775 |       312 |     0 |  225 |             1 |        300 |      450.2 |       402.6 | 2/2
 mandates.inbound |       1 |         0 |         0 |     3 |    0 |             0 |        900 |       15.0 |        15.0 | 3/4
 notify.outbound  |       1 |         0 |         0 |     0 |    0 |             0 |        600 |       47.6 |        47.6 | 1/1
```

Note the ledger.postings row: 1 s of lag, 775 items scheduled for retry and 225 dead, which is trap 1 above.
`in_per_min` for payments is 0 because files arrive in bursts and the 12:00 file had finished ingesting; P5 and P14 use longer windows for that reason.
