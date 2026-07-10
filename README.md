# Electron Debug MCP Server

MCP server for launching, attaching to, and debugging Electron apps through the Chrome DevTools Protocol.

## What it does

- **Tools** to start/attach/stop apps, evaluate JS, screenshot, inspect DOM, read console/network buffers, and run arbitrary CDP methods
- **Resources** for read-only process/log/console/target inspection
- **Prompts** for common debug workflows (blank window, renderer exceptions)
- Speaks MCP over **stdio** (Cursor / Claude Desktop safe — logs go to stderr)

## Setup

```bash
cd D:\GH\electron-mcp-server
npm install
npm run ensure-electron   # downloads the Electron binary if npm blocked install scripts
npm run build
```

If `npm install` warns about `allowScripts` / `electron` postinstall, run:

```powershell
npm run ensure-electron
# or:
npm install electron --foreground-scripts
```

## Cursor config

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

Optional env vars:

| Env | Purpose |
|-----|---------|
| `ELECTRON_PATH` | Use a specific Electron binary |
| `ELECTRON_MCP_NO_SANDBOX=1` | Auto-add `--no-sandbox` (CI/containers) |
| `ELECTRON_MCP_ALLOWED_ROOTS` | `;` / `\|` separated allowlist for `start_app` paths |

## Tools

| Tool | Purpose |
|------|---------|
| `start_app` | Start Electron with `--remote-debugging-port` |
| `attach` | Attach to an already-running debug port |
| `discover_apps` | Scan local ports for CDP endpoints |
| `stop_app` | Stop owned process or detach attached session |
| `list_apps` | List managed/attached processes |
| `diagnose` | Port health, target roles, recent console errors |
| `get_logs` | stdout/stderr capture |
| `get_console_messages` | Buffered page console/exceptions |
| `get_network_log` | Buffered Network domain events |
| `list_targets` | CDP targets with page/worker/browser roles |
| `evaluate` | `Runtime.evaluate` (optional role/target) |
| `screenshot` | `Page.captureScreenshot` (image content) |
| `get_dom` | `outerHTML` for document or selector |
| `query_selector` | Summarize `querySelectorAll` matches |
| `reload` / `pause` / `resume` | Page/debugger controls |
| `cdp_command` | Any `Domain.method` CDP call |

### Examples

Start:

```json
{ "appPath": "D:/path/to/electron-app", "debugPort": 9222 }
```

Attach to an app you launched with `--remote-debugging-port=9222`:

```json
{ "debugPort": 9222, "name": "my-app" }
```

Evaluate:

```json
{ "processId": "electron-…", "expression": "document.title" }
```

## Resources

| URI | Description |
|-----|-------------|
| `electron://info` | Managed process overview |
| `electron://targets` | All CDP targets |
| `electron://process/{id}` | Process debug details |
| `electron://logs/{id}` | Process logs |
| `electron://console/{id}` | Buffered console messages |
| `electron://cdp/{processId}/{targetId}` | Target metadata |

## Development

```bash
npm run build
npm test          # unit + end-to-end smoke
npm run test:unit
npm run test:smoke
```

```
src/
  index.ts              # MCP tools, resources, prompts
  process-manager.ts    # Electron/CDP lifecycle
  events.ts             # Process/console event bus
  log.ts                # stderr-only logging
fixtures/minimal-electron-app/
test/
  unit-helpers.test.mjs
  mcp-smoke.mjs
```

## License

ISC
