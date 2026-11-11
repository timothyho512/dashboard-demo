# DBQ console SQL: Oracle 19c+ and SQL Server equivalents

**Status: NOT EXECUTED.**
Only the PostgreSQL 17 versions in `panels.sql` were run (see the results file).
Everything below is a hand translation for review by someone with an Oracle or SQL Server instance.
It covers P1, P2, P8, P10, P17 release and the claim query, which together exercise every construct that needs translating.

Conventions used below:

- `now` is the database clock in UTC.
  Oracle: `LOCALTIMESTAMP` with every session set to `TIME_ZONE = 'UTC'` (or `SYS_EXTRACT_UTC(SYSTIMESTAMP)` everywhere).
  SQL Server: `SYSUTCDATETIME()`, captured once per batch as `@now`.
  PostgreSQL production: `LOCALTIMESTAMP` with `TimeZone = 'UTC'` (the test harness freezes it as `dbq_now()`).
- Binds are written `:name` for Oracle and `@name` for SQL Server.
- Timestamps are `TIMESTAMP` (Oracle) and `DATETIME2(6)` (SQL Server), never `DATE` / `DATETIME`.

## Translation points

| PostgreSQL construct | Oracle 19c+ | SQL Server 2019+ |
| --- | --- | --- |
| Partial index `... WHERE status IN (...)` | No partial indexes. Index virtual columns that are `NULL` outside the subset (B-tree skips entries whose key columns are all `NULL`). Every key column must be such a `CASE`, or every row gets indexed. Queries must filter on the virtual columns. | Filtered index `WHERE status IN ('QUEUED','FAILED')` works. Queries must repeat the literal predicate (a bind parameter in its place does not match the filter). Sessions doing DML need `QUOTED_IDENTIFIER` and `ANSI_NULLS` ON (JDBC default). |
| `ts - interval '5 minutes'`, `n * interval '1 second'` | `ts - INTERVAL '5' MINUTE`, `NUMTODSINTERVAL(n, 'SECOND')` | `DATEADD(MINUTE, -5, ts)`, `DATEADD(SECOND, -n, ts)` |
| `extract(epoch FROM a - b)` (seconds) | `ROUND((CAST(a AS DATE) - CAST(b AS DATE)) * 86400)` (whole seconds), or sum the `EXTRACT(DAY/HOUR/MINUTE/SECOND ...)` parts of the interval for fractions | `DATEDIFF(SECOND, b, a)`; `DATEDIFF_BIG(MILLISECOND, b, a) / 1000.0` for fractions |
| `count(*) FILTER (WHERE p)` | `COUNT(CASE WHEN p THEN 1 END)` | same as Oracle |
| `percentile_cont(0.95) WITHIN GROUP (ORDER BY x)` (aggregate; P6, P11) | Same syntax, works as an aggregate | Only as a window function: `PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY x) OVER (PARTITION BY ...)`, then `DISTINCT` or `TOP (1)` to collapse the rows |
| `regexp_replace(s, p, r, 'g')` (fingerprint) | `REGEXP_REPLACE(s, p, r)` replaces every occurrence by default | No regex before SQL Server 2025. Options: SQL Server 2025 `REGEXP_REPLACE` (check its occurrence default and compatibility-level requirement), a CLR function, or (recommended for all three databases) have the worker write an `error_fp` column when it records a failure |
| `LATERAL (...)` | `CROSS APPLY` / `OUTER APPLY` (12c+) | `CROSS APPLY` / `OUTER APPLY` |
| `LIMIT n` | `FETCH FIRST n ROWS ONLY` | `TOP (n)` |
| `ORDER BY x DESC NULLS LAST` | Same syntax | No `NULLS LAST`: `ORDER BY CASE WHEN x IS NULL THEN 1 ELSE 0 END, x DESC` |
| `UPDATE ... RETURNING` feeding `INSERT` in one statement (CTE) | No DML in a CTE. PL/SQL: `UPDATE ... RETURNING id BULK COLLECT INTO l_ids;` then `INSERT` / `FORALL` | `UPDATE ... OUTPUT inserted.id INTO @released(id)` (a table variable; an `OUTPUT INTO` target cannot have triggers or foreign keys), then `INSERT ... SELECT FROM @released` |
| `UPDATE t ... FROM other` | Not in 19c (23ai adds it). Correlated subquery or `EXISTS`, or read the config value into a variable first | `UPDATE alias SET ... FROM t AS alias JOIN other ...` |
| `FOR UPDATE SKIP LOCKED` + `LIMIT` | `FOR UPDATE SKIP LOCKED` is supported, but not together with `FETCH FIRST` (ORA-02014). Open a cursor and `FETCH ... BULK COLLECT ... LIMIT n`; rows are locked as they are fetched | `WITH (ROWLOCK, UPDLOCK, READPAST)` on a `TOP (n) ... ORDER BY` CTE and `UPDATE` the CTE. `READPAST` needs READ COMMITTED or REPEATABLE READ (not SERIALIZABLE) |
| `BIGINT[]` (audit item ids), `= ANY (item_ids)` | Child table `dbq_action_item (audit_id, item_id)` (indexable both ways), or a JSON array in a `CLOB CHECK (item_ids IS JSON)` searched with `JSON_TABLE` | Child table, or `NVARCHAR(MAX)` JSON array built with `STRING_AGG` and searched with `OPENJSON` |
| `BOOLEAN` (`paused`, `is_*` flags) | No SQL `BOOLEAN` before 23ai: `NUMBER(1)` with `CHECK (paused IN (0,1))`; flags as `CASE WHEN ... THEN 1 ELSE 0 END` | `BIT`; flags as `CASE` |
| `a \|\| b` | Same | `CONCAT(a, b)` (`+` returns `NULL` if either side is `NULL`) |
| `date_trunc('minute', ts)` | `TRUNC(ts, 'MI')` (returns `DATE`; `CAST(... AS TIMESTAMP)` if needed) | `DATETRUNC(minute, ts)` (2022+), else `DATEADD(MINUTE, DATEDIFF(MINUTE, 0, ts), 0)` |
| `generate_series` (P5, P12b) | `SELECT LEVEL FROM dual CONNECT BY LEVEL <= n` | `GENERATE_SERIES(1, n)` (2022+), else a numbers table |
| `INSERT ... ON CONFLICT DO NOTHING` (P18) | `MERGE ... WHEN NOT MATCHED THEN INSERT` | `MERGE ... WITH (HOLDLOCK)`, or `INSERT ... WHERE NOT EXISTS` under `UPDLOCK, HOLDLOCK` |
| `GENERATED BY DEFAULT AS IDENTITY` | Same (12c+) | `IDENTITY(84000000, 1)` or a `SEQUENCE` |

