<p align="center">
  <img src="assets/logo.svg" alt="Electron Debug MCP logo" width="128" height="128" />
</p>

<h1 align="center">Electron Debug MCP</h1>

<p align="center">
  <strong>Debug Electron apps from Cursor (and any MCP client) via Chrome DevTools Protocol.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/MCP-Model%20Context%20Protocol-0F766E?style=for-the-badge" alt="MCP" />
  <img src="https://img.shields.io/badge/Electron-CDP-47848F?style=for-the-badge&logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/License-ISC-F59E0B?style=for-the-badge" alt="License" />
</p>

<p align="center">
  Start or attach to Electron · capture screenshots · read console errors · inspect the DOM · run CDP commands — all as MCP tools.
</p>

---

## ✨ Why this exists

Electron bugs are often invisible to an AI assistant: blank windows, silent renderer exceptions, failed network calls, wrong DOM state. This server bridges that gap.

| Without this server | With Electron Debug MCP |
| --- | --- |
| Guess from source code alone | See live `document.title`, DOM, screenshots |
| No access to DevTools | Full CDP: evaluate, pause, reload, network |
| Can't see `console.error` | Buffered console + exception capture |
| Manual copy/paste from DevTools | Ask the agent to `diagnose` / `screenshot` |

---

## 🚀 Features

### 🔌 Process control
- **Start** Electron apps with `--remote-debugging-port`
- **Attach** to apps you already launched
- **Discover** local debug ports (`9222+`)
- **Stop** owned processes (or detach attached sessions)

### 🩺 Live inspection
- **Screenshots** (`Page.captureScreenshot`) as MCP image content
- **DOM** snapshots + `querySelectorAll` summaries
- **Console** buffer (`log` / `warn` / `error` / exceptions)
- **Network** request/response buffer
- **Stdout/stderr** process logs

### 🧠 Agent-friendly UX
- `diagnose` — one-shot health report (port, targets, recent errors)
- Prompts: `debug_blank_window`, `find_renderer_exception`
- Target roles: `page` / `worker` / `browser`
- Stdio-safe logging (diagnostics go to **stderr** only)

---

## 📦 Install

```bash
git clone https://github.com/amafjarkasi/electron-mcp-server.git
cd electron-mcp-server
npm install
npm run ensure-electron
npm run build
```

### Windows note

If `npm install` warns about `allowScripts` / Electron postinstall, the binary may be missing. Fix with:

```bat
.\scripts\fix-electron.cmd
```

Or manually:

```powershell
npm run ensure-electron
npm test
```

---

## ⚙️ Cursor setup

Add to your Cursor MCP config (path adjusted to your clone):

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

macOS / Linux example:

```json
{
  "mcpServers": {
    "electron-debug": {
      "command": "node",
      "args": ["/Users/you/code/electron-mcp-server/build/index.js"]
    }
  }
}
```

Then **restart Cursor**. You should see tools like `start_app`, `attach`, `screenshot`, `get_console_messages`.

> ⚠️ Do **not** run `node build/index.js` in a normal terminal for day-to-day use — it waits on stdio for an MCP client. Let Cursor launch it.

---

## 🛠️ Tools

### Lifecycle

| Tool | What it does |
| --- | --- |
| `start_app` | Launch an Electron app with remote debugging |
| `attach` | Connect to an existing `--remote-debugging-port` |
| `discover_apps` | Scan local ports for CDP endpoints |
| `stop_app` | Kill a started app, or detach an attached session |
| `list_apps` | List managed / attached processes |
| `diagnose` | Port reachability, target roles, recent console errors |

### Inspection

| Tool | What it does |
| --- | --- |
| `screenshot` | PNG/JPEG screenshot of a page target |
| `get_dom` | `outerHTML` for `documentElement` or a CSS selector |
| `query_selector` | Summarize matches from `querySelectorAll` |
| `evaluate` | Run JS via `Runtime.evaluate` |
| `get_console_messages` | Buffered console + exceptions (filter by `level`) |
| `get_network_log` | Buffered Network domain events |
| `get_logs` | Captured Electron stdout/stderr |
| `list_targets` | CDP targets with role classification |

### Control

| Tool | What it does |
| --- | --- |
| `reload` | `Page.reload` (one target or all pages) |
| `pause` / `resume` | `Debugger.pause` / `Debugger.resume` |
| `cdp_command` | Any raw `Domain.method` CDP call |

---

## 📚 Usage examples

### 1) Start your app and read the title

**Tool:** `start_app`

```json
{
  "appPath": "D:/apps/my-electron-app",
  "debugPort": 9222,
  "extraArgs": ["--no-sandbox"]
}
```

**Tool:** `evaluate`

```json
{
  "processId": "electron-1710000000000",
  "expression": "document.title"
}
```

### 2) Attach to an app you already started

Launch Electron yourself:

```bash
electron . --remote-debugging-port=9222
```

**Tool:** `attach`

```json
{
  "debugPort": 9222,
  "name": "my-app"
}
```

### 3) Catch console errors

**Tool:** `get_console_messages`

