'use strict';
// Runs the parser in a worker thread with a memory cap, so a huge or broken file can never take the editor down.
const path = require('path');
const { Worker } = require('worker_threads');

const HEAP_MB = 1024;

/** o: { file (path) | bytes (Uint8Array), name, maxBytes, timeoutMs } -> Promise of the loadProfile result. */
function parseProfile(o) {
  return new Promise((resolve, reject) => {
    let done = false;
    const w = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { file: o.file, bytes: o.bytes, name: o.name, maxBytes: o.maxBytes },
      resourceLimits: { maxOldGenerationSizeMb: HEAP_MB },
    });
    const timer = o.timeoutMs ? setTimeout(() => { if (!done) { done = true; w.terminate(); reject(new Error(`Reading this profile took longer than ${Math.round(o.timeoutMs / 1000)} s and was stopped.`)); } }, o.timeoutMs) : null;
    const finish = (fn) => { if (done) return; done = true; if (timer) clearTimeout(timer); fn(); };
    w.on('message', (m) => finish(() => { if (m && m.ok) resolve(m.result); else reject(new Error((m && m.error) || 'The profile could not be read.')); w.terminate(); }));
    w.on('error', (e) => finish(() => reject(new Error(/ERR_WORKER_OUT_OF_MEMORY|heap out of memory/i.test(`${e && e.code} ${e && e.message}`) ? `This profile needs more than ${HEAP_MB} MB of memory to open, so it was stopped.` : String((e && e.message) || e)))));
    w.on('exit', (code) => finish(() => reject(new Error(`The profile reader stopped (code ${code}).`))));
  });
}

module.exports = { parseProfile };
