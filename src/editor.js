'use strict';
// Read-only custom editor for profile files. The extension host reads and parses the file in a worker thread
// (src/core/parse.js), keeps the finished views (flat typed arrays) and sends one view at a time to the webview,
// which draws it on a canvas (media/flame.js). Nothing leaves the computer; the webview has no network access.
const vscode = require('vscode');
const path = require('path');
const { parseProfile } = require('./core/parse');
const { editorHtml } = require('./html');
const support = require('./support');

const VIEW_TYPE = 'flameGraph.editor';
// .cpuprofile, .heapprofile and any .json, .txt or .log: VS Code (or another extension) already has an editor for
// them, so ours is an option there and "Open as Flame Graph" opens it. Two default editors would make VS Code ask.
const OTHER_VIEW_TYPE = 'flameGraph.other';
const DEFAULT_RE = /\.(pb\.gz|pprof|prof|folded|collapsed|perf|perfscript|speedscope\.json)$|(^|[\\/])Trace-[^\\/]*\.json$/i;
const viewTypeFor = (uri) => (DEFAULT_RE.test(uri.path) ? VIEW_TYPE : OTHER_VIEW_TYPE);
const PROFILE_GLOB = '**/*.{cpuprofile,heapprofile,pb.gz,pprof,prof,folded,collapsed,perf,perfscript,speedscope.json}';
const PREFIX = 'flameGraph';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);
const base = (uri) => path.posix.basename(uri.path);

class ProfileDocument {
  constructor(uri) { this.uri = uri; this.result = null; this.error = ''; this.viewId = -1; this.panels = new Set(); this.listeners = []; this.loading = null; }
  get name() { return base(this.uri); }
  get view() { return this.result ? this.result.views[this.viewId] || this.result.views[this.result.defaultView] : null; }
  async load() {
    this.error = '';
    const max = Math.max(1, Number(setting('maxFileSizeMB', 2048)) || 2048) * 1024 * 1024;
    try {
      let r;
      if (this.uri.scheme === 'file') r = await parseProfile({ file: this.uri.fsPath, name: this.name, maxBytes: max, timeoutMs: 180000 });
      else {
        const st = await vscode.workspace.fs.stat(this.uri);
        if (st.size > max) throw new Error(`This file is ${Math.round(st.size / 1048576)} MB, more than the ${Math.round(max / 1048576)} MB set in "flameGraph.maxFileSizeMB".`);
        const data = await vscode.workspace.fs.readFile(this.uri);
        r = await parseProfile({ bytes: data, name: this.name, maxBytes: max, timeoutMs: 180000 });
      }
      this.result = r;
      if (this.viewId < 0 || this.viewId >= r.views.length) this.viewId = r.defaultView;
    } catch (e) {
      this.result = null;
      this.error = String((e && e.message) || e);
    }
  }
  dispose() { for (const l of this.listeners) l.dispose(); }
}

/** Opens one profile without a viewer (for the Pro tools run from the Explorer or with two files). */
async function loadUri(uri) {
  const doc = new ProfileDocument(uri);
  await doc.load();
  if (doc.error) throw new Error(`${doc.name}: ${doc.error}`);
  return doc;
}

function metaOf(doc, extra = {}) {
  const base0 = { type: 'meta', name: doc.name, ...extra };
  if (!doc.result) return { ...base0, error: doc.error || 'The file could not be read.' };
  const r = doc.result;
  return {
    ...base0, format: r.format, formatLabel: r.formatLabel, current: doc.viewId, warnings: r.warnings, info: r.info, size: r.size,
    views: r.views.map((v) => ({ id: v.id, label: v.label, unit: v.unit, total: v.total, samples: v.samples, nodes: v.nodes, chronoAvailable: v.chronoAvailable, chronoLabel: v.chronoLabel })),
  };
}

