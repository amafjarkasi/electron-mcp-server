import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { CrxReError } from "./errors.ts";

const EXTENSION_ID = /^[a-z]{32}$/;
const CWS_DETAIL =
  /^https?:\/\/(?:chrome\.google\.com\/webstore|chromewebstore\.google\.com)\/detail\/(?:[^/]+\/)?([a-z]{32})(?:[/?#]|$)/i;

export type ResolvedSource =
  | { kind: "store-id"; id: string; source: string }
  | { kind: "crx-url"; url: string; source: string }
  | { kind: "local-file"; path: string; source: string }
  | { kind: "local-dir"; path: string; source: string };

export function extractExtensionId(input: string): string | null {
  const trimmed = input.trim();
  if (EXTENSION_ID.test(trimmed)) return trimmed;
  const match = CWS_DETAIL.exec(trimmed);
  return match?.[1] ?? null;
}

export function resolveSource(input: string): ResolvedSource {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new CrxReError("INVALID_INPUT", "Provide a store URL, extension ID, CRX URL, or local path.");
  }

  const id = extractExtensionId(trimmed);
  if (id) {
    return { kind: "store-id", id, source: trimmed };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    if (/\.(crx|zip)(?:[?#]|$)/i.test(trimmed)) {
      return { kind: "crx-url", url: trimmed, source: trimmed };
    }
    throw new CrxReError(
      "INVALID_INPUT",
      "URL is not a Chrome Web Store listing or a direct .crx/.zip link.",
    );
  }

  const resolved = path.resolve(trimmed);
  if (!existsSync(resolved)) {
    throw new CrxReError("INVALID_INPUT", `Path not found: ${trimmed}`);
  }
  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    return { kind: "local-dir", path: resolved, source: trimmed };
  }
  return { kind: "local-file", path: resolved, source: trimmed };
}

export function storeDownloadUrl(id: string, prodversion = "141.0.7390.55"): string {
  return (
    "https://clients2.google.com/service/update2/crx?response=redirect" +
    `&prodversion=${encodeURIComponent(prodversion)}` +
    "&acceptformat=crx2,crx3" +
    `&x=id%3D${id}%26uc`
  );
}
