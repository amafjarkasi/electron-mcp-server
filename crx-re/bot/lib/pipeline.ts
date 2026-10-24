import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildArchitecture, type Architecture } from "./architecture.ts";
import { stripCrx } from "./crx.ts";
import { downloadStoreCrx, downloadUrl, DEFAULT_MAX_BYTES } from "./download.ts";
import { buildInventory, type Inventory } from "./inventory.ts";
import { resolveSource } from "./resolve.ts";
import { discoverTokens, type TokenDiscovery } from "./tokens.ts";
import { unpackZip } from "./unpack.ts";

export type AnalyzeOptions = {
  input: string;
  outDir?: string;
  keepCrx?: boolean;
  iOwnThis?: boolean;
  force?: boolean;
  maxBytes?: number;
};

export type AnalyzeResult = {
  runDir: string;
  source: ReturnType<typeof resolveSource>;
  format: "crx2" | "crx3" | "zip" | "unpacked";
  sha256?: string;
  inventory: Inventory;
  architecture: Architecture;
  tokens: TokenDiscovery;
  llm: { skipped: true; reason: string };
};

function slugFor(source: ReturnType<typeof resolveSource>): string {
  if (source.kind === "store-id") return source.id;
  if (source.kind === "local-dir" || source.kind === "local-file") {
    return path.basename(source.path).replace(/\.(crx|zip)$/i, "") || "extension";
  }
  try {
    return new URL(source.url).pathname.split("/").filter(Boolean).pop()?.replace(/\.(crx|zip)$/i, "") || "extension";
  } catch {
    return "extension";
  }
}

export async function analyzeExtension(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const source = resolveSource(options.input);

  const runDir = path.resolve(options.outDir ?? path.join(process.cwd(), "out", slugFor(source)));
  const originalDir = path.join(runDir, "original");
  await mkdir(runDir, { recursive: true });

  let format: AnalyzeResult["format"] = "unpacked";
  let sha256: string | undefined;

  if (source.kind === "local-dir") {
    await cp(source.path, originalDir, { recursive: true, force: true });
    format = "unpacked";
  } else {
    let bytes: Buffer;
    if (source.kind === "store-id") {
      const downloaded = await downloadStoreCrx(source.id, {
        maxBytes: options.force ? options.maxBytes ?? 80 * 1024 * 1024 : options.maxBytes ?? DEFAULT_MAX_BYTES,
      });
      bytes = downloaded.bytes;
    } else if (source.kind === "crx-url") {
      const downloaded = await downloadUrl(source.url, {
        maxBytes: options.force ? options.maxBytes ?? 80 * 1024 * 1024 : options.maxBytes ?? DEFAULT_MAX_BYTES,
      });
      bytes = downloaded.bytes;
    } else {
      bytes = await readFile(source.path);
    }

    sha256 = createHash("sha256").update(bytes).digest("hex");
    if (options.keepCrx) {
      await writeFile(path.join(runDir, "original.crx"), bytes);
    }

    const stripped = stripCrx(bytes);
    format = stripped.format;
    await unpackZip(stripped.zip, originalDir);
  }

  const inventory = await buildInventory(originalDir);
  const architecture = await buildArchitecture(originalDir, inventory);
  const tokens = discoverTokens();

  const meta = {
    source,
    format,
    sha256: sha256 ?? null,
    createdAt: new Date().toISOString(),
  };

  await writeFile(path.join(runDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  await writeFile(path.join(runDir, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(path.join(runDir, "architecture.json"), `${JSON.stringify(architecture, null, 2)}\n`);

  const brief = [
    `# ${architecture.name ?? slugFor(source)}`,
    "",
    "Deterministic capability brief (no LLM).",
    "",
    ...architecture.capabilities.map((line) => `- ${line}`),
    "",
    "Original files are in `original/`. Reconstruction / review were skipped (`--no-llm` default until a preferred provider key is used in a later phase).",
    "",
  ].join("\n");
  await writeFile(path.join(runDir, "REPORT.md"), brief);

  return {
    runDir,
    source,
    format,
    sha256,
    inventory,
    architecture,
    tokens,
    llm: {
      skipped: true,
      reason: tokens.selected
        ? "Preferred provider present; LLM reconstruction is Phase 5 and not invoked from --no-llm / this cut."
        : "No preferred reconstruction token (MiMo / DeepSeek / Z.ai / MiniMax / Kimi / Qwen).",
    },
  };
}
