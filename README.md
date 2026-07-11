<p align="center">
  <img src="assets/logo.svg" alt="Electron Debug MCP" width="160" height="160" />
</p>

<h1 align="center">⚡ Electron Debug MCP</h1>

<p align="center">
  <b>Debug Electron apps from Cursor &amp; Claude with real DevTools superpowers.</b><br/>
  <sub>Model Context Protocol server · Chrome DevTools Protocol · start / attach / screenshot / console / DOM / UI automation / tracing</sub>
</p>

<p align="center">
  <img src="assets/logo.png" alt="" width="72" height="72" />
</p>

<p align="center">
  <a href="#-60-second-quick-start"><img src="https://img.shields.io/badge/⚡_Quick_Start-0F766E?style=for-the-badge" alt="Quick Start" /></a>
  <a href="#-complete-tools-cheatsheet"><img src="https://img.shields.io/badge/🛠️_36_Tools-47848F?style=for-the-badge" alt="36 Tools" /></a>
  <a href="#-usage-examples"><img src="https://img.shields.io/badge/📚_Examples-0EA5E9?style=for-the-badge" alt="Examples" /></a>
  <a href="#-cursor--claude-desktop-setup"><img src="https://img.shields.io/badge/🖥️_Cursor_Ready-3178C6?style=for-the-badge" alt="Cursor Ready" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/📜_ISC-F59E0B?style=for-the-badge" alt="ISC" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/MCP-stdio_JSON--RPC-0F766E?style=flat-square" alt="MCP" />
  <img src="https://img.shields.io/badge/CDP-Chrome_DevTools-47848F?style=flat-square&logo=googlechrome&logoColor=white" alt="CDP" />
  <img src="https://img.shields.io/badge/Electron-desktop_apps-2B2E3A?style=flat-square&logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TS" />
  <img src="https://img.shields.io/badge/Node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node" />
  <img src="https://img.shields.io/badge/version-1.5.0-blue?style=flat-square" alt="version" />
  <img src="https://img.shields.io/badge/tests-unit_+_e2e_smoke-8B5CF6?style=flat-square" alt="tests" />
</p>

---

## 🌟 Overview

**Electron Debug MCP** is a local MCP server that gives AI coding agents **eyes, hands, and Chrome DevTools** inside your Electron app.

Instead of guessing from source alone, the agent can:

| 🎯 Goal | 🛠️ How |
| --- | --- |
| Boot your app under a debugger | `start_app` with `--remote-debugging-port` |
| Hook an app you already launched | `attach` · `attach_by_pid` · `find_apps` · `discover_apps` |
| See the UI | `screenshot` / `save_screenshot` (full page or **element clip** via `selector`) |
| Read renderer failures | `get_console_messages` (`level: "error"`) + exceptions |
| Stream console live | `set_console_live` → MCP log notifications |
| Inspect markup | `get_dom` / `query_selector` |
| Run JS in the page | `evaluate` |
| Run JS in **main** | `start_app({ inspectMain: true })` → `evaluate_main` |
| Cookies & web storage | `get_cookies` / `set_cookie` · `get_storage` / `set_storage` |
| Watch network | `get_network_log` |
| Drive the UI | `wait_for` → `type_text` / `press_key` → `click` → `navigate` |
| Perf deep-dive | `start_tracing` → reproduce → `stop_tracing` (open in `chrome://tracing`) |
| One-shot health check | `diagnose` |
| Full DevTools power | `cdp_command` (`Domain.method`) |

It speaks **MCP over stdio** (Cursor / Claude Desktop friendly), bridges to **Chrome DevTools Protocol**, buffers console + network on monitored page targets, and keeps **stdout clean** (all server logs go to **stderr**).

### 👤 Who it’s for

- 🧑‍💻 **Cursor / Claude users** pair-programming on Electron desktop apps  
- 🐛 **Maintainers** tired of “white screen / silent exception” bugs agents can’t see  
- 🧰 **Tooling authors** who need a stdio MCP ↔ CDP bridge for Electron/Chromium  

