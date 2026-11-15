'use strict';
// Extension tests with the vscode stub: listing, activation, the custom editor's messages, click to source, the three
// Pro tools with their free tries (the panels' "shown" answer comes from log.onPost like the real webview), README
// and support links.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadExtension, tmpDir, cleanup } = require('./support/vscode-stub');
const { editorHtml, panelHtml } = require('../src/html');

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');
const FIX = path.join(__dirname, 'fixtures');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
test.after(() => cleanup());

function activate(folder) {
  const s = loadExtension();
  if (folder) s.vscode.workspace.workspaceFolders = [{ uri: s.vscode.Uri.file(folder), name: 'ws' }];
  s.api = s.ext.activate(s.context);
  // Answer the tool panels like the webview: "shown" after a result is drawn.
  s.log.onPost = (panel, m) => { if (m.type === 'diff' || m.type === 'hotspots') panel.send({ type: 'shown' }); };
  return s;
}
function tmpWs() {
  const dir = tmpDir('flame-ws-');
  fs.mkdirSync(path.join(dir, 'prof', 'src'), { recursive: true });
  fs.copyFileSync(path.join(SAMPLES, 'sample-app.cpuprofile'), path.join(dir, 'prof', 'before.cpuprofile'));
  fs.copyFileSync(path.join(SAMPLES, 'sample-go-cpu.pb.gz'), path.join(dir, 'prof', 'cpu.pb.gz'));
  fs.copyFileSync(path.join(SAMPLES, 'sample-app.js'), path.join(dir, 'prof', 'src', 'sample-app.js'));
  fs.writeFileSync(path.join(dir, 'prof', 'after.folded'), 'main;parse 4\nmain;render 12\nmain;new 2\n');
  fs.writeFileSync(path.join(dir, 'prof', 'before.folded'), 'main;parse 4\nmain;render 4\nmain;io 2\n');
  fs.writeFileSync(path.join(dir, 'prof', 'broken.pb.gz'), 'not a profile');
  return dir;
}
function fakePanel() {
  let onMsg;
  const posted = [];
  return {
    posted, viewColumn: 1, active: true,
    webview: { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u, postMessage: async (m) => { posted.push(m); return true; }, onDidReceiveMessage: (f) => { onMsg = f; return { dispose() {} }; } },
    onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }), reveal() {},
    send: (m) => onMsg(m),
  };
}
async function openEditor(s, file) {
  const prov = s.providers.custom.p;
  const handle = await prov.openCustomDocument(s.vscode.Uri.file(file));
  const panel = fakePanel();
  await prov.resolveCustomEditor(handle, panel);
  await panel.send({ type: 'ready' });
  return { prov, handle, panel, doc: handle._doc };
}

