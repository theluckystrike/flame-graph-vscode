'use strict';
// Line-based formats, read line by line in 1 MB chunks:
//  - collapsed stacks ("folded"): "main;parse;read 42" per line, from stackcollapse scripts, py-spy, rbspy,
//    async-profiler (collapsed), cargo flamegraph, bpftrace and many more.
//  - Linux perf script output: a header line per sample, then one frame per line, leaf first, then an empty line.
const { Builder } = require('./builder');

/** Calls onLine(text) for every line of a file (path) or a buffer. UTF-16 files (with a BOM) are decoded first. */
function eachLine(fs, src, onLine) {
  const isPath = typeof src === 'string';
  const head = isPath ? readHead(fs, src, 4) : src.subarray(0, 4);
  if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) {
    let b = isPath ? fs.readFileSync(src) : Buffer.from(src);
    if (b[0] === 0xfe) { b = Buffer.from(b); b.swap16(); }
    const text = b.toString('utf16le').replace(/^﻿/, '');
    for (const l of text.split(/\r?\n/)) onLine(l);
    return;
  }
  let rest = '';
  const feed = (chunk, last) => {
    const s = rest + chunk;
    let a = 0;
    for (;;) {
      const nl = s.indexOf('\n', a);
      if (nl < 0) break;
      onLine(s.charCodeAt(nl - 1) === 13 ? s.slice(a, nl - 1) : s.slice(a, nl));
      a = nl + 1;
    }
    rest = s.slice(a);
    if (last && rest) { onLine(rest.replace(/\r$/, '')); rest = ''; }
  };
  const { StringDecoder } = require('string_decoder');
  const dec = new StringDecoder('utf8');
  let first = true;
  const strip = (t) => { if (first) { first = false; return t.replace(/^﻿/, ''); } return t; };
  if (isPath) {
    const fd = fs.openSync(src, 'r');
    const buf = Buffer.allocUnsafe(1 << 20);
    try {
      for (;;) {
        const got = fs.readSync(fd, buf, 0, buf.length, null);
        if (!got) break;
        feed(strip(dec.write(buf.subarray(0, got))), false);
      }
    } finally { fs.closeSync(fd); }
  } else {
    for (let i = 0; i < src.length; i += 1 << 20) feed(strip(dec.write(Buffer.from(src.buffer, src.byteOffset + i, Math.min(1 << 20, src.length - i)))), false);
  }
  feed(dec.end(), true);
}

function readHead(fs, file, n) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(n); const got = fs.readSync(fd, b, 0, n, 0); return b.subarray(0, got); } finally { fs.closeSync(fd); }
}

const FOLDED_RE = /^(.*\S)\s+(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;

/** Collapsed stacks. Returns { builder, lines, bad }. */
function buildFolded(fs, src, frames) {
  const b = new Builder({ label: 'Collapsed stacks', unit: 'samples', chrono: true, chronoLabel: 'File order' });
  let lines = 0, bad = 0;
  const ids = new Map();
  const stack = [];
  eachLine(fs, src, (line) => {
    if (!line || line.charCodeAt(0) === 35) return; // empty or "#" comment
    lines++;
    const m = FOLDED_RE.exec(line);
    if (!m) { bad++; return; }
    const w = Number(m[2]);
    if (!(w > 0)) return;
    const parts = m[1].split(';');
    stack.length = 0;
    for (const raw of parts) {
      const name = raw.trim();
      if (!name) continue;
      let id = ids.get(name);
      if (id === undefined) { id = frames.id(name, '', 0, 0); ids.set(name, id); }
      stack.push(id);
    }
    if (stack.length) b.add(stack, stack.length, w);
  });
  if (!b.samples) throw new Error(lines ? `None of the ${lines} lines is a collapsed stack ("frame;frame;frame count").` : 'This file is empty.');
  return { builder: b, lines, bad };
}

// perf script: "comm pid/tid [cpu] time: period event:" then "\t addr sym+off (dso)" lines, leaf first.
const PERF_HEAD = /^(\S(?:.*?\S)?)\s+(\d+)(?:\/(\d+))?\s+(?:\[\d+\]\s+)?(?:(\d+\.\d+):\s*)?/;
const PERF_FRAME = /^\s+([0-9a-fA-F]+)\s+(.+?)\s+\((.*)\)\s*$/;
const PERF_FRAME_NOADDR = /^\s+(\S.*?)\s+\((.*)\)\s*$/;

function cleanSym(sym, dso) {
  let s = sym.replace(/\+0x[0-9a-fA-F]+$/, '');
  if (s === '[unknown]' || !s) {
    const base = dso && dso !== '[unknown]' ? dso.split('/').pop() : '';
    s = base ? `[${base.replace(/^\[|\]$/g, '')}]` : '[unknown]';
  }
  return s;
}

/** perf script text. Returns { builder, samples, bad }. */
function buildPerf(fs, src, frames) {
  const b = new Builder({ label: 'perf samples', unit: 'samples', chrono: true });
  let inSample = false, comm = '', frs = [], samples = 0, headers = 0;
  const ids = new Map();
  const id = (name, file) => { const k = `${name}\u0000${file}`; let v = ids.get(k); if (v === undefined) { v = frames.id(name, file, 0, 0); ids.set(k, v); } return v; };
  const stack = [];
  const flush = () => {
    if (!inSample) return;
    inSample = false;
    stack.length = 0;
    stack.push(id(comm || '[unknown]', ''));
    for (let k = frs.length - 1; k >= 0; k--) stack.push(frs[k]);
    b.add(stack, stack.length, 1);
    samples++;
    frs = [];
  };
  eachLine(fs, src, (line) => {
    if (!line.trim()) { flush(); return; }
    const c = line.charCodeAt(0);
    if (c === 35) return; // "#" header
    if (c === 32 || c === 9) {
      if (!inSample) return;
      const m = PERF_FRAME.exec(line) || PERF_FRAME_NOADDR.exec(line);
      if (!m) return;
      const sym = m.length === 4 ? m[2] : m[1];
      const dso = m.length === 4 ? m[3] : m[2];
      frs.push(id(cleanSym(sym, dso), dso && dso !== '[unknown]' ? '' : ''));
      return;
    }
    flush();
    const h = PERF_HEAD.exec(line);
    if (!h) return;
    headers++;
    inSample = true;
    comm = h[1];
  });
  flush();
  if (!samples) throw new Error(headers ? 'This perf script output has sample headers but no stacks. Record with "perf record -g" to get call stacks.' : 'This is not perf script output: no sample header lines were found.');
  return { builder: b, samples };
}

module.exports = { eachLine, readHead, buildFolded, buildPerf, cleanSym };