### 💬 Example things you can ask the agent

> “Start `D:/apps/my-app` on port 9222 and tell me if the renderer threw on boot.”  
> “Find my running Electron app, attach by PID, screenshot `#sidebar`, and dump localStorage.”  
> “Type into `#email`, press Enter, wait for Welcome, then list console errors.”  
> “Start a CDP trace, click through settings, stop tracing, and save the JSON.”  
> “Diagnose why this Electron window is blank.”

### 📊 At a glance

| | |
| :--- | :--- |
| 🔌 **Transport** | MCP **stdio** JSON-RPC |
| 🧬 **Debug bridge** | Chrome DevTools Protocol (Runtime · Page · Network · Debugger · Input · Log · Tracing) |
| 🚀 **App control** | Spawn Electron **or** attach by port / PID / process scan |
| 📦 **Surface area** | **36 tools** · **6 resources** · **3 prompts** · logging + resource list-changed |
| 🖥️ **Platforms** | Windows · macOS · Linux (CI: Xvfb + no-sandbox) |
| 📦 **Requires** | Node **≥ 18**, npm, one-time Electron binary download |
| 🛡️ **Safety** | Optional `ELECTRON_MCP_ALLOWED_ROOTS`; attach sessions detach-only on stop |
| ✅ **Verify** | `npm test` → unit + full MCP↔Electron smoke |

### ✅ Status

- 🟢 Ready for local agent-driven Electron debugging
- 🟢 E2E smoke: start → UI/automation → storage/cookies → tracing → find/attach-by-pid → stop
- 🟢 Windows binary repair: `scripts/fix-electron.cmd` when npm blocks postinstall
- 🟢 v1.5.0 — element screenshots, cookies/storage, tracing, attach-by-pid

---

## 📖 Table of contents

