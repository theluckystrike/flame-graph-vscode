'use strict';
// Core tests: the streaming JSON reader, the profile model, every format reader against real and hand-built files,
// the format sniffing, the worker, and the Pro report functions. Expected pprof numbers come from `go tool pprof -top`
// on the same files (Go 1.27.3).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createJsonStream, scanBytes } = require('../src/core/jsonstream');
const { Builder, FrameTable } = require('../src/core/builder');
const { loadProfile, sniff, formatFromName } = require('../src/core/load');
const { parseProfile } = require('../src/core/parse');
const R = require('../src/core/report');
const U = require('../src/core/units');

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');
const FIX = path.join(__dirname, 'fixtures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flame-core-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const buf = (s) => Buffer.from(s, 'utf8');
const load = (text, name) => loadProfile(Buffer.isBuffer(text) ? text : buf(text), name);
const fnRow = (view, frames, name) => { const i = Array.from(view.fn.frame).findIndex((f) => frames.names[f] === name); return i < 0 ? null : { self: view.fn.self[i], total: view.fn.total[i] }; };

// ---------- streaming JSON ----------
function collect(text, stream, chunk) {
  const els = [], sc = [];
  const s = createJsonStream({ stream: (p) => stream.includes(p), onElement: (p, v, idx) => els.push([p, v, idx]), onScalar: (p, v, idx) => sc.push([p, v, idx]) });
  const r = scanBytes(buf(text), s, chunk);
  return { els, sc, r };
}
test('json stream: elements of stream paths are parsed one by one, other scalars come with their path', () => {
  const t = '{"traceEvents":[{"a":1,"s":"x}\\"]"},{"b":[1,2,{"c":"\\u00e9"}]}],"meta":{"n":3,"ok":true,"z":null},"list":[5,"w"]}';
  for (const chunk of [1, 2, 3, 7, 1 << 20]) {
    const { els, sc, r } = collect(t, ['traceEvents.#'], chunk);
    assert.equal(r.complete, true);
    assert.deepEqual(els.map((e) => e[1]), [{ a: 1, s: 'x}"]' }, { b: [1, 2, { c: 'é' }] }]);
    assert.deepEqual(els.map((e) => e[2]), [[0], [1]]);
    assert.deepEqual(sc.map((e) => [e[0], e[1]]), [['meta.n', 3], ['meta.ok', true], ['meta.z', null], ['list.#', 5], ['list.#', 'w']]);
  }
});
test('json stream: number arrays, a root array, nested indices, a BOM and a trailing comma', () => {
  let r = collect('﻿[1, -2.5e3 ,3]', ['#'], 2);
  assert.deepEqual(r.els.map((e) => e[1]), [1, -2500, 3]);
  r = collect('{"profiles":[{"samples":[[0,1],[0]]},{"samples":[[2]]}]}', ['profiles.#.samples.#'], 3);
  assert.deepEqual(r.els.map((e) => [e[1], e[2]]), [[[0, 1], [0, 0]], [[0], [0, 1]], [[2], [1, 0]]]);
  r = collect('[{"a":1},{"a":2},]', ['#'], 4);
  assert.equal(r.els.length, 2);
  assert.equal(r.r.complete, true);
});
test('json stream: a file cut off in the middle keeps every whole element and reports it as incomplete', () => {
  const r = collect('{"traceEvents":[{"a":1},{"a":2},{"a":', ['traceEvents.#'], 5);
  assert.deepEqual(r.els.map((e) => e[1]), [{ a: 1 }, { a: 2 }]);
  assert.equal(r.r.complete, false);
});
test('json stream: broken JSON throws a plain message', () => {
  assert.throws(() => collect('{"a" 1}', [], 3), /Not valid JSON/);
  assert.throws(() => collect('[1, 2] x', ['#'], 3) && collect('{"a":1,]', [], 2), /Not valid JSON/);
});

// ---------- the model ----------
test('builder: merged tree, left heavy order, x layout, self and recursion-safe totals', () => {
  const frames = new FrameTable();
  const [a, b, c] = ['a', 'b', 'c'].map((n) => frames.id(n));
  const bl = new Builder({ unit: 'samples' });
  bl.add([a, b], 2, 1);
  bl.add([a, c], 2, 3);
  bl.add([a, b, a], 3, 2); // recursion: a calls b calls a
  bl.add([a], 1, 1);
  const v = bl.finish(frames);
  assert.equal(v.total, 7);
  const m = v.merged;
  const label = (i) => (m.frame[i] < 0 ? 'all' : frames.names[m.frame[i]]);
  assert.deepEqual(Array.from(m.frame, (_, i) => `${label(i)}@${m.depth[i]}:${m.x[i]}+${m.w[i]}`), ['all@0:0+7', 'a@1:0+7', 'b@2:0+3', 'a@3:0+2', 'c@2:3+3']);
  assert.deepEqual(Array.from(m.self), [0, 1, 1, 2, 3]);
  assert.deepEqual(Array.from(m.parent), [-1, 0, 1, 2, 1]);
  // a's total is 7, not 9: the recursive a under b is part of the same time
  assert.deepEqual(fnRow(v, frames, 'a'), { self: 3, total: 7 });
  assert.deepEqual(fnRow(v, frames, 'b'), { self: 1, total: 3 });
});
test('builder: time order merges consecutive samples that share a path, and splits when the path changes', () => {
  const frames = new FrameTable();
  const [a, b, c] = ['a', 'b', 'c'].map((n) => frames.id(n));
  const bl = new Builder({});
  bl.add([a, b], 2, 1); bl.add([a, b], 2, 1); bl.add([a, c], 2, 1); bl.add([a, b], 2, 1); bl.add([c], 1, 2); bl.add([a], 1, 0);
  const v = bl.finish(frames);
  const ch = v.chrono;
  const label = (i) => (ch.frame[i] < 0 ? 'all' : frames.names[ch.frame[i]]);
  assert.deepEqual(Array.from(ch.frame, (_, i) => `${label(i)}@${ch.depth[i]}:${ch.x[i]}+${ch.w[i]}`), ['all@0:0+6', 'a@1:0+4', 'b@2:0+2', 'c@2:2+1', 'b@2:3+1', 'c@1:4+2']);
  assert.equal(v.samples, 5, 'a zero weight sample is not counted');
});

// ---------- V8 ----------
test('cpuprofile (Node --cpu-prof of samples/sample-app.js): time per function, 1-based lines, time order', () => {
  const r = loadProfile(path.join(SAMPLES, 'sample-app.cpuprofile'), 'sample-app.cpuprofile');
  assert.equal(r.format, 'cpuprofile');
  const v = r.views[0];
  const doc = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'sample-app.cpuprofile'), 'utf8'));
  // every sample but the last lasts until the next one; the total stays within one interval of endTime - startTime
  assert.ok(Math.abs(v.total - (doc.endTime - doc.startTime)) < 0.01 * (doc.endTime - doc.startTime), `${v.total} vs ${doc.endTime - doc.startTime}`);
  assert.equal(v.samples, doc.samples.length);
  const fid = r.frames.names.indexOf('roundTrip');
  assert.ok(fid >= 0);
  assert.equal(r.frames.files[fid], 'file:///home/dev/order-report/sample-app.js');
  const src = fs.readFileSync(path.join(SAMPLES, 'sample-app.js'), 'utf8').split('\n');
  assert.match(src[r.frames.lines[fid] - 1], /function roundTrip/);
  const top = R.hotspots(v, r.frames, 3).map((h) => h.name);
  assert.ok(top.includes('roundTrip'), top.join());
  assert.ok(v.chrono && v.chrono.frame.length > v.merged.frame.length);
  assert.equal(v.chrono.w[0], v.total);
});
test('cpuprofile in the older form (a head tree with samples and timestamps)', () => {
  const doc = { head: { functionName: '(root)', url: '', lineNumber: 0, id: 1, hitCount: 0, children: [{ functionName: 'main', url: '/x/app.js', lineNumber: 3, id: 2, hitCount: 1, children: [{ functionName: 'hot', url: '/x/app.js', lineNumber: 9, id: 3, hitCount: 2, children: [] }] }] }, startTime: 1, endTime: 1.004, samples: [2, 3, 3], timestamps: [1000000, 1001000, 1002000] };
  const r = load(JSON.stringify(doc), 'old.cpuprofile');
  const v = r.views[0];
  assert.deepEqual(fnRow(v, r.frames, 'hot'), { self: 2000, total: 2000 });
  assert.deepEqual(fnRow(v, r.frames, 'main'), { self: 1000, total: 3000 });
  assert.equal(r.frames.lines[r.frames.names.indexOf('hot')], 10);
});
test('cpuprofile without samples falls back to hit counts', () => {
  const doc = { nodes: [{ id: 1, callFrame: { functionName: '(root)' }, children: [2] }, { id: 2, callFrame: { functionName: 'f', url: 'a.js', lineNumber: 0, columnNumber: 0 }, hitCount: 4 }], startTime: 0, endTime: 400 };
  const r = load(JSON.stringify(doc), 'h.cpuprofile');
  assert.equal(r.views[0].total, 400);
  assert.equal(r.views[0].chrono, null);
});
test('heapprofile (Node --heap-prof): bytes per allocation site add up to the sum of selfSize', () => {
  const file = path.join(FIX, 'sample-app.heapprofile');
  const r = loadProfile(file, 'sample-app.heapprofile');
  assert.equal(r.format, 'heapprofile');
  let sum = 0;
  const walk = (n) => { sum += n.selfSize; for (const k of n.children || []) walk(k); };
  walk(JSON.parse(fs.readFileSync(file, 'utf8')).head);
  const v = r.views[0];
  assert.equal(v.unit, 'bytes');
  assert.equal(v.total, sum);
  assert.equal(v.chrono, null);
  assert.ok(fnRow(v, r.frames, 'fingerprint').total > 0);
});

