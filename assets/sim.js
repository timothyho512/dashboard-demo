/* DBQ console prototype: deterministic simulation of one fictional day.
 * Every concept page reads the same numbers from window.DBQ, so the
 * console, the flow map and the triage view always agree at a given minute.
 * All names, ids and files are invented sample data (DEMO_*). */
(function () {
  'use strict';

  var START_H = 7;            // 07:00
  var N = 480;                // minutes simulated: 07:00 .. 14:59
  var DATE_LABEL = 'Thu 15 Oct 2026';

  function rngFrom(seed) {    // mulberry32
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var rnd = rngFrom(20261015);
  function between(a, b) { return a + (b - a) * rnd(); }
  function ri(a, b) { return Math.round(between(a, b)); }
  function hm(h, m) { return (h - START_H) * 60 + m; }       // clock -> minute index
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function clock(min, sec) {
    var h = START_H + Math.floor(min / 60), m = min % 60;
    return pad(h) + ':' + pad(m) + (sec === undefined ? '' : ':' + pad(sec));
  }
  function zeros() { var a = new Array(N); for (var i = 0; i < N; i++) a[i] = 0; return a; }

  /* ---------- queues ---------- */
  var QUEUES = [
    { name: 'payments.inbound', pattern: 'ingestion-buffer', producer: 'AIS', consumer: 'MMP', slo: 900, stale: 90, maxAttempts: 10,
      expectedArrival: 900, arrivalWarnMultiple: 2,
      workers: ['mmp-app-01', 'mmp-app-02', 'mmp-app-03', 'mmp-app-04'], perWorker: 200, procS: 3.1,
      blurb: 'Payment records split out of ingested files' },
    { name: 'mandates.inbound', pattern: 'ingestion-buffer', producer: 'AIS', consumer: 'MMP', slo: 900, stale: 90, maxAttempts: 10,
      workers: ['mmp-app-01', 'mmp-app-02', 'mmp-app-03', 'mmp-app-04'], perWorker: 30, procS: 2.4,
      blurb: 'Direct-debit mandate instructions' },
    { name: 'ledger.postings', pattern: 'deferred-recovery', producer: 'MMP', consumer: 'Ledger', slo: 300, stale: 60, maxAttempts: 5,
      workers: ['ledger-svc-01', 'ledger-svc-02'], perWorker: 520, procS: 0.9,
      blurb: 'Postings MMP hands to the ledger service' },
    { name: 'notify.outbound', pattern: 'background-work', producer: 'MMP', consumer: 'Notifier', slo: 600, stale: 60, maxAttempts: 3,
      expectedArrival: 900, arrivalWarnMultiple: 2,
      workers: ['notify-svc-01'], perWorker: 240, procS: 1.6,
      blurb: 'Customer e-mail and SMS notifications' },
    { name: 'recon.daily', pattern: 'background-work', producer: 'recon-scheduler', consumer: 'Recon', slo: 3600, stale: 120, maxAttempts: 5,
      workers: ['recon-batch-01'], perWorker: 40, procS: 9,
      blurb: 'Reconciliation tasks created by the scheduler' },
    { name: 'audit.archive', pattern: 'consolidation', producer: 'All services', consumer: 'Archiver', slo: 14400, stale: 300, maxAttempts: 5,
      workers: ['archiver-01'], perWorker: 0, procS: 0.2,
      blurb: 'Audit events copied to cold storage in batches' },
    { name: 'notify.outbox', pattern: 'transactional-outbox', producer: 'MMP', consumer: 'Outbox publisher', slo: 120, stale: 60, maxAttempts: 8,
      workers: ['outbox-pub-01'], perWorker: 360, procS: 0.35,
      blurb: 'Committed notification events waiting to publish to notify.outbound' },
    { name: 'dead.letters', pattern: 'dead-letter', producer: 'All consumers', consumer: 'Operations', slo: 86400, stale: 600, maxAttempts: 1,
      workers: ['dlq-admin-01'], perWorker: 0, procS: 0,
      blurb: 'Dead-lettered items grouped for replay or discard' }
  ];
  var QI = {}; QUEUES.forEach(function (q, i) { QI[q.name] = i; });

  var STUCK = { worker: 'mmp-app-03', pid: 4211, min: hm(10, 42), sec: 13, claims: { 'payments.inbound': 25, 'mandates.inbound': 3 } };
  var BULK = { name: 'DEMO_FPS_BULK_20261015_1112.csv', rows: 48000, from: hm(11, 15), to: hm(11, 21) };
  var STORM = { from: hm(11, 50), to: hm(12, 14), okRate: 0.04 };
  var PRODUCER_OUTAGE = { queue: 'notify.outbound', from: hm(13, 1), to: hm(13, 50) };
  var POISON = { id: 88120473, batch: 'DEMO_BACS_20261015_0900.csv', row: 1207, firstMin: hm(9, 0), firstSec: 41,
    backoffMin: [1, 2, 4, 8, 16, 30, 30, 30, 30], ref: 'PAY-DEMO-0900-1207',
    error: 'java.lang.IllegalArgumentException: creditor IBAN checksum invalid: GB00 DEMO 0000 1207 99' };

  /* error fingerprints: the raw example plus the normalised group key */
  var FP = {
    iban: { key: 'IllegalArgumentException: creditor IBAN checksum invalid: <iban>', kind: 'deterministic',
      sample: POISON.error },
    cbs: { key: 'SocketTimeoutException: Read timed out (cbs-gateway:<port>)', kind: 'dependency',
      sample: 'java.net.SocketTimeoutException: Read timed out (cbs-gateway.demo.internal:8443) after 5000 ms' },
    optlock: { key: 'OptimisticLockException: row updated by another transaction (payment <id>)', kind: 'transient',
      sample: 'jakarta.persistence.OptimisticLockException: Row was updated or deleted by another transaction (payment 88119934)' },
    smtp: { key: 'MailboxUnavailableException: 550 mailbox unavailable <email>', kind: 'deterministic',
      sample: 'MailboxUnavailableException: 550 5.1.1 mailbox unavailable j.doe@demo.example' },
    mandate: { key: 'MandateNotFoundException: mandate ref <ref> not found', kind: 'deterministic',
      sample: 'MandateNotFoundException: mandate ref DDI-DEMO-55120 not found' }
  };

  /* ---------- arrivals ---------- */
  // batches: name -> {name, queue, producer, firstMin, total, arrived[]}
  var batches = {};
  function addBatch(queue, name, producer, startMin, rows, ratePerMin) {
    var b = batches[name] || (batches[name] = { name: name, queue: queue, producer: producer, firstMin: startMin,
      total: 0, arrived: zeros(), done: zeros(), dead: 0, stuck: 0 });
    var left = rows, m = startMin;
    while (left > 0 && m < N) {
      var n = Math.min(left, ratePerMin === Infinity ? left : Math.round(ratePerMin * between(0.94, 1.06)));
      b.arrived[m] += n; b.total += n; left -= n; m++;
    }
    return b;
  }
  // payments.inbound: FPS files every 15 min, two BACS files, the bulk file, a CHAPS trickle
  for (var f = 0; f < N; f += 15) {
    var name = 'DEMO_FPS_20261015_' + clock(f).replace(':', '') + '.csv';
    addBatch('payments.inbound', name, 'AIS', f + 1, ri(320, 1500), 8000);
  }
  addBatch('payments.inbound', 'DEMO_BACS_20261015_0900.csv', 'AIS', hm(9, 0), 4200, 8000);
  addBatch('payments.inbound', 'DEMO_BACS_20261015_1300.csv', 'AIS', hm(13, 0), 3900, 8000);
  addBatch('payments.inbound', BULK.name, 'AIS', BULK.from, BULK.rows, BULK.rows / (BULK.to - BULK.from));
  (function () {
    var b = batches['CHAPS stream'] = { name: 'CHAPS stream', queue: 'payments.inbound', producer: 'AIS', firstMin: 0,
      total: 0, arrived: zeros(), done: zeros(), dead: 0, stuck: 0, stream: true };
    for (var m = 0; m < N; m++) { var n = ri(1, 6); b.arrived[m] = n; b.total += n; }
  })();
  // mandates.inbound: two DDI files plus a trickle
  addBatch('mandates.inbound', 'DEMO_DDI_20261015_0800.csv', 'AIS', hm(8, 0), 820, 450);
  addBatch('mandates.inbound', 'DEMO_DDI_20261015_1200.csv', 'AIS', hm(12, 0), 760, 450);
  (function () {
    var b = batches['DDI stream'] = { name: 'DDI stream', queue: 'mandates.inbound', producer: 'AIS', firstMin: 0,
      total: 0, arrived: zeros(), done: zeros(), dead: 0, stuck: 0, stream: true };
    for (var m = 0; m < N; m++) { var n = rnd() < 0.55 ? ri(0, 3) : 0; b.arrived[m] = n; b.total += n; }
  })();
  // recon.daily: scheduler drops task sets at 07:00 and 12:00
  addBatch('recon.daily', 'recon run 07:00', 'recon-scheduler', hm(7, 0), 1200, Infinity);
  addBatch('recon.daily', 'recon run 12:00', 'recon-scheduler', hm(12, 0), 640, Infinity);

  function batchesOf(qname) {
    return Object.keys(batches).map(function (k) { return batches[k]; }).filter(function (b) { return b.queue === qname; });
  }

  /* ---------- per-queue simulation ---------- */
  function makeSeries() {
    return { arr: zeros(), done: zeros(), fail: zeros(), deadNew: zeros(), dead: zeros(), waiting: zeros(),
      sched: zeros(), inflight: zeros(), stuck: zeros(), oldest: zeros(), p50: zeros(), p95: zeros(),
      byProducer: {}, failFp: {}, workerDone: {}, live: zeros() };
  }
  var S = {}; QUEUES.forEach(function (q) { S[q.name] = makeSeries(); });

  function weightedPct(chunks, p) {   // chunks: [[wait, n]]
    var tot = 0; chunks.forEach(function (c) { tot += c[1]; });
    if (!tot) return 0;
    chunks.sort(function (a, b) { return a[0] - b[0]; });
    var acc = 0, target = tot * p;
    for (var i = 0; i < chunks.length; i++) { acc += chunks[i][1]; if (acc >= target) return chunks[i][0]; }
    return chunks[chunks.length - 1][0];
  }

  // generic FIFO simulation. opts.arrivalsAt(m) -> [{batch, producer, n}]
  function simulate(q, opts) {
    var s = S[q.name];
    var ready = [];        // cohorts {start, end, n, batch, att}  (start/end in seconds, items spread uniformly)
    var sched = [];        // retry cohorts {due, n, batch, att}
    var deadTotal = opts.deadAtStart || 0;
    var stuckNow = 0;
    var pollS = 2.5;
    for (var m = 0; m < N; m++) {
      var t0 = m * 60, t1 = t0 + 60;
      // 1. arrivals
      var arrivals = opts.arrivalsAt(m);
      arrivals.forEach(function (a) {
        if (!a.n) return;
        s.arr[m] += a.n;
        (s.byProducer[a.producer] || (s.byProducer[a.producer] = zeros()))[m] += a.n;
        ready.push({ start: t0, end: t1, n: a.n, batch: a.batch, att: 0, fresh: true });
      });
      // 2. retries that came due join the ready set in available_at order
      var still = [];
      sched.forEach(function (c) {
        if (c.due < t1) {
          var ins = { start: c.due, end: c.due + 1, n: c.n, batch: c.batch, att: c.att, retry: true };
          var i = 0; while (i < ready.length && ready[i].start <= ins.start) i++;
          ready.splice(i, 0, ins);
        } else still.push(c);
      });
      sched = still;
      // 3. capacity
      var live = q.workers.filter(function (w) { return !(w === STUCK.worker && m >= STUCK.min); }).length;
      if (m >= STUCK.min && STUCK.claims[q.name]) stuckNow = STUCK.claims[q.name];
      s.live[m] = live;
      var cap = opts.capacityAt ? opts.capacityAt(m, live) : Math.round(live * q.perWorker * between(0.93, 1.04));
      // 4. claim and process from the head
      var processed = 0, chunks = [], okRate = opts.okRateAt ? opts.okRateAt(m) : 1;
      while (processed < cap && ready.length) {
        var c = ready[0];
        var k = Math.min(c.n, cap - processed);
        var frac = k / c.n;
        var availMid = c.start + (c.end - c.start) * frac / 2;
        var finishAt = t0 + 60 * (processed + k / 2) / Math.max(cap, 1);
        var wait = Math.max(between(0.6, 1.4) * pollS, finishAt - availMid);
        var ok = Math.round(k * okRate), bad = k - ok;
        if (opts.transient) {                   // a sprinkle of transient or deterministic first-attempt errors
          var tr = opts.transient(m, k, c);
          if (tr) { ok -= tr.n; bad += tr.n; c.fpOverride = tr.fp; }
        }
        if (ok > 0) {
          s.done[m] += ok; chunks.push([wait, ok]);
          var b = batches[c.batch]; if (b) b.done[m] += ok;
        }
        if (bad > 0) {
          var fp = c.fpOverride || opts.failFp || 'cbs';
          (s.failFp[fp] || (s.failFp[fp] = zeros()))[m] += bad;
          s.fail[m] += bad;
          var att = c.att + 1;
          var maxA = (opts.maxAttemptsFor ? opts.maxAttemptsFor(fp) : q.maxAttempts);
          if (att >= maxA || (opts.nonRetryable && opts.nonRetryable(fp))) {
            deadTotal += bad; s.deadNew[m] += bad;
            var bb = batches[c.batch]; if (bb) bb.dead += bad;
          } else {
            var backoff = opts.backoffS ? opts.backoffS(att, fp) : Math.min(30 * Math.pow(2, att - 1), 300);
            sched.push({ due: finishAt + backoff, n: bad, batch: c.batch, att: att });
          }
        }
        c.fpOverride = null;
        processed += k;
        c.start += (c.end - c.start) * frac; c.n -= k;
        if (c.n <= 0) ready.shift();
      }
      // 5. snapshot at the end of the minute
      var waiting = 0; ready.forEach(function (c) { waiting += c.n; });
      var oldest;
      if (waiting > 0) {
        oldest = t1 - ready[0].start;
        // a backlog that only formed in this minute is seconds old, not a minute old
        if (ready[0].fresh && waiting < cap * 0.05) oldest = between(1, 6);
      } else {
        var rate = s.arr[m] / 60;
        waiting = Math.round(rate * between(0.5, 2.5));
        oldest = waiting ? between(0.8, 4.5) : 0;
      }
      ready.forEach(function (c) { c.fresh = false; });
      s.waiting[m] = waiting;
      s.oldest[m] = Math.round(oldest);
      var sc = 0; sched.forEach(function (c) { sc += c.n; });
      s.sched[m] = sc + (opts.extraSched ? opts.extraSched(m) : 0);
      s.inflight[m] = Math.min(Math.round(s.done[m] * q.procS / 60 + s.fail[m] * 0.4 + between(0, 1.6)), live * 25);
      s.stuck[m] = stuckNow;
      s.dead[m] = deadTotal + (opts.extraDead ? opts.extraDead(m) : 0);
      s.p50[m] = weightedPct(chunks.slice(), 0.5);
      s.p95[m] = weightedPct(chunks.slice(), 0.95);
      // per-worker share of completions
      var liveWorkers = q.workers.filter(function (w) { return !(w === STUCK.worker && m >= STUCK.min); });
      var remaining = s.done[m];
      q.workers.forEach(function (w, wi) {
        var arr = s.workerDone[w] || (s.workerDone[w] = zeros());
        if (liveWorkers.indexOf(w) < 0) return;
        var share = wi === q.workers.length - 1 || liveWorkers[liveWorkers.length - 1] === w
          ? remaining : Math.round(s.done[m] / liveWorkers.length * between(0.88, 1.12));
        share = Math.max(0, Math.min(share, remaining)); arr[m] = share; remaining -= share;
      });
    }
  }

  function arrivalsFromBatches(qname) {
    var bs = batchesOf(qname);
    return function (m) { return bs.map(function (b) { return { batch: b.name, producer: b.producer, n: b.arrived[m] }; }); };
  }

  // payments.inbound (with the poison message handled on the side)
  var poisonAttempts = [];
  (function () {
    var t = POISON.firstMin * 60 + POISON.firstSec;
    for (var a = 1; a <= 10; a++) {
      poisonAttempts.push({ attempt: a, at: t, worker: ['mmp-app-02', 'mmp-app-04', 'mmp-app-01', 'mmp-app-03', 'mmp-app-02',
        'mmp-app-04', 'mmp-app-01', 'mmp-app-02', 'mmp-app-04', 'mmp-app-01'][a - 1] });
      if (a <= POISON.backoffMin.length) t += POISON.backoffMin[a - 1] * 60 + ri(0, 3);
    }
  })();
  var POISON_DEAD_S = poisonAttempts[9].at + 1;
  simulate(QUEUES[0], {
    arrivalsAt: arrivalsFromBatches('payments.inbound'),
    failFp: 'optlock',
    transient: function (m, k) { var n = 0; for (var i = 0; i < Math.min(k, 50); i++) if (rnd() < 0.0035 * Math.max(1, k / 50)) n++; return n ? { n: n, fp: 'optlock' } : null; },
    extraSched: function (m) { var s = m * 60 + 59; return s >= poisonAttempts[0].at && s < POISON_DEAD_S ? 1 : 0; },
    extraDead: function (m) { return m * 60 + 59 >= POISON_DEAD_S ? 1 : 0; }
  });
  poisonAttempts.forEach(function (a) {
    var m = Math.floor(a.at / 60); var sp = S['payments.inbound'];
    (sp.failFp.iban || (sp.failFp.iban = zeros()))[m] += 1; sp.fail[m] += 1;
    if (a.attempt === 10) sp.deadNew[m] += 1;
  });
  batches[POISON.batch].dead += 0; // counted via extraDead, attributed below
  // mandates.inbound
  simulate(QUEUES[1], {
    arrivalsAt: arrivalsFromBatches('mandates.inbound'),
    failFp: 'mandate', deadAtStart: 1,
    transient: function (m) { return m === hm(8, 47) ? { n: 1, fp: 'mandate' } : null; },
    nonRetryable: function (fp) { return fp === 'mandate'; }
  });
  // ledger.postings: MMP completions feed it; cbs-gateway times out during the storm
  simulate(QUEUES[2], {
    arrivalsAt: function (m) {
      var p = S['payments.inbound'].done[m], d = S['mandates.inbound'].done[m];
      return [{ batch: 'from payments.inbound', producer: 'MMP', n: p }, { batch: 'from mandates.inbound', producer: 'MMP', n: d }];
    },
    okRateAt: function (m) { return m >= STORM.from && m < STORM.to ? STORM.okRate : 1; },
    failFp: 'cbs',
    backoffS: function (att) { return Math.min(15 * Math.pow(2, att - 1), 240) + between(0, 8); }
  });
  // notify.outbound: roughly one in ten payments notifies a customer
  simulate(QUEUES[3], {
    arrivalsAt: function (m) {
      var p = S['payments.inbound'].done[m];
      var n = Math.round(p * between(0.08, 0.12));
      if (m === PRODUCER_OUTAGE.from - 1) n = Math.max(1, n);
      if (m >= PRODUCER_OUTAGE.from && m <= PRODUCER_OUTAGE.to) n = 0;
      return [{ batch: 'payment notices', producer: 'MMP', n: n }];
    },
    failFp: 'smtp', deadAtStart: 6,
    transient: function (m, k) { return rnd() < 0.07 && k > 0 ? { n: 1, fp: 'smtp' } : null; },
    backoffS: function () { return 300; }
  });
  // recon.daily
  simulate(QUEUES[4], { arrivalsAt: arrivalsFromBatches('recon.daily') });
  // audit.archive: steady arrivals from everyone, archiver sweeps every 15 minutes
  simulate(QUEUES[5], {
    arrivalsAt: function (m) {
      return [
        { batch: 'audit', producer: 'MMP', n: ri(38, 62) + Math.round(S['payments.inbound'].done[m] * 0.04) },
        { batch: 'audit', producer: 'AIS', n: ri(12, 22) },
        { batch: 'audit', producer: 'Ledger', n: ri(16, 30) },
        { batch: 'audit', producer: 'Notifier', n: ri(4, 10) }
      ];
    },
    capacityAt: function (m) { return m % 15 === 7 ? 6000 : 0; }
  });
  // notify.outbox: one durable event per customer notification, then publish to notify.outbound.
  simulate(QUEUES[6], {
    arrivalsAt: function (m) {
      var p = S['payments.inbound'].done[m];
      return [{ batch: 'notification outbox', producer: 'MMP', n: Math.round(p * 0.1) }];
    }
  });
  // dead.letters is a read-only operational view of items already dead-lettered in the story.
  simulate(QUEUES[7], {
    arrivalsAt: function (m) {
      var n = 0;
      ['payments.inbound', 'mandates.inbound', 'ledger.postings', 'notify.outbound'].forEach(function (qn) { n += S[qn].deadNew[m]; });
      return [{ batch: 'dead-letter arrivals', producer: 'DBQ consumers', n: n }];
    },
    capacityAt: function () { return 0; },
    deadAtStart: 7
  });

  // which batches the stuck worker was holding: the FPS file it was chewing at 10:42
  var stuckBatch = 'DEMO_FPS_20261015_1030.csv';
  if (batches[stuckBatch]) batches[stuckBatch].stuck = 25;
  batches[POISON.batch].dead = 1;

  /* ---------- workers ---------- */
  var WORKERS = {};
  function worker(id, host, service, queues, threads) {
    WORKERS[id] = { id: id, host: host, pid: 4100 + ri(0, 400), service: service, queues: queues, threads: threads };
  }
  worker('mmp-app-01', 'mmp-app-01.demo.internal', 'MMP', ['payments.inbound', 'mandates.inbound'], 8);
  worker('mmp-app-02', 'mmp-app-02.demo.internal', 'MMP', ['payments.inbound', 'mandates.inbound'], 8);
  worker('mmp-app-03', 'mmp-app-03.demo.internal', 'MMP', ['payments.inbound', 'mandates.inbound'], 8);
  worker('mmp-app-04', 'mmp-app-04.demo.internal', 'MMP', ['payments.inbound', 'mandates.inbound'], 8);
  worker('ledger-svc-01', 'ledger-svc-01.demo.internal', 'Ledger', ['ledger.postings'], 16);
  worker('ledger-svc-02', 'ledger-svc-02.demo.internal', 'Ledger', ['ledger.postings'], 16);
  worker('notify-svc-01', 'notify-svc-01.demo.internal', 'Notifier', ['notify.outbound'], 4);
  worker('recon-batch-01', 'recon-batch-01.demo.internal', 'Recon', ['recon.daily'], 2);
  worker('archiver-01', 'archiver-01.demo.internal', 'Archiver', ['audit.archive'], 1);
  worker('outbox-pub-01', 'outbox-pub-01.demo.internal', 'MMP', ['notify.outbox'], 4);
  worker('dlq-admin-01', 'dlq-admin-01.demo.internal', 'Operations', ['dead.letters'], 1);
  WORKERS['mmp-app-03'].pid = STUCK.pid;
  // heartbeat age per worker per minute (seconds); claims held per worker per queue
  Object.keys(WORKERS).forEach(function (id) {
    var w = WORKERS[id]; w.hb = zeros();
    for (var m = 0; m < N; m++) {
      if (id === STUCK.worker && m >= STUCK.min) w.hb[m] = (m * 60 + 59) - (STUCK.min * 60 + STUCK.sec);
      else w.hb[m] = ri(1, 14);
    }
  });

  /* ---------- notable items for journeys ---------- */
  var ITEMS = [
    { id: POISON.id, queue: 'payments.inbound', ref: POISON.ref, batch: POISON.batch, row: POISON.row,
      createdS: POISON.firstMin * 60 + 9, kind: 'poison', attempts: poisonAttempts, error: POISON.error, deadS: POISON_DEAD_S },
    { id: 88131877, queue: 'payments.inbound', ref: 'PAY-DEMO-1030-0412', batch: stuckBatch, row: 412,
      createdS: hm(10, 31) * 60 + 7, kind: 'stuck', claimS: hm(10, 41) * 60 + 58, worker: STUCK.worker },
    { id: 88162290, queue: 'payments.inbound', ref: 'PAY-DEMO-BULK-41877', batch: BULK.name, row: 41877,
      createdS: hm(11, 20) * 60 + 14, kind: 'bulk' },
    { id: 55102399, queue: 'ledger.postings', ref: 'POST-DEMO-55102399', batch: 'from payments.inbound',
      createdS: hm(11, 51) * 60 + 22, kind: 'storm' }
  ];

  /* ---------- timeline events ---------- */
  var EVENTS = [
    { m: hm(9, 0), s: 41, kind: 'poison', queue: 'payments.inbound', title: 'Item #88120473 fails for the first time',
      detail: 'creditor IBAN checksum invalid; retried with backoff' },
    { m: hm(10, 42), s: 13, kind: 'stuck', queue: 'payments.inbound', title: 'mmp-app-03 stops heartbeating',
      detail: 'holds 25 payments and 3 mandates; none of them will complete' },
    { m: BULK.from, s: 0, kind: 'spike', queue: 'payments.inbound', title: 'AIS starts ingesting a 48,000-row file',
      detail: BULK.name },
    { m: Math.floor(POISON_DEAD_S / 60), s: POISON_DEAD_S % 60, kind: 'poison', queue: 'payments.inbound', title: '#88120473 dead-lettered after 10 attempts',
      detail: 'same error every time: deterministic, not transient' },
    { m: STORM.from, s: 0, kind: 'storm', queue: 'ledger.postings', title: 'cbs-gateway starts timing out',
      detail: 'ledger.postings retries every item; one error fingerprint' },
    { m: STORM.to, s: 0, kind: 'recover', queue: 'ledger.postings', title: 'cbs-gateway recovers',
      detail: 'scheduled retries drain over the next few minutes' },
    { m: hm(13, 0), s: 0, kind: 'spike', queue: 'payments.inbound', title: 'Second BACS file lands (3,900 rows)',
      detail: 'DEMO_BACS_20261015_1300.csv' }
  ];
  // SLO breach start/end events, derived from the data
  QUEUES.forEach(function (q) {
    var s = S[q.name], inBreach = false;
    for (var m = 0; m < N; m++) {
      var b = s.oldest[m] >= q.slo;
      if (b && !inBreach) EVENTS.push({ m: m, s: 0, kind: 'breach', queue: q.name, title: q.name + ' breaches its ' + (q.slo / 60) + '-minute wait target', detail: 'oldest waiting item is older than the SLO' });
      if (!b && inBreach) EVENTS.push({ m: m, s: 0, kind: 'recover', queue: q.name, title: q.name + ' is back within target', detail: 'backlog drained' });
      inBreach = b;
    }
  });
  EVENTS.sort(function (a, b) { return a.m * 60 + a.s - (b.m * 60 + b.s); });

  var CHAPTERS = [
    { m: hm(8, 30), label: 'Normal day', blurb: 'Files arrive every 15 minutes and drain in seconds.' },
    { m: hm(10, 20), label: 'Poison message', blurb: 'One payment fails the same way on every retry.' },
    { m: hm(10, 58), label: 'Stuck worker', blurb: 'mmp-app-03 went silent holding 25 claims. Counts look fine.' },
    { m: hm(11, 24), label: 'Big file', blurb: 'A 48,000-row file lands in six minutes.' },
    { m: hm(12, 6), label: 'Backlog + retry storm', blurb: 'Everything at once: the default "now".' },
    { m: hm(12, 24), label: 'Draining', blurb: 'The count falls, but the oldest item is still getting older.' },
    { m: hm(13, 40), label: 'Aftermath', blurb: 'Backlog gone; stuck claims and dead items still need a human.' }
  ];

  /* ---------- derived views at a minute ---------- */
  function sum(arr, from, to) { var t = 0; for (var i = Math.max(0, from); i <= to; i++) t += arr[i]; return t; }
  function median(arr, from, to) {
    var v = []; for (var i = Math.max(0, from); i <= to; i++) v.push(arr[i]);
    if (!v.length) return 0; v.sort(function (a, b) { return a - b; }); return v[Math.floor(v.length / 2)];
  }

  function queueAt(name, m) {
    var q = QUEUES[QI[name]], s = S[name];
    var in5 = sum(s.arr, m - 4, m) / 5, out5 = sum(s.done, m - 4, m) / 5, fail5 = sum(s.fail, m - 4, m) / 5;
    var in15 = sum(s.arr, m - 14, m) / 15, out15 = sum(s.done, m - 14, m) / 15;
    var in10 = sum(s.arr, m - 9, m) / 10, out10 = sum(s.done, m - 9, m) / 10;
    var backlog = s.waiting[m] + s.sched[m];
    var net = out5 - in5;   // drain speed over the last five minutes
    var eta = null;         // forecast only once the backlog is a real one (a third of the SLO)
    if (s.oldest[m] >= q.slo / 3 && s.waiting[m] > 100 && net > 0) eta = Math.max(1, Math.round(s.waiting[m] / net));
    return {
      q: q, name: name, waiting: s.waiting[m], sched: s.sched[m], inflight: s.inflight[m], stuck: s.stuck[m],
      dead: s.dead[m], oldest: s.oldest[m], p50: s.p50[m], p95: s.p95[m], in5: in5, out5: out5, fail5: fail5,
      in15: in15, out15: out15, in10: in10, out10: out10, backlog: backlog, net: net, etaMin: eta, live: s.live[m], total: q.workers.length,
      sloRatio: s.oldest[m] / q.slo
    };
  }

  // detectors: the rules a real console would run every minute
  function findingsAt(m) {
    var out = [];
    QUEUES.forEach(function (q) {
      var s = S[q.name], v = queueAt(q.name, m);
      // backlog age vs SLO
      if (v.oldest >= q.slo) {
        var since = m; while (since > 0 && s.oldest[since - 1] >= q.slo) since--;
        out.push({ id: 'slo:' + q.name, rule: 'Wait-time SLO', sev: 'critical', queue: q.name, sinceM: since,
          title: q.name + ' is ' + fmtDur(v.oldest) + ' behind (target ' + fmtDur(q.slo) + ')',
          metric: v.oldest, v: v });
      } else if (v.oldest >= q.slo * 0.66) {
        out.push({ id: 'slo:' + q.name, rule: 'Wait-time SLO', sev: 'warning', queue: q.name, sinceM: m,
          title: q.name + ' is approaching its wait target', metric: v.oldest, v: v });
      }
      // silent producer: a configured cadence has missed its allowed number of intervals
      if (q.expectedArrival) {
        var lastArrival = m;
        while (lastArrival >= 0 && !s.arr[lastArrival]) lastArrival--;
        var noArrivalS = lastArrival < 0 ? (m + 1) * 60 : (m - lastArrival) * 60;
        if (noArrivalS > q.expectedArrival * q.arrivalWarnMultiple) {
          out.push({ id: 'silent-producer:' + q.name, rule: 'Silent producer', sev: 'warning', queue: q.name,
            sinceM: lastArrival + Math.floor(q.expectedArrival * q.arrivalWarnMultiple / 60) + 1,
            title: q.name + ': No arrivals for ' + fmtDur(noArrivalS) + ' (usually every ' + fmtDur(q.expectedArrival) + ')',
            reason: 'No arrivals for ' + fmtDur(noArrivalS) + '; usually every ' + fmtDur(q.expectedArrival),
            metric: noArrivalS, v: v, lastArrivalM: lastArrival });
        }
      }
      // retry storm: lots of failures across many items with one fingerprint, against the trailing-hour median
      var f5 = sum(s.fail, m - 4, m), base = median(s.fail, m - 64, m - 5) * 5;
      if (f5 >= 300 && f5 > Math.max(base, 5) * 8) {
        var since2 = m; while (since2 > 0 && s.fail[since2 - 1] > 40) since2--;
        out.push({ id: 'storm:' + q.name, rule: 'Retry storm', sev: 'critical', queue: q.name, sinceM: since2,
          title: q.name + ': ' + fmtNum(Math.round(f5 / 5)) + ' failures a minute, one error', metric: f5, v: v });
      }
    });
    // stuck claims: one finding per silent worker, listing every queue it holds claims in
    if (m >= STUCK.min) {
      var held = Object.keys(STUCK.claims).map(function (qn) { return { queue: qn, n: STUCK.claims[qn] }; });
      var tot = held.reduce(function (a, h) { return a + h.n; }, 0);
      out.push({ id: 'stuck:' + STUCK.worker, rule: 'Stuck claims', sev: 'serious', queue: held[0].queue, queues: held,
        worker: STUCK.worker, sinceM: STUCK.min,
        title: STUCK.worker + ' silent for ' + fmtDur(WORKERS[STUCK.worker].hb[m]) + ', holding ' + tot + ' claims',
        metric: tot });
    }
    // poison message (deterministic repeat failure of one item)
    var pa = poisonAttempts.filter(function (a) { return a.at <= m * 60 + 59; });
    if (pa.length >= 3) {
      var dead = m * 60 + 59 >= POISON_DEAD_S;
      out.push({ id: 'poison:' + POISON.id, rule: dead ? 'Dead letter' : 'Poison message', sev: dead ? 'serious' : 'warning',
        queue: 'payments.inbound', sinceM: POISON.firstMin,
        title: dead ? 'Item #' + POISON.id + ' dead after 10 identical failures' : 'Item #' + POISON.id + ' has failed ' + pa.length + ' times with the same error',
        metric: pa.length, item: POISON.id });
    }
    // producer spike
    var sp = S['payments.inbound'];
    var a10 = sum(sp.arr, m - 9, m), aBase = sum(sp.arr, m - 129, m - 10) / 120 * 10;
    if (a10 >= 5000 && a10 > aBase * 6) {
      out.push({ id: 'spike:AIS', rule: 'Producer spike', sev: 'info', queue: 'payments.inbound', sinceM: BULK.from,
        title: 'AIS wrote ' + fmtNum(a10) + ' items in 10 minutes (' + Math.round(a10 / Math.max(aBase, 1)) + '× normal)', metric: a10 });
    }
    // ledger dead letters left from the storm
    var ld = S['ledger.postings'].dead[m];
    if (ld > 0) {
      out.push({ id: 'dead:ledger', rule: 'Dead letters', sev: 'serious', queue: 'ledger.postings', sinceM: STORM.from,
        title: fmtNum(ld) + ' postings dead-lettered by the timeout storm', metric: ld });
    }
    var rank = { critical: 0, serious: 1, warning: 2, info: 3 };
    out.sort(function (a, b) { return rank[a.sev] - rank[b.sev] || b.metric - a.metric; });
    return out;
  }

  function healthOf(name, m) {
    var f = healthFindings(name, m);
    return f.length ? f[0].sev : 'good';
  }

  function healthFindings(name, m) {
    return findingsAt(m).filter(function (x) {
      return x.sev !== 'info' && (x.queue === name || (x.queues && x.queues.some(function (h) { return h.queue === name; })));
    });
  }

  function healthReason(name, m) {
    var f = healthFindings(name, m)[0], q = QUEUES[QI[name]], v = queueAt(name, m);
    if (!f) return 'All checks pass';
    if (f.reason) return f.reason;
    if (f.rule === 'Wait-time SLO') return 'Oldest wait ' + fmtDur(v.oldest) + ', target ' + fmtDur(q.slo);
    if (f.rule === 'Retry storm') return fmtNum(Math.round(v.fail5)) + ' failures/min across many items';
    if (f.rule === 'Stuck claims') return f.worker + ' silent for ' + fmtDur(WORKERS[f.worker].hb[m]) + ', holding ' + (f.queues.filter(function (h) { return h.queue === name; })[0] || { n: 0 }).n + ' claims';
    if (f.rule === 'Poison message' || f.rule === 'Dead letter') return 'One item failed ' + f.metric + ' times with the same error';
    if (f.rule === 'Dead letters') return fmtNum(f.metric) + ' items are dead-lettered';
    return f.title;
  }

  function fmtNum(n) { return Math.round(n).toLocaleString('en-GB'); }
  function fmtDur(s) {
    s = Math.max(0, Math.round(s));
    if (s < 60) return s + 's';
    var mi = Math.floor(s / 60);
    if (mi < 60) return mi + 'm' + (mi < 10 && s % 60 ? ' ' + (s % 60) + 's' : '');
    var h = Math.floor(mi / 60), r = mi % 60;
    return h + 'h' + (r ? ' ' + r + 'm' : '');
  }

  window.DBQ = {
    N: N, START_H: START_H, DATE_LABEL: DATE_LABEL, NOW_DEFAULT: hm(12, 6),
    QUEUES: QUEUES, QI: QI, S: S, WORKERS: WORKERS, batches: batches, batchesOf: batchesOf,
    STUCK: STUCK, BULK: BULK, STORM: STORM, PRODUCER_OUTAGE: PRODUCER_OUTAGE, POISON: POISON, poisonAttempts: poisonAttempts, POISON_DEAD_S: POISON_DEAD_S,
    FP: FP, ITEMS: ITEMS, EVENTS: EVENTS, CHAPTERS: CHAPTERS,
    hm: hm, clock: clock, sum: sum, queueAt: queueAt, findingsAt: findingsAt, healthOf: healthOf, healthReason: healthReason,
    fmtNum: fmtNum, fmtDur: fmtDur
  };
})();