## Oracle 19c+

### Schema deltas (partial-index emulation)

```sql
ALTER TABLE dbq_item ADD (
  ready_queue    VARCHAR2(64)  GENERATED ALWAYS AS (CASE WHEN status IN ('QUEUED','FAILED')     THEN queue_name   END) VIRTUAL,
  ready_at       TIMESTAMP     GENERATED ALWAYS AS (CASE WHEN status IN ('QUEUED','FAILED')     THEN available_at END) VIRTUAL,
  claimed_queue  VARCHAR2(64)  GENERATED ALWAYS AS (CASE WHEN status IN ('CLAIMED','PROCESSING') THEN queue_name   END) VIRTUAL,
  claimed_worker VARCHAR2(128) GENERATED ALWAYS AS (CASE WHEN status IN ('CLAIMED','PROCESSING') THEN claimed_by   END) VIRTUAL,
  dead_queue     VARCHAR2(64)  GENERATED ALWAYS AS (CASE WHEN status = 'DEAD'                    THEN queue_name   END) VIRTUAL,
  dead_at        TIMESTAMP     GENERATED ALWAYS AS (CASE WHEN status = 'DEAD'                    THEN completed_at END) VIRTUAL
);
-- Only open rows get index entries. Do NOT append a never-NULL column such as id or heartbeat_at:
-- that would index every DONE row too. The claim therefore orders by ready_at only (ties are rare and harmless).
CREATE INDEX dbq_item_ready_ix   ON dbq_item (ready_queue, ready_at);
CREATE INDEX dbq_item_claimed_ix ON dbq_item (claimed_queue, claimed_worker);
CREATE INDEX dbq_item_dead_ix    ON dbq_item (dead_queue, dead_at);
CREATE INDEX dbq_item_created_ix ON dbq_item (queue_name, created_at);
CREATE INDEX dbq_item_completed_ix ON dbq_item (queue_name, completed_at);

CREATE TABLE dbq_action_item (
  audit_id NUMBER NOT NULL REFERENCES dbq_action_audit (id),
  item_id  NUMBER NOT NULL,
  PRIMARY KEY (audit_id, item_id)
);
CREATE INDEX dbq_action_item_item_ix ON dbq_action_item (item_id);   -- P16: actions that touched one item
```