// ---------- Chrome trace ----------
test('trace: B/E and X events become a flame graph per thread; unsorted X events are sorted; E without a name closes the last B', () => {
  const ev = [
    { ph: 'M', name: 'thread_name', pid: 1, tid: 7, args: { name: 'Main' } },
    { ph: 'X', name: 'child', pid: 1, tid: 7, ts: 20, dur: 30 },
    { ph: 'X', name: 'task', pid: 1, tid: 7, ts: 0, dur: 100 },
    { ph: 'B', name: 'outer', pid: 1, tid: 8, ts: 0 }, { ph: 'B', name: 'inner', pid: 1, tid: 8, ts: 10 }, { ph: 'E', pid: 1, tid: 8, ts: 15 }, { ph: 'E', name: 'outer', pid: 1, tid: 8, ts: 40 },
    { ph: 'I', name: 'mark', pid: 1, tid: 7, ts: 5 },
  ];
  const r = load(JSON.stringify({ traceEvents: ev }), 'x.json');
  assert.equal(r.format, 'trace');
  assert.deepEqual(r.views.map((v) => v.label), ['Trace events: Main (pid 1, tid 7)', 'Trace events: Thread 8 (pid 1, tid 8)']);
  const [t7, t8] = r.views;
  assert.equal(t7.total, 100);
  assert.deepEqual(fnRow(t7, r.frames, 'task'), { self: 70, total: 100 });
  assert.deepEqual(fnRow(t7, r.frames, 'child'), { self: 30, total: 30 });
  assert.equal(t8.total, 40);
  assert.deepEqual(fnRow(t8, r.frames, 'inner'), { self: 5, total: 5 });
  assert.deepEqual(fnRow(t8, r.frames, 'outer'), { self: 35, total: 40 });
  assert.equal(t7.unit, 'microseconds');
});
test('trace: CPU profile chunks (Chrome Performance panel) come first as a view; a bare event array works too', () => {
  const nodes = [{ id: 1, callFrame: { functionName: '(root)', url: '' } }, { id: 2, parent: 1, callFrame: { functionName: 'render', url: 'https://app.example/app.js', lineNumber: 4, columnNumber: 2 } }, { id: 3, parent: 2, callFrame: { functionName: 'layout', url: 'https://app.example/app.js', lineNumber: 40, columnNumber: 0 } }];
  const ev = [
    { ph: 'P', name: 'Profile', id: '0x1', pid: 5, tid: 9, ts: 0, args: { data: { startTime: 0 } } },
    { ph: 'P', name: 'ProfileChunk', id: '0x1', pid: 5, tid: 9, ts: 1, args: { data: { cpuProfile: { nodes, samples: [2, 3] }, timeDeltas: [0, 100] } } },
    { ph: 'P', name: 'ProfileChunk', id: '0x1', pid: 5, tid: 9, ts: 2, args: { data: { cpuProfile: { samples: [3, 2] }, timeDeltas: [100, 50] } } },
    { ph: 'X', name: 'RunTask', pid: 5, tid: 9, ts: 0, dur: 10 },
  ];
  const r = load(JSON.stringify(ev), 'Trace-1.json');
  assert.equal(r.views[0].label, 'CPU profile: thread 9 (pid 5)');
  const v = r.views[0];
  // a sample lasts until the next one: layout gets 100 + 50
  assert.deepEqual(fnRow(v, r.frames, 'layout'), { self: 150, total: 150 });
  assert.equal(r.frames.lines[r.frames.names.indexOf('layout')], 41);
  assert.equal(r.views[1].label, 'Trace events: Thread 9 (pid 5, tid 9)');
});
test('trace: the samples + stackFrames form (Hermes) gives one view per thread', () => {
  const doc = { traceEvents: [], stackFrames: { 1: { name: 'main' }, 2: { name: 'work', parent: 1 } }, samples: [{ pid: 1, tid: 1, ts: 0, sf: 2 }, { pid: 1, tid: 1, ts: 10, sf: 1 }, { pid: 1, tid: 1, ts: 30, sf: 2 }] };
  const r = load(JSON.stringify(doc), 'h.json');
  const v = r.views[0];
  assert.match(v.label, /^CPU samples:/);
  assert.deepEqual(fnRow(v, r.frames, 'work'), { self: 10 + 15, total: 25 });
  assert.equal(v.total, 45);
});
test('trace: a trace cut off while it was written opens with a note', () => {
  const r = load('{"traceEvents":[{"ph":"X","name":"a","pid":1,"tid":1,"ts":0,"dur":5},{"ph":"X","name":"b","pid":1,"tid":1,"ts":1,"dur":2},{"ph":"B","na', 'p.json');
  assert.equal(r.views[0].total, 5);
  assert.match(r.warnings.join(), /ends early/);
});

