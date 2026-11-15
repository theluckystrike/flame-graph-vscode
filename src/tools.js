'use strict';
// The three Zovo Pro tools: Compare two profiles, Export HTML or SVG report, Hotspot report (CSV, JSON). Each asks
// pro.allowed() before it starts and calls pro.produced() only after its result is on screen or on disk, so Escape,
// Cancel or an error never uses a free try. Everything runs on this computer.
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { loadUri, PROFILE_GLOB } = require('./editor');
const R = require('./core/report');
const { formatValue } = require('./core/units');
const { panelHtml } = require('./html');

const PREFIX = 'flameGraph';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);
const base = (uri) => path.posix.basename(uri.path);
const stem = (name) => name.replace(/\.(pb\.gz|speedscope\.json|perf\.txt)$/i, '').replace(/\.[^.]+$/, '');
const isUri = (u) => !!(u && typeof u === 'object' && u.scheme && u.path);

function createTools({ context, provider, pro }) {
  const panels = {};

  async function exists(uri) { try { await vscode.workspace.fs.stat(uri); return true; } catch (e) { return false; } }
  async function uniqueFile(dir, name) {
    let u = vscode.Uri.joinPath(dir, name);
    const ext = name.match(/(\.[a-z]+){1,2}$/i)[0];
    const st = name.slice(0, name.length - ext.length);
    for (let i = 2; await exists(u) && i < 1000; i++) u = vscode.Uri.joinPath(dir, `${st}-${i}${ext}`);
    return u;
  }
  const write = (uri, text) => vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));

  /** Profiles in the workspace for a pick, newest first. */
  async function workspaceProfiles(exclude) {
    if (!vscode.workspace.workspaceFolders) return [];
    const found = await vscode.workspace.findFiles(PROFILE_GLOB, '**/node_modules/**', 300);
    const out = [];
    for (const u of found) {
      if (exclude && u.toString() === exclude.toString()) continue;
      let mtime = 0;
      try { mtime = (await vscode.workspace.fs.stat(u)).mtime || 0; } catch (e) { /* gone */ }
      out.push({ uri: u, mtime });
    }
    // the profiles next to the other one and of the same kind come first, then the newest
    const dirOf = (u) => u.path.slice(0, u.path.lastIndexOf('/'));
    const kind = (u) => (u.path.match(/(\.pb\.gz|\.speedscope\.json|\.[^./]+)$/i) || [''])[0].toLowerCase();
    const score = (u) => (exclude ? (dirOf(u) === dirOf(exclude) ? 2 : 0) + (kind(u) === kind(exclude) ? 1 : 0) : 0);
    out.sort((a, b) => (score(b.uri) - score(a.uri)) || (b.mtime - a.mtime) || a.uri.path.localeCompare(b.uri.path));
    return out.map((x) => x.uri);
  }

  /** Asks for a profile file: workspace profiles first, then a file dialog. */
  async function pickProfile(title, exclude) {
    const list = await workspaceProfiles(exclude);
    const browse = { label: '$(folder-opened) Choose a file...', browse: true };
    const items = list.slice(0, 200).map((u) => ({ label: base(u), description: vscode.workspace.asRelativePath(vscode.Uri.joinPath(u, '..')), uri: u })).concat([browse]);
    const pick = await vscode.window.showQuickPick(items, { title, placeHolder: list.length ? 'A profile from this workspace, or choose a file' : 'Choose a profile file', matchOnDescription: true, ignoreFocusOut: true });
    if (!pick) return undefined;
    if (!pick.browse) return pick.uri;
    const r = await vscode.window.showOpenDialog({ canSelectMany: false, title, openLabel: 'Use this profile', filters: { Profiles: ['cpuprofile', 'heapprofile', 'json', 'gz', 'pprof', 'prof', 'pb', 'folded', 'collapsed', 'perf', 'txt'], 'All files': ['*'] } });
    return r && r[0];
  }

  /** The profile a tool works on: the clicked file, the active viewer, or one picked from the workspace. */
  async function target(arg, title) {
    if (isUri(arg)) {
      const open = [...provider.docs].find((d) => d.uri.toString() === arg.toString() && d.result);
      return open || loadUri(arg);
    }
    if (provider.active && provider.active.result) return provider.active;
    const u = await pickProfile(title);
    return u ? loadUri(u) : undefined;
  }

  function viewOf(doc, label) {
    const r = doc.result;
    if (label) { const v = r.views.find((x) => x.label === label); if (v) return v; }
    return doc.view || r.views[r.defaultView];
  }

  // ---------- panels ----------
  function panel(kind, title) {
    let p = panels[kind];
    if (p) { p.title = title; p.reveal(vscode.ViewColumn.Active, false); return p; }
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    p = vscode.window.createWebviewPanel(`flameGraph.${kind}`, title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    p.webview.html = panelHtml({
      cspSource: p.webview.cspSource,
      flameUri: p.webview.asWebviewUri(vscode.Uri.joinPath(media, 'flame.js')).toString(),
      scriptUri: p.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js')).toString(),
      styleUri: p.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.css')).toString(),
      title, showSupportLinks: setting('showSupportLinks', true) !== false,
    });
    p.onDidDispose(() => { if (panels[kind] === p) delete panels[kind]; });
    panels[kind] = p;
    p.ready = new Promise((resolve) => { p.markReady = resolve; });
    p.handlers = {};
    p.webview.onDidReceiveMessage((m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ready') p.markReady();
      else if (p.handlers[m.type]) p.handlers[m.type](m);
    });
    return p;
  }
  /** Posts the result and resolves when the webview reports it drew it. */
  async function show(p, msg) {
    await Promise.race([p.ready, new Promise((r) => setTimeout(r, 15000))]);
    const shown = new Promise((resolve) => { p.handlers.shown = () => resolve(true); setTimeout(() => resolve(false), 20000); });
    await p.webview.postMessage(msg);
    return shown;
  }

  // ---------- 1. compare two profiles ----------
  async function diffTool(arg, uris) {
    if (!(await pro.allowed('diff', arg))) return undefined;
    let before, after;
    if (Array.isArray(uris) && uris.filter(isUri).length >= 2) {
      // two files picked in the Explorer: the older one is the before profile (Swap in the panel turns it around)
      const two = uris.filter(isUri).slice(0, 2);
      const mt = async (u) => { try { return (await vscode.workspace.fs.stat(u)).mtime || 0; } catch (e) { return 0; } };
      const [m0, m1] = [await mt(two[0]), await mt(two[1])];
      if (m1 && m0 && m1 < m0) two.reverse();
      before = await loadUri(two[0]);
      after = await loadUri(two[1]);
    } else {
      after = await target(arg, 'Compare two profiles: the AFTER profile');
      if (!after) return undefined;
      const bu = await pickProfile(`Compare with ${after.name}: pick the BEFORE profile`, after.uri);
      if (!bu) return undefined;
      before = await loadUri(bu);
    }
    return runDiff(before, after);
  }
  async function runDiff(before, after, count = true) {
    const av = viewOf(after);
    const bv = viewOf(before, av.label);
    const d = R.diffViews(bv, before.result.frames, av, after.result.frames, 300);
    const p = panel('diff', `Diff: ${before.name} vs ${after.name}`);
    const csvName = `${stem(after.name)}.diff.csv`;
    p.handlers.saveCsv = async () => {
      const u = await uniqueFile(vscode.Uri.joinPath(after.uri, '..'), csvName);
      await write(u, R.diffCsv(d.all));
      p.webview.postMessage({ type: 'saved', text: `Saved ${vscode.workspace.asRelativePath(u)} (${d.all.length} functions).`, path: u.fsPath });
    };
    p.handlers.swap = async () => { await runDiff(after, before, false); };
    const m = av.merged;
    const shown = await show(p, {
      type: 'diff', title: `${before.name} → ${after.name}`,
      before: { name: before.name, label: bv.label, total: bv.total, unit: bv.unit, text: formatValue(bv.total, bv.unit) },
      after: { name: after.name, label: av.label, total: av.total, unit: av.unit, text: formatValue(av.total, av.unit) },
      summary: d.summary, rows: d.rows,
      graph: { frame: m.frame, depth: m.depth, x: m.x, w: m.w, self: m.self, names: after.result.frames.names, files: after.result.frames.files, delta: d.delta, maxAbs: d.maxAbs, unit: av.unit, total: av.total },
    });
    if (shown && count) await pro.produced('diff');
    return { before, after, diff: d, shown };
  }

  // ---------- 2. export ----------
  async function exportTool(arg) {
    if (!(await pro.allowed('export', arg))) return undefined;
    const doc = await target(arg, 'Export a report: pick a profile');
    if (!doc) return undefined;
    const kind = await vscode.window.showQuickPick([
      { label: 'HTML report', description: 'one file: interactive flame graph, search, zoom, top functions', id: 'html' },
      { label: 'SVG image', description: 'a flame graph image with a tooltip on every bar', id: 'svg' },
    ], { title: `Export ${doc.name}`, placeHolder: 'What to save next to the profile', ignoreFocusOut: true });
    if (!kind) return undefined;
    const v = viewOf(doc);
    const title = `${doc.name}: ${v.label}`;
    const info = [['Format', doc.result.formatLabel], ['Profile', v.label], ['Total', formatValue(v.total, v.unit)], ...(doc.result.info || [])];
    let text, bars;
    if (kind.id === 'svg') ({ svg: text, bars } = R.svgReport(v, doc.result.frames, { title, subtitle: info.map(([k, x]) => `${k}: ${x}`).join('   ') }));
    else {
      const flameJs = fs.readFileSync(path.join(context.extensionPath || context.extensionUri.fsPath, 'media', 'flame.js'), 'utf8');
      ({ html: text, bars } = R.htmlReport(v, doc.result.frames, { title, info, flameJs, top: 30 }));
    }
    const u = await uniqueFile(vscode.Uri.joinPath(doc.uri, '..'), `${stem(doc.name)}.flame.${kind.id}`);
    await write(u, text);
    await pro.produced('export');
    const rel = vscode.workspace.asRelativePath(u);
    vscode.window.showInformationMessage(`Saved ${rel} (${bars.toLocaleString('en-US')} bars, ${(Buffer.byteLength(text) / 1024).toFixed(0)} KB). It opens in any browser with no network access.`, 'Reveal in Explorer').then((b) => { if (b) vscode.commands.executeCommand('revealInExplorer', u); });
    return { uri: u, bars, kind: kind.id };
  }

  // ---------- 3. hotspots ----------
  async function hotspotsTool(arg) {
    if (!(await pro.allowed('hotspots', arg))) return undefined;
    const doc = await target(arg, 'Hotspot report: pick a profile');
    if (!doc) return undefined;
    const v = viewOf(doc);
    const n = Math.max(5, Math.min(1000, Number(setting('hotspotCount', 50)) || 50));
    const rows = R.hotspots(v, doc.result.frames, n);
    const dir = vscode.Uri.joinPath(doc.uri, '..');
    const csvU = await uniqueFile(dir, `${stem(doc.name)}.hotspots.csv`);
    const jsonU = await uniqueFile(dir, `${stem(doc.name)}.hotspots.json`);
    await write(csvU, R.hotspotsCsv(rows, v.unit));
    await write(jsonU, JSON.stringify(R.hotspotsJson({ file: doc.name, format: doc.result.format, view: v, rows }), null, 2) + '\n');
    const p = panel('hotspots', `Hotspots: ${doc.name}`);
    p.handlers.open = (m) => { if (m.which === 'csv') vscode.commands.executeCommand('vscode.open', csvU); else if (m.which === 'json') vscode.commands.executeCommand('vscode.open', jsonU); };
    const shown = await show(p, {
      type: 'hotspots', title: `${doc.name}: top ${rows.length} functions by self ${v.unit === 'bytes' ? 'memory' : 'time'}`,
      label: v.label, unit: v.unit, total: v.total, totalText: formatValue(v.total, v.unit),
      rows: rows.map((r) => ({ ...r, selfText: formatValue(r.self, v.unit), totalText: formatValue(r.total, v.unit) })),
      csv: vscode.workspace.asRelativePath(csvU), json: vscode.workspace.asRelativePath(jsonU),
    });
    if (shown) await pro.produced('hotspots');
    return { csv: csvU, json: jsonU, rows, shown };
  }

  return { diffTool, exportTool, hotspotsTool, runDiff, pickProfile, panels };
}

module.exports = { createTools, stem };
