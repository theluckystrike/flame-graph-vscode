# Third-party notices

## Code

No third-party code is included. The flame graph renderer (`media/flame.js`), the streaming JSON reader, the pprof protocol buffer decoder and every profile reader in `src/core` are written for this extension (MIT, see LICENSE). gzip data is inflated with Node's built-in `zlib`. The license module in `src/license` and the rating module in `src/rate.js` are Zovo's own shared modules.

## Sample files

- `samples/sample-app.cpuprofile` was recorded by Zovo with `node --cpu-prof` from `samples/sample-app.js`, a small program written for this extension. The path of the script in the profile was changed to `/home/dev/order-report/sample-app.js`.
- `samples/sample-go-cpu.pb.gz` was recorded by Zovo with Go's `runtime/pprof` from `samples/sample-go/main.go`, a small program written for this extension and built with `-trimpath`. The profile also names functions of the Go standard library (BSD-3-Clause, https://go.dev/LICENSE); it contains their names and file paths only, no Go source code.

The format names pprof, speedscope, perf and Chrome trace refer to the file formats this extension reads. This extension is not made by, or affiliated with, the authors of those tools.