### Claim (consumer side, for reference)

```sql
DECLARE
  CURSOR c_next IS
    SELECT id
    FROM dbq_item
    WHERE ready_queue = :queue AND ready_at <= LOCALTIMESTAMP
      AND NOT EXISTS (SELECT 1 FROM dbq_queue_config WHERE queue_name = :queue AND paused = 1)
    ORDER BY ready_at
    FOR UPDATE SKIP LOCKED;
  TYPE id_tab IS TABLE OF dbq_item.id%TYPE;
  l_ids id_tab;
BEGIN
  OPEN c_next;
  FETCH c_next BULK COLLECT INTO l_ids LIMIT 25;   -- FETCH FIRST cannot be combined with FOR UPDATE
  CLOSE c_next;
  FORALL k IN 1 .. l_ids.COUNT
    UPDATE dbq_item
    SET status = 'PROCESSING', claimed_by = :me, claimed_at = LOCALTIMESTAMP,
        heartbeat_at = LOCALTIMESTAMP, attempts = attempts + 1
    WHERE id = l_ids(k);
END;
```

### P1 queue overview

```sql
CREATE OR REPLACE VIEW dbq_queue_now AS
SELECT c.queue_name,
       r.waiting, r.scheduled, f.in_flight, f.stuck, d.dead,
       ROUND((CAST(LOCALTIMESTAMP AS DATE) - CAST(r.oldest_available_at AS DATE)) * 86400) AS oldest_wait_s,
       c.slo_wait_s,
       a.arrived_5m, k.completed_5m,
       ROUND(a.arrived_5m / 5, 1)   AS in_per_min,
       ROUND(k.completed_5m / 5, 1) AS out_per_min,
       w.consumers_alive, w.consumers_total
FROM dbq_queue_config c
CROSS APPLY (
  SELECT COUNT(CASE WHEN ready_at <= LOCALTIMESTAMP THEN 1 END) AS waiting,
         COUNT(CASE WHEN ready_at >  LOCALTIMESTAMP THEN 1 END) AS scheduled,
         MIN(CASE WHEN ready_at <= LOCALTIMESTAMP THEN ready_at END) AS oldest_available_at
  FROM dbq_item
  WHERE ready_queue = c.queue_name) r
CROSS APPLY (
  SELECT COUNT(CASE WHEN heartbeat_at >= LOCALTIMESTAMP - NUMTODSINTERVAL(c.stale_after_s, 'SECOND') THEN 1 END) AS in_flight,
         COUNT(CASE WHEN heartbeat_at IS NULL
                      OR heartbeat_at <  LOCALTIMESTAMP - NUMTODSINTERVAL(c.stale_after_s, 'SECOND') THEN 1 END) AS stuck
  FROM dbq_item
  WHERE claimed_queue = c.queue_name) f
CROSS APPLY (
  SELECT COUNT(*) AS dead FROM dbq_item WHERE dead_queue = c.queue_name) d
CROSS APPLY (
  SELECT COUNT(*) AS arrived_5m FROM dbq_item
  WHERE queue_name = c.queue_name
    AND created_at > LOCALTIMESTAMP - INTERVAL '5' MINUTE AND created_at <= LOCALTIMESTAMP) a
CROSS APPLY (
  SELECT COUNT(*) AS completed_5m FROM dbq_item
  WHERE queue_name = c.queue_name AND status = 'DONE'
    AND completed_at > LOCALTIMESTAMP - INTERVAL '5' MINUTE AND completed_at <= LOCALTIMESTAMP) k
CROSS APPLY (
  SELECT COUNT(CASE WHEN heartbeat_at >= LOCALTIMESTAMP - NUMTODSINTERVAL(c.stale_after_s, 'SECOND') THEN 1 END) AS consumers_alive,
         COUNT(*) AS consumers_total
  FROM dbq_worker WHERE queue_name = c.queue_name) w;

SELECT queue_name, waiting, scheduled, in_flight, stuck, dead, oldest_wait_s, slo_wait_s,
       in_per_min, out_per_min, consumers_alive || '/' || consumers_total AS consumers
FROM dbq_queue_now
ORDER BY oldest_wait_s / slo_wait_s DESC NULLS LAST, queue_name;
```

