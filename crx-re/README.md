# crx-re

CLI that downloads (or opens) a Chrome extension, unpacks it, and writes a deterministic inventory plus a capability brief. LLM reconstruction is a later phase and uses one preferred provider (MiMo Token Plan, DeepSeek, Z.ai, MiniMax) — never official Claude/OpenAI.

This package lives in `amafjarkasi/electron-mcp-server` as a sibling project (`crx-re/`). It does not change the Electron MCP server.

## Test locally

Needs **Node 22.13+**. From a clone of this repo (PR branch `cursor/crx-re-scaffold-14ae`):

```bash
git clone https://github.com/amafjarkasi/electron-mcp-server.git
cd electron-mcp-server
git fetch origin cursor/crx-re-scaffold-14ae
git checkout cursor/crx-re-scaffold-14ae
```

One-shot smoke (install, unit tests, typecheck, analyze the hello-world fixture):

```bash
bash crx-re/scripts/test-local.sh
```

Or step by step from `crx-re/`:

```bash
cd crx-re
npm install
npm test
npm run tokens
npm run analyze:hello
```

Outputs land in `crx-re/out/hello-world/` (`inventory.json`, `architecture.json`, `REPORT.md`, `original/`).

From the **repo root** without `cd`:

```bash
npm --prefix ./crx-re install
npm --prefix ./crx-re test
npm --prefix ./crx-re run tokens
npm --prefix ./crx-re exec -- node ./crx-re/bin/crx-re.mjs analyze ./crx-re/fixtures/hello-world --out ./crx-re/out/hello-world
```

After `npm install` inside `crx-re/`, the local bin works from any cwd if you pass absolute fixture paths:

```bash
node /ABS/electron-mcp-server/crx-re/bin/crx-re.mjs tokens
node /ABS/electron-mcp-server/crx-re/bin/crx-re.mjs analyze /ABS/electron-mcp-server/crx-re/fixtures/hello-world --out /tmp/crx-hello
```

Optional live store download (network):

```bash
cd crx-re
node bin/crx-re.mjs analyze https://chromewebstore.google.com/detail/chrome-extension-source-viewer/jifpbeccnghkjeaalbbjmodiffmgedin --out ./out/crx-viewer
```

`tokens` prints `{ provider, envName, present, role }` only. It never prints secret values.

## Outputs

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

From `crx-re/` after `npm install`:

```bash
npx @grok/agent-sdk validate --dir .
npx @grok/agent-sdk info --dir . --json
npx @grok/agent-sdk tool call discover_tokens --dir . --input '{}'
npx @grok/agent-sdk tool call analyze_extension --dir . --input '{"input":"fixtures/hello-world"}'
```

Model turns need a Cursor credential. Reconstruction still will not use Claude/OpenAI official APIs.
