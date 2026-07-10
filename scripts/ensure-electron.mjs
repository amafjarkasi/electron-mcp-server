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

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronDir = path.join(root, "node_modules", "electron");
const installJs = path.join(electronDir, "install.js");
const pathTxt = path.join(electronDir, "path.txt");
const distDir = path.join(electronDir, "dist");

function electronBinaryExists() {
  try {
    // Fresh require each check — clear cache in case path.txt appeared.
    const resolved = require.resolve("electron");
    delete require.cache[resolved];
    const binary = require("electron");
    return typeof binary === "string" && fs.existsSync(binary);
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
    "electron package is missing. Run:\nnpm install electron --foreground-scripts"
  );
}

if (electronBinaryExists()) {
  const binary = require("electron");
  console.log(`[ensure-electron] OK: ${binary}`);
  process.exit(0);
}

if (!fs.existsSync(installJs)) {
  fail(
    "electron install.js missing. Delete node_modules\\electron and reinstall."
  );
}

const getPkg = path.join(electronDir, "node_modules", "@electron", "get");
if (!fs.existsSync(getPkg)) {
  fail(
    [
      "electron dependency @electron/get is missing.",
      "Run:",
      "  Remove-Item -Recurse -Force node_modules\\electron",
      "  npm install electron --foreground-scripts",
    ].join("\n")
  );
}

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
  console.warn(
    "[ensure-electron] ELECTRON_SKIP_BINARY_DOWNLOAD was set — ignoring it so the binary can download."
  );
}

// Clear partial installs so electron/install.js does not think it is done.
rmQuiet(pathTxt);
rmQuiet(path.join(distDir, "version"));

console.log(
  `[ensure-electron] Downloading Electron for ${process.platform}/${process.arch} ...`
);

const env = {
  ...process.env,
  ELECTRON_SKIP_BINARY_DOWNLOAD: "",
  // force_no_cache can help recover from a corrupt cache entry
  force_no_cache: process.env.force_no_cache || "true",
};

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
      "Common fixes on Windows:",
      "  $env:ELECTRON_SKIP_BINARY_DOWNLOAD=$null",
      "  Remove-Item -Recurse -Force node_modules\\electron -ErrorAction SilentlyContinue",
      "  npm install electron --foreground-scripts",
      "If you are offline/firewalled, set a mirror, e.g.:",
      "  $env:ELECTRON_MIRROR=\"https://npmmirror.com/mirrors/electron/\"",
    ].join("\n")
  );
}

// Clear require cache and re-check
try {
  const resolved = require.resolve("electron");
  delete require.cache[resolved];
} catch {
  // ignore
}

if (!electronBinaryExists()) {
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
      "Try a clean reinstall:",
      "  Remove-Item -Recurse -Force node_modules\\electron",
      "  npm install electron --foreground-scripts",
    ].join("\n")
  );
}

console.log(`[ensure-electron] Installed: ${require("electron")}`);