// ---------- package.json and listing ----------
test('listing: display name with the phrase first, 30 characters or less, 5 keywords, engines low enough for Cursor and Windsurf', () => {
  assert.equal(pkg.displayName, 'Flame Graph & pprof Viewer');
  assert.ok(pkg.displayName.length <= 30);
  assert.ok(pkg.description.startsWith('Flame graph'));
  assert.deepEqual(pkg.keywords, ['flame graph', 'pprof', 'cpuprofile', 'profiler', 'performance']);
  assert.equal(pkg.engines.vscode, '^1.75.0');
  assert.equal(`${pkg.publisher}.${pkg.name}`, 'zovo.zovo-flame-graph');
  assert.equal(pkg.repository.url, 'https://github.com/theluckystrike/flame-graph-vscode');
  assert.equal(pkg.license, 'MIT');
  assert.ok(pkg.activationEvents.includes('onUri'));
  const [def, opt] = pkg.contributes.customEditors;
  assert.equal(def.priority, 'default');
  // VS Code ships a default editor for .cpuprofile and .heapprofile: ours must be an option there, or VS Code asks.
  assert.equal(opt.priority, 'option');
  const defPatterns = def.selector.map((x) => x.filenamePattern);
  assert.ok(!defPatterns.some((p) => /cpuprofile|heapprofile|^\*\.json$/.test(p)), defPatterns.join());
  assert.ok(opt.selector.some((x) => x.filenamePattern === '*.cpuprofile'));
});
test('every contributed command is registered, and every registered flameGraph command is contributed', () => {
  const s = activate();
  const contributed = pkg.contributes.commands.map((c) => c.command);
  for (const c of contributed) assert.ok(s.commands.has(c), `not registered: ${c}`);
  for (const c of s.commands.keys()) if (c.startsWith('flameGraph.')) assert.ok(contributed.includes(c), `not in package.json: ${c}`);
  const menus = Object.values(pkg.contributes.menus).flat().map((m) => m.command);
  for (const c of menus) assert.ok(contributed.includes(c), `menu names an unknown command: ${c}`);
});
test('activation shows nothing: no message, no panel, no editor', () => {
  const s = activate();
  assert.equal(s.log.info.length + s.log.warn.length + s.log.error.length, 0);
  assert.equal(s.log.panel, undefined);
  assert.equal(s.log.opened.length, 0);
  assert.equal(s.log.external.length, 0);
});
test('Open as Flame Graph picks the default view type for pprof and the optional one for .cpuprofile and .json', async () => {
  const s = activate();
  for (const f of ['/x/cpu.pb.gz', '/x/a.cpuprofile', '/x/trace.json', '/x/Trace-20260101T000000.json', '/x/out.folded']) await s.vscode.commands.executeCommand('flameGraph.openWithViewer', s.vscode.Uri.file(f));
  assert.deepEqual(s.log.commands.filter((c) => c[0] === 'vscode.openWith').map((c) => c[2]), ['flameGraph.editor', 'flameGraph.other', 'flameGraph.other', 'flameGraph.editor', 'flameGraph.editor']);
});
test('webview HTML: strict CSP, nonce scripts only, no remote URLs', () => {
  for (const html of [editorHtml({ cspSource: 'vscode-resource:', flameUri: 'f.js', scriptUri: 'a.js', styleUri: 'a.css', title: '<x>' }), panelHtml({ cspSource: 'vscode-resource:', flameUri: 'f.js', scriptUri: 'p.js', styleUri: 'p.css', title: 't' })]) {
    const csp = /content="([^"]+)"/.exec(html)[1];
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /connect-src|unsafe-eval|unsafe-inline|https?:/);
    const nonce = /'nonce-([^']+)'/.exec(csp)[1];
    for (const tag of html.match(/<script[^>]*>/g)) assert.ok(tag.includes(`nonce="${nonce}"`), tag);
    // nothing is loaded from a remote origin (the footer links open only on a click)
    assert.doesNotMatch(html, /<(script|img|iframe)[^>]+src="https?:|<link[^>]+href="https?:/);
  }
  assert.match(editorHtml({ cspSource: 'c', flameUri: 'f', scriptUri: 's', styleUri: 'y', title: '<x>' }), /<title>&lt;x&gt;<\/title>/);
});
test('media scripts: no network calls, no eval', () => {
  for (const f of ['flame.js', 'viewer.js', 'panel.js']) {
    const t = fs.readFileSync(path.join(ROOT, 'media', f), 'utf8');
    assert.doesNotMatch(t, /\bfetch\(|XMLHttpRequest|WebSocket|new Function|\beval\(|https?:\/\//, f);
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'src', 'core'))) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'src', 'core', f), 'utf8'), /require\('(https?|net|http2|dgram|tls)'\)/, f);
});

// ---------- the viewer ----------
test('viewer: the Node sample sends meta and the left heavy and time order arrays; switching views works', async () => {
  const s = activate();
  const { panel, doc } = await openEditor(s, path.join(SAMPLES, 'sample-app.cpuprofile'));
  const meta = panel.posted.find((m) => m.type === 'meta');
  assert.equal(meta.format, 'cpuprofile');
  assert.equal(meta.formatLabel, 'V8 CPU profile');
  assert.equal(meta.views.length, 1);
  assert.deepEqual(meta.prefs, { mode: 'left', orientation: 'flame', table: true });
  const data = panel.posted.find((m) => m.type === 'data');
  assert.ok(data.merged.x instanceof Float64Array && data.chrono.frame instanceof Int32Array);
  assert.ok(data.names.includes('roundTrip'));
  assert.equal(data.merged.w[0], data.total);
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.ok(panel.webview.options.enableCommandUris.includes('flameGraph.getPro'));
  await panel.send({ type: 'shown' });
  assert.ok(doc.result);
  // a pprof file has two sample types: the second view arrives on request
  const go = await openEditor(s, path.join(SAMPLES, 'sample-go-cpu.pb.gz'));
  const gm = go.panel.posted.find((m) => m.type === 'meta');
  assert.deepEqual(gm.views.map((v) => v.label), ['samples (count)', 'cpu (nanoseconds)']);
  assert.equal(gm.current, 1);
  await go.panel.send({ type: 'view', id: 0 });
  const last = go.panel.posted[go.panel.posted.length - 1];
  assert.equal(last.type, 'data');
  assert.equal(last.view, 0);
  assert.equal(last.total, 152);
  assert.equal(last.chrono, null);
});
test('viewer: a broken file shows a message instead of a graph, nothing throws', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const { panel } = await openEditor(s, path.join(dir, 'prof', 'broken.pb.gz'));
  const meta = panel.posted.find((m) => m.type === 'meta');
  assert.match(meta.error, /not a profile the viewer knows|not a readable pprof/);
  assert.equal(panel.posted.filter((m) => m.type === 'data').length, 0);
  assert.equal(s.log.error.length, 0);
});
test('click to source: a frame opens its file at the line, found next to the profile or by suffix in the workspace', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  // the shipped sample: the recorded path does not exist here; the file next to the profile is used
  let e = await openEditor(s, path.join(SAMPLES, 'sample-app.cpuprofile'));
  let names = e.panel.posted.find((m) => m.type === 'data').names;
  await e.panel.send({ type: 'open', frame: names.indexOf('roundTrip') });
  let opened = s.log.opened[s.log.opened.length - 1];
  assert.equal(opened.fsPath, path.join(SAMPLES, 'sample-app.js'));
  // a copy in the workspace (prof/before.cpuprofile): found as prof/src/sample-app.js by name
  e = await openEditor(s, path.join(dir, 'prof', 'before.cpuprofile'));
  names = e.panel.posted.find((m) => m.type === 'data').names;
  await e.panel.send({ type: 'open', frame: names.indexOf('toCsv') });
  opened = s.log.opened[s.log.opened.length - 1];
  assert.equal(opened.fsPath, path.join(dir, 'prof', 'src', 'sample-app.js'));
  // a runtime frame: a note, no editor
  const n = s.log.opened.length;
  await e.panel.send({ type: 'open', frame: e.doc.result.frames.files.findIndex((f) => /^node:/.test(f)) });
  assert.equal(s.log.opened.length, n);
  assert.match(e.panel.posted[e.panel.posted.length - 1].text, /inside the runtime/);
});

