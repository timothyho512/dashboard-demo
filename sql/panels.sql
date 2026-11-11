-- DBQ console: one query per panel (P1-P20), PostgreSQL 17 dialect, against schema.sql.
-- Runnable end to end:  psql -v ON_ERROR_STOP=1 -f schema.sql -f seed.sql -f panels.sql
-- Parameters are psql variables (:'queue' is a quoted string, :item_id a number).
-- In Spring's NamedParameterJdbcTemplate the same parameters are written :queue, :item_id and so on.
-- dbq_now() is the frozen test clock (2026-10-15 12:06:00); production uses LOCALTIMESTAMP.
-- Every write (claim path, P17, P18) runs inside BEGIN ... ROLLBACK here so the file can be re-run.

\set queue      'payments.inbound'
\set worker     'mmp-app-03:4211'
\set item_id    88120473
\set batch      'DEMO_FPS_BULK_20261015_1112.csv'
\set objective  0.995

-- @@ CONTEXT claim, heartbeat and fenced completion (what the consumers do; the console relies on these semantics)
BEGIN;
-- Claim up to 25 ready items, oldest first, skipping rows other workers have locked; respects the pause switch.
-- The pause check must stay an uncorrelated scalar subquery (evaluated once). Written as a correlated
-- NOT EXISTS, the planner estimated 1 row for the anti-join and sorted the whole ready set before LIMIT:
-- 6.6 ms at 30k ready rows (and growing with the backlog) instead of 0.02 ms reading 25 index entries.
WITH next AS (
  SELECT i.id
  FROM dbq_item i
  WHERE i.queue_name = :'queue'
    AND i.status IN ('QUEUED','FAILED')
    AND i.available_at <= dbq_now()
    AND NOT coalesce((SELECT c.paused FROM dbq_queue_config c WHERE c.queue_name = :'queue'), false)
  ORDER BY i.available_at, i.id
  LIMIT 25
  FOR UPDATE SKIP LOCKED
)
UPDATE dbq_item i
SET status = 'PROCESSING', claimed_by = 'mmp-app-01:4102', claimed_at = dbq_now(), heartbeat_at = dbq_now(),
    attempts = i.attempts + 1
FROM next
WHERE i.id = next.id
RETURNING i.id, i.payload_ref, i.attempts;
-- Heartbeat: every 30 s the worker touches its claims (stale_after_s = 90 = three missed beats).
UPDATE dbq_item SET heartbeat_at = dbq_now()
WHERE queue_name = :'queue' AND claimed_by = 'mmp-app-01:4102' AND status IN ('CLAIMED','PROCESSING');
-- Fenced completion: succeeds only while this worker still owns the claim. 0 rows = the claim was released
-- (for example by P17), so the worker must not treat the item as done. This makes "release stuck claims" safe.
UPDATE dbq_item SET status = 'DONE', completed_at = dbq_now()
WHERE id = (SELECT min(id) FROM dbq_item WHERE claimed_by = 'mmp-app-01:4102' AND status = 'PROCESSING' AND claimed_at = dbq_now())
  AND claimed_by = 'mmp-app-01:4102' AND status = 'PROCESSING'
RETURNING id, status;
ROLLBACK;

-- @@ P1 queue overview (one row per queue). Defined as a view so P18 can snapshot exactly the same numbers.
CREATE OR REPLACE VIEW dbq_queue_now AS
SELECT c.queue_name,
       r.waiting, r.scheduled, f.in_flight, f.stuck, d.dead,
       extract(epoch FROM dbq_now() - o.oldest_available_at)::int AS oldest_wait_s,
       c.slo_wait_s,
       a.arrived_5m, k.completed_5m,
       round(a.arrived_5m / 5.0, 1)   AS in_per_min,
       round(k.completed_5m / 5.0, 1) AS out_per_min,
       w.consumers_alive, w.consumers_total
FROM dbq_queue_config c
CROSS JOIN LATERAL (
  SELECT count(*) FILTER (WHERE available_at <= dbq_now()) AS waiting,
         count(*) FILTER (WHERE available_at >  dbq_now()) AS scheduled
  FROM dbq_item
  WHERE queue_name = c.queue_name AND status IN ('QUEUED','FAILED')) r
CROSS JOIN LATERAL (
  SELECT min(available_at) AS oldest_available_at
  FROM dbq_item
  WHERE queue_name = c.queue_name AND status IN ('QUEUED','FAILED') AND available_at <= dbq_now()) o
CROSS JOIN LATERAL (
  SELECT count(*) FILTER (WHERE heartbeat_at >= dbq_now() - c.stale_after_s * interval '1 second')                     AS in_flight,
         count(*) FILTER (WHERE heartbeat_at IS NULL OR heartbeat_at < dbq_now() - c.stale_after_s * interval '1 second') AS stuck
  FROM dbq_item
  WHERE queue_name = c.queue_name AND status IN ('CLAIMED','PROCESSING')) f
CROSS JOIN LATERAL (
  SELECT count(*) AS dead FROM dbq_item WHERE queue_name = c.queue_name AND status = 'DEAD') d
CROSS JOIN LATERAL (
  SELECT count(*) AS arrived_5m FROM dbq_item
  WHERE queue_name = c.queue_name AND created_at > dbq_now() - interval '5 minutes' AND created_at <= dbq_now()) a
