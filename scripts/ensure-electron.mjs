#!/usr/bin/env node
/**
 * Ensure the electron package has a real platform binary.
 * Downloads via @electron/get directly (does not trust electron/install.js,
 * which no-ops when ELECTRON_SKIP_BINARY_DOWNLOAD is set).
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronDir = path.join(root, "node_modules", "electron");
const pathTxt = path.join(electronDir, "path.txt");
const distDir = path.join(electronDir, "dist");

function fail(message) {
  console.error(`[ensure-electron] ${message}`);
  process.exit(1);
}

function platformPath() {
  switch (os.platform()) {
    case "darwin":
    case "mas":
      return "Electron.app/Contents/MacOS/Electron";
    case "win32":
      return "electron.exe";
    default:
      return "electron";
  }
}

function resolveBinary() {
  if (!fs.existsSync(pathTxt)) return null;
  const rel = fs.readFileSync(pathTxt, "utf8").trim();
  if (!rel) return null;
  const candidate = path.join(distDir, rel);
  return fs.existsSync(candidate) ? candidate : null;
}

function rmQuiet(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function requireFrom(dir, id) {
  const req = createRequire(path.join(dir, "package.json"));
  return req(id);
}

function ensureDeps() {
  const tryResolve = () => {
    try {
      requireFrom(root, "@electron/get");
      requireFrom(root, "extract-zip");
      return true;
    } catch {
      try {
        requireFrom(electronDir, "@electron/get");
        requireFrom(electronDir, "extract-zip");
        return true;
      } catch {
        return false;
      }
    }
  };

  if (tryResolve()) return;

  console.warn("[ensure-electron] Installing @electron/get and extract-zip...");
  const result = spawnSync(
    "npm",
    [
      "install",
      "--foreground-scripts",
      "--no-save",
      "@electron/get@^2.0.0",
      "extract-zip@^2.0.1",
    ],
    { cwd: root, encoding: "utf8", shell: true, env: process.env }
  );
  if (result.stdout?.trim()) console.log(result.stdout.trimEnd());
  if (result.stderr?.trim()) console.error(result.stderr.trimEnd());
  if (result.status !== 0 || !tryResolve()) {
    fail(
      "Could not install @electron/get / extract-zip. Run:\nnpm install @electron/get extract-zip --foreground-scripts"
    );
  }
}

function loadDep(id) {
  try {
    return requireFrom(root, id);
  } catch {
    return requireFrom(electronDir, id);
  }
}

function dumpElectronEnv() {
  const keys = Object.keys(process.env)
    .filter((k) => /electron/i.test(k))
    .sort();
  if (!keys.length) {
    console.log("[ensure-electron] No Electron-related env vars set.");
    return;
  }
  console.log("[ensure-electron] Electron-related env:");
  for (const key of keys) {
    console.log(`  ${key}=${process.env[key]}`);
  }
}

async function downloadElectron() {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(electronDir, "package.json"), "utf8")
  );
  const version = pkg.version;
  const rel = platformPath();
  const { downloadArtifact } = loadDep("@electron/get");
  const extract = loadDep("extract-zip");

  console.log(
    `[ensure-electron] Downloading Electron ${version} for ${os.platform()}/${os.arch()} ...`
  );

  // Never honor skip flags for this recovery path.
  delete process.env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  delete process.env.npm_config_electron_skip_binary_download;

  rmQuiet(distDir);
  rmQuiet(pathTxt);
  fs.mkdirSync(distDir, { recursive: true });

  const zipPath = await downloadArtifact({
    version,
    artifactName: "electron",
    force: true,
    platform: process.env.npm_config_platform || process.platform,
    arch: process.env.npm_config_arch || process.arch,
  });

  console.log(`[ensure-electron] Extracting ${zipPath} ...`);
  await extract(zipPath, { dir: distDir });

  const binary = path.join(distDir, rel);
  if (!fs.existsSync(binary)) {
    const listing = fs.existsSync(distDir)
      ? fs.readdirSync(distDir).slice(0, 30).join(", ")
      : "(empty)";
    throw new Error(
      `Extract finished but ${rel} is missing. dist contains: ${listing}`
    );
  }

  fs.writeFileSync(pathTxt, rel);
  fs.writeFileSync(path.join(distDir, "version"), version);
  return binary;
}

async function main() {
  if (!fs.existsSync(electronDir)) {
    fail(
      "electron package is missing. Run:\nnpm install electron --foreground-scripts"
    );
  }

  const existing = resolveBinary();
  if (existing) {
    console.log(`[ensure-electron] OK: ${existing}`);
    return;
  }

  dumpElectronEnv();
  ensureDeps();

  try {
    const binary = await downloadElectron();
    console.log(`[ensure-electron] Installed: ${binary}`);
  } catch (err) {
    const message = err instanceof Error ? err.stack || err.message : String(err);
    fail(
      [
        "Failed to download Electron binary.",
        message,
        "",
        "Try in PowerShell:",
        "  Remove-Item Env:ELECTRON_SKIP_BINARY_DOWNLOAD -ErrorAction SilentlyContinue",
        "  $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'",
        "  Remove-Item -Recurse -Force node_modules\\electron -ErrorAction SilentlyContinue",
        "  npm install electron --foreground-scripts",
        "  npm run ensure-electron",
      ].join("\n")
    );
  }
}

main();
