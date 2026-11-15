'use strict';
// Chrome trace event JSON: { "traceEvents": [...] } or a bare array, from Chrome DevTools (Performance > Save
// profile), chrome://tracing, Perfetto JSON export, Node --trace-events-enabled, and other tools. Two things become
// views:
//  - CPU profiles inside the trace (Profile + ProfileChunk events, or one CpuProfile event): the JavaScript flame graph.
//  - duration events per thread (B/E pairs and X complete events): a flame graph of the traced spans.
// Events are read one at a time by the streaming JSON reader. Duration events are kept as compact typed arrays and
// sorted per thread at the end.
const { Builder, Grow } = require('./builder');
const { CpuProfileParts, buildCpuProfile } = require('./v8');

const MAX_THREAD_VIEWS = 40;

class TraceCollector {
  constructor() {
    this.threads = new Map(); // "pid:tid" -> index
    this.threadKeys = [];
    this.threadNames = new Map();
    this.processNames = new Map();
    this.names = new Map(); this.nameList = [];
    this.tIdx = new Grow(Int32Array, 4096); this.ts = new Grow(Float64Array, 4096); this.dur = new Grow(Float64Array, 4096); this.nm = new Grow(Int32Array, 4096);
    this.profiles = new Map(); // id -> { parts, pid, tid }
    this.events = 0;
    this.skipped = 0;
    // the older "samples" + "stackFrames" form (Hermes, early Chrome): stack frame id -> { name, parent }
    this.stackFrames = new Map();
    this.sampleThreads = new Map(); // thread index -> { ts: Grow, sf: [] }
  }
  stackFrame(key, v) {
    if (!v || typeof v !== 'object') return;
    this.stackFrames.set(String(key), { name: String(v.name || '(unnamed)'), parent: v.parent === undefined ? null : String(v.parent), cat: v.category || '' });
  }
  sample(e) {
    if (!e || typeof e !== 'object' || e.sf === undefined) return;
    const t = this.thread(e.pid, e.tid);
    let st = this.sampleThreads.get(t);
    if (!st) { st = { ts: new Grow(Float64Array, 1024), sf: [], w: new Grow(Float64Array, 1024) }; this.sampleThreads.set(t, st); }
    st.ts.push(Number(e.ts) || 0); st.sf.push(String(e.sf)); st.w.push(Number(e.weight) || 1);
  }
  buildSamples(frames) {
    const out = [];
    const cache = new Map();
    const stackOf = (sf) => {
      let s = cache.get(sf);
      if (s) return s;
      const a = [];
      for (let k = sf, guard = 0; k !== null && k !== undefined && guard < 10000; guard++) {
        const f = this.stackFrames.get(k);
        if (!f) break;
        a.push(frames.id(f.name, '', 0, 0));
        k = f.parent;
      }
      s = a.reverse();
      cache.set(sf, s);
      return s;
    };
    for (const [t, st] of this.sampleThreads) {
      const n = st.ts.length;
      const ts = st.ts.view();
      const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (ts[a] - ts[b]) || (a - b));
      let sum = 0, cnt = 0;
      for (let k = 1; k < n; k++) { const d = ts[order[k]] - ts[order[k - 1]]; if (d > 0) { sum += d; cnt++; } }
      const avg = cnt ? sum / cnt : 1;
      const b = new Builder({ label: `CPU samples: ${this.threadLabel(t)}`, unit: 'microseconds', chrono: true });
      for (let k = 0; k < n; k++) {
        const i = order[k];
        const w = k + 1 < n ? ts[order[k + 1]] - ts[i] : avg;
        const s = stackOf(st.sf[i]);
        if (s.length && w > 0) b.add(s, s.length, w);
      }
      if (b.samples) out.push(b);
    }
    return out;
  }
  nameId(s) {
    const k = String(s === undefined || s === null ? '' : s);
    let id = this.names.get(k);
    if (id === undefined) { id = this.nameList.length; this.names.set(k, id); this.nameList.push(k); }
    return id;
  }
  thread(pid, tid) {
    const k = `${pid}:${tid}`;
    let i = this.threads.get(k);
    if (i === undefined) { i = this.threadKeys.length; this.threads.set(k, i); this.threadKeys.push([pid, tid]); }
    return i;
  }
  profile(id, pid, tid) {
    const k = String(id === undefined ? `${pid}:${tid}` : id);
    let p = this.profiles.get(k);
    if (!p) { p = { parts: new CpuProfileParts(), pid, tid }; this.profiles.set(k, p); }
    return p;
  }
  event(e) {
    if (!e || typeof e !== 'object') return;
    this.events++;
    const ph = e.ph;
    if (ph === 'M') {
      const nm = e.args && e.args.name;
      if (e.name === 'thread_name' && nm) this.threadNames.set(`${e.pid}:${e.tid}`, String(nm));
      else if (e.name === 'process_name' && nm) this.processNames.set(String(e.pid), String(nm));
      return;
    }
    const data = e.args && e.args.data;
    if (ph === 'P' || e.name === 'Profile' || e.name === 'ProfileChunk' || e.name === 'CpuProfile') {
      if (e.name === 'Profile' && data) { const p = this.profile(e.id, e.pid, e.tid); p.parts.startTime = Number(data.startTime) || p.parts.startTime; return; }
      if (e.name === 'ProfileChunk' && data) {
        const p = this.profile(e.id, e.pid, e.tid);
        const cp = data.cpuProfile || {};
        if (Array.isArray(cp.nodes)) for (const n of cp.nodes) p.parts.node(n);
        if (Array.isArray(cp.samples)) for (const s of cp.samples) p.parts.sample(s);
        const td = data.timeDeltas || cp.timeDeltas;
        if (Array.isArray(td)) for (const d of td) p.parts.delta(d);
        if (data.endTime) p.parts.endTime = Number(data.endTime);
        return;
      }
      if (e.name === 'CpuProfile' && data && data.cpuProfile) {
        const p = this.profile(`cpu-${e.pid}:${e.tid}:${this.profiles.size}`, e.pid, e.tid);
        const cp = data.cpuProfile;
        for (const n of cp.nodes || []) p.parts.node(n);
        for (const s of cp.samples || []) p.parts.sample(s);
        for (const d of cp.timeDeltas || []) p.parts.delta(d);
        p.parts.startTime = Number(cp.startTime) || 0; p.parts.endTime = Number(cp.endTime) || 0;
        return;
      }
      if (ph === 'P') return;
    }
    if (ph !== 'X' && ph !== 'B' && ph !== 'E') return;
    const ts = Number(e.ts);
    if (!Number.isFinite(ts)) { this.skipped++; return; }
    let d;
    if (ph === 'X') { d = Number(e.dur); if (!Number.isFinite(d) || d < 0) d = 0; } else d = ph === 'B' ? -1 : -2;
    this.tIdx.push(this.thread(e.pid, e.tid));
    this.ts.push(ts);
    this.dur.push(d);
    this.nm.push(ph === 'E' && (e.name === undefined || e.name === '') ? -1 : this.nameId(e.name));
  }
  threadLabel(i) {
    const [pid, tid] = this.threadKeys[i];
    const tn = this.threadNames.get(`${pid}:${tid}`);
    const pn = this.processNames.get(String(pid));
    return `${tn || `Thread ${tid}`}${pn ? ` in ${pn}` : ''} (pid ${pid}, tid ${tid})`;
  }
  /** Builders: CPU profiles first, then the busiest threads. */
  build(frames) {
    const out = this.sampleThreads.size ? this.buildSamples(frames) : [];
    for (const p of this.profiles.values()) {
      if (!p.parts.nodeCount) continue;
      const tn = this.threadNames.get(`${p.pid}:${p.tid}`);
      const label = `CPU profile: ${tn || `thread ${p.tid}`} (pid ${p.pid})`;
      try { out.push(buildCpuProfile(p.parts, frames, { label })); } catch (err) { /* a profile without samples is skipped */ }
    }
    const T = this.threadKeys.length;
    const n = this.ts.length;
    if (n) {
      const tIdx = this.tIdx.view(), ts = this.ts.view(), dur = this.dur.view(), nm = this.nm.view();
      const per = Array.from({ length: T }, () => []);
      for (let i = 0; i < n; i++) per[tIdx[i]].push(i);
      const frameOfName = new Int32Array(this.nameList.length).fill(-1);
      const fr = (id) => { if (frameOfName[id] < 0) frameOfName[id] = frames.id(this.nameList[id] || '(unnamed)', '', 0, 0); return frameOfName[id]; };
      const built = [];
      for (let t = 0; t < T; t++) {
        const idx = per[t];
        if (!idx.length) continue;
        idx.sort((a, b) => (ts[a] - ts[b]) || ((dur[a] >= 0 && dur[b] >= 0) ? dur[b] - dur[a] : 0) || (a - b));
        const b = new Builder({ label: `Trace events: ${this.threadLabel(t)}`, unit: 'microseconds', chrono: true });
        sweep(idx, ts, dur, nm, fr, b);
        if (b.samples) built.push(b);
        per[t] = null;
      }
      built.sort((a, b) => b.total.a[0] - a.total.a[0]);
      for (const b of built.slice(0, MAX_THREAD_VIEWS)) out.push(b);
      this.droppedThreads = Math.max(0, built.length - MAX_THREAD_VIEWS);
    }
    return out;
  }
}

