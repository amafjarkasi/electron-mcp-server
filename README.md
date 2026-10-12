<p align="center">
  <img src="assets/logo.svg" alt="Electron Debug MCP" width="96" height="96" />
</p>

<h1 align="center">Electron Debug MCP</h1>

<p align="center">
  Launch or attach to an Electron app and let an agent see the window, drive it, and read DevTools.<br/>
  MCP over stdio · Chrome DevTools Protocol · 84 tools · 7 resources · 6 prompts
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/electron-debug-mcp">npm</a>
  ·
  <a href="./CHANGELOG.md">changelog</a>
  ·
  <a href="./LICENSE">ISC</a>
</p>

The server keeps stdout clean for JSON-RPC. Logs go to stderr.

This page is the human guide: what the server is for, how you use it, and which tool does which job. Once Cursor or Claude has started it, each tool also publishes its arguments. You do not need this file to learn every field.

## What it is for

An agent that can only read your repo cannot see an Electron window. This server is the debugger it is missing. It launches the app, or attaches to one you already started, then lets the agent look, click, and read DevTools on your machine.

| You are trying to… | What the agent can do |
| --- | --- |
| Explain a blank or crashed window | Screenshot it, read console errors, exceptions, and the process log |
| Check that a button or form works | Wait until the control is there, click or type, then assert the result |
| See why a request failed | Read the network log and response body, or stub the URL |
| Catch a visual regression | Compare a screenshot to a PNG baseline |
| Inspect main-process or IPC bugs | List windows, evaluate in main, record IPC, deliver a deep link |
| Debug an app that is already open | Find its PID or debug port and attach, without killing it |
| Investigate a slow or leaky screen | Trace, CPU profile, heap snapshot, coverage, or a short performance audit |
| Move a window, the clipboard, or a download | Focus a window, read or write clipboard text, and report the path a file was saved to |
| Scroll, drag, or a permission prompt | Scroll a control into view, drag between two elements, or allow or deny notifications, camera, and geolocation |

It is a local debugger, not a hosted service. The agent and the Electron app both run on your computer.

## How you use it

You do not call the tools yourself. You add the server to Cursor or Claude, then ask in normal language. The client shows the agent the tool list and fills in arguments.

Things you can type:

- “Start `D:/apps/my-app` and tell me if the window is blank.”
- “Click Go, type Ada in the name field, and tell me if the status says saved.”
- “What failed on the network, and what did the response body say?”
- “Attach to the Electron app I already launched and screenshot it.”
- “Profile the settings screen while I click through it, then save a heap snapshot.”

A session has an id, usually `electron-…`. Later tool calls pass that id as `processId`. `stop_app` ends the session. If this server started the app, stop kills it. If you only attached, stop detaches and leaves your app running.

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

Pass `inspectMain: true` to `start_app` when you need the main process. That opens a separate `--inspect` port and merges the Node target into `list_targets`. These tools need it: `evaluate_main`, `main_state`, `ipc_tap`, `get_ipc_log`, `webcontents_topology`, `open_deep_link`, `focus_window`, `get_clipboard`, `set_clipboard`, `get_downloads`, `set_permission`.

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
| `hover` | Move the pointer over a selector. Does not click. |
| `scroll` | Wheel the page or an element. A selector and no deltas scrolls it into view. |
| `drag` | Press on one selector, move to another, and release. |
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
| `delete_cookie` | Remove a cookie by name. Same url or domain rules as `set_cookie`. |
| `get_clipboard` / `set_clipboard` | OS clipboard text. Needs `inspectMain`. |
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
| `get_downloads` | Arm `will-download` on every webContents session, save files into a directory (default OS temp), and return `savePath`. Call it before the download, or pass `url` to start one. Needs `inspectMain`. |
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
| `focus_window` | Show and focus a `BrowserWindow`. `windowId` comes from `webcontents_topology`. `show: false` skips `show()`. Needs `inspectMain`. |
| `set_permission` | Allow or deny an Electron permission prompt (`notifications`, `media`, `geolocation`, …) on every session. Unlisted permissions are denied after this is installed. Needs `inspectMain`. |
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

## A session, end to end

Ask the agent to start the app. Under the hood that is `start_app`. Set `inspectMain` when the bug is in the main process, IPC, clipboard, downloads, or deep links.

```json
{ "appPath": "/path/to/your-app", "inspectMain": true }
```

The reply includes `id`. That is `processId` for everything after.

Ask what the window shows. `vision` returns a screenshot plus the page URL, console errors, and failed requests. `snapshot` returns the accessibility tree (role and name) when a CSS selector is the wrong handle.

Ask it to act, then check:

```json
{ "processId": "electron-…", "name": "Submit", "role": "button" }
```

```json
{ "processId": "electron-…", "textIncludes": "Saved", "maxConsoleErrors": 0 }
```

`click_ax` clicks the button named Submit. `assert_ui` returns `pass: true` or `pass: false` with one line per check. A failed check is not a crashed tool.

When the question is a request, `get_network_log` lists what was sent. `get_response_body` needs a finished `requestId` from that log. `network_stub` can fulfill or fail a URL pattern so the UI can be exercised without the real API.

`stop_app` with the same `processId` removes the session.

`doctor` is the first call when the environment itself is suspect: missing Electron binary, no display, sandbox flags. The same checklist is in [`examples/doctor-checklist.md`](./examples/doctor-checklist.md).

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
| `evaluate_main`, `main_state`, `ipc_tap`, `open_deep_link`, `focus_window`, clipboard, or `get_downloads` fails | Restart with `inspectMain: true`, or pass a node `targetId` from `list_targets`. |
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