CROSS JOIN LATERAL (
  SELECT count(*) AS completed_5m FROM dbq_item
  WHERE queue_name = c.queue_name AND completed_at > dbq_now() - interval '5 minutes' AND completed_at <= dbq_now()
    AND status = 'DONE') k
CROSS JOIN LATERAL (
  SELECT count(*) FILTER (WHERE heartbeat_at >= dbq_now() - c.stale_after_s * interval '1 second') AS consumers_alive,
         count(*) AS consumers_total
  FROM dbq_worker WHERE queue_name = c.queue_name) w;

SELECT queue_name, waiting, scheduled, in_flight, stuck, dead, oldest_wait_s, slo_wait_s,
       in_per_min, out_per_min, consumers_alive || '/' || consumers_total AS consumers
FROM dbq_queue_now
ORDER BY (oldest_wait_s::numeric / slo_wait_s) DESC NULLS LAST, queue_name;

-- @@ P2 oldest waiting item per queue (lag measured as age, not count)
-- Ready-item wait alone hides retry backoff: items sitting in backoff are not "waiting", so a queue whose
-- dependency is down can show a 1 s wait while hundreds of items are 15 minutes old. The two backoff columns expose that.
SELECT c.queue_name, o.id AS oldest_item_id, o.payload_ref,
       extract(epoch FROM dbq_now() - o.available_at)::int AS oldest_wait_s,   -- since it became claimable
       extract(epoch FROM dbq_now() - o.created_at)::int   AS oldest_age_s,    -- since it was written
       c.slo_wait_s,
       CASE WHEN o.id IS NULL THEN 'EMPTY'
            WHEN dbq_now() - o.available_at > c.slo_wait_s * interval '1 second'       THEN 'BREACH'
            WHEN dbq_now() - o.available_at > c.slo_wait_s * 0.5 * interval '1 second' THEN 'WARN'
            ELSE 'OK' END AS lag_status,
       b.in_backoff,
       extract(epoch FROM dbq_now() - b.oldest_backoff_created_at)::int AS oldest_backoff_age_s
FROM dbq_queue_config c
LEFT JOIN LATERAL (
  SELECT id, payload_ref, available_at, created_at
  FROM dbq_item
  WHERE queue_name = c.queue_name AND status IN ('QUEUED','FAILED') AND available_at <= dbq_now()
  ORDER BY available_at
  LIMIT 1) o ON true
CROSS JOIN LATERAL (
  -- items that failed and wait for their next attempt (attempts > 0 excludes delayed first deliveries)
  SELECT count(*) AS in_backoff, min(created_at) AS oldest_backoff_created_at
  FROM dbq_item
  WHERE queue_name = c.queue_name AND status IN ('QUEUED','FAILED') AND available_at > dbq_now() AND attempts > 0) b
ORDER BY oldest_wait_s DESC NULLS LAST;

-- @@ P3 state depth over time (stacked area; from the snapshot table, never the hot table)
SELECT taken_at, waiting, scheduled, in_flight, stuck, dead
FROM dbq_snapshot
WHERE queue_name = :'queue' AND taken_at > dbq_now() - interval '6 hours'
ORDER BY taken_at;

-- @@ P4 oldest wait over time against the queue's SLO
SELECT s.taken_at, s.oldest_wait_s, c.slo_wait_s, (s.oldest_wait_s > c.slo_wait_s) AS breach
FROM dbq_snapshot s
JOIN dbq_queue_config c USING (queue_name)
WHERE s.queue_name = :'queue' AND s.taken_at > dbq_now() - interval '6 hours'
ORDER BY s.taken_at;

-- @@ P5 throughput per minute, last 60 minutes, zero-filled (in = created_at, out = completed_at)
WITH minutes AS (
  SELECT generate_series(date_trunc('minute', dbq_now()) - interval '59 minutes',
                         date_trunc('minute', dbq_now()) - interval '1 minute', interval '1 minute') AS minute
), arrived AS (
  SELECT date_trunc('minute', created_at) AS minute, count(*) AS n
  FROM dbq_item
  WHERE queue_name = :'queue'
    AND created_at >= date_trunc('minute', dbq_now()) - interval '59 minutes' AND created_at < date_trunc('minute', dbq_now())
  GROUP BY 1
), finished AS (
  SELECT date_trunc('minute', completed_at) AS minute,
         count(*) FILTER (WHERE status = 'DONE') AS done,
         count(*) FILTER (WHERE status = 'DEAD') AS dead
  FROM dbq_item
  WHERE queue_name = :'queue'
    AND completed_at >= date_trunc('minute', dbq_now()) - interval '59 minutes' AND completed_at < date_trunc('minute', dbq_now())
  GROUP BY 1
)
SELECT m.minute, coalesce(a.n, 0) AS arrived, coalesce(f.done, 0) AS completed, coalesce(f.dead, 0) AS dead_lettered
FROM minutes m
LEFT JOIN arrived a USING (minute)
LEFT JOIN finished f USING (minute)
ORDER BY m.minute;

-- @@ P6 wait and processing time percentiles for items completed in the last 15 minutes
SELECT count(*) AS completed_15m,
       round(percentile_cont(0.50) WITHIN GROUP (ORDER BY extract(epoch FROM claimed_at - available_at))::numeric, 1)   AS wait_p50_s,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM claimed_at - available_at))::numeric, 1)   AS wait_p95_s,
       round(max(extract(epoch FROM claimed_at - available_at))::numeric, 1)                                             AS wait_max_s,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - claimed_at))::numeric, 2)  AS processing_p95_s,
       round(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at - created_at))::numeric, 1)  AS end_to_end_p95_s
