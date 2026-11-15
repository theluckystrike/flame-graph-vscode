'use strict';
// REACH1: this listing's Pro tools for the viewer toolbar row and the Explorer entries (src/reach.js).
module.exports = {
  prefix: 'flameGraph',
  triesKey: 'flameGraph.proTrial',
  slot: '#toolbar',
  tools: [
    { id: 'diff', title: 'Compare two profiles', command: 'flameGraph.diff' },
    { id: 'export', title: 'Export HTML or SVG report', command: 'flameGraph.export' },
    { id: 'hotspots', title: 'Hotspot report (CSV, JSON)', command: 'flameGraph.hotspots' },
  ],
};
