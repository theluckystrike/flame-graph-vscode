'use strict';
// Webview HTML for the flame graph viewer and the Pro tool panels. No vscode import, so tests can check the CSP:
// default-src 'none', no remote origin, no connect-src, scripts only with the page nonce.
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

const PREFIX = 'flameGraph';
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function csp(cspSource, n) {
  return ["default-src 'none'", `style-src ${cspSource} 'nonce-${n}'`, `script-src 'nonce-${n}'`, `img-src ${cspSource} data:`, `font-src ${cspSource}`].join('; ');
}

/** p: { cspSource, flameUri, scriptUri, styleUri, title, showSupportLinks, head?(nonce), nonce? } */
function editorHtml(p) {
  const n = p.nonce || crypto.randomBytes(18).toString('base64url');
  const footer = footerHtml(PREFIX, p.showSupportLinks !== false, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(p.cspSource, n)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attr(p.styleUri)}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
${typeof p.head === 'function' ? p.head(n) : ''}
<title>${attr(p.title)}</title>
</head>
<body>
<div id="toolbar" role="toolbar" aria-label="Flame graph">
  <span id="fmt" class="chip" title="Format, profile and total"></span>
  <label class="sel" id="viewBox" hidden><span id="viewLbl">Profile</span> <select id="view" aria-label="Profile, thread or sample type"></select></label>
  <span class="grp" role="group" aria-label="Order">
    <button class="tb" id="modeLeft" aria-pressed="true" title="Merge identical call paths and put the heaviest first (L)">Left heavy</button>
    <button class="tb" id="modeTime" aria-pressed="false" title="Keep the order of the samples (T)">Time order</button>
  </span>
  <span class="grp" role="group" aria-label="Direction">
    <button class="tb" id="orFlame" aria-pressed="true" title="Root at the bottom (F)">Flame</button>
    <button class="tb" id="orIcicle" aria-pressed="false" title="Root at the top (I)">Icicle</button>
  </span>
  <span class="search"><input id="search" type="search" placeholder="Search functions" aria-label="Search functions" spellcheck="false"><span id="matches" aria-live="polite"></span></span>
  <button class="tb" id="reset" title="Show the whole profile again (Escape)">Reset zoom</button>
  <button class="tb" id="tableBtn" aria-pressed="true" title="Show or hide the function table (B)">Table</button>
</div>
<div id="err" role="alert" hidden></div>
<div id="warn" hidden></div>
<div id="busy">Reading the profile...</div>
<div id="main">
  <div id="graph"><div id="scroller" tabindex="0" aria-label="Flame graph. Click a bar to zoom, Ctrl or Cmd + click opens its source."><canvas id="flame"></canvas><div id="spacer"></div></div></div>
  <div id="details" aria-live="polite"><span class="hint">Click a bar to zoom in. Ctrl or Cmd + click (or double-click) opens the source line when the file is in your workspace. Ctrl or Cmd + wheel zooms at the mouse.</span></div>
  <div id="tablePane">
    <div id="tableHead"><span id="tableNote"></span></div>
    <div id="tableWrap"><table id="fn" aria-label="Functions by self and total"><thead><tr>
      <th data-k="self" class="num sorted" aria-sort="descending">Self</th><th data-k="selfPct" class="num">Self %</th><th data-k="total" class="num">Total</th><th data-k="totalPct" class="num">Total %</th><th data-k="name">Function</th><th data-k="file">File</th>
    </tr></thead><tbody></tbody></table></div>
  </div>
</div>
<div id="tip" role="tooltip" hidden></div>
<div id="footer"></div>
<template id="zovo-footer">${footer}</template>
<script nonce="${n}" src="${attr(p.flameUri)}"></script>
<script nonce="${n}" src="${attr(p.scriptUri)}"></script>
</body>
</html>`;
}

/** Panel of a Pro tool. p: { cspSource, flameUri, scriptUri, styleUri, title, head?(nonce), showSupportLinks } */
function panelHtml(p) {
  const n = p.nonce || crypto.randomBytes(18).toString('base64url');
  const footer = footerHtml(PREFIX, p.showSupportLinks !== false, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(p.cspSource, n)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attr(p.styleUri)}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
${typeof p.head === 'function' ? p.head(n) : ''}
<title>${attr(p.title)}</title>
</head>
<body class="panel">
<div id="toolbar" role="toolbar"><strong id="title"></strong><span id="actions"></span></div>
<div id="app"><p class="muted">Working...</p></div>
<div id="tip" role="tooltip" hidden></div>
<div id="footer">${footer}</div>
<script nonce="${n}" src="${attr(p.flameUri)}"></script>
<script nonce="${n}" src="${attr(p.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { editorHtml, panelHtml, csp };