FROM dbq_item
WHERE queue_name = :'queue' AND status = 'DONE'
  AND completed_at > dbq_now() - interval '15 minutes' AND completed_at <= dbq_now();

-- @@ P7 consumers: registry heartbeat, claims held, throughput and failures per worker
SELECT w.worker_id, w.version,
       extract(epoch FROM dbq_now() - w.heartbeat_at)::int AS process_heartbeat_age_s,
       coalesce(cl.claims_held, 0) AS claims_held,
       extract(epoch FROM dbq_now() - cl.oldest_claim_heartbeat)::int AS oldest_claim_heartbeat_age_s,
       coalesce(dn.completed_5m, 0) AS completed_5m,
       coalesce(fl.failed_5m, 0) AS failed_5m,
       CASE WHEN w.heartbeat_at < dbq_now() - c.stale_after_s * interval '1 second' AND coalesce(cl.claims_held, 0) > 0
              THEN 'STUCK_HOLDING_CLAIMS'
            WHEN w.heartbeat_at < dbq_now() - c.stale_after_s * interval '1 second' THEN 'GONE'
            WHEN coalesce(dn.completed_5m, 0) = 0 AND coalesce(cl.claims_held, 0) = 0 THEN 'IDLE'
            ELSE 'HEALTHY' END AS state
FROM dbq_worker w
JOIN dbq_queue_config c USING (queue_name)
LEFT JOIN LATERAL (
  SELECT count(*) AS claims_held, min(heartbeat_at) AS oldest_claim_heartbeat
  FROM dbq_item i
  WHERE i.queue_name = w.queue_name AND i.claimed_by = w.worker_id AND i.status IN ('CLAIMED','PROCESSING')) cl ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS completed_5m
  FROM dbq_item i
  WHERE i.queue_name = w.queue_name AND i.status = 'DONE' AND i.claimed_by = w.worker_id
    AND i.completed_at > dbq_now() - interval '5 minutes' AND i.completed_at <= dbq_now()) dn ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS failed_5m
  FROM dbq_attempt a
  WHERE a.queue_name = w.queue_name AND a.worker = w.worker_id AND a.outcome = 'FAILED'
    AND a.finished_at > dbq_now() - interval '5 minutes' AND a.finished_at <= dbq_now()) fl ON true
WHERE w.queue_name = :'queue'
ORDER BY w.worker_id;

-- @@ P7b consumers WITHOUT a registry (derived from claims and completions only)
-- Limitation: a dead worker that holds no claims and completed nothing recently is invisible here.
SELECT coalesce(cl.claimed_by, dn.claimed_by) AS worker, coalesce(cl.claims_held, 0) AS claims_held,
       extract(epoch FROM dbq_now() - cl.last_heartbeat)::int AS last_claim_heartbeat_age_s,
       coalesce(dn.completed_5m, 0) AS completed_5m
FROM (SELECT claimed_by, count(*) AS claims_held, max(heartbeat_at) AS last_heartbeat
      FROM dbq_item WHERE queue_name = :'queue' AND status IN ('CLAIMED','PROCESSING')
      GROUP BY claimed_by) cl
FULL JOIN (SELECT claimed_by, count(*) AS completed_5m
           FROM dbq_item WHERE queue_name = :'queue' AND status = 'DONE'
             AND completed_at > dbq_now() - interval '5 minutes' AND completed_at <= dbq_now()
           GROUP BY claimed_by) dn USING (claimed_by)
ORDER BY 1;

-- @@ P8 stuck claims: claimed items whose heartbeat is older than the queue's stale threshold
SELECT i.id, i.queue_name, i.claimed_by, i.claimed_at, i.heartbeat_at,
       extract(epoch FROM dbq_now() - coalesce(i.heartbeat_at, i.claimed_at))::int AS silent_s,
       i.attempts, i.payload_ref, i.batch_ref
FROM dbq_item i
JOIN dbq_queue_config c USING (queue_name)
WHERE i.status IN ('CLAIMED','PROCESSING')
  AND coalesce(i.heartbeat_at, i.claimed_at) < dbq_now() - c.stale_after_s * interval '1 second'
ORDER BY silent_s DESC, i.id;

-- @@ P8b stuck claims grouped by worker (the triage card)
SELECT i.queue_name, i.claimed_by, count(*) AS stuck_claims,
       min(i.claimed_at) AS first_claimed_at, max(i.heartbeat_at) AS last_heartbeat_at,
       extract(epoch FROM dbq_now() - max(i.heartbeat_at))::int AS silent_s
FROM dbq_item i
JOIN dbq_queue_config c USING (queue_name)
WHERE i.status IN ('CLAIMED','PROCESSING')
  AND coalesce(i.heartbeat_at, i.claimed_at) < dbq_now() - c.stale_after_s * interval '1 second'
GROUP BY i.queue_name, i.claimed_by
ORDER BY stuck_claims DESC;