// ---------- Pro tools ----------
test('Pro hotspots: CSV and JSON written next to the profile; a try counts after the table showed', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const r = await s.api.tools.hotspotsTool(s.vscode.Uri.file(path.join(dir, 'prof', 'cpu.pb.gz')));
  assert.equal(r.shown, true);
  assert.equal(path.basename(r.csv.fsPath), 'cpu.hotspots.csv');
  const csv = fs.readFileSync(r.csv.fsPath, 'utf8').split('\n');
  assert.equal(csv[0], 'rank,function,file,line,self_ms,self_pct,total_ms,total_pct');
  assert.match(csv[1], /^1,runtime\.madvise,/);
  const j = JSON.parse(fs.readFileSync(r.json.fsPath, 'utf8'));
  assert.equal(j.top.length, 50);
  assert.equal(j.unit, 'ms');
  assert.equal(j.total, 1520);
  assert.equal(s.api.pro.left('hotspots'), 0);
  assert.ok(s.log.status.some((t) => /the free try of "Hotspot report \(CSV, JSON\)" is used/.test(t)));
});
test('Pro export: HTML report next to the profile; Escape in the pick uses no try; the 2nd use opens the Zovo Pro panel', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const uri = s.vscode.Uri.file(path.join(dir, 'prof', 'before.cpuprofile'));
  s.ui.quick.push(undefined);
  assert.equal(await s.api.tools.exportTool(uri), undefined);
  assert.equal(s.api.pro.left('export'), 1);
  s.ui.quick.push((items) => items.find((i) => i.id === 'html'));
  const r = await s.api.tools.exportTool(uri);
  assert.equal(path.basename(r.uri.fsPath), 'before.flame.html');
  const html = fs.readFileSync(r.uri.fsPath, 'utf8');
  assert.match(html, /^<!DOCTYPE html>/);
  assert.ok(html.includes('new ZovoFlame.FlameView') && html.includes('roundTrip'));
  assert.equal(s.api.pro.left('export'), 0);
  assert.ok(s.log.info.some((m) => /Saved .*before\.flame\.html/.test(m.text)));
  const files = fs.readdirSync(path.join(dir, 'prof')).length;
  const msgs = s.log.info.length + s.log.warn.length;
  s.ui.quick.push((items) => items.find((i) => i.id === 'svg'));
  assert.equal(await s.api.tools.exportTool(uri), undefined);
  assert.match(s.log.info.concat(s.log.warn).slice(msgs).map((m) => m.text).join('\n'), /Export HTML or SVG report/);
  assert.equal(fs.readdirSync(path.join(dir, 'prof')).length, files);
});
test('Pro export: SVG image next to the profile (first use on another computer)', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  s.ui.quick.push((items) => items.find((i) => i.id === 'svg'));
  const r = await s.api.tools.exportTool(s.vscode.Uri.file(path.join(dir, 'prof', 'cpu.pb.gz')));
  assert.equal(path.basename(r.uri.fsPath), 'cpu.flame.svg');
  assert.match(fs.readFileSync(r.uri.fsPath, 'utf8'), /<svg [\s\S]*<title>runtime\.main/);
});
test('Pro diff: two files from the Explorer; the panel gets the red and blue graph and the table; the 2nd use shows the Zovo Pro panel', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  const b = s.vscode.Uri.file(path.join(dir, 'prof', 'before.folded'));
  const a = s.vscode.Uri.file(path.join(dir, 'prof', 'after.folded'));
  const r = await s.api.tools.diffTool(b, [b, a]);
  assert.equal(r.shown, true);
  const msg = s.log.panel.posted.find((m) => m.type === 'diff');
  assert.equal(msg.rows[0].name, 'render');
  assert.equal(msg.summary.newFunctions, 1);
  assert.ok(msg.graph.delta instanceof Float32Array && msg.graph.delta.length === msg.graph.frame.length);
  assert.equal(s.api.pro.left('diff'), 0);
  // Save table as CSV writes after.diff.csv; Swap redraws without using a try
  await s.log.panel.send({ type: 'saveCsv' });
  await tick(30);
  assert.match(fs.readFileSync(path.join(dir, 'prof', 'after.diff.csv'), 'utf8'), /^function,file,before_self_pct[\s\S]*\nrender,/);
  await s.log.panel.send({ type: 'swap' });
  await tick(50);
  assert.equal(s.log.panel.posted.filter((m) => m.type === 'diff').length, 2);
  const msgs = s.log.info.length + s.log.warn.length;
  const files = fs.readdirSync(path.join(dir, 'prof')).length;
  assert.equal(await s.api.tools.diffTool(b, [b, a]), undefined);
  const shownMsgs = s.log.info.concat(s.log.warn).slice(msgs).map((m) => `${m.text} ${JSON.stringify(m.opts)}`).join('\n');
  assert.match(shownMsgs, /Compare two profiles/);
  assert.equal(fs.readdirSync(path.join(dir, 'prof')).length, files);
  assert.equal(s.api.pro.left('export'), 1);
  assert.equal(s.log.external.length, 0);
});
test('Pro diff from the palette with a viewer open: the before profile is picked from the workspace, next to it first', async () => {
  const dir = tmpWs();
  const s = activate(dir);
  await openEditor(s, path.join(dir, 'prof', 'after.folded'));
  s.ui.quick.push((items) => items.find((i) => i.label === 'before.folded'));
  const r = await s.api.tools.diffTool();
  assert.equal(r.shown, true);
  assert.equal(r.before.name, 'before.folded');
  assert.equal(r.after.name, 'after.folded');
  const items = s.log.lastPick.items;
  assert.equal(items[0].label, 'before.folded', 'same folder and same kind first');
  assert.ok(items.some((i) => /Choose a file/.test(i.label)));
  assert.equal(s.log.lastPick.opts.ignoreFocusOut, true);
});

