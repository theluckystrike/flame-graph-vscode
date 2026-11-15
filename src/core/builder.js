'use strict';
// The one profile model every format turns into. A parser feeds stacks (root first, as frame ids) with a weight; the
// builder keeps
//  - the merged call tree (a trie: one node per distinct call path), for the left-heavy view and the function table,
//  - the time-order chart: consecutive samples that share a call path prefix share the bar, the way a timeline does.
// Both live in growable typed arrays, so memory grows with the number of distinct paths, not with the file size.
// finish() lays both out as flat arrays in pre-order (frame, depth, x, w), which is what the webview draws.

const KEY_SPAN = 4194304; // 2^22 frames at most: parent * KEY_SPAN + frame stays below 2^53
const MAX_TREE_NODES = 6000000;
const MAX_CHRONO_NODES = 3000000;

class Grow {
  constructor(T, n = 1024) { this.T = T; this.a = new T(n); this.length = 0; }
  push(v) { if (this.length === this.a.length) { const b = new this.T(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.length++] = v; return this.length - 1; }
  get(i) { return this.a[i]; }
  set(i, v) { this.a[i] = v; }
  add(i, v) { this.a[i] += v; }
  view() { return this.a.subarray(0, this.length); }
  copy() { return this.a.slice(0, this.length); }
}

/** Distinct functions of one file, shared by all its views. key separates same-named functions. */
class FrameTable {
  constructor() { this.names = []; this.files = []; this.lines = []; this.cols = []; this.map = new Map(); }
  id(name, file, line, col, key) {
    const nm = name || '(anonymous)';
    const fl = file || '';
    const k = key === undefined ? `${nm}\u0000${fl}` : `${nm}\u0000${fl}\u0000${key}`;
    let id = this.map.get(k);
    if (id === undefined) {
      id = this.names.length;
      if (id >= KEY_SPAN) throw new Error('This profile has more than 4 million distinct functions.');
      this.map.set(k, id);
      this.names.push(nm); this.files.push(fl); this.lines.push(line > 0 ? line | 0 : 0); this.cols.push(col > 0 ? col | 0 : 0);
    } else if (line > 0 && !this.lines[id]) { this.lines[id] = line | 0; this.cols[id] = col > 0 ? col | 0 : 0; }
    return id;
  }
  get size() { return this.names.length; }
  toJSON() { return { names: this.names, files: this.files, lines: this.lines }; }
}

class Builder {
  /** o: { label, unit, chrono (default true), chronoLabel } */
  constructor(o = {}) {
    this.label = o.label || 'Profile';
    this.unit = o.unit || 'samples';
    this.wantChrono = o.chrono !== false;
    this.chronoLabel = o.chronoLabel || 'Time order';
    this.parent = new Grow(Int32Array); this.frame = new Grow(Int32Array); this.depth = new Grow(Int32Array);
    this.self = new Grow(Float64Array); this.total = new Grow(Float64Array);
    this.parent.push(-1); this.frame.push(-1); this.depth.push(0); this.self.push(0); this.total.push(0);
    this.kids = new Map();
    this.samples = 0;
    this.chronoDropped = false;
    if (this.wantChrono) {
      this.cFrame = new Grow(Int32Array); this.cDepth = new Grow(Int32Array); this.cX = new Grow(Float64Array); this.cW = new Grow(Float64Array);
      this.open = []; this.openFrames = []; this.cursor = 0;
    }
  }
  /** stack: frame ids root first (array or typed array), len: how many of them, weight > 0. */
  add(stack, len, weight) {
    if (!(weight > 0) || !Number.isFinite(weight)) return;
    if (len === undefined) len = stack.length;
    this.samples++;
    let node = 0;
    this.total.a[0] += weight;
    for (let k = 0; k < len; k++) {
      const f = stack[k];
      const key = node * KEY_SPAN + f;
      let child = this.kids.get(key);
      if (child === undefined) {
        child = this.parent.push(node);
        if (child >= MAX_TREE_NODES) throw new Error('This profile has more than 6 million distinct call paths, too many to show.');
        this.frame.push(f); this.depth.push(k + 1); this.self.push(0); this.total.push(0);
        this.kids.set(key, child);
      }
      this.total.a[child] += weight;
      node = child;
    }
    this.self.a[node] += weight;
    if (this.wantChrono && !this.chronoDropped) this._chrono(stack, len, weight);
  }
  _chrono(stack, len, weight) {
    const open = this.open, of = this.openFrames;
    let k = 0;
    const m = Math.min(open.length, len);
    while (k < m && of[k] === stack[k]) k++;
    for (let j = open.length - 1; j >= k; j--) this.cW.a[open[j]] = this.cursor - this.cX.a[open[j]];
    open.length = k; of.length = k;
    for (let j = k; j < len; j++) {
      const id = this.cFrame.push(stack[j]);
      this.cDepth.push(j + 1); this.cX.push(this.cursor); this.cW.push(0);
      open.push(id); of.push(stack[j]);
    }
    this.cursor += weight;
    if (this.cFrame.length > MAX_CHRONO_NODES) this._dropChrono();
  }
  _dropChrono() {
    this.chronoDropped = true;
    this.cFrame = this.cDepth = this.cX = this.cW = null; this.open = []; this.openFrames = [];
  }

