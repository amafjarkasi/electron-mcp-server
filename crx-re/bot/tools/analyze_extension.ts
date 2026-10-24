import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { isCrxReError } from "../lib/errors.ts";
import { analyzeExtension } from "../lib/pipeline.ts";

export default defineTool({
  description:
    "Resolve a Chrome Web Store URL/ID or local CRX/zip/folder, unpack it, and write original/, inventory.json, and architecture.json. Does not run an LLM.",
  execution: "server",
  effect: "write",
  inputSchema: z.object({
    input: z.string().describe("Store URL, 32-letter ID, CRX URL, or local path"),
    outDir: z.string().optional(),
    keepCrx: z.boolean().optional(),
    force: z.boolean().optional(),
  }),
  async execute({ input, outDir, keepCrx, force }) {
    try {
      const result = await analyzeExtension({ input, outDir, keepCrx, force });
      return {
        ok: true,
        runDir: result.runDir,
        format: result.format,
        fileCount: result.inventory.files.length,
        name: result.architecture.name,
        manifestVersion: result.architecture.manifestVersion,
        capabilities: result.architecture.capabilities,
        llm: result.llm,
      };
    } catch (error) {
      if (isCrxReError(error)) {
        return { ok: false, code: error.code, message: error.message };
      }
      return {
        ok: false,
        code: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
});
