'use strict';
// Flame Graph & pprof Viewer by Zovo: opens CPU and memory profiles (.cpuprofile, .heapprofile, Chrome trace JSON,
// Go pprof, collapsed stacks, perf script, speedscope JSON) as a flame graph in a VS Code editor tab. No network, no
// telemetry. Activation shows nothing: no message, no popup. The viewer opens only for files the user opens.
const vscode = require('vscode');
const { FlameEditorProvider, VIEW_TYPE, OTHER_VIEW_TYPE, viewTypeFor } = require('./editor');
const { createTools } = require('./tools');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const support = require('./support');
const { createReach } = require('./reach');
const reachConfig = require('./reach-config');

const PREFIX = 'flameGraph';
const EXT_ID = 'zovo.zovo-flame-graph';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);

function activate(context) {
  const sub = (d) => context.subscriptions.push(d);
  let rating = { success() {}, failure() {} };
  try { rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'Flame Graph & pprof Viewer' }); } catch (e) { /* rating is optional */ }
  support.registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  const pro = createPro({ vscode, context });
  const reach = createReach({ vscode, ...reachConfig, context, licensed: () => !!pro.licensed, shown: () => setting('showProTools', true) !== false });
  reach.registerCtx();
  sub(pro.onDidChange(() => reach.refresh()));

  const samples = vscode.Uri.joinPath(context.extensionUri, 'samples');
  const isSample = (uri) => uri && uri.toString().startsWith(samples.toString());
  const provider = new FlameEditorProvider(context, {
    reach: () => reach,
    onSuccess: (doc) => { if (!isSample(doc.uri)) rating.success(doc.uri); },
    onFailure: () => rating.failure(),
  });
  for (const vt of [VIEW_TYPE, OTHER_VIEW_TYPE]) sub(vscode.window.registerCustomEditorProvider(vt, provider, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }));
  const tools = createTools({ context, provider, pro });

  const reg = (id, fn) => sub(vscode.commands.registerCommand(id, async (...a) => {
    try { return await fn(...a); } catch (e) { vscode.window.showErrorMessage(String((e && e.message) || e)); return undefined; }
  }));
  const target = (uri) => (uri && uri.scheme ? uri : (uri && uri.surface ? uri : undefined));
  reg(`${PREFIX}.openWithViewer`, (uri) => {
    let u = uri && uri.scheme ? uri : undefined;
    if (!u) {
      const ed = vscode.window.activeTextEditor;
      if (ed) u = ed.document.uri;
      else {
        const tab = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup && vscode.window.tabGroups.activeTabGroup.activeTab;
        if (tab && tab.input && tab.input.uri) u = tab.input.uri;
      }
    }
    if (!u) { vscode.window.showInformationMessage('Select a profile file first (.cpuprofile, .heapprofile, .json, .pb.gz, .folded, perf script text).'); return undefined; }
    return vscode.commands.executeCommand('vscode.openWith', u, viewTypeFor(u));
  });
  reg(`${PREFIX}.openSample`, () => vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(samples, 'sample-app.cpuprofile'), OTHER_VIEW_TYPE));
  reg(`${PREFIX}.openGoSample`, () => vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(samples, 'sample-go-cpu.pb.gz'), VIEW_TYPE));
  reg(`${PREFIX}.openWalkthrough`, () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#${PREFIX}.start`, false));
  reg(`${PREFIX}.diff`, reach.wrap((uri, uris) => tools.diffTool(target(uri), uris)));
  reg(`${PREFIX}.export`, reach.wrap((uri) => tools.exportTool(target(uri))));
  reg(`${PREFIX}.hotspots`, reach.wrap((uri) => tools.hotspotsTool(target(uri))));
  sub(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${PREFIX}.showProTools`)) reach.refresh(); }));
  sub(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));
  return { provider, tools, pro };
}

function deactivate() {}

module.exports = { activate, deactivate };
