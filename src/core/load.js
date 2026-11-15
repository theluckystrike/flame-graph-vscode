'use strict';
// Opens a profile file: finds its format from the name and the first bytes, runs the right reader and returns the
// finished views (flat arrays for the webview) with one shared frame table. No vscode import: the worker thread and
// the tests call it directly.
const fs = require('fs');
const { FrameTable } = require('./builder');
const { createJsonStream, scanFile, scanBytes } = require('./jsonstream');
const { CpuProfileParts, buildCpuProfile, buildHeapProfile } = require('./v8');
const { TraceCollector } = require('./trace');
const { SpeedscopeCollector } = require('./speedscope');
const { buildPprof, isGzip } = require('./pprof');
const { buildFolded, buildPerf, readHead } = require('./text');

const FORMATS = {
  cpuprofile: 'V8 CPU profile',
  heapprofile: 'V8 heap profile',
  trace: 'Chrome trace',
  pprof: 'pprof',
  folded: 'Collapsed stacks',
  perf: 'perf script',
  speedscope: 'speedscope',
};
const HEAP_JSON_LIMIT = 300 * 1024 * 1024;
const PPROF_LIMIT = 400 * 1024 * 1024;

/** Format from the file name alone, or '' when the content has to decide. */
function formatFromName(name) {
  const n = String(name || '').toLowerCase();
  if (/\.cpuprofile(\.json)?$/.test(n)) return 'cpuprofile';
  if (/\.heapprofile(\.json)?$/.test(n)) return 'heapprofile';
  if (/\.speedscope\.json$/.test(n)) return 'speedscope';
  if (/\.(pb\.gz|pprof|pb)$/.test(n)) return 'pprof';
  if (/\.(folded|collapsed)$/.test(n)) return 'folded';
  if (/\.(perf|perfscript|perf\.txt|perf-script)$/.test(n) || /(^|[\\/])perf\.script$/.test(n)) return 'perf';
  return '';
}

const PERF_LINE = /^\S.*?\s+\d+(?:\/\d+)?\s+(?:\[\d+\]\s+)?(?:\d+\.\d+:)/m;
const PERF_STACK = /\n[ \t]+[0-9a-fA-F]+\s+\S.*\(.*\)\s*\n/;
const FOLDED_LINE = /^[^\n;]+(;[^\n;]+)*\s+\d+(\.\d+)?\s*$/;

/** Format from the first bytes. */
function sniff(head, name) {
  if (!head || !head.length) return { format: '', reason: 'This file is empty.' };
  if (isGzip(head)) return { format: 'pprof' };
  let i = 0;
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3;
  if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) return { format: 'folded' };
  while (i < head.length && (head[i] === 32 || head[i] === 10 || head[i] === 13 || head[i] === 9)) i++;
  const text = head.toString('utf8', i, Math.min(head.length, i + 65536));
  if (head[i] === 0x7b || head[i] === 0x5b) {
    if (/"\$schema"\s*:\s*"[^"]*speedscope/.test(text) || /"exporter"\s*:\s*"speedscope/.test(text)) return { format: 'speedscope' };
    if (head[i] === 0x5b || /"traceEvents"\s*:/.test(text)) return { format: 'trace' };
    if (/"head"\s*:/.test(text) && /"selfSize"\s*:/.test(text)) return { format: 'heapprofile' };
    if (/"nodes"\s*:/.test(text) && /"callFrame"\s*:/.test(text)) return { format: 'cpuprofile' };
    if (/"head"\s*:/.test(text) && /"hitCount"\s*:/.test(text)) return { format: 'cpuprofile', legacy: true };
    if (/"samples"\s*:/.test(text) && /"timeDeltas"\s*:/.test(text)) return { format: 'cpuprofile' };
    if (/^\{\s*"[^"]+"\s*:/.test(text)) return { format: '', reason: 'This JSON file is not a profile the viewer knows: it reads V8 .cpuprofile and .heapprofile, Chrome trace JSON and speedscope JSON.' };
  }
  // binary: a pprof protocol buffer starts with sample_type (field 1, bytes) or sample (field 2)
  let bin = 0;
  for (let k = i; k < Math.min(head.length, i + 512); k++) if (head[k] === 0 || (head[k] < 9)) bin++;
  if (bin > 2) {
    if (head[i] === 0x0a || head[i] === 0x12) return { format: 'pprof' };
    return { format: '', reason: /\.prof$/i.test(name || '') ? 'This .prof file is not a pprof profile. Python cProfile (pstats) files are not supported; save the profile as collapsed stacks or speedscope JSON instead.' : 'This binary file is not a profile the viewer knows.' };
  }
  if (PERF_LINE.test(text) && PERF_STACK.test(text)) return { format: 'perf' };
  const first = text.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'));
  if (first && FOLDED_LINE.test(first.trim())) return { format: 'folded' };
  if (/\.prof$/i.test(name || '') && /time\s+and\s+allocation|individual\s+inherited|COST CENTRE/i.test(text)) return { format: '', reason: 'This .prof file is a GHC profiling report, not a pprof profile. Open it as text.' };
  if (PERF_LINE.test(text)) return { format: 'perf' };
  return { format: '', reason: 'This file is not a profile the viewer knows. It reads .cpuprofile, .heapprofile, Chrome trace JSON, pprof (.pb.gz, .pprof, .prof), collapsed stacks (.folded), perf script text and speedscope JSON.' };
}

