#!/usr/bin/env node
/**
 * Ensure the electron package has a real platform binary.
 * Downloads via @electron/get and extracts with system tar when possible
 * (extract-zip has been unreliable on some Windows setups).
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

function log(message) {
  console.log(`[ensure-electron] ${message}`);
}

function warn(message) {
  console.warn(`[ensure-electron] ${message}`);
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
  try {
    loadDep("@electron/get");
    return;
  } catch {
    // continue
  }

  warn("Installing @electron/get ...");
  const result = spawnSync(
    "npm",
    ["install", "--foreground-scripts", "--no-save", "@electron/get@^2.0.0"],
    { cwd: root, encoding: "utf8", shell: true, env: process.env }
  );
  if (result.stdout?.trim()) console.log(result.stdout.trimEnd());
  if (result.stderr?.trim()) console.error(result.stderr.trimEnd());
  try {
    loadDep("@electron/get");
  } catch {
    throw new Error(
      "Could not install @electron/get. Run: npm install @electron/get --foreground-scripts"
    );
  }
}

function clearElectronCache() {
  const candidates = [
    process.env.electron_config_cache,
    process.env.ELECTRON_CACHE,
    process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local", "electron", "Cache")
      : path.join(os.homedir(), ".cache", "electron"),
  ].filter(Boolean);

  for (const cacheRoot of candidates) {
    if (fs.existsSync(cacheRoot)) {
      warn(`Clearing Electron cache: ${cacheRoot}`);
      rmQuiet(cacheRoot);
    }
  }
}

function extractWithTar(zipPath, outDir) {
  const result = spawnSync(
    "tar",
    ["-xf", zipPath, "-C", outDir],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(
      `tar extract failed (code ${result.status}): ${
        result.stderr || result.stdout || "no output"
      }`
    );
  }
}

async function extractWithExtractZip(zipPath, outDir) {
  const extractZip = loadDep("extract-zip");
  await Promise.resolve(extractZip(zipPath, { dir: outDir }));
}

async function extractZipFile(zipPath, outDir) {
  // Prefer system tar — more reliable on Windows than extract-zip here.
  try {
    log("Extracting with system tar...");
    extractWithTar(zipPath, outDir);
    return "tar";
  } catch (err) {
    warn(
      `tar extract failed (${err instanceof Error ? err.message : String(err)}); trying extract-zip...`
    );
    await extractWithExtractZip(zipPath, outDir);
    return "extract-zip";
  }
}

async function downloadElectron({ clearCache }) {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(electronDir, "package.json"), "utf8")
  );
  const version = pkg.version;
  const rel = platformRelPath();
  const { downloadArtifact } = loadDep("@electron/get");

  log(`Downloading Electron ${version} for ${os.platform()}/${os.arch()} ...`);

  delete process.env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  delete process.env.npm_config_electron_skip_binary_download;

  if (clearCache) {
    clearElectronCache();
  }

  rmQuiet(distDir);
  rmQuiet(pathTxt);
  fs.mkdirSync(distDir, { recursive: true });

  const zipPath = await Promise.resolve(
    downloadArtifact({
      version,
      artifactName: "electron",
      force: true,
      platform: process.env.npm_config_platform || process.platform,
      arch: process.env.npm_config_arch || process.arch,
    })
  );

  if (!zipPath || !fs.existsSync(zipPath)) {
    throw new Error(`downloadArtifact did not return a zip file: ${String(zipPath)}`);
  }

  const zipSize = fs.statSync(zipPath).size;
  log(`Downloaded zip: ${zipPath} (${zipSize} bytes)`);
  if (zipSize < 1_000_000) {
    throw new Error(
      `Electron zip is suspiciously small (${zipSize} bytes). Cache is likely corrupt.`
    );
  }

  const method = await extractZipFile(zipPath, distDir);
  log(`Extract method: ${method}`);

  const listing = fs.existsSync(distDir) ? fs.readdirSync(distDir) : [];
  log(`dist entries (${listing.length}): ${listing.slice(0, 25).join(", ")}`);

  const binary = path.join(distDir, rel);
  if (!fs.existsSync(binary)) {
    throw new Error(
      `Extract finished but ${rel} is missing. dist contains: ${
        listing.slice(0, 40).join(", ") || "(empty)"
      }`
    );
  }

  fs.writeFileSync(pathTxt, rel, "utf8");
  fs.writeFileSync(path.join(distDir, "version"), version, "utf8");
  log(`Wrote ${pathTxt} -> ${rel}`);

  if (!resolveBinary()) {
    throw new Error("Wrote path.txt but binary still does not resolve.");
  }

  return binary;
}

async function main() {
  if (!fs.existsSync(electronDir)) {
    throw new Error(
      "electron package is missing. Run: npm install electron --foreground-scripts"
    );
  }

  const existing = resolveBinary();
  if (existing) {
    log(`OK: ${existing}`);
    return existing;
  }

  ensureDeps();

  try {
    const binary = await downloadElectron({ clearCache: false });
    log(`Installed: ${binary}`);
    return binary;
  } catch (err) {
    warn(
      `First download attempt failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    warn("Retrying after clearing Electron cache...");
    const binary = await downloadElectron({ clearCache: true });
    log(`Installed after cache clear: ${binary}`);
    return binary;
  }
}

main()
  .then((binary) => {
    const resolved = resolveBinary();
    if (!resolved) {
      console.error(
        "[ensure-electron] Finished without a resolvable Electron binary."
      );
      process.exit(1);
    }
    log(`Verified binary: ${resolved}`);
    if (binary && binary !== resolved) {
      log(`(download returned ${binary})`);
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
        "Try these PowerShell commands:",
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
