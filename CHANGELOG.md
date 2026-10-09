# Changelog

## 1.5.1

### Fixes
- **`inspectMain` / `evaluate_main`** — allocate a pinned `--inspect` port and merge the main-process `node` target (Chromium’s remote-debugging port never listed it when using `--inspect=0`).
- **Session cleanup** — remove stopped/crashed sessions from the managed map; abandon in-progress CDP traces on stop/exit; make `stop_app` idempotent.
- **`reload`** — only reloads page targets (skips the Node inspect target).
- **`resume`** — calls `Debugger.disable` after resume so screenshots/input are not blocked.

### Tests & CI
- Expanded E2E smoke: `inspectMain`, navigate/reload/pause/resume/cdp/`get_logs`, all 6 resources, real discover ports, post-stop cleanup.
- Smoke hardens: exact 36 tools + 3 prompts, `attach_by_pid` must succeed, cookies via `http://`, `set_console_live` asserts MCP log notifications.
- Wired `monitor.test.mjs` into `npm test`; unit tests for `preferAppTarget` / `allocateLocalPort` / delete-on-stop.
- CI matrix: Ubuntu + Xvfb, Windows, and macOS; Node 22; `typecheck` + `npm pack --dry-run`.

### Packaging & security
- Package `files` / `.npmignore` / repository metadata; `prepublishOnly` builds before publish.
- `electron` moved to `optionalDependencies` (attach-only installs can use `--omit=optional`).
- Broader output-path blocklist (`.aws`, `.gnupg`, …) + symlink-ancestor resolution.

### Docs
- README refreshed for v1.5 behavior (inspectMain, cleanup, CI platforms, troubleshooting).

## 1.5.0

- Element screenshots (`selector` clip), cookies/storage tools, CDP tracing, `attach_by_pid` / `find_apps`, UI automation (`wait_for`, click/type/press), 36 tools · 6 resources · 3 prompts.
