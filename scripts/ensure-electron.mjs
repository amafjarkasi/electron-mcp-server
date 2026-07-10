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

function electronBinaryExists() {
  try {
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

if (!fs.existsSync(electronDir)) {
  fail(
    "electron package is missing. Run: npm install electron --foreground-scripts"
  );
}

if (electronBinaryExists()) {
  const binary = require("electron");
  console.log(`[ensure-electron] OK: ${binary}`);
  process.exit(0);
}

if (!fs.existsSync(installJs)) {
  fail(
    "electron install.js missing. Delete node_modules/electron and reinstall."
  );
}

console.log(
  "[ensure-electron] Electron binary missing — running electron/install.js ..."
);
const result = spawnSync(process.execPath, [installJs], {
  cwd: electronDir,
  stdio: "inherit",
  env: process.env,
});

if (result.status !== 0) {
  fail(
    [
      "Failed to download Electron.",
      "Try:",
      "  npm approve-scripts electron",
      "  npm rebuild electron --foreground-scripts",
      "or:",
      "  Remove-Item -Recurse -Force node_modules\\electron; npm install electron --foreground-scripts",
    ].join("\n")
  );
}

if (!electronBinaryExists()) {
  const pathContents = fs.existsSync(pathTxt)
    ? fs.readFileSync(pathTxt, "utf8").trim()
    : "(missing path.txt)";
  fail(
    `Electron install finished but binary still missing (path.txt=${pathContents}).`
  );
}

console.log(`[ensure-electron] Installed: ${require("electron")}`);