The PostgreSQL view reads the oldest ready item in its own `LATERAL` so it is a one-row index probe.
Here it is folded into the ready-set aggregate (one range scan of the ready index instead of two); either shape is fine.

### P2 oldest waiting item per queue

```sql
SELECT c.queue_name, o.id AS oldest_item_id, o.payload_ref,
       ROUND((CAST(LOCALTIMESTAMP AS DATE) - CAST(o.available_at AS DATE)) * 86400) AS oldest_wait_s,
       ROUND((CAST(LOCALTIMESTAMP AS DATE) - CAST(o.created_at   AS DATE)) * 86400) AS oldest_age_s,
       c.slo_wait_s,
       CASE WHEN o.id IS NULL THEN 'EMPTY'
            WHEN o.available_at < LOCALTIMESTAMP - NUMTODSINTERVAL(c.slo_wait_s, 'SECOND')       THEN 'BREACH'
            WHEN o.available_at < LOCALTIMESTAMP - NUMTODSINTERVAL(c.slo_wait_s * 0.5, 'SECOND') THEN 'WARN'
            ELSE 'OK' END AS lag_status,
       b.in_backoff,
       ROUND((CAST(LOCALTIMESTAMP AS DATE) - CAST(b.oldest_backoff_created_at AS DATE)) * 86400) AS oldest_backoff_age_s
FROM dbq_queue_config c
OUTER APPLY (
  SELECT id, payload_ref, available_at, created_at
  FROM dbq_item
  WHERE ready_queue = c.queue_name AND ready_at <= LOCALTIMESTAMP
  ORDER BY ready_at
  FETCH FIRST 1 ROW ONLY) o
CROSS APPLY (
  SELECT COUNT(*) AS in_backoff, MIN(created_at) AS oldest_backoff_created_at
  FROM dbq_item
  WHERE ready_queue = c.queue_name AND ready_at > LOCALTIMESTAMP AND attempts > 0) b
ORDER BY oldest_wait_s DESC NULLS LAST;
```

### P8 stuck claims

```sql
SELECT i.id, i.queue_name, i.claimed_by, i.claimed_at, i.heartbeat_at,
       ROUND((CAST(LOCALTIMESTAMP AS DATE) - CAST(COALESCE(i.heartbeat_at, i.claimed_at) AS DATE)) * 86400) AS silent_s,
       i.attempts, i.payload_ref, i.batch_ref
FROM dbq_queue_config c
JOIN dbq_item i ON i.claimed_queue = c.queue_name
WHERE COALESCE(i.heartbeat_at, i.claimed_at) < LOCALTIMESTAMP - NUMTODSINTERVAL(c.stale_after_s, 'SECOND')
ORDER BY silent_s DESC, i.id;
```

### P10 error fingerprints (retrying or dead items)

