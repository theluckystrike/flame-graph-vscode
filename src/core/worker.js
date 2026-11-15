'use strict';
// Worker thread: reads and parses one profile, posts the finished views back (typed arrays are transferred, not
// copied) and ends, so the parser's memory goes back to the system right after the file is open.
const { parentPort, workerData } = require('worker_threads');
const { loadProfile } = require('./load');
const { buffersOf } = require('./builder');

try {
  const src = workerData.file || workerData.bytes;
  const r = loadProfile(src, workerData.name, { maxBytes: workerData.maxBytes });
  const transfer = [];
  for (const v of r.views) transfer.push(...buffersOf(v));
  parentPort.postMessage({ ok: true, result: r }, transfer);
} catch (e) {
  parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
}
