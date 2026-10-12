<p align="center">
  <img src="assets/logo.png" alt="Electron Debug MCP" width="180" height="180" />
</p>

<h1 align="center">Electron Debug MCP</h1>

<p align="center">
  <b>Eyes, hands, and DevTools for Electron apps.</b><br/>
  An MCP server your agent uses to launch or attach, see the window, and drive it.
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-1.9.4-0F766E?style=flat-square" />
  <img alt="84 tools" src="https://img.shields.io/badge/84_tools-0F766E?style=flat-square" />
  <img alt="7 resources" src="https://img.shields.io/badge/7_resources-115E59?style=flat-square" />
  <img alt="6 prompts" src="https://img.shields.io/badge/6_prompts-134E4A?style=flat-square" />
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white" />
  <img alt="Electron" src="https://img.shields.io/badge/Electron-CDP-47848F?style=flat-square&logo=electron&logoColor=white" />
  <img alt="license" src="https://img.shields.io/badge/license-ISC-F5A623?style=flat-square" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/electron-debug-mcp"><b>npm</b></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/amafjarkasi/electron-mcp-server"><b>GitHub</b></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/amafjarkasi/electron-mcp-server/blob/master/CHANGELOG.md"><b>changelog</b></a>
</p>

An agent that can only read your repo cannot see an Electron window. This server is that debugger. It runs locally, speaks MCP over stdio, and drives the app through the Chrome DevTools Protocol.

You add it to Cursor or Claude and ask in normal language. The client shows the agent every tool and its arguments. This page is the map of what those tools are for.

<table>
  <tr>
    <td width="33%" valign="top">
      <b>See</b><br/>
      <code>vision</code> screenshot, errors, and failed requests in one call.<br/>
      <code>snapshot</code> accessibility tree when CSS is the wrong handle.<br/>
      <code>diff_screenshot</code> compare the window to a PNG baseline.
    </td>
    <td width="33%" valign="top">
      <b>Drive</b><br/>
      <code>click</code> <code>hover</code> <code>scroll</code> <code>drag</code><br/>
      <code>click_ax</code> <code>type_ax</code> by accessible name.<br/>
      <code>assert_ui</code> returns pass or fail, not a crashed tool.
    </td>
    <td width="33%" valign="top">
      <b>Inspect</b><br/>
      Console, network, HAR, trace, CPU profile, heap, coverage.<br/>
      Main process, IPC, clipboard, downloads, permissions.<br/>
      <code>cdp_command</code> for any DevTools method not wrapped above.
    </td>
  </tr>
</table>

## Changelog

