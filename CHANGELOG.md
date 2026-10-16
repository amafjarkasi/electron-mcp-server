# Changelog

## 1.10.0

### Features
- **`emulate_network`** — offline, latency, and download/upload throughput. `clear` restores a normal network.
- **`select_option`** — choose a `<select>` option by value or visible label.
- **`set_window_bounds`** — move or resize a `BrowserWindow` (`inspectMain`). Omitted fields stay unchanged. Does not show a hidden window.
- **`print_pdf`** — write the page to a PDF via `Page.printToPDF`.
- Surface: **88 tools · 7 resources · 6 prompts**.

## 1.9.4

### Fixes
- **`set_permission`** also calls `Browser.grantPermissions` and returns the page permission state as `checked`.
- **`set_clipboard` / `get_clipboard`** read and write a PNG via `imageDataUrl`, in addition to text.
- **`drag`** sends an HTML5 drag with `text/plain` on `dataTransfer`, so a `drop` listener receives the payload.

## 1.9.3

### Docs
- Replaced `assets/logo.png`. The old file had a checkerboard painted into the pixels. The new mark is a transparent PNG rendered from `assets/logo.svg`.
- README header is a logo, badge row, and a See / Drive / Inspect board. Tool lists stay in headed tables so npm does not drop rows.

## 1.9.2

### Docs
- README has a Changelog section that lists 1.9.2 through 1.6.0 and links to this file on GitHub.

## 1.9.1

### Docs
- README renders on npm as headed sections instead of one table with empty category rows. Adds the logo, a short badge row, and the full tool list under Connect, See, Act, Page state, Network, Profile, and Main process.

## 1.9.0

### Features — session quick wins
- **`delete_cookie`** — remove a cookie by name (`Network.deleteCookies`).
- **`hover`** — move the pointer over a CSS selector without clicking.
- **`focus_window`** — show and focus a `BrowserWindow` (`inspectMain`). `show: false` focuses without showing a hidden window.
- **`get_clipboard` / `set_clipboard`** — OS clipboard text (`inspectMain`).
- **`get_downloads`** — arm `will-download` on every webContents session, save into a directory, and report `savePath` (`inspectMain`). Optional `url` starts a download on the first session.
- **`scroll`** — wheel a page or element, or scroll a selector into view.
- **`drag`** — press, move, and release between two selectors.
- **`set_permission`** — allow or deny Electron permission prompts (`notifications`, `media`, `geolocation`, …) on every session (`inspectMain`). Unlisted permissions are denied once the handler is installed.
- Prompts `debug_blank_window`, `find_renderer_exception`, `ui_smoke_check`, and `attach_and_screenshot` now start from `vision` / `assert_ui` instead of a screenshot-only loop.
- Surface: **84 tools · 7 resources · 6 prompts**.

## 1.8.0

### Features — accessibility act + network control
- **`click_ax` / `type_ax`** — click or type by accessibility name and role.
- **`network_stub` / `clear_network_stubs`** — Fetch interception (fulfill or fail by `urlPattern`).
- **`wait_network_idle`** — wait until the network buffer is quiet.
- **`export_har`** — write the buffered network log as HAR 1.2.
- **`handle_dialog`** — auto accept or dismiss JavaScript dialogs.
- **`highlight`** — scroll a selector into view and paint a CDP overlay.
- **`assert_ui`** — structured url / title / text / selector / expression checks.
- **`open_deep_link`** — emit `open-url` and `second-instance` (requires `inspectMain`). Returns the URL app listeners recorded and mirrors it to `window.__DEEP_LINK__`.
- Prompt **`ax_then_assert`** — snapshot → click_ax/type_ax → assert_ui.
- Surface: **75 tools · 7 resources · 6 prompts**.

## 1.7.0

### Features — next creative ten
- **`start_coverage` / `stop_coverage`** — V8 precise JS coverage (+ optional CSS rule usage).
- **`set_file_input`** — `DOM.setFileInputFiles` for `<input type=file>`.
- **`emulate`** — device metrics / UA / geolocation / media (or `clear`).
- **`start_screencast` / `stop_screencast`** — bounded `Page.startScreencast` frame buffer.
- **`set_breakpoint` / `remove_breakpoint`** — `Debugger.setBreakpointByUrl`.
- **`resolve_stack`** — map frames to source snippets.
- **`perf_audit`** — Lighthouse-lite (metrics + nav/paint timing + Audits buffer).
- **`capture_mhtml`** — `Page.captureSnapshot` MHTML artifact.
- **`virtual_clock`** — `Emulation.setVirtualTimePolicy`.
- **`webcontents_topology`** — BrowserWindow / webContents ↔ CDP target map.
- Prompt **`vision_then_act`** — vision → snapshot → act → verify agent loop.
- Surface: **65 tools · 7 resources · 5 prompts**.

### Docs
- npm install / `npx electron-debug-mcp` quick start; cheatsheet for vision loop + new tools.

## 1.6.0