```sql
CREATE OR REPLACE FUNCTION dbq_fingerprint (msg IN VARCHAR2) RETURN VARCHAR2
  DETERMINISTIC PARALLEL_ENABLE
IS
  PRAGMA UDF;   -- cheaper SQL-to-PL/SQL call; an inline WITH FUNCTION clause also works
BEGIN
  RETURN SUBSTR(
    REGEXP_REPLACE(
      REGEXP_REPLACE(
        REGEXP_REPLACE(msg, '''[^'']*''', '''?'''),
        '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '<uuid>'),
      '[0-9]+', '#'),
    1, 300);
END;
/

SELECT queue_name, fingerprint,
       COUNT(*) AS items,
       COUNT(CASE WHEN status = 'DEAD' THEN 1 END)  AS dead,
       COUNT(CASE WHEN status <> 'DEAD' THEN 1 END) AS retrying,
       MIN(id) AS sample_item_id
FROM (
  SELECT queue_name, status, id, dbq_fingerprint(last_error) AS fingerprint
  FROM dbq_item WHERE ready_queue IS NOT NULL AND last_error IS NOT NULL
  UNION ALL
  SELECT queue_name, status, id, dbq_fingerprint(last_error)
  FROM dbq_item WHERE dead_queue IS NOT NULL
)
GROUP BY queue_name, fingerprint      -- inline view because 19c cannot GROUP BY a select-list alias
ORDER BY items DESC
FETCH FIRST 20 ROWS ONLY;
```

### P17 release stale claims (guarded, audited, one transaction)

```sql
DECLARE
  TYPE id_tab IS TABLE OF dbq_item.id%TYPE;
  l_ids   id_tab;
  l_n     PLS_INTEGER;
  l_stale dbq_queue_config.stale_after_s%TYPE;
  l_audit dbq_action_audit.id%TYPE;
BEGIN
  SELECT stale_after_s INTO l_stale FROM dbq_queue_config WHERE queue_name = :queue;

  -- 19c has no UPDATE ... FROM, so the config value is read first and the worker check is an EXISTS.
  UPDATE dbq_item i
  SET status = 'QUEUED', claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL   -- available_at kept: same place in line
  WHERE i.claimed_queue = :queue AND i.claimed_worker = :worker
    AND i.heartbeat_at < LOCALTIMESTAMP - NUMTODSINTERVAL(l_stale, 'SECOND')
    AND EXISTS (SELECT 1 FROM dbq_worker w
                WHERE w.worker_id = i.claimed_by AND w.queue_name = i.queue_name
                  AND w.heartbeat_at < LOCALTIMESTAMP - NUMTODSINTERVAL(l_stale, 'SECOND'))
  RETURNING i.id BULK COLLECT INTO l_ids;
  l_n := l_ids.COUNT;   -- collection methods cannot appear inside SQL statements

  IF l_n <> :expected THEN
    -- an unhandled exception rolls back everything this block did
    raise_application_error(-20001, 'Preview said ' || :expected || ' items, release would touch ' || l_n
                                    || '. Refresh the preview.');
  END IF;

  INSERT INTO dbq_action_audit (actor, approver, action, queue_name, predicate, expected, affected, reason, created_at)
  VALUES (:actor, :approver, 'RELEASE_STALE_CLAIMS', :queue,
          'claimed_by = ' || :worker || ' AND claim heartbeat and worker heartbeat older than stale_after_s',
          :expected, l_n, :reason, LOCALTIMESTAMP)
  RETURNING id INTO l_audit;

  FORALL k IN 1 .. l_ids.COUNT
    INSERT INTO dbq_action_item (audit_id, item_id) VALUES (l_audit, l_ids(k));
  -- the caller commits
END;
```

## SQL Server 2019+

### Schema deltas