-- @@ P9 poison candidates: many attempts, one error fingerprint, failed on more than one worker
-- (one fingerprint + several workers = the message is bad, not the worker; retrying will not help)
-- A retry storm matches the same shape (every victim fails with the same timeout on several workers), so the
-- candidate is only flagged as poison when few other items failed with the same fingerprint in the last 24 hours.
WITH cand AS (
  SELECT i.id, i.queue_name, i.status, i.attempts, i.max_attempts, i.payload_ref, i.batch_ref,
         count(DISTINCT a.worker) AS distinct_workers,
         min(dbq_fingerprint(a.error)) AS fingerprint,
         min(a.started_at) AS first_failure_at, max(a.finished_at) AS last_failure_at,
         left(i.last_error, 90) AS last_error
  FROM dbq_item i
  JOIN dbq_attempt a ON a.item_id = i.id AND a.outcome = 'FAILED'
  WHERE i.status IN ('QUEUED','FAILED','DEAD')
    AND i.attempts >= 3
  GROUP BY i.id
  HAVING count(DISTINCT dbq_fingerprint(a.error)) = 1 AND count(DISTINCT a.worker) >= 2
), spread AS (
  SELECT a.queue_name, dbq_fingerprint(a.error) AS fingerprint, count(DISTINCT a.item_id) AS items_same_error
  FROM dbq_attempt a
  WHERE a.outcome = 'FAILED' AND a.finished_at > dbq_now() - interval '24 hours' AND a.finished_at <= dbq_now()
    AND a.queue_name IN (SELECT queue_name FROM cand)
  GROUP BY 1, 2
)
SELECT c.id, c.queue_name, c.status, c.attempts, c.max_attempts, c.payload_ref, c.distinct_workers,
       s.items_same_error, (s.items_same_error <= 3) AS is_poison,
       c.first_failure_at, c.last_failure_at, c.last_error
FROM cand c
JOIN spread s USING (queue_name, fingerprint)
ORDER BY is_poison DESC, c.attempts DESC, c.last_failure_at DESC
LIMIT 50;

-- @@ P10 error fingerprints over items that are failing now (retrying) or dead
SELECT queue_name, dbq_fingerprint(last_error) AS fingerprint,
       count(*) AS items,
       count(*) FILTER (WHERE status = 'DEAD') AS dead,
       count(*) FILTER (WHERE status <> 'DEAD') AS retrying,
       min(id) AS sample_item_id
FROM dbq_item
WHERE ((status IN ('QUEUED','FAILED') AND last_error IS NOT NULL) OR status = 'DEAD')
GROUP BY 1, 2
ORDER BY items DESC
LIMIT 20;

-- @@ P10b error fingerprints over the last 60 minutes of attempts (history, first and last seen)
SELECT a.queue_name, dbq_fingerprint(a.error) AS fingerprint,
       count(*) AS failures, count(DISTINCT a.item_id) AS items, count(DISTINCT a.worker) AS workers,
       min(a.finished_at) AS first_seen, max(a.finished_at) AS last_seen
FROM dbq_queue_config c
JOIN dbq_attempt a ON a.queue_name = c.queue_name
WHERE a.outcome = 'FAILED' AND a.finished_at > dbq_now() - interval '60 minutes' AND a.finished_at <= dbq_now()
GROUP BY 1, 2
ORDER BY failures DESC;

-- @@ P11 retry storm detector: failure rate now vs the queue's normal, spread over many items, one dominant cause
SELECT c.queue_name, r.failed_10m, r.items_10m,
       round(r.failed_10m / 10.0, 1) AS failed_per_min,
       b.baseline_per_min,
       t.top_fingerprint, round(t.top_n::numeric / nullif(r.failed_10m, 0), 2) AS top_share,
       (r.failed_10m / 10.0 >= greatest(5, 10 * b.baseline_per_min)
        AND r.items_10m >= 20
        AND t.top_n::numeric / nullif(r.failed_10m, 0) >= 0.8) AS is_storm
FROM dbq_queue_config c
CROSS JOIN LATERAL (
  SELECT count(*) AS failed_10m, count(DISTINCT item_id) AS items_10m
  FROM dbq_attempt a
  WHERE a.queue_name = c.queue_name AND a.outcome = 'FAILED'
    AND a.finished_at > dbq_now() - interval '10 minutes' AND a.finished_at <= dbq_now()) r
CROSS JOIN LATERAL (
  -- median failures per minute over the last 3 hours of snapshots: robust to the storm itself
  SELECT coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY s.failed_1m), 0)::numeric AS baseline_per_min
  FROM dbq_snapshot s
  WHERE s.queue_name = c.queue_name AND s.taken_at > dbq_now() - interval '3 hours') b
LEFT JOIN LATERAL (
  SELECT dbq_fingerprint(a.error) AS top_fingerprint, count(*) AS top_n
  FROM dbq_attempt a
  WHERE a.queue_name = c.queue_name AND a.outcome = 'FAILED'
    AND a.finished_at > dbq_now() - interval '10 minutes' AND a.finished_at <= dbq_now()
  GROUP BY 1 ORDER BY 2 DESC LIMIT 1) t ON true
ORDER BY r.failed_10m DESC;

-- @@ P12 arrivals in the last 60 minutes by producer and batch (which upstream file is filling the queue)
SELECT producer, batch_ref, count(*) AS arrived, min(created_at) AS first_at, max(created_at) AS last_at,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct_of_arrivals
FROM dbq_item
WHERE queue_name = :'queue' AND created_at > dbq_now() - interval '60 minutes' AND created_at <= dbq_now()
GROUP BY producer, batch_ref
ORDER BY arrived DESC;