function dataOf(doc) {
  const r = doc.result, v = doc.view;
  return {
    type: 'data', view: v.id, label: v.label, unit: v.unit, total: v.total, samples: v.samples,
    names: r.frames.names, files: r.frames.files, lines: r.frames.lines,
    merged: { frame: v.merged.frame, depth: v.merged.depth, x: v.merged.x, w: v.merged.w, self: v.merged.self },
    chrono: v.chrono ? { frame: v.chrono.frame, depth: v.chrono.depth, x: v.chrono.x, w: v.chrono.w } : null,
    chronoLabel: v.chronoLabel, chronoTooBig: !!v.chronoTooBig,
    fn: v.fn,
  };
}

/** Where a frame's file is on disk: as written, next to the profile, or the best suffix match in the workspace. */
async function resolveSource(doc, file) {
  if (!file) return { reason: 'This frame has no file.' };
  let p = String(file);
  if (/^(node|internal):|^native |^\[|^v8\//.test(p) || /^(node:)?internal\//.test(p)) return { reason: `This frame is inside the runtime (${p}), so there is no file to open.` };
  if (/^https?:/i.test(p)) {
    try { p = new URL(p).pathname; } catch (e) { /* keep */ }
  } else if (/^file:/i.test(p)) {
    try { const u = vscode.Uri.parse(p); if (await exists(u)) return { uri: u }; p = u.fsPath || u.path; } catch (e) { /* keep */ }
  } else if (/^[a-z][\w+.-]*:\/\//i.test(p)) p = p.replace(/^[a-z][\w+.-]*:\/\/\/?/i, '').replace(/^\.\//, '');
  if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) { const u = vscode.Uri.file(p); if (await exists(u)) return { uri: u }; }
  const segs = p.split(/[\\/]+/).filter((s) => s && s !== '.' && s !== '..');
  if (!segs.length) return { reason: `No file named ${file}.` };
  // next to the profile: the longest suffix of the path that exists there
  const dir = vscode.Uri.joinPath(doc.uri, '..');
  for (let k = 0; k < segs.length && k < 6; k++) {
    const u = vscode.Uri.joinPath(dir, ...segs.slice(k));
    if (await exists(u)) return { uri: u };
  }
  if (!vscode.workspace.workspaceFolders || !vscode.workspace.workspaceFolders.length) return { reason: `${segs[segs.length - 1]} is not next to the profile, and no folder is open to search.` };
  const name = segs[segs.length - 1].replace(/[[\]{}*?]/g, '?');
  const found = await vscode.workspace.findFiles(`**/${name}`, '**/node_modules/**', 200);
  let best = null, bestScore = 0;
  for (const u of found) {
    const us = u.path.split('/').filter(Boolean);
    let s = 0;
    while (s < us.length && s < segs.length && us[us.length - 1 - s] === segs[segs.length - 1 - s]) s++;
    if (s > bestScore || (s === bestScore && best && u.path.length < best.path.length)) { best = u; bestScore = s; }
  }
  if (best && bestScore >= 1) return { uri: best };
  return { reason: `${segs[segs.length - 1]} is not in this workspace.` };
}
async function exists(u) { try { await vscode.workspace.fs.stat(u); return true; } catch (e) { return false; } }

class FlameEditorProvider {
  constructor(context, hooks = {}) {
    this.context = context;
    this.hooks = hooks;
    this.docs = new Set();
    this.active = null;
    this.activePanel = null;
    this._success = new WeakSet();
  }

  async openCustomDocument(uri) {
    const doc = new ProfileDocument(uri);
    doc.loading = doc.load();
    await doc.loading;
    this.docs.add(doc);
    if (uri.scheme === 'file') {
      try {
        const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), base(uri)));
        let timer = null;
        const reload = () => { clearTimeout(timer); timer = setTimeout(async () => { await doc.load(); for (const p of doc.panels) this.post(doc, p.webview); }, 400); };
        doc.listeners.push(w, w.onDidChange(reload), w.onDidCreate(reload));
      } catch (e) { /* no watcher: the view still works */ }
    }
    return { uri, dispose: () => { this.docs.delete(doc); doc.dispose(); if (this.active === doc) this.active = null; }, _doc: doc };
  }

  async resolveCustomEditor(handle, panel) {
    const doc = handle._doc;
    doc.panels.add(panel);
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const reach = this.hooks.reach ? this.hooks.reach() : null;
    panel.webview.options = {
      enableScripts: true, localResourceRoots: [media],
      enableCommandUris: (reach ? reach.commandIds() : []).concat(support.commandUris(PREFIX)),
    };
    panel.webview.html = editorHtml({
      cspSource: panel.webview.cspSource,
      flameUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'flame.js')).toString(),
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.css')).toString(),
      title: doc.name,
      head: reach ? (n) => reach.headHtml(n) : undefined,
      showSupportLinks: setting('showSupportLinks', true) !== false,
    });
    if (reach) reach.attach(panel.webview, panel);
    const setActive = () => { if (panel.active) { this.active = doc; this.activePanel = panel; } };
    setActive();
    panel.onDidChangeViewState(setActive);
    panel.onDidDispose(() => { doc.panels.delete(panel); if (this.activePanel === panel) { this.activePanel = null; if (this.active === doc) this.active = null; } });
    panel.webview.onDidReceiveMessage(async (m) => {
      if (reach && reach.onMessage(m)) return;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') await this.post(doc, panel.webview);
      else if (m.type === 'view') { if (doc.result && doc.result.views[m.id | 0]) { doc.viewId = m.id | 0; this.send(panel.webview, dataOf(doc)); } }
      else if (m.type === 'open') await this.openSource(doc, m.frame | 0, panel.webview);
      else if (m.type === 'prefs') { const p = { mode: m.mode === 'time' ? 'time' : 'left', orientation: m.orientation === 'icicle' ? 'icicle' : 'flame', table: m.table !== false }; await this.context.globalState.update('flameGraph.prefs', p); }
      else if (m.type === 'shown') { if (!this._success.has(doc)) { this._success.add(doc); if (this.hooks.onSuccess) this.hooks.onSuccess(doc); } }
      else if (m.type === 'failed') { if (this.hooks.onFailure) this.hooks.onFailure(doc); }
      else if (m.type === 'copy' && typeof m.text === 'string') { await vscode.env.clipboard.writeText(m.text.slice(0, 20000)); vscode.window.setStatusBarMessage('Copied the frame', 3000); }
    });
  }

  send(webview, msg) { try { const r = webview.postMessage(msg); if (r && r.then) r.then(undefined, () => false); } catch (e) { /* disposed */ } }

  prefs() {
    const saved = this.context.globalState.get('flameGraph.prefs') || {};
    return { mode: saved.mode || setting('defaultOrder', 'left'), orientation: saved.orientation || setting('direction', 'flame'), table: saved.table !== false };
  }

  async post(doc, webview) {
    if (doc.loading) await doc.loading;
    this.send(webview, metaOf(doc, { prefs: this.prefs() }));
    if (!doc.result) { if (this.hooks.onFailure) this.hooks.onFailure(doc); return; }
    this.send(webview, dataOf(doc));
  }

  async openSource(doc, frame, webview) {
    const r = doc.result;
    if (!r || frame < 0 || frame >= r.frames.names.length) return;
    const file = r.frames.files[frame], line = r.frames.lines[frame] || 1;
    const found = await resolveSource(doc, file);
    if (!found.uri) {
      this.send(webview, { type: 'note', text: found.reason });
      vscode.window.setStatusBarMessage(found.reason, 6000);
      return;
    }
    const pos = new vscode.Position(Math.max(0, line - 1), 0);
    await vscode.window.showTextDocument(found.uri, { selection: new vscode.Range(pos, pos), viewColumn: vscode.ViewColumn.Beside, preview: true });
    this.send(webview, { type: 'note', text: `Opened ${vscode.workspace.asRelativePath(found.uri)}:${line}` });
  }
}

module.exports = { FlameEditorProvider, ProfileDocument, VIEW_TYPE, OTHER_VIEW_TYPE, viewTypeFor, metaOf, dataOf, resolveSource, loadUri, PROFILE_GLOB, DEFAULT_RE };
