<p align="center">
  <img src="assets/logo.svg" alt="Electron Debug MCP logo" width="140" height="140" />
</p>

<h1 align="center">Electron Debug MCP</h1>

<p align="center">
  <strong>An MCP server that lets AI agents launch, attach to, inspect, and drive Electron apps through the Chrome DevTools Protocol.</strong>
</p>

<p align="center">
  <a href="#-quick-start"><img src="https://img.shields.io/badge/Quick%20Start-0F766E?style=for-the-badge" alt="Quick Start" /></a>
  <a href="#-tools-reference"><img src="https://img.shields.io/badge/22%20Tools-47848F?style=for-the-badge" alt="22 Tools" /></a>
  <a href="#-resources-read-only"><img src="https://img.shields.io/badge/6%20Resources-0EA5E9?style=for-the-badge" alt="6 Resources" /></a>
  <a href="#-cursor--claude-desktop-setup"><img src="https://img.shields.io/badge/Cursor%20%2B%20Claude-3178C6?style=for-the-badge" alt="Cursor + Claude" /></a>
  <a href="#-license"><img src="https://img.shields.io/badge/License-ISC-F59E0B?style=for-the-badge" alt="ISC License" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/MCP-stdio%20JSON--RPC-0F766E?style=flat-square" alt="MCP stdio" />
  <img src="https://img.shields.io/badge/Protocol-Chrome%20DevTools%20(CDP)-47848F?style=flat-square&logo=googlechrome&logoColor=white" alt="CDP" />
  <img src="https://img.shields.io/badge/Runtime-Electron%20%2B%20Node%20%3E%3D%2018-339933?style=flat-square&logo=electron&logoColor=white" alt="Electron Node" />
  <img src="https://img.shields.io/badge/Language-TypeScript%205.x-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/version-1.2.0-blue?style=flat-square" alt="v1.2.0" />
  <img src="https://img.shields.io/badge/tests-unit%20%2B%20e2e%20smoke-8B5CF6?style=flat-square" alt="tests" />
</p>

---

### What this is