```json
{
  "processId": "electron-1710000000000",
  "level": "error",
  "tail": 50
}
```

Also available as resource: `electron://console/{processId}`

### 4) Screenshot a blank / white window

**Tool:** `screenshot`

```json
{
  "processId": "electron-1710000000000",
  "format": "png"
}
```

Then inspect:

```json
{
  "processId": "electron-1710000000000",
  "selector": "#root"
}
```

(`get_dom`)

### 5) One-shot diagnosis

**Tool:** `diagnose`

```json
{
  "processId": "electron-1710000000000"
}
```

Returns debug-port health, page/worker/browser target counts, monitoring status, and recent console errors.

### 6) Raw CDP when you need full power

**Tool:** `cdp_command`

```json
{
  "processId": "electron-1710000000000",
  "method": "Page.navigate",
  "params": { "url": "https://example.com" }
}
```

### 7) Typical agent workflow

1. `discover_apps` or `start_app` / `attach`
2. `diagnose`
3. `get_console_messages` with `level: "error"`
4. `screenshot`
5. `get_dom` / `evaluate` to confirm root cause
6. `stop_app` when finished

Built-in prompts (`debug_blank_window`, `find_renderer_exception`) encode these flows for the model.

---

## 📡 Resources (read-only)

| URI | Description |
| --- | --- |
| `electron://info` | Overview of managed processes |
| `electron://targets` | All CDP targets |
| `electron://process/{id}` | Process details + target summary |
| `electron://logs/{id}` | stdout/stderr capture |
| `electron://console/{id}` | Buffered console / exceptions |
| `electron://cdp/{processId}/{targetId}` | Target metadata |

---

## 🔐 Environment variables

| Variable | Purpose |
| --- | --- |
| `ELECTRON_PATH` | Use a specific Electron binary |
| `ELECTRON_MCP_NO_SANDBOX=1` | Auto-append `--no-sandbox` (CI / containers) |
| `ELECTRON_MCP_ALLOWED_ROOTS` | `;` or `\|` separated allowlist for `start_app` paths |
| `ELECTRON_MIRROR` | Alternate download mirror for Electron binaries |
| `ELECTRON_SKIP_BINARY_DOWNLOAD` | If set in your environment, `ensure-electron` clears it and downloads anyway |

---

## 🧪 Tests

```bash
npm test          # ensure-electron + build + unit + e2e smoke
npm run test:unit
npm run test:smoke
```

The smoke test speaks real MCP over stdio against `fixtures/minimal-electron-app`:

`initialize` → `start_app` → `evaluate` → console/network/DOM/screenshot → `attach` → `stop_app`

---

## 🗂️ Project layout

```text
electron-mcp-server/
├── assets/
│   ├── logo.svg                 # README logo
│   └── logo.png
├── fixtures/
│   └── minimal-electron-app/    # Tiny app used by smoke tests
├── scripts/
│   ├── ensure-electron.mjs      # Download/repair Electron binary
│   ├── fix-electron.cmd         # Windows one-shot repair + test
│   └── fix-electron.ps1
├── src/
│   ├── index.ts                 # MCP tools, resources, prompts
│   ├── process-manager.ts       # Electron + CDP lifecycle
│   ├── events.ts                # Process / console event bus
│   └── log.ts                   # stderr-only logger
├── test/
│   ├── mcp-smoke.mjs            # End-to-end MCP client
│   └── unit-helpers.test.mjs
└── package.json
```

---

## 🧩 Architecture (short)

```text
Cursor / MCP client
        │  stdio JSON-RPC
        ▼
 Electron Debug MCP  ──tools/resources/prompts──►  process-manager
        │                                              │
        │                         spawn/attach + CDP   │
        ▼                                              ▼
   stderr logs only                          Electron + DevTools port
                                             (Runtime / Page / Network / Debugger)
```

- **Tools** mutate / act (start, evaluate, screenshot, …)
- **Resources** are read-only snapshots
- **Monitoring sessions** stay connected to page targets to buffer console + network events between tool calls

---

## 🧯 Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Electron failed to install correctly` | Run `.\scripts\fix-electron.cmd` (Windows) or `npm run ensure-electron` |
| `path.txt` missing / `dist` only has `locales` | Corrupt unzip/cache — `fix-electron` clears cache and uses system `tar` |
| Smoke test hangs on a black console window titled **Select** | Windows QuickEdit paused the process — click the window, press `Esc`, disable QuickEdit |
| No console messages | Call `get_console_messages` after the app has logged; monitoring attaches to page targets automatically on start/attach |
| `start_app` path rejected | Check `ELECTRON_MCP_ALLOWED_ROOTS` |
| Running `node build/index.js` “does nothing” | It's waiting for MCP stdio — configure it in Cursor instead |

---

## 🤝 Contributing

1. Fork + branch
2. `npm test`
3. Open a PR with a clear description of tools/behavior changes

---

## 📄 License

[ISC](./LICENSE) © contributors

---

<p align="center">
  <img src="assets/logo.svg" alt="" width="48" height="48" /><br/>
  <sub>Built for agents that need eyes inside Electron.</sub>
</p>
