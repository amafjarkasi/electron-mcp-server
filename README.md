# Electron Debug MCP Server

MCP server for launching and debugging Electron apps through the Chrome DevTools Protocol.

## What it does

- **Tools** start/stop Electron apps, evaluate JS, reload pages, pause/resume, and run arbitrary CDP methods
- **Resources** expose read-only process info, logs, and CDP targets
- Speaks MCP over **stdio** (safe for Cursor / Claude Desktop)

## Setup

```bash
cd D:\GH\electron-mcp-server
npm install
npm run build
```

## Cursor config

Add to your MCP settings (path adjusted to your clone):

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

Restart Cursor after saving.

## Tools

| Tool | Purpose |
|------|---------|
| `start_app` | Start an Electron app with `--remote-debugging-port` |
| `stop_app` | Stop a managed process |
| `list_apps` | List managed processes |
| `get_logs` | Read captured stdout/stderr |
| `list_targets` | List CDP targets |
| `evaluate` | `Runtime.evaluate` in a page/renderer |
| `reload` | `Page.reload` |
| `pause` / `resume` | `Debugger.pause` / `Debugger.resume` |
| `cdp_command` | Run any `Domain.method` CDP call |

### Examples

Start an app:

```json
{
  "appPath": "D:/path/to/your/electron-app",
  "debugPort": 9222
}
```

Evaluate in the first page target:

```json
{
  "processId": "electron-1710000000000",
  "expression": "document.title"
}
```

Raw CDP:

```json
{
  "processId": "electron-1710000000000",
  "method": "Page.navigate",
  "params": { "url": "https://example.com" }
}
```

## Resources (read-only)

| URI | Description |
|-----|-------------|
| `electron://info` | Managed process overview |
| `electron://targets` | All CDP targets |
| `electron://process/{id}` | Process debug details |
| `electron://logs/{id}` | Process logs |
| `electron://cdp/{processId}/{targetId}` | Target metadata |

## Development

```bash
npm run build
npm start
npm run typecheck
npm test
```

`npm test` builds the server, then runs `test/mcp-smoke.mjs` against `fixtures/minimal-electron-app` (start → list targets → evaluate → stop).

Project layout:

```
src/
  index.ts              # MCP tools + resources
  process-manager.ts    # Electron process + CDP helpers
  log.ts                # stderr-only logging
  types/                # ambient typings
fixtures/
  minimal-electron-app/ # Tiny Electron app used by smoke tests
test/
  mcp-smoke.mjs         # End-to-end MCP stdio smoke test
```

## Notes

- Logs go to **stderr** so stdio JSON-RPC on stdout stays clean
- `start_app` waits for the debug port before returning
- Targets default to the first `page` target when `targetId` is omitted
- This server manages processes it starts; it does not attach to arbitrary already-running Electron apps yet

## License

ISC
