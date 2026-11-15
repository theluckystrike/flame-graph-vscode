'use strict';
// Units of profile weights and how they print. Shared by the parsers, the exports and (as a copy) the webview.

const TIME = { nanoseconds: 1e-9, microseconds: 1e-6, milliseconds: 1e-3, seconds: 1 };
const ALIASES = { ns: 'nanoseconds', nanosecond: 'nanoseconds', us: 'microseconds', microsecond: 'microseconds', ms: 'milliseconds', millisecond: 'milliseconds', s: 'seconds', second: 'seconds', byte: 'bytes', b: 'bytes', sample: 'samples', none: 'samples', count: 'samples', '': 'samples', objects: 'objects', object: 'objects' };

function normUnit(u) {
  const s = String(u || '').trim().toLowerCase();
  if (TIME[s] || s === 'bytes' || s === 'samples' || s === 'objects') return s;
  return ALIASES[s] || s || 'samples';
}

function num(n, digits) {
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** 1234567 microseconds -> "1.23 s"; 2048 bytes -> "2.00 KB"; 12 samples -> "12 samples". */
function formatValue(v, unit) {
  const u = normUnit(unit);
  if (TIME[u]) {
    const s = v * TIME[u];
    const a = Math.abs(s);
    if (a >= 60) return `${num(s / 60, 1)} min`;
    if (a >= 1) return `${num(s, 2)} s`;
    if (a >= 1e-3) return `${num(s * 1e3, 2)} ms`;
    if (a >= 1e-6) return `${num(s * 1e6, 1)} µs`;
    return `${num(s * 1e9, 0)} ns`;
  }
  if (u === 'bytes') {
    const a = Math.abs(v);
    if (a >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`;
    if (a >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(2)} MB`;
    if (a >= 1024) return `${(v / 1024).toFixed(2)} KB`;
    return `${num(v, 0)} B`;
  }
  if (u === 'objects') return `${num(v, 0)} objects`;
  if (u === 'samples') return `${num(v, Math.abs(v) < 10 ? 2 : 0)} ${Math.abs(v) === 1 ? 'sample' : 'samples'}`;
  return `${num(v, 2)} ${u}`;
}

/** Plain number in a unit a CSV reader can sort: milliseconds for time, bytes, samples. */
function csvValue(v, unit) {
  const u = normUnit(unit);
  if (TIME[u]) return Math.round(v * TIME[u] * 1e3 * 1e6) / 1e6;
  return Math.round(v * 1e6) / 1e6;
}
function csvUnit(unit) {
  const u = normUnit(unit);
  return TIME[u] ? 'ms' : u;
}

const pct = (v, total) => (total > 0 ? (v / total) * 100 : 0);
const fmtPct = (p) => `${p >= 10 ? p.toFixed(1) : p.toFixed(2)} %`;

module.exports = { normUnit, formatValue, csvValue, csvUnit, pct, fmtPct, TIME };