// ---------- pprof ----------
test('pprof (Go runtime/pprof CPU profile, samples/sample-go-cpu.pb.gz): numbers equal go tool pprof -top', () => {
  const r = loadProfile(path.join(SAMPLES, 'sample-go-cpu.pb.gz'), 'sample-go-cpu.pb.gz');
  assert.equal(r.format, 'pprof');
  assert.deepEqual(r.views.map((v) => v.label), ['samples (count)', 'cpu (nanoseconds)']);
  const v = r.views[r.defaultView];
  assert.equal(v.label, 'cpu (nanoseconds)');
  assert.equal(v.total, 1520000000);
  assert.equal(new Set(Array.from(v.fn.frame)).size, 194); // "Showing top 6 nodes out of 194"
  const top = R.hotspots(v, r.frames, 6);
  assert.deepEqual(top.slice(0, 3).map((h) => [h.name, h.self, h.total]), [['runtime.madvise', 90000000, 90000000], ['runtime.memmove', 80000000, 80000000], ['encoding/json/jsontext.(*decoderState).ReadValue', 70000000, 150000000]]);
  assert.deepEqual(fnRow(v, r.frames, 'encoding/json/v2.makeStructArshaler.func2'), { self: 60000000, total: 270000000 });
  assert.equal(r.views[0].total, 152);
  const mk = r.frames.names.indexOf('main.makeItems');
  assert.equal(r.frames.files[mk], 'sample-go/main.go');
  assert.match(fs.readFileSync(path.join(SAMPLES, 'sample-go', 'main.go'), 'utf8').split('\n')[r.frames.lines[mk] - 1], /^func makeItems/);
});
test('pprof (Go heap profile): four sample types, inuse_space by default, values equal go tool pprof', () => {
  const r = loadProfile(path.join(FIX, 'go-heap.pb.gz'), 'heap.pb.gz');
  assert.deepEqual(r.views.map((v) => [v.label, v.unit]), [['alloc_objects (count)', 'objects'], ['alloc_space (bytes)', 'bytes'], ['inuse_objects (count)', 'objects'], ['inuse_space (bytes)', 'bytes']]);
  assert.equal(r.views[r.defaultView].label, 'inuse_space (bytes)');
  const alloc = r.views[1];
  assert.equal(alloc.total, 1417265658);
  assert.deepEqual(fnRow(alloc, r.frames, 'reflect.growslice'), { self: 618822478, total: 618822478 });
  assert.deepEqual(fnRow(alloc, r.frames, 'main.makeItems'), { self: 154636500, total: 196580180 });
  assert.equal(r.views[3].total, 121456752);
  assert.deepEqual(fnRow(r.views[3], r.frames, 'bytes.Clone'), { self: 114852220, total: 114852220 });
});

