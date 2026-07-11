#!/usr/bin/env node
/**
 * Ensure the electron package has a real platform binary.
 * Downloads via @electron/get directly (ignores ELECTRON_SKIP_BINARY_DOWNLOAD).
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
  process.exitCode = 1;
  throw new Error(message);
}

function platformRelPath() {
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

function loadDep(id) {
  try {
    return requireFrom(root, id);
  } catch {
    return requireFrom(electronDir, id);
  }
}

function ensureDeps() {
  const tryResolve = () => {
    try {
      loadDep("@electron/get");
      loadDep("extract-zip");
      return true;
    } catch {
      return false;
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

function clearElectronCache() {
  const cacheRoot =
    process.env.electron_config_cache ||
    process.env.ELECTRON_CACHE ||
    path.join(os.homedir(), "AppData", "Local", "electron", "Cache");
  if (fs.existsSync(cacheRoot)) {
    console.warn(`[ensure-electron] Clearing Electron cache: ${cacheRoot}`);
    rmQuiet(cacheRoot);
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

function asPromise(maybePromise) {
  return Promise.resolve(maybePromise);
}

async function downloadElectron({ clearCache }) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(electronDir, "package.json"), "utf8")
  );
  const version = pkg.version;
  const rel = platformRelPath();
  const { downloadArtifact } = loadDep("@electron/get");
  const extractZip = loadDep("extract-zip");

  console.log(
    `[ensure-electron] Downloading Electron ${version} for ${os.platform()}/${os.arch()} ...`
  );

  delete process.env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  delete process.env.npm_config_electron_skip_binary_download;

  if (clearCache) {
    clearElectronCache();
  }

  rmQuiet(distDir);
  rmQuiet(pathTxt);
  fs.mkdirSync(distDir, { recursive: true });

  const zipPath = await asPromise(
    downloadArtifact({
      version,
      artifactName: "electron",
      force: true,
      platform: process.env.npm_config_platform || process.platform,
      arch: process.env.npm_config_arch || process.arch,
    })
  );

  if (!zipPath || !fs.existsSync(zipPath)) {
    fail(`downloadArtifact did not return a zip file: ${String(zipPath)}`);
  }

  const zipSize = fs.statSync(zipPath).size;
  console.log(
    `[ensure-electron] Extracting ${zipPath} (${zipSize} bytes) ...`
  );
  if (zipSize < 1_000_000) {
    fail(
      `Electron zip is suspiciously small (${zipSize} bytes). Cache is likely corrupt.`
    );
  }

  await asPromise(extractZip(zipPath, { dir: distDir }));

  const listing = fs.existsSync(distDir)
    ? fs.readdirSync(distDir)
    : [];
  console.log(
    `[ensure-electron] dist entries (${listing.length}): ${listing
      .slice(0, 20)
      .join(", ")}`
  );

  const binary = path.join(distDir, rel);
  if (!fs.existsSync(binary)) {
    fail(
      `Extract finished but ${rel} is missing. dist contains: ${
        listing.slice(0, 30).join(", ") || "(empty)"
      }`
    );
  }

  fs.writeFileSync(pathTxt, rel, "utf8");
  fs.writeFileSync(path.join(distDir, "version"), version, "utf8");

  if (!resolveBinary()) {
    fail("Wrote path.txt but binary still does not resolve.");
  }

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
    const binary = await downloadElectron({ clearCache: false });
    console.log(`[ensure-electron] Installed: ${binary}`);
  } catch (err) {
    console.error(
      `[ensure-electron] First download attempt failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    console.warn("[ensure-electron] Retrying after clearing Electron cache...");
    const binary = await downloadElectron({ clearCache: true });
    console.log(`[ensure-electron] Installed after cache clear: ${binary}`);
  }
}

main()
  .then(() => {
    const binary = resolveBinary();
    if (!binary) {
      console.error(
        "[ensure-electron] Finished without a resolvable Electron binary."
      );
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error(
      `[ensure-electron] ${err instanceof Error ? err.stack || err.message : String(err)}`
    );
    console.error(
      [
        "",
        "Try in PowerShell:",
        "  Remove-Item Env:ELECTRON_SKIP_BINARY_DOWNLOAD -ErrorAction SilentlyContinue",
        "  $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'",
        "  Remove-Item -Recurse -Force \"$env:LOCALAPPDATA\\electron\\Cache\" -ErrorAction SilentlyContinue",
        "  Remove-Item -Recurse -Force node_modules\\electron -ErrorAction SilentlyContinue",
        "  npm install electron --foreground-scripts",
        "  node .\\scripts\\ensure-electron.mjs",
      ].join("\n")
    );
    process.exit(1);
  });