### Features — creative power tools
- **`snapshot`** — CDP accessibility tree (`Accessibility.getFullAXTree`).
- **`vision`** — one-shot screenshot + page + console errors + network failures (image + JSON).
- **`get_response_body`** — `Network.getResponseBody` by `requestId` (buffers now record `loadingFinished`).
- **`block_urls`** / **`set_extra_headers`** — Network request shaping.
- **`get_performance_metrics`** — `Performance.getMetrics`.
- **`start_cpu_profile`** / **`stop_cpu_profile`** / **`heap_snapshot`** — V8 Profiler + HeapProfiler artifacts.
- **`main_state`** — Electron windows / paths / versions / metrics via `evaluate_main`.
- **`ipc_tap`** / **`get_ipc_log`** — main-process IPC observability (requires `inspectMain`).
- **`diff_screenshot`** — baseline vs current PNG (exact + byte similarity).
- **`get_audit_issues`** — Chromium Audits domain buffer (enabled with monitoring).
- **`find_installed_apps`** — scan common install locations for packaged Electron apps.
- Surface: **52 tools · 7 resources · 4 prompts**.

### Hardening
- CDP power tools wrap calls with timeouts; CPU profile / tracing abandoned on `stop_app` / crash via `registerProcessCleanup`.
- `snapshot` caps node count; `vision` soft-fails page/screenshot; heap waits on progress + rejects empty snapshots.
- `diff_screenshot` validates PNG magic; IPC tap is defensive per-webContents; installed-app scan is bounded.
- Smoke soft-skips flaky creative tools and cleans temp profile/heap/diff artifacts.
- Per-command CDP timeouts (`CDP_COMMAND_TIMEOUT_MS`) with transport-only reconnect; late connect sockets closed; `/json/list` uses `AbortSignal.timeout`.
- Default debug/inspect ports via `allocateLocalPort`; process ids include a random suffix to avoid collisions.
- CPU profile start is serialized (`starting` lock); stop keeps the session on failure so callers can retry; cleanup stops Profiler on forget.
- Heap snapshot binds listeners on the same CDP client that sends `takeHeapSnapshot`; disables HeapProfiler in `finally`.
- `main_state` / `ipc_tap` throw on main-process `ok: false`; IPC tap sets the installed flag before wiring listeners.
- Main-process evaluates load Electron via `require` when present, else `_linkedBinding` (`app` / `BrowserWindow`) for CDP’s `browser_init` inspect context; `ipc_tap` treats `ipcMain` as optional.
- Smoke uses a shared `finally` for stop/detach/temp cleanup; CPU/diff/heap soft paths clean artifacts even on failure.

## 1.5.1

### Fixes
- **`inspectMain` / `evaluate_main`** — allocate a pinned `--inspect` port and merge the main-process `node` target (Chromium’s remote-debugging port never listed it when using `--inspect=0`).
- **Session cleanup** — remove stopped/crashed sessions from the managed map; abandon in-progress CDP traces on stop/exit; make `stop_app` idempotent.
- **`reload`** — only reloads page targets (skips the Node inspect target).
- **`resume`** — calls `Debugger.disable` after resume so screenshots/input are not blocked.
- **Path realpath** — canonicalize output/app paths via ancestor `realpath` so macOS `/tmp`→`/private/tmp` (and `/etc`→`/private/etc`) matches allow/block lists.
- **Headless fixture** — smoke fixture shows a window only when `CI` **and** `DISPLAY` are set; `paintWhenInitiallyHidden` keeps CDP screenshots working headless on Windows/macOS.

### Features
- **`doctor`** — local env health JSON (package version, Node, platform, Electron binary resolve, env flags, managed process count, optional free-port sample).
- **`electron://server`** — read-only resource for package version, uptime, Node/platform, and capability counts without calling a tool.
- Shared **`SERVER_VERSION`** from `package.json` for McpServer + `doctor`.
- Prompt **`attach_and_screenshot`** (`processId?` / `debugPort?`) — find/attach → screenshot + console errors.
- Surface: **37 tools · 7 resources · 4 prompts**.

### Tests & CI
- Expanded E2E smoke: `inspectMain`, navigate/reload/pause/resume/cdp/`get_logs`, all resources, real discover ports, post-stop cleanup.
- Smoke hardens: ≥ required tools/prompts (incl. `doctor` + `attach_and_screenshot`), `attach_by_pid` must succeed, cookies via `http://`, `set_console_live` asserts MCP log notifications.
- Wired `monitor.test.mjs` into `npm test`; unit tests for `preferAppTarget` / `allocateLocalPort` / delete-on-stop / realpath-aware paths.
- CI matrix: Ubuntu + Xvfb, Windows, and macOS; Node 22; `typecheck` + `npm pack --dry-run`.

### Packaging & security
- Package `files` / `.npmignore` / repository metadata; `prepublishOnly` builds before publish.
- `electron` moved to `optionalDependencies` (attach-only installs can use `--omit=optional`).
- Broader output-path blocklist (`.aws`, `.gnupg`, …) + symlink-ancestor resolution.

### Docs
- README refreshed for v1.5 behavior (inspectMain, cleanup, CI platforms, troubleshooting).
- Cheatsheet: `doctor` + `attach_and_screenshot` + `electron://server`; `npm run doctor` CLI; example checklist `examples/doctor-checklist.md`; `CONTRIBUTING.md`.

## 1.5.0

- Element screenshots (`selector` clip), cookies/storage tools, CDP tracing, `attach_by_pid` / `find_apps`, UI automation (`wait_for`, click/type/press), 36 tools · 6 resources · 3 prompts.