// A tiny protobuf writer for hand-built pprof files.
const varint = (n) => { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n); return Buffer.from(out); };
const key = (f, wt) => varint(f * 8 + wt);
const fld = (f, v) => Buffer.concat([key(f, 0), varint(v)]);
const msg = (f, b) => Buffer.concat([key(f, 2), varint(b.length), b]);
const str = (f, s) => msg(f, Buffer.from(s, 'utf8'));
const packed = (f, arr) => msg(f, Buffer.concat(arr.map(varint)));
function handPprof({ unpacked, defaultType } = {}) {
  const S = ['', 'samples', 'count', 'cpu', 'nanoseconds', 'main', 'app/main.go', 'work', 'helper', 'inlined'];
  const parts = [];
  parts.push(msg(1, Buffer.concat([fld(1, 1), fld(2, 2)])), msg(1, Buffer.concat([fld(1, 3), fld(2, 4)])));
  parts.push(msg(2, Buffer.concat([packed(1, [3, 2, 1]), packed(2, [2, 20000000])])));
  parts.push(msg(2, unpacked ? Buffer.concat([fld(1, 2), fld(1, 1), fld(2, 1), fld(2, 10000000)]) : Buffer.concat([packed(1, [2, 1]), packed(2, [1, 10000000])])));
  parts.push(msg(4, Buffer.concat([fld(1, 1), msg(4, Buffer.concat([fld(1, 1), fld(2, 12)]))])));
  parts.push(msg(4, Buffer.concat([fld(1, 2), msg(4, Buffer.concat([fld(1, 2), fld(2, 21)]))])));
  parts.push(msg(4, Buffer.concat([fld(1, 3), msg(4, Buffer.concat([fld(1, 4), fld(2, 41)])), msg(4, Buffer.concat([fld(1, 3), fld(2, 31)]))])));
  [[1, 5, 10], [2, 7, 20], [3, 8, 30], [4, 9, 40]].forEach(([id, name, start]) => parts.push(msg(5, Buffer.concat([fld(1, id), fld(2, name), fld(4, 6), fld(5, start)]))));
  for (const s of S) parts.push(str(6, s));
  if (defaultType) parts.push(fld(14, defaultType));
  return Buffer.concat(parts);
}
test('pprof (hand-built): inlined frames, packed and unpacked fields, raw and gzip, default_sample_type', () => {
  for (const [bytes, name] of [[handPprof(), 'a.pprof'], [zlib.gzipSync(handPprof({ unpacked: true })), 'b.pb.gz']]) {
    const r = load(bytes, name);
    const v = r.views[r.defaultView];
    assert.equal(v.label, 'cpu (nanoseconds)');
    assert.equal(v.total, 30000000);
    assert.deepEqual(fnRow(v, r.frames, 'inlined'), { self: 20000000, total: 20000000 });
    assert.deepEqual(fnRow(v, r.frames, 'helper'), { self: 0, total: 20000000 });
    assert.deepEqual(fnRow(v, r.frames, 'work'), { self: 10000000, total: 30000000 });
    const m = v.merged;
    const path0 = []; for (let i = 0; i < m.frame.length; i++) path0.push(`${m.depth[i]}:${m.frame[i] < 0 ? 'all' : r.frames.names[m.frame[i]]}`);
    assert.deepEqual(path0, ['0:all', '1:main', '2:work', '3:helper', '4:inlined']);
    assert.equal(r.frames.lines[r.frames.names.indexOf('helper')], 30);
  }
  const r = load(handPprof({ defaultType: 1 }), 'c.pprof');
  assert.equal(r.views[r.defaultView].label, 'samples (count)');
});
test('pprof: a damaged gzip file and a binary that is no profile give plain messages', () => {
  const gz = zlib.gzipSync(handPprof());
  assert.throws(() => load(gz.subarray(0, gz.length - 30), 'cut.pb.gz'), /gzip data of this file is damaged|not a readable pprof/);
  assert.throws(() => load(Buffer.from([0x0a, 0xff, 0xff, 0xff, 0x0f, 0, 1, 2, 0, 0, 0]), 'x.pprof'), /pprof/);
  assert.throws(() => load(Buffer.from([0x7b, 0, 0, 0, 0xe3, 0, 0, 0, 0, 0, 0, 0x29]), 'py.prof'), /Python cProfile/);
});

