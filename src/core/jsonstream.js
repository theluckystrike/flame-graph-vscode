'use strict';
// Streaming JSON reader. It walks a JSON document chunk by chunk, so a 500 MB trace never has to sit in memory as one
// string or one object tree. Values at "stream" paths (for example every element of traceEvents) are parsed one at a
// time and handed to onElement; every other scalar is handed to onScalar with its path. Containers outside the stream
// paths are walked, not kept.
//
// Paths: object keys joined with ".", array elements as "#". The root array's elements are "#", the elements of
// { "traceEvents": [...] } are "traceEvents.#", the samples of the 2nd speedscope profile are "profiles.#.samples.#"
// with indices [1, n]. A truncated file (a trace cut off while it was written) ends quietly after the last whole element.

const V = 0, KEY_OR_END = 1, KEY = 2, COLON = 3, AFTER = 4, STR = 5, LIT = 6, CAP = 7, DONE = 8;
const BOM = [0xef, 0xbb, 0xbf];
const MAX_ELEMENT = 256 * 1024 * 1024;
const MAX_STRING = 1024 * 1024;
const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9;
const isDelim = (c) => c === 44 || c === 93 || c === 125 || c === 32 || c === 10 || c === 13 || c === 9 || c === 58;

/**
 * o: { stream(path) -> bool, onElement(path, value, indices), onScalar(path, value, indices) }
 * Returns { push(buffer), end() }. push may be called with any chunk size; the caller may reuse its buffer.
 */