-- @@ P12b spike detector: last 60 minutes of arrivals vs the same hour on the previous 7 days
SELECT c.queue_name, n.arrived_60m, b.max_same_hour_prev_days,
       round(n.arrived_60m::numeric / nullif(b.max_same_hour_prev_days, 0), 1) AS x_normal,
       (n.arrived_60m > 3 * greatest(b.max_same_hour_prev_days, 100)) AS is_spike
FROM dbq_queue_config c
CROSS JOIN LATERAL (
  SELECT count(*) AS arrived_60m FROM dbq_item
  WHERE queue_name = c.queue_name AND created_at > dbq_now() - interval '60 minutes' AND created_at <= dbq_now()) n
CROSS JOIN LATERAL (
  SELECT max(x.cnt) AS max_same_hour_prev_days
  FROM generate_series(1, 7) AS d
  CROSS JOIN LATERAL (
    SELECT count(*) AS cnt FROM dbq_item
    WHERE queue_name = c.queue_name
      AND created_at >  dbq_now() - d * interval '1 day' - interval '60 minutes'
      AND created_at <= dbq_now() - d * interval '1 day') x) b
ORDER BY x_normal DESC NULLS LAST;

-- @@ P13 batch / file progress for today's upstream files
SELECT batch_ref,
       count(*) AS total,
       count(*) FILTER (WHERE status = 'DONE') AS done,
       count(*) FILTER (WHERE status IN ('CLAIMED','PROCESSING')) AS in_flight,
       count(*) FILTER (WHERE status IN ('QUEUED','FAILED') AND available_at <= dbq_now()) AS waiting,
       count(*) FILTER (WHERE status IN ('QUEUED','FAILED') AND available_at >  dbq_now()) AS scheduled,
       count(*) FILTER (WHERE status = 'DEAD') AS dead,
       round(100.0 * count(*) FILTER (WHERE status = 'DONE') / count(*), 1) AS pct_done,
       min(created_at) AS first_item_at,
       max(completed_at) AS last_completed_at
FROM dbq_item
WHERE queue_name = :'queue' AND created_at >= date_trunc('day', dbq_now()) AND batch_ref IS NOT NULL
GROUP BY batch_ref
ORDER BY first_item_at DESC
LIMIT 12;

-- @@ P13b one batch: when will its last item be done? (FIFO: everything ahead of its last waiting item, at the current pace)
WITH b AS (
  SELECT max(available_at) AS last_available_at
  FROM dbq_item
  WHERE batch_ref = :'batch' AND queue_name = :'queue' AND status IN ('QUEUED','FAILED')
), ahead AS (
  SELECT count(*) AS items_until_batch_done
  FROM dbq_item i, b
  WHERE i.queue_name = :'queue' AND i.status IN ('QUEUED','FAILED') AND i.available_at <= b.last_available_at
), pace AS (
  SELECT count(*) / 15.0 AS out_per_min
  FROM dbq_item
  WHERE queue_name = :'queue' AND status = 'DONE'
    AND completed_at > dbq_now() - interval '15 minutes' AND completed_at <= dbq_now()
)
SELECT ahead.items_until_batch_done, round(pace.out_per_min, 1) AS out_per_min,
       date_trunc('second', dbq_now() + ahead.items_until_batch_done / nullif(pace.out_per_min, 0) * interval '1 minute') AS batch_eta
FROM ahead, pace;

-- @@ P14 drain forecast: when the backlog empties, and when the oldest item is back inside the SLO
WITH backlog AS (
  SELECT count(*) AS n FROM dbq_item WHERE queue_name = :'queue' AND status IN ('QUEUED','FAILED')
), rates AS (
  SELECT (SELECT count(*) FROM dbq_item
           WHERE queue_name = :'queue' AND created_at > dbq_now() - interval '15 minutes' AND created_at <= dbq_now()) / 15.0 AS in_per_min,
         (SELECT count(*) FROM dbq_item
           WHERE queue_name = :'queue' AND status = 'DONE'
             AND completed_at > dbq_now() - interval '15 minutes' AND completed_at <= dbq_now()) / 15.0 AS out_per_min
), fifo AS (
  -- position of every waiting item in the line; it is claimed at now + position / out_per_min
  SELECT i.available_at, row_number() OVER (ORDER BY i.available_at, i.id) AS pos
  FROM dbq_item i
  WHERE i.queue_name = :'queue' AND i.status IN ('QUEUED','FAILED') AND i.available_at <= dbq_now()
), back_in_slo AS (
  -- first waiting item that will be claimed while still inside the SLO
  SELECT min(dbq_now() + f.pos / r.out_per_min * interval '1 minute') AS at
  FROM fifo f, rates r, dbq_queue_config c
  WHERE c.queue_name = :'queue' AND r.out_per_min > 0
    AND dbq_now() + f.pos / r.out_per_min * interval '1 minute' - f.available_at <= c.slo_wait_s * interval '1 second'
)
SELECT b.n AS backlog, round(r.in_per_min, 1) AS in_per_min, round(r.out_per_min, 1) AS out_per_min,
       round(r.out_per_min - r.in_per_min, 1) AS net_drain_per_min,
       CASE WHEN r.out_per_min > r.in_per_min
            THEN date_trunc('second', dbq_now() + b.n / (r.out_per_min - r.in_per_min) * interval '1 minute') END AS drain_eta,
       -- If every item waiting now will breach, the head of the line becomes an item that has not arrived yet.
       -- At steady rates the head at now + x minutes arrived at now + (x * out - n) / in, so its wait is inside the
       -- SLO (S minutes) once x >= (n - S * in) / (out - in), and never before the current backlog is consumed (n / out).
       date_trunc('second', coalesce(s.at,
         CASE WHEN r.out_per_min > r.in_per_min
              THEN dbq_now() + greatest(b.n / r.out_per_min,
                                        (b.n - c.slo_wait_s / 60.0 * r.in_per_min) / (r.out_per_min - r.in_per_min))
                               * interval '1 minute' END)) AS back_within_slo_eta