Full history, including 1.6 and 1.5, is in [`CHANGELOG.md` on GitHub](https://github.com/amafjarkasi/electron-mcp-server/blob/master/CHANGELOG.md). The same file ships in the npm package.

| Version | What landed |
| --- | --- |
| 1.9.4 | `set_permission` is visible to the page as granted. Clipboard reads and writes PNG. `drag` delivers `dataTransfer`. |
| 1.9.3 | Transparent logo, and a See / Drive / Inspect header so the npm page is not a bare list. |
| 1.9.2 | Changelog section on the README, linked to this file on GitHub. |
| 1.9.1 | README layout fix for the npm page: no empty table rows. |
| 1.9.0 | `delete_cookie`, `hover`, `scroll`, `drag`, `focus_window`, clipboard, `get_downloads`, `set_permission`. 84 tools. Prompts start from `vision` and `assert_ui`. |
| 1.8.0 | `click_ax` / `type_ax`, network stub, HAR, `assert_ui`, dialogs, deep links. |
| 1.7.0 | Coverage, file input, emulation, screencast, breakpoints, MHTML, virtual clock, window topology. |
| 1.6.0 | `vision`, `snapshot`, response bodies, CPU profile, heap snapshot, IPC tap, screenshot diff. |

## What you can ask it to do

| Job | What happens |
| --- | --- |
| Explain a blank or crashed window | Screenshot, console errors, exceptions, and the process log |
| Check that a button or form works | Wait for the control, click or type, then assert the result |
| See why a request failed | Network log, response body, or a stubbed URL |
| Catch a visual regression | Compare the window to a PNG baseline |
| Inspect main-process or IPC bugs | Window list, main-process JavaScript, IPC log, deep links |
| Debug an app that is already open | Find its PID or debug port and attach, without killing it |
| Investigate a slow or leaky screen | Trace, CPU profile, heap snapshot, coverage, or a short audit |
| Window, clipboard, or a download | Focus a window, read or write clipboard text, report the saved path |
| Scroll, drag, or a permission prompt | Scroll into view, drag between two elements, allow or deny camera, notifications, and geolocation |

Examples you can type:

- “Start `D:/apps/my-app` and tell me if the window is blank.”
- “Click Go, type Ada in the name field, and tell me if the status says saved.”
- “What failed on the network, and what did the response body say?”
- “Attach to the Electron app I already launched and screenshot it.”
- “Profile the settings screen, then save a heap snapshot.”

## Install

Cursor and Claude should spawn the process. Running it in a terminal looks idle because it is waiting on stdio.

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

Claude Desktop config files:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

From a clone, build once and point `command` at `node` with the absolute path to `build/index.js`. Templates live in the repo under `examples/`.

```bash
npm install
npm run build
```

`electron` is an optional dependency. Attach-only installs can use `npm install --omit=optional`. On Windows, if npm skips postinstall, run `scripts/fix-electron.cmd`. Requires Node 18 or newer.

## How a session works

`start_app` launches your app with a DevTools port. `find_apps` reads Electron PIDs from the process list. `discover_apps` probes local ports. `attach` and `attach_by_pid` join an app that is already running.

The reply includes an id, usually `electron-…`. Later calls pass that id as `processId`.

`stop_app` kills a process this server started. On an attached session it only detaches. Either way the session leaves `list_apps`.

Pass `inspectMain: true` when the bug is in the main process. That opens a separate `--inspect` port. These tools need it: `evaluate_main`, `main_state`, `ipc_tap`, `get_ipc_log`, `webcontents_topology`, `open_deep_link`, `focus_window`, `get_clipboard`, `set_clipboard`, `get_downloads`, `set_permission`.

Page targets keep console, network, and audit events buffered between calls.

### Start, look, act, check

```json
{ "appPath": "/path/to/your-app", "inspectMain": true }
```

`start_app` returns `id`. Use it as `processId`.

`vision` returns a screenshot plus the page URL, console errors, and failed requests. `snapshot` returns the accessibility tree when a CSS selector is the wrong handle.

```json
{ "processId": "electron-…", "name": "Submit", "role": "button" }
```

```json
{ "processId": "electron-…", "textIncludes": "Saved", "maxConsoleErrors": 0 }
```

`click_ax` clicks the button named Submit. `assert_ui` returns `pass: true` or `pass: false` with one line per check. A failed check is not a crashed tool.

`get_network_log` lists requests. `get_response_body` needs a finished `requestId` from that log. `network_stub` fulfills or fails a URL pattern. `stop_app` removes the session.

`doctor` is the first call when the environment itself is suspect: missing Electron binary, no display, sandbox flags.

## Tools

### Connect

| Tool | What it does |
| --- | --- |
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

### See

| Tool | What it does |
| --- | --- |
| `vision` | Screenshot plus page, console errors, and network failures. |
| `snapshot` | Accessibility tree (role and name). |
| `screenshot` | PNG or JPEG. `selector` clips to an element. Returns an image. |
| `save_screenshot` | Same capture, written to a file. |
| `diff_screenshot` | Compare a PNG baseline. Reports identical and byte similarity. |
| `highlight` | Scroll a selector into view and paint a DevTools overlay. |
| `get_dom` | `outerHTML` for the document or one selector. |
| `query_selector` | Tag, id, class, and text for matches. |
| `page_info` | URL, title, readyState, userAgent. |
| `list_targets` | DevTools targets with role: page, worker, browser, other. |
| `webcontents_topology` | BrowserWindow and webContents mapped to DevTools targets. Needs `inspectMain`. |

### Act

| Tool | What it does |
| --- | --- |
| `navigate` | Go to a URL, then optionally wait for load. |
| `reload` | Page targets only. Never the Node inspect target. |
| `wait_for` | Selector, hidden, enabled, text, URL, console text, or node count. |
| `click` | Click the center of a CSS selector. |
| `hover` | Move the pointer over a selector. Does not click. |
| `scroll` | Wheel the page or an element. A selector and no deltas scrolls it into view. |
| `drag` | Press, move, and release. Also delivers `text/plain` on `dataTransfer` so HTML5 `drop` listeners see the payload. |
| `click_ax` | Click by accessibility name and optional role. |
| `type_text` | Insert text. Optional focus, clear, and Enter. |
| `type_ax` | Focus by accessibility name, then insert text. |
| `press_key` | Key or shortcut, with modifiers. |
| `set_file_input` | Set files on `<input type="file">`. |
| `handle_dialog` | Auto accept or dismiss the next alert, confirm, or prompt. |
| `assert_ui` | URL, title, text, selector, expression, console-error budget. Failed checks return `pass: false`. |
| `open_deep_link` | Emit `open-url` and `second-instance`. Needs `inspectMain`. |
| `pause` / `resume` | Pause JavaScript. `resume` then disables the debugger so screenshots and input work again. |

### Page state

| Tool | What it does |
| --- | --- |
| `evaluate` | JavaScript in a page, worker, or browser target. |
| `evaluate_main` | JavaScript in the main process. Needs `inspectMain`. |
| `main_state` | Windows, app paths, versions, metrics. Needs `inspectMain`. |
| `get_console_messages` | Buffered console, log, and exceptions. |
| `set_console_live` | Also stream non-error console lines as MCP logs. Errors always notify. |
| `get_logs` | Process stdout and stderr. |
| `get_cookies` / `set_cookie` | Read or write cookies. `file://` pages usually need an explicit `http(s)` url or domain. |
| `delete_cookie` | Remove a cookie by name. Same url or domain rules as `set_cookie`. |
| `get_clipboard` / `set_clipboard` | OS clipboard text and PNG (`imageDataUrl`). Needs `inspectMain`. |
| `get_storage` / `set_storage` | `localStorage` or `sessionStorage`. |
| `clear_buffers` | Drop console, network, logs, ipc, and audit buffers. |

### Network

| Tool | What it does |
| --- | --- |
| `get_network_log` | Buffered request and response events. |
| `get_response_body` | Body for a `requestId` after the response finishes. |
| `export_har` | HAR 1.2 from that buffer. No bodies. |
| `block_urls` | Block URL patterns. |
| `set_extra_headers` | Extra headers on later requests. |
| `network_stub` | Fulfill or fail URLs that match a pattern. The same pattern replaces the previous rule. |
| `clear_network_stubs` | Turn request interception off. |
| `wait_network_idle` | Wait until nothing is in flight and the log has been quiet. |
| `get_downloads` | Save downloads from every webContents session and return `savePath`. Call it before the download, or pass `url` to start one. Needs `inspectMain`. |

### Profile

| Tool | What it does |
| --- | --- |
| `get_performance_metrics` | Renderer performance counters. |
| `perf_audit` | Metrics, navigation and paint timing, recent audit issues. Not full Lighthouse. |
| `get_audit_issues` | Buffered audit issues: cookies, CORS, mixed content, deprecations. |
| `start_tracing` / `stop_tracing` | One trace per session. Open the JSON in `chrome://tracing` or Perfetto. |
| `start_cpu_profile` / `stop_cpu_profile` | V8 `.cpuprofile`. |
| `heap_snapshot` | V8 `.heapsnapshot`. |
| `start_coverage` / `stop_coverage` | Precise JS coverage, optional CSS. |
| `emulate` | Viewport, user agent, geolocation, media. `clear` resets. |
| `virtual_clock` | Pause or advance virtual time. |
| `start_screencast` / `stop_screencast` | Bounded frame buffer. Stop can write the last frame. |
| `capture_mhtml` | Save the page as MHTML. |
| `set_breakpoint` / `remove_breakpoint` | Break on a script URL and line. |
| `resolve_stack` | Map stack frames to source snippets. |

### Main process

| Tool | What it does |
| --- | --- |
| `ipc_tap` / `get_ipc_log` | Record IPC in the main process, then read it. Needs `inspectMain`. |
| `focus_window` | Show and focus a window. `windowId` comes from `webcontents_topology`. `show: false` skips showing a hidden window. Needs `inspectMain`. |
| `set_permission` | Allow or deny a permission prompt and grant it in the page (`checked: "granted"`). Unlisted permissions are denied after this is installed. Needs `inspectMain`. |
| `cdp_command` | Any DevTools `Domain.method` the wrappers above do not cover. |

## Prompts

| Prompt | When |
| --- | --- |
| `debug_blank_window` | White or blank window. Starts from `vision`. |
| `find_renderer_exception` | Console errors and exceptions. |
| `ui_smoke_check` | Wait, interact, then `assert_ui`. |
| `attach_and_screenshot` | Find or attach, then `vision` and console errors. |
| `vision_then_act` | `vision`, then `snapshot`, act, verify. |
| `ax_then_assert` | `snapshot`, then `click_ax` / `type_ax`, then `assert_ui`. |

## Resources

| URI | What |
| --- | --- |
| `electron://server` | Version, uptime, platform, capability counts. |
| `electron://info` | Managed processes. |
| `electron://targets` | DevTools targets. |
| `electron://process/{id}` | One session, including recent errors. |
| `electron://logs/{id}` | stdout and stderr. |
| `electron://console/{id}` | Buffered console. |
| `electron://cdp/{processId}/{targetId}` | One target. |

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
| Main-process tools fail | Restart with `inspectMain: true`. That covers `evaluate_main`, `main_state`, `ipc_tap`, `get_ipc_log`, `webcontents_topology`, `open_deep_link`, `focus_window`, clipboard, `get_downloads`, and `set_permission`. |
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

| Script | What it does |
| --- | --- |
| `npm run ensure-electron` | Download or repair the Electron binary. |
| `npm run build` | Compile TypeScript to `build/`. |
| `npm start` | Run the server on stdio. |
| `npm run doctor` | Build, then call `doctor` and read `electron://server`. |
| `npm run pack:check` | `npm pack --dry-run`. |

`src/index.ts` registers tools, prompts, and resources. `src/process-manager.ts` owns sessions and DevTools. `src/power-tools.ts` holds the higher-level helpers. Logs go to stderr so stdout stays clean for JSON-RPC.

The npm package contains `build/`, `assets/`, this README, `LICENSE`, and `CHANGELOG.md`.

## License

[ISC](https://github.com/amafjarkasi/electron-mcp-server/blob/master/LICENSE)
