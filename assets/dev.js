/* Developer-facing DBQ views. All values come from the shared deterministic Thursday simulation. */
(function () {
  'use strict';
  var D = window.DBQ, U = window.DBQUI, $ = U.$, esc = U.esc;
  var page = document.body.dataset.page;

  var PATTERNS = {
    'ingestion-buffer': {
      name: 'Ingestion buffer',
      healthy: 'The consumer drains each arrival burst before the next file lands, and the oldest item stays within its wait target.'
    },
    'transactional-outbox': {
      name: 'Transactional outbox',
      healthy: 'Committed events publish once, quickly, and leave no growing unpublished tail.'
    },
    'background-work': {
      name: 'Background work queue',
      healthy: 'Work starts promptly, finishes within its normal run time, succeeds, and leaves concurrency available for the next burst.'
    },
    'deferred-recovery': {
      name: 'Deferred integration recovery',
      healthy: 'Retries spread out by attempt, give-ups stay rare, and the queue drains after the downstream dependency recovers.'
    },
    'consolidation': {
      name: 'Consolidation queue',
      healthy: 'Open batches fill and close inside the batching window, without stranding late arrivals.'
    },
    'dead-letter': {
      name: 'Dead letter queue',
      healthy: 'Arrivals stay exceptional, errors group into understood fingerprints, and every item ends in replay or discard.'
    }
  };

  function storyLinks(target) {
    var moments = [
      [D.hm(10, 42), '10:42 silent worker'], [D.hm(11, 15), '11:15 big file'],
      [D.hm(11, 50), '11:50 retry storm'], [D.hm(12, 24), '12:24 draining']
    ];
    return '<nav class="story-strip" aria-label="Thursday story moments">' + moments.map(function (x) {
      return '<a href="' + target + '#t=' + D.clock(x[0]) + '">' + esc(x[1]) + '</a>';
    }).join('') + '</nav>';
  }

  function head(title, text) {
    return '<header class="dev-head"><div class="dev-head-main"><h1>' + esc(title) + '</h1><p>' + esc(text) + '</p></div></header>';
  }

  function verdict(sev, title, body) {
    return '<section class="verdict ' + sev + '">' + U.ICON[sev] + '<div><strong>' + esc(title) + '</strong><p>' + esc(body) + '</p></div></section>';
  }

  function signal(label, value, detail, tone, small) {
    return '<article class="card signal ' + (tone || '') + '"><span class="signal-label">' + esc(label) + '</span>' +
      '<strong class="signal-value' + (small ? ' small' : '') + '">' + esc(value) + '</strong><span class="signal-detail">' + esc(detail) + '</span></article>';
  }

  function pct(n) { return Math.max(0, Math.min(100, Math.round(n * 100))); }
  function sum(name, key, m, n) { return D.sum(D.S[name][key], m - n + 1, m); }
  function max(name, key, m, n) {
    var out = 0, a = D.S[name][key];
    for (var i = Math.max(0, m - n + 1); i <= m; i++) out = Math.max(out, a[i] || 0);
    return out;
  }

  function queueSignals(q, m) {
    var v = D.queueAt(q.name, m), s = D.S[q.name], cards = [], p = q.pattern;
    if (p === 'ingestion-buffer') {
      var drain = v.out5 - v.in5;
      cards = [
        ['Arrival rate', U.rate(v.in5) + '/min', 'Last 5 minutes', v.in5 > v.out5 ? 'watch' : ''],
        ['Drain rate', U.rate(v.out5) + '/min', drain > 0 ? U.rate(drain) + '/min faster than arrivals' : 'Not gaining on arrivals', drain <= 0 && v.waiting ? 'bad' : ''],
        ['Time to drain', v.etaMin ? v.etaMin + ' min' : (v.waiting ? 'No forecast' : 'Clear'), v.etaMin ? 'At the current net rate' : 'No sustained backlog', v.waiting && !v.etaMin ? 'bad' : ''],
        ['Peak depth', D.fmtNum(max(q.name, 'waiting', m, 60)), 'Highest in the last hour', ''],
        ['Oldest item', D.fmtDur(v.oldest), 'Target ' + D.fmtDur(q.slo), v.oldest >= q.slo ? 'bad' : v.oldest >= q.slo * .66 ? 'watch' : '']
      ];
    } else if (p === 'transactional-outbox') {
      var dup = m >= D.hm(11, 50) && m < D.hm(12, 14) ? 3 : 0;
      cards = [
        ['Unpublished', D.fmtNum(v.waiting + v.sched), 'Committed events not yet published', v.waiting > 100 ? 'watch' : ''],
        ['Oldest unpublished', D.fmtDur(v.oldest), 'Publish target ' + D.fmtDur(q.slo), v.oldest >= q.slo ? 'bad' : ''],
        ['Publish lag p95', D.fmtDur(Math.max(1, s.p95[m] || v.oldest)), 'Commit to broker acknowledgement', ''],
        ['Published', U.rate(v.out5) + '/min', 'Last 5 minutes', ''],
        ['Duplicate publishes', String(dup), dup ? 'Idempotency key repeats in the last hour' : 'None in the last hour', dup ? 'watch' : '']
      ];
    } else if (p === 'background-work') {
      var attempts = sum(q.name, 'done', m, 15) + sum(q.name, 'fail', m, 15), success = attempts ? sum(q.name, 'done', m, 15) / attempts : 1;
      var used = q.workers.length ? Math.min(q.workers.length * 25, v.inflight + v.stuck) : 0, limit = q.workers.length * 25;
      cards = [
        ['Wait time', D.fmtDur(v.oldest), 'Oldest runnable item', v.oldest >= q.slo ? 'bad' : ''],
        ['Run time p95', D.fmtDur(Math.max(q.procS, s.p95[m] || q.procS)), 'Claim to completion', ''],
        ['Success rate', pct(success) + '%', 'Attempts in the last 15 minutes', success < .98 ? 'bad' : ''],
        ['Retries', D.fmtNum(sum(q.name, 'fail', m, 15)), 'Failed attempts in 15 minutes', sum(q.name, 'fail', m, 15) ? 'watch' : ''],
        ['Concurrency in use', used + ' / ' + limit, limit ? pct(used / limit) + '% of thread limit' : 'No workers', used >= limit ? 'bad' : '']
      ];
    } else if (p === 'deferred-recovery') {
      var storm = m >= D.STORM.from && m < D.STORM.to, recovered = m >= D.STORM.to;
      cards = [
        ['Retry scheduled', D.fmtNum(v.sched), 'Failed, waiting for its next retry time. Attempt 1: ' + Math.round(v.sched * .58) + ', 2: ' + Math.round(v.sched * .28) + ', 3+: ' + Math.round(v.sched * .14), storm ? 'bad' : ''],
        ['Next retry schedule', storm ? '15s / 30s / 1m' : (v.sched ? 'Due over 4 min' : 'Empty'), 'Exponential backoff with jitter', ''],
        ['Give-ups', D.fmtNum(v.dead), 'Reached max attempts', v.dead ? 'watch' : ''],
        ['Downstream', storm ? 'Still failing' : recovered ? 'Recovered' : 'Healthy', storm ? '96% of attempts time out' : recovered ? 'Successes resumed at 12:14' : 'No dependency failures', storm ? 'bad' : ''],
        ['Recovery throughput', U.rate(v.out5) + '/min', recovered && v.sched ? 'Draining scheduled retries' : 'Current completion rate', '']
      ];
    } else if (p === 'consolidation') {
      var windowS = 900, age = v.waiting ? Math.min(windowS + 300, v.oldest) : 0, late = age > windowS ? Math.round(v.waiting * .04) : 0;
      cards = [
        ['Items in open batch', D.fmtNum(v.waiting), 'Next archive sweep', ''],
        ['Batch age', D.fmtDur(age), '15-minute batching window', age > windowS ? 'bad' : age > windowS * .8 ? 'watch' : ''],
        ['Window used', pct(age / windowS) + '%', 'Age against close window', age > windowS ? 'bad' : ''],
        ['Late arrivals', D.fmtNum(late), late ? 'Arrived after the batch closed' : 'None in the current batch', late ? 'watch' : ''],
        ['Last batch size', D.fmtNum(max(q.name, 'done', m, 30)), 'Most recent archive sweep', '']
      ];
    } else {
      var arrivals = sum(q.name, 'arr', m, 60), replayed = m >= D.hm(12, 24) ? 18 : 0, discarded = m >= D.hm(13, 40) ? 1 : 0;
      cards = [
        ['Arrivals per hour', D.fmtNum(arrivals), 'Dead-lettered in the last 60 minutes', arrivals > 50 ? 'bad' : arrivals ? 'watch' : ''],
        ['Oldest item', v.waiting ? D.fmtDur(v.oldest) : 'None', 'Time awaiting a disposition', v.oldest > q.slo ? 'bad' : ''],
        ['Top fingerprint', m >= D.STORM.from ? 'cbs-gateway timeout' : 'IBAN checksum', m >= D.STORM.from ? D.fmtNum(Math.max(1, arrivals - 1)) + ' items' : '1 item', arrivals ? 'watch' : '', true],
        ['Replayed', D.fmtNum(replayed), 'Marked for another delivery attempt', ''],
        ['Discarded', D.fmtNum(discarded), 'Closed with an audit reason', '']
      ];
    }
    return cards;
  }

  function queueNotes(pattern) {
    var notes = {
      'ingestion-buffer': [['Rates belong together', 'Depth alone cannot say whether the burst is clearing.'], ['Peak depth sizes capacity', 'The peak captures burst pressure that a five-minute average hides.'], ['Drain time is the decision', 'It answers whether the next scheduled file will overlap this one.']],
      'transactional-outbox': [['Unpublished is the backlog', 'A committed row is unfinished until the publisher records acknowledgement.'], ['Duplicates need their own count', 'At-least-once publish is safe only when the downstream idempotency key works.']],
      'background-work': [['Wait and run time separate causes', 'Wait points to capacity. Run time points to the work or dependency.'], ['Concurrency has a limit', 'Busy threads matter only beside the configured maximum.']],
      'deferred-recovery': [['Attempt number shapes the backlog', 'A thousand first retries differs from a thousand items near give-up.'], ['Recovery must be observed', 'A timer becoming due does not prove the dependency works again.']],
      'consolidation': [['The window is the target', 'A low item count may be correct until the batch age crosses its close window.'], ['Late arrivals expose boundaries', 'They show that producer and closer disagree about the batch cut-off.']],
      'dead-letter': [['Every item needs a disposition', 'A flat depth can still hide old items nobody has reviewed.'], ['Fingerprints set the work unit', 'Operators replay or discard a known error group, not an arbitrary count.']]
    };
    return notes[pattern];
  }

  function renderQueue(m) {
    var hashQ = U.parseHash().q, q = D.QUEUES[D.QI[hashQ] == null ? 0 : D.QI[hashQ]], pattern = PATTERNS[q.pattern];
    var cards = queueSignals(q, m), notes = queueNotes(q.pattern);
    $('#app').innerHTML = head('Pattern-aware queue health', 'The declared queue pattern selects the signals and the definition of healthy. Generic depth and throughput remain supporting evidence.') +
      '<section class="card"><div class="card-b queue-picker"><label for="queueSelect">Queue</label><select class="input" id="queueSelect">' + D.QUEUES.map(function (x) {
        return '<option value="' + esc(x.name) + '"' + (x.name === q.name ? ' selected' : '') + '>' + esc(x.name + ' - ' + PATTERNS[x.pattern].name) + '</option>';
      }).join('') + '</select><span class="badge neutral">Declared in dbq_queue_config.pattern</span></div></section>' +
      '<section><div class="pattern-title"><h2>' + esc(q.name) + '</h2><span class="badge info">' + esc(pattern.name) + '</span></div><p class="healthy"><b>Healthy means:</b> ' + esc(pattern.healthy) + '</p></section>' +
      '<section class="signal-grid" aria-label="Pattern health signals">' + cards.map(function (c) { return signal(c[0], c[1], c[2], c[3], c[4]); }).join('') + '</section>' +
      '<div class="two-col"><section class="card"><div class="card-h"><h3 class="card-t">Pattern signals over the last 90 minutes</h3><span class="card-sub">selected minute at the right edge</span></div><div class="chart-pad"><div id="patternChart"></div><div class="legend" id="patternLegend"></div></div></section>' +
      '<aside class="card"><div class="card-h"><h3 class="card-t">Why this panel set</h3></div><ul class="explain-list">' + notes.map(function (n) { return '<li><b>' + esc(n[0]) + '.</b> ' + esc(n[1]) + '</li>'; }).join('') + '</ul></aside></div>' +
      storyLinks('queue.html') + '<p class="footnote">All names and values are invented. The pattern is configuration, not a guess from queue traffic. Open <a data-keep-time data-base="consumers.html" href="consumers.html">Consumers</a> for worker capacity or <a data-keep-time data-base="database.html" href="database.html">Database cost</a> for storage and query pressure.</p>';
    $('#queueSelect').addEventListener('change', function (e) { U.writeHash({ q: e.target.value }); renderQueue(m); });
    var series = q.pattern === 'deferred-recovery'
      ? [{ name: 'Retry scheduled', values: D.S[q.name].sched, color: 'var(--s7)' }, { name: 'Failed', values: D.S[q.name].fail, color: 'var(--critical)' }]
      : [{ name: 'Arrived', values: D.S[q.name].arr, color: 'var(--s1)' }, { name: 'Completed', values: D.S[q.name].done, color: 'var(--s3)' }];
    $('#patternLegend').innerHTML = series.map(function (s) { return '<span><i class="line" style="background:' + s.color + '"></i>' + esc(s.name) + '</span>'; }).join('');
    U.chart($('#patternChart'), { from: Math.max(0, m - 89), to: m, series: series.map(function (s) { return { label: s.name, values: s.values, color: s.color }; }), height: 210, label: pattern.name + ' signals for ' + q.name });
  }

  function workerRows(m) {
    return Object.keys(D.WORKERS).map(function (id) {
      var w = D.WORKERS[id], held = 0, inflight = 0, throughput = 0, fails = 0;
      w.queues.forEach(function (qn) {
        var q = D.QUEUES[D.QI[qn]], s = D.S[qn];
        if (!q || !s) return;
        inflight += Math.round((s.inflight[m] || 0) / Math.max(1, s.live[m] || q.workers.length));
        held += id === D.STUCK.worker && m >= D.STUCK.min ? (D.STUCK.claims[qn] || 0) : 0;
        throughput += D.sum(s.workerDone[id] || [], m - 4, m) / 5;
        fails += D.sum(s.fail, m - 4, m) / Math.max(1, q.workers.length) / 5;
      });
      var stopped = id === D.STUCK.worker && m >= D.STUCK.min;
      var used = Math.min(w.threads, Math.max(stopped ? held : 0, Math.ceil(inflight + fails * .05)));
      return { id: id + ':' + w.pid, raw: id, w: w, stopped: stopped, hb: w.hb[m], held: held, used: used,
        busy: w.threads ? used / w.threads : 0, throughput: throughput, p50: stopped && held ? 82 : Math.max(1, Math.round(2 + used * .8)),
        p95: stopped && held ? Math.round(w.hb[m]) : Math.max(2, Math.round(5 + used * 2.4)) };
    });
  }

  function capacityVerdict(m, queueName) {
    var storm = queueName === 'ledger.postings' && m >= D.STORM.from && m < D.STORM.to;
    var silent = D.STUCK.claims[queueName] && m >= D.STUCK.min;
    var current = D.queueAt(queueName, m), q = current.q;
    var required = Math.ceil((current.out5 / 60) * q.procS), available = current.live * 8;
    var numbers = { queue: queueName, throughput: current.out5 / 60, processing: q.procS, required: required, available: available };
    if (storm) return { sev: 'critical', title: 'No. More consumers will amplify the retry storm.', body: 'ledger.postings is failing most attempts against cbs-gateway. Little\'s law describes healthy service capacity, but failed retries are consuming the threads. Wait for the dependency to recover.', numbers: numbers };
    if (silent && m < D.hm(11, 15)) return { sev: 'serious', title: 'Restore the silent worker before adding instances.', body: 'mmp-app-03 stopped heartbeating at 10:42 while holding 28 claims. The remaining instances have spare threads, so another consumer would hide the failed instance rather than fix it.', numbers: numbers };
    if (current.waiting > 5000) return { sev: 'info', title: 'Yes, one healthy consumer would shorten the drain.', body: queueName + ' needs about ' + required + ' concurrent threads at the current throughput and has ' + available + ' configured on live instances. The extra instance helps only while successful completions continue.', numbers: numbers };
    return { sev: 'good', title: 'No. Current consumers have spare concurrency.', body: 'Throughput multiplied by processing time needs about ' + required + ' concurrent threads. The live workers expose ' + available + ', so another instance would mostly sit idle.', numbers: numbers };
  }

  function renderConsumers(m) {
    var requested = U.parseHash().q;
    var capacityQueue = D.QI[requested] == null ? (m >= D.STORM.from && m < D.STORM.to ? 'ledger.postings' : 'payments.inbound') : requested;
    var rows = workerRows(m), cap = capacityVerdict(m, capacityQueue), silent = rows.filter(function (r) { return r.stopped; }).length;
    var busy = rows.reduce(function (a, r) { return a + r.used; }, 0), limit = rows.reduce(function (a, r) { return a + r.w.threads; }, 0);
    var contention = m >= D.STORM.from && m < D.STORM.to ? 18.6 : m >= D.hm(11, 15) && m < D.hm(12, 45) ? 4.8 : 1.3;
    $('#app').innerHTML = head('Consumers and concurrency', 'Per-instance liveness, held claims, processing time, throughput, and database claim contention. The capacity answer uses throughput multiplied by processing time.') +
      verdict(cap.sev, cap.title, cap.body) +
      '<section class="signal-grid">' +
      signal('Threads in use', busy + ' / ' + limit, pct(busy / limit) + '% across all instances', busy / limit > .85 ? 'watch' : '') +
      signal('Silent instances', String(silent), silent ? 'mmp-app-03 stopped at 10:42' : 'All process heartbeats are fresh', silent ? 'bad' : '') +
      signal('Claims held', D.fmtNum(rows.reduce(function (a, r) { return a + r.held; }, 0)), silent ? '28 belong to the silent worker' : 'No stale claims', silent ? 'bad' : '') +
      signal('Claim query p95', contention.toFixed(1) + ' ms', m >= D.STORM.from && m < D.STORM.to ? 'Retry churn raises lock traffic' : 'FOR UPDATE SKIP LOCKED', contention > 10 ? 'watch' : '') +
      signal('Skipped locked rows', m >= D.STORM.from && m < D.STORM.to ? '8.4K/min' : '12/min', 'Claim contention, not queue depth', m >= D.STORM.from && m < D.STORM.to ? 'watch' : '') + '</section>' +
      '<section class="card"><div class="card-h"><h2 class="card-t">Worker instances</h2><span class="card-sub">claim hold p50 and p95 include processing time</span></div>' +
      '<div class="table-wrap desktop-table"><table class="t"><thead><tr><th>Instance</th><th>Queues</th><th>Heartbeat</th><th>Threads</th><th class="r">Busy</th><th class="r">Claims</th><th class="r">Hold p50 / p95</th><th class="r">Throughput</th></tr></thead><tbody>' + rows.map(function (r) {
        var hb = r.stopped ? (D.clock(D.STUCK.min) + ' stopped') : r.hb + 's ago';
        return '<tr><td><span class="worker-id">' + esc(r.id) + '</span></td><td>' + esc(r.w.queues.join(', ')) + '</td><td>' + U.status(r.stopped ? 'serious' : 'good', hb) + '</td>' +
          '<td><div class="util"><div class="meter"><i style="width:' + pct(r.busy) + '%;background:' + (r.busy > .85 ? 'var(--warning)' : 'var(--s1)') + '"></i></div><span class="num">' + r.used + ' / ' + r.w.threads + '</span></div></td>' +
          '<td class="r">' + pct(r.busy) + '%</td><td class="r">' + r.held + '</td><td class="r">' + r.p50 + 's / ' + r.p95 + 's</td><td class="r">' + U.rate(r.throughput) + '/min</td></tr>';
      }).join('') + '</tbody></table></div><div class="mobile-records card-b">' + rows.map(function (r) {
        return '<article class="card mobile-record"><div class="mobile-record-h"><span class="worker-id">' + esc(r.id) + '</span>' + U.badge(r.stopped ? 'serious' : 'good', r.stopped ? 'Heartbeat stopped' : 'Live') + '</div>' +
          '<div class="mobile-kv"><span>Threads<b>' + r.used + ' / ' + r.w.threads + ' (' + pct(r.busy) + '%)</b></span><span>Claims held<b>' + r.held + '</b></span><span>Hold p50 / p95<b>' + r.p50 + 's / ' + r.p95 + 's</b></span><span>Throughput<b>' + U.rate(r.throughput) + '/min</b></span></div></article>';
      }).join('') + '</div></section>' +
      '<div class="two-col"><section class="card"><div class="card-h"><h3 class="card-t">Will more consumers help?</h3><span class="spacer"></span><select class="input capacity-select" id="capacityQueue" aria-label="Queue for capacity calculation">' + D.QUEUES.filter(function (q) { return q.workers.length && q.procS > 0; }).map(function (q) { return '<option value="' + esc(q.name) + '"' + (q.name === capacityQueue ? ' selected' : '') + '>' + esc(q.name) + '</option>'; }).join('') + '</select></div><div class="card-b"><div class="formula">required concurrency = throughput items/s x processing time s</div><div class="capacity-math"><b>' + cap.numbers.throughput.toFixed(1) + ' items/s</b><span>x</span><b>' + cap.numbers.processing.toFixed(1) + 's</b><span>=</span><b>' + cap.numbers.required + ' required</b><span>against</span><b>' + cap.numbers.available + ' threads available</b></div><p class="footnote" style="margin:12px 0 0">The formula estimates in-flight work at steady state. The verdict also checks failure share, queue depth, heartbeat loss, and claim-query contention before recommending capacity.</p></div></section>' +
      '<aside class="card"><div class="card-h"><h3 class="card-t">Claim contention</h3></div><ul class="explain-list"><li><b>Query time.</b> ' + contention.toFixed(1) + ' ms p95 for the claim statement.</li><li><b>Skipped locks.</b> Workers keep moving because the query uses <span class="mono">SKIP LOCKED</span>.</li><li><b>Interpretation.</b> ' + (contention > 10 ? 'Retry churn is raising database work, but the failed dependency is the primary limit.' : 'The database is not limiting healthy throughput.') + '</li></ul></aside></div>' +
      storyLinks('consumers.html') + '<p class="footnote">At 10:42 the page flags the stopped heartbeat immediately, while release remains guarded by the configured stale threshold. At 11:50 it refuses the tempting but harmful answer to add consumers.</p>';
    $('#capacityQueue').addEventListener('change', function (e) { U.writeHash({ q: e.target.value }); renderConsumers(m); });
  }

  function dbRow(q, m, ix) {
    var s = D.S[q.name], created = sum(q.name, 'arr', m, Math.min(m + 1, 180)), done = sum(q.name, 'done', m, Math.min(m + 1, 180));
    var storm = q.name === 'ledger.postings' && m >= D.STORM.from, bulk = q.name === 'payments.inbound' && m >= D.BULK.from;
    var rowCounts = [296795, 36994, 266687, 26463, 9600, 1009200, 600, 232];
    var heap = Math.max(.06, rowCounts[ix] * .000264), index = Math.max(.05, rowCounts[ix] * .000247);
    var deadRows = Math.round(done * .18 + (bulk ? 12000 : 0) + (storm ? sum(q.name, 'fail', m, 20) * .7 : 0));
    var vacuumMin = storm ? 71 : bulk ? 46 : 8 + ix * 3;
    var claimMs = storm ? 18.6 : bulk ? 6.4 : 1.1 + ix * .25;
    var panelMs = q.pattern === 'dead-letter' ? 28.4 : storm ? 44.8 : 4.2 + ix * 1.3;
    var purge = Math.round(done * .82), completed = Math.round(done), keep = completed ? purge / completed : 1;
    var sev = storm ? 'critical' : deadRows > 10000 || vacuumMin > 40 ? 'warning' : 'good';
    var text = storm ? 'Retry churn is growing dead rows faster than vacuum can clean them.' : bulk ? 'The big file raised churn; vacuum is behind but claim queries still use the partial index.' : 'Storage, vacuum, query time, and retention are within the sample thresholds.';
    return { q: q, heap: heap, index: index, deadRows: deadRows, vacuumMin: vacuumMin, claimMs: claimMs, panelMs: panelMs, purge: purge, completed: completed, keep: keep, sev: sev, text: text };
  }

  function renderDatabase(m) {
    var rows = D.QUEUES.map(function (q, i) { return dbRow(q, m, i); });
    var totalHeap = rows.reduce(function (a, r) { return a + r.heap; }, 0), totalIndex = rows.reduce(function (a, r) { return a + r.index; }, 0);
    var totalDead = rows.reduce(function (a, r) { return a + r.deadRows; }, 0), worst = rows.slice().sort(function (a, b) { return U.rankSev(a.sev) - U.rankSev(b.sev) || b.deadRows - a.deadRows; })[0];
    var storm = m >= D.STORM.from && m < D.STORM.to, bulk = m >= D.BULK.from && m < D.hm(12, 45);
    var top = storm ? ['critical', 'Database churn is compounding the retry storm', 'ledger.postings is rewriting failed rows, adding attempt history, and leaving dead tuples faster than autovacuum removes them. Stop retry pressure before tuning vacuum.'] :
      bulk ? ['warning', 'Vacuum is behind after the 48,000-row file', 'payments.inbound is still using its partial claim index, but dead rows are accumulating. Let autovacuum catch up and confirm the purge job closes the gap.'] :
      ['good', 'Queue database cost is controlled', 'Partial indexes keep claim scans small, autovacuum is recent, and the completed-row purge is keeping pace in this sample minute.'];
    $('#app').innerHTML = head('Database cost', 'Storage, dead tuples, vacuum, claim and panel query cost, and completed-row retention. Catalog numbers are a deterministic sample of the same Thursday.') +
      verdict(top[0], top[1], top[2]) +
      '<section class="db-summary">' + signal('Queue tables', U.rate(totalHeap) + ' MB', 'Heap across the eight sample queues', '') +
      signal('Queue indexes', U.rate(totalIndex) + ' MB', 'Ready and claimed partial indexes stay small', '') +
      signal('Dead rows', D.fmtNum(totalDead), 'Awaiting vacuum', totalDead > 20000 ? 'bad' : totalDead > 10000 ? 'watch' : '') +
      signal('Worst autovacuum age', Math.max.apply(null, rows.map(function (r) { return r.vacuumMin; })) + ' min', worst.q.name, worst.vacuumMin > 40 ? 'watch' : '') + '</section>' +
      '<section class="card"><div class="card-h"><h2 class="card-t">Cost by queue</h2><span class="card-sub">sample catalog snapshot at ' + D.clock(m) + '</span></div>' +
      '<div class="table-wrap desktop-table"><table class="t"><thead><tr><th>Queue</th><th class="r">Table</th><th class="r">Indexes</th><th class="r">Dead rows</th><th class="r">Last autovacuum</th><th class="r">Claim p95</th><th class="r">Panels p95</th><th class="r">Purged / completed</th><th>Verdict</th></tr></thead><tbody>' + rows.map(function (r) {
        return '<tr><td><span class="qname">' + esc(r.q.name) + '</span></td><td class="r">' + r.heap.toFixed(1) + ' MB</td><td class="r">' + r.index.toFixed(1) + ' MB</td><td class="r ' + (r.deadRows > 10000 ? 'cost-high' : '') + '">' + D.fmtNum(r.deadRows) + '</td><td class="r ' + (r.vacuumMin > 40 ? 'cost-watch' : '') + '">' + r.vacuumMin + ' min ago</td><td class="r">' + r.claimMs.toFixed(1) + ' ms</td><td class="r">' + r.panelMs.toFixed(1) + ' ms</td><td class="r">' + D.fmtNum(r.purge) + ' / ' + D.fmtNum(r.completed) + '</td><td>' + U.badge(r.sev, r.sev === 'good' ? 'Controlled' : r.sev === 'warning' ? 'Watch' : 'Act') + '</td></tr>';
      }).join('') + '</tbody></table></div><div class="mobile-records card-b">' + rows.map(function (r) {
        return '<article class="card mobile-record"><div class="mobile-record-h"><span class="worker-id">' + esc(r.q.name) + '</span>' + U.badge(r.sev, r.sev === 'good' ? 'Controlled' : r.sev === 'warning' ? 'Watch' : 'Act') + '</div><div class="mobile-kv"><span>Table + indexes<b>' + r.heap.toFixed(1) + ' + ' + r.index.toFixed(1) + ' MB</b></span><span>Dead rows<b>' + D.fmtNum(r.deadRows) + '</b></span><span>Autovacuum<b>' + r.vacuumMin + ' min ago</b></span><span>Claim / panel p95<b>' + r.claimMs.toFixed(1) + ' / ' + r.panelMs.toFixed(1) + ' ms</b></span></div><p class="footnote" style="margin:0">' + esc(r.text) + '</p></article>';
      }).join('') + '</div></section>' +
      '<div class="two-col"><section class="card"><div class="card-h"><h3 class="card-t">What the database is paying for</h3></div><ul class="explain-list"><li><b>Claim query.</b> Reads the ready partial index and locks only the selected batch.</li><li><b>Panel queries.</b> Read snapshots for history; item-table scans are limited to current state and indexed lookups.</li><li><b>Churn.</b> Every retry updates the hot row and writes an attempt, so the 11:50 storm increases dead tuples even when depth stays flat.</li><li><b>Retention.</b> The purge must remove completed rows at least as fast as workers create them.</li></ul></section>' +
      '<aside class="card"><div class="card-h"><h3 class="card-t">Plain-English verdict</h3></div><div class="card-b"><p style="margin:0;color:var(--ink-2)">' + esc(worst.text) + '</p><p class="footnote" style="margin:12px 0 0">Catalog panels use PostgreSQL statistics views. Query timings need <span class="mono">pg_stat_statements</span>; relation sizes need catalog access; production roles should remain read-only.</p></div></aside></div>' +
      storyLinks('database.html') + '<p class="footnote">The sample sizes are invented. The SQL uses <span class="mono">pg_stat_user_tables</span>, <span class="mono">pg_relation_size</span>, and <span class="mono">pg_stat_statements</span>, so a real deployment would show measured database values.</p>';
  }

  var render = page === 'queue' ? renderQueue : page === 'consumers' ? renderConsumers : renderDatabase;
  $('#app').innerHTML = head('', '');
  U.mountChrome({ page: page, subtitle: page === 'queue' ? 'Developer · Queue health' : page === 'consumers' ? 'Developer · Consumers' : 'Developer · Database cost' });
  U.onTime(render);
  U.start();
})();