```sql
-- Filtered indexes match PostgreSQL's partial indexes one to one.
CREATE INDEX dbq_item_ready_ix   ON dbq_item (queue_name, available_at, id)          WHERE status IN ('QUEUED','FAILED');
CREATE INDEX dbq_item_claimed_ix ON dbq_item (queue_name, claimed_by, heartbeat_at)  WHERE status IN ('CLAIMED','PROCESSING');
CREATE INDEX dbq_item_dead_ix    ON dbq_item (queue_name, completed_at)              WHERE status = 'DEAD';
CREATE INDEX dbq_item_created_ix ON dbq_item (queue_name, created_at);
CREATE INDEX dbq_item_completed_ix ON dbq_item (queue_name, completed_at)            WHERE completed_at IS NOT NULL;
-- dbq_action_audit.item_ids NVARCHAR(MAX) CHECK (ISJSON(item_ids) = 1), or the dbq_action_item child table shown for Oracle.
-- Recommended: error_fp VARCHAR(300) written by the worker on failure (no regex needed in SQL), indexed with the ready and dead filters.
```

### Claim (consumer side, for reference)

```sql
DECLARE @now DATETIME2(6) = SYSUTCDATETIME();
WITH next AS (
  SELECT TOP (25) id, payload_ref, status, claimed_by, claimed_at, heartbeat_at, attempts
  FROM dbq_item WITH (ROWLOCK, UPDLOCK, READPAST)          -- READPAST = SKIP LOCKED
  WHERE queue_name = @queue AND status IN ('QUEUED','FAILED') AND available_at <= @now
    AND NOT EXISTS (SELECT 1 FROM dbq_queue_config WHERE queue_name = @queue AND paused = 1)
  ORDER BY available_at, id
)
UPDATE next
SET status = 'PROCESSING', claimed_by = @me, claimed_at = @now, heartbeat_at = @now, attempts = attempts + 1
OUTPUT inserted.id, inserted.payload_ref, inserted.attempts;
```

### P1 queue overview

```sql
CREATE OR ALTER VIEW dbq_queue_now AS
SELECT c.queue_name,
       r.waiting, r.scheduled, f.in_flight, f.stuck, d.dead,
       DATEDIFF(SECOND, o.oldest_available_at, SYSUTCDATETIME()) AS oldest_wait_s,
       c.slo_wait_s,
       a.arrived_5m, k.completed_5m,
       ROUND(a.arrived_5m / 5.0, 1)   AS in_per_min,
       ROUND(k.completed_5m / 5.0, 1) AS out_per_min,
       w.consumers_alive, w.consumers_total
FROM dbq_queue_config c
CROSS APPLY (
  SELECT COUNT(CASE WHEN available_at <= SYSUTCDATETIME() THEN 1 END) AS waiting,
         COUNT(CASE WHEN available_at >  SYSUTCDATETIME() THEN 1 END) AS scheduled
  FROM dbq_item
  WHERE queue_name = c.queue_name AND status IN ('QUEUED','FAILED')) r
CROSS APPLY (
  SELECT MIN(available_at) AS oldest_available_at
  FROM dbq_item
  WHERE queue_name = c.queue_name AND status IN ('QUEUED','FAILED') AND available_at <= SYSUTCDATETIME()) o
CROSS APPLY (
  SELECT COUNT(CASE WHEN heartbeat_at >= DATEADD(SECOND, -c.stale_after_s, SYSUTCDATETIME()) THEN 1 END) AS in_flight,
         COUNT(CASE WHEN heartbeat_at IS NULL
                      OR heartbeat_at <  DATEADD(SECOND, -c.stale_after_s, SYSUTCDATETIME()) THEN 1 END) AS stuck
  FROM dbq_item
  WHERE queue_name = c.queue_name AND status IN ('CLAIMED','PROCESSING')) f
CROSS APPLY (
  SELECT COUNT(*) AS dead FROM dbq_item WHERE queue_name = c.queue_name AND status = 'DEAD') d
CROSS APPLY (
  SELECT COUNT(*) AS arrived_5m FROM dbq_item
  WHERE queue_name = c.queue_name
    AND created_at > DATEADD(MINUTE, -5, SYSUTCDATETIME()) AND created_at <= SYSUTCDATETIME()) a
CROSS APPLY (
  SELECT COUNT(*) AS completed_5m FROM dbq_item
  WHERE queue_name = c.queue_name AND status = 'DONE' AND completed_at IS NOT NULL
    AND completed_at > DATEADD(MINUTE, -5, SYSUTCDATETIME()) AND completed_at <= SYSUTCDATETIME()) k
CROSS APPLY (
  SELECT COUNT(CASE WHEN heartbeat_at >= DATEADD(SECOND, -c.stale_after_s, SYSUTCDATETIME()) THEN 1 END) AS consumers_alive,
         COUNT(*) AS consumers_total
  FROM dbq_worker WHERE queue_name = c.queue_name) w;
GO

SELECT queue_name, waiting, scheduled, in_flight, stuck, dead, oldest_wait_s, slo_wait_s,
       in_per_min, out_per_min, CONCAT(consumers_alive, '/', consumers_total) AS consumers
FROM dbq_queue_now
ORDER BY CASE WHEN oldest_wait_s IS NULL THEN 1 ELSE 0 END,
         CAST(oldest_wait_s AS DECIMAL(12,2)) / slo_wait_s DESC, queue_name;
```