/** Walks one thread's events in time order and adds every span between two event edges with the stack open then. */
function sweep(idx, ts, dur, nm, fr, b) {
  const sFrame = []; const sEnd = []; const sName = [];
  let t0 = idx.length ? ts[idx[0]] : 0;
  const emit = (t) => { if (t > t0 && sFrame.length) b.add(sFrame, sFrame.length, t - t0); if (t > t0) t0 = t; };
  const popEnded = (t) => {
    while (sFrame.length && sEnd[sEnd.length - 1] <= t) {
      emit(sEnd[sEnd.length - 1]);
      sFrame.pop(); sEnd.pop(); sName.pop();
    }
  };
  for (const i of idx) {
    const t = ts[i];
    popEnded(t);
    emit(t);
    const d = dur[i];
    if (d >= 0) {
      let end = t + d;
      if (sEnd.length && end > sEnd[sEnd.length - 1]) end = sEnd[sEnd.length - 1];
      sFrame.push(fr(nm[i])); sEnd.push(end); sName.push(nm[i]);
    } else if (d === -1) {
      sFrame.push(fr(nm[i])); sEnd.push(Infinity); sName.push(nm[i]);
    } else {
      // E: close the matching B (by name when it has one), and anything opened above it
      let k = sName.length - 1;
      if (nm[i] >= 0) while (k >= 0 && !(sEnd[k] === Infinity && sName[k] === nm[i])) k--;
      else while (k >= 0 && sEnd[k] !== Infinity) k--;
      if (k >= 0) { sFrame.length = k; sEnd.length = k; sName.length = k; }
    }
  }
  // close the remaining complete events; B without E end at the last edge
  while (sFrame.length && sEnd[sEnd.length - 1] !== Infinity) { emit(sEnd[sEnd.length - 1]); sFrame.pop(); sEnd.pop(); sName.pop(); }
}

module.exports = { TraceCollector, sweep };