// ---------- text formats ----------
test('collapsed stacks: weights, comments, CRLF, bad lines counted, UTF-16 with a BOM', () => {
  const text = '# made by hand\r\nmain;parse;read 3\r\nmain;parse 2\r\nmain;render;paint 5\r\nnot a stack line\r\nmain;parse;read 1\r\n';
  const r = load(text, 'app.folded');
  const v = r.views[0];
  assert.equal(v.total, 11);
  assert.deepEqual(fnRow(v, r.frames, 'read'), { self: 4, total: 4 });
  assert.deepEqual(fnRow(v, r.frames, 'parse'), { self: 2, total: 6 });
  assert.match(r.warnings.join(), /1 lines are not/);
  assert.equal(v.chronoLabel, 'File order');
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a;b 2\na;c 1\n', 'utf16le')]);
  const r2 = load(u16, 'w.collapsed');
  assert.equal(r2.views[0].total, 3);
  assert.throws(() => load('hello world\n', 'x.folded'), /None of the 1 lines/);
});
test('perf script: process name at the root, leaf-first frames reversed, offsets stripped, unknown symbols named by their library', () => {
  const text = [
    '# ========', '# captured on: today', '# ========',
    'my app 1234/1234 [002] 100.000001: 250000 cpu-clock:',
    '\t     55f1 compute+0x1a (/usr/bin/app)',
    '\t     55e0 main+0x10 (/usr/bin/app)',
    '\t   7f0001 __libc_start_main+0xf3 (/usr/lib/libc.so.6)',
    '',
    'my app 1234/1234 [002] 100.000101: 250000 cpu-clock:',
    '\t     9999 [unknown] (/usr/lib/libz.so.1)',
    '\t     55e0 main+0x10 (/usr/bin/app)',
    '\t   7f0001 __libc_start_main+0xf3 (/usr/lib/libc.so.6)',
    '',
    'kworker/0:1 77 [000] 100.000200: 1 cpu-clock:',
    '\tffffffff81000000 worker_thread ([kernel.kallsyms])',
    '',
  ].join('\n');
  const r = load(text, 'out.perf');
  assert.equal(r.format, 'perf');
  const v = r.views[0];
  assert.equal(v.total, 3);
  const m = v.merged, names = (i) => (m.frame[i] < 0 ? 'all' : r.frames.names[m.frame[i]]);
  assert.deepEqual(Array.from(m.frame, (_, i) => `${m.depth[i]}:${names(i)}`), ['0:all', '1:my app', '2:__libc_start_main', '3:main', '4:compute', '4:[libz.so.1]', '1:kworker/0:1', '2:worker_thread']);
  assert.throws(() => load('# just a header\n', 'x.perf'), /not perf script output/);
});
test('speedscope: sampled and evented profiles, frames listed after the profiles, the active profile first', () => {
  const doc = {
    $schema: 'https://www.speedscope.app/file-format-schema.json', activeProfileIndex: 1, name: 'demo',
    profiles: [
      { type: 'sampled', name: 'one', unit: 'milliseconds', startValue: 0, endValue: 10, samples: [[0, 1], [0, 1], [0, 2], [0]], weights: [1, 2, 3, 4] },
      { type: 'evented', name: 'two', unit: 'microseconds', startValue: 0, endValue: 9, events: [{ type: 'O', frame: 0, at: 0 }, { type: 'O', frame: 2, at: 2 }, { type: 'C', frame: 2, at: 5 }, { type: 'C', frame: 0, at: 9 }] },
    ],
    shared: { frames: [{ name: 'main', file: 'src/main.ts', line: 3, col: 1 }, { name: 'parse' }, { name: 'render', file: 'src/render.ts', line: 12 }] },
  };
  const r = load(JSON.stringify(doc), 'x.speedscope.json');
  assert.equal(r.format, 'speedscope');
  assert.deepEqual(r.views.map((v) => [v.label, v.unit, v.total]), [['one', 'milliseconds', 10], ['two', 'microseconds', 9]]);
  assert.equal(r.defaultView, 1);
  assert.deepEqual(fnRow(r.views[0], r.frames, 'parse'), { self: 3, total: 3 });
  assert.deepEqual(fnRow(r.views[1], r.frames, 'render'), { self: 3, total: 3 });
  assert.deepEqual(fnRow(r.views[1], r.frames, 'main'), { self: 6, total: 9 });
  assert.equal(r.frames.files[r.frames.names.indexOf('render')], 'src/render.ts');
  assert.equal(r.frames.lines[r.frames.names.indexOf('render')], 12);
});