`completed_at IS NOT NULL` is repeated in the completions subquery so the optimizer can match the filtered index.

### P2 oldest waiting item per queue

```sql
DECLARE @now DATETIME2(6) = SYSUTCDATETIME();
SELECT c.queue_name, o.id AS oldest_item_id, o.payload_ref,
       DATEDIFF(SECOND, o.available_at, @now) AS oldest_wait_s,
       DATEDIFF(SECOND, o.created_at,   @now) AS oldest_age_s,
       c.slo_wait_s,
       CASE WHEN o.id IS NULL THEN 'EMPTY'
            WHEN DATEDIFF(SECOND, o.available_at, @now) > c.slo_wait_s       THEN 'BREACH'
            WHEN DATEDIFF(SECOND, o.available_at, @now) > c.slo_wait_s * 0.5 THEN 'WARN'
            ELSE 'OK' END AS lag_status,
       b.in_backoff,
       DATEDIFF(SECOND, b.oldest_backoff_created_at, @now) AS oldest_backoff_age_s
FROM dbq_queue_config c
OUTER APPLY (
  SELECT TOP (1) id, payload_ref, available_at, created_at
  FROM dbq_item
  WHERE queue_name = c.queue_name AND status IN ('QUEUED','FAILED') AND available_at <= @now
  ORDER BY available_at, id) o
CROSS APPLY (
  SELECT COUNT(*) AS in_backoff, MIN(created_at) AS oldest_backoff_created_at
  FROM dbq_item
  WHERE queue_name = c.queue_name AND status IN ('QUEUED','FAILED') AND available_at > @now AND attempts > 0) b
ORDER BY CASE WHEN o.id IS NULL THEN 1 ELSE 0 END, oldest_wait_s DESC;
```

### P8 stuck claims

```sql
DECLARE @now DATETIME2(6) = SYSUTCDATETIME();
SELECT i.id, i.queue_name, i.claimed_by, i.claimed_at, i.heartbeat_at,
       DATEDIFF(SECOND, COALESCE(i.heartbeat_at, i.claimed_at), @now) AS silent_s,
       i.attempts, i.payload_ref, i.batch_ref
FROM dbq_item i
JOIN dbq_queue_config c ON c.queue_name = i.queue_name
WHERE i.status IN ('CLAIMED','PROCESSING')
  AND COALESCE(i.heartbeat_at, i.claimed_at) < DATEADD(SECOND, -c.stale_after_s, @now)
ORDER BY silent_s DESC, i.id;
```

### P10 error fingerprints (retrying or dead items)

With a worker-written `error_fp` column (works on any version):

```sql
SELECT TOP (20) queue_name, error_fp AS fingerprint,
       COUNT(*) AS items,
       COUNT(CASE WHEN status = 'DEAD' THEN 1 END)  AS dead,
       COUNT(CASE WHEN status <> 'DEAD' THEN 1 END) AS retrying,
       MIN(id) AS sample_item_id
FROM dbq_item
WHERE (status IN ('QUEUED','FAILED') AND last_error IS NOT NULL) OR status = 'DEAD'
GROUP BY queue_name, error_fp
ORDER BY items DESC;
```