- [Overview](#-overview)
- [Why this exists](#-why-this-exists)
- [Feature tour](#-feature-tour)
- [60-second quick start](#-60-second-quick-start)
- [Cursor & Claude Desktop setup](#-cursor--claude-desktop-setup)
- [How it works](#-how-it-works)
- [Complete tools cheatsheet](#-complete-tools-cheatsheet)
- [Tools reference (all options)](#-tools-reference-all-options)
- [Resources](#-resources-read-only)
- [Prompts](#-prompts)
- [Usage examples](#-usage-examples)
- [Configuration](#-configuration)
- [npm scripts](#-npm-scripts)
- [Testing](#-testing)
- [Project layout](#-project-layout)
- [Security](#-security)
- [Troubleshooting](#-troubleshooting)
- [Contributing](#-contributing)
- [License](#-license)

---

## ✨ Why this exists

Electron bugs are often **invisible** to coding agents:

| 😣 Pain | 🙈 What agents usually see | 👁️ What this server adds |
| --- | --- | --- |
| Blank / white window | Source files only | Live **screenshot** + DOM (+ element clip) |
| Silent renderer crash | Nothing | **Console + exception** buffer (+ live stream) |
| Failed API calls | Guesswork | **Network** event log |
| Wrong route / URL | Unknown | **page_info** / `evaluate` |
| UI not responding | Can't interact | **click** / **type_text** / **press_key** / **wait_for** |
| Auth / state bugs | Blind | **cookies** + **localStorage/sessionStorage** |
| Perf jank | Guesswork | **CDP tracing** export |
| App already running | Manual port hunt | **find_apps** / **attach_by_pid** |
| Need DevTools power | Manual only | Full **cdp_command** escape hatch |

---

## 🚀 Feature tour

<table>
<tr>
<td width="50%" valign="top">

### 🔌 Lifecycle
- ▶️ `start_app` — launch with remote debugging (+ optional `inspectMain`)
- 🔗 `attach` — connect to an existing debug port
- 🆔 `attach_by_pid` — resolve port from process argv
- 🧭 `find_apps` — list Electron PIDs + debug ports
- 🔎 `discover_apps` — scan local CDP ports
- ⏹️ `stop_app` — kill owned / detach attached
- 📋 `list_apps` — sessions, ports, buffer counts
- 🩺 `diagnose` — port health + recent errors
</td>
<td width="50%" valign="top">

### 🔍 Inspection
- 📸 `screenshot` / 💾 `save_screenshot` — full page or **selector clip**
- 🌳 `get_dom` / `query_selector`
- 🧮 `evaluate` / `evaluate_main`
- 🍪 `get_cookies` / `set_cookie`
- 🗄️ `get_storage` / `set_storage`
- 🧾 `get_console_messages` — log/warn/error/exceptions
- 🌐 `get_network_log` — request/response/fail
- 📜 `get_logs` — Electron stdout/stderr
- 🎯 `list_targets` / `page_info`
</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🖱️ Interaction
- 🧭 `navigate` + load wait
- ⏳ `wait_for` — selector / hidden / enabled / count / text / URL / console
- 🖱️ `click` left/right/middle
- ⌨️ `type_text` (+ clear / Enter) · `press_key` (+ modifiers)
- 🔄 `reload` · ⏸️ `pause` · ▶️ `resume`
- 🧹 `clear_buffers`
</td>
<td width="50%" valign="top">

### 🧠 Agent UX & power
- 📝 MCP handshake **instructions**
- 💬 Prompts: blank window · exceptions · UI smoke
- 🏷️ Target roles: page / worker / browser / main
- 🔔 `set_console_live` + resource list-changed
- 📈 `start_tracing` / `stop_tracing`
- 🛡️ stderr-only diagnostics (stdio-safe)
- 🧰 `cdp_command` for any DevTools method
</td>
</tr>
</table>

## ⚡ 60-second quick start

```bash
git clone https://github.com/amafjarkasi/electron-mcp-server.git
cd electron-mcp-server
npm install
npm run ensure-electron
npm run build
npm test
```

### 🪟 Windows binary missing?

If npm warns about `allowScripts` / Electron postinstall:

```bat
.\scripts\fix-electron.cmd
```

That reinstalls Electron, extracts `electron.exe` with system `tar`, then runs tests.

---

## 🖥️ Cursor & Claude Desktop setup

### Cursor

1. `npm run build`
2. Open **Cursor → MCP settings**
3. Add (use your absolute path):

**Windows**

```json
{
  "mcpServers": {
    "electron-debug": {
      "command": "node",
      "args": ["D:/GH/electron-mcp-server/build/index.js"]
    }
  }
}
```

**macOS / Linux**

```json
{
  "mcpServers": {
    "electron-debug": {
      "command": "node",
      "args": ["/Users/you/code/electron-mcp-server/build/index.js"],
      "env": {
        "ELECTRON_MCP_NO_SANDBOX": "1"
      }
    }
  }
}
```

4. Restart Cursor  
5. Confirm tools: `start_app`, `attach`, `find_apps`, `screenshot`, `get_console_messages`, `click`, `start_tracing`, …

📄 Template: [`examples/cursor-mcp.json`](./examples/cursor-mcp.json)

### Claude Desktop

Same `mcpServers` block in `claude_desktop_config.json`, pointing at `build/index.js`.

> ⚠️ **Don’t** run `node build/index.js` in a normal terminal for daily use — it waits on stdio for an MCP client. Let Cursor/Claude spawn it.

---

## 🧩 How it works

```text
┌──────────────────────────┐
│  Cursor / Claude / MCP   │
│  client (agent)          │
└────────────┬─────────────┘
             │ stdio JSON-RPC
             ▼
┌──────────────────────────┐
│  Electron Debug MCP      │
│  🛠️ tools (36)           │
│  📡 resources            │
│  💬 prompts              │
│  📣 logging / list-changed│
└────────────┬─────────────┘
             │ spawn / attach / PID resolve
             │ CDP WebSocket
             ▼
┌──────────────────────────┐
│  Electron application    │
│  --remote-debugging-port │
│  Runtime·Page·Network·…  │
│  optional --inspect (main)│
└──────────────────────────┘
```

After `start_app` / `attach` / `attach_by_pid`, page targets get **Runtime / Log / Network / Page** enabled so console + network events keep buffering between tool calls.

**Finding a running app**

1. `find_apps` — OS process scan (Electron PIDs + `--remote-debugging-port` from argv)  
2. `discover_apps` — HTTP probe of local CDP ports (`/json/version`, `/json/list`)  
3. `attach` / `attach_by_pid` — open a managed session (detach-only on `stop_app`)

---

## 🗂️ Complete tools cheatsheet

| Category | Tools |
| --- | --- |
| 🚀 Lifecycle | `start_app` · `attach` · `attach_by_pid` · `find_apps` · `discover_apps` · `stop_app` · `list_apps` · `diagnose` |
| 🔍 Inspect | `screenshot` · `save_screenshot` · `get_dom` · `query_selector` · `evaluate` · `evaluate_main` · `get_cookies` · `set_cookie` · `get_storage` · `set_storage` · `get_console_messages` · `get_network_log` · `get_logs` · `list_targets` · `page_info` |
| 🖱️ Interact | `navigate` · `wait_for` · `click` · `type_text` · `press_key` · `reload` · `pause` · `resume` · `clear_buffers` · `set_console_live` |
| 🧰 Power | `start_tracing` · `stop_tracing` · `cdp_command` |

---

## 🛠️ Tools reference (all options)

All APIs below are MCP **tools**. Schemas match the live Zod definitions in `src/index.ts`.

### 🚀 Lifecycle

#### `start_app`
Launch Electron with remote debugging.

| Param | Type | Req | Default | Description |
| --- | --- | --- | --- | --- |
| `appPath` | string | ✅ | — | App directory or main script |
| `debugPort` | int `1024–65535` | ❌ | random `9222–9999` | CDP port |
| `extraArgs` | string[] | ❌ | `[]` | Extra CLI flags |
| `inspectMain` | bool | ❌ | `false` | Pass `--inspect=0` so main appears as a node target for `evaluate_main` |

**Auto flags:** `--remote-debugging-port`, `--enable-logging`, `--disable-gpu`, and `--no-sandbox` when `ELECTRON_MCP_NO_SANDBOX=1` / `CI=true` / no `DISPLAY`.

**Returns:** `id`, `pid`, `debugPort`, `targets`, `attached: false`, …

---

#### `attach`

| Param | Type | Req | Description |
| --- | --- | --- | --- |
| `debugPort` | int | ✅ | Existing DevTools port |
| `name` | string | ❌ | Friendly session name |

`stop_app` on attached sessions **detaches only** (does not kill the external app).

---

#### `attach_by_pid`

Attach by OS process id. Resolves `--remote-debugging-port` from the process command line (Linux/macOS/`ps`, Windows PowerShell). Falls back to listening sockets owned by the PID on Linux when needed.

| Param | Type | Req | Description |
| --- | --- | --- | --- |
| `pid` | int | ✅ | Electron **main** process id |
| `name` | string | ❌ | Friendly session name |

**Tip:** Prefer the main process PID from `find_apps` (helpers with `--type=renderer` / `gpu-process` are filtered unless they expose a debug port).

---

#### `find_apps`

List running Electron-like processes.

**Returns:** `{ apps: [{ pid, command, debugPort?, inspectPort?, likelyElectron }], count }`

Use this when you launched the app yourself and don’t remember the port.

---

#### `discover_apps`

| Param | Type | Default |
| --- | --- | --- |
| `startPort` | int | `9222` |
| `endPort` | int | `9235` |

HTTP-probes each port for Chromium/Electron DevTools (`/json/version` + `/json/list`).

---

#### `stop_app` — `{ processId }`  
#### `list_apps` — no params  
#### `diagnose` — optional `{ processId }` (omit = all sessions)

`diagnose` reports port reachability, target role counts, recent console errors, and monitoring state.

---

### 🔍 Inspection

#### `screenshot` / `save_screenshot`

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `processId` | string ✅ | — | Session id |
| `targetId` | string | first page | CDP page target |
| `format` | `png` \| `jpeg` | `png` | Image format |
| `quality` | int `0–100` | — | JPEG only |
| `selector` | string | — | **Element clip** — capture only that node’s bounding box |
| `path` | string ✅ (`save_screenshot`) | — | File path to write |

`screenshot` returns MCP **image** content (+ JSON meta including `clip` when used).  
`save_screenshot` writes bytes to disk and returns `{ path, bytes, mimeType, clip? }`.

---

#### `get_dom` — `{ processId, selector?, targetId? }`  
#### `query_selector` — `{ processId, selector, targetId?, limit?=20 }`  

#### `evaluate`

| Param | Type | Default |
| --- | --- | --- |
| `processId` | string ✅ | — |
| `expression` | string ✅ | — |
| `targetId` | string | auto |
| `role` | `page` \| `worker` \| `browser` \| `any` | `page` |
| `returnByValue` | bool | `true` |

#### `evaluate_main`

Evaluate in the Electron **main/node** CDP target.

| Param | Type | Default |
| --- | --- | --- |
| `processId` | string ✅ | — |
| `expression` | string ✅ | — |
| `targetId` | string | auto-pick node/main |
| `returnByValue` | bool | `true` |

**Requires** a node-like target — start with `inspectMain: true`, or pass an explicit `targetId` from `list_targets`.

---

#### `get_cookies`

| Param | Type | Description |
| --- | --- | --- |
| `processId` | string ✅ | — |
| `urls` | string[] | Optional URL filter |
| `targetId` | string | Page target |

#### `set_cookie`

| Param | Type | Description |
| --- | --- | --- |
| `processId` | string ✅ | — |
| `name` / `value` | string ✅ | Cookie pair |
| `url` / `domain` | string | One required (defaults `url` to `location.href` when possible) |
| `path` | string | Cookie path |
| `secure` / `httpOnly` | bool | Flags |
| `sameSite` | `Strict` \| `Lax` \| `None` | SameSite |
| `expires` | number | Unix seconds |
| `targetId` | string | Page target |

> Note: Chromium often rejects cookies on `file://` pages — use an `http(s)` URL or pass an explicit `url`/`domain`.

---

#### `get_storage` / `set_storage`

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `processId` | string ✅ | — | — |
| `kind` | `localStorage` \| `sessionStorage` | `localStorage` | Store |
| `entries` | `Record<string,string>` ✅ (`set`) | — | Keys to write |
| `clear` | bool (`set`) | `false` | Clear store before write |
| `targetId` | string | — | Page target |

---

#### `get_console_messages` — `{ processId, tail?, level? }`  
#### `get_network_log` — `{ processId, tail? }`  
#### `get_logs` — `{ processId, tail? }`  
#### `list_targets` — `{ processId? }`  
#### `page_info` — `{ processId, targetId? }` → url / title / readyState / userAgent  

Console capture includes `console.*`, CDP Log entries, and `Runtime.exceptionThrown`.

---

### 🖱️ Interaction & control

#### `navigate` — `{ processId, url, targetId?, waitUntilLoad?=true, timeoutMs?=15000 }`

#### `wait_for`

Provide **at least one** condition:

| Param | Meaning |
| --- | --- |
| `selector` | Element must exist |
| `hidden` | Element absent or not visible |
| `enabled` | Element exists and is not disabled |
| `countSelector` + `minCount` | `querySelectorAll` length ≥ min |
| `text` | `document.body.innerText` includes |
| `urlIncludes` | `location.href` includes |
| `consoleIncludes` | Buffered console text includes |
| `timeoutMs` | Default `10000` (max `120000`) |
| `screenshotOnTimeout` | Save a PNG under the OS temp dir on failure |
| `targetId` | Page target |

#### `click` — `{ processId, selector, targetId?, button?=left }`  
#### `type_text` — `{ processId, text, selector?, clear?, pressEnter?, targetId? }`  

#### `press_key`

| Param | Type | Description |
| --- | --- | --- |
| `processId` | string ✅ | — |
| `key` | string ✅ | e.g. `Enter`, `Escape`, `Tab`, `ArrowDown`, `a` |
| `selector` | string | Focus/click before keypress |
| `modifiers` | `Alt` \| `Control` \| `Meta` \| `Shift`[] | Chord modifiers |
| `repeat` | int `1–50` | Repeat count |
| `targetId` | string | Page target |

#### `set_console_live` — `{ enabled }`  
Errors/asserts **always** emit MCP logs. When enabled, log/info/warn/debug also stream live.

#### `reload` — `{ processId, targetId?, ignoreCache?=false }`  
#### `pause` / `resume` — `{ processId, targetId? }`  
#### `clear_buffers` — `{ processId, console?=true, network?=true, logs?=false }`  

---

### 🧰 Power / tracing

#### `start_tracing`

| Param | Type | Description |
| --- | --- | --- |
| `processId` | string ✅ | — |
| `categories` | string | Comma-separated CDP categories (default: timeline + v8 profiler set) |
| `targetId` | string | Page target |

Only one active trace per process session.

#### `stop_tracing`

| Param | Type | Description |
| --- | --- | --- |
| `processId` | string ✅ | — |
| `path` | string | Output JSON path (default: OS temp dir) |

**Returns:** `{ path, eventCount, elapsedMs, targetId, … }`  
Open the file in Chrome’s `chrome://tracing` (or Perfetto UI).

#### `cdp_command` — `{ processId, method:"Domain.method", targetId?, params? }`

Escape hatch for any DevTools method not wrapped above.

---

## 📡 Resources (read-only)

| URI | MIME | Description |
| --- | --- | --- |
| `electron://info` | JSON | Managed processes overview |
| `electron://targets` | JSON | All CDP targets |
| `electron://process/{id}` | JSON | Process details + webContents + recent errors |
| `electron://logs/{id}` | text | stdout/stderr capture |
| `electron://console/{id}` | JSON | Buffered console / exceptions |
| `electron://cdp/{processId}/{targetId}` | JSON | Target metadata |

---

## 💬 Prompts

| Prompt | Args | Use when |
| --- | --- | --- |
| `debug_blank_window` | `processId` | White/blank window |
| `find_renderer_exception` | `processId` | Hunting console/exceptions |
| `ui_smoke_check` | `processId`, `selector` | Wait → interact → verify |

---

## 📚 Usage examples

### 1️⃣ Start app → read title

```json
// tool: start_app
{
  "appPath": "D:/apps/my-electron-app",
  "debugPort": 9222,
  "extraArgs": ["--no-sandbox"]
}
```

```json
// tool: evaluate
{
  "processId": "electron-1710000000000",
  "expression": "document.title"
}
```

### 2️⃣ Attach to a running app (port)

```bash
electron . --remote-debugging-port=9222
```

```json
// tool: attach
{ "debugPort": 9222, "name": "my-app" }
```

### 3️⃣ Find by PID → attach

```json
// tool: find_apps
{}
```

```json
// tool: attach_by_pid
{ "pid": 43210, "name": "my-app" }
```

### 4️⃣ Catch console errors (+ live stream)

```json
// tool: set_console_live
{ "enabled": true }
```

```json
// tool: get_console_messages
{
  "processId": "electron-1710000000000",
  "level": "error",
  "tail": 50
}
```

Also: resource `electron://console/{processId}`

### 5️⃣ Screenshot — full page, file, or element

```json
// tool: screenshot
{ "processId": "electron-…", "format": "png" }
```

```json
// tool: save_screenshot
{
  "processId": "electron-…",
  "path": "D:/tmp/app.png",
  "format": "png"
}
```

```json
// tool: save_screenshot (element clip)
{
  "processId": "electron-…",
  "path": "D:/tmp/sidebar.png",
  "selector": "#sidebar"
}
```

### 6️⃣ UI automation flow

```json
// wait_for
{ "processId": "electron-…", "selector": "#email", "timeoutMs": 8000 }
```

```json
// type_text
{
  "processId": "electron-…",
  "selector": "#email",
  "text": "ada@example.com",
  "clear": true
}
```

```json
// press_key
{ "processId": "electron-…", "key": "Enter" }
```

```json
// click
{ "processId": "electron-…", "selector": "button[type=submit]" }
```

```json
// wait_for (richer conditions)
{
  "processId": "electron-…",
  "text": "Welcome",
  "timeoutMs": 8000,
  "screenshotOnTimeout": true
}
```

```json
// wait_for enabled / count / hidden
{ "processId": "electron-…", "enabled": "#submit" }
```

```json
{
  "processId": "electron-…",
  "countSelector": ".row",
  "minCount": 3
}
```

```json
{ "processId": "electron-…", "hidden": ".spinner" }
```

### 7️⃣ Cookies & storage

```json
// set_storage
{
  "processId": "electron-…",
  "kind": "localStorage",
  "clear": true,
  "entries": { "theme": "dark", "onboardingDone": "1" }
}
```

```json
// get_storage
{ "processId": "electron-…", "kind": "localStorage" }
```

```json
// set_cookie
{
  "processId": "electron-…",
  "name": "session",
  "value": "abc",
  "url": "https://app.local/"
}
```

```json
// get_cookies
{ "processId": "electron-…", "urls": ["https://app.local/"] }
```

### 8️⃣ Main-process evaluate

```json
// start_app with inspectMain
{
  "appPath": "D:/apps/my-electron-app",
  "debugPort": 9222,
  "inspectMain": true
}
```

```json
// evaluate_main
{
  "processId": "electron-…",
  "expression": "process.versions.electron"
}
```

### 9️⃣ Performance tracing

```json
// start_tracing
{ "processId": "electron-…" }
```

```text
…reproduce the slow interaction (click / navigate / wait_for)…
```

```json
// stop_tracing
{
  "processId": "electron-…",
  "path": "D:/tmp/app-trace.json"
}
```

Open `app-trace.json` in `chrome://tracing`.

### 🔟 Diagnose a sick session

```json
// tool: diagnose
{ "processId": "electron-1710000000000" }
```

### 1️⃣1️⃣ Navigate + page info

```json
// navigate
{
  "processId": "electron-…",
  "url": "file:///path/to/renderer/settings.html",
  "waitUntilLoad": true
}
```

```json
// page_info
{ "processId": "electron-…" }
```

### 1️⃣2️⃣ Raw CDP escape hatch

```json
// cdp_command
{
  "processId": "electron-…",
  "method": "Page.captureScreenshot",
  "params": { "format": "png", "fromSurface": true }
}
```

### 1️⃣3️⃣ Recommended agent loop

```text
find_apps / discover_apps / start_app / attach / attach_by_pid
    → diagnose
    → set_console_live(true)   # optional
    → get_console_messages(level="error")
    → screenshot / save_screenshot(selector?)
    → wait_for (if UI)
    → click / type_text / press_key / evaluate / get_dom
    → get_storage / get_cookies   # if state matters
    → start_tracing … stop_tracing   # if perf
    → stop_app
```

---

## 🔐 Configuration

### Environment variables

| Variable | Purpose |
| --- | --- |
| `ELECTRON_PATH` | Force a specific Electron binary |
| `ELECTRON_MCP_NO_SANDBOX=1` | Always pass `--no-sandbox` |
| `ELECTRON_MCP_ALLOWED_ROOTS` | `;` / `\|` allowlist for `start_app` paths |
| `ELECTRON_MIRROR` | Download mirror for Electron zips |
| `ELECTRON_SKIP_BINARY_DOWNLOAD` | Cleared by `ensure-electron` so download still runs |
| `ELECTRON_CACHE` / `electron_config_cache` | Zip cache directory |
| `CI=true` | Enables no-sandbox auto flag |
| unset `DISPLAY` (Linux) | Enables no-sandbox auto flag |

### Path allowlist example

```powershell
$env:ELECTRON_MCP_ALLOWED_ROOTS="D:\apps;D:\GH"
```

---

## 📜 npm scripts

| Script | Does |
| --- | --- |
| `npm run ensure-electron` | Download/repair Electron binary |
| `npm run fix-electron` | Alias of ensure-electron |
| `npm run build` | Compile TS → `build/` |
| `npm start` | Run MCP server (stdio) |
| `npm run dev` | build + start |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | ensure + build + unit + smoke |
| `npm run test:unit` | Helper unit tests |
| `npm run test:smoke` | Full MCP e2e vs fixture app |
| `postinstall` | Runs ensure-electron |

**Windows helpers:** `scripts/fix-electron.cmd` · `scripts/fix-electron.ps1`

---

## 🧪 Testing

```bash
npm test
```

Smoke path (v1.5):

`initialize` → tool/prompt/resource lists → `start_app` → evaluate → console/network/DOM → page_info / type_text / click / wait_for / press_key → `save_screenshot` (+ **selector clip**) → **storage** / **cookies** → **start/stop_tracing** → **find_apps** / **attach_by_pid** → screenshot → diagnose → attach → discover → stop

CI: [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) (Ubuntu + Xvfb).

---

## 🗂️ Project layout

```text
electron-mcp-server/
├── assets/logo.svg · logo.png
├── examples/cursor-mcp.json
├── fixtures/minimal-electron-app/
├── scripts/ensure-electron.mjs · fix-electron.cmd · fix-electron.ps1
├── src/index.ts · process-manager.ts · events.ts · log.ts
├── test/mcp-smoke.mjs · unit-helpers.test.mjs
├── .github/workflows/ci.yml
└── README.md · LICENSE · package.json
```

---

## 🛡️ Security

- Can launch local binaries, evaluate JS in app contexts, read page content, cookies, and storage — treat as a **powerful local debugger**.
- Use `ELECTRON_MCP_ALLOWED_ROOTS` on shared machines.
- Don’t expose stdio over an open network without auth.
- Only `attach` / `attach_by_pid` to apps you trust (remote debugging is powerful).
- In-memory console/network buffers and exported traces may contain secrets from the app under test.

---

## 🧯 Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Electron failed to install correctly` | `.\scripts\fix-electron.cmd` / `npm run ensure-electron` |
| `path.txt` missing / `dist=locales` | Corrupt cache — repair script clears + uses `tar` |
| `allowScripts` warning | Expected on newer npm — run ensure/fix scripts |
| Hang + console title `Select …` | Windows QuickEdit — press Esc; disable QuickEdit |
| Empty console buffer | Wait for page activity; monitoring starts on start/attach; try `set_console_live` |
| `wait_for` / `click` fails | Selector not ready — wait first; screenshot to verify |
| Element screenshot hangs / times out | Headless/GPU quirks — server retries without `fromSurface`; ensure selector is visible |
| `set_cookie` fails on `file://` | Pass an `http(s)` `url`/`domain` |
| `evaluate_main` “No main/node target” | Restart with `inspectMain: true` or pass `targetId` |
| `attach_by_pid` can’t resolve port | App must be started with `--remote-debugging-port`; check `find_apps` |
| `start_app` path rejected | Outside `ELECTRON_MCP_ALLOWED_ROOTS` |
| `node build/index.js` “does nothing” | Waiting on MCP stdio — use Cursor config |
| Port in use | Change `debugPort` or `discover_apps` / `find_apps` |
| Linux headless | `ELECTRON_MCP_NO_SANDBOX=1` + Xvfb |
| Tracing empty / fails | Call `start_tracing` before the slow path; only one active trace per session |

---

## 🤝 Contributing

1. Fork + branch  
2. `npm test`  
3. PR with tool/behavior notes  
4. Keep stdout MCP-clean (log to stderr only)

---

## 📄 License

[ISC](./LICENSE) © Electron Debug MCP contributors

---

<p align="center">
  <img src="assets/logo.svg" width="64" height="64" alt="Electron Debug MCP" /><br/>
  <b>Built for agents that need eyes — and hands — inside Electron.</b>
</p>
