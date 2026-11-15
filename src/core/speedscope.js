'use strict';
// The speedscope file format (https://www.speedscope.app/file-format-schema.json), read with the streaming JSON
// reader: shared.frames, and profiles of type "sampled" (samples + weights, stacks root first) or "evented" (open and
// close events). The frames may come after the profiles in the file, so stacks are kept as frame indices until the end.
const { Builder, Grow } = require('./builder');
const { normUnit } = require('./units');

class SpeedscopeCollector {
  constructor() {
    this.frames = []; // { name, file, line, col }
    this.profiles = []; // per index
    this.name = '';
    this.active = -1;
    this.schema = '';
  }
  prof(i) {
    let p = this.profiles[i];
    if (!p) {
      p = { type: '', name: '', unit: '', startValue: 0, endValue: 0, flat: new Grow(Int32Array, 4096), offs: new Grow(Int32Array, 1024), weights: new Grow(Float64Array, 1024), evType: new Grow(Int32Array, 1024), evAt: new Grow(Float64Array, 1024), evFrame: new Grow(Int32Array, 1024) };
      this.profiles[i] = p;
    }
    return p;
  }
  static stream(path) { return path === 'shared.frames.#' || path === 'profiles.#.samples.#' || path === 'profiles.#.weights.#' || path === 'profiles.#.events.#'; }
  element(path, v, idx) {
    if (path === 'shared.frames.#') { this.frames[idx[0]] = v && typeof v === 'object' ? v : { name: String(v) }; return; }
    const p = this.prof(idx[0]);
    if (path === 'profiles.#.samples.#') {
      p.offs.push(p.flat.length);
      if (Array.isArray(v)) for (const f of v) p.flat.push(f | 0);
    } else if (path === 'profiles.#.weights.#') p.weights.push(Number(v) || 0);
    else if (path === 'profiles.#.events.#' && v && typeof v === 'object') {
      p.evType.push(v.type === 'O' ? 1 : v.type === 'C' ? 2 : 0); p.evAt.push(Number(v.at) || 0); p.evFrame.push(v.frame | 0);
    }
  }
  scalar(path, v, idx) {
    if (path === '$schema') this.schema = String(v);
    else if (path === 'name') this.name = String(v);
    else if (path === 'activeProfileIndex') this.active = v | 0;
    else if (/^profiles\.#\.(type|name|unit|startValue|endValue)$/.test(path)) this.prof(idx[0])[path.split('.')[2]] = v;
  }
  build(frameTable) {
    const fid = new Map();
    const frameId = (i) => {
      let id = fid.get(i);
      if (id === undefined) {
        const f = this.frames[i] || {};
        const line = Number(f.line) || 0, col = Number(f.col) || 0;
        id = frameTable.id(f.name || `frame ${i}`, f.file || '', line, col, f.file ? `${line}:${col}` : `#${i}`);
        fid.set(i, id);
      }
      return id;
    };
    const out = [];
    this.profiles.forEach((p, k) => {
      if (!p) return;
      const unit = normUnit(p.unit);
      const label = p.name ? String(p.name) : `Profile ${k + 1}`;
      const b = new Builder({ label, unit, chrono: true });
      const stack = [];
      if (p.type === 'evented' || (!p.offs.length && p.evType.length)) {
        const n = p.evType.length;
        const order = Array.from({ length: n }, (_, i) => i);
        const at = p.evAt.view(), ty = p.evType.view(), fr = p.evFrame.view();
        order.sort((a, b2) => (at[a] - at[b2]) || (a - b2));
        let t0 = n ? at[order[0]] : 0;
        for (const i of order) {
          const t = at[i];
          if (t > t0 && stack.length) b.add(stack, stack.length, t - t0);
          if (t > t0) t0 = t;
          const f = frameId(fr[i]);
          if (ty[i] === 1) stack.push(f);
          else if (ty[i] === 2) {
            let j = stack.length - 1;
            while (j >= 0 && stack[j] !== f) j--;
            if (j >= 0) stack.length = j;
          }
        }
      } else {
        const offs = p.offs.view(), flat = p.flat.view(), w = p.weights.view();
        const S = offs.length;
        for (let i = 0; i < S; i++) {
          const a = offs[i], z = i + 1 < S ? offs[i + 1] : flat.length;
          stack.length = 0;
          for (let j = a; j < z; j++) stack.push(frameId(flat[j]));
          b.add(stack, stack.length, i < w.length ? w[i] : 1);
        }
      }
      if (b.samples) out.push(b);
    });
    if (!out.length) throw new Error('This speedscope file holds no samples or events.');
    return out;
  }
}

module.exports = { SpeedscopeCollector };
