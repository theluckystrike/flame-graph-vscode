// Flame Graph & pprof Viewer by Zovo: the Pro tool panels. "diff" draws the after profile with each bar colored by
// its change against the before profile (red grew, blue shrank) and lists the functions by change; "hotspots" lists
// the top functions by self weight with the paths of the saved CSV and JSON files.
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function ta(T, v) {
    if (v instanceof T) return v;
    if (!v) return new T(0);
    if (ArrayBuffer.isView(v)) return new T(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    if (Array.isArray(v)) return T.from(v);
    return T.from(Object.keys(v).sort(function (a, b) { return a - b; }).map(function (k) { return v[k]; }));
  }
  function signed(p) { var s = p.toFixed(Math.abs(p) >= 10 ? 1 : 2); return (p > 0 ? '+' : p < 0 ? '' : '±') + s + ' pts'; }
  function p2(p) { return p.toFixed(p >= 10 ? 1 : 2) + ' %'; }
  var tip = $('tip');

  function shown() { requestAnimationFrame(function () { requestAnimationFrame(function () { vscode.postMessage({ type: 'shown' }); }); }); }

  function renderDiff(m) {
    $('title').textContent = 'Profile diff: ' + m.title;
    var s = m.summary;
    $('actions').innerHTML = '<button class="tb" id="swap" title="Use the other file as the before profile">Swap</button> <button class="tb" id="csv" title="Save the whole table next to the after profile">Save table as CSV</button>';
    var change = s.changePct === null ? 'The two profiles use different units, so shares are compared.' : 'Total ' + m.before.text + ' → ' + m.after.text + ' (' + (s.changePct >= 0 ? '+' : '') + s.changePct.toFixed(1) + ' %).';
    var app = $('app');
    app.innerHTML = '<div class="summary" id="summary"><span class="sw red"></span> grew <span class="sw blue"></span> shrank (share of each profile\'s total; bars are the after profile). ' + esc(change) +
      ' <b>' + s.regressions + '</b> functions take a larger share, <b>' + s.improvements + '</b> a smaller one; ' + s.newFunctions + ' new, ' + s.goneFunctions + ' gone.</div>' +
      '<div id="saved" class="muted"></div>' +
      '<div id="graph" class="diffgraph"><div id="scroller" tabindex="0"><canvas id="flame"></canvas><div id="spacer"></div></div></div>' +
      '<div id="tableWrap" class="panelTable"><table id="rows"><thead><tr><th data-k="name">Function</th><th class="num" data-k="bSelf">Self before</th><th class="num" data-k="aSelf">Self after</th><th class="num sorted" data-k="dSelf" aria-sort="descending">Change</th><th class="num" data-k="bTotal">Total before</th><th class="num" data-k="aTotal">Total after</th><th class="num" data-k="dTotal">Change</th><th></th></tr></thead><tbody></tbody></table></div>';
    var sortK = 'dSelf', sortD = -1;
    function body() {
      var list = m.rows.slice().sort(function (a, b) { var x = a[sortK], y = b[sortK]; return typeof x === 'string' ? sortD * x.localeCompare(y) : sortD * (x - y); });
      document.querySelector('#rows tbody').innerHTML = list.map(function (r) {
        return '<tr class="' + (r.dSelf > 0.005 ? 'up' : r.dSelf < -0.005 ? 'down' : '') + '"><td class="name" title="' + esc(r.file || '') + '">' + esc(r.name) + '</td><td class="num">' + p2(r.bSelf) + '</td><td class="num">' + p2(r.aSelf) + '</td><td class="num chg">' + signed(r.dSelf) + '</td><td class="num">' + p2(r.bTotal) + '</td><td class="num">' + p2(r.aTotal) + '</td><td class="num">' + signed(r.dTotal) + '</td><td>' + (r.status ? '<span class="tag">' + r.status + '</span>' : '') + '</td></tr>';
      }).join('');
      var ths = document.querySelectorAll('#rows th[data-k]');
      for (var j = 0; j < ths.length; j++) { var on = ths[j].getAttribute('data-k') === sortK; ths[j].classList.toggle('sorted', on); ths[j].setAttribute('aria-sort', on ? (sortD < 0 ? 'descending' : 'ascending') : 'none'); }
    }
    body();
    document.querySelector('#rows thead').addEventListener('click', function (e) {
      var th = e.target.closest('th[data-k]'); if (!th) return;
      var k = th.getAttribute('data-k');
      if (k === sortK) sortD = -sortD; else { sortK = k; sortD = k === 'name' ? 1 : -1; }
      body();
    });
    var g = m.graph;
    var d = { frame: ta(Int32Array, g.frame), depth: ta(Int32Array, g.depth), x: ta(Float64Array, g.x), w: ta(Float64Array, g.w) };
    var self = ta(Float64Array, g.self), delta = ta(Float32Array, g.delta);
    var view = new ZovoFlame.FlameView({ scroller: $('scroller'), canvas: $('flame'), spacer: $('spacer'),
      onHover: function (i, cx, cy) {
        if (i < 0) { tip.hidden = true; return; }
        var f = d.frame[i];
        tip.innerHTML = '<b>' + esc(f < 0 ? 'all' : g.names[f]) + '</b><br>after: ' + p2(d.w[i] / g.total * 100) + ' of the total, self ' + p2(self[i] / g.total * 100) + '<br>change: ' + signed(delta[i] * 100);
        tip.hidden = false;
        tip.style.left = Math.min(cx + 14, window.innerWidth - tip.offsetWidth - 8) + 'px'; tip.style.top = (cy + 18) + 'px';
      } });
    view.setData(d, g.names, g.files, { diff: delta, diffMax: g.maxAbs });
    window.zovoDiff = { view: view, delta: delta, names: g.names, find: function (name) { var out = []; for (var i = 0; i < d.frame.length; i++) if (d.frame[i] >= 0 && g.names[d.frame[i]] === name) out.push({ i: i, delta: delta[i], rect: view.rectOf(i) }); return out; } };
    $('swap').addEventListener('click', function () { vscode.postMessage({ type: 'swap' }); });
    $('csv').addEventListener('click', function () { vscode.postMessage({ type: 'saveCsv' }); });
    shown();
  }

  function renderHotspots(m) {
    var maxSelf = m.rows.reduce(function (a, r) { return Math.max(a, r.selfPct); }, 0);
    $('title').textContent = m.title;
    $('actions').innerHTML = '<button class="tb" id="oCsv">Open CSV</button> <button class="tb" id="oJson">Open JSON</button>';
    $('app').innerHTML = '<div class="summary">' + esc(m.label) + ', total ' + esc(m.totalText) + '. Saved <code>' + esc(m.csv) + '</code> and <code>' + esc(m.json) + '</code>.</div>' +
      '<div class="panelTable"><table id="rows"><thead><tr><th class="num">#</th><th>Function</th><th class="num">Self</th><th class="num">Self %</th><th class="num">Total</th><th class="num">Total %</th><th>File</th></tr></thead><tbody>' +
      m.rows.map(function (r) {
        return '<tr><td class="num">' + r.rank + '</td><td class="name">' + esc(r.name) + '</td><td class="num">' + esc(r.selfText) + '</td><td class="num"><span class="meter"><span data-w="' + (maxSelf > 0 ? r.selfPct / maxSelf * 100 : 0).toFixed(1) + '"></span></span>' + p2(r.selfPct) + '</td><td class="num">' + esc(r.totalText) + '</td><td class="num">' + p2(r.totalPct) + '</td><td class="file">' + esc(r.file ? r.file + (r.line ? ':' + r.line : '') : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    // widths through the CSS object model: the page's CSP allows no inline style attributes
    var ms = document.querySelectorAll('.meter span[data-w]');
    for (var k = 0; k < ms.length; k++) ms[k].style.width = ms[k].getAttribute('data-w') + '%';
    $('oCsv').addEventListener('click', function () { vscode.postMessage({ type: 'open', which: 'csv' }); });
    $('oJson').addEventListener('click', function () { vscode.postMessage({ type: 'open', which: 'json' }); });
    shown();
  }

  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'diff') renderDiff(m);
    else if (m.type === 'hotspots') renderHotspots(m);
    else if (m.type === 'saved') { var s = $('saved'); if (s) s.textContent = m.text; }
  });
  vscode.postMessage({ type: 'ready' });
})();
