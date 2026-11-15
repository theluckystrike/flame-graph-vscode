# Changelog

## 0.1.0

- First release. Opens .cpuprofile, .heapprofile, Chrome trace JSON, Go pprof (.pb.gz, .pprof, .prof), collapsed stacks, perf script text and speedscope JSON as a flame graph, offline.
- Flame graph or icicle chart, left heavy or time order, search with the share of the total, click to zoom, a table of self and total per function.
- Ctrl or Cmd + click a bar to open its source line when the file is in the workspace.
- Files are read in a stream in a worker thread, so large profiles open without freezing the editor.
- Zovo Pro tools: Compare two profiles; Export HTML or SVG report; Hotspot report (CSV, JSON). 1 free try each.