**Electron Debug MCP** is a local [Model Context Protocol](https://modelcontextprotocol.io/) server for **Cursor**, **Claude Desktop**, and any MCP client that speaks **stdio**.

It sits between the agent and your Electron app and exposes real debugger capabilities as tools:

| Area | What the agent can do |
| --- | --- |
| 🚀 **Lifecycle** | `start_app`, `attach`, `discover_apps`, `stop_app`, `list_apps`, `diagnose` |
| 🔍 **Inspect** | screenshots, DOM, `evaluate`, console errors/exceptions, network log, process logs, targets |
| 🖱️ **Interact** | `navigate`, `wait_for`, `click`, `type_text`, `reload`, `pause` / `resume` |
| 🧰 **Escape hatch** | raw `cdp_command` for any `Domain.method` DevTools call |
| 📦 **Read-only context** | resources like `electron://info`, `electron://console/{id}`, `electron://logs/{id}` |
| 🧭 **Guided flows** | prompts for blank windows, renderer exceptions, and UI smoke checks |

Under the hood it uses **Chrome DevTools Protocol** (`--remote-debugging-port`) via `chrome-remote-interface`, keeps page targets monitored so console/network events buffer between tool calls, and writes diagnostics to **stderr only** so MCP JSON-RPC on stdout stays clean.

### Who it’s for

- **Cursor / Claude users** debugging Electron desktop apps with an AI pair-programmer
- **Electron maintainers** who want agents to *see* blank windows, failed fetches, and renderer exceptions instead of guessing from source
- **Tooling authors** who need a stdio MCP bridge into CDP for Electron (and other Chromium targets that expose remote debugging)

### What you get in practice

Ask the agent things like:

- “Start my app and tell me if the renderer threw on boot.”
- “Attach to port 9222, screenshot the window, and dump `#root`.”
- “Type into `#email`, click Submit, wait for Welcome, and report console errors.”
- “Diagnose why this window is white.”

…and it can do that through tools instead of asking you to paste DevTools output.

### At a glance

| | |
| --- | --- |
| **Transport** | MCP over **stdio** (Cursor / Claude Desktop compatible) |
| **Debug bridge** | Chrome DevTools Protocol (Runtime, Page, Network, Debugger, Input, Log, …) |
| **App control** | Spawn Electron *or* attach to an existing `--remote-debugging-port` |
| **Surface area** | **22 tools** · **6 resources** · **3 prompts** · logging + list-changed notifications |
| **Platforms** | Windows · macOS · Linux (CI uses Xvfb + `ELECTRON_MCP_NO_SANDBOX`) |
| **Requirements** | Node **≥ 18**, npm, network once to download the Electron binary |
| **Safety defaults** | Optional `ELECTRON_MCP_ALLOWED_ROOTS` path allowlist; attached sessions are detach-only on stop |
| **Verify install** | `npm test` runs unit helpers + a full MCP↔Electron smoke suite |

### Status

✅ Actively usable for local agent-driven Electron debugging  
✅ End-to-end smoke tested (`start` → evaluate/console/DOM/click/type → `attach` → `stop`)  
✅ Windows Electron binary recovery via `scripts/fix-electron.cmd` when npm blocks install scripts

---

## 📖 Table of contents

- [Why this exists](#-why-this-exists)
- [Feature overview](#-feature-overview)
- [Quick start](#-quick-start)
- [Cursor / Claude Desktop setup](#-cursor--claude-desktop-setup)
- [How it works](#-how-it-works)
- [Tools reference](#-tools-reference)
- [Resources](#-resources-read-only)
- [Prompts](#-prompts)
- [Recipes & workflows](#-recipes--workflows)
- [Configuration](#-configuration)
- [npm scripts](#-npm-scripts)
- [Testing](#-testing)
- [Project layout](#-project-layout)
- [Security notes](#-security-notes)
- [Troubleshooting](#-troubleshooting)
- [Contributing](#-contributing)
- [License](#-license)

---

## ✨ Why this exists

Electron bugs are often invisible to coding agents:

| Pain | What agents usually see | What this server adds |
| --- | --- | --- |
| ⬜ Blank / white window | Source files only | Live **screenshot** + DOM |
| 💥 Silent renderer crash | Nothing | **Console + exception** buffer |
| 🌐 Failed API calls | Guesswork | **Network** event log |
| 🧭 Wrong route / URL | Unknown | **page_info** / `evaluate` |
| 🖱️ UI not responding | Can't interact | **click** / **type_text** / **wait_for** |
| 🔧 Need DevTools power | Manual only | Full **cdp_command** escape hatch |

Electron Debug MCP is a stdio MCP server that launches or attaches to Electron, speaks Chrome DevTools Protocol, and exposes that power as tools an agent can call.

---

## 🚀 Feature overview

### 🔌 Lifecycle
- Start Electron with `--remote-debugging-port`
- Attach to an already-running debug port
- Discover local CDP ports in a range
- Stop owned processes or detach attached sessions
- List managed sessions with status / ports / buffer counts

### 🩺 Inspection
- Screenshots (PNG/JPEG) as MCP image content
- DOM `outerHTML` and `querySelectorAll` summaries
- JS evaluation in page / worker / browser targets
- Buffered console (`log`/`warn`/`error`) + uncaught exceptions
- Buffered network request/response/failure events
- Process stdout/stderr capture
- One-shot `diagnose` health report

### 🖱️ Interaction
- Navigate + wait for load
- Wait for selector / text / URL / console match
- Click elements (left/right/middle)
- Type into inputs (clear + optional Enter)
- Reload / debugger pause / resume
- Clear console/network/log buffers

### 🧠 Agent UX
- MCP `instructions` baked into the server handshake
- Prompts: blank-window debug, renderer exceptions, UI smoke check
- Target role awareness: `page` · `worker` · `browser`
- Resource list-changed + logging notifications
- Stdio-safe: all diagnostics go to **stderr**

---

## 🏁 Quick start

```bash
git clone https://github.com/amafjarkasi/electron-mcp-server.git
cd electron-mcp-server
npm install
npm run ensure-electron
npm run build
npm test
```

### Windows (if Electron binary is missing)

npm may block Electron’s postinstall (`allowScripts`). Use the repair script:

```bat
.\scripts\fix-electron.cmd
```

This reinstalls Electron, downloads the real `electron.exe` (via system `tar`), then runs the full test suite.

---

## ⚙️ Cursor / Claude Desktop setup

### Cursor

1. Build this repo (`npm run build`).
2. Open Cursor MCP settings.
3. Add a server entry (path must be absolute):

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

4. Restart Cursor.
5. Confirm tools appear: `start_app`, `attach`, `screenshot`, `get_console_messages`, `click`, …

A ready-made template lives at [`examples/cursor-mcp.json`](./examples/cursor-mcp.json).

### Claude Desktop

Same shape — add under `mcpServers` in `claude_desktop_config.json`, pointing `args` at `build/index.js`.

> ⚠️ **Do not** run `node build/index.js` in a normal terminal for daily use. It blocks on stdio waiting for an MCP client. Let Cursor/Claude launch it.

---

## 🧩 How it works

```text
┌──────────────────────┐     stdio JSON-RPC      ┌─────────────────────────┐
│  Cursor / MCP client │ ◄─────────────────────► │  Electron Debug MCP     │
└──────────────────────┘                         │  tools · resources ·    │
                                                 │  prompts · logging      │
                                                 └───────────┬─────────────┘
                                                             │
                                              spawn / attach │ CDP (Runtime,
                                                             │ Page, Network,
                                                             │ Debugger, Input)
                                                             ▼
                                                 ┌─────────────────────────┐
                                                 │  Electron app           │
                                                 │  --remote-debugging-port│
                                                 └─────────────────────────┘
```

| Layer | Role |
| --- | --- |
| **Tools** | Actions: start, evaluate, screenshot, click, … |
| **Resources** | Read-only snapshots: info, logs, console, targets |
| **Prompts** | Packaged debug workflows for the model |
| **Monitoring** | Persistent CDP sessions buffer console + network between tool calls |
| **Logging** | Server diagnostics → **stderr** only (stdout stays clean JSON-RPC) |

After `start_app` / `attach`, the server enables `Runtime`, `Log`, `Network`, and `Page` on page targets so console/network events accumulate automatically.

---

## 🛠️ Tools reference

All mutating/inspection APIs are MCP **tools**. Parameters below match the live Zod schemas.

### Lifecycle

#### `start_app`
Launch an Electron application with remote debugging enabled.

| Param | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `appPath` | string | ✅ | — | Path to app directory or main script |
| `debugPort` | int `1024–65535` | ❌ | random `9222–9999` | CDP port |
| `extraArgs` | string[] | ❌ | `[]` | Extra Electron CLI flags (e.g. `["--no-sandbox"]`) |

**Also auto-adds** `--remote-debugging-port`, `--enable-logging`, `--disable-gpu`, and optionally `--no-sandbox` when `ELECTRON_MCP_NO_SANDBOX=1`, `CI=true`, or `DISPLAY` is unset.

**Returns:** `id`, `name`, `status`, `pid`, `debugPort`, `appPath`, `targets`, `attached: false`

---

#### `attach`
Attach to an Electron/Chromium instance already listening for DevTools.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `debugPort` | int | ✅ | Existing remote debugging port |
| `name` | string | ❌ | Friendly session name |

**Returns:** session `id`, `attached: true`, current `targets`  
**Note:** `stop_app` on an attached session **detaches bookkeeping only** — it does not kill the external app.

---

#### `discover_apps`
Scan localhost for CDP endpoints.

| Param | Type | Required | Default |
| --- | --- | --- | --- |
| `startPort` | int | ❌ | `9222` |
| `endPort` | int | ❌ | `9235` |

**Returns:** `{ found: [{ port, version, targetCount }, ...] }`

---

#### `stop_app`

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `processId` | string | ✅ | Id from `start_app` or `attach` |

Started apps are terminated (Windows uses process-tree kill). Attached sessions are detached.

---

#### `list_apps`
No parameters. Returns managed sessions with `status`, `attached`, `debugPort`, `targetCount`, `consoleCount`, `networkCount`, etc.

---

#### `diagnose`
One-shot health report.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `processId` | string | ❌ | Omit to diagnose **all** sessions |

**Includes:** debug-port reachability, target role counts, recent console errors, monitoring target ids, discovered local ports, actionable `hints`.

---

### Inspection

#### `screenshot`

| Param | Type | Required | Default |
| --- | --- | --- | --- |
| `processId` | string | ✅ | — |
| `targetId` | string | ❌ | first page target |
| `format` | `"png"` \| `"jpeg"` | ❌ | `"png"` |
| `quality` | int `0–100` | ❌ | — (jpeg only) |

**Returns:** MCP `image` content + JSON metadata.

---

#### `get_dom`

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `processId` | string | ✅ | — |
| `selector` | string | ❌ | CSS selector; omit for `documentElement.outerHTML` |
| `targetId` | string | ❌ | — |

---

#### `query_selector`

| Param | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `processId` | string | ✅ | — | — |
| `selector` | string | ✅ | — | CSS selector |
| `targetId` | string | ❌ | — | — |
| `limit` | int `1–100` | ❌ | `20` | Max nodes summarized |

**Returns:** `{ count, nodes: [{ tag, id, className, text }] }`

---

#### `evaluate`

| Param | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `processId` | string | ✅ | — | — |
| `expression` | string | ✅ | — | JS to run |
| `targetId` | string | ❌ | — | Explicit CDP target |
| `role` | `page`\|`worker`\|`browser`\|`other` | ❌ | `page` | Preferred role if no `targetId` |
| `returnByValue` | boolean | ❌ | `true` | CDP `returnByValue` |

Uses `Runtime.evaluate` with `awaitPromise: true`.

---

#### `get_console_messages`

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `processId` | string | ✅ | — |
| `tail` | positive int | ❌ | Last N messages |
| `level` | string | ❌ | Filter e.g. `error`, `warning`, `log` |

Captures `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, and `Log.entryAdded`.

---

#### `get_network_log`

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `processId` | string | ✅ | — |
| `tail` | positive int | ❌ | Last N events |

Events: `request` · `response` · `failed` · `finished` (where applicable).

---

#### `get_logs`

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `processId` | string | ✅ | — |
| `tail` | positive int | ❌ | Trailing stdout/stderr chunks |

---

#### `list_targets`

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `processId` | string | ❌ | Omit = all running sessions |

Each entry includes `role`: `page` | `worker` | `browser` | `other`.

---

#### `page_info`

| Param | Type | Required |
| --- | --- | --- |
| `processId` | string | ✅ |
| `targetId` | string | ❌ |

**Returns:** `url`, `title`, `readyState`, `userAgent`, `targetId`.

---

### Interaction & control

#### `navigate`

| Param | Type | Required | Default |
| --- | --- | --- | --- |
| `processId` | string | ✅ | — |
| `url` | string | ✅ | — |
| `targetId` | string | ❌ | — |
| `waitUntilLoad` | boolean | ❌ | `true` |
| `timeoutMs` | int ≤ 120000 | ❌ | `15000` |

---

#### `wait_for`
Provide **at least one** condition:

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `processId` | string | ✅ | — |
| `selector` | string | ❌ | CSS selector must exist |
| `text` | string | ❌ | Must appear in `document.body.innerText` |
| `urlIncludes` | string | ❌ | `location.href` substring |
| `consoleIncludes` | string | ❌ | Buffered console text substring |
| `timeoutMs` | int ≤ 120000 | ❌ | default `10000` |
| `targetId` | string | ❌ | — |

---

#### `click`

| Param | Type | Required | Default |
| --- | --- | --- | --- |
| `processId` | string | ✅ | — |
| `selector` | string | ✅ | — |
| `targetId` | string | ❌ | — |
| `button` | `left`\|`right`\|`middle` | ❌ | `left` |

Clicks the center of the element’s bounding rect via `Input.dispatchMouseEvent`.

---

#### `type_text`

| Param | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `processId` | string | ✅ | — | — |
| `text` | string | ✅ | — | Text to insert |
| `selector` | string | ❌ | — | Click/focus before typing |
| `clear` | boolean | ❌ | `false` | Clear field if `selector` set |
| `pressEnter` | boolean | ❌ | `false` | Send Enter after typing |
| `targetId` | string | ❌ | — | — |

---

#### `reload`

| Param | Type | Required | Default |
| --- | --- | --- | --- |
| `processId` | string | ✅ | — |
| `targetId` | string | ❌ | all page-like targets |
| `ignoreCache` | boolean | ❌ | `false` |

---

#### `pause` / `resume`

| Param | Type | Required |
| --- | --- | --- |
| `processId` | string | ✅ |
| `targetId` | string | ❌ |

Enables Debugger domain then pauses/resumes JS execution.

---

#### `clear_buffers`

| Param | Type | Required | Default |
| --- | --- | --- | --- |
| `processId` | string | ✅ | — |
| `console` | boolean | ❌ | `true` |
| `network` | boolean | ❌ | `true` |
| `logs` | boolean | ❌ | `false` |

---

#### `cdp_command`
Raw DevTools escape hatch.

| Param | Type | Required | Description |
| --- | --- | --- | --- |
| `processId` | string | ✅ | — |
| `method` | string | ✅ | Must be `Domain.method` |
| `targetId` | string | ❌ | — |
| `params` | object | ❌ | CDP parameters JSON |

Example methods: `Page.navigate`, `Runtime.evaluate`, `DOM.getDocument`, `Network.enable`, `Profiler.start`.

---

## 📡 Resources (read-only)

| URI | MIME | Description |
| --- | --- | --- |
| `electron://info` | `application/json` | All managed processes |
| `electron://targets` | `application/json` | All CDP targets across sessions |
| `electron://process/{id}` | `application/json` | Detailed process + webContents + recent errors |
| `electron://logs/{id}` | `text/plain` | Captured stdout/stderr |
| `electron://console/{id}` | `application/json` | Buffered console/exceptions |
| `electron://cdp/{processId}/{targetId}` | `application/json` | Single target metadata |

Dynamic URIs are advertised via resource templates and refresh when processes start/stop (list-changed notifications).

---

## 💬 Prompts

| Prompt | Args | Purpose |
| --- | --- | --- |
| `debug_blank_window` | `processId` | Step-by-step blank/white window diagnosis |
| `find_renderer_exception` | `processId` | Hunt console/exceptions + failed network |
| `ui_smoke_check` | `processId`, `selector` | Wait → interact → verify UI path |

Use these from clients that support MCP prompts to steer the model into a proven workflow.

---

## 📚 Recipes & workflows

### 1) Start app → read title

```json
// start_app
{ "appPath": "D:/apps/my-electron-app", "debugPort": 9222 }

// evaluate
{ "processId": "electron-…", "expression": "document.title" }
```

### 2) Attach to an app you launched

```bash
electron . --remote-debugging-port=9222
```

```json
// attach
{ "debugPort": 9222, "name": "my-app" }
```

### 3) Find console errors

```json
// get_console_messages
{ "processId": "electron-…", "level": "error", "tail": 50 }
```

Or read resource `electron://console/{processId}`.

### 4) Blank window playbook

1. `diagnose`
2. `list_targets`
3. `get_console_messages` (`level: "error"`)
4. `screenshot`
5. `get_dom` / `query_selector` on `#root` / `#app`
6. Summarize cause → fix

### 5) UI automation

```json
// wait_for
{ "processId": "electron-…", "selector": "#email", "timeoutMs": 8000 }

// type_text
{ "processId": "electron-…", "selector": "#email", "text": "ada@example.com", "clear": true }

// click
{ "processId": "electron-…", "selector": "button[type=submit]" }

// wait_for
{ "processId": "electron-…", "text": "Welcome", "timeoutMs": 8000 }
```

### 6) Navigate in-app

```json
// navigate
{
  "processId": "electron-…",
  "url": "file:///path/to/renderer/settings.html",
  "waitUntilLoad": true,
  "timeoutMs": 15000
}
```

### 7) Raw CDP

```json
// cdp_command
{
  "processId": "electron-…",
  "method": "Page.captureScreenshot",
  "params": { "format": "png", "fromSurface": true }
}
```

### 8) Recommended agent loop

```text
discover_apps / start_app / attach
        → diagnose
        → get_console_messages(level=error)
        → screenshot
        → wait_for (if UI)
        → click / type_text / evaluate / get_dom
        → stop_app
```

---

## 🔐 Configuration

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ELECTRON_PATH` | (auto) | Force a specific Electron binary |
| `ELECTRON_MCP_NO_SANDBOX` | unset | If `1`, always pass `--no-sandbox` |
| `ELECTRON_MCP_ALLOWED_ROOTS` | unset | `;` or `\|` separated allowlist for `start_app` paths |
| `ELECTRON_MIRROR` | unset | Mirror base URL for Electron downloads |
| `ELECTRON_SKIP_BINARY_DOWNLOAD` | unset | If set externally, `ensure-electron` clears it and still downloads |
| `ELECTRON_CACHE` / `electron_config_cache` | OS default | Cache dir for Electron zips |
| `CI` | unset | When `true`, enables no-sandbox auto flag |
| `DISPLAY` | (Linux) | If unset, no-sandbox auto flag is enabled |

### Auto CLI flags on `start_app`

Always:

- `--remote-debugging-port=<port>`
- `--enable-logging`
- `--disable-gpu`

Conditionally:

- `--no-sandbox` when `ELECTRON_MCP_NO_SANDBOX=1` **or** `CI=true` **or** no `DISPLAY`
- plus any `extraArgs` you pass

### Path allowlisting

```powershell
$env:ELECTRON_MCP_ALLOWED_ROOTS="D:\apps;D:\GH"
```

`start_app` will reject paths outside those roots.

---

## 📜 npm scripts

| Script | What it does |
| --- | --- |
| `npm run ensure-electron` | Download/repair the Electron binary (`path.txt` + `dist/electron[.exe]`) |
| `npm run fix-electron` | Alias of `ensure-electron` |
| `npm run build` | Compile TypeScript → `build/` and chmod the bin entry |
| `npm start` | Run the MCP server on stdio |
| `npm run dev` | `build` then `start` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `ensure-electron` (pretest) + build + unit + smoke |
| `npm run test:unit` | Pure helper tests (`node --test`) |
| `npm run test:smoke` | Full MCP stdio e2e against the fixture app |
| `postinstall` | Runs `ensure-electron` after `npm install` |

Windows helper scripts (not npm):

| File | Purpose |
| --- | --- |
| `scripts/fix-electron.cmd` | Reinstall Electron + ensure binary + `npm test` |
| `scripts/fix-electron.ps1` | PowerShell variant of the same flow |

---

## 🧪 Testing

```bash
npm test
```

Smoke coverage (real Electron + real MCP):

`initialize` → tools/prompts/resources list → `start_app` → targets → evaluate → console → network → DOM → **page_info / type_text / click / wait_for / clear_buffers** → screenshot → diagnose → attach → discover → stop

CI runs the same suite on Ubuntu under Xvfb (see [`.github/workflows/ci.yml`](./.github/workflows/ci.yml)).

---

## 🗂️ Project layout

```text
electron-mcp-server/
├── assets/
│   ├── logo.svg                 # Brand mark (README)
│   └── logo.png
├── examples/
│   └── cursor-mcp.json          # Cursor MCP config template
├── fixtures/
│   └── minimal-electron-app/    # Tiny app for smoke tests
├── scripts/
│   ├── ensure-electron.mjs      # Binary download / repair
│   ├── fix-electron.cmd         # Windows one-shot repair
│   └── fix-electron.ps1
├── src/
│   ├── index.ts                 # MCP tools, resources, prompts
│   ├── process-manager.ts       # Electron + CDP lifecycle & automation
│   ├── events.ts                # Process/console event bus
│   ├── log.ts                   # stderr-only logger
│   └── types/                   # Ambient typings
├── test/
│   ├── mcp-smoke.mjs            # End-to-end MCP client
│   └── unit-helpers.test.mjs
├── .github/workflows/ci.yml
├── package.json
├── tsconfig.json
├── LICENSE
└── README.md
```

---

## 🛡️ Security notes

- This server can **launch local executables**, **evaluate arbitrary JS** in app contexts, and **read page content**. Treat it as a powerful local debug tool.
- Prefer `ELECTRON_MCP_ALLOWED_ROOTS` in shared environments.
- Do not expose the stdio server over an open network transport without auth.
- Attached mode can inspect any Chromium/Electron instance that enabled remote debugging — only attach to apps you trust.
- Console/network buffers are held in memory (capped); they may contain secrets from the app under test.

---

## 🧯 Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Electron failed to install correctly` | `.\scripts\fix-electron.cmd` or `npm run ensure-electron` |
| `path.txt` missing / `dist` only has `locales` | Corrupt extract/cache — repair script clears cache and uses `tar` |
| `allowScripts` warning for electron | Normal on newer npm; run `ensure-electron` / `fix-electron.cmd` |
| Smoke hangs; console title starts with **Select** | Windows QuickEdit paused I/O — press `Esc`, disable QuickEdit |
| No console messages | Ensure page finished loading; call `get_console_messages` after activity; monitoring attaches on start/attach |
| `wait_for` timeout | Loosen condition, raise `timeoutMs`, or `screenshot` to see current UI |
| `click` / `type_text` fails | Selector not visible yet — `wait_for` first |
| `start_app` path rejected | Path outside `ELECTRON_MCP_ALLOWED_ROOTS` |
| `node build/index.js` “does nothing” | It’s waiting on MCP stdio — configure in Cursor |
| Port already in use | Pick another `debugPort` or `discover_apps` |
| Linux CI / headless | Set `ELECTRON_MCP_NO_SANDBOX=1` and use Xvfb |

---

## 🤝 Contributing

1. Fork and create a branch
2. `npm test`
3. Open a PR describing tool/behavior changes
4. Keep stdout MCP-clean (log to stderr only)

---

## 📄 License

[ISC](./LICENSE) © Electron Debug MCP contributors

---

<p align="center">
  <img src="assets/logo.svg" width="56" height="56" alt="" /><br/>
  <sub>Built for agents that need eyes — and hands — inside Electron.</sub>
</p>
