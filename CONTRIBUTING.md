# Contributing

## Setup

```bash
npm install
npm run ensure-electron
npm run build
npm test
```

On Linux headless: ensure `DISPLAY` (or use Xvfb) and `ELECTRON_MCP_NO_SANDBOX=1`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run build` | Compile TypeScript → `build/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:unit` | Fast helper / monitor / probe tests |
| `npm run test:smoke` | Full MCP ↔ Electron e2e |
| `npm run doctor` | Build + stdio self-check (`doctor` tool + `electron://server`) |
| `npm run pack:check` | `npm pack --dry-run` (publish surface) |

## Guidelines

1. Keep **stdout MCP-clean** — log only to stderr (`src/log.ts`).
2. Prefer small, focused PRs; add smoke coverage when adding a tool.
3. After changing tools/resources/prompts, update the README cheatsheet and `CHANGELOG.md`.
4. Path writes go through `validateOutputPath`; session teardown must call `forgetProcess` / delete from the managed map.
5. Do not commit `build/smoke-*` artifacts (smoke writes to OS temp).

## PR checklist

- [ ] `npm run typecheck && npm test`
- [ ] `npm run pack:check` (no unexpected files)
- [ ] CHANGELOG note under the current version