// ---------- README and text ----------
test('README: first screen has the main use, a screenshot of this product, the free list and the price; by Zovo; no rival names', () => {
  const md = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const first = md.split('\n').slice(0, 30).join('\n');
  assert.match(first, /^# Flame Graph & pprof Viewer/);
  assert.match(first, /images\/screenshot\.png/);
  assert.match(first, /Zovo Pro: USD 19 once/);
  assert.match(md, /by Zovo/);
  assert.doesNotMatch(md, /speedscope\.app|vscode-js-profile|rafaelha|go-prof|MaxMedia|sransara|Brendan|ms-vscode/i);
  assert.ok(fs.existsSync(path.join(ROOT, 'images', 'screenshot.png')));
});
test('support links name this listing and related Zovo tools', () => {
  const support = require('../src/support');
  assert.equal(support.SELF_ID, 'zovo.zovo-flame-graph');
  assert.ok(support.RELATED.length >= 3 && !support.RELATED.includes(support.SELF_ID));
  assert.equal(support.PRO.getPro, 'flameGraph.getPro');
});
test('proinfo: listing flame with the three tools and the tries key pro.js writes', () => {
  const cfg = require('../src/license/config');
  const { TRIAL_KEY, FEATURES } = require('../src/pro');
  assert.equal(cfg.listing, 'flame');
  assert.equal(cfg.pro_info.triesKey, TRIAL_KEY);
  assert.deepEqual(cfg.pro_info.tools.map((t) => t.title), Object.values(FEATURES).map((f) => f.title));
  assert.equal(require('../src/license').MODULE_VERSION, '2026-11-15.tries1');
  assert.equal(require('../src/pro').TRIAL_USES, 1);
});
