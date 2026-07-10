#!/usr/bin/env node
/**
 * Ensure the electron package downloaded its platform binary.
 * Needed when npm blocks install scripts (allowScripts) or a prior install failed.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronDir = path.join(root, "node_modules", "electron");
const installJs = path.join(electronDir, "install.js");
const pathTxt = path.join(electronDir, "path.txt");
const distDir = path.join(electronDir, "dist");

const requireFromRoot = createRequire(path.join(root, "package.json"));
const requireFromElectron = fs.existsSync(path.join(electronDir, "package.json"))
  ? createRequire(path.join(electronDir, "package.json"))
  : null;

function resolveElectronBinary() {
  if (fs.existsSync(pathTxt)) {
    const rel = fs.readFileSync(pathTxt, "utf8").trim();
    if (rel) {
      const candidate = path.join(distDir, rel);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  // Fallback: ask the electron package itself.
  if (!requireFromElectron) return null;
  try {
    const indexJs = path.join(electronDir, "index.js");
    delete requireFromElectron.cache[indexJs];
    const binary = requireFromElectron(indexJs);
    if (typeof binary === "string" && fs.existsSync(binary)) {
      return binary;
    }
  } catch {
    // ignore
  }
  return null;
}

function hasElectronGet() {
  try {
    if (requireFromElectron) {
      requireFromElectron.resolve("@electron/get");
      return true;
    }
  } catch {
    // ignore
  }
  try {
    requireFromRoot.resolve("@electron/get");
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  console.error(`[ensure-electron] ${message}`);
  process.exit(1);
}

function rmQuiet(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

if (!fs.existsSync(electronDir)) {
  fail(
    "electron package is missing. Run this in PowerShell:\nnpm install electron --foreground-scripts"
  );
}

const existing = resolveElectronBinary();
if (existing) {
  console.log(`[ensure-electron] OK: ${existing}`);
  process.exit(0);
}

if (!fs.existsSync(installJs)) {
  fail(
    "electron install.js missing. Delete node_modules\\electron and reinstall."
  );
}

if (!hasElectronGet()) {
  console.warn(
    "[ensure-electron] @electron/get not resolvable yet — installing electron deps..."
  );
  const depInstall = spawnSync(
    "npm",
    ["install", "--foreground-scripts", "--no-save", "@electron/get", "extract-zip"],
    {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      shell: true,
    }
  );
  if (depInstall.stdout?.trim()) console.log(depInstall.stdout.trimEnd());
  if (depInstall.stderr?.trim()) console.error(depInstall.stderr.trimEnd());
  if (depInstall.status !== 0 || !hasElectronGet()) {
    fail(
      [
        "@electron/get is missing and could not be installed.",
        "In PowerShell run:",
        "  npm install @electron/get extract-zip --foreground-scripts",
        "  npm install electron --foreground-scripts",
      ].join("\n")
    );
  }
}

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
  console.warn(
    "[ensure-electron] ELECTRON_SKIP_BINARY_DOWNLOAD was set — clearing it for this install."
  );
}

// Clear partial installs so electron/install.js does real work.
rmQuiet(pathTxt);
rmQuiet(path.join(distDir, "version"));

console.log(
  `[ensure-electron] Downloading Electron for ${process.platform}/${process.arch} ...`
);

const env = {
  ...process.env,
};
delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
env.force_no_cache = process.env.force_no_cache || "true";

const result = spawnSync(process.execPath, [installJs], {
  cwd: electronDir,
  env,
  encoding: "utf8",
});

if (result.stdout?.trim()) {
  console.log(result.stdout.trimEnd());
}
if (result.stderr?.trim()) {
  console.error(result.stderr.trimEnd());
}

if (result.error) {
  fail(`Failed to spawn electron install.js: ${result.error.message}`);
}

if (result.status !== 0) {
  fail(
    [
      `electron/install.js exited with code ${result.status}.`,
      "In PowerShell run these exactly:",
      "  Remove-Item Env:ELECTRON_SKIP_BINARY_DOWNLOAD -ErrorAction SilentlyContinue",
      "  Remove-Item -Recurse -Force node_modules\\electron -ErrorAction SilentlyContinue",
      "  npm install electron --foreground-scripts",
      "If download is blocked:",
      "  $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'",
      "  npm install electron --foreground-scripts",
    ].join("\n")
  );
}

const binary = resolveElectronBinary();
if (!binary) {
  const pathContents = fs.existsSync(pathTxt)
    ? fs.readFileSync(pathTxt, "utf8").trim()
    : "(missing path.txt)";
  const distListing = fs.existsSync(distDir)
    ? fs.readdirSync(distDir).slice(0, 20).join(", ")
    : "(no dist/)";
  fail(
    [
      "Electron install reported success but binary is still missing.",
      `path.txt=${pathContents}`,
      `dist=${distListing}`,
      "In PowerShell run:",
      "  Remove-Item -Recurse -Force node_modules\\electron",
      "  npm install electron --foreground-scripts",
      "  npm run ensure-electron",
    ].join("\n")
  );
}

console.log(`[ensure-electron] Installed: ${binary}`);