  /** Flat pre-order arrays for drawing and the function table. frames: the FrameTable (for the function count). */
  finish(frames) {
    const N = this.parent.length;
    const parent = this.parent.view(), frame = this.frame.view(), total = this.total.view(), self = this.self.view(), depthIn = this.depth.view();
    this.kids = null;
    // children lists by counting sort
    const count = new Int32Array(N + 1);
    for (let i = 1; i < N; i++) count[parent[i] + 1]++;
    for (let i = 1; i <= N; i++) count[i] += count[i - 1];
    const start = count.slice(0, N);
    const kids = new Int32Array(Math.max(0, N - 1));
    const fill = start.slice();
    for (let i = 1; i < N; i++) kids[fill[parent[i]]++] = i;
    // left heavy: heaviest child first; ties keep the order of appearance
    for (let p = 0; p < N; p++) {
      const a = start[p], b = p + 1 < N ? start[p + 1] : N - 1;
      if (b - a > 1) {
        const part = Array.from(kids.subarray(a, b));
        part.sort((u, v) => (total[v] - total[u]) || (u - v));
        kids.set(part, a);
      }
    }
    const end = (p) => (p + 1 < N ? start[p + 1] : N - 1);
    const oFrame = new Int32Array(N), oDepth = new Int32Array(N), oParent = new Int32Array(N);
    const oX = new Float64Array(N), oW = new Float64Array(N), oSelf = new Float64Array(N);
    const pos = new Int32Array(N); // node -> output index
    const stack = [0];
    const xs = new Float64Array(N);
    let out = 0;
    while (stack.length) {
      const nd = stack.pop();
      const o = out++;
      pos[nd] = o;
      oFrame[o] = frame[nd]; oDepth[o] = depthIn[nd]; oX[o] = xs[nd]; oW[o] = total[nd]; oSelf[o] = self[nd];
      oParent[o] = nd === 0 ? -1 : pos[parent[nd]];
      let x = xs[nd];
      const a = start[nd], b = end(nd);
      for (let k = a; k < b; k++) { xs[kids[k]] = x; x += total[kids[k]]; }
      for (let k = b - 1; k >= a; k--) stack.push(kids[k]);
    }
    // function table: self, and total counted once per call path (recursion is not counted twice)
    const F = frames ? frames.size : 0;
    let maxF = F;
    for (let i = 1; i < N; i++) if (oFrame[i] + 1 > maxF) maxF = oFrame[i] + 1;
    const fSelf = new Float64Array(maxF), fTotal = new Float64Array(maxF), onPath = new Int32Array(maxF);
    const path = [];
    for (let i = 1; i < N; i++) {
      while (path.length && oDepth[path[path.length - 1]] >= oDepth[i]) onPath[oFrame[path.pop()]]--;
      const f = oFrame[i];
      fSelf[f] += oSelf[i];
      if (onPath[f] === 0) fTotal[f] += oW[i];
      onPath[f]++;
      path.push(i);
    }
    const used = [];
    for (let f = 0; f < maxF; f++) if (fTotal[f] > 0 || fSelf[f] > 0) used.push(f);
    const fn = { frame: Int32Array.from(used), self: Float64Array.from(used, (f) => fSelf[f]), total: Float64Array.from(used, (f) => fTotal[f]) };
    let maxDepth = 0;
    for (let i = 0; i < N; i++) if (oDepth[i] > maxDepth) maxDepth = oDepth[i];

    let chrono = null;
    if (this.wantChrono && !this.chronoDropped && this.cFrame.length) {
      for (const id of this.open) this.cW.a[id] = this.cursor - this.cX.a[id];
      const M = this.cFrame.length + 1;
      const cf = new Int32Array(M), cd = new Int32Array(M), cx = new Float64Array(M), cw = new Float64Array(M);
      cf[0] = -1; cd[0] = 0; cx[0] = 0; cw[0] = this.cursor;
      cf.set(this.cFrame.view(), 1); cd.set(this.cDepth.view(), 1); cx.set(this.cX.view(), 1); cw.set(this.cW.view(), 1);
      chrono = { frame: cf, depth: cd, x: cx, w: cw };
    }
    const result = {
      label: this.label, unit: this.unit, total: total[0], samples: this.samples, maxDepth, nodes: N,
      merged: { frame: oFrame, depth: oDepth, parent: oParent, x: oX, w: oW, self: oSelf },
      chrono, chronoLabel: this.chronoLabel, chronoTooBig: !!this.chronoDropped, chronoAvailable: !!chrono,
      fn,
    };
    this.parent = this.frame = this.depth = this.self = this.total = null;
    this.cFrame = this.cDepth = this.cX = this.cW = null;
    return result;
  }
}

/** The typed arrays of a finished view, for postMessage transfer lists. */
function buffersOf(view) {
  const out = [];
  for (const part of [view.merged, view.chrono, view.fn]) if (part) for (const v of Object.values(part)) if (v && v.buffer) out.push(v.buffer);
  return out;
}

module.exports = { Builder, FrameTable, Grow, buffersOf, MAX_TREE_NODES, MAX_CHRONO_NODES };
