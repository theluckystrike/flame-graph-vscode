# Flame Graph & pprof Viewer 0.1.0 (zovo.zovo-flame-graph)

New listing, staged only. NICHE5 row 1, built by lane NEWB11.

- vsix: out/NEWB11-dist/zovo.zovo-flame-graph/zovo.zovo-flame-graph-0.1.0.vsix
- sha256: 8730b007e9f873b337958d7e1979d0120df27fb60444b8e8fe884776e4f159f1
- Unit tests: 244 of 244 pass (Node test runner: profile readers, streaming JSON reader, pprof decoder, tree builder, reports, extension and Pro tools with the vscode stub, license, rating).
- Real-app gate: VS Code 1.142.0 on port 9411 through buildslot, run f2 on this exact vsix: 82 PASS, 0 FAIL (out/NEWB11-data/flame/flame-gate-f2.tsv and .json, screenshots in out/NEWB11-data/flame/shots). Run f1 on the same vsix had 26 FAIL: from the fourth third-party file on, the gate could not reach the webview pages over CDP while two other gates shared the machine (the screenshots show the viewer drawn). f2 passed with no change to the vsix. Dev runs d1 to d6 (on earlier dev builds) came before; the one FAIL left in d6 was a gate check: it read the cursor line right ("line 14", want 14) but did not accept that reading. The check now accepts the active line number or the status bar position.

## What it is

- Display name: Flame Graph & pprof Viewer (26 characters). Search phrase "flame graph" comes first. The description starts with "Flame graph viewer".
- Keywords: flame graph, pprof, cpuprofile, profiler, performance. Engines: ^1.75.0, so it installs in Cursor and Windsurf.
- Free core: a custom editor that opens .cpuprofile and .heapprofile (Node.js, Chrome DevTools), Chrome trace JSON, Go pprof (.pb.gz, .pprof, .prof), collapsed stacks (.folded, .collapsed), perf script text and speedscope JSON. Flame graph or icicle chart, left heavy or time order, search with the share of the total, click to zoom, a table of self and total per function, Ctrl or Cmd + click (or double-click a row) to open the source line, a picker for every thread or sample type. JSON and text files are read in a stream in a worker thread.
- Zovo Pro tools (1 free try each, module 2026-11-15.tries1, listing tag "flame"): Compare two profiles (red and blue diff flame graph, regression table, CSV); Export HTML or SVG report (one standalone file); Hotspot report (CSV and JSON).
- No popups, toasts or nags on open. No network calls (webview CSP default-src 'none' with nonce scripts; no fetch or socket code).

## Samples used

- Shipped: samples/sample-app.cpuprofile (recorded by Zovo with the Node.js CPU profiler (`node --cpu-prof`) from samples/sample-app.js, our own program) and samples/sample-go-cpu.pb.gz (recorded by Zovo with Go runtime/pprof from samples/sample-go/main.go, our own program; it names Go standard library functions, BSD-3-Clause).
- Real-app gate (not shipped): profiles recorded on this Mac from our own programs (Node.js CPU profile, heap profile and trace events of indexer.js, a Chrome-style trace written from that recording, Go CPU and heap profiles, a Go before/after pair); sample profiles from the speedscope repository, commit fe804e6, MIT (Chrome 116 trace, Chrome 65 sucrase.cpuprofile, Chrome 69 heap profile, Chrome 70 worker trace, pprof simple.prof, two linux perf script files, a Java collapsed-stacks file, two speedscope files, a Hermes trace, a cut-off trace, a Node 10 .cpuprofile); broken files (text named .pb.gz, a Python cProfile file named .prof, a .cpuprofile cut in the middle); a generated 252 MB trace with 1.5 million events.

## Known limits

- VS Code opens .cpuprofile and .heapprofile in its own table view. Our viewer opens from the flame button in that view's title bar or the right-click menu; Reopen Editor With makes it the default.
- Plain .json, .txt and .log profiles open only through Open as Flame Graph, so other JSON files are never taken over.
- pprof files have no sample order, so time order is off for them.
- The SVG export is checked by unit tests (file name, bars, tooltips, escaping); the gate checks the HTML export on disk and that the SVG choice is offered.
- Source links work when the file is next to the profile or in the open workspace (node_modules is not searched). Paths from another machine are matched by file name and the longest matching end of the path; runtime frames (node:internal and the like) have no file to open.
- The README image goes through vsce's GitHub rewrite. The repo theluckystrike/flame-graph-vscode is not pushed yet, so the image shows only after the repo is pushed.
