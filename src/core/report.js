'use strict';
// The three Pro outputs, as pure functions (no vscode): the hotspot report (CSV and a JSON summary), the profile diff
// (per-bar change for a red and blue flame graph plus a regression table) and the standalone SVG and HTML reports.
const { formatValue, csvValue, csvUnit, pct, normUnit } = require('./units');

const csvCell = (s) => (/[",\r\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- hotspots ----------

/** Functions by self weight, heaviest first. */
function hotspots(view, frames, limit = 50) {
  const fn = view.fn, total = view.total || 0;
  const idx = Array.from({ length: fn.frame.length }, (_, i) => i).sort((a, b) => (fn.self[b] - fn.self[a]) || (fn.total[b] - fn.total[a]) || (a - b));
  return idx.slice(0, Math.max(1, limit)).map((i, k) => {
    const f = fn.frame[i];
    return { rank: k + 1, frame: f, name: frames.names[f], file: frames.files[f] || '', line: frames.lines[f] || 0, self: fn.self[i], selfPct: pct(fn.self[i], total), total: fn.total[i], totalPct: pct(fn.total[i], total) };
  });
}

function hotspotsCsv(rows, unit) {
  const u = csvUnit(unit);
  const head = ['rank', 'function', 'file', 'line', `self_${u}`, 'self_pct', `total_${u}`, 'total_pct'];
  return [head.join(',')].concat(rows.map((r) => [r.rank, csvCell(r.name), csvCell(r.file), r.line || '', csvValue(r.self, unit), round(r.selfPct, 3), csvValue(r.total, unit), round(r.totalPct, 3)].join(','))).join('\n') + '\n';
}

/** A JSON summary a CI step can read: the top functions with their share of the total. */
function hotspotsJson({ file, format, view, rows, generated }) {
  return {
    tool: 'Flame Graph & pprof Viewer by Zovo',
    schema: 1,
    file, format, profile: view.label,
    unit: csvUnit(view.unit),
    total: csvValue(view.total, view.unit),
    totalText: formatValue(view.total, view.unit),
    samples: view.samples,
    functions: view.fn.frame.length,
    generated: generated || new Date().toISOString(),
    top: rows.map((r) => ({ rank: r.rank, function: r.name, file: r.file || null, line: r.line || null, self: csvValue(r.self, view.unit), selfPct: round(r.selfPct, 3), total: csvValue(r.total, view.unit), totalPct: round(r.totalPct, 3) })),
  };
}

// ---------- diff ----------

/**
 * Compares two views by call path (function names from the root). Returns the change of each "after" bar's share of
 * its profile (after % minus before %) and a table of functions by change in self share.
 */
function diffViews(before, beforeFrames, after, afterFrames, limit = 200) {
  const bm = before.merged, am = after.merged;
  const bTotal = before.total || 1, aTotal = after.total || 1;
  const keyOf = new Map();
  const nameB = (i) => (bm.frame[i] < 0 ? '' : beforeFrames.names[bm.frame[i]]);
  const nameA = (i) => (am.frame[i] < 0 ? '' : afterFrames.names[am.frame[i]]);
  const nB = bm.frame.length, nA = am.frame.length;
  for (let i = 1; i < nB; i++) { const k = `${bm.parent[i]}\u0001${nameB(i)}`; if (!keyOf.has(k)) keyOf.set(k, i); }
  const match = new Int32Array(nA).fill(-1);
  match[0] = 0;
  const delta = new Float32Array(nA);
  let maxAbs = 0;
  for (let j = 0; j < nA; j++) {
    if (j > 0) {
      const pm = match[am.parent[j]];
      if (pm >= 0) { const m = keyOf.get(`${pm}\u0001${nameA(j)}`); match[j] = m === undefined ? -1 : m; }
    }
    const b = match[j] >= 0 ? bm.w[match[j]] / bTotal : 0;
    const d = am.w[j] / aTotal - b;
    delta[j] = d;
    if (j > 0 && Math.abs(d) > maxAbs) maxAbs = Math.abs(d);
  }
  // functions by name
  const agg = new Map();
  const put = (frames, fn, total, side) => {
    for (let i = 0; i < fn.frame.length; i++) {
      const f = fn.frame[i], name = frames.names[f];
      let r = agg.get(name);
      if (!r) { r = { name, file: frames.files[f] || '', bSelf: 0, bTotal: 0, aSelf: 0, aTotal: 0 }; agg.set(name, r); }
      if (side === 'b') { r.bSelf += fn.self[i] / total * 100; r.bTotal += fn.total[i] / total * 100; } else { r.aSelf += fn.self[i] / total * 100; r.aTotal += fn.total[i] / total * 100; if (frames.files[f]) r.file = frames.files[f]; }
    }
  };
  put(beforeFrames, before.fn, bTotal, 'b');
  put(afterFrames, after.fn, aTotal, 'a');
  const all = [...agg.values()].map((r) => ({ ...r, dSelf: r.aSelf - r.bSelf, dTotal: r.aTotal - r.bTotal, status: r.bTotal === 0 ? 'new' : r.aTotal === 0 ? 'gone' : '' }));
  all.sort((x, y) => (y.dSelf - x.dSelf) || (y.dTotal - x.dTotal) || x.name.localeCompare(y.name));
  const regressions = all.filter((r) => r.dSelf > 0.005).length;
  const improvements = all.filter((r) => r.dSelf < -0.005).length;
  const rows = all.length > limit ? all.slice(0, Math.ceil(limit / 2)).concat(all.slice(-Math.floor(limit / 2))) : all;
  return {
    delta, maxAbs, rows, all,
    summary: {
      beforeTotal: before.total, afterTotal: after.total, beforeUnit: before.unit, afterUnit: after.unit,
      beforeText: formatValue(before.total, before.unit), afterText: formatValue(after.total, after.unit),
      sameUnit: normUnit(before.unit) === normUnit(after.unit),
      changePct: normUnit(before.unit) === normUnit(after.unit) && before.total ? (after.total - before.total) / before.total * 100 : null,
      functions: all.length, regressions, improvements,
      newFunctions: all.filter((r) => r.status === 'new').length, goneFunctions: all.filter((r) => r.status === 'gone').length,
      matchedBars: Array.from(match).filter((m) => m >= 0).length - 1, bars: nA - 1,
    },
  };
}

function diffCsv(all) {
  const head = ['function', 'file', 'before_self_pct', 'after_self_pct', 'change_self_pct', 'before_total_pct', 'after_total_pct', 'change_total_pct', 'status'];
  return [head.join(',')].concat(all.map((r) => [csvCell(r.name), csvCell(r.file), round(r.bSelf, 3), round(r.aSelf, 3), round(r.dSelf, 3), round(r.bTotal, 3), round(r.aTotal, 3), round(r.dTotal, 3), r.status].join(','))).join('\n') + '\n';
}

// ---------- SVG and HTML ----------

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
// the same palette as media/flame.js
function colorOf(name, file) {
  const h = hash(name || '');
  const n = name || '';
  if (n[0] === '(' || n[0] === '[') return `hsl(220,6%,${58 + (h % 10)}%)`;
  const f = file || '';
  if (/^node:|^internal\/|^runtime[./]|^runtime$/.test(f) || /^runtime\.|^syscall\.|^internal\//.test(n)) return `hsl(${190 + (h % 30)},45%,${55 + ((h >> 8) % 12)}%)`;
  if (/node_modules|\/pkg\/mod\/|site-packages|vendor\//.test(f)) return `hsl(${40 + (h % 18)},70%,${54 + ((h >> 8) % 10)}%)`;
  return `hsl(${h % 38},${68 + ((h >> 8) % 20)}%,${55 + ((h >> 16) % 10)}%)`;
}

/** Bars wide enough to see at a given width, so a report of a huge profile stays small. */
function visibleBars(view, width, minPx = 0.5) {
  const m = view.merged, total = view.total || 1, out = [];
  const n = m.frame.length;
  let skipDepth = -1;
  for (let i = 0; i < n; i++) {
    if (skipDepth >= 0 && m.depth[i] > skipDepth) continue;
    skipDepth = -1;
    if ((m.w[i] / total) * width < minPx) { skipDepth = m.depth[i]; continue; }
    out.push(i);
  }
  return out;
}

/** A standalone SVG flame graph (root at the bottom) with a tooltip on every bar. */
function svgReport(view, frames, o = {}) {
  const W = o.width || 1200, ROW = 17, TOP = 44, total = view.total || 1;
  const bars = visibleBars(view, W - 20);
  const m = view.merged;
  let maxD = 0;
  for (const i of bars) if (m.depth[i] > maxD) maxD = m.depth[i];
  const H = TOP + (maxD + 1) * ROW + 24;
  const sc = (W - 20) / total;
  const parts = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Verdana, Arial, sans-serif" font-size="11">`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#fdfdfd"/>`);
  parts.push(`<text x="10" y="20" font-size="15" fill="#111">${xml(o.title || 'Flame graph')}</text>`);
  parts.push(`<text x="10" y="36" fill="#555">${xml(o.subtitle || `${view.label}, total ${formatValue(view.total, view.unit)}`)}</text>`);
  for (const i of bars) {
    const f = m.frame[i];
    const name = f < 0 ? 'all' : frames.names[f];
    const file = f < 0 ? '' : frames.files[f];
    const x = 10 + m.x[i] * sc, w = m.w[i] * sc, y = TOP + (maxD - m.depth[i]) * ROW;
    const tip = `${name}${file ? ` (${file}${frames.lines[f] ? `:${frames.lines[f]}` : ''})` : ''}\ntotal ${formatValue(m.w[i], view.unit)} (${pct(m.w[i], total).toFixed(2)} %), self ${formatValue(m.self[i], view.unit)} (${pct(m.self[i], total).toFixed(2)} %)`;
    const max = Math.floor((w - 6) / 6.6);
    const label = max > 2 ? (name.length > max ? `${name.slice(0, max - 1)}…` : name) : '';
    parts.push(`<g><title>${xml(tip)}</title><rect x="${x.toFixed(2)}" y="${y}" width="${Math.max(0.5, w - 0.6).toFixed(2)}" height="${ROW - 1}" rx="1.5" fill="${f < 0 ? 'hsl(220,8%,62%)' : colorOf(name, file)}"/>${label ? `<text x="${(x + 3).toFixed(2)}" y="${y + 12}" fill="#111">${xml(label)}</text>` : ''}</g>`);
  }
  parts.push(`<text x="10" y="${H - 8}" fill="#777" font-size="10">Made with Flame Graph &amp; pprof Viewer by Zovo. ${bars.length.toLocaleString('en-US')} of ${(m.frame.length).toLocaleString('en-US')} bars are wide enough to show.</text>`);
  parts.push('</svg>');
  return { svg: parts.join('\n') + '\n', bars: bars.length };
}

/**
 * A standalone HTML report: the interactive flame graph (the viewer's own renderer, inlined), search, the info rows
 * and the top functions. Opens in any browser with no network access.
 */
function htmlReport(view, frames, o = {}) {
  const width = 4000;
  const bars = visibleBars(view, width, 0.25);
  const m = view.merged;
  const remap = new Map();
  const names = [], files = [];
  const fr = [], dp = [], xs = [], ws = [], sf = [];
  for (const i of bars) {
    const f = m.frame[i];
    let g = -1;
    if (f >= 0) { g = remap.get(f); if (g === undefined) { g = names.length; remap.set(f, g); names.push(frames.names[f]); files.push(frames.files[f] || ''); } }
    fr.push(g); dp.push(m.depth[i]); xs.push(m.x[i]); ws.push(m.w[i]); sf.push(m.self[i]);
  }
  const top = hotspots(view, frames, o.top || 30);
  const data = { names, files, frame: fr, depth: dp, x: xs, w: ws, self: sf, unit: view.unit, total: view.total };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const rowsHtml = top.map((r) => `<tr><td>${r.rank}</td><td class="fn">${xml(r.name)}</td><td>${xml(formatValue(r.self, view.unit))}</td><td>${r.selfPct.toFixed(2)} %</td><td>${xml(formatValue(r.total, view.unit))}</td><td>${r.totalPct.toFixed(2)} %</td><td class="file">${xml(r.file ? `${r.file}${r.line ? `:${r.line}` : ''}` : '')}</td></tr>`).join('\n');
  const info = (o.info || []).map(([k, v]) => `<span><b>${xml(k)}</b> ${xml(v)}</span>`).join('');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Flame Graph &amp; pprof Viewer by Zovo">
<title>${xml(o.title || 'Flame graph report')}</title>
<style>
:root { --vscode-editor-background: #ffffff; --vscode-font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
body { margin: 0; font: 13px var(--vscode-font-family); color: #1d1d1f; background: #fff; }
header { padding: 14px 18px 8px; border-bottom: 1px solid #ddd; }
h1 { font-size: 18px; margin: 0 0 4px; }
.info span { margin-right: 16px; color: #444; }
.bar { display: flex; gap: 8px; align-items: center; padding: 8px 18px; }
.bar input { width: 260px; padding: 4px 6px; }
.bar button { padding: 3px 10px; }
#scroller { position: relative; height: 62vh; overflow: auto; border-top: 1px solid #eee; border-bottom: 1px solid #eee; }
#flame { position: sticky; top: 0; display: block; }
#tip { position: fixed; pointer-events: none; background: #222; color: #fff; padding: 6px 8px; border-radius: 4px; font-size: 12px; max-width: 520px; display: none; z-index: 5; white-space: pre-wrap; }
table { border-collapse: collapse; margin: 12px 18px 24px; font-size: 12px; }
th, td { text-align: left; padding: 3px 10px 3px 0; border-bottom: 1px solid #eee; }
td.fn { font-family: ui-monospace, Menlo, Consolas, monospace; }
td.file { color: #666; }
footer { color: #777; font-size: 11px; padding: 0 18px 18px; }
</style>
</head>
<body>
<header><h1>${xml(o.title || 'Flame graph report')}</h1><div class="info">${info}</div></header>
<div class="bar"><input id="q" type="search" placeholder="Search functions" aria-label="Search functions"><span id="hits"></span><button id="reset" type="button">Reset zoom</button><span style="color:#666">Click a bar to zoom, Ctrl or Cmd + wheel to zoom at the mouse.</span></div>
<div id="scroller"><canvas id="flame" aria-label="Flame graph"></canvas><div id="spacer"></div></div>
<div id="tip"></div>
<h2 style="font-size:15px;margin:16px 18px 0">Top functions by self ${xml(view.unit === 'bytes' ? 'memory' : 'time')}</h2>
<table><thead><tr><th>#</th><th>Function</th><th>Self</th><th>Self %</th><th>Total</th><th>Total %</th><th>File</th></tr></thead><tbody>
${rowsHtml}
</tbody></table>
<footer>Made with Flame Graph &amp; pprof Viewer by Zovo on ${xml((o.generated || new Date().toISOString()).slice(0, 10))}. ${bars.length.toLocaleString('en-US')} of ${m.frame.length.toLocaleString('en-US')} bars are included (the rest are too narrow to see). This file loads nothing from the network.</footer>
<script>
${o.flameJs || ''}
</script>
<script>
(function () {
  var D = ${json};
  var unit = D.unit, total = D.total;
  function fmt(v) {
    var t = { nanoseconds: 1e-9, microseconds: 1e-6, milliseconds: 1e-3, seconds: 1 }[unit];
    if (t) { var s = v * t; return s >= 1 ? s.toFixed(2) + ' s' : s >= 1e-3 ? (s * 1e3).toFixed(2) + ' ms' : (s * 1e6).toFixed(1) + ' \\u00b5s'; }
    if (unit === 'bytes') return v >= 1048576 ? (v / 1048576).toFixed(2) + ' MB' : v >= 1024 ? (v / 1024).toFixed(2) + ' KB' : Math.round(v) + ' B';
    return Math.round(v).toLocaleString('en-US') + ' ' + (unit === 'objects' ? 'objects' : 'samples');
  }
  var d = { frame: Int32Array.from(D.frame), depth: Int32Array.from(D.depth), x: Float64Array.from(D.x), w: Float64Array.from(D.w) };
  var tip = document.getElementById('tip');
  var view = new ZovoFlame.FlameView({ scroller: document.getElementById('scroller'), canvas: document.getElementById('flame'), spacer: document.getElementById('spacer'),
    onHover: function (i, cx, cy) {
      if (i < 0) { tip.style.display = 'none'; return; }
      var f = d.frame[i], name = f < 0 ? 'all' : D.names[f];
      tip.textContent = name + (f >= 0 && D.files[f] ? '\\n' + D.files[f] : '') + '\\ntotal ' + fmt(d.w[i]) + ' (' + (d.w[i] / total * 100).toFixed(2) + ' %), self ' + fmt(D.self[i]) + ' (' + (D.self[i] / total * 100).toFixed(2) + ' %)';
      tip.style.display = 'block'; tip.style.left = Math.min(cx + 14, innerWidth - 540) + 'px'; tip.style.top = (cy + 14) + 'px';
    } });
  view.setData(d, D.names, D.files);
  var q = document.getElementById('q'), hits = document.getElementById('hits');
  q.addEventListener('input', function () {
    var s = q.value.trim().toLowerCase();
    if (!s) { view.setMatch(null); hits.textContent = ''; return; }
    var share = view.setMatch(function (f) { return D.names[f].toLowerCase().indexOf(s) >= 0; });
    hits.textContent = (share * 100).toFixed(1) + ' % of the total';
  });
  document.getElementById('reset').addEventListener('click', function () { view.reset(); });
})();
</script>
</body>
</html>
`;
  return { html, bars: bars.length };
}

module.exports = { hotspots, hotspotsCsv, hotspotsJson, diffViews, diffCsv, svgReport, htmlReport, visibleBars, colorOf, csvCell };
