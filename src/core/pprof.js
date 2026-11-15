'use strict';
// pprof profiles (Go runtime/pprof and net/http/pprof, go test -cpuprofile, pprof-rs, async-profiler and others):
// a gzip-compressed protocol buffer of the message perftools.profiles.Profile. Decoded here from the wire format
// with our own reader; gzip is Node's zlib. One view per sample type (for example samples/count and cpu/nanoseconds,
// or the four heap types alloc_objects, alloc_space, inuse_objects and inuse_space).
const zlib = require('zlib');
const { Builder } = require('./builder');
const { normUnit } = require('./units');

const MAX_INFLATED = 768 * 1024 * 1024;

/** Minimal protobuf reader over a Uint8Array. */
class Reader {
  constructor(buf, start = 0, end = buf.length) { this.b = buf; this.p = start; this.end = end; }
  more() { return this.p < this.end; }
  varint() {
    const b = this.b;
    let x = 0, mul = 1, byte;
    do {
      if (this.p >= this.end) throw new Error('truncated varint');
      byte = b[this.p++];
      x += (byte & 0x7f) * mul;
      mul *= 128;
    } while (byte & 0x80 && mul < 2 ** 70);
    if (byte & 0x80) throw new Error('varint too long');
    return x;
  }
  /** int64 written as a varint: values of 2^63 and up are negative. */
  int64() { const v = this.varint(); return v >= 2 ** 63 ? v - 2 ** 64 : v; }
  tag() { const t = this.varint(); return [Math.floor(t / 8), t & 7]; }
  bytes() { const n = this.varint(); const s = this.p; this.p += n; if (this.p > this.end) throw new Error('truncated field'); return [s, this.p]; }
  skip(wt) {
    if (wt === 0) this.varint();
    else if (wt === 1) this.p += 8;
    else if (wt === 2) this.bytes();
    else if (wt === 5) this.p += 4;
    else throw new Error(`unsupported wire type ${wt}`);
    if (this.p > this.end) throw new Error('truncated field');
  }
  /** Repeated varint field: packed (wire type 2) or one value (wire type 0). */
  repeated(wt, out, signed) {
    if (wt === 2) { const [s, e] = this.bytes(); const r = new Reader(this.b, s, e); while (r.more()) out.push(signed ? r.int64() : r.varint()); } else if (wt === 0) out.push(signed ? this.int64() : this.varint());
    else this.skip(wt);
  }
}

const isGzip = (b) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

function inflate(bytes) {
  if (!isGzip(bytes)) return bytes;
  try {
    return zlib.gunzipSync(bytes, { maxOutputLength: MAX_INFLATED });
  } catch (e) {
    if (/maxOutputLength|buffer|Cannot create a Buffer/i.test(String(e && (e.code || e.message)))) throw new Error('This pprof file inflates to more than 768 MB, too large to open.');
    throw new Error(`The gzip data of this file is damaged (${e.code || e.message}).`);
  }
}

/** Decodes the Profile message. Returns tables and the byte ranges of the samples (decoded later, per view). */
function decode(buf) {
  const r = new Reader(buf);
  const strings = [];
  const sampleTypes = []; // [typeIdx, unitIdx]
  const sampleRanges = [];
  const locations = new Map(); // id -> [[functionId, line], ...] innermost first
  const functions = new Map(); // id -> { name, file, start }
  let defaultType = 0, periodType = null, period = 0, durationNanos = 0, timeNanos = 0;
  const vt = (s, e) => { const q = new Reader(buf, s, e); let t = 0, u = 0; while (q.more()) { const [f, w] = q.tag(); if (f === 1 && w === 0) t = q.varint(); else if (f === 2 && w === 0) u = q.varint(); else q.skip(w); } return [t, u]; };
  while (r.more()) {
    const [f, wt] = r.tag();
    if (wt !== 2) { if (f === 9 && wt === 0) timeNanos = r.int64(); else if (f === 10 && wt === 0) durationNanos = r.int64(); else if (f === 12 && wt === 0) period = r.int64(); else if (f === 14 && wt === 0) defaultType = r.varint(); else r.skip(wt); continue; }
    const [s, e] = r.bytes();
    if (f === 1) sampleTypes.push(vt(s, e));
    else if (f === 2) sampleRanges.push(s, e);
    else if (f === 4) {
      const q = new Reader(buf, s, e);
      let id = 0; const lines = [];
      while (q.more()) {
        const [lf, lw] = q.tag();
        if (lf === 1 && lw === 0) id = q.varint();
        else if (lf === 4 && lw === 2) {
          const [ls, le] = q.bytes(); const lr = new Reader(buf, ls, le);
          let fn = 0, line = 0;
          while (lr.more()) { const [xf, xw] = lr.tag(); if (xf === 1 && xw === 0) fn = lr.varint(); else if (xf === 2 && xw === 0) line = lr.int64(); else lr.skip(xw); }
          lines.push([fn, line]);
        } else q.skip(lw);
      }
      locations.set(id, lines);
    } else if (f === 5) {
      const q = new Reader(buf, s, e);
      let id = 0, name = 0, sys = 0, file = 0, start = 0;
      while (q.more()) { const [ff, fw] = q.tag(); if (fw !== 0) { q.skip(fw); continue; } const v = q.varint(); if (ff === 1) id = v; else if (ff === 2) name = v; else if (ff === 3) sys = v; else if (ff === 4) file = v; else if (ff === 5) start = v; }
      functions.set(id, { name, sys, file, start });
    } else if (f === 6) strings.push(buf.toString ? buf.toString('utf8', s, e) : Buffer.from(buf.buffer, buf.byteOffset + s, e - s).toString('utf8'));
    else if (f === 11) periodType = vt(s, e);
  }
  if (!strings.length || strings[0] !== '') throw new Error('This is not a pprof profile: its string table is missing.');
  if (!sampleTypes.length) throw new Error('This pprof profile lists no sample types.');
  const str = (i) => (i >= 0 && i < strings.length ? strings[i] : '');
  return {
    strings, str, sampleTypes: sampleTypes.map(([t, u]) => ({ type: str(t), unit: str(u) })), sampleRanges, locations, functions,
    defaultType: defaultType ? str(defaultType) : '', periodType: periodType ? { type: str(periodType[0]), unit: str(periodType[1]) } : null, period, durationNanos, timeNanos,
  };
}

