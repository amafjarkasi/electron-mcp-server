# crx-re

CLI that downloads (or opens) a Chrome extension, unpacks it, and writes a deterministic inventory plus a capability brief. LLM reconstruction is a later phase and uses one preferred provider (MiMo Token Plan, DeepSeek, Z.ai, MiniMax) — never official Claude/OpenAI.

This package lives in `amafjarkasi/electron-mcp-server` as a sibling project (`crx-re/`). It does not change the Electron MCP server.

## Commands

```bash
cd crx-re
npm test
npx tsx cli/index.ts tokens
npx tsx cli/index.ts analyze fixtures/hello-world --out /tmp/crx-hello
```

`tokens` prints `{ provider, envName, present, role }` only. It never prints secret values.

`analyze` writes:

```
<out>/
  original/           # unpacked package, never mutated
  inventory.json
  architecture.json
  REPORT.md           # deterministic brief in this cut
  meta.json
```

## Inputs

- Chrome Web Store URL or 32-letter ID
- Direct `.crx` / `.zip` URL
- Local CRX, zip, or unpacked folder

## Agent SDK

```bash
npx @grok/agent-sdk validate --dir .
npx @grok/agent-sdk info --dir . --json
npx @grok/agent-sdk tool call discover_tokens --dir . --input '{}'
npx @grok/agent-sdk tool call analyze_extension --dir . --input '{"input":"fixtures/hello-world"}'
```

Model turns need a Cursor credential. Reconstruction still will not use Claude/OpenAI official APIs.
