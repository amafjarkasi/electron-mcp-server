import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { CrxReError } from "./errors.ts";

export type InventoryFile = {
  path: string;
  size: number;
  sha256: string;
  kind: "js" | "css" | "html" | "json" | "wasm" | "image" | "locale" | "native" | "other";
};

export type Inventory = {
  manifest: Record<string, unknown>;
  files: InventoryFile[];
  entrypoints: {
    background?: string[];
    contentScripts?: string[];
    popup?: string;
    options?: string;
    sidePanel?: string;
  };
};

function classify(rel: string): InventoryFile["kind"] {
  const lower = rel.toLowerCase();
  if (lower.startsWith("_locales/")) return "locale";
  if (/\.(exe|dll|so|dylib|node|nexe)$/.test(lower)) return "native";
  if (lower.endsWith(".wasm")) return "wasm";
  if (/\.(js|mjs|cjs)$/.test(lower)) return "js";
  if (lower.endsWith(".css")) return "css";
  if (/\.html?$/.test(lower)) return "html";
  if (lower.endsWith(".json")) return "json";
  if (/\.(png|jpe?g|gif|svg|webp|ico)$/.test(lower)) return "image";
  return "other";
}

async function walk(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(root, full)));
    } else if (entry.isFile()) {
      files.push(path.relative(root, full).split(path.sep).join("/"));
    }
  }
  return files;
}

export async function buildInventory(originalDir: string): Promise<Inventory> {
  const manifestPath = path.join(originalDir, "manifest.json");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    throw new CrxReError("MANIFEST_MISSING", "original/manifest.json is missing.");
  }

  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    manifest = parsed as Record<string, unknown>;
  } catch {
    throw new CrxReError("MANIFEST_INVALID", "manifest.json is not valid JSON object.");
  }

  const rels = (await walk(originalDir)).sort();
  const files: InventoryFile[] = [];
  for (const rel of rels) {
    const full = path.join(originalDir, rel);
    const info = await stat(full);
    const sha256 = createHash("sha256")
      .update(await readFile(full))
      .digest("hex");
    files.push({ path: rel, size: info.size, sha256, kind: classify(rel) });
  }

  const background = manifest.background;
  const backgroundFiles: string[] = [];
  if (background && typeof background === "object") {
    const bg = background as Record<string, unknown>;
    if (typeof bg.service_worker === "string") backgroundFiles.push(bg.service_worker);
    if (typeof bg.page === "string") backgroundFiles.push(bg.page);
    if (Array.isArray(bg.scripts)) {
      for (const script of bg.scripts) {
        if (typeof script === "string") backgroundFiles.push(script);
      }
    }
  }

  const contentScripts: string[] = [];
  if (Array.isArray(manifest.content_scripts)) {
    for (const item of manifest.content_scripts) {
      if (item && typeof item === "object" && Array.isArray((item as { js?: unknown }).js)) {
        for (const script of (item as { js: unknown[] }).js) {
          if (typeof script === "string") contentScripts.push(script);
        }
      }
    }
  }

  const action = manifest.action ?? manifest.browser_action ?? manifest.page_action;
  const popup =
    action && typeof action === "object" && typeof (action as { default_popup?: unknown }).default_popup === "string"
      ? (action as { default_popup: string }).default_popup
      : undefined;

  const optionsUi = manifest.options_ui;
  const options =
    typeof manifest.options_page === "string"
      ? manifest.options_page
      : optionsUi && typeof optionsUi === "object" && typeof (optionsUi as { page?: unknown }).page === "string"
        ? (optionsUi as { page: string }).page
        : undefined;

  const sidePanel = manifest.side_panel;
  const sidePanelPath =
    sidePanel && typeof sidePanel === "object" && typeof (sidePanel as { default_path?: unknown }).default_path === "string"
      ? (sidePanel as { default_path: string }).default_path
      : undefined;

  return {
    manifest,
    files,
    entrypoints: {
      background: backgroundFiles.length ? backgroundFiles : undefined,
      contentScripts: contentScripts.length ? contentScripts : undefined,
      popup,
      options,
      sidePanel: sidePanelPath,
    },
  };
}