function createJsonStream(o) {
  const stream = o.stream || (() => false);
  const onElement = o.onElement || (() => {});
  const onScalar = o.onScalar || (() => {});
  const stack = []; // { arr, path, key, i }
  const streamCache = new Map();
  let state = V;
  let first = true;
  let bom = 0;
  // string (key or scalar outside a capture)
  let strIsKey = false, strParts = [], strLen = 0, strEsc = false;
  // literal outside a capture
  let lit = '';
  // capture
  let cap = null; // { path, idx, depth, inStr, esc, parts, size, lit }

  const isStream = (p) => { let v = streamCache.get(p); if (v === undefined) { v = !!stream(p); streamCache.set(p, v); } return v; };
  function elemPath() {
    const t = stack[stack.length - 1];
    if (!t) return '';
    if (t.arr) return t.path ? t.path + '.#' : '#';
    return t.path ? t.path + '.' + t.key : t.key;
  }
  const indices = () => stack.filter((t) => t.arr).map((t) => t.i);
  function endValue() {
    const t = stack[stack.length - 1];
    state = t ? AFTER : DONE;
  }
  function scalarText(s) {
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s === 'null') return null;
    const n = Number(s);
    if (Number.isNaN(n)) throw new Error(`Not valid JSON near "${s.slice(0, 40)}"`);
    return n;
  }

  function push(buf) {
    let i = 0;
    const n = buf.length;
    // a UTF-8 byte order mark at the start, even when it is split over chunks
    while (bom < 3 && i < n) {
      if (buf[i] === BOM[bom]) { bom++; i++; } else { bom = 3; }
    }
    if (n) first = false;
    while (i < n) {
      if (state === CAP) {
        if (cap.lit !== null) {
          let j = i;
          while (j < n && !isDelim(buf[j])) j++;
          cap.lit += buf.toString('latin1', i, j);
          if (j >= n) { i = n; break; }
          i = j;
          onElement(cap.path, scalarText(cap.lit), cap.idx);
          cap = null;
          endValue();
          continue;
        }
        let j = i, d = cap.depth, inS = cap.inStr, e = cap.esc, finished = false;
        for (; j < n; j++) {
          const c = buf[j];
          if (inS) {
            if (e) e = false;
            else if (c === 92) e = true;
            else if (c === 34) { inS = false; if (d === 0) { j++; finished = true; break; } }
          } else if (c === 34) inS = true;
          else if (c === 123 || c === 91) d++;
          else if (c === 125 || c === 93) { d--; if (d === 0) { j++; finished = true; break; } }
        }
        if (finished) {
          const text = cap.parts.length ? Buffer.concat([...cap.parts, buf.subarray(i, j)]).toString('utf8') : buf.toString('utf8', i, j);
          const path = cap.path, idx = cap.idx;
          cap = null;
          onElement(path, JSON.parse(text), idx);
          endValue();
          i = j;
          continue;
        }
        cap.size += n - i;
        if (cap.size > MAX_ELEMENT) throw new Error('One element of this JSON file is larger than 256 MB.');
        cap.parts.push(Buffer.from(buf.subarray(i, n)));
        cap.depth = d; cap.inStr = inS; cap.esc = e;
        i = n;
        break;
      }
      if (state === STR) {
        let j = i, e = strEsc, finished = false;
        for (; j < n; j++) {
          const c = buf[j];
          if (e) e = false;
          else if (c === 92) e = true;
          else if (c === 34) { finished = true; break; }
        }
        const piece = buf.subarray(i, j);
        if (strLen + piece.length <= MAX_STRING) { strParts.push(finished ? piece : Buffer.from(piece)); strLen += piece.length; }
        strEsc = e;
        if (!finished) { i = n; break; }
        i = j + 1;
        const raw = strParts.length === 1 ? strParts[0].toString('utf8') : Buffer.concat(strParts).toString('utf8');
        strParts = []; strLen = 0;
        let s;
        try { s = raw.indexOf('\\') >= 0 ? JSON.parse('"' + raw + '"') : raw; } catch (err) { s = raw; }
        if (strIsKey) { stack[stack.length - 1].key = s; state = COLON; } else { onScalar(elemPath(), s, indices()); endValue(); }
        continue;
      }
      if (state === LIT) {
        let j = i;
        while (j < n && !isDelim(buf[j])) j++;
        lit += buf.toString('latin1', i, j);
        if (j >= n) { i = n; break; }
        i = j;
        onScalar(elemPath(), scalarText(lit), indices());
        lit = '';
        endValue();
        continue;
      }
      const c = buf[i];
      if (isWs(c)) { i++; continue; }
      switch (state) {
        case V: {
          const t = stack[stack.length - 1];
          if (c === 93 && t && t.arr) { stack.pop(); endValue(); i++; break; } // "[]" or a trailing comma
          const p = elemPath();
          if (isStream(p)) {
            const idx = indices();
            if (c === 123 || c === 91 || c === 34) cap = { path: p, idx, depth: 0, inStr: false, esc: false, parts: [], size: 0, lit: null };
            else cap = { path: p, idx, lit: '' };
            state = CAP;
            break; // the capture loop starts at this byte
          }
          if (c === 123) { stack.push({ arr: false, path: p, key: null, i: 0 }); state = KEY_OR_END; i++; } else if (c === 91) { stack.push({ arr: true, path: p, key: null, i: 0 }); state = V; i++; } else if (c === 34) { strIsKey = false; strEsc = false; state = STR; i++; } else { lit = ''; state = LIT; }
          break;
        }
        case KEY_OR_END:
        case KEY:
          if (c === 34) { strIsKey = true; strEsc = false; state = STR; i++; } else if (c === 125) { stack.pop(); endValue(); i++; } else throw new Error('Not valid JSON: expected a key.');
          break;
        case COLON:
          if (c !== 58) throw new Error('Not valid JSON: expected ":".');
          state = V; i++;
          break;
        case AFTER: {
          const t = stack[stack.length - 1];
          if (c === 44) { if (t.arr) { t.i++; state = V; } else state = KEY; i++; } else if (c === 93 || c === 125) { stack.pop(); endValue(); i++; } else throw new Error('Not valid JSON: expected "," or a closing bracket.');
          break;
        }
        case DONE:
          i = n; // trailing text after the document is ignored
          break;
        default:
          i++;
      }
    }
  }
  function end() {
    if (state === LIT && lit) { onScalar(elemPath(), scalarText(lit), indices()); lit = ''; endValue(); }
    if (state === CAP && cap && cap.lit !== null && cap.lit) { onElement(cap.path, scalarText(cap.lit), cap.idx); cap = null; endValue(); }
    return { complete: state === DONE, depth: stack.length };
  }
  return { push, end, get started() { return !first; } };
}

/** Reads a file through the scanner in 1 MB chunks. */
function scanFile(fs, file, scanner, chunk = 1 << 20) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(chunk);
  try {
    for (;;) {
      const got = fs.readSync(fd, buf, 0, chunk, null);
      if (!got) break;
      scanner.push(got === chunk ? buf : buf.subarray(0, got));
    }
  } finally { fs.closeSync(fd); }
  return scanner.end();
}

/** Feeds an in-memory buffer through the scanner. */
function scanBytes(bytes, scanner, chunk = 1 << 20) {
  for (let i = 0; i < bytes.length; i += chunk) scanner.push(bytes.subarray(i, Math.min(bytes.length, i + chunk)));
  return scanner.end();
}

module.exports = { createJsonStream, scanFile, scanBytes };