// ---------- format detection ----------
test('format: from the name, else from the first bytes; unknown files get a plain message', () => {
  assert.equal(formatFromName('cpu.pb.gz'), 'pprof');
  assert.equal(formatFromName('x.speedscope.json'), 'speedscope');
  assert.equal(formatFromName('a.collapsed'), 'folded');
  assert.equal(formatFromName('trace.json'), '');
  assert.equal(sniff(buf('{"nodes":[{"id":1,"callFrame":{}}],"samples":[]}')).format, 'cpuprofile');
  assert.equal(sniff(buf('[{"ph":"X"}]')).format, 'trace');
  assert.equal(sniff(buf('{"head":{"callFrame":{},"selfSize":0}}')).format, 'heapprofile');
  assert.equal(sniff(zlib.gzipSync(handPprof())).format, 'pprof');
  assert.equal(sniff(buf('a;b;c 12\n')).format, 'folded');
  assert.throws(() => load('{"name":"my-package","version":"1.0.0"}', 'package.json'), /not a profile the viewer knows/);
  assert.throws(() => load('', 'empty.folded'), /empty/);
  // a .prof that is really text with stacks reads as collapsed stacks
  assert.equal(load('main;run 5\n', 'cpu.prof').format, 'folded');
});

// ---------- worker ----------
test('worker: parses in a thread, hands back typed arrays; a broken file and the size limit give messages', async () => {
  const r = await parseProfile({ file: path.join(SAMPLES, 'sample-go-cpu.pb.gz'), name: 'sample-go-cpu.pb.gz' });
  assert.ok(r.views[1].merged.x instanceof Float64Array);
  assert.equal(r.views[1].total, 1520000000);
  const bad = path.join(TMP, 'broken.cpuprofile');
  fs.writeFileSync(bad, '{"nodes":[{"id":1,"callFrame":{"functionName":"(root)"}},');
  await assert.rejects(parseProfile({ file: bad, name: 'broken.cpuprofile' }), /no samples|not a V8|nodes/);
  await assert.rejects(parseProfile({ file: path.join(SAMPLES, 'sample-app.cpuprofile'), name: 'sample-app.cpuprofile', maxBytes: 1000 }), /more than the 0 MB|more than the/);
  const bytes = fs.readFileSync(path.join(SAMPLES, 'sample-app.cpuprofile'));
  const r2 = await parseProfile({ bytes: new Uint8Array(bytes), name: 'x.cpuprofile' });
  assert.equal(r2.format, 'cpuprofile');
});
test('streaming: a 6 MB trace read in small chunks gives the same totals as one read', () => {
  const ev = [];
  for (let i = 0; i < 40000; i++) ev.push({ ph: 'X', name: `task${i % 13}`, cat: 'x', pid: 1, tid: 1 + (i % 3), ts: i * 10, dur: 9, args: { n: i, s: 'abc\\"}]' } });
  const text = JSON.stringify({ traceEvents: ev, displayTimeUnit: 'ms' });
  assert.ok(text.length > 4e6);
  const file = path.join(TMP, 'big.json');
  fs.writeFileSync(file, text);
  const a = loadProfile(file, 'big.json');
  const b = loadProfile(buf(text), 'big.json');
  assert.deepEqual(a.views.map((v) => v.total), b.views.map((v) => v.total));
  assert.equal(a.views.reduce((s, v) => s + v.total, 0), 40000 * 9);
});

