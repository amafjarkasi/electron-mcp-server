import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Inventory } from "./inventory.ts";

export type Architecture = {
  manifestVersion: number | null;
  name: string | null;
  version: string | null;
  background: "service_worker" | "page" | "scripts" | null;
  contentScripts: Array<{ js: string[]; matches: string[]; css?: string[] }>;
  popup: string | null;
  options: string | null;
  sidePanel: string | null;
  permissions: string[];
  optionalPermissions: string[];
  hostPermissions: string[];
  optionalHostPermissions: string[];
  contentSecurityPolicy: unknown;
  externallyConnectable: unknown;
  declarativeNetRequest: boolean;
  webAccessibleResources: unknown;
  wasm: boolean;
  native: boolean;
  messagePassing: string[];
  capabilities: string[];
};

const PERMISSION_PLAIN: Record<string, string> = {
  activeTab: "Can access the current tab after the user invokes the extension.",
  alarms: "Can schedule periodic extension events.",
  bookmarks: "Can read and change bookmarks.",
  browsingData: "Can clear browsing data the user has stored.",
  clipboardRead: "Can read the clipboard.",
  clipboardWrite: "Can write to the clipboard.",
  contentSettings: "Can change site content settings.",
  contextMenus: "Can add items to the context menu.",
  cookies: "Can read cookies on sites it is allowed to access.",
  debugger: "Can attach to the debugger API on pages it can access.",
  declarativeNetRequest: "Can install static network request rules.",
  downloads: "Can manage downloads.",
  history: "Can read browsing history.",
  identity: "Can use identity / OAuth APIs.",
  idle: "Can detect idle state.",
  management: "Can list and manage other extensions.",
  notifications: "Can show notifications.",
  offscreen: "Can open an offscreen document.",
  scriptings: "Can inject scripts where host permission allows.",
  scripting: "Can inject scripts where host permission allows.",
  storage: "Can store data in extension storage.",
  tabs: "Can query and switch tabs.",
  tabCapture: "Can capture tab media streams.",
  unlimitedStorage: "Can exceed the default extension storage quota.",
  webNavigation: "Can observe navigation events.",
  webRequest: "Can observe (and, on MV2, modify) network requests.",
  windows: "Can create and arrange browser windows.",
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function permissionCapability(name: string): string {
  if (PERMISSION_PLAIN[name]) return PERMISSION_PLAIN[name];
  if (name === "<all_urls>" || name === "*://*/*") {
    return "Declared host access covers every website.";
  }
  if (name.includes("://") || name.startsWith("<")) {
    return `Declared host access: ${name}.`;
  }
  return `Declared permission: ${name}.`;
}

const MESSAGE_MARKERS = [
  "chrome.runtime.sendMessage",
  "chrome.runtime.onMessage",
  "chrome.runtime.connect",
  "browser.runtime.sendMessage",
  "chrome.tabs.sendMessage",
];

export async function buildArchitecture(
  originalDir: string,
  inventory: Inventory,
): Promise<Architecture> {
  const manifest = inventory.manifest;
  const background = manifest.background;
  let backgroundKind: Architecture["background"] = null;
  if (background && typeof background === "object") {
    const bg = background as Record<string, unknown>;
    if (typeof bg.service_worker === "string") backgroundKind = "service_worker";
    else if (typeof bg.page === "string") backgroundKind = "page";
    else if (Array.isArray(bg.scripts)) backgroundKind = "scripts";
  }

  const contentScripts: Architecture["contentScripts"] = [];
  if (Array.isArray(manifest.content_scripts)) {
    for (const item of manifest.content_scripts) {
      if (!item || typeof item !== "object") continue;
      const row = item as { js?: unknown; css?: unknown; matches?: unknown };
      contentScripts.push({
        js: asStringArray(row.js),
        css: asStringArray(row.css).length ? asStringArray(row.css) : undefined,
        matches: asStringArray(row.matches),
      });
    }
  }

  const permissions = asStringArray(manifest.permissions);
  const optionalPermissions = asStringArray(manifest.optional_permissions);
  const hostPermissions = asStringArray(manifest.host_permissions);
  const optionalHostPermissions = asStringArray(manifest.optional_host_permissions);

  const messagePassing = new Set<string>();
  for (const file of inventory.files.filter((item) => item.kind === "js")) {
    let text = "";
    try {
      text = await readFile(path.join(originalDir, file.path), "utf8");
    } catch {
      continue;
    }
    for (const marker of MESSAGE_MARKERS) {
      if (text.includes(marker)) messagePassing.add(marker);
    }
  }

  const capabilities = [
    ...permissions.map(permissionCapability),
    ...hostPermissions.map(permissionCapability),
  ];
  if (backgroundKind === "service_worker") {
    capabilities.push("Uses an MV3 service worker as the background context.");
  } else if (backgroundKind === "page" || backgroundKind === "scripts") {
    capabilities.push("Uses a persistent or event background page (typical of MV2).");
  }
  if (contentScripts.length) {
    capabilities.push("Injects content scripts on matching pages.");
  }
  if (inventory.entrypoints.popup) {
    capabilities.push("Shows a toolbar popup.");
  }

  return {
    manifestVersion: typeof manifest.manifest_version === "number" ? manifest.manifest_version : null,
    name: typeof manifest.name === "string" ? manifest.name : null,
    version: typeof manifest.version === "string" ? manifest.version : null,
    background: backgroundKind,
    contentScripts,
    popup: inventory.entrypoints.popup ?? null,
    options: inventory.entrypoints.options ?? null,
    sidePanel: inventory.entrypoints.sidePanel ?? null,
    permissions,
    optionalPermissions,
    hostPermissions,
    optionalHostPermissions,
    contentSecurityPolicy: manifest.content_security_policy ?? null,
    externallyConnectable: manifest.externally_connectable ?? null,
    declarativeNetRequest: Boolean(manifest.declarative_net_request),
    webAccessibleResources: manifest.web_accessible_resources ?? null,
    wasm: inventory.files.some((file) => file.kind === "wasm"),
    native: inventory.files.some((file) => file.kind === "native"),
    messagePassing: [...messagePassing].sort(),
    capabilities,
  };
}