function headOf(src) {
  return typeof src === 'string' ? readHead(fs, src, 65536) : Buffer.from(src.buffer, src.byteOffset, Math.min(src.byteLength, 65536));
}
const sizeOf = (src) => (typeof src === 'string' ? fs.statSync(src).size : src.byteLength);
const mb = (n) => `${Math.round(n / 1048576)} MB`;

function parseWhole(src, what) {
  const text = typeof src === 'string' ? fs.readFileSync(src, 'utf8') : Buffer.from(src.buffer, src.byteOffset, src.byteLength).toString('utf8');
  try { return JSON.parse(text.replace(/^\ufeff/, '')); } catch (e) { throw new Error(`This ${what} is not valid JSON (${e.message}).`); }
}

/** The older CPU profile form (Node 8 to 10 profilers, Chrome before 60): a "head" tree, samples and timestamps. */
function legacyCpuParts(doc) {
  const parts = new CpuProfileParts();
  const work = doc && doc.head ? [doc.head] : [];
  while (work.length) {
    const n = work.pop();
    if (!n || typeof n !== 'object') continue;
    const kids = Array.isArray(n.children) ? n.children : [];
    parts.node({ id: n.id, hitCount: n.hitCount, callFrame: n.callFrame || { functionName: n.functionName, url: n.url, lineNumber: n.lineNumber, columnNumber: n.columnNumber }, children: kids.map((k) => k && k.id) });
    for (const k of kids) work.push(k);
  }
  if (!parts.nodeCount) throw new Error('This CPU profile has no call tree.');
  // seconds in the oldest files, microseconds later
  const scale = doc.startTime && doc.startTime < 1e8 ? 1e6 : 1;
  parts.startTime = (Number(doc.startTime) || 0) * scale; parts.endTime = (Number(doc.endTime) || 0) * scale;
  const ts = Array.isArray(doc.timestamps) ? doc.timestamps : [];
  if (Array.isArray(doc.samples)) doc.samples.forEach((s, i) => { parts.sample(s); parts.delta(i < ts.length ? (i ? ts[i] - ts[i - 1] : ts[0] - parts.startTime) : 0); });
  return parts;
}

function scanJson(src, opts) {
  const s = createJsonStream(opts);
  return typeof src === 'string' ? scanFile(fs, src, s) : scanBytes(Buffer.from(src.buffer, src.byteOffset, src.byteLength), s);
}

/**
 * src: file path or bytes (Uint8Array). name: file name for the format. o: { maxBytes }.
 * Returns { format, formatLabel, views, defaultView, frames, warnings, info }.
 */
