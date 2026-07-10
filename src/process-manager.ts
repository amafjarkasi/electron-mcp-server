import { spawn, ChildProcess } from "child_process";
import { createRequire } from "module";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";
import CDP from "chrome-remote-interface";
import { log } from "./log.js";

const require = createRequire(import.meta.url);

export interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
}

export interface ElectronProcess {
  id: string;
  process: ChildProcess;
  name: string;
  status: "running" | "stopped" | "crashed";
  pid?: number;
  debugPort?: number;
  startTime: Date;
  logs: string[];
  appPath: string;
  cdpClient?: CDP.Client;
  cdpTargetId?: string;
  targets?: CDPTarget[];
  lastTargetUpdate?: Date;
}

export interface ElectronDebugInfo {
  id: string;
  name: string;
  status: ElectronProcess["status"];
  pid?: number;
  debugPort?: number;
  startTime: Date;
  appPath: string;
  webContents: Array<{
    id: number;
    url: string;
    title: string;
    type: string;
    debuggable: boolean;
    debugPort?: number;
    targetId?: string;
  }>;
}

const electronProcesses = new Map<string, ElectronProcess>();

function getElectronExecutablePath(): string {
  try {
    const fromPackage = require("electron") as string;
    if (fromPackage && fs.existsSync(fromPackage)) {
      return fromPackage;
    }
  } catch {
    // Fall through to path search
  }

  const isWin = process.platform === "win32";
  const binName = isWin ? "electron.cmd" : "electron";
  const here = path.dirname(fileURLToPath(import.meta.url));

  const candidates = [
    path.resolve(process.cwd(), "node_modules", ".bin", binName),
    path.resolve(here, "..", "node_modules", ".bin", binName),
  ];

  if (isWin) {
    candidates.push(
      path.join(os.homedir(), "AppData", "Roaming", "npm", binName)
    );
  } else {
    candidates.push(path.join(os.homedir(), ".npm-global", "bin", binName));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return "electron";
}

async function waitForDebugPort(
  port: number,
  timeoutMs = 20000
): Promise<void> {
  const started = Date.now();
  let lastError: unknown;

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Debug port ${port} did not become ready within ${timeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

export function listProcesses(): Array<{
  id: string;
  name: string;
  status: ElectronProcess["status"];
  pid?: number;
  debugPort?: number;
  startTime: Date;
  appPath: string;
  targetCount: number;
}> {
  return Array.from(electronProcesses.entries()).map(([id, proc]) => ({
    id,
    name: proc.name,
    status: proc.status,
    pid: proc.pid,
    debugPort: proc.debugPort,
    startTime: proc.startTime,
    appPath: proc.appPath,
    targetCount: proc.targets?.length ?? 0,
  }));
}

export function getProcess(id: string): ElectronProcess | undefined {
  return electronProcesses.get(id);
}

export function getAllProcesses(): Map<string, ElectronProcess> {
  return electronProcesses;
}

export async function startElectronApp(
  appPath: string,
  debugPort?: number,
  extraArgs: string[] = []
): Promise<ElectronProcess> {
  const resolvedAppPath = path.resolve(appPath);
  if (!fs.existsSync(resolvedAppPath)) {
    throw new Error(`App path does not exist: ${resolvedAppPath}`);
  }

  const id = `electron-${Date.now()}`;
  const port =
    debugPort ?? Math.floor(Math.random() * (9999 - 9222 + 1)) + 9222;

  // Containers / CI often need --no-sandbox for Electron to start.
  const autoArgs: string[] = [];
  if (
    process.env.ELECTRON_MCP_NO_SANDBOX === "1" ||
    process.env.CI === "true" ||
    !process.env.DISPLAY
  ) {
    autoArgs.push("--no-sandbox");
  }

  const args = [
    `--remote-debugging-port=${port}`,
    "--enable-logging",
    "--disable-gpu",
    ...autoArgs,
    ...extraArgs,
    resolvedAppPath,
  ];

  const electronPath = getElectronExecutablePath();
  log.info(`Starting ${resolvedAppPath} via ${electronPath} on port ${port}`);

  const electronProc = spawn(electronPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
    shell: process.platform === "win32" && electronPath.endsWith(".cmd"),
  });

  const electronProcess: ElectronProcess = {
    id,
    process: electronProc,
    name: path.basename(resolvedAppPath),
    status: "running",
    pid: electronProc.pid,
    debugPort: port,
    startTime: new Date(),
    logs: [],
    appPath: resolvedAppPath,
  };

  const appendLog = (chunk: Buffer, stream: "stdout" | "stderr") => {
    const text = chunk.toString();
    electronProcess.logs.push(text);
    // Cap in-memory logs to avoid unbounded growth
    if (electronProcess.logs.length > 2000) {
      electronProcess.logs.splice(0, electronProcess.logs.length - 2000);
    }
    log.info(`[${id}:${stream}] ${text.trimEnd()}`);
  };

  electronProc.stdout?.on("data", (data: Buffer) => appendLog(data, "stdout"));
  electronProc.stderr?.on("data", (data: Buffer) => appendLog(data, "stderr"));

  electronProc.on("error", (err) => {
    electronProcess.status = "crashed";
    log.error(`[${id}] Failed to start:`, err);
  });

  electronProc.on("exit", (code) => {
    electronProcess.status = code === 0 ? "stopped" : "crashed";
    log.info(`[${id}] Process exited with code ${code}`);
    void closeCdpClient(electronProcess);
  });

  electronProcesses.set(id, electronProcess);

  try {
    await waitForDebugPort(port);
    await updateCDPTargets(electronProcess);
  } catch (err) {
    log.warn(`[${id}] App started but CDP is not ready yet:`, err);
  }

  return electronProcess;
}

async function closeCdpClient(electronProcess: ElectronProcess): Promise<void> {
  if (!electronProcess.cdpClient) {
    return;
  }
  try {
    await electronProcess.cdpClient.close();
  } catch (err) {
    log.error(`[${electronProcess.id}] Error closing CDP client:`, err);
  }
  electronProcess.cdpClient = undefined;
  electronProcess.cdpTargetId = undefined;
}

export async function stopElectronApp(id: string): Promise<boolean> {
  const electronProcess = electronProcesses.get(id);
  if (!electronProcess) {
    return false;
  }

  await closeCdpClient(electronProcess);

  if (electronProcess.status === "running") {
    electronProcess.process.kill();
    // Give it a moment, then force-kill if needed
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (
      electronProcess.status === "running" &&
      electronProcess.pid &&
      !electronProcess.process.killed
    ) {
      try {
        electronProcess.process.kill("SIGKILL");
      } catch {
        // Process may already be gone
      }
    }
  }

  electronProcess.status = "stopped";
  return true;
}

export async function updateCDPTargets(
  electronProcess: ElectronProcess
): Promise<CDPTarget[]> {
  if (!electronProcess.debugPort) {
    throw new Error("No debug port available for this Electron process");
  }

  const response = await fetch(
    `http://127.0.0.1:${electronProcess.debugPort}/json/list`
  );
  if (!response.ok) {
    throw new Error(`Failed to get targets: ${response.statusText}`);
  }

  const targets = (await response.json()) as CDPTarget[];
  electronProcess.targets = targets;
  electronProcess.lastTargetUpdate = new Date();
  return targets;
}

export async function connectToCDPTarget(
  electronProcess: ElectronProcess,
  targetId: string
): Promise<CDP.Client> {
  if (!electronProcess.debugPort) {
    throw new Error("No debug port available for this Electron process");
  }

  const stale =
    !electronProcess.targets ||
    !electronProcess.lastTargetUpdate ||
    Date.now() - electronProcess.lastTargetUpdate.getTime() > 5000;

  if (stale) {
    await updateCDPTargets(electronProcess);
  }

  const target = electronProcess.targets?.find((t) => t.id === targetId);
  if (!target) {
    throw new Error(`Target ${targetId} not found`);
  }

  if (
    electronProcess.cdpClient &&
    electronProcess.cdpTargetId === targetId
  ) {
    return electronProcess.cdpClient;
  }

  await closeCdpClient(electronProcess);

  const client = await CDP({
    target: targetId,
    port: electronProcess.debugPort,
    host: "127.0.0.1",
  });

  electronProcess.cdpClient = client;
  electronProcess.cdpTargetId = targetId;
  return client;
}

export async function executeCDPCommand(
  electronProcess: ElectronProcess,
  targetId: string,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  const client = await connectToCDPTarget(electronProcess, targetId);
  return client.send(method, params);
}

export async function getElectronDebugInfo(
  id: string
): Promise<ElectronDebugInfo | null> {
  const electronProcess = electronProcesses.get(id);
  if (!electronProcess) {
    return null;
  }

  if (electronProcess.status === "running" && electronProcess.debugPort) {
    try {
      await updateCDPTargets(electronProcess);
    } catch (err) {
      log.warn(`[${id}] Could not update CDP targets:`, err);
    }
  }

  const webContents =
    electronProcess.targets?.map((target, index) => ({
      id: index + 1,
      url: target.url,
      title: target.title,
      type: target.type,
      debuggable: Boolean(target.webSocketDebuggerUrl),
      debugPort: electronProcess.debugPort,
      targetId: target.id,
    })) ?? [];

  return {
    id: electronProcess.id,
    name: electronProcess.name,
    status: electronProcess.status,
    pid: electronProcess.pid,
    debugPort: electronProcess.debugPort,
    startTime: electronProcess.startTime,
    appPath: electronProcess.appPath,
    webContents,
  };
}

export function pickPageTarget(
  electronProcess: ElectronProcess,
  targetId?: string
): CDPTarget {
  if (!electronProcess.targets?.length) {
    throw new Error(
      `No CDP targets available for process ${electronProcess.id}`
    );
  }

  if (targetId) {
    const match = electronProcess.targets.find((t) => t.id === targetId);
    if (!match) {
      throw new Error(`Target ${targetId} not found`);
    }
    return match;
  }

  const page =
    electronProcess.targets.find((t) => t.type === "page") ??
    electronProcess.targets.find((t) => Boolean(t.webSocketDebuggerUrl)) ??
    electronProcess.targets[0];

  return page;
}