FROM backlog b, rates r, back_in_slo s, dbq_queue_config c
WHERE c.queue_name = :'queue';

-- @@ P15 SLO burn from snapshots: minutes in breach, budget left, burn rate over the last hour
-- Objective: the oldest wait is within the SLO in :objective of minutes (0.995 over 30 days = 216 budget minutes).
SELECT c.queue_name,
       count(*) AS minutes_observed,
       count(*) FILTER (WHERE s.oldest_wait_s > c.slo_wait_s) AS breach_minutes,
       round(100.0 * count(*) FILTER (WHERE s.oldest_wait_s IS NULL OR s.oldest_wait_s <= c.slo_wait_s) / count(*), 2) AS pct_within_slo,
       round(30 * 1440 * (1 - :objective)) - count(*) FILTER (WHERE s.oldest_wait_s > c.slo_wait_s) AS budget_minutes_left_30d,
       round((count(*) FILTER (WHERE s.oldest_wait_s > c.slo_wait_s AND s.taken_at > dbq_now() - interval '60 minutes') / 60.0)
             / (1 - :objective), 1) AS burn_rate_1h
FROM dbq_snapshot s
JOIN dbq_queue_config c USING (queue_name)
WHERE s.taken_at > dbq_now() - interval '30 days'
GROUP BY c.queue_name
ORDER BY breach_minutes DESC;

-- @@ P15b item-based SLI: share of today's completed items that waited longer than the SLO
SELECT i.queue_name, count(*) AS completed_today,
       count(*) FILTER (WHERE i.claimed_at - i.available_at > c.slo_wait_s * interval '1 second') AS waited_over_slo,
       round(100.0 * count(*) FILTER (WHERE i.claimed_at - i.available_at <= c.slo_wait_s * interval '1 second') / count(*), 2) AS pct_within_slo
FROM dbq_queue_config c
JOIN dbq_item i ON i.queue_name = c.queue_name
WHERE i.status = 'DONE' AND i.completed_at >= date_trunc('day', dbq_now()) AND i.completed_at <= dbq_now()
GROUP BY i.queue_name
ORDER BY pct_within_slo;

-- @@ P16 item journey (lookup by id; by business key: WHERE payload_ref = :'ref'; by file: WHERE batch_ref = :'batch')
SELECT id, queue_name, status, attempts, max_attempts, producer, batch_ref, payload_ref,
       created_at, available_at, claimed_by, claimed_at, heartbeat_at, completed_at
FROM dbq_item WHERE id = :item_id;

SELECT ts, event, detail FROM (
  SELECT created_at AS ts, 'CREATED' AS event, 'by ' || coalesce(producer, '?') || ' from ' || coalesce(batch_ref, '-') AS detail
  FROM dbq_item WHERE id = :item_id
  UNION ALL
  SELECT started_at, 'ATTEMPT ' || attempt || ' STARTED', worker FROM dbq_attempt WHERE item_id = :item_id
  UNION ALL
  SELECT finished_at, 'ATTEMPT ' || attempt || ' ' || outcome, coalesce(left(error, 80), '') FROM dbq_attempt WHERE item_id = :item_id
  UNION ALL
  SELECT claimed_at, 'CLAIMED (in progress)', claimed_by || ', last heartbeat ' || heartbeat_at
  FROM dbq_item WHERE id = :item_id AND status IN ('CLAIMED','PROCESSING')
  UNION ALL
  SELECT completed_at, status, NULL FROM dbq_item WHERE id = :item_id AND status IN ('DONE','DEAD','CANCELLED')
  UNION ALL
  SELECT created_at, 'ACTION ' || action, actor || coalesce(' approved by ' || approver, '') || ': ' || reason
  FROM dbq_action_audit WHERE :item_id = ANY (item_ids)
) t
ORDER BY ts, event;

-- @@ P17 operator actions (each previewed, guarded, four-eyes for bulk, audited in the same statement)
BEGIN;
-- P17a preview (dry run) of "release stale claims of one worker": the count the operator confirms.
SELECT count(*) AS would_release, min(i.heartbeat_at) AS oldest_heartbeat, max(i.heartbeat_at) AS newest_heartbeat
FROM dbq_item i
JOIN dbq_queue_config c USING (queue_name)
WHERE i.queue_name = :'queue' AND i.claimed_by = :'worker' AND i.status IN ('CLAIMED','PROCESSING')
  AND i.heartbeat_at < dbq_now() - c.stale_after_s * interval '1 second'
  AND EXISTS (SELECT 1 FROM dbq_worker w
              WHERE w.worker_id = i.claimed_by AND w.queue_name = i.queue_name
                AND w.heartbeat_at < dbq_now() - c.stale_after_s * interval '1 second');