function loadProfile(src, name, o = {}) {
  const size = sizeOf(src);
  if (o.maxBytes && size > o.maxBytes) throw new Error(`This file is ${mb(size)}, more than the ${mb(o.maxBytes)} set in "flameGraph.maxFileSizeMB".`);
  const head = headOf(src);
  let format = formatFromName(name);
  const sn = sniff(head, name);
  if (format === 'pprof' && sn.format && sn.format !== 'pprof') format = sn.format;
  if (format && format !== 'pprof' && sn.format === 'pprof' && isGzip(head)) format = 'pprof';
  if (!format || (format === 'cpuprofile' && sn.format === 'trace') || (format === 'speedscope' && sn.format && sn.format !== 'speedscope')) format = sn.format;
  if (!format) throw new Error(sn.reason || 'This file is not a profile the viewer knows.');
  const frames = new FrameTable();
  const warnings = [];
  const info = [];
  let builders = [];
  let def = 0;
  if (format === 'cpuprofile' && sn.legacy) {
    if (size > HEAP_JSON_LIMIT) throw new Error(`This CPU profile in the older format is ${mb(size)}; up to ${mb(HEAP_JSON_LIMIT)} open.`);
    const doc = parseWhole(src, 'CPU profile');
    const parts = legacyCpuParts(doc);
    builders = [buildCpuProfile(parts, frames, { label: 'CPU time' })];
    info.push(['Samples', parts.samples.length.toLocaleString('en-US')]);
  } else if (format === 'cpuprofile') {
    const parts = new CpuProfileParts();
    const r = scanJson(src, {
      stream: (p) => p === 'nodes.#' || p === 'samples.#' || p === 'timeDeltas.#',
      onElement: (p, v) => { if (p === 'nodes.#') parts.node(v); else if (p === 'samples.#') parts.sample(v); else parts.delta(v); },
      onScalar: (p, v) => { if (p === 'startTime') parts.startTime = Number(v) || 0; else if (p === 'endTime') parts.endTime = Number(v) || 0; },
    });
    if (!r.complete) warnings.push('The file ends early (it may still have been written); the part that was read is shown.');
    if (!parts.nodeCount) throw new Error('This is not a V8 CPU profile: it has no "nodes".');
    builders = [buildCpuProfile(parts, frames, { label: 'CPU time' })];
    info.push(['Samples', parts.samples.length.toLocaleString('en-US')]);
    if (parts.endTime > parts.startTime) info.push(['Duration', `${((parts.endTime - parts.startTime) / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} ms`]);
  } else if (format === 'heapprofile') {
    if (size > HEAP_JSON_LIMIT) throw new Error(`This heap profile is ${mb(size)}; heap profiles up to ${mb(HEAP_JSON_LIMIT)} open.`);
    const text = typeof src === 'string' ? fs.readFileSync(src, 'utf8') : Buffer.from(src.buffer, src.byteOffset, src.byteLength).toString('utf8');
    let doc;
    try { doc = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new Error(`This heap profile is not valid JSON (${e.message}).`); }
    builders = [buildHeapProfile(doc, frames, { label: 'Allocated memory (sampled)' })];
    if (Array.isArray(doc.samples)) info.push(['Allocation samples', doc.samples.length.toLocaleString('en-US')]);
  } else if (format === 'trace') {
    const c = new TraceCollector();
    const r = scanJson(src, {
      stream: (p) => p === '#' || p === 'traceEvents.#' || p === 'samples.#' || /^stackFrames\.[^.]+$/.test(p),
      onElement: (p, v) => { if (p === 'samples.#') c.sample(v); else if (p.startsWith('stackFrames.')) c.stackFrame(p.slice(12), v); else c.event(v); },
    });
    if (!r.complete) warnings.push('The trace ends early (it may still have been written); the events that were read are shown.');
    if (!c.events && !c.sampleThreads.size) throw new Error('This trace holds no events.');
    builders = c.build(frames);
    if (!builders.length) throw new Error(`This trace has ${c.events.toLocaleString('en-US')} events but no CPU profile and no duration events (B, E or X) to draw.`);
    info.push(['Events', c.events.toLocaleString('en-US')]);
    if (c.droppedThreads) warnings.push(`${c.droppedThreads} quieter threads are not listed (the 40 busiest are).`);
  } else if (format === 'speedscope') {
    const c = new SpeedscopeCollector();
    const r = scanJson(src, { stream: SpeedscopeCollector.stream, onElement: (p, v, idx) => c.element(p, v, idx), onScalar: (p, v, idx) => c.scalar(p, v, idx) });
    if (!r.complete) warnings.push('The file ends early; the part that was read is shown.');
    builders = c.build(frames);
    if (c.active >= 0 && c.active < builders.length) def = c.active;
  } else if (format === 'pprof') {
    if (size > PPROF_LIMIT) throw new Error(`This pprof file is ${mb(size)}; pprof files up to ${mb(PPROF_LIMIT)} open.`);
    const bytes = typeof src === 'string' ? fs.readFileSync(src) : Buffer.from(src.buffer, src.byteOffset, src.byteLength);
    const r = buildPprof(bytes, frames);
    builders = r.builders;
    def = r.meta.defaultIndex;
    info.push(['Samples', r.meta.samples.toLocaleString('en-US')]);
    if (r.meta.durationNanos > 0) info.push(['Duration', `${(r.meta.durationNanos / 1e9).toLocaleString('en-US', { maximumFractionDigits: 2 })} s`]);
    if (r.meta.periodType && r.meta.period) info.push(['Period', `${r.meta.period.toLocaleString('en-US')} ${r.meta.periodType.unit || ''} ${r.meta.periodType.type || ''}`.trim()]);
    // keep only types with data; keep the default one in front of the user
    const keep = builders.map((b, k) => [b, k]).filter(([b]) => b.samples > 0);
    if (!keep.length) throw new Error('This pprof profile holds no samples with a value above 0.');
    const dk = keep.findIndex(([, k]) => k === def);
    builders = keep.map(([b]) => b);
    def = dk >= 0 ? dk : builders.length - 1;
  } else if (format === 'folded') {
    const r = buildFolded(fs, src, frames);
    builders = [r.builder];
    info.push(['Lines', r.lines.toLocaleString('en-US')]);
    if (r.bad) warnings.push(`${r.bad.toLocaleString('en-US')} lines are not "stack count" lines and were skipped.`);
  } else if (format === 'perf') {
    const r = buildPerf(fs, src, frames);
    builders = [r.builder];
    info.push(['Samples', r.samples.toLocaleString('en-US')]);
  }
  const views = builders.map((b, k) => ({ id: k, ...b.finish(frames) }));
  views.forEach((v) => { if (!v.total) warnings.push(`"${v.label}" holds no weight.`); });
  return { format, formatLabel: FORMATS[format], views, defaultView: Math.min(def, views.length - 1), frames: frames.toJSON(), warnings, info, size };
}

module.exports = { loadProfile, sniff, formatFromName, FORMATS };