On SQL Server 2025 the fingerprint can be computed in SQL instead:

```sql
SELECT TOP (20) i.queue_name, f.fingerprint, COUNT(*) AS items,
       COUNT(CASE WHEN i.status = 'DEAD' THEN 1 END)  AS dead,
       COUNT(CASE WHEN i.status <> 'DEAD' THEN 1 END) AS retrying,
       MIN(i.id) AS sample_item_id
FROM dbq_item i
CROSS APPLY (SELECT LEFT(
               REGEXP_REPLACE(
                 REGEXP_REPLACE(
                   REGEXP_REPLACE(i.last_error, '''[^'']*''', '''?'''),
                   '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '<uuid>'),
                 '[0-9]+', '#'),
               300) AS fingerprint) f
WHERE (i.status IN ('QUEUED','FAILED') AND i.last_error IS NOT NULL) OR i.status = 'DEAD'
GROUP BY i.queue_name, f.fingerprint
ORDER BY items DESC;
```

### P17 release stale claims (guarded, audited, one transaction)

```sql
SET XACT_ABORT ON;
DECLARE @now DATETIME2(6) = SYSUTCDATETIME();
DECLARE @released TABLE (id BIGINT PRIMARY KEY);
BEGIN TRANSACTION;

UPDATE i
SET status = 'QUEUED', claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL   -- available_at kept: same place in line
OUTPUT inserted.id INTO @released (id)
FROM dbq_item AS i WITH (ROWLOCK, READPAST)      -- a row its worker is touching right now is skipped, not waited on
JOIN dbq_queue_config AS c ON c.queue_name = i.queue_name
WHERE i.queue_name = @queue AND i.claimed_by = @worker AND i.status IN ('CLAIMED','PROCESSING')
  AND i.heartbeat_at < DATEADD(SECOND, -c.stale_after_s, @now)
  AND EXISTS (SELECT 1 FROM dbq_worker AS w
              WHERE w.worker_id = i.claimed_by AND w.queue_name = i.queue_name
                AND w.heartbeat_at < DATEADD(SECOND, -c.stale_after_s, @now));

IF (SELECT COUNT(*) FROM @released) <> @expected
BEGIN
  ROLLBACK TRANSACTION;
  THROW 50001, 'Affected rows differ from the preview. Refresh the preview.', 1;
END;

INSERT INTO dbq_action_audit (actor, approver, action, queue_name, predicate, expected, affected, item_ids, reason, created_at)
SELECT @actor, @approver, 'RELEASE_STALE_CLAIMS', @queue,
       CONCAT('claimed_by = ', @worker, ' AND claim heartbeat and worker heartbeat older than stale_after_s'),
       @expected, COUNT(*),
       '[' + STRING_AGG(CAST(id AS VARCHAR(MAX)), ',') WITHIN GROUP (ORDER BY id) + ']',
       @reason, @now
FROM @released;

COMMIT TRANSACTION;
```

## Things that behave differently and matter for the console

- Fenced completion (`UPDATE ... WHERE id = ? AND claimed_by = me AND status = 'PROCESSING'`, check the row count) is plain SQL in all three and is what makes releasing a stuck claim safe everywhere.
- Oracle and SQL Server (with RCSI) read committed data without blocking, like PostgreSQL, so console reads never wait on consumers.
  Without RCSI, SQL Server readers take shared locks and a console count can block behind a claim; enable `READ_COMMITTED_SNAPSHOT` or read with `SNAPSHOT` isolation.
- Oracle's `FOR UPDATE SKIP LOCKED` locks at fetch time, so the batch size is whatever the cursor fetch limit is.
  SQL Server's `READPAST` skips only row and page locks.
  A table lock (for example lock escalation when one statement locks about 5,000 rows, as a large bulk retry could) makes every claim wait, so bulk actions stay batched well below that (P17d uses 500).
- In all three, one statement reads one snapshot.
  A subquery inside the same statement that re-reads rows the statement just updated sees the old values (found in PostgreSQL, see P17d in the results file).
