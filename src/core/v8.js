'use strict';
// V8 CPU profiles (.cpuprofile from Node --cpu-prof, Chrome DevTools, the VS Code JS debugger, and the Profile /
// ProfileChunk events inside a Chrome trace) and V8 sampling heap profiles (.heapprofile from Node --heap-prof and
// Chrome DevTools).
const { Builder, Grow } = require('./builder');

/** Collects the parts of one V8 CPU profile; nodes may come in chunks with "parent" or with "children". */
class CpuProfileParts {
  constructor() {
    this.index = new Map(); // node id -> slot
    this.ids = []; this.parentOf = []; this.callFrames = []; this.hits = [];
    this.samples = new Grow(Float64Array, 4096); this.deltas = new Grow(Float64Array, 4096);
    this.startTime = 0; this.endTime = 0;
  }
  slot(id) {
    let s = this.index.get(id);
    if (s === undefined) { s = this.ids.length; this.index.set(id, s); this.ids.push(id); this.parentOf.push(undefined); this.callFrames.push(null); this.hits.push(0); }
    return s;
  }
  node(n) {
    if (!n || typeof n !== 'object' || n.id === undefined) return;
    const s = this.slot(n.id);
    this.callFrames[s] = n.callFrame || { functionName: n.functionName, url: n.url, lineNumber: n.lineNumber, columnNumber: n.columnNumber };
    this.hits[s] = Number(n.hitCount) || 0;
    if (n.parent !== undefined && this.parentOf[s] === undefined) this.parentOf[s] = n.parent;
    if (Array.isArray(n.children)) for (const c of n.children) { const cs = this.slot(c); if (this.parentOf[cs] === undefined) this.parentOf[cs] = n.id; }
  }
  sample(id) { this.samples.push(Number(id)); }
  delta(d) { this.deltas.push(Number(d) || 0); }
  get nodeCount() { return this.ids.length; }
}

const urlToFile = (url) => {
  if (!url) return '';
  return String(url);
};
const isRootName = (n) => n === '(root)';

/** Frame id of a V8 call frame. Line and column are 0-based in V8; the table stores them 1-based. */
function v8Frame(frames, cf) {
  const name = (cf && cf.functionName) || '';
  const url = urlToFile(cf && cf.url);
  const line = cf && Number.isFinite(cf.lineNumber) && cf.lineNumber >= 0 ? cf.lineNumber + 1 : 0;
  const col = cf && Number.isFinite(cf.columnNumber) && cf.columnNumber >= 0 ? cf.columnNumber + 1 : 0;
  const display = name || (url ? '(anonymous)' : (cf && cf.codeType === 'other' ? '(program)' : '(anonymous)'));
  return frames.id(display, url, line, col, url ? `${line}:${col}` : undefined);
}

/**
 * Feeds the parts into a new builder. Samples with time deltas give the time order; without samples the hit counts
 * give the merged tree only.
 */
function buildCpuProfile(parts, frames, o = {}) {
  const N = parts.nodeCount;
  const frameOf = new Int32Array(N);
  const parentSlot = new Int32Array(N).fill(-1);
  const isRoot = new Uint8Array(N);
  for (let s = 0; s < N; s++) {
    const cf = parts.callFrames[s];
    const p = parts.parentOf[s];
    if (p !== undefined && parts.index.has(p)) parentSlot[s] = parts.index.get(p);
    if (parentSlot[s] < 0 && (!cf || isRootName(cf.functionName))) { isRoot[s] = 1; frameOf[s] = -1; } else frameOf[s] = v8Frame(frames, cf);
  }
  const b = new Builder({ label: o.label || 'CPU profile', unit: 'microseconds', chrono: true });
  const stack = new Int32Array(4096);
  let buf = stack;
  const stackOf = (slot) => {
    let len = 0;
    for (let s = slot, guard = 0; s >= 0 && guard < 100000; s = parentSlot[s], guard++) {
      if (isRoot[s]) break;
      if (len === buf.length) { const nb = new Int32Array(buf.length * 2); nb.set(buf); buf = nb; }
      buf[len++] = frameOf[s];
    }
    // reverse in place: root first
    for (let a = 0, z = len - 1; a < z; a++, z--) { const t = buf[a]; buf[a] = buf[z]; buf[z] = t; }
    return len;
  };
  const S = parts.samples.length;
  if (S > 0) {
    const samples = parts.samples.view(), deltas = parts.deltas.view();
    const D = deltas.length;
    let sum = 0, cnt = 0;
    for (let i = 1; i < D; i++) if (deltas[i] > 0) { sum += deltas[i]; cnt++; }
    const avg = cnt ? sum / cnt : 1;
    for (let i = 0; i < S; i++) {
      const slot = parts.index.get(samples[i]);
      if (slot === undefined) continue;
      // a sample lasts until the next one; the last one gets the average interval
      const w = i + 1 < D ? deltas[i + 1] : avg;
      if (!(w > 0)) continue;
      const len = stackOf(slot);
      b.add(buf, len, w);
    }
  } else {
    let hits = 0;
    for (let s = 0; s < N; s++) hits += parts.hits[s];
    const per = hits && parts.endTime > parts.startTime ? (parts.endTime - parts.startTime) / hits : 1;
    if (!hits) throw new Error('This CPU profile has no samples.');
    b.wantChrono = false;
    for (let s = 0; s < N; s++) {
      if (!parts.hits[s]) continue;
      const len = stackOf(s);
      b.add(buf, len, parts.hits[s] * per);
    }
  }
  return b;
}

/** Sampling heap profile: { head: { callFrame, selfSize, children }, samples }. */
function buildHeapProfile(doc, frames, o = {}) {
  const head = doc && (doc.head || (doc.profile && doc.profile.head));
  if (!head || typeof head !== 'object') throw new Error('This is not a V8 heap profile: there is no "head" node.');
  const b = new Builder({ label: o.label || 'Allocated memory (sampled)', unit: 'bytes', chrono: false });
  const stack = [];
  const work = [[head, 0]];
  while (work.length) {
    const [n, depth] = work.pop();
    stack.length = depth;
    const cf = n.callFrame || {};
    const rootLike = depth === 0 && isRootName(cf.functionName);
    let len = depth;
    if (!rootLike) { stack[depth] = v8Frame(frames, cf); len = depth + 1; }
    if (n.selfSize > 0) b.add(stack, len, Number(n.selfSize));
    const kids = Array.isArray(n.children) ? n.children : [];
    for (let k = kids.length - 1; k >= 0; k--) work.push([kids[k], len]);
  }
  if (!b.samples) throw new Error('This heap profile holds no allocations.');
  return b;
}

module.exports = { CpuProfileParts, buildCpuProfile, buildHeapProfile, v8Frame };
