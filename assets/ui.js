/* DBQ console prototypes: shared chrome (top bar, time scrubber, theme),
 * formatting, and small SVG chart helpers. No network, no dependencies. */
(function () {
  'use strict';
  var D = window.DBQ;
  var NS = 'http://www.w3.org/2000/svg';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  /* ---------- formatting ---------- */
  function compact(n) {
    n = Math.round(n);
    var a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (a >= 1e4) return Math.round(n / 1e3) + 'K';
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }
  function rate(n) { return n >= 100 ? D.fmtNum(n) : n >= 10 ? Math.round(n) + '' : n.toFixed(n < 1 && n > 0 ? 1 : 0); }
  function clockS(totalS) { return D.clock(Math.floor(totalS / 60), Math.floor(totalS % 60)); }

  /* ---------- icons ---------- */
  var ICON = {
    good: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.8 8.2l2.1 2.1 4.3-4.4" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    info: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M8 7.2v4" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="4.9" r="1" fill="#fff"/></svg>',
    warning: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.3l7 12.6H1z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M8 6v3.6" stroke="#1a1a19" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="11.6" r="0.95" fill="#1a1a19"/></svg>',
    serious: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0.8l7.2 7.2L8 15.2 0.8 8z" fill="currentColor"/><path d="M8 4.6v4.2" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="11.2" r="1" fill="#fff"/></svg>',
    critical: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.1 0.9h5.8l4.2 4.2v5.8l-4.2 4.2H5.1L0.9 10.9V5.1z" fill="currentColor"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/></svg>',
    play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9.5-5.5z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="2.5" width="3.2" height="11" rx="1" fill="currentColor"/><rect x="9.3" y="2.5" width="3.2" height="11" rx="1" fill="currentColor"/></svg>',
    sun: '<svg class="theme-light-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 1.8v2.1M10 16.1v2.1M1.8 10h2.1M16.1 10h2.1M4.2 4.2l1.5 1.5M14.3 14.3l1.5 1.5M4.2 15.8l1.5-1.5M14.3 5.7l1.5-1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    moon: '<svg class="theme-dark-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M16.5 12.4A7 7 0 0 1 7.6 3.5a7 7 0 1 0 8.9 8.9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    brand: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="2.6" rx="1.3" fill="var(--surface)"/><rect x="2" y="6.7" width="8.5" height="2.6" rx="1.3" fill="var(--surface)" opacity=".8"/><rect x="2" y="10.9" width="5" height="2.6" rx="1.3" fill="var(--surface)" opacity=".6"/></svg>',
    arrow: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9.5M9 4.5L12.5 8 9 11.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    search: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    heart: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 8.5h3l1.6-3.5 2.6 7 2-5 1.2 1.5H15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  var SEV_LABEL = { good: 'Healthy', info: 'Info', warning: 'Watch', serious: 'Action needed', critical: 'Breaching' };
  function status(sev, label) {
    return '<span class="status ' + sev + '">' + ICON[sev] + '<span>' + esc(label || SEV_LABEL[sev]) + '</span></span>';
  }
  function badge(sev, label) {
    return '<span class="badge ' + sev + '">' + (ICON[sev] || '') + '<span>' + esc(label || SEV_LABEL[sev]) + '</span></span>';
  }

  /* ---------- theme ---------- */
  function toggleTheme() {
    var root = document.documentElement;
    var dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('dbq-theme', root.dataset.theme); } catch (e) { /* storage unavailable */ }
    window.dispatchEvent(new Event('dbq-theme'));
  }
  if (window.matchMedia) {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { window.dispatchEvent(new Event('dbq-theme')); });
  }

  /* ---------- time state ---------- */
  var listeners = [];
  var state = { m: D.NOW_DEFAULT, playing: false, timer: null };
  function parseHash() {
    var h = {}; location.hash.replace(/^#/, '').split('&').forEach(function (kv) {
      var p = kv.split('='); if (p[0]) h[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
    });
    return h;
  }
  function writeHash(extra) {
    var h = parseHash(); h.t = D.clock(state.m);
    Object.keys(extra || {}).forEach(function (k) { if (extra[k] == null) delete h[k]; else h[k] = extra[k]; });
    var s = Object.keys(h).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(h[k]); }).join('&');
    history.replaceState(null, '', '#' + s);
    $$('[data-keep-time]').forEach(function (a) { a.href = a.getAttribute('data-base') + '#t=' + D.clock(state.m); });
  }
  (function initTime() {
    var t = parseHash().t;
    if (t && /^\d\d:\d\d$/.test(t)) {
      var m = D.hm(+t.slice(0, 2), +t.slice(3));
      if (m >= 0 && m < D.N) state.m = m;
    }
  })();
  function setTime(m, opts) {
    state.m = Math.max(0, Math.min(D.N - 1, m));
    writeHash();
    listeners.forEach(function (fn) { fn(state.m, opts || {}); });
  }
  function onTime(fn) { listeners.push(fn); }

  /* ---------- day heat for the scrubber ---------- */
  var dayHealth = null;
  function getDayHealth() {
    if (dayHealth) return dayHealth;
    dayHealth = [];
    for (var m = 0; m < D.N; m++) {
      var worst = 'good';
      D.QUEUES.forEach(function (q) {
        var r = D.S[q.name].oldest[m] / q.slo;
        var sev = r >= 1 ? 'critical' : r >= 0.66 ? 'warning' : 'good';
        if (rankSev(sev) < rankSev(worst)) worst = sev;
      });
      if (worst === 'good' && D.S['payments.inbound'].stuck[m] > 0) worst = 'serious';
      if (worst !== 'critical' && D.sum(D.S['ledger.postings'].fail, m - 4, m) > 300) worst = 'critical';
      dayHealth.push(worst);
    }
    return dayHealth;
  }
  function rankSev(s) { return { critical: 0, serious: 1, warning: 2, info: 3, good: 4 }[s]; }

  /* ---------- chrome ---------- */
  var PAGES = [
    { id: 'console', href: 'console.html', label: 'Control room', short: 'Console' },
    { id: 'flow', href: 'flow.html', label: 'Flow map', short: 'Flow' },
    { id: 'triage', href: 'triage.html', label: 'Triage', short: 'Triage' }
  ];
  function mountChrome(opts) {
    var narrow = matchMedia('(max-width: 560px)').matches;
    var top = document.createElement('header');
    top.className = 'topbar';
    top.innerHTML =
      '<a class="brand" href="index.html" data-keep-time data-base="index.html" aria-label="DBQ Console concepts home">' +
      '<span class="brand-mark">' + ICON.brand + '</span>' +
      '<span><span class="brand-name">DBQ Console</span> <span class="brand-sub">· ' + esc(opts.subtitle || '') + '</span></span></a>' +
      '<nav class="concept-nav" aria-label="Concepts">' + PAGES.map(function (p) {
        return '<a href="' + p.href + '" data-keep-time data-base="' + p.href + '"' + (p.id === opts.page ? ' aria-current="page"' : '') + '>' +
          '<span class="lbl-long">' + esc(p.label) + '</span></a>';
      }).join('') + '</nav>' +
      '<div class="top-actions"><span class="demo-chip" title="Every name, number and file here is invented">Sample data</span>' +
      '<button class="icon-btn" type="button" id="themeBtn" aria-label="Toggle light or dark theme">' + ICON.sun + ICON.moon + '</button></div>';
    document.body.insertBefore(top, document.body.firstChild);
    $('#themeBtn').addEventListener('click', toggleTheme);
    if (narrow) $$('.concept-nav a', top).forEach(function (a, i) { a.querySelector('.lbl-long').textContent = PAGES[i].short; });

    var tb = document.createElement('div');
    tb.className = 'timebar';
    tb.innerHTML =
      '<div class="timebar-inner">' +
      '<div class="tb-now"><button class="play-btn" type="button" id="playBtn" aria-label="Play the day">' + ICON.play + '</button>' +
      '<div class="tb-clock"><span class="tb-time" id="tbTime">--:--</span><span class="tb-date">' + esc(D.DATE_LABEL) + ' · replay</span></div></div>' +
      '<div class="scrub" id="scrub"><svg aria-hidden="true"></svg>' +
      '<input type="range" id="scrubIn" min="0" max="' + (D.N - 1) + '" step="1" aria-label="Time of day"></div>' +
      '<div class="chapters" id="chapters" role="group" aria-label="Story moments">' + D.CHAPTERS.map(function (c, i) {
        return '<button class="chip" type="button" data-m="' + c.m + '" title="' + esc(c.blurb) + '"><span class="chip-t">' + D.clock(c.m) + '</span>' + esc(c.label) + '</button>';
      }).join('') + '</div></div>';
    top.after(tb);

    var input = $('#scrubIn');
    input.addEventListener('input', function () { stop(); setTime(+input.value, { scrub: true }); });
    $$('#chapters .chip').forEach(function (b) { b.addEventListener('click', function () { stop(); setTime(+b.dataset.m, { chapter: true }); }); });
    $('#playBtn').addEventListener('click', function () { state.playing ? stop() : play(); });
    function play() {
      if (state.m >= D.N - 1) setTime(0);
      state.playing = true; $('#playBtn').innerHTML = ICON.pause; $('#playBtn').setAttribute('aria-label', 'Pause');
      state.timer = setInterval(function () { if (state.m >= D.N - 1) stop(); else setTime(state.m + 1, { playing: true }); }, 180);
    }
    function stop() {
      if (!state.playing) return;
      state.playing = false; clearInterval(state.timer); $('#playBtn').innerHTML = ICON.play; $('#playBtn').setAttribute('aria-label', 'Play the day');
    }
    function drawScrub() {
      var svg = $('#scrub svg'), w = $('#scrub').clientWidth, h = 30;
      if (!w) return;
      svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
      var heat = getDayHealth(), x = function (m) { return 7 + (w - 14) * m / (D.N - 1); };
      var out = '<rect x="0" y="0" width="' + w + '" height="' + h + '" rx="6" fill="var(--surface)"/>';
      // total waiting across queues as a soft silhouette
      var tot = [], max = 1;
      for (var m = 0; m < D.N; m++) { var t = 0; D.QUEUES.forEach(function (q) { if (q.name !== 'audit.archive') t += D.S[q.name].waiting[m]; }); tot.push(t); if (t > max) max = t; }
      var d = 'M' + x(0) + ' 24';
      for (m = 0; m < D.N; m++) d += 'L' + x(m).toFixed(1) + ' ' + (24 - 17 * Math.sqrt(tot[m] / max)).toFixed(1);
      d += 'L' + x(D.N - 1) + ' 24Z';
      out += '<path d="' + d + '" fill="var(--ink)" opacity="0.10"/>';
      // health strip
      var run = heat[0], start = 0;
      for (m = 1; m <= D.N; m++) {
        if (m === D.N || heat[m] !== run) {
          var col = run === 'good' ? 'var(--axis)' : 'var(--' + run + ')';
          out += '<rect x="' + x(start).toFixed(1) + '" y="25" width="' + Math.max(1, x(m) - x(start)).toFixed(1) + '" height="3" fill="' + col + '"' + (run === 'good' ? ' opacity="0.6"' : '') + '/>';
          if (m < D.N) { run = heat[m]; start = m; }
        }
      }
      // hour ticks; a label the 14px handle would cover is left out instead of peeking out around it
      for (var hr = 1, hx = x(state.m); hr < D.N / 60; hr++) {
        var tx = x(hr * 60), lab = (D.START_H + hr) + ':00', covered = hx + 9 > tx + 3 && hx - 9 < tx + 3 + lab.length * 5.4;
        out += '<line x1="' + tx + '" x2="' + tx + '" y1="3" y2="6" stroke="var(--axis-ink)" opacity=".7"/>' +
          (w > 640 && !covered ? '<text x="' + (tx + 3) + '" y="11" font-size="9" fill="var(--axis-ink)">' + lab + '</text>' : '');
      }
      // future dimmer
      out += '<rect x="' + x(state.m) + '" y="0" width="' + Math.max(0, w - x(state.m)) + '" height="' + h + '" fill="var(--page)" opacity="0.55"/>';
      svg.innerHTML = out;
    }
    function sync(m) {
      $('#tbTime').textContent = D.clock(m);
      input.value = m;
      $$('#chapters .chip').forEach(function (b) { b.setAttribute('aria-pressed', String(+b.dataset.m === m)); });
      drawScrub();
    }
    onTime(sync);
    window.addEventListener('resize', drawScrub);
    window.addEventListener('dbq-theme', drawScrub);
    writeHash();
    return { stop: stop };
  }

  /* ---------- tooltip ---------- */
  var tipEl = null;
  function tip(html, x, y) {
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tip'; tipEl.setAttribute('role', 'status'); document.body.appendChild(tipEl); }
    if (html == null) { tipEl.classList.remove('on'); return; }
    tipEl.innerHTML = html;
    tipEl.classList.add('on');
    var r = tipEl.getBoundingClientRect(), vw = innerWidth, vh = innerHeight;
    var left = x + 14, topY = y + 14;
    if (left + r.width > vw - 8) left = x - r.width - 14;
    if (left < 8) left = 8;
    if (topY + r.height > vh - 8) topY = y - r.height - 14;
    tipEl.style.left = left + 'px'; tipEl.style.top = topY + 'px';
  }
  function tipRows(title, rows) {
    return '<div class="tip-h">' + esc(title) + '</div>' + rows.map(function (r) {
      return '<div class="tip-row"><i style="background:' + r.color + '"></i><b>' + esc(r.value) + '</b><span>' + esc(r.label) + '</span></div>';
    }).join('');
  }

  /* ---------- charts ---------- */
  function niceMax(v) {
    if (v <= 0) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
    var s = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return s * p;
  }
  function el(tag, attrs) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    return e;
  }

  // timeChart: series over minute indices [from..to]; one y axis only.
  function timeChart(host, opts) {
    host.classList.add('chart');
    function render() {
      var W = host.clientWidth; if (!W) return;
      var H = opts.height || 180;
      var from = opts.from, to = Math.max(opts.to, from + 1);
      var series = opts.series;
      var stack = !!opts.stack;
      var vals = function (s, m) { return s.values[m] || 0; };
      var maxV = opts.yMin || 0;
      for (var m = from; m <= to; m++) {
        var acc = 0;
        series.forEach(function (s) { var v = vals(s, m); if (stack) acc += v; else if (v > maxV) maxV = v; });
        if (stack && acc > maxV) maxV = acc;
      }
      if (opts.threshold && opts.threshold.value * 1.15 > maxV) maxV = opts.threshold.value * 1.15;
      var yFmt = opts.yFmt || compact, yMax, ticks;
      if (opts.durationAxis) {         // seconds: step through clock-friendly units
        var steps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1200, 1800, 3600, 7200, 10800];
        var st = steps[steps.length - 1];
        for (var si = 0; si < steps.length; si++) if (maxV * 1.04 / steps[si] <= 4) { st = steps[si]; break; }
        yMax = Math.max(st, Math.ceil(maxV * 1.04 / st) * st); ticks = [];
        for (var tv = 0; tv <= yMax + 0.1; tv += st) ticks.push(tv);
      } else {
        var raw = Math.max(maxV * 1.04, 1), p10 = Math.pow(10, Math.floor(Math.log10(raw / 5))), nstep = p10;
        [1, 2, 2.5, 5, 10, 20, 25, 50].some(function (k) { nstep = k * p10; return Math.ceil(raw / nstep) <= 5; });
        if (raw < 4) nstep = 1;
        yMax = Math.ceil(raw / nstep) * nstep; ticks = [];
        for (var tv0 = 0; tv0 <= yMax + nstep / 2; tv0 += nstep) ticks.push(tv0);
      }
      var labW = 0; ticks.forEach(function (t) { labW = Math.max(labW, yFmt(t).length); });
      var padL = Math.max(26, labW * 6.2 + 10), padR = opts.padR || 10, padT = 10, padB = 20;
      var iw = W - padL - padR, ih = H - padT - padB;
      var X = function (mm) { return padL + iw * (mm - from) / (to - from); };
      var Y = function (v) { return padT + ih - ih * Math.min(v, yMax) / yMax; };
      var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, height: H, role: 'img', 'aria-label': opts.label || '' });
      // grid + y ticks
      ticks.forEach(function (t) {
        svg.appendChild(el('line', { x1: padL, x2: W - padR, y1: Y(t), y2: Y(t), class: t === 0 ? 'baseline' : 'gridline' }));
        var tx = el('text', { x: padL - 8, y: Y(t) + 3.5, 'text-anchor': 'end', class: 'tick' }); tx.textContent = yFmt(t); svg.appendChild(tx);
      });
      // x ticks
      var span = to - from, step = span > 300 ? 60 : span > 150 ? 30 : span > 60 ? 15 : span > 25 ? 5 : 2;
      if (iw < 360 && step < 60 && span > 120) step = 60;
      if (iw < 360 && span > 300) step = 120;
      var first = Math.ceil((from + D.START_H * 60) / step) * step - D.START_H * 60;
      for (var tm = first; tm <= to; tm += step) {
        var xx = X(tm);
        if (xx < padL + 12 || xx > W - padR - 12) continue;
        var tt = el('text', { x: xx, y: H - 5, 'text-anchor': 'middle', class: 'tick' }); tt.textContent = D.clock(tm); svg.appendChild(tt);
      }
      // threshold band (area above threshold tinted)
      if (opts.band) {
        svg.appendChild(el('rect', { x: X(Math.max(from, opts.band.from)), y: padT, width: Math.max(0, X(Math.min(to, opts.band.to)) - X(Math.max(from, opts.band.from))), height: ih, fill: 'var(--critical)', opacity: 0.06 }));
      }
      // series
      var base = []; for (m = from; m <= to; m++) base.push(0);
      series.forEach(function (s, si) {
        var top = [], d = '';
        for (var mm = from; mm <= to; mm++) top.push((stack ? base[mm - from] : 0) + vals(s, mm));
        var pen = false;
        for (mm = from; mm <= to; mm++) {
          var tv2 = top[mm - from];
          if (s.sparse && !stack && tv2 === 0 && !(top[mm - from - 1] > 0) && !(top[mm - from + 1] > 0)) { pen = false; continue; }
          d += (pen ? 'L' : 'M') + X(mm).toFixed(1) + ' ' + Y(tv2).toFixed(1); pen = true;
        }
        if (s.kind === 'area' || stack) {
          var low = '';
          for (mm = to; mm >= from; mm--) low += 'L' + X(mm).toFixed(1) + ' ' + Y(stack ? base[mm - from] : 0).toFixed(1);
          svg.appendChild(el('path', { d: d + low + 'Z', fill: s.color, opacity: stack ? 0.88 : 0.12 }));
          if (stack) svg.appendChild(el('path', { d: d, fill: 'none', stroke: 'var(--surface)', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
        }
        if (!stack) svg.appendChild(el('path', { d: d, fill: 'none', stroke: s.color, 'stroke-width': s.width || 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: s.opacity || 1 }));
        if (stack) base = top;
      });
      if (opts.threshold) {
        var ty = Y(opts.threshold.value);
        svg.appendChild(el('line', { x1: padL, x2: W - padR, y1: ty, y2: ty, class: 'threshold' }));
        var tl = el('text', { x: W - padR - 2, y: ty - 5, 'text-anchor': 'end', class: 'threshold-label' }); tl.textContent = opts.threshold.label; svg.appendChild(tl);
      }
      var rowsEnd = [];
      (opts.markers || []).forEach(function (mk) {
        if (mk.m < from || mk.m > to) return;
        var mx = X(mk.m);
        svg.appendChild(el('line', { x1: mx, x2: mx, y1: padT, y2: padT + ih, class: 'marker-line' }));
        if (!mk.label || iw <= 300) return;
        var lw = mk.label.length * 5.6 + 8, row = 0;
        var right = mx + 4 + lw <= W - padR;            // flip the label left of the line near the right edge
        var x0 = right ? mx : mx - lw;
        while (rowsEnd[row] != null && rowsEnd[row] > x0) row++;
        if (row > 2) return;
        rowsEnd[row] = x0 + lw;
        var ml = el('text', { x: right ? mx + 4 : mx - 4, y: padT + 9 + row * 12, class: 'marker-label', 'text-anchor': right ? 'start' : 'end' });
        ml.textContent = mk.label; svg.appendChild(ml);
      });
      // end dot on single-series line charts
      if (!stack && series.length === 1 && opts.endDot !== false) {
        svg.appendChild(el('circle', { cx: X(to), cy: Y(vals(series[0], to)), r: 4, fill: series[0].color, stroke: 'var(--surface)', 'stroke-width': 2 }));
      }
      // crosshair layer
      var xh = el('line', { x1: 0, x2: 0, y1: padT, y2: padT + ih, class: 'xhair', visibility: 'hidden' });
      svg.appendChild(xh);
      var hit = el('rect', { x: padL, y: 0, width: iw, height: H, fill: 'transparent', tabindex: 0 });
      svg.appendChild(hit);
      function at(clientX) {
        var r = svg.getBoundingClientRect();
        var mm = Math.round(from + (clientX - r.left - padL) / iw * (to - from));
        return Math.max(from, Math.min(to, mm));
      }
      function show(mm, cx, cy) {
        xh.setAttribute('x1', X(mm)); xh.setAttribute('x2', X(mm)); xh.setAttribute('visibility', 'visible');
        var rows = series.map(function (s) { return { color: s.color, value: (opts.tipFmt || yFmt)(vals(s, mm)), label: s.label }; });
        if (stack) rows.reverse();
        tip(tipRows(D.clock(mm) + (opts.tipTitle ? ' · ' + opts.tipTitle : ''), rows), cx, cy);
      }
      hit.addEventListener('pointermove', function (e) { show(at(e.clientX), e.clientX, e.clientY); });
      hit.addEventListener('pointerleave', function () { xh.setAttribute('visibility', 'hidden'); tip(null); });
      hit.addEventListener('focus', function () { var r = svg.getBoundingClientRect(); show(to, r.left + X(to), r.top + 20); });
      hit.addEventListener('blur', function () { xh.setAttribute('visibility', 'hidden'); tip(null); });
      host.innerHTML = '';
      host.appendChild(svg);
    }
    render();
    if (!host._ro) { host._ro = new ResizeObserver(function () { render(); }); host._ro.observe(host); }
    host._render = function (o) { opts = o; render(); };
    return host;
  }
  function chart(host, opts) { if (host._render) host._render(opts); else timeChart(host, opts); }

  // sparkline: returns an SVG string
  function spark(values, o) {
    o = o || {};
    var w = o.w || 96, h = o.h || 26, n = values.length, max = o.max || 0;
    values.forEach(function (v) { if (v > max) max = v; });
    if (o.threshold && o.threshold > max) max = o.threshold * 1.1;
    if (!max) max = 1;
    var X = function (i) { return 1 + (w - 6) * i / Math.max(1, n - 1); };
    var Y = function (v) { return h - 2 - (h - 5) * Math.min(v, max) / max; };
    var d = values.map(function (v, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); }).join('');
    var col = o.color || 'var(--s1)';
    var s = '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true">';
    if (o.threshold) s += '<line x1="1" x2="' + (w - 1) + '" y1="' + Y(o.threshold) + '" y2="' + Y(o.threshold) + '" stroke="var(--critical)" stroke-width="1" stroke-dasharray="2 2" opacity=".8"/>';
    s += '<path d="' + d + 'L' + X(n - 1) + ' ' + (h - 2) + 'L' + X(0) + ' ' + (h - 2) + 'Z" fill="' + col + '" opacity=".12"/>';
    s += '<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>';
    s += '<circle cx="' + X(n - 1) + '" cy="' + Y(values[n - 1]) + '" r="2.6" fill="' + col + '" stroke="var(--surface)" stroke-width="1.5"/>';
    return s + '</svg>';
  }

  /* ---------- toast, modal, drawer ---------- */
  var toastEl, toastT;
  function toast(msg) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(function () { toastEl.classList.remove('on'); }, 3200);
  }
  var scrim;
  function ensureScrim() {
    if (!scrim) {
      scrim = document.createElement('div'); scrim.className = 'scrim'; document.body.appendChild(scrim);
      scrim.addEventListener('click', closeOverlays);
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeOverlays(); });
    }
    return scrim;
  }
  var openOverlays = [];
  function closeOverlays() {
    openOverlays.forEach(function (o) { o.classList.remove('on'); if (o._onClose) o._onClose(); });
    openOverlays = []; if (scrim) scrim.classList.remove('on');
  }
  function modal(html, onMount) {
    ensureScrim();
    var m = $('#dbqModal');
    if (!m) { m = document.createElement('div'); m.id = 'dbqModal'; m.className = 'modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); document.body.appendChild(m); }
    m.innerHTML = html;
    closeOverlays();
    scrim.classList.add('on'); m.classList.add('on'); openOverlays.push(m);
    $$('[data-close]', m).forEach(function (b) { b.addEventListener('click', closeOverlays); });
    if (onMount) onMount(m);
    var f = m.querySelector('button, input, textarea'); if (f) f.focus();
    return m;
  }
  function drawer(html, onMount, onClose) {
    ensureScrim();
    var d = $('#dbqDrawer');
    if (!d) { d = document.createElement('aside'); d.id = 'dbqDrawer'; d.className = 'drawer'; d.setAttribute('role', 'dialog'); document.body.appendChild(d); }
    d.innerHTML = html; d._onClose = onClose;
    closeOverlays();
    scrim.classList.add('on'); d.classList.add('on'); openOverlays.push(d);
    $$('[data-close]', d).forEach(function (b) { b.addEventListener('click', closeOverlays); });
    if (onMount) onMount(d);
    return d;
  }

  // keep hyphenated identifiers such as mmp-app-03 on one line instead of breaking at the hyphen
  function keepWhole(text) {
    return esc(text).replace(/\S+-\S+/g, function (w) { return '<span style="white-space:nowrap">' + w + '</span>'; });
  }

  // guarded action: dry-run count, the exact SQL, a reason for the audit log and an optional second approver
  function guarded(o) {
    var m = state.m;
    return modal('<div class="modal-h"><div class="eyebrow">Guarded action · ' + esc(o.queue) + '</div><h3 style="font-size:18px;margin-top:4px">' + keepWhole(o.title) + '</h3></div>' +
      '<div class="modal-b guard"><p style="margin:0;color:var(--ink-2)">' + esc(o.explain) + '</p>' +
      '<div class="impact"><div><b class="num">' + window.DBQ.fmtNum(o.n) + '</b>' + esc(o.nLabel || 'rows match right now (dry run)') + '</div><div><b>' + esc(window.DBQ.clock(m)) + '</b>evaluated at</div><div><b>2</b>people required</div></div>' +
      (o.warn ? '<div class="guard-warn">' + ICON.warning + '<span>' + esc(o.warn) + '</span></div>' : '') +
      '<pre class="sql">' + sqlHtml(o.sql) + '</pre>' +
      '<label>Reason (goes to the audit log)<textarea class="input" rows="2" placeholder="e.g. INC-DEMO-4411: mmp-app-03 wedged, restarted by platform team"></textarea></label>' +
      '<label class="check"><input type="checkbox" id="fourEyes" checked> Ask a second operator to approve before it runs (four-eyes)</label></div>' +
      '<div class="modal-f"><button class="btn ghost" data-close>Cancel</button><button class="btn ' + (o.danger ? 'danger' : 'primary') + '" id="doIt">' + esc(o.cta || 'Request action') + '</button></div>', function (md) {
      $('#doIt', md).addEventListener('click', function () {
        var four = $('#fourEyes', md).checked;
        closeOverlays();
        toast(four ? 'Sent for approval. Prototype only: nothing was changed.' : 'Prototype only: in the real console this runs the SQL above and writes an audit row.');
      });
    });
  }

  // very small SQL highlighter for display blocks
  function sqlHtml(sql) {
    return esc(sql)
      .replace(/(--[^\n]*)/g, '<span class="cm">$1</span>')
      .replace(/\b(SELECT|FROM|WHERE|AND|OR|GROUP BY|ORDER BY|UPDATE|SET|RETURNING|INSERT INTO|VALUES|LIMIT|COUNT|FILTER|CASE|WHEN|THEN|ELSE|END|AS|IN|IS|NULL|NOT|WITH|JOIN|ON|MIN|MAX|NOW|INTERVAL|FOR UPDATE SKIP LOCKED|DISTINCT|LEFT JOIN|EXTRACT|EPOCH|HAVING|SUM|COALESCE)\b(?![^<]*<\/span>)/g, '<span class="kw">$1</span>');
  }

  window.DBQUI = {
    esc: esc, $: $, $$: $$, cssVar: cssVar, compact: compact, rate: rate, clockS: clockS,
    ICON: ICON, SEV_LABEL: SEV_LABEL, status: status, badge: badge, rankSev: rankSev,
    mountChrome: mountChrome, onTime: onTime, setTime: setTime, now: function () { return state.m; },
    parseHash: parseHash, writeHash: writeHash, getDayHealth: getDayHealth,
    guarded: guarded, tip: tip, tipRows: tipRows, chart: chart, spark: spark, niceMax: niceMax,
    toast: toast, modal: modal, drawer: drawer, closeOverlays: closeOverlays, sqlHtml: sqlHtml,
    start: function () { listeners.forEach(function (fn) { fn(state.m, { initial: true }); }); }
  };
})();