-- P17b release: same predicate re-checked at write time (a claim that heartbeats again is not touched).
-- available_at is left alone, so released items keep their place at the front of the line.
WITH released AS (
  UPDATE dbq_item i
  SET status = 'QUEUED', claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL
  FROM dbq_queue_config c
  WHERE c.queue_name = i.queue_name
    AND i.queue_name = :'queue' AND i.claimed_by = :'worker' AND i.status IN ('CLAIMED','PROCESSING')
    AND i.heartbeat_at < dbq_now() - c.stale_after_s * interval '1 second'
    AND EXISTS (SELECT 1 FROM dbq_worker w
                WHERE w.worker_id = i.claimed_by AND w.queue_name = i.queue_name
                  AND w.heartbeat_at < dbq_now() - c.stale_after_s * interval '1 second')
  RETURNING i.id
)
INSERT INTO dbq_action_audit (actor, approver, action, queue_name, predicate, expected, affected, item_ids, reason, created_at)
SELECT 'ops.analyst1', 'ops.lead2', 'RELEASE_STALE_CLAIMS', :'queue',
       'claimed_by = ' || :'worker' || ' AND claim heartbeat older than stale_after_s AND worker heartbeat older than stale_after_s',
       25, count(*), array_agg(id ORDER BY id), 'mmp-app-03 hung since 10:42 (INC-DEMO-4471)', dbq_now()
FROM released
RETURNING action, expected, affected, cardinality(item_ids) AS ids_recorded;
-- The application commits only when affected = expected; otherwise it rolls back and shows a fresh preview.

-- P17c retry one dead item (warn first if P9 says it is poison: it will fail again until the data is fixed).
UPDATE dbq_item
SET status = 'QUEUED', attempts = 0, available_at = dbq_now(), completed_at = NULL,
    claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL
WHERE id = :item_id AND status = 'DEAD'
RETURNING id, status, available_at;

-- P17d retry dead items by fingerprint, in a capped batch, staggered 200 ms apart so the recovered dependency is not stampeded.
SELECT dbq_fingerprint(last_error) AS fp
FROM dbq_item WHERE queue_name = 'ledger.postings' AND status = 'DEAD' LIMIT 1 \gset
WITH pick AS (
  SELECT id, completed_at FROM dbq_item
  WHERE queue_name = 'ledger.postings' AND status = 'DEAD'
    AND completed_at >= dbq_now() - interval '2 hours'
    AND dbq_fingerprint(last_error) = :'fp'
  ORDER BY completed_at
  LIMIT 500
  FOR UPDATE SKIP LOCKED
), staggered AS (
  SELECT id, row_number() OVER (ORDER BY completed_at, id) AS rn FROM pick
), requeued AS (
  UPDATE dbq_item i
  SET status = 'QUEUED', attempts = 0, completed_at = NULL, claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
      available_at = dbq_now() + s.rn * interval '200 milliseconds'
  FROM staggered s
  WHERE i.id = s.id
  RETURNING i.id, i.available_at
)
INSERT INTO dbq_action_audit (actor, approver, action, queue_name, predicate, expected, affected, item_ids, reason, created_at)
SELECT 'ops.analyst1', 'ops.lead2', 'RETRY_DEAD', 'ledger.postings',
       'status = DEAD AND fingerprint = ' || :'fp', 225, count(*), array_agg(id ORDER BY id),
       'cbs-gateway recovered 12:08 (INC-DEMO-4472)', dbq_now()
FROM requeued
RETURNING action, affected;
-- Check the stagger in a separate statement: every part of one statement reads the same snapshot, so a subquery
-- on dbq_item inside the RETURNING above would still see the old (pre-update) available_at values.
SELECT count(*) AS requeued, min(i.available_at) AS first_retry_at, max(i.available_at) AS last_retry_at
FROM (SELECT item_ids FROM dbq_action_audit WHERE action = 'RETRY_DEAD' ORDER BY id DESC LIMIT 1) a
JOIN dbq_item i ON i.id = ANY (a.item_ids);

-- P17e cancel one item (never an in-flight one; consumers only claim QUEUED / FAILED, so CANCELLED is inert).
UPDATE dbq_item SET status = 'CANCELLED', completed_at = dbq_now()
WHERE id = :item_id AND status IN ('QUEUED','FAILED','DEAD')
RETURNING id, status;

-- P17f pause and resume a queue (only effective because the claim query checks dbq_queue_config.paused).
UPDATE dbq_queue_config SET paused = true WHERE queue_name = 'ledger.postings' RETURNING queue_name, paused;
INSERT INTO dbq_action_audit (actor, approver, action, queue_name, predicate, expected, affected, reason, created_at)
VALUES ('ops.analyst1', NULL, 'PAUSE', 'ledger.postings', 'queue_name = ledger.postings', 1, 1,
        'stop hammering cbs-gateway while it is down (INC-DEMO-4472)', dbq_now());

-- The journey of a released item now shows the action (P16 joins dbq_action_audit).
SELECT id, status, claimed_by, available_at FROM dbq_item
WHERE id = (SELECT min(x) FROM dbq_action_audit a, unnest(a.item_ids) x WHERE a.action = 'RELEASE_STALE_CLAIMS');
ROLLBACK;

-- @@ P18 snapshot writer (run once a minute by one scheduler; idempotent per minute)
BEGIN;
INSERT INTO dbq_snapshot (queue_name, taken_at, waiting, scheduled, in_flight, stuck, dead, oldest_wait_s,
                          arrived_1m, completed_1m, failed_1m)