// ---------- reports ----------
test('hotspots: CSV in ms with quoted names, JSON summary with shares', () => {
  const r = load('main;"quoted, name" 3\nmain;other 1\n', 'q.folded');
  const v = r.views[0];
  const rows = R.hotspots(v, r.frames, 10);
  assert.deepEqual(rows.map((x) => x.name), ['"quoted, name"', 'other', 'main']);
  const csv = R.hotspotsCsv(rows, v.unit);
  assert.equal(csv.split('\n')[0], 'rank,function,file,line,self_samples,self_pct,total_samples,total_pct');
  assert.equal(csv.split('\n')[1], '1,"""quoted, name""",,,3,75,3,75');
  const j = R.hotspotsJson({ file: 'q.folded', format: 'folded', view: v, rows, generated: '2026-11-15T00:00:00Z' });
  assert.equal(j.top[0].selfPct, 75);
  assert.equal(j.total, 4);
  const cpu = loadProfile(path.join(SAMPLES, 'sample-go-cpu.pb.gz'), 'g.pb.gz');
  const cv = cpu.views[cpu.defaultView];
  assert.match(R.hotspotsCsv(R.hotspots(cv, cpu.frames, 1), cv.unit), /self_ms[\s\S]*\n1,runtime\.madvise,[^,]*,\d*,90,5\.921/);
});
test('diff: the same profile shows no change; a slower function shows red with its regression on top', () => {
  const a = load('main;parse 4\nmain;render 4\nmain;io 2\n', 'a.folded');
  const b = load('main;parse 4\nmain;render 12\nmain;new 2\n', 'b.folded');
  const same = R.diffViews(a.views[0], a.frames, a.views[0], a.frames);
  assert.ok(Array.from(same.delta).every((d) => Math.abs(d) < 1e-9));
  const d = R.diffViews(a.views[0], a.frames, b.views[0], b.frames);
  assert.equal(d.rows[0].name, 'render');
  assert.ok(Math.abs(d.rows[0].dSelf - (12 / 18 - 4 / 10) * 100) < 1e-9);
  assert.equal(d.all.find((x) => x.name === 'new').status, 'new');
  assert.equal(d.all.find((x) => x.name === 'io').status, 'gone');
  const m = b.views[0].merged;
  const idx = (n) => Array.from(m.frame).findIndex((f) => f >= 0 && b.frames.names[f] === n);
  assert.ok(d.delta[idx('render')] > 0 && d.delta[idx('parse')] < 0);
  assert.equal(d.summary.newFunctions, 1);
  assert.equal(d.summary.goneFunctions, 1);
  assert.match(R.diffCsv(d.all).split('\n')[1], /^render,,40,66\.667,26\.667,40,66\.667,26\.667,$/);
});
test('SVG and HTML reports: escaped names, tooltips, our renderer inlined, nothing remote', () => {
  const r = load('main;<script>&co 3\nmain;b 1\n', 'x.folded');
  const v = r.views[0];
  const { svg, bars } = R.svgReport(v, r.frames, { title: 'T <1>' });
  assert.equal(bars, 4);
  assert.match(svg, /^<\?xml[\s\S]*<svg [^>]*width="1200"/);
  assert.match(svg, /&lt;script&gt;&amp;co/);
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /<title>[^<]*total 3 samples \(75\.00 %\)/);
  const flameJs = fs.readFileSync(path.join(ROOT, 'media', 'flame.js'), 'utf8');
  const { html } = R.htmlReport(v, r.frames, { title: 'Report', flameJs, info: [['Format', 'folded']] });
  assert.ok(html.includes('ZovoFlame.FlameView'));
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!www\.w3\.org)/);
  assert.ok(!html.includes('"names":["main","<script>'), 'the data is escaped inside the script tag');
});
test('units: time, bytes and samples print plainly', () => {
  assert.equal(U.formatValue(1520000000, 'nanoseconds'), '1.52 s');
  assert.equal(U.formatValue(2500, 'microseconds'), '2.5 ms');
  assert.equal(U.formatValue(2048, 'bytes'), '2.00 KB');
  assert.equal(U.formatValue(1, 'samples'), '1 sample');
  assert.equal(U.normUnit('none'), 'samples');
  assert.equal(U.csvValue(1520000000, 'nanoseconds'), 1520);
});
