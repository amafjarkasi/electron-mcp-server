#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { analyzeExtension } from "../bot/lib/pipeline.ts";
import { isCrxReError } from "../bot/lib/errors.ts";
import { discoverTokens } from "../bot/lib/tokens.ts";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(error: unknown): never {
  if (isCrxReError(error)) {
    printJson({ error: { code: error.code, message: error.message } });
    process.exit(1);
  }
  const message = error instanceof Error ? error.message : String(error);
  printJson({ error: { code: "failed", message } });
  process.exit(1);
}

const tokens = defineCommand({
  meta: {
    name: "tokens",
    description: "Show discovered agent-owned provider keys (never values).",
  },
  args: {
    json: { type: "boolean", description: "JSON output", default: true },
  },
  run() {
    printJson(discoverTokens());
  },
});

const analyze = defineCommand({
  meta: {
    name: "analyze",
    description: "Download/unpack a public store listing or local CRX and write inventory + architecture.",
  },
  args: {
    input: {
      type: "positional",
      description: "Store URL, 32-letter ID, CRX URL, or local path",
      required: true,
    },
    out: { type: "string", description: "Output directory", alias: "o" },
    json: { type: "boolean", description: "JSON output", default: true },
    "keep-crx": { type: "boolean", description: "Keep the downloaded CRX beside original/" },
    "no-llm": {
      type: "boolean",
      description: "Skip reconstruction (default for this cut)",
      default: true,
    },
    "i-own-this": { type: "boolean", description: "Assert ownership of a local package" },
    force: { type: "boolean", description: "Raise the download size cap" },
  },
  async run({ args }) {
    try {
      const result = await analyzeExtension({
        input: String(args.input),
        outDir: args.out ? String(args.out) : undefined,
        keepCrx: Boolean(args.keepCrx ?? args["keep-crx"]),
        iOwnThis: Boolean(args.iOwnThis ?? args["i-own-this"]),
        force: Boolean(args.force),
      });
      printJson({
        runDir: result.runDir,
        source: result.source,
        format: result.format,
        sha256: result.sha256 ?? null,
        files: result.inventory.files.length,
        architecture: {
          name: result.architecture.name,
          manifestVersion: result.architecture.manifestVersion,
          permissions: result.architecture.permissions,
          hostPermissions: result.architecture.hostPermissions,
          capabilities: result.architecture.capabilities,
        },
        tokens: result.tokens,
        llm: result.llm,
      });
    } catch (error) {
      fail(error);
    }
  },
});

const main = defineCommand({
  meta: {
    name: "crx-re",
    version: "0.1.0",
    description: "Reverse-engineer a Chrome extension into a readable inventory (deterministic first).",
  },
  subCommands: { tokens, analyze },
});

await runMain(main);