SELECT q.queue_name, date_trunc('minute', dbq_now()), q.waiting, q.scheduled, q.in_flight, q.stuck, q.dead, q.oldest_wait_s,
       (SELECT count(*) FROM dbq_item a WHERE a.queue_name = q.queue_name
          AND a.created_at > dbq_now() - interval '1 minute' AND a.created_at <= dbq_now()),
       (SELECT count(*) FROM dbq_item d WHERE d.queue_name = q.queue_name AND d.status = 'DONE'
          AND d.completed_at > dbq_now() - interval '1 minute' AND d.completed_at <= dbq_now()),
       (SELECT count(*) FROM dbq_attempt f WHERE f.queue_name = q.queue_name AND f.outcome = 'FAILED'
          AND f.finished_at > dbq_now() - interval '1 minute' AND f.finished_at <= dbq_now())
FROM dbq_queue_now q
ON CONFLICT (queue_name, taken_at) DO NOTHING
RETURNING queue_name, taken_at, waiting, in_flight, stuck, dead, oldest_wait_s, arrived_1m, completed_1m, failed_1m;
ROLLBACK;

-- @@ P19 queue verdict, Burrow-style: rules over a sliding window of the last 10 snapshot minutes instead of
-- per-queue thresholds (the flow map's OK / WARN / STALL / ERR, plus STOP for consumers without a heartbeat).
-- window_complete < 1 means the window is not full yet (new queue, or the snapshot job missed minutes): trust it less.
WITH win AS (
  SELECT s.queue_name, coalesce(s.oldest_wait_s, 0) AS oldest_wait_s, s.completed_1m, s.failed_1m,
         coalesce(s.oldest_wait_s, 0)
           - lag(coalesce(s.oldest_wait_s, 0)) OVER (PARTITION BY s.queue_name ORDER BY s.taken_at) AS wait_change
  FROM dbq_snapshot s
  WHERE s.taken_at >= date_trunc('minute', dbq_now()) - interval '10 minutes'   -- the 10 most recent whole minutes
    AND s.taken_at <  date_trunc('minute', dbq_now())
), w AS (
  SELECT queue_name, count(*) AS samples, sum(completed_1m) AS completed_10m, sum(failed_1m) AS failed_10m,
         bool_or(oldest_wait_s < 30) AS caught_up,     -- the queue was (nearly) empty at least once
         bool_and(wait_change >= 0) AS wait_rising     -- never fell between two samples (first row's NULL is ignored)
  FROM win
  GROUP BY queue_name
)
SELECT c.queue_name, round(coalesce(w.samples, 0) / 10.0, 1) AS window_complete,
       w.completed_10m, w.failed_10m,
       CASE WHEN w.samples IS NULL THEN 'NO DATA'
            WHEN w.failed_10m > w.completed_10m AND w.failed_10m > 50 THEN 'ERR'    -- more attempts fail than succeed
            WHEN w.caught_up THEN 'OK'
            WHEN w.completed_10m = 0 THEN 'STALL'                                  -- items waiting, nothing completing
            WHEN w.wait_rising THEN 'WARN'                                         -- completing, but falling behind
            ELSE 'OK' END AS verdict,
       k.consumers_stop
FROM dbq_queue_config c
LEFT JOIN w USING (queue_name)
CROSS JOIN LATERAL (
  SELECT count(*) FILTER (WHERE r.heartbeat_at < dbq_now() - c.stale_after_s * interval '1 second') AS consumers_stop
  FROM dbq_worker r WHERE r.queue_name = c.queue_name) k
ORDER BY c.queue_name;

-- @@ P20 wait target today in 10-minute cells (the triage strip): a cell takes the worst minute inside it
SELECT s.queue_name,
       date_bin('10 minutes', s.taken_at, date_trunc('day', dbq_now())) AS cell_start,
       max(coalesce(s.oldest_wait_s, 0)) AS worst_wait_s,
       count(*) FILTER (WHERE s.oldest_wait_s > c.slo_wait_s) AS minutes_past_target,
       CASE WHEN max(coalesce(s.oldest_wait_s, 0)) > c.slo_wait_s             THEN 'PAST_TARGET'
            WHEN max(coalesce(s.oldest_wait_s, 0)) > c.slo_wait_s * 2 / 3.0  THEN 'PAST_TWO_THIRDS'
            ELSE 'WITHIN' END AS cell_state
FROM dbq_snapshot s
JOIN dbq_queue_config c USING (queue_name)
WHERE s.taken_at >= date_trunc('day', dbq_now()) AND s.taken_at <= dbq_now()
GROUP BY s.queue_name, c.slo_wait_s, 2
ORDER BY s.queue_name, cell_start;

-- P20 row labels: minutes past target today against a daily budget (within target 99% of an 8-hour day = 4.8 minutes)
SELECT s.queue_name,
       count(*) FILTER (WHERE s.oldest_wait_s > c.slo_wait_s) AS minutes_past_target,
       round(count(*) FILTER (WHERE s.oldest_wait_s > c.slo_wait_s) / (8 * 60 * 0.01), 1) AS x_daily_budget
FROM dbq_snapshot s
JOIN dbq_queue_config c USING (queue_name)
WHERE s.taken_at >= date_trunc('day', dbq_now()) AND s.taken_at <= dbq_now()
GROUP BY s.queue_name
ORDER BY minutes_past_target DESC, s.queue_name;
