<p align="center">
  <img src="assets/logo.svg" alt="Electron Debug MCP" width="96" height="96" />
</p>

<h1 align="center">Electron Debug MCP</h1>

<p align="center">
  Launch or attach to an Electron app and let an agent see the window, drive it, and read DevTools.<br/>
  MCP over stdio · Chrome DevTools Protocol · 75 tools · 7 resources · 6 prompts
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/electron-debug-mcp">npm</a>
  ·
  <a href="./CHANGELOG.md">changelog</a>
  ·
  <a href="./LICENSE">ISC</a>
</p>

The server keeps stdout clean for JSON-RPC. Logs go to stderr. Tool schemas live on the MCP tools; this page is the map.

## Install

Published as [`electron-debug-mcp`](https://www.npmjs.com/package/electron-debug-mcp). Cursor and Claude should spawn it. Running it in a terminal looks idle because it is waiting on stdio.

```json
{
  "mcpServers": {
    "electron-debug": {
      "command": "npx",
      "args": ["-y", "electron-debug-mcp"],
      "env": {
        "ELECTRON_MCP_NO_SANDBOX": "1"
      }
    }
  }
}
```

Templates: [`examples/cursor-mcp.json`](./examples/cursor-mcp.json) · [`examples/claude-desktop-config.json`](./examples/claude-desktop-config.json)

Claude Desktop config files:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

From a clone, build once and point `command` at `node` with the absolute path to `build/index.js`. Template: [`examples/cursor-mcp.local.json`](./examples/cursor-mcp.local.json).

```bash
npm install
npm run build
```

`electron` is an optional dependency. Attach-only installs can use `npm install --omit=optional` and skip the binary download. On Windows, if npm skips postinstall, run `scripts/fix-electron.cmd`.

Requires Node 18 or newer.

## Session

`start_app` launches your app with `--remote-debugging-port` (a free port if you omit `debugPort`). `find_apps` reads Electron PIDs and ports from the process list. `discover_apps` probes a local port range. `attach` and `attach_by_pid` join an app that is already running.

`stop_app` kills a process this server started. On an attached session it only detaches. Either way the session leaves `list_apps`.

Pass `inspectMain: true` to `start_app` when you need the main process. That opens a separate `--inspect` port and merges the Node target into `list_targets`. These tools need it: `evaluate_main`, `main_state`, `ipc_tap`, `get_ipc_log`, `webcontents_topology`, `open_deep_link`.

Page targets get Runtime, Log, Network, Page, and Audits enabled, so console, network, and audit issues keep buffering between calls.

## Tools

| | |
| --- | --- |
| **Connect** | |
| `start_app` | Launch with remote debugging. `inspectMain` adds the main-process target. |
| `attach` | Join an existing `--remote-debugging-port`. |
| `attach_by_pid` | Resolve that port from a main-process PID. |
| `find_apps` | Electron PIDs plus debug and inspect ports from argv. |
| `discover_apps` | Probe a local CDP port range (`9222`–`9235` by default). |
| `find_installed_apps` | Packaged apps under Applications, Program Files, and `.desktop` files. |
| `list_apps` | Sessions this server owns or has attached. |
| `stop_app` | Kill an owned process, or detach an attached one. |
| `diagnose` | Port, target roles, recent console errors. |
| `doctor` | This machine: Node, Electron binary, env flags, free port. |
| **See** | |
| `vision` | Screenshot plus page, console errors, and network failures. |
| `snapshot` | Accessibility tree (role and name). |
| `screenshot` | PNG or JPEG. `selector` clips to an element. Returns an image. |
| `save_screenshot` | Same capture, written to a file. |
| `diff_screenshot` | Compare a PNG baseline. Reports identical and byte similarity. |
| `highlight` | Scroll a selector into view and paint a CDP overlay. |
| `get_dom` | `outerHTML` for the document or one selector. |
| `query_selector` | Tag, id, class, and text for matches. |
| `page_info` | URL, title, readyState, userAgent. |
| `list_targets` | CDP targets with role: page, worker, browser, other. |
| `webcontents_topology` | BrowserWindow and webContents mapped to CDP targets. Needs `inspectMain`. |
| **Act** | |
| `navigate` | `Page.navigate`, then optional load wait. |
| `reload` | Page targets only. Never the Node inspect target. |
| `wait_for` | Selector, hidden, enabled, text, URL, console text, or node count. |
| `click` | Click the center of a CSS selector. |
| `click_ax` | Click by accessibility name and optional role. |
| `type_text` | Insert text. Optional focus, clear, and Enter. |
| `type_ax` | Focus by accessibility name, then insert text. |
| `press_key` | Key or shortcut, with modifiers. |
| `set_file_input` | Set files on `<input type="file">`. |
| `handle_dialog` | Auto accept or dismiss the next alert, confirm, or prompt. |
| `assert_ui` | URL, title, text, selector, expression, console-error budget. Failed checks return `pass: false`. |
| `open_deep_link` | Emit `open-url` and `second-instance`. Needs `inspectMain`. |
| `pause` / `resume` | `Debugger.pause` / `resume`. `resume` then disables the debugger so screenshots and input work again. |
| **Page state** | |
| `evaluate` | JavaScript in a page, worker, or browser target. |
| `evaluate_main` | JavaScript in the main process. Needs `inspectMain`. |
| `main_state` | Windows, app paths, versions, metrics. Needs `inspectMain`. |
| `get_console_messages` | Buffered console, log, and exceptions. |
| `set_console_live` | Also stream non-error console lines as MCP logs. Errors always notify. |
| `get_logs` | Process stdout and stderr. |
| `get_cookies` / `set_cookie` | Read or write cookies. `file://` pages usually need an explicit `http(s)` url or domain. |
| `get_storage` / `set_storage` | `localStorage` or `sessionStorage`. |
| `clear_buffers` | Drop console, network, logs, ipc, and audit buffers. |
| **Network** | |
| `get_network_log` | Buffered request and response events. |
| `get_response_body` | Body for a `requestId` after the response finishes. |
| `export_har` | HAR 1.2 from that buffer. No bodies. |
| `block_urls` | `Network.setBlockedURLs`. |
| `set_extra_headers` | Extra headers on later requests. |
| `network_stub` | Fulfill or fail URLs that match a pattern. The same pattern replaces the previous rule. |
| `clear_network_stubs` | Turn Fetch interception off. |
| `wait_network_idle` | Wait until nothing is in flight and the log has been quiet. |
| **Profile** | |
| `get_performance_metrics` | `Performance.getMetrics`. |
| `perf_audit` | Metrics, navigation and paint timing, recent Audits issues. Not full Lighthouse. |
| `get_audit_issues` | Buffered Audits issues (cookies, CORS, mixed content, deprecations). |
| `start_tracing` / `stop_tracing` | One CDP trace per session. Open the JSON in `chrome://tracing` or Perfetto. |
| `start_cpu_profile` / `stop_cpu_profile` | V8 `.cpuprofile`. |
| `heap_snapshot` | V8 `.heapsnapshot`. |
| `start_coverage` / `stop_coverage` | Precise JS coverage, optional CSS. |
| `emulate` | Viewport, user agent, geolocation, media. `clear` resets. |
| `virtual_clock` | Pause or advance virtual time. |
| `start_screencast` / `stop_screencast` | Bounded frame buffer. Stop can write the last frame. |
| `capture_mhtml` | `Page.captureSnapshot`. |
| `set_breakpoint` / `remove_breakpoint` | `Debugger.setBreakpointByUrl`. |
| `resolve_stack` | Map stack frames to source snippets. |
| **Main process and escape hatch** | |
| `ipc_tap` / `get_ipc_log` | Record IPC in the main process, then read it. Needs `inspectMain`. |
| `cdp_command` | Any `Domain.method` the wrappers above do not cover. |

## Prompts

| Prompt | When |
| --- | --- |
| `debug_blank_window` | White or blank window. |
| `find_renderer_exception` | Console errors and exceptions. |
| `ui_smoke_check` | Wait, interact, verify. |
| `attach_and_screenshot` | Find or attach, then screenshot and collect errors. |
| `vision_then_act` | `vision`, then `snapshot`, act, verify. |
| `ax_then_assert` | `snapshot`, then `click_ax` / `type_ax`, then `assert_ui`. |

## Resources

| URI | What |
| --- | --- |
| `electron://server` | Version, uptime, platform, capability counts. |
| `electron://info` | Managed processes. |
| `electron://targets` | CDP targets. |
| `electron://process/{id}` | One session, including recent errors. |
| `electron://logs/{id}` | stdout and stderr. |
| `electron://console/{id}` | Buffered console. |
| `electron://cdp/{processId}/{targetId}` | One target. |

## A loop that works

1. `doctor` if the environment is new.
2. `start_app` (with `inspectMain` if you will touch main) or `find_apps` then `attach`.
3. `vision` or `snapshot`.
4. `get_console_messages` with `level: "error"`, plus `get_audit_issues` and `get_logs`.
5. `wait_for`, then `click` / `click_ax` / `type_text` / `type_ax`, then `assert_ui`.
6. `get_network_log`, `get_response_body`, or `network_stub` when the bug is a request.
7. `stop_app` when you are done.

```json
{ "appPath": "/path/to/your-app", "inspectMain": true }
```

```json
{ "processId": "electron-…", "name": "Submit", "role": "button" }
```

```json
{ "processId": "electron-…", "textIncludes": "Saved", "maxConsoleErrors": 0 }
```

## Configuration

| Variable | Effect |
| --- | --- |
| `ELECTRON_PATH` | Use this Electron binary. |
| `ELECTRON_MCP_NO_SANDBOX=1` | Always pass `--no-sandbox`. Also applied when `CI=true` or Linux has no `DISPLAY`. |
| `ELECTRON_MCP_ALLOWED_ROOTS` | `;` or `\|` separated allowlist for `start_app` paths. Unset means unrestricted. |
| `ELECTRON_MCP_OUTPUT_ROOTS` | Allowlist for screenshot, trace, profile, and heap paths. The sensitive-path blocklist still applies. |
| `ELECTRON_MIRROR` | Mirror for the Electron zip. |
| `ELECTRON_CACHE` | Zip cache directory. |

```powershell
$env:ELECTRON_MCP_ALLOWED_ROOTS="D:\apps;D:\src"
```

Screenshot and trace writes are rejected under credential and system roots (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `/etc`, `/proc`, `/usr`, `/root`, `C:\Windows`, `C:\Program Files`, and similar). Existing ancestors are resolved so macOS `/tmp` → `/private/tmp` still matches.

## Security

This is a local debugger. It can start binaries, evaluate JavaScript, and read page content, cookies, storage, and network bodies. Set `ELECTRON_MCP_ALLOWED_ROOTS` on a shared machine. Attach only to apps you trust. Do not expose stdio on an open network. Buffers and exported traces can contain secrets from the app under test.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `Electron failed to install correctly` | `npm run ensure-electron`, or `scripts/fix-electron.cmd` on Windows. |
| `allowScripts` warning | Expected on newer npm. Run the ensure script. |
| Terminal hangs on `node build/index.js` | The process is waiting for an MCP client. Configure Cursor or Claude to spawn it. |
| `evaluate_main`, `main_state`, `ipc_tap`, or `open_deep_link` fails | Restart with `inspectMain: true`, or pass a node `targetId` from `list_targets`. |
| Screenshot fails after `pause` | Call `resume`. It disables the debugger. |
| `set_cookie` fails on `file://` | Pass an `http(s)` `url` or `domain`. |
| `wait_for` or `click` cannot find the node | Wait for it, then screenshot. |
| `get_response_body` fails | Use a `requestId` from a finished response. |
| `start_app` path rejected | The path is outside `ELECTRON_MCP_ALLOWED_ROOTS`. |
| Output path rejected | Avoid home credential dirs and system dirs, or set `ELECTRON_MCP_OUTPUT_ROOTS`. |
| `attach_by_pid` cannot find a port | The app must have been started with `--remote-debugging-port`. Check `find_apps`. |
| `list_apps` empty after stop | Expected. Stopped sessions are removed. |
| Linux headless | `ELECTRON_MCP_NO_SANDBOX=1` and a display such as Xvfb. |
| Empty trace | Call `start_tracing` before the slow path. One trace at a time. |

## Develop

```bash
npm test
```

That builds, runs unit tests, and runs the MCP smoke test against `fixtures/minimal-electron-app`. CI runs the same suite on Ubuntu (Xvfb), Windows, and macOS.

| Script | |
| --- | --- |
| `npm run ensure-electron` | Download or repair the Electron binary. |
| `npm run build` | Compile TypeScript to `build/`. |
| `npm start` | Run the server on stdio. |
| `npm run doctor` | Build, then call `doctor` and read `electron://server`. |
| `npm run pack:check` | `npm pack --dry-run`. |

Layout: `src/index.ts` registers tools, prompts, and resources. `src/process-manager.ts` owns sessions and CDP. `src/power-tools.ts` holds the higher-level helpers. `fixtures/minimal-electron-app` is the smoke app.

The npm tarball contains `build/`, `assets/`, this README, `LICENSE`, and `CHANGELOG.md`.

Release: bump `package.json`, merge to `master`, and tag `vX.Y.Z` to match. [`.github/workflows/publish.yml`](./.github/workflows/publish.yml) runs `npm stage publish`. A maintainer approves with a one-time password:

```bash
npm stage list
npm stage approve <stage-id>
```

Approve only after `npm stage list` shows status `staged`. If the version is older than the current `latest` tag, the workflow stages it as `release-<version>` so `latest` stays put.

## Contributing

Run `npm test` before a PR. Keep stdout free of logs.

## License

[ISC](./LICENSE)
