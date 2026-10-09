# Agent checklist: doctor → find_apps → diagnose

Use this when an Electron session looks broken or the environment is unknown.

1. **`doctor`** — Confirm package version, Node/platform, Electron binary resolves (`ELECTRON_PATH` or `require('electron')`), and whether `ELECTRON_MCP_NO_SANDBOX` / `CI` / `DISPLAY` are set. Note `managedProcessCount` and the free-port sample.
2. **`find_apps`** — List running Electron PIDs and any `--remote-debugging-port` / `--inspect` from argv. Use `discover_apps` if you only know a port range.
3. **`diagnose`** — Attach or start first if needed, then diagnose the session (port reachability, targets, recent console errors).

If `doctor` shows no Electron binary, run `npm run ensure-electron` (or set `ELECTRON_PATH`). If `DISPLAY` is unset on Linux CI, use Xvfb or headless-friendly flags (`ELECTRON_MCP_NO_SANDBOX=1` when appropriate).
