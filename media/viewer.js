// Flame Graph & pprof Viewer by Zovo: the editor webview. Draws the view the extension sends (media/flame.js), the
// toolbar (profile picker, left heavy or time order, flame or icicle, search) and the function table.
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var $ = function (id) { return document.getElementById(id); };
  var TIME = { nanoseconds: 1e-9, microseconds: 1e-6, milliseconds: 1e-3, seconds: 1 };
  function num(n, d) { return n.toLocaleString('en-US', { maximumFractionDigits: d }); }
  function fmt(v, unit) {
    var t = TIME[unit];
    if (t) {
      var s = v * t, a = Math.abs(s);
      if (a >= 60) return num(s / 60, 1) + ' min';
      if (a >= 1) return num(s, 2) + ' s';
      if (a >= 1e-3) return num(s * 1e3, 2) + ' ms';
      if (a >= 1e-6) return num(s * 1e6, 1) + ' µs';
      return num(s * 1e9, 0) + ' ns';
    }
    if (unit === 'bytes') {
      var b = Math.abs(v);
      if (b >= 1073741824) return (v / 1073741824).toFixed(2) + ' GB';
      if (b >= 1048576) return (v / 1048576).toFixed(2) + ' MB';
      if (b >= 1024) return (v / 1024).toFixed(2) + ' KB';
      return num(v, 0) + ' B';
    }
    if (unit === 'objects') return num(v, 0) + ' objects';
    return num(v, Math.abs(v) < 10 ? 2 : 0) + (Math.abs(v) === 1 ? ' sample' : ' samples');
  }
  function pct(v, total) { var p = total > 0 ? v / total * 100 : 0; return (p >= 10 ? p.toFixed(1) : p.toFixed(2)) + ' %'; }
  function ta(T, v) {
    if (v instanceof T) return v;
    if (!v) return new T(0);
    if (v instanceof ArrayBuffer) return new T(v);
    if (ArrayBuffer.isView(v)) return new T(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    if (Array.isArray(v)) return T.from(v);
    return T.from(Object.keys(v).sort(function (a, b) { return a - b; }).map(function (k) { return v[k]; }));
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  var state = vscode.getState() || {};
  var meta = null, data = null, mode = 'left', orientation = 'flame', showTable = true, sortKey = 'self', sortDir = -1, query = '', hlFrame = -1;
  var shownSent = false;
  var tip = $('tip');
  var view = new ZovoFlame.FlameView({
    scroller: $('scroller'), canvas: $('flame'), spacer: $('spacer'),
    onHover: function (i, cx, cy) { hover(i, cx, cy); },
    onSelect: function (i) { details(i); },
    onOpen: function (i) { openFrame(i); },
    onDraw: function (n) { if (!shownSent && n > 0) { shownSent = true; vscode.postMessage({ type: 'shown' }); } },
  });
  window.zovoFlame = {
    view: view,
    /** Bars whose function name is exactly name (or matches a RegExp), with their screen rectangles. */
    find: function (name) {
      var d = view.data, out = [];
      if (!d) return out;
      for (var i = 0; i < d.frame.length; i++) {
        var f = d.frame[i], nm = f < 0 ? 'all' : data.names[f];
        if (name instanceof RegExp ? name.test(nm) : nm === name) { var r = view.rectOf(i); out.push({ i: i, depth: d.depth[i], w: d.w[i], x: r.x, y: r.y, width: r.w, height: r.h }); }
      }
      return out;
    },
    state: function () { return { mode: mode, orientation: orientation, drawn: view.drawn, zoomed: view.zoomed(), selected: view.selected >= 0 ? view.labelOf(view.selected) : '', bars: view.data ? view.data.frame.length : 0, maxDepth: view.maxDepth, total: data ? data.total : 0, unit: data ? data.unit : '' }; },
  };

  function frameLabel(f) { return f < 0 ? 'all' : data.names[f]; }
  function cur() { return mode === 'time' && data && data.chrono ? data.chrono : data.merged; }
  function hover(i, cx, cy) {
    if (i < 0 || !data) { tip.hidden = true; return; }
    var d = cur(), f = d.frame[i], total = data.total;
    var lines = ['<b>' + esc(frameLabel(f)) + '</b>'];
    if (f >= 0 && data.files[f]) lines.push('<span class="muted">' + esc(data.files[f]) + (data.lines[f] ? ':' + data.lines[f] : '') + '</span>');
    lines.push((mode === 'time' && data.chrono ? 'Duration ' : 'Total ') + esc(fmt(d.w[i], data.unit)) + ' (' + pct(d.w[i], total) + ')');
    if (mode !== 'time' && data.merged.self) lines.push('Self ' + esc(fmt(data.merged.self[i], data.unit)) + ' (' + pct(data.merged.self[i], total) + ')');
    tip.innerHTML = lines.join('<br>');
    tip.hidden = false;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(4, Math.min(cx + 14, window.innerWidth - w - 8)) + 'px';
    tip.style.top = Math.max(4, cy + 18 + h > window.innerHeight ? cy - h - 10 : cy + 18) + 'px';
  }
  function details(i) {
    var el = $('details');
    if (i < 0 || !data) return;
    var d = cur(), f = d.frame[i];
    var html = '<b>' + esc(frameLabel(f)) + '</b> <span class="muted">' + (mode === 'time' && data.chrono ? 'duration ' : 'total ') + esc(fmt(d.w[i], data.unit)) + ' (' + pct(d.w[i], data.total) + ')';
    if (mode !== 'time') html += ', self ' + esc(fmt(data.merged.self[i], data.unit)) + ' (' + pct(data.merged.self[i], data.total) + ')';
    html += '</span>';
    if (f >= 0 && data.files[f]) html += ' <a href="#" id="openSrc" title="Open this line in an editor beside the graph">' + esc(shortFile(data.files[f])) + (data.lines[f] ? ':' + data.lines[f] : '') + '</a>';
    html += ' <a href="#" id="copyName" title="Copy the function name">Copy name</a>';
    el.innerHTML = html;
    el.setAttribute('data-frame', String(f));
    var o = $('openSrc'); if (o) o.addEventListener('click', function (e) { e.preventDefault(); vscode.postMessage({ type: 'open', frame: f }); });
    $('copyName').addEventListener('click', function (e) { e.preventDefault(); vscode.postMessage({ type: 'copy', text: frameLabel(f) }); });
  }
  function shortFile(f) { var s = String(f).replace(/^file:\/\//, ''); var p = s.split(/[\\/]/); return p.length > 3 ? '…/' + p.slice(-3).join('/') : s; }
  function openFrame(i) {
    var f = cur().frame[i];
    if (f >= 0) vscode.postMessage({ type: 'open', frame: f });
  }

  // ---------- toolbar ----------
  function setPressed(id, on) { $(id).setAttribute('aria-pressed', on ? 'true' : 'false'); }
  function savePrefs() { vscode.setState({ mode: mode, orientation: orientation }); vscode.postMessage({ type: 'prefs', mode: mode, orientation: orientation, table: showTable }); }
  function applyMode(m, keep) {
    if (m === 'time' && !(data && data.chrono)) m = 'left';
    mode = m;
    setPressed('modeLeft', m === 'left'); setPressed('modeTime', m === 'time');
    if (!data) return;
    var d = cur();
    view.setData(d, data.names, data.files);
    view.orientation = orientation;
    view.layout(true);
    if (query) runSearch();
    if (hlFrame >= 0) view.setHighlightFrame(hlFrame);
    if (!keep) savePrefs();
  }
  function applyOrientation(o, keep) {
    orientation = o;
    setPressed('orFlame', o === 'flame'); setPressed('orIcicle', o === 'icicle');
    view.setOrientation(o);
    if (!keep) savePrefs();
  }
  $('modeLeft').addEventListener('click', function () { applyMode('left'); });
  $('modeTime').addEventListener('click', function () { applyMode('time'); });
  $('orFlame').addEventListener('click', function () { applyOrientation('flame'); });
  $('orIcicle').addEventListener('click', function () { applyOrientation('icicle'); });
  $('reset').addEventListener('click', function () { view.reset(); hlFrame = -1; view.setHighlightFrame(-1); markRow(); });
  $('tableBtn').addEventListener('click', function () { showTable = !showTable; applyTable(); savePrefs(); });
  function applyTable() { setPressed('tableBtn', showTable); $('tablePane').hidden = !showTable; view.resize(); }
  $('view').addEventListener('change', function () { vscode.postMessage({ type: 'view', id: Number($('view').value) }); $('busy').hidden = false; });
  var searchTimer = 0;
  $('search').addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(function () { query = $('search').value.trim(); runSearch(); renderTable(); }, 120); });
  function matcher() {
    if (!query) return null;
    var re = null;
    if (query.length > 2 && query.charAt(0) === '/' && query.charAt(query.length - 1) === '/') { try { re = new RegExp(query.slice(1, -1), 'i'); } catch (e) { re = null; } }
    var q = query.toLowerCase();
    return re ? function (s) { return re.test(s); } : function (s) { return s.toLowerCase().indexOf(q) >= 0; };
  }
  function runSearch() {
    var m = matcher();
    if (!m || !data) { view.setMatch(null); $('matches').textContent = ''; return; }
    var names = data.names, files = data.files;
    var share = view.setMatch(function (f) { return m(names[f]) || (files[f] && m(files[f])); });
    $('matches').textContent = share > 0 ? pct(share, 1) + ' of the total' : 'no match';
  }
  document.addEventListener('keydown', function (e) {
    var t = e.target && e.target.tagName;
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); $('search').focus(); $('search').select(); return; }
    // keys with Cmd, Ctrl or Alt belong to VS Code (Cmd+B, Ctrl+T ...), not to the graph
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (t === 'INPUT' || t === 'SELECT') { if (e.key === 'Escape') { $('search').value = ''; query = ''; runSearch(); renderTable(); $('scroller').focus(); } return; }
    if (e.key === 'Escape') { view.reset(); hlFrame = -1; view.setHighlightFrame(-1); markRow(); }
    else if (e.key === '/') { e.preventDefault(); $('search').focus(); }
    else if (e.key === 'l' || e.key === 'L') applyMode('left');
    else if (e.key === 't' || e.key === 'T') applyMode('time');
    else if (e.key === 'f' || e.key === 'F') applyOrientation('flame');
    else if (e.key === 'i' || e.key === 'I') applyOrientation('icicle');
    else if (e.key === 'b' || e.key === 'B') { showTable = !showTable; applyTable(); savePrefs(); }
  });

  // ---------- table ----------
  var rows = [];
  function buildRows() {
    rows = [];
    var fn = data.fn, total = data.total;
    for (var i = 0; i < fn.frame.length; i++) {
      var f = fn.frame[i];
      rows.push({ f: f, name: data.names[f], file: data.files[f] || '', line: data.lines[f] || 0, self: fn.self[i], total: fn.total[i], selfPct: total ? fn.self[i] / total : 0, totalPct: total ? fn.total[i] / total : 0 });
    }
  }
  function renderTable() {
    if (!data) return;
    var m = matcher();
    var list = m ? rows.filter(function (r) { return m(r.name) || (r.file && m(r.file)); }) : rows.slice();
    var k = sortKey, dir = sortDir;
    list.sort(function (a, b) { var x = a[k], y = b[k]; if (typeof x === 'string') return dir * x.localeCompare(y); return dir * (x - y) || (b.total - a.total); });
    var LIMIT = 500, html = [];
    for (var i = 0; i < list.length && i < LIMIT; i++) {
      var r = list[i];
      html.push('<tr data-f="' + r.f + '"' + (r.f === hlFrame ? ' class="hl"' : '') + '><td class="num">' + esc(fmt(r.self, data.unit)) + '</td><td class="num">' + pct(r.self, data.total) + '</td><td class="num">' + esc(fmt(r.total, data.unit)) + '</td><td class="num">' + pct(r.total, data.total) + '</td><td class="name" title="' + esc(r.name) + '">' + esc(r.name) + '</td><td class="file" title="' + esc(r.file) + '">' + (r.file ? esc(shortFile(r.file)) + (r.line ? ':' + r.line : '') : '') + '</td></tr>');
    }
    document.querySelector('#fn tbody').innerHTML = html.join('');
    $('tableNote').textContent = (m ? list.length.toLocaleString('en-US') + ' of ' : '') + rows.length.toLocaleString('en-US') + ' functions' + (list.length > LIMIT ? ', the first ' + LIMIT + ' shown' : '') + '. Click a row to light up its bars; double-click opens the source.';
    var ths = document.querySelectorAll('#fn th');
    for (var j = 0; j < ths.length; j++) { var on = ths[j].getAttribute('data-k') === sortKey; ths[j].classList.toggle('sorted', on); ths[j].setAttribute('aria-sort', on ? (sortDir < 0 ? 'descending' : 'ascending') : 'none'); }
  }
  function markRow() { var trs = document.querySelectorAll('#fn tbody tr'); for (var i = 0; i < trs.length; i++) trs[i].classList.toggle('hl', Number(trs[i].getAttribute('data-f')) === hlFrame); }
  document.querySelector('#fn thead').addEventListener('click', function (e) {
    var th = e.target.closest('th'); if (!th) return;
    var k = th.getAttribute('data-k');
    if (k === sortKey) sortDir = -sortDir; else { sortKey = k; sortDir = k === 'name' || k === 'file' ? 1 : -1; }
    renderTable();
  });
  document.querySelector('#fn tbody').addEventListener('click', function (e) {
    var tr = e.target.closest('tr'); if (!tr) return;
    var f = Number(tr.getAttribute('data-f'));
    hlFrame = hlFrame === f ? -1 : f;
    view.setHighlightFrame(hlFrame);
    markRow();
  });
  document.querySelector('#fn tbody').addEventListener('dblclick', function (e) {
    var tr = e.target.closest('tr'); if (!tr) return;
    vscode.postMessage({ type: 'open', frame: Number(tr.getAttribute('data-f')) });
  });

  // ---------- messages ----------
  function showError(text) { var e = $('err'); e.textContent = text; e.hidden = false; $('busy').hidden = true; }
  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'meta') {
      meta = m;
      if (m.error) { showError(m.error); $('fmt').textContent = 'Not opened'; vscode.postMessage({ type: 'failed' }); return; }
      $('err').hidden = true;
      if (m.prefs) { mode = m.prefs.mode === 'time' ? 'time' : 'left'; orientation = m.prefs.orientation === 'icicle' ? 'icicle' : 'flame'; showTable = m.prefs.table !== false; }
      if (state.mode) mode = state.mode;
      if (state.orientation) orientation = state.orientation;
      var sel = $('view'); sel.innerHTML = '';
      m.views.forEach(function (v) { var o = document.createElement('option'); o.value = String(v.id); o.textContent = v.label + ' – ' + fmt(v.total, v.unit); sel.appendChild(o); });
      sel.value = String(m.current);
      $('viewBox').hidden = m.views.length < 2;
      $('viewLbl').textContent = m.format === 'pprof' ? 'Sample type' : m.format === 'trace' ? 'Thread' : 'Profile';
      var w = $('warn');
      if (m.warnings && m.warnings.length) { w.textContent = m.warnings.join(' '); w.hidden = false; } else w.hidden = true;
      applyTable();
    } else if (m.type === 'data') {
      data = {
        view: m.view, label: m.label, unit: m.unit, total: m.total, names: m.names, files: m.files, lines: m.lines,
        merged: { frame: ta(Int32Array, m.merged.frame), depth: ta(Int32Array, m.merged.depth), x: ta(Float64Array, m.merged.x), w: ta(Float64Array, m.merged.w), self: ta(Float64Array, m.merged.self) },
        chrono: m.chrono ? { frame: ta(Int32Array, m.chrono.frame), depth: ta(Int32Array, m.chrono.depth), x: ta(Float64Array, m.chrono.x), w: ta(Float64Array, m.chrono.w) } : null,
        chronoLabel: m.chronoLabel || 'Time order',
        fn: { frame: ta(Int32Array, m.fn.frame), self: ta(Float64Array, m.fn.self), total: ta(Float64Array, m.fn.total) },
      };
      $('busy').hidden = true;
      $('view').value = String(m.view);
      $('modeTime').textContent = data.chronoLabel;
      $('modeTime').disabled = !data.chrono;
      $('modeTime').title = data.chrono ? 'Keep the order of the samples (T)' : m.chronoTooBig ? 'This profile changes call path more than 3 million times, too many bars for the time order; left heavy shows all of it' : 'This profile has no sample order (pprof and heap profiles are sums)';
      $('fmt').textContent = (meta && meta.formatLabel ? meta.formatLabel + ' · ' : '') + fmt(m.total, m.unit) + ' · ' + m.fn.frame.length.toLocaleString('en-US') + ' functions';
      hlFrame = -1;
      buildRows();
      applyMode(mode, true);
      applyOrientation(orientation, true);
      view.layout(true);
      renderTable();
      $('details').innerHTML = '<span class="hint">Click a bar to zoom in. Ctrl or Cmd + click (or double-click) opens the source line when the file is in your workspace. Ctrl or Cmd + wheel zooms at the mouse.</span>';
    } else if (m.type === 'note') {
      var n = document.createElement('div'); n.className = 'note'; n.textContent = m.text;
      var dd = $('details'); var old = dd.querySelector('.note'); if (old) old.remove(); dd.appendChild(n);
    }
  });
  window.addEventListener('resize', function () { view.resize(); });
  var foot = $('zovo-footer'); if (foot && foot.innerHTML.trim()) $('footer').innerHTML = foot.innerHTML;
  vscode.postMessage({ type: 'ready' });
})();