/** Builders, one per sample type, filled in one pass over the samples. */
function buildPprof(bytes, frames) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p, data;
  try { data = inflate(buf); p = decode(data); } catch (e) {
    if (/^This /.test(e.message)) throw e;
    throw new Error(`This file is not a readable pprof profile (${e.message}).`);
  }
  const T = p.sampleTypes.length;
  const builders = p.sampleTypes.map((st) => new Builder({ label: `${st.type || 'value'}${st.unit ? ` (${st.unit})` : ''}`, unit: /objects/i.test(st.type) && /^count$/i.test(st.unit) ? 'objects' : normUnit(st.unit), chrono: false }));
  const fnFrame = new Map();
  const frameOfFn = (fid, line) => {
    let id = fnFrame.get(fid);
    if (id === undefined) {
      const fn = p.functions.get(fid);
      const name = fn ? (p.str(fn.name) || p.str(fn.sys)) : '';
      const file = fn ? p.str(fn.file) : '';
      id = frames.id(name || `function ${fid}`, file, fn && fn.start > 0 ? fn.start : line, 0, fn && fn.start > 0 ? String(fn.start) : undefined);
      fnFrame.set(fid, id);
    }
    return id;
  };
  // the frames of one location, root first (a location lists inlined functions innermost first)
  const locFrames = new Map();
  const framesOfLoc = (lid) => {
    let a = locFrames.get(lid);
    if (!a) {
      const lines = p.locations.get(lid);
      if (!lines || !lines.length) a = [frames.id(`0x${Number(lid).toString(16)}`, '', 0, 0)];
      else { a = []; for (let k = lines.length - 1; k >= 0; k--) a.push(frameOfFn(lines[k][0], lines[k][1])); }
      locFrames.set(lid, a);
    }
    return a;
  };
  const R = p.sampleRanges;
  const locs = [], vals = [];
  let stack = new Int32Array(1024);
  for (let i = 0; i < R.length; i += 2) {
    const q = new Reader(data, R[i], R[i + 1]);
    locs.length = 0; vals.length = 0;
    while (q.more()) {
      const [f, w] = q.tag();
      if (f === 1) q.repeated(w, locs, false);
      else if (f === 2) q.repeated(w, vals, true);
      else q.skip(w);
    }
    let len = 0;
    for (let k = locs.length - 1; k >= 0; k--) {
      const fr = framesOfLoc(locs[k]);
      if (len + fr.length > stack.length) { const nb = new Int32Array((len + fr.length) * 2); nb.set(stack); stack = nb; }
      for (const x of fr) stack[len++] = x;
    }
    for (let t = 0; t < T && t < vals.length; t++) if (vals[t] > 0) builders[t].add(stack, len, vals[t]);
  }
  if (!R.length) throw new Error('This pprof profile holds no samples.');
  // the default view: default_sample_type, else the last type (Go puts cpu/nanoseconds and inuse_space last)
  let def = T - 1;
  if (p.defaultType) { const k = p.sampleTypes.findIndex((st) => st.type === p.defaultType); if (k >= 0) def = k; }
  const meta = { sampleTypes: p.sampleTypes, period: p.period, periodType: p.periodType, durationNanos: p.durationNanos, timeNanos: p.timeNanos, defaultIndex: def, functions: p.functions.size, locations: p.locations.size, samples: R.length / 2 };
  return { builders, meta };
}

module.exports = { Reader, decode, inflate, isGzip, buildPprof };
