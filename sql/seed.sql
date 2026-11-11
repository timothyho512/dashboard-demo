-- DBQ console: deterministic synthetic data that reproduces the prototype's story (Thu 15 Oct 2026, all names DEMO).
-- Run after schema.sql:  psql -v ON_ERROR_STOP=1 -f schema.sql -f seed.sql
-- Volume: ~1.6M dbq_item rows (3 days of DONE history plus today's live state at the frozen clock 12:06:00).
-- Determinism: every random draw is dbq_rand(<stable key>) (md5 based), so results do not depend on plan order.
-- Production has no seed; the frozen clock is dbq_now() in schema.sql.

SET client_min_messages = warning;
SELECT setseed(0.42);   -- belt and braces; the generator below does not call random()

CREATE OR REPLACE FUNCTION dbq_rand(s text) RETURNS double precision
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT ('x' || substr(md5(s), 1, 7))::bit(28)::int / 268435456.0 $$;

TRUNCATE dbq_item, dbq_attempt, dbq_snapshot, dbq_worker, dbq_queue_config, dbq_action_audit;

-- ---------------------------------------------------------------------------
-- Queue settings and the consumer registry
-- ---------------------------------------------------------------------------
INSERT INTO dbq_queue_config (queue_name, slo_wait_s, stale_after_s, paused, owner_team) VALUES
  ('payments.inbound',   900,   90, false, 'Payments Platform'),
  ('mandates.inbound',   900,   90, false, 'Payments Platform'),
  ('ledger.postings',    300,   90, false, 'Core Ledger'),
  ('notify.outbound',    600,   90, false, 'Customer Comms'),
  ('recon.daily',       3600,  300, false, 'Reconciliation'),
  ('audit.archive',    14400,  300, false, 'Platform Ops');

INSERT INTO dbq_worker (worker_id, queue_name, host, service, started_at, heartbeat_at, version) VALUES
  ('mmp-app-01:4102', 'payments.inbound', 'mmp-app-01', 'MMP',      '2026-10-15 06:02:11', '2026-10-15 12:05:51', '4.18.2'),
  ('mmp-app-01:4102', 'mandates.inbound', 'mmp-app-01', 'MMP',      '2026-10-15 06:02:11', '2026-10-15 12:05:51', '4.18.2'),
  ('mmp-app-02:3988', 'payments.inbound', 'mmp-app-02', 'MMP',      '2026-10-15 06:02:40', '2026-10-15 12:05:47', '4.18.2'),
  ('mmp-app-02:3988', 'mandates.inbound', 'mmp-app-02', 'MMP',      '2026-10-15 06:02:40', '2026-10-15 12:05:47', '4.18.2'),
  ('mmp-app-03:4211', 'payments.inbound', 'mmp-app-03', 'MMP',      '2026-10-15 06:03:02', '2026-10-15 10:42:13', '4.18.2'),
  ('mmp-app-03:4211', 'mandates.inbound', 'mmp-app-03', 'MMP',      '2026-10-15 06:03:02', '2026-10-15 10:42:13', '4.18.2'),
  ('mmp-app-04:4050', 'payments.inbound', 'mmp-app-04', 'MMP',      '2026-10-15 06:03:19', '2026-10-15 12:05:55', '4.18.2'),
  ('mmp-app-04:4050', 'mandates.inbound', 'mmp-app-04', 'MMP',      '2026-10-15 06:03:19', '2026-10-15 12:05:55', '4.18.2'),
  ('ledger-svc-01:2210', 'ledger.postings', 'ledger-svc-01', 'Ledger', '2026-10-15 05:58:02', '2026-10-15 12:05:58', '2.9.0'),
  ('ledger-svc-02:2236', 'ledger.postings', 'ledger-svc-02', 'Ledger', '2026-10-15 05:58:09', '2026-10-15 12:05:49', '2.9.0'),
  ('notify-svc-01:1877', 'notify.outbound', 'notify-svc-01', 'Notifier', '2026-10-15 06:10:00', '2026-10-15 12:05:52', '1.4.7'),
  ('recon-batch-01:991', 'recon.daily',     'recon-batch-01', 'Recon',  '2026-10-15 06:59:30', '2026-10-15 12:05:58', '3.1.0'),
  ('archiver-01:715',    'audit.archive',   'archiver-01',    'Archiver','2026-10-14 22:00:00', '2026-10-15 12:05:40', '0.9.3');

-- Staging copy of dbq_item without constraints; payload_ref is the unique join key until ids are assigned.
DROP TABLE IF EXISTS stg, stg_attempt, pay_file, pay_sched, storm;
CREATE TEMP TABLE stg AS SELECT * FROM dbq_item WITH NO DATA;
CREATE TEMP TABLE stg_attempt (payload_ref text, attempt int, queue_name text, worker text,
                               started_at timestamp, finished_at timestamp, outcome text, error text);

-- ---------------------------------------------------------------------------
-- payments.inbound: AIS files, FIFO-processed by MMP (4 instances at 150/min each; 3 after mmp-app-03 hangs at 10:42:13)
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE pay_file AS
SELECT row_number() OVER (ORDER BY landed_at, name)::int AS seq, name, landed_at, n_rows
FROM (
  SELECT 'DEMO_FPS_' || to_char(ts, 'YYYYMMDD_HH24MI') || '.csv' AS name, ts AS landed_at,
         400 + floor(dbq_rand('fps' || ts::text) * 2000)::int AS n_rows
  FROM generate_series(timestamp '2026-10-12 07:00', timestamp '2026-10-15 12:00', interval '15 minutes') ts
  WHERE ts::time BETWEEN time '07:00' AND time '19:00'
  UNION ALL
  SELECT 'DEMO_BACS_' || to_char(d, 'YYYYMMDD') || '_0900.csv', d + interval '9 hours 10 minutes',
         CASE WHEN d = timestamp '2026-10-15' THEN 3200 ELSE 3000 + floor(dbq_rand('bacs' || d::text) * 400)::int END
  FROM generate_series(timestamp '2026-10-12', timestamp '2026-10-15', interval '1 day') d
  UNION ALL SELECT 'DEMO_FPS_20261015_1041.csv',      timestamp '2026-10-15 10:41:00',   380
  UNION ALL SELECT 'DEMO_FPS_BULK_20261015_1112.csv', timestamp '2026-10-15 11:15:00', 48000
) x;

-- File-level FIFO schedule: a file starts when it lands or when the previous one finishes, whichever is later.
CREATE TEMP TABLE pay_sched AS
WITH RECURSIVE r(seq, start_at, rate, end_at) AS (
  SELECT f.seq, f.landed_at, 10.0::float8, f.landed_at + f.n_rows / 10.0 * interval '1 second'
  FROM pay_file f WHERE f.seq = 1
  UNION ALL
  SELECT f.seq, x.start_at, x.rate, x.start_at + f.n_rows / x.rate * interval '1 second'
  FROM r
  JOIN pay_file f ON f.seq = r.seq + 1
  CROSS JOIN LATERAL (
    SELECT greatest(f.landed_at, r.end_at) AS start_at,
           CASE WHEN greatest(f.landed_at, r.end_at) < timestamp '2026-10-15 10:42:13' THEN 10.0 ELSE 7.5 END::float8 AS rate
  ) x
)
SELECT * FROM r;

INSERT INTO stg (queue_name, status, priority, payload_ref, producer, batch_ref, created_at, available_at,
                 claimed_by, claimed_at, heartbeat_at, attempts, max_attempts, last_error, completed_at)
SELECT 'payments.inbound', st.status, 0,
       'PAY-' || to_char(f.landed_at, 'YYMMDD') || '-' || lpad(f.seq::text, 3, '0') || '-' || lpad(g.k::text, 5, '0'),
       'AIS', f.name, t.created_at, t.created_at,
       CASE WHEN c.stuck THEN 'mmp-app-03:4211'
            WHEN st.status = 'QUEUED' THEN NULL
            WHEN c.claim_at < timestamp '2026-10-15 10:42:13'
              THEN (ARRAY['mmp-app-01:4102','mmp-app-02:3988','mmp-app-03:4211','mmp-app-04:4050'])[1 + g.k % 4]
            ELSE (ARRAY['mmp-app-01:4102','mmp-app-02:3988','mmp-app-04:4050'])[1 + g.k % 3] END,
       CASE st.status WHEN 'QUEUED' THEN NULL
                      WHEN 'PROCESSING' THEN CASE WHEN c.stuck THEN c.claim_at
                                                  ELSE timestamp '2026-10-15 12:06' - t.r * interval '10 seconds' END
                      ELSE c.claim_at END,
       CASE st.status WHEN 'QUEUED' THEN NULL
                      WHEN 'PROCESSING' THEN CASE WHEN c.stuck THEN timestamp '2026-10-15 10:42:13'
                                                  ELSE timestamp '2026-10-15 12:06' - t.r * interval '5 seconds' END
                      ELSE c.claim_at END,
       CASE WHEN st.status = 'QUEUED' THEN 0 ELSE 1 END, 10, NULL,
       CASE WHEN st.status = 'DONE' THEN t.done_at END
FROM pay_file f
JOIN pay_sched s USING (seq)
CROSS JOIN LATERAL generate_series(1, f.n_rows) AS g(k)
CROSS JOIN LATERAL (SELECT f.landed_at + (g.k - 1) / 133.33 * interval '1 second' AS created_at,
                           s.start_at + g.k / s.rate * interval '1 second'     AS done_at,
                           dbq_rand('p' || f.seq || ':' || g.k)                AS r) t
CROSS JOIN LATERAL (SELECT (f.name = 'DEMO_FPS_20261015_1041.csv' AND g.k BETWEEN 201 AND 225) AS stuck,
                           greatest(t.created_at + interval '0.2 second',
                                    t.done_at - (0.3 + 0.9 * t.r) * interval '1 second') AS claim_at) c
CROSS JOIN LATERAL (SELECT CASE WHEN c.stuck THEN 'PROCESSING'
                                WHEN t.done_at <= timestamp '2026-10-15 12:06:00' THEN 'DONE'
                                WHEN t.done_at <= timestamp '2026-10-15 12:06:10' THEN 'PROCESSING'
                                ELSE 'QUEUED' END AS status) st;

-- The poison message: BACS file row 1207 fails deterministically on every worker, 10 attempts, dead at 11:43.
WITH p AS (
  SELECT payload_ref, claimed_at AS a1 FROM stg
  WHERE batch_ref = 'DEMO_BACS_20261015_0900.csv' AND payload_ref LIKE '%-01207'
), a AS (
  SELECT p.payload_ref, x.n, p.a1 + x.off_min * interval '1 minute' AS started_at, x.worker
  FROM p CROSS JOIN (VALUES (1, 0, 'mmp-app-01:4102'), (2, 1, 'mmp-app-04:4050'), (3, 3, 'mmp-app-02:3988'),
                            (4, 7, 'mmp-app-03:4211'), (5, 15, 'mmp-app-01:4102'), (6, 31, 'mmp-app-02:3988'),
                            (7, 61, 'mmp-app-03:4211'), (8, 91, 'mmp-app-04:4050'), (9, 121, 'mmp-app-01:4102'),
                            (10, 151, 'mmp-app-02:3988')) AS x(n, off_min, worker)
)
INSERT INTO stg_attempt
SELECT payload_ref, n, 'payments.inbound', worker, started_at, started_at + interval '0.21 second', 'FAILED',
       'java.lang.IllegalArgumentException: Creditor IBAN failed checksum: ''GB00DEMO00000012345678'' (row 1207)'
FROM a;

UPDATE stg s SET status = 'DEAD', attempts = 10,
       claimed_by = 'mmp-app-02:3988', claimed_at = a.started_at, heartbeat_at = a.started_at,
       available_at = a.started_at, completed_at = a.finished_at, last_error = a.error
FROM stg_attempt a
WHERE a.payload_ref = s.payload_ref AND a.attempt = 10;

-- Background transient failures (~0.15% of today's completed payments): fail once, succeed 30 s later.
WITH tf AS (
  SELECT payload_ref, claimed_by, claimed_at, completed_at,
         (ARRAY['org.springframework.dao.CannotAcquireLockException: could not obtain lock on row in relation "payment_instruction" (lock timeout 2000 ms)',
                'java.net.SocketTimeoutException: Read timed out (sanctions-screening.demo.internal:443) after 5000 ms',
                'org.springframework.web.client.HttpServerErrorException$ServiceUnavailable: 503 Service Unavailable from POST https://fx-rates.demo.internal/v2/quote/'
                  || (100000 + floor(dbq_rand('fxq' || payload_ref) * 899999))::int])
           [1 + floor(dbq_rand('tfe' || payload_ref) * 3)::int] AS err
  FROM stg
  WHERE queue_name = 'payments.inbound' AND status = 'DONE' AND attempts = 1
    AND claimed_at >= timestamp '2026-10-15 00:00' AND completed_at <= timestamp '2026-10-15 12:04'
    AND dbq_rand('tf' || payload_ref) < 0.0015
), ins AS (
  INSERT INTO stg_attempt
  SELECT payload_ref, 1, 'payments.inbound', claimed_by, claimed_at, claimed_at + interval '0.4 second', 'FAILED', err FROM tf
)
UPDATE stg s SET attempts = 2, last_error = tf.err,
       claimed_at = tf.claimed_at + interval '30 seconds', heartbeat_at = tf.claimed_at + interval '30 seconds',
       available_at = tf.claimed_at + interval '30.4 seconds', completed_at = tf.completed_at + interval '30 seconds'
FROM tf WHERE tf.payload_ref = s.payload_ref;

-- ---------------------------------------------------------------------------
-- ledger.postings: MMP writes one posting per completed payment; Ledger consumes. Retry storm 11:50-12:08.
-- ---------------------------------------------------------------------------
INSERT INTO stg (queue_name, status, priority, payload_ref, producer, batch_ref, created_at, available_at,
                 claimed_by, claimed_at, heartbeat_at, attempts, max_attempts, last_error, completed_at)
SELECT 'ledger.postings',
       CASE WHEN x.done_at <= timestamp '2026-10-15 12:06' THEN 'DONE'
            WHEN x.claim_at <= timestamp '2026-10-15 12:06' THEN 'PROCESSING' ELSE 'QUEUED' END,
       0, 'POST-' || substr(p.payload_ref, 5), 'MMP', p.batch_ref, x.created_at, x.created_at,
       CASE WHEN x.claim_at <= timestamp '2026-10-15 12:06' THEN x.worker END,
       CASE WHEN x.claim_at <= timestamp '2026-10-15 12:06' THEN x.claim_at END,
       CASE WHEN x.claim_at <= timestamp '2026-10-15 12:06' THEN x.claim_at END,
       CASE WHEN x.claim_at <= timestamp '2026-10-15 12:06' THEN 1 ELSE 0 END, 5, NULL,
       CASE WHEN x.done_at <= timestamp '2026-10-15 12:06' THEN x.done_at END
FROM stg p
CROSS JOIN LATERAL (SELECT p.completed_at + interval '0.05 second' AS created_at,
                           dbq_rand('l' || p.payload_ref) AS r) b
CROSS JOIN LATERAL (SELECT b.created_at,
                           b.created_at + (0.5 + 1.5 * b.r) * interval '1 second' AS claim_at,
                           b.created_at + (0.7 + 1.9 * b.r) * interval '1 second' AS done_at,
                           CASE WHEN b.r < 0.5 THEN 'ledger-svc-01:2210' ELSE 'ledger-svc-02:2236' END AS worker) x
WHERE p.queue_name = 'payments.inbound' AND p.status = 'DONE';

-- Storm: cbs-gateway read timeouts (30 s each), 60% of attempts fail, backoff 30s/60s/120s/240s, max 5 attempts.
CREATE TEMP TABLE storm AS
SELECT s.payload_ref, a.n,
       s.created_at + a.start_off * interval '1 second' AS started_at,
       dbq_rand('storm' || s.payload_ref || ':' || a.n) < 0.6 AS fails,
       CASE WHEN dbq_rand('sw' || s.payload_ref || ':' || a.n) < 0.5 THEN 'ledger-svc-01:2210' ELSE 'ledger-svc-02:2236' END AS worker
FROM stg s
CROSS JOIN (VALUES (1, 1), (2, 61), (3, 151), (4, 301), (5, 571)) AS a(n, start_off)
WHERE s.queue_name = 'ledger.postings' AND s.created_at >= timestamp '2026-10-15 11:50';

WITH per_item AS (
  SELECT payload_ref, min(n) FILTER (WHERE NOT fails) AS first_ok FROM storm GROUP BY payload_ref
), happened AS (
  SELECT st.*, pi.first_ok FROM storm st JOIN per_item pi USING (payload_ref)
  WHERE st.started_at <= timestamp '2026-10-15 12:06' AND (pi.first_ok IS NULL OR st.n <= pi.first_ok)
)
INSERT INTO stg_attempt
SELECT payload_ref, n, 'ledger.postings', worker, started_at,
       started_at + CASE WHEN fails THEN interval '30 seconds' ELSE interval '0.5 second' END,
       CASE WHEN fails THEN 'FAILED' ELSE 'SUCCESS' END,
       CASE WHEN fails THEN 'java.net.SocketTimeoutException: Read timed out after 30000 ms calling POST https://cbs-gateway.demo.internal:8443/v1/postings/'
                            || substr(payload_ref, 6) END
FROM happened
WHERE started_at + CASE WHEN fails THEN interval '30 seconds' ELSE interval '0.5 second' END <= timestamp '2026-10-15 12:06';

-- Item state at 12:06 from its attempts (finished ones are in stg_attempt; an unfinished one is in flight).
WITH per_item AS (
  SELECT payload_ref, min(n) FILTER (WHERE NOT fails) AS first_ok,
         max(n) FILTER (WHERE started_at <= timestamp '2026-10-15 12:06') AS last_started_any
  FROM storm GROUP BY payload_ref
), cur AS (
  SELECT pi.payload_ref,
         least(pi.last_started_any, coalesce(pi.first_ok, 5)) AS n
  FROM per_item pi
), cur_attempt AS (
  SELECT c.payload_ref, c.n, st.started_at, st.fails, st.worker,
         st.started_at + CASE WHEN st.fails THEN interval '30 seconds' ELSE interval '0.5 second' END AS finished_at,
         (SELECT s2.started_at FROM storm s2 WHERE s2.payload_ref = c.payload_ref AND s2.n = c.n + 1) AS next_start
  FROM cur c JOIN storm st ON st.payload_ref = c.payload_ref AND st.n = c.n
  WHERE c.n IS NOT NULL
)
UPDATE stg s SET
  attempts     = ca.n,
  claimed_by   = ca.worker,
  claimed_at   = ca.started_at,
  heartbeat_at = CASE WHEN ca.finished_at > timestamp '2026-10-15 12:06' THEN timestamp '2026-10-15 12:05:52' ELSE ca.started_at END,
  status       = CASE WHEN ca.finished_at > timestamp '2026-10-15 12:06' THEN 'PROCESSING'
                      WHEN NOT ca.fails THEN 'DONE'
                      WHEN ca.n = 5 THEN 'DEAD'
                      ELSE 'FAILED' END,
  available_at = CASE WHEN ca.finished_at <= timestamp '2026-10-15 12:06' AND ca.fails AND ca.n < 5 THEN ca.next_start ELSE s.available_at END,
  completed_at = CASE WHEN ca.finished_at <= timestamp '2026-10-15 12:06' AND (NOT ca.fails OR ca.n = 5) THEN ca.finished_at END,
  last_error   = CASE WHEN ca.n > 1 OR ca.fails THEN
                   'java.net.SocketTimeoutException: Read timed out after 30000 ms calling POST https://cbs-gateway.demo.internal:8443/v1/postings/'
                   || substr(s.payload_ref, 6) END
FROM cur_attempt ca
WHERE ca.payload_ref = s.payload_ref;
-- Storm items not yet attempted at 12:06 (created in the last second) stay QUEUED.
UPDATE stg s SET status = 'QUEUED', claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL, attempts = 0, completed_at = NULL
WHERE s.queue_name = 'ledger.postings' AND s.created_at >= timestamp '2026-10-15 11:50'
  AND NOT EXISTS (SELECT 1 FROM storm st WHERE st.payload_ref = s.payload_ref AND st.started_at <= timestamp '2026-10-15 12:06');

-- ---------------------------------------------------------------------------
-- notify.outbound (10% of completed payments), mandates.inbound (one every 4 s), recon.daily (two runs a day)
-- ---------------------------------------------------------------------------
INSERT INTO stg (queue_name, status, priority, payload_ref, producer, batch_ref, created_at, available_at,
                 claimed_by, claimed_at, heartbeat_at, attempts, max_attempts, last_error, completed_at)
SELECT 'notify.outbound',
       CASE WHEN x.done_at <= timestamp '2026-10-15 12:06' THEN 'DONE'
            WHEN x.claim_at <= timestamp '2026-10-15 12:06' THEN 'PROCESSING' ELSE 'QUEUED' END,
       0, 'NTF-' || substr(p.payload_ref, 5), 'MMP', NULL, x.created_at, x.created_at,
       CASE WHEN x.claim_at <= timestamp '2026-10-15 12:06' THEN 'notify-svc-01:1877' END,
       CASE WHEN x.claim_at <= timestamp '2026-10-15 12:06' THEN x.claim_at END,
       CASE WHEN x.claim_at <= timestamp '2026-10-15 12:06' THEN x.claim_at END,
       CASE WHEN x.claim_at <= timestamp '2026-10-15 12:06' THEN 1 ELSE 0 END, 8, NULL,
       CASE WHEN x.done_at <= timestamp '2026-10-15 12:06' THEN x.done_at END
FROM stg p
CROSS JOIN LATERAL (SELECT p.completed_at + interval '0.1 second' AS created_at, dbq_rand('n' || p.payload_ref) AS r) b
CROSS JOIN LATERAL (SELECT b.created_at,
                           b.created_at + (0.5 + 1.0 * b.r) * interval '1 second' AS claim_at,
                           b.created_at + (0.6 + 1.2 * b.r) * interval '1 second' AS done_at) x
WHERE p.queue_name = 'payments.inbound' AND p.status = 'DONE' AND dbq_rand('nsel' || p.payload_ref) < 0.10;

INSERT INTO stg (queue_name, status, priority, payload_ref, producer, batch_ref, created_at, available_at,
                 claimed_by, claimed_at, heartbeat_at, attempts, max_attempts, last_error, completed_at)
SELECT 'mandates.inbound',
       CASE WHEN x.stuck THEN 'PROCESSING'
            WHEN x.done_at <= timestamp '2026-10-15 12:06' THEN 'DONE'
            WHEN x.claim_at <= timestamp '2026-10-15 12:06' THEN 'PROCESSING' ELSE 'QUEUED' END,
       0, 'MND-' || to_char(t, 'YYMMDD-HH24MISS'), 'AIS', 'DEMO_MANDATES_' || to_char(t, 'YYYYMMDD') || '.stream', t, t,
       CASE WHEN x.stuck THEN 'mmp-app-03:4211'
            WHEN x.claim_at > timestamp '2026-10-15 12:06' THEN NULL
            WHEN t < timestamp '2026-10-15 10:42:13'
              THEN (ARRAY['mmp-app-01:4102','mmp-app-02:3988','mmp-app-03:4211','mmp-app-04:4050'])[1 + floor(x.r * 4)::int]
            ELSE (ARRAY['mmp-app-01:4102','mmp-app-02:3988','mmp-app-04:4050'])[1 + floor(x.r * 3)::int] END,
       CASE WHEN x.claim_at <= timestamp '2026-10-15 12:06' THEN x.claim_at END,
       CASE WHEN x.stuck THEN timestamp '2026-10-15 10:42:13' WHEN x.claim_at <= timestamp '2026-10-15 12:06' THEN x.claim_at END,
       CASE WHEN x.claim_at <= timestamp '2026-10-15 12:06' THEN 1 ELSE 0 END, 10, NULL,
       CASE WHEN NOT x.stuck AND x.done_at <= timestamp '2026-10-15 12:06' THEN x.done_at END
FROM generate_series(timestamp '2026-10-12 07:00', timestamp '2026-10-15 12:06', interval '4 seconds') t
CROSS JOIN LATERAL (SELECT dbq_rand('m' || t::text) AS r) b
CROSS JOIN LATERAL (SELECT b.r,
                           t + (1 + 2 * b.r) * interval '1 second' AS claim_at,
                           t + (1.2 + 2.3 * b.r) * interval '1 second' AS done_at,
                           t IN (timestamp '2026-10-15 10:41:52', timestamp '2026-10-15 10:41:56', timestamp '2026-10-15 10:42:00') AS stuck) x
WHERE t::time BETWEEN time '07:00' AND time '19:00';

INSERT INTO stg (queue_name, status, priority, payload_ref, producer, batch_ref, created_at, available_at,
                 claimed_by, claimed_at, heartbeat_at, attempts, max_attempts, last_error, completed_at)
SELECT 'recon.daily',
       CASE WHEN x.done_at <= timestamp '2026-10-15 12:06' THEN 'DONE'
            WHEN x.claim_at <= timestamp '2026-10-15 12:06' THEN 'PROCESSING' ELSE 'QUEUED' END,
       0, 'RCN-' || to_char(run, 'YYMMDD-HH24MI') || '-' || lpad(k::text, 4, '0'), 'recon-scheduler',
       'RECON_' || to_char(run, 'YYYYMMDD_HH24MI'), x.created_at, x.created_at,
       CASE WHEN x.claim_at <= timestamp '2026-10-15 12:06' THEN 'recon-batch-01:991' END,
       CASE WHEN x.claim_at <= timestamp '2026-10-15 12:06' THEN x.claim_at END,
       CASE WHEN x.claim_at <= timestamp '2026-10-15 12:06' THEN x.claim_at END,
       CASE WHEN x.claim_at <= timestamp '2026-10-15 12:06' THEN 1 ELSE 0 END, 3, NULL,
       CASE WHEN x.done_at <= timestamp '2026-10-15 12:06' THEN x.done_at END
FROM generate_series(timestamp '2026-10-12', timestamp '2026-10-15', interval '1 day') d
CROSS JOIN (VALUES (interval '7 hours'), (interval '12 hours')) AS h(off)
CROSS JOIN LATERAL (SELECT d + h.off AS run) r
CROSS JOIN generate_series(1, 1200) k
CROSS JOIN LATERAL (SELECT run + k * interval '4 milliseconds' AS created_at,
                           run + (8 + k * 2) * interval '1 second' AS claim_at,
                           run + (10 + k * 2) * interval '1 second' AS done_at) x
WHERE run <= timestamp '2026-10-15 12:06';

-- ---------------------------------------------------------------------------
-- audit.archive: every service writes ~200/min around the clock; archiver drains in a batch every 10 minutes (SLO 4 h)
-- ---------------------------------------------------------------------------
INSERT INTO stg (queue_name, status, priority, payload_ref, producer, batch_ref, created_at, available_at,
                 claimed_by, claimed_at, heartbeat_at, attempts, max_attempts, last_error, completed_at)
SELECT 'audit.archive',
       CASE WHEN x.done_at <= timestamp '2026-10-15 12:06' THEN 'DONE' ELSE 'QUEUED' END,
       0, 'AUD-' || i, x.producer, NULL, x.created_at, x.created_at,
       CASE WHEN x.done_at <= timestamp '2026-10-15 12:06' THEN 'archiver-01:715' END,
       CASE WHEN x.done_at <= timestamp '2026-10-15 12:06' THEN x.done_at - interval '5 milliseconds' END,
       CASE WHEN x.done_at <= timestamp '2026-10-15 12:06' THEN x.done_at - interval '5 milliseconds' END,
       CASE WHEN x.done_at <= timestamp '2026-10-15 12:06' THEN 1 ELSE 0 END, 5, NULL,
       CASE WHEN x.done_at <= timestamp '2026-10-15 12:06' THEN x.done_at END
FROM generate_series(0, (extract(epoch FROM timestamp '2026-10-15 12:06' - timestamp '2026-10-12 00:00') / 0.3)::int - 1) i
CROSS JOIN LATERAL (SELECT timestamp '2026-10-12 00:00' + i * interval '0.3 second' AS created_at) a
CROSS JOIN LATERAL (SELECT date_bin(interval '10 minutes', a.created_at, timestamp '2026-10-12 00:00') AS prev_batch) b
CROSS JOIN LATERAL (SELECT a.created_at,
                           b.prev_batch + interval '10 minutes'
                             + floor(extract(epoch FROM a.created_at - b.prev_batch) / 0.3) * interval '10 milliseconds' AS done_at,
                           (ARRAY['MMP','MMP','MMP','AIS','AIS','Ledger','Ledger','Notifier'])[1 + i % 8] AS producer) x;

-- ---------------------------------------------------------------------------
-- Load: ids follow creation time, like a real sequence. Then pin the poison message's id used across the prototypes.
-- ---------------------------------------------------------------------------
INSERT INTO dbq_item (queue_name, status, priority, payload_ref, producer, batch_ref, created_at, available_at,
                      claimed_by, claimed_at, heartbeat_at, attempts, max_attempts, last_error, completed_at)
SELECT queue_name, status, priority, payload_ref, producer, batch_ref, created_at, available_at,
       claimed_by, claimed_at, heartbeat_at, attempts, max_attempts, last_error, completed_at
FROM stg ORDER BY created_at, payload_ref;

UPDATE dbq_item SET id = 88120473
WHERE batch_ref = 'DEMO_BACS_20261015_0900.csv' AND payload_ref LIKE '%-01207';

-- Attempt log for today: explicit failure histories plus one SUCCESS row per item finished on its first attempt.
INSERT INTO dbq_attempt (item_id, attempt, queue_name, worker, started_at, finished_at, outcome, error)
SELECT i.id, a.attempt, a.queue_name, a.worker, a.started_at, a.finished_at, a.outcome, a.error
FROM stg_attempt a JOIN dbq_item i ON i.payload_ref = a.payload_ref;

INSERT INTO dbq_attempt (item_id, attempt, queue_name, worker, started_at, finished_at, outcome, error)
SELECT i.id, i.attempts, i.queue_name, i.claimed_by, i.claimed_at, i.completed_at, 'SUCCESS', NULL
FROM dbq_item i
WHERE i.status = 'DONE' AND i.completed_at >= timestamp '2026-10-15 00:00'
  AND NOT EXISTS (SELECT 1 FROM dbq_attempt x WHERE x.item_id = i.id AND x.attempt = i.attempts);

ANALYZE dbq_item; ANALYZE dbq_attempt;

-- ---------------------------------------------------------------------------
-- dbq_snapshot for today 07:00-12:05, RECONSTRUCTED from item timestamps (production writes it forward with P18).
-- Approximation: a FAILED item counts as scheduled until available_at, and an item with attempts > 1 counts as
-- scheduled between its first attempt (from dbq_attempt) and its last claim (the item row keeps only the last claim).
-- ---------------------------------------------------------------------------
INSERT INTO dbq_snapshot (queue_name, taken_at, waiting, scheduled, in_flight, stuck, dead, oldest_wait_s,
                          arrived_1m, completed_1m, failed_1m)
SELECT q.queue_name, m.taken_at,
       w.waiting, w.scheduled, w.in_flight, w.stuck,
       (SELECT count(*) FROM dbq_item d
         WHERE d.queue_name = q.queue_name AND d.status = 'DEAD' AND d.completed_at <= m.taken_at),
       extract(epoch FROM m.taken_at - w.oldest_waiting)::int,
       (SELECT count(*) FROM dbq_item a
         WHERE a.queue_name = q.queue_name AND a.created_at > m.taken_at - interval '1 minute' AND a.created_at <= m.taken_at),
       (SELECT count(*) FROM dbq_item c
         WHERE c.queue_name = q.queue_name AND c.completed_at > m.taken_at - interval '1 minute'
           AND c.completed_at <= m.taken_at AND c.status = 'DONE'),
       (SELECT count(*) FROM dbq_attempt f
         WHERE f.queue_name = q.queue_name AND f.outcome = 'FAILED'
           AND f.finished_at > m.taken_at - interval '1 minute' AND f.finished_at <= m.taken_at)
FROM dbq_queue_config q
CROSS JOIN generate_series(timestamp '2026-10-15 07:00', timestamp '2026-10-15 12:05', interval '1 minute') AS m(taken_at)
CROSS JOIN LATERAL (
  SELECT count(*) FILTER (WHERE NOT sch AND (i.claimed_at IS NULL OR i.claimed_at > m.taken_at))           AS waiting,
         count(*) FILTER (WHERE sch)                                                                        AS scheduled,
         count(*) FILTER (WHERE NOT sch AND NOT stk AND i.claimed_at <= m.taken_at)                         AS in_flight,
         count(*) FILTER (WHERE stk)                                                                        AS stuck,
         min(i.created_at) FILTER (WHERE NOT sch AND (i.claimed_at IS NULL OR i.claimed_at > m.taken_at))   AS oldest_waiting
  FROM dbq_item i
  CROSS JOIN LATERAL (SELECT
      ((i.status = 'FAILED' AND i.claimed_at <= m.taken_at AND i.available_at > m.taken_at)
        OR (i.attempts > 1 AND i.claimed_at > m.taken_at
            AND m.taken_at >= (SELECT min(a.started_at) FROM dbq_attempt a WHERE a.item_id = i.id))) AS sch,
      (i.status = 'PROCESSING' AND i.claimed_at <= m.taken_at
        AND i.heartbeat_at < m.taken_at - interval '90 seconds') AS stk) f
  WHERE i.queue_name = q.queue_name
    AND i.created_at <= m.taken_at AND i.created_at > m.taken_at - interval '3 hours'
    AND (i.completed_at IS NULL OR i.completed_at > m.taken_at)
) w;

ANALYZE;
