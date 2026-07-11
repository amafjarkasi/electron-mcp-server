import { spawn, ChildProcess, execFile } from "child_process";
import { createRequire } from "module";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { promisify } from "util";
import CDP from "chrome-remote-interface";
import { log } from "./log.js";
import { processEvents } from "./events.js";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const MAX_LOG_CHUNKS = 2000;
const MAX_CONSOLE = 500;
const MAX_NETWORK = 500;

export interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
}

export interface ConsoleMessage {
  timestamp: string;
  targetId: string;
  level: string;
  text: string;
  source: "console" | "log" | "exception";
}

export interface NetworkEntry {
  timestamp: string;
  targetId: string;
  requestId: string;
  method?: string;
  url?: string;
  status?: number;
  mimeType?: string;
  type?: string;
  event: "request" | "response" | "failed" | "finished";
  errorText?: string;
}

export interface ElectronProcess {
  id: string;
  process?: ChildProcess;
  attached: boolean;
  name: string;
  status: "running" | "stopped" | "crashed";
  pid?: number;
  debugPort?: number;
  startTime: Date;
  logs: string[];
  appPath: string;
  consoleMessages: ConsoleMessage[];
  networkEntries: NetworkEntry[];
  cdpClient?: CDP.Client;
  cdpTargetId?: string;
  monitorClients: Map<string, CDP.Client>;
  targets?: CDPTarget[];
  lastTargetUpdate?: Date;
}

export interface ElectronDebugInfo {
  id: string;
  name: string;
  status: ElectronProcess["status"];
  attached: boolean;
  pid?: number;
  debugPort?: number;
  startTime: Date;
  appPath: string;
  targetSummary: {
    pages: number;
    workers: number;
    browser: number;
    other: number;
  };
  webContents: Array<{
    id: number;
    url: string;
    title: string;
    type: string;
    role: "page" | "worker" | "browser" | "other";
    debuggable: boolean;
    debugPort?: number;
    targetId?: string;
  }>;
  recentConsoleErrors: ConsoleMessage[];
}

const electronProcesses = new Map<string, ElectronProcess>();

export function classifyTargetRole(
  type: string
): "page" | "worker" | "browser" | "other" {
  if (type === "page") return "page";
  if (type === "worker" || type === "service_worker") return "worker";
  if (type === "browser") return "browser";
  return "other";
}

export function getAllowedRoots(): string[] {
  const raw = process.env.ELECTRON_MCP_ALLOWED_ROOTS?.trim();
  if (!raw) return [];
  return raw
    .split(/[;|]/)
    .map((p) => path.resolve(p.trim()))
    .filter(Boolean);
}

export function assertAppPathAllowed(appPath: string): string {
  const resolved = path.resolve(appPath);
  const roots = getAllowedRoots();
  if (!roots.length) {
    return resolved;
  }
  const ok = roots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep)
  );
  if (!ok) {
    throw new Error(
      `App path ${resolved} is outside ELECTRON_MCP_ALLOWED_ROOTS (${roots.join(", ")})`
    );
  }
  return resolved;
}

function getElectronExecutablePath(): string {
  if (process.env.ELECTRON_PATH && fs.existsSync(process.env.ELECTRON_PATH)) {
    return process.env.ELECTRON_PATH;
  }

  const installHint =
    "Electron binary is not installed. From the repo root run: npm run ensure-electron   (or: .\\scripts\\fix-electron.cmd)";

  // Prefer path.txt — require('electron') throws on incomplete installs.
  try {
    const electronPkgDir = path.dirname(require.resolve("electron/package.json"));
    const pathTxt = path.join(electronPkgDir, "path.txt");
    if (fs.existsSync(pathTxt)) {
      const rel = fs.readFileSync(pathTxt, "utf8").trim();
      const candidate = path.join(electronPkgDir, "dist", rel);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    const winExe = path.join(electronPkgDir, "dist", "electron.exe");
    if (fs.existsSync(winExe)) {
      return winExe;
    }
    const nixBin = path.join(electronPkgDir, "dist", "electron");
    if (fs.existsSync(nixBin)) {
      return nixBin;
    }
  } catch {
    // fall through
  }

  try {
    const fromPackage = require("electron") as string;
    if (fromPackage && fs.existsSync(fromPackage)) {
      return fromPackage;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message}\n${installHint}`);
  }

  throw new Error(installHint);
}

export async function waitForDebugPort(
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

export async function probeDebugPort(port: number): Promise<{
  port: number;
  ok: boolean;
  version?: unknown;
  targets?: CDPTarget[];
  error?: string;
}> {
  try {
    const versionRes = await fetch(`http://127.0.0.1:${port}/json/version`);
    if (!versionRes.ok) {
      return { port, ok: false, error: `HTTP ${versionRes.status}` };
    }
    const version = await versionRes.json();
    const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = listRes.ok
      ? ((await listRes.json()) as CDPTarget[])
      : [];
    return { port, ok: true, version, targets };
  } catch (err) {
    return {
      port,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function discoverDebugPorts(
  startPort = 9222,
  endPort = 9235
): Promise<Array<{ port: number; version?: unknown; targetCount: number }>> {
  const found = [];
  for (let port = startPort; port <= endPort; port++) {
    const probe = await probeDebugPort(port);
    if (probe.ok) {
      found.push({
        port,
        version: probe.version,
        targetCount: probe.targets?.length ?? 0,
      });
    }
  }
  return found;
}

function pushCapped<T>(arr: T[], item: T, max: number): void {
  arr.push(item);
  if (arr.length > max) {
    arr.splice(0, arr.length - max);
  }
}

function createProcessRecord(
  partial: Omit<ElectronProcess, "consoleMessages" | "networkEntries" | "monitorClients" | "logs"> & {
    logs?: string[];
  }
): ElectronProcess {
  return {
    ...partial,
    logs: partial.logs ?? [],
    consoleMessages: [],
    networkEntries: [],
    monitorClients: new Map(),
  };
}

export function listProcesses(): Array<{
  id: string;
  name: string;
  status: ElectronProcess["status"];
  attached: boolean;
  pid?: number;
  debugPort?: number;
  startTime: Date;
  appPath: string;
  targetCount: number;
  consoleCount: number;
  networkCount: number;
}> {
  return Array.from(electronProcesses.entries()).map(([id, proc]) => ({
    id,
    name: proc.name,
    status: proc.status,
    attached: proc.attached,
    pid: proc.pid,
    debugPort: proc.debugPort,
    startTime: proc.startTime,
    appPath: proc.appPath,
    targetCount: proc.targets?.length ?? 0,
    consoleCount: proc.consoleMessages.length,
    networkCount: proc.networkEntries.length,
  }));
}

export function getProcess(id: string): ElectronProcess | undefined {
  return electronProcesses.get(id);
}

export function getAllProcesses(): Map<string, ElectronProcess> {
  return electronProcesses;
}

function wireChildProcess(
  electronProcess: ElectronProcess,
  child: ChildProcess
): void {
  const appendLog = (chunk: Buffer, stream: "stdout" | "stderr") => {
    const text = chunk.toString();
    pushCapped(electronProcess.logs, text, MAX_LOG_CHUNKS);
    log.info(`[${electronProcess.id}:${stream}] ${text.trimEnd()}`);
  };

  child.stdout?.on("data", (data: Buffer) => appendLog(data, "stdout"));
  child.stderr?.on("data", (data: Buffer) => appendLog(data, "stderr"));

  child.on("error", (err) => {
    electronProcess.status = "crashed";
    log.error(`[${electronProcess.id}] Failed to start:`, err);
    processEvents.emitEvent({
      type: "process_crashed",
      processId: electronProcess.id,
      detail: err.message,
    });
  });

  child.on("exit", (code) => {
    electronProcess.status = code === 0 ? "stopped" : "crashed";
    log.info(`[${electronProcess.id}] Process exited with code ${code}`);
    void closeAllClients(electronProcess);
    processEvents.emitEvent({
      type: code === 0 ? "process_stopped" : "process_crashed",
      processId: electronProcess.id,
      detail: `exit code ${code}`,
    });
  });
}

export async function startElectronApp(
  appPath: string,
  debugPort?: number,
  extraArgs: string[] = [],
  options: { inspectMain?: boolean } = {}
): Promise<ElectronProcess> {
  const resolvedAppPath = assertAppPathAllowed(appPath);
  if (!fs.existsSync(resolvedAppPath)) {
    throw new Error(`App path does not exist: ${resolvedAppPath}`);
  }

  const id = `electron-${Date.now()}`;
  const port =
    debugPort ?? Math.floor(Math.random() * (9999 - 9222 + 1)) + 9222;

  const autoArgs: string[] = [];
  if (
    process.env.ELECTRON_MCP_NO_SANDBOX === "1" ||
    process.env.CI === "true" ||
    !process.env.DISPLAY
  ) {
    autoArgs.push("--no-sandbox");
  }
  if (options.inspectMain) {
    // Expose the Electron main process to the inspector (shows up as a node target).
    autoArgs.push("--inspect=0");
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
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: "1",
      // Prevent Windows console QuickEdit freezes when launched from a terminal.
      ELECTRON_NO_ATTACH_CONSOLE: "1",
    },
    windowsHide: true,
  });

  const electronProcess = createProcessRecord({
    id,
    process: electronProc,
    attached: false,
    name: path.basename(resolvedAppPath),
    status: "running",
    pid: electronProc.pid,
    debugPort: port,
    startTime: new Date(),
    appPath: resolvedAppPath,
  });

  wireChildProcess(electronProcess, electronProc);
  electronProcesses.set(id, electronProcess);

  // Fail fast if Electron exits before the debug port opens (common when
  // the binary failed to download under npm allowScripts).
  let onEarlyExit: ((code: number | null) => void) | undefined;
  const earlyExit = new Promise<never>((_, reject) => {
    onEarlyExit = (code: number | null) => {
      const tail = electronProcess.logs.slice(-20).join("");
      reject(
        new Error(
          `Electron exited early with code ${code} before debug port ${port} was ready.${
            tail ? `\n--- output ---\n${tail}` : ""
          }`
        )
      );
    };
    electronProc.once("exit", onEarlyExit);
  });

  try {
    await Promise.race([waitForDebugPort(port), earlyExit]);
    if (onEarlyExit) {
      electronProc.off("exit", onEarlyExit);
    }
    await updateCDPTargets(electronProcess);
    await ensureMonitoring(electronProcess);
  } catch (err) {
    if (onEarlyExit) {
      electronProc.off("exit", onEarlyExit);
    }
    if (electronProc.exitCode != null || electronProcess.status !== "running") {
      electronProcesses.delete(id);
      throw err;
    }
    log.warn(`[${id}] App started but CDP is not ready yet:`, err);
  }

  processEvents.emitEvent({ type: "process_started", processId: id });
  return electronProcess;
}

export async function attachToDebugPort(
  debugPort: number,
  name?: string
): Promise<ElectronProcess> {
  const existing = Array.from(electronProcesses.values()).find(
    (p) => p.debugPort === debugPort && p.status === "running"
  );
  if (existing) {
    return existing;
  }

  await waitForDebugPort(debugPort, 5000);
  const probe = await probeDebugPort(debugPort);
  if (!probe.ok) {
    throw new Error(
      `Nothing listening on debug port ${debugPort}: ${probe.error}`
    );
  }

  const id = `attached-${debugPort}-${Date.now()}`;
  const electronProcess = createProcessRecord({
    id,
    attached: true,
    name: name ?? `attached:${debugPort}`,
    status: "running",
    debugPort,
    startTime: new Date(),
    appPath: `attach://127.0.0.1:${debugPort}`,
  });

  electronProcess.targets = probe.targets ?? [];
  electronProcess.lastTargetUpdate = new Date();
  electronProcesses.set(id, electronProcess);

  await ensureMonitoring(electronProcess);
  processEvents.emitEvent({ type: "process_attached", processId: id });
  return electronProcess;
}

async function closeClient(client?: CDP.Client): Promise<void> {
  if (!client) return;
  try {
    await client.close();
  } catch (err) {
    log.error("Error closing CDP client:", err);
  }
}

async function closeAllClients(electronProcess: ElectronProcess): Promise<void> {
  await closeClient(electronProcess.cdpClient);
  electronProcess.cdpClient = undefined;
  electronProcess.cdpTargetId = undefined;

  for (const [, client] of electronProcess.monitorClients) {
    await closeClient(client);
  }
  electronProcess.monitorClients.clear();
}

async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"]);
      return;
    } catch (err) {
      log.warn(`taskkill failed for pid ${pid}:`, err);
    }
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
  await new Promise((r) => setTimeout(r, 400));
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

export async function stopElectronApp(id: string): Promise<boolean> {
  const electronProcess = electronProcesses.get(id);
  if (!electronProcess) {
    return false;
  }

  await closeAllClients(electronProcess);

  if (electronProcess.attached) {
    // Attached sessions are not owned — just detach bookkeeping.
    electronProcess.status = "stopped";
    processEvents.emitEvent({
      type: "process_stopped",
      processId: id,
      detail: "detached",
    });
    return true;
  }

  if (electronProcess.status === "running" && electronProcess.pid) {
    if (electronProcess.process && !electronProcess.process.killed) {
      try {
        electronProcess.process.kill("SIGTERM");
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (electronProcess.status === "running") {
      await killProcessTree(electronProcess.pid);
    }
  }

  electronProcess.status = "stopped";
  processEvents.emitEvent({ type: "process_stopped", processId: id });
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
  const prev = electronProcess.targets?.map((t) => t.id).join(",") ?? "";
  electronProcess.targets = targets;
  electronProcess.lastTargetUpdate = new Date();
  const next = targets.map((t) => t.id).join(",");
  if (prev !== next) {
    processEvents.emitEvent({
      type: "targets_changed",
      processId: electronProcess.id,
      targetCount: targets.length,
    });
  }
  return targets;
}

function wireMonitorEvents(
  electronProcess: ElectronProcess,
  targetId: string,
  client: CDP.Client
): void {
  client.on("Runtime.consoleAPICalled", (params) => {
    const p = params as {
      type?: string;
      args?: Array<{ value?: unknown; description?: string; type?: string }>;
    };
    const text = (p.args ?? [])
      .map((a) => {
        if (a.value !== undefined) return String(a.value);
        if (a.description) return a.description;
        return a.type ?? "";
      })
      .join(" ");
    const level = p.type ?? "log";
    pushCapped(
      electronProcess.consoleMessages,
      {
        timestamp: new Date().toISOString(),
        targetId,
        level,
        text,
        source: "console",
      },
      MAX_CONSOLE
    );
    processEvents.emitEvent({
      type: "console",
      processId: electronProcess.id,
      targetId,
      level,
      text,
    });
  });

  client.on("Runtime.exceptionThrown", (params) => {
    const p = params as {
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    const text =
      p.exceptionDetails?.exception?.description ||
      p.exceptionDetails?.text ||
      "exception";
    pushCapped(
      electronProcess.consoleMessages,
      {
        timestamp: new Date().toISOString(),
        targetId,
        level: "error",
        text,
        source: "exception",
      },
      MAX_CONSOLE
    );
    processEvents.emitEvent({
      type: "console",
      processId: electronProcess.id,
      targetId,
      level: "error",
      text,
    });
  });

  client.on("Log.entryAdded", (params) => {
    const p = params as {
      entry?: { level?: string; text?: string };
    };
    const level = p.entry?.level ?? "log";
    const text = p.entry?.text ?? "";
    pushCapped(
      electronProcess.consoleMessages,
      {
        timestamp: new Date().toISOString(),
        targetId,
        level,
        text,
        source: "log",
      },
      MAX_CONSOLE
    );
    processEvents.emitEvent({
      type: "console",
      processId: electronProcess.id,
      targetId,
      level,
      text,
    });
  });

  client.on("Network.requestWillBeSent", (params) => {
    const p = params as {
      requestId: string;
      request?: { url?: string; method?: string };
      type?: string;
    };
    pushCapped(
      electronProcess.networkEntries,
      {
        timestamp: new Date().toISOString(),
        targetId,
        requestId: p.requestId,
        method: p.request?.method,
        url: p.request?.url,
        type: p.type,
        event: "request",
      },
      MAX_NETWORK
    );
  });

  client.on("Network.responseReceived", (params) => {
    const p = params as {
      requestId: string;
      response?: { url?: string; status?: number; mimeType?: string };
      type?: string;
    };
    pushCapped(
      electronProcess.networkEntries,
      {
        timestamp: new Date().toISOString(),
        targetId,
        requestId: p.requestId,
        url: p.response?.url,
        status: p.response?.status,
        mimeType: p.response?.mimeType,
        type: p.type,
        event: "response",
      },
      MAX_NETWORK
    );
  });

  client.on("Network.loadingFailed", (params) => {
    const p = params as {
      requestId: string;
      errorText?: string;
      type?: string;
    };
    pushCapped(
      electronProcess.networkEntries,
      {
        timestamp: new Date().toISOString(),
        targetId,
        requestId: p.requestId,
        type: p.type,
        event: "failed",
        errorText: p.errorText,
      },
      MAX_NETWORK
    );
  });
}

export async function ensureMonitoring(
  electronProcess: ElectronProcess,
  targetId?: string
): Promise<void> {
  if (electronProcess.status !== "running" || !electronProcess.debugPort) {
    return;
  }

  await updateCDPTargets(electronProcess);
  const targets = targetId
    ? (electronProcess.targets ?? []).filter((t) => t.id === targetId)
    : (electronProcess.targets ?? []).filter(
        (t) =>
          (t.type === "page" || Boolean(t.webSocketDebuggerUrl)) &&
          t.type !== "browser"
      );

  for (const target of targets) {
    if (electronProcess.monitorClients.has(target.id)) {
      continue;
    }
    if (!target.webSocketDebuggerUrl) {
      continue;
    }

    try {
      const client = await CDP({
        target: target.id,
        port: electronProcess.debugPort,
        host: "127.0.0.1",
      });
      wireMonitorEvents(electronProcess, target.id, client);
      await client.send("Runtime.enable");
      try {
        await client.send("Log.enable");
      } catch {
        // optional
      }
      try {
        await client.send("Network.enable");
      } catch {
        // optional
      }
      try {
        await client.send("Page.enable");
      } catch {
        // optional
      }
      electronProcess.monitorClients.set(target.id, client);
      // Prefer monitor client for subsequent commands on this target
      if (!electronProcess.cdpClient) {
        electronProcess.cdpClient = client;
        electronProcess.cdpTargetId = target.id;
      }
    } catch (err) {
      log.warn(
        `[${electronProcess.id}] Could not monitor target ${target.id}:`,
        err
      );
    }
  }
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

  const monitored = electronProcess.monitorClients.get(targetId);
  if (monitored) {
    electronProcess.cdpClient = monitored;
    electronProcess.cdpTargetId = targetId;
    return monitored;
  }

  if (
    electronProcess.cdpClient &&
    electronProcess.cdpTargetId === targetId
  ) {
    return electronProcess.cdpClient;
  }

  if (
    electronProcess.cdpClient &&
    electronProcess.cdpTargetId &&
    !electronProcess.monitorClients.has(electronProcess.cdpTargetId)
  ) {
    await closeClient(electronProcess.cdpClient);
  }

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
  try {
    return await client.send(method, params);
  } catch (err) {
    // One reconnect attempt for dropped sockets
    log.warn(
      `[${electronProcess.id}] CDP ${method} failed, reconnecting:`,
      err
    );
    electronProcess.monitorClients.delete(targetId);
    if (electronProcess.cdpTargetId === targetId) {
      electronProcess.cdpClient = undefined;
      electronProcess.cdpTargetId = undefined;
    }
    const retry = await connectToCDPTarget(electronProcess, targetId);
    return retry.send(method, params);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function captureScreenshot(
  electronProcess: ElectronProcess,
  targetId?: string,
  format: "png" | "jpeg" = "png",
  quality?: number,
  selector?: string
): Promise<{
  targetId: string;
  mimeType: string;
  data: string;
  clip?: { x: number; y: number; width: number; height: number; selector: string };
}> {
  await updateCDPTargets(electronProcess);
  const target = pickPageTarget(electronProcess, targetId);
  if (!target?.id) {
    throw new Error("No page target available for screenshot");
  }

  // Always close any existing debugger session on this target before
  // reconnecting — Chromium allows only one CDP websocket per target.
  const existingMonitor = electronProcess.monitorClients.get(target.id);
  electronProcess.monitorClients.delete(target.id);
  if (existingMonitor) {
    await closeClient(existingMonitor);
  }
  if (electronProcess.cdpTargetId === target.id) {
    if (
      electronProcess.cdpClient &&
      electronProcess.cdpClient !== existingMonitor
    ) {
      await closeClient(electronProcess.cdpClient);
    }
    electronProcess.cdpClient = undefined;
    electronProcess.cdpTargetId = undefined;
  }

  await ensureMonitoring(electronProcess, target.id);

  let clip:
    | { x: number; y: number; width: number; height: number; scale: number }
    | undefined;
  let clipMeta:
    | { x: number; y: number; width: number; height: number; selector: string }
    | undefined;

  if (selector) {
    const box = (await evalValue(
      electronProcess,
      target.id,
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          scale: window.devicePixelRatio || 1
        };
      })()`
    )) as {
      x: number;
      y: number;
      width: number;
      height: number;
      scale: number;
    } | null;

    if (!box) {
      throw new Error(
        `No visible element matched selector for screenshot clip: ${selector}`
      );
    }
    clip = {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      scale: 1,
    };
    clipMeta = {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      selector,
    };
  }

  const paramsBase = {
    format,
    ...(format === "jpeg" && quality ? { quality } : {}),
    ...(clip ? { clip } : {}),
  };

  let result: { data: string };
  const tryCapture = async (fromSurface: boolean) =>
    (await withTimeout(
      executeCDPCommand(electronProcess, target.id, "Page.captureScreenshot", {
        ...paramsBase,
        fromSurface,
      }),
      clip ? 10000 : 8000,
      `Page.captureScreenshot(fromSurface=${fromSurface})`
    )) as { data: string };

  const resetPageSocket = async () => {
    const mon = electronProcess.monitorClients.get(target.id);
    electronProcess.monitorClients.delete(target.id);
    if (mon) await closeClient(mon);
    if (electronProcess.cdpTargetId === target.id) {
      if (
        electronProcess.cdpClient &&
        electronProcess.cdpClient !== mon
      ) {
        await closeClient(electronProcess.cdpClient);
      }
      electronProcess.cdpClient = undefined;
      electronProcess.cdpTargetId = undefined;
    }
    await ensureMonitoring(electronProcess, target.id);
  };

  try {
    // Element clips + fromSurface often hang under headless/no-GPU; prefer
    // fromSurface:false when clipping, otherwise try true then false.
    if (clip) {
      result = await tryCapture(false);
    } else {
      try {
        result = await tryCapture(true);
      } catch (err) {
        log.warn(
          `[${electronProcess.id}] screenshot fromSurface failed, retrying without:`,
          err
        );
        await resetPageSocket();
        result = await tryCapture(false);
      }
    }
  } catch (err) {
    log.warn(`[${electronProcess.id}] screenshot failed, one more reconnect:`, err);
    await resetPageSocket();
    result = await tryCapture(false);
  }

  return {
    targetId: target.id,
    mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
    data: result.data,
    ...(clipMeta ? { clip: clipMeta } : {}),
  };
}

export async function saveScreenshot(
  electronProcess: ElectronProcess,
  filePath: string,
  targetId?: string,
  format: "png" | "jpeg" = "png",
  quality?: number,
  selector?: string
): Promise<{
  targetId: string;
  path: string;
  bytes: number;
  mimeType: string;
  clip?: { x: number; y: number; width: number; height: number; selector: string };
}> {
  const shot = await captureScreenshot(
    electronProcess,
    targetId,
    format,
    quality,
    selector
  );
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const buffer = Buffer.from(shot.data, "base64");
  fs.writeFileSync(resolved, buffer);
  return {
    targetId: shot.targetId,
    path: resolved,
    bytes: buffer.length,
    mimeType: shot.mimeType,
    ...(shot.clip ? { clip: shot.clip } : {}),
  };
}

export async function getOuterHtml(
  electronProcess: ElectronProcess,
  selector?: string,
  targetId?: string
): Promise<{ targetId: string; html: string }> {
  await updateCDPTargets(electronProcess);
  const target = pickPageTarget(electronProcess, targetId);
  const expression = selector
    ? `(() => { const el = document.querySelector(${JSON.stringify(
        selector
      )}); return el ? el.outerHTML : null; })()`
    : "document.documentElement.outerHTML";

  const result = (await executeCDPCommand(
    electronProcess,
    target.id,
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }
  )) as { result?: { value?: string | null } };

  const html = result.result?.value;
  if (html == null) {
    throw new Error(
      selector
        ? `No element matched selector: ${selector}`
        : "Could not read document HTML"
    );
  }

  return { targetId: target.id, html };
}

export async function diagnoseProcess(id?: string): Promise<unknown> {
  const procs = id
    ? [getProcess(id)].filter(Boolean)
    : Array.from(electronProcesses.values());

  if (id && !procs.length) {
    throw new Error(`Process not found: ${id}`);
  }

  const reports = [];
  for (const proc of procs as ElectronProcess[]) {
    let portOk = false;
    let portError: string | undefined;
    if (proc.debugPort) {
      const probe = await probeDebugPort(proc.debugPort);
      portOk = probe.ok;
      portError = probe.error;
      if (probe.ok && probe.targets) {
        proc.targets = probe.targets;
        proc.lastTargetUpdate = new Date();
      }
    }

    const byRole = { page: 0, worker: 0, browser: 0, other: 0 };
    for (const t of proc.targets ?? []) {
      byRole[classifyTargetRole(t.type)] += 1;
    }

    const recentErrors = proc.consoleMessages
      .filter((m) => m.level === "error" || m.level === "assert")
      .slice(-5);

    reports.push({
      id: proc.id,
      name: proc.name,
      status: proc.status,
      attached: proc.attached,
      pid: proc.pid,
      debugPort: proc.debugPort,
      debugPortReachable: portOk,
      debugPortError: portError,
      appPath: proc.appPath,
      targetSummary: byRole,
      targets: (proc.targets ?? []).map((t) => ({
        id: t.id,
        type: t.type,
        role: classifyTargetRole(t.type),
        title: t.title,
        url: t.url,
        debuggable: Boolean(t.webSocketDebuggerUrl),
      })),
      logChunks: proc.logs.length,
      consoleMessages: proc.consoleMessages.length,
      networkEntries: proc.networkEntries.length,
      recentConsoleErrors: recentErrors,
      monitoringTargets: Array.from(proc.monitorClients.keys()),
      hints: [
        !portOk && proc.status === "running"
          ? "Debug port is not reachable — app may have exited or remote debugging is off"
          : null,
        byRole.page === 0 && portOk
          ? "No page targets yet — window may still be loading"
          : null,
        recentErrors.length
          ? "Recent console/exceptions present — inspect with get_console_messages"
          : null,
      ].filter(Boolean),
    });
  }

  return { processes: reports, discovered: await discoverDebugPorts() };
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

  const targetSummary = { pages: 0, workers: 0, browser: 0, other: 0 };
  const webContents =
    electronProcess.targets?.map((target, index) => {
      const role = classifyTargetRole(target.type);
      targetSummary[
        role === "page"
          ? "pages"
          : role === "worker"
            ? "workers"
            : role === "browser"
              ? "browser"
              : "other"
      ] += 1;
      return {
        id: index + 1,
        url: target.url,
        title: target.title,
        type: target.type,
        role,
        debuggable: Boolean(target.webSocketDebuggerUrl),
        debugPort: electronProcess.debugPort,
        targetId: target.id,
      };
    }) ?? [];

  return {
    id: electronProcess.id,
    name: electronProcess.name,
    status: electronProcess.status,
    attached: electronProcess.attached,
    pid: electronProcess.pid,
    debugPort: electronProcess.debugPort,
    startTime: electronProcess.startTime,
    appPath: electronProcess.appPath,
    targetSummary,
    webContents,
    recentConsoleErrors: electronProcess.consoleMessages
      .filter((m) => m.level === "error" || m.source === "exception")
      .slice(-10),
  };
}

export function pickPageTarget(
  electronProcess: ElectronProcess,
  targetId?: string,
  preferredRole: "page" | "worker" | "browser" | "any" = "page"
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

  if (preferredRole !== "any") {
    const roleMatch = electronProcess.targets.find(
      (t) => classifyTargetRole(t.type) === preferredRole
    );
    if (roleMatch) return roleMatch;
  }

  return (
    electronProcess.targets.find((t) => t.type === "page") ??
    electronProcess.targets.find((t) => Boolean(t.webSocketDebuggerUrl)) ??
    electronProcess.targets[0]
  );
}

export function pickTargetByRole(
  electronProcess: ElectronProcess,
  role: "page" | "worker" | "browser" | "other",
  targetId?: string
): CDPTarget {
  if (targetId) {
    return pickPageTarget(electronProcess, targetId, "any");
  }
  const match = (electronProcess.targets ?? []).find(
    (t) => classifyTargetRole(t.type) === role
  );
  if (!match) {
    throw new Error(`No ${role} target found for process ${electronProcess.id}`);
  }
  return match;
}

export function clearProcessBuffers(
  electronProcess: ElectronProcess,
  what: Array<"console" | "network" | "logs"> = ["console", "network", "logs"]
): { cleared: string[] } {
  const cleared: string[] = [];
  if (what.includes("console")) {
    electronProcess.consoleMessages = [];
    cleared.push("console");
  }
  if (what.includes("network")) {
    electronProcess.networkEntries = [];
    cleared.push("network");
  }
  if (what.includes("logs")) {
    electronProcess.logs = [];
    cleared.push("logs");
  }
  return { cleared };
}

async function evalValue(
  electronProcess: ElectronProcess,
  targetId: string,
  expression: string
): Promise<unknown> {
  const result = (await executeCDPCommand(
    electronProcess,
    targetId,
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }
  )) as { result?: { value?: unknown; subtype?: string; description?: string } };
  if (result.result?.subtype === "error") {
    throw new Error(result.result.description || "evaluate error");
  }
  return result.result?.value;
}

export async function getPageInfo(
  electronProcess: ElectronProcess,
  targetId?: string
): Promise<{
  targetId: string;
  url: string;
  title: string;
  readyState: string;
  userAgent: string;
}> {
  await updateCDPTargets(electronProcess);
  const target = pickPageTarget(electronProcess, targetId);
  const info = (await evalValue(
    electronProcess,
    target.id,
    `({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      userAgent: navigator.userAgent
    })`
  )) as {
    url: string;
    title: string;
    readyState: string;
    userAgent: string;
  };
  return { targetId: target.id, ...info };
}

export async function navigatePage(
  electronProcess: ElectronProcess,
  url: string,
  targetId?: string,
  waitUntilLoad = true,
  timeoutMs = 15000
): Promise<{ targetId: string; url: string; title: string }> {
  await updateCDPTargets(electronProcess);
  const target = pickPageTarget(electronProcess, targetId);
  await executeCDPCommand(electronProcess, target.id, "Page.enable", {});
  await executeCDPCommand(electronProcess, target.id, "Page.navigate", { url });

  if (waitUntilLoad) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const ready = await evalValue(
        electronProcess,
        target.id,
        "document.readyState"
      );
      if (ready === "complete" || ready === "interactive") {
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  const info = await getPageInfo(electronProcess, target.id);
  return { targetId: target.id, url: info.url, title: info.title };
}

async function elementCenter(
  electronProcess: ElectronProcess,
  targetId: string,
  selector: string
): Promise<{ x: number; y: number }> {
  const box = (await evalValue(
    electronProcess,
    targetId,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`
  )) as { x: number; y: number } | null;

  if (!box) {
    throw new Error(`No visible element for selector: ${selector}`);
  }
  return box;
}

export async function clickSelector(
  electronProcess: ElectronProcess,
  selector: string,
  targetId?: string,
  button: "left" | "right" | "middle" = "left"
): Promise<{ targetId: string; selector: string; x: number; y: number }> {
  await updateCDPTargets(electronProcess);
  const target = pickPageTarget(electronProcess, targetId);
  const { x, y } = await elementCenter(electronProcess, target.id, selector);
  const btn = button === "right" ? "right" : button === "middle" ? "middle" : "left";

  await executeCDPCommand(electronProcess, target.id, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: btn,
    clickCount: 1,
  });
  await executeCDPCommand(electronProcess, target.id, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: btn,
    clickCount: 1,
  });

  return { targetId: target.id, selector, x, y };
}

export async function typeText(
  electronProcess: ElectronProcess,
  text: string,
  options: {
    selector?: string;
    targetId?: string;
    clear?: boolean;
    pressEnter?: boolean;
  } = {}
): Promise<{ targetId: string; typed: string }> {
  await updateCDPTargets(electronProcess);
  const target = pickPageTarget(electronProcess, options.targetId);

  if (options.selector) {
    await clickSelector(electronProcess, options.selector, target.id);
    if (options.clear) {
      await evalValue(
        electronProcess,
        target.id,
        `(() => {
          const el = document.querySelector(${JSON.stringify(options.selector)});
          if (!el) return false;
          if ('value' in el) el.value = '';
          el.textContent = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()`
      );
    }
  }

  await executeCDPCommand(electronProcess, target.id, "Input.insertText", {
    text,
  });

  if (options.pressEnter) {
    await executeCDPCommand(electronProcess, target.id, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    await executeCDPCommand(electronProcess, target.id, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
  }

  return { targetId: target.id, typed: text };
}

export async function waitForCondition(
  electronProcess: ElectronProcess,
  options: {
    selector?: string;
    text?: string;
    urlIncludes?: string;
    consoleIncludes?: string;
    /** Wait until selector matches no elements (or is not visible). */
    hidden?: string;
    /** Wait until selector is present and not disabled. */
    enabled?: string;
    /** Wait until selector matches at least this many nodes. */
    count?: { selector: string; min: number };
    timeoutMs?: number;
    targetId?: string;
    screenshotOnTimeout?: boolean;
  }
): Promise<{
  targetId: string;
  matched: string;
  elapsedMs: number;
  timeoutScreenshotPath?: string;
}> {
  const timeoutMs = options.timeoutMs ?? 10000;
  await updateCDPTargets(electronProcess);
  const target = pickPageTarget(electronProcess, options.targetId);
  const started = Date.now();

  const hasCondition = Boolean(
    options.selector ||
      options.text ||
      options.urlIncludes ||
      options.consoleIncludes ||
      options.hidden ||
      options.enabled ||
      options.count
  );
  if (!hasCondition) {
    throw new Error(
      "Provide at least one wait condition (selector, text, urlIncludes, consoleIncludes, hidden, enabled, count)"
    );
  }

  while (Date.now() - started < timeoutMs) {
    if (options.selector) {
      const found = await evalValue(
        electronProcess,
        target.id,
        `!!document.querySelector(${JSON.stringify(options.selector)})`
      );
      if (found) {
        return {
          targetId: target.id,
          matched: `selector:${options.selector}`,
          elapsedMs: Date.now() - started,
        };
      }
    }

    if (options.hidden) {
      const gone = await evalValue(
        electronProcess,
        target.id,
        `(() => {
          const el = document.querySelector(${JSON.stringify(options.hidden)});
          if (!el) return true;
          const style = window.getComputedStyle(el);
          const hidden =
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.opacity === '0' ||
            el.getClientRects().length === 0;
          return hidden;
        })()`
      );
      if (gone) {
        return {
          targetId: target.id,
          matched: `hidden:${options.hidden}`,
          elapsedMs: Date.now() - started,
        };
      }
    }

    if (options.enabled) {
      const ok = await evalValue(
        electronProcess,
        target.id,
        `(() => {
          const el = document.querySelector(${JSON.stringify(options.enabled)});
          if (!el) return false;
          const disabled =
            el.hasAttribute('disabled') ||
            el.getAttribute('aria-disabled') === 'true' ||
            (el instanceof HTMLButtonElement && el.disabled) ||
            (el instanceof HTMLInputElement && el.disabled);
          return !disabled;
        })()`
      );
      if (ok) {
        return {
          targetId: target.id,
          matched: `enabled:${options.enabled}`,
          elapsedMs: Date.now() - started,
        };
      }
    }

    if (options.count) {
      const n = Number(
        (await evalValue(
          electronProcess,
          target.id,
          `document.querySelectorAll(${JSON.stringify(
            options.count.selector
          )}).length`
        )) ?? 0
      );
      if (n >= options.count.min) {
        return {
          targetId: target.id,
          matched: `count:${options.count.selector}>=${options.count.min} (got ${n})`,
          elapsedMs: Date.now() - started,
        };
      }
    }

    if (options.text) {
      const found = await evalValue(
        electronProcess,
        target.id,
        `document.body && document.body.innerText.includes(${JSON.stringify(
          options.text
        )})`
      );
      if (found) {
        return {
          targetId: target.id,
          matched: `text:${options.text}`,
          elapsedMs: Date.now() - started,
        };
      }
    }

    if (options.urlIncludes) {
      const url = String(
        (await evalValue(electronProcess, target.id, "location.href")) ?? ""
      );
      if (url.includes(options.urlIncludes)) {
        return {
          targetId: target.id,
          matched: `url:${options.urlIncludes}`,
          elapsedMs: Date.now() - started,
        };
      }
    }

    if (options.consoleIncludes) {
      const hit = electronProcess.consoleMessages.some((m) =>
        m.text.includes(options.consoleIncludes!)
      );
      if (hit) {
        return {
          targetId: target.id,
          matched: `console:${options.consoleIncludes}`,
          elapsedMs: Date.now() - started,
        };
      }
    }

    await new Promise((r) => setTimeout(r, 150));
  }

  let timeoutScreenshotPath: string | undefined;
  if (options.screenshotOnTimeout) {
    try {
      const file = path.join(
        os.tmpdir(),
        `electron-mcp-timeout-${electronProcess.id}-${Date.now()}.png`
      );
      const saved = await saveScreenshot(
        electronProcess,
        file,
        target.id,
        "png"
      );
      timeoutScreenshotPath = saved.path;
    } catch (err) {
      log.warn("screenshotOnTimeout failed:", err);
    }
  }

  throw new Error(
    `wait_for timed out after ${timeoutMs}ms (selector=${options.selector ?? "-"}, hidden=${options.hidden ?? "-"}, enabled=${options.enabled ?? "-"}, count=${options.count ? `${options.count.selector}>=${options.count.min}` : "-"}, text=${options.text ?? "-"}, urlIncludes=${options.urlIncludes ?? "-"}, consoleIncludes=${options.consoleIncludes ?? "-"}${
      timeoutScreenshotPath ? `, screenshot=${timeoutScreenshotPath}` : ""
    })`
  );
}

const KEY_MAP: Record<
  string,
  { key: string; code: string; text?: string; windowsVirtualKeyCode?: number }
> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: {
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
};

export async function pressKey(
  electronProcess: ElectronProcess,
  key: string,
  options: {
    targetId?: string;
    selector?: string;
    modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">;
    repeat?: number;
  } = {}
): Promise<{ targetId: string; key: string; modifiers: string[]; repeat: number }> {
  await updateCDPTargets(electronProcess);
  const target = pickPageTarget(electronProcess, options.targetId);
  if (options.selector) {
    await clickSelector(electronProcess, options.selector, target.id);
  }

  const modifiers = options.modifiers ?? [];
  const repeat = Math.max(1, options.repeat ?? 1);
  const mapped = KEY_MAP[key] ?? {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    text: key.length === 1 ? key : undefined,
  };

  let modifierBits = 0;
  if (modifiers.includes("Alt")) modifierBits |= 1;
  if (modifiers.includes("Control")) modifierBits |= 2;
  if (modifiers.includes("Meta")) modifierBits |= 4;
  if (modifiers.includes("Shift")) modifierBits |= 8;

  for (let i = 0; i < repeat; i++) {
    await executeCDPCommand(electronProcess, target.id, "Input.dispatchKeyEvent", {
      type: "keyDown",
      modifiers: modifierBits,
      key: mapped.key,
      code: mapped.code,
      windowsVirtualKeyCode: mapped.windowsVirtualKeyCode,
      text: mapped.text,
    });
    if (mapped.text && modifiers.length === 0) {
      await executeCDPCommand(electronProcess, target.id, "Input.dispatchKeyEvent", {
        type: "char",
        modifiers: modifierBits,
        key: mapped.key,
        code: mapped.code,
        text: mapped.text,
      });
    }
    await executeCDPCommand(electronProcess, target.id, "Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: modifierBits,
      key: mapped.key,
      code: mapped.code,
      windowsVirtualKeyCode: mapped.windowsVirtualKeyCode,
    });
  }

  return { targetId: target.id, key, modifiers, repeat };
}

/** Live MCP logging for console events (all levels when enabled). */
let consoleLiveLogging = false;

export function setConsoleLiveLogging(enabled: boolean): boolean {
  consoleLiveLogging = enabled;
  return consoleLiveLogging;
}

export function isConsoleLiveLoggingEnabled(): boolean {
  return consoleLiveLogging;
}

export function pickMainTarget(
  electronProcess: ElectronProcess,
  targetId?: string
): CDPTarget {
  if (!electronProcess.targets?.length) {
    throw new Error(
      `No CDP targets available for process ${electronProcess.id}`
    );
  }
  if (targetId) {
    return pickPageTarget(electronProcess, targetId, "any");
  }

  const targets = electronProcess.targets;
  const nodeLike =
    targets.find((t) => t.type === "node") ??
    targets.find((t) => t.type === "service_worker" && /electron|main/i.test(`${t.title} ${t.url}`)) ??
    targets.find((t) => /node/i.test(t.type));

  if (!nodeLike) {
    throw new Error(
      `No main/node target found for ${electronProcess.id}. Start with inspectMain:true (adds --inspect) or pass targetId from list_targets.`
    );
  }
  return nodeLike;
}

export async function evaluateMain(
  electronProcess: ElectronProcess,
  expression: string,
  targetId?: string,
  returnByValue = true
): Promise<{ targetId: string; targetType: string; result: unknown }> {
  await updateCDPTargets(electronProcess);
  const target = pickMainTarget(electronProcess, targetId);
  const result = await executeCDPCommand(
    electronProcess,
    target.id,
    "Runtime.evaluate",
    {
      expression,
      returnByValue,
      awaitPromise: true,
    }
  );
  return {
    targetId: target.id,
    targetType: target.type,
    result,
  };
}

export function listTargetsByRole(electronProcess: ElectronProcess): Array<{
  id: string;
  type: string;
  role: ReturnType<typeof classifyTargetRole>;
  title: string;
  url: string;
  likelyMain: boolean;
}> {
  return (electronProcess.targets ?? []).map((t) => {
    const role = classifyTargetRole(t.type);
    const likelyMain =
      t.type === "node" ||
      t.type === "browser" ||
      /main|electron/i.test(`${t.type} ${t.title} ${t.url}`);
    return {
      id: t.id,
      type: t.type,
      role,
      title: t.title,
      url: t.url,
      likelyMain,
    };
  });
}

export async function getCookies(
  electronProcess: ElectronProcess,
  options: { urls?: string[]; targetId?: string } = {}
): Promise<{ targetId: string; cookies: unknown[] }> {
  await updateCDPTargets(electronProcess);
  const target = pickPageTarget(electronProcess, options.targetId);
  await executeCDPCommand(electronProcess, target.id, "Network.enable", {});
  const result = (await executeCDPCommand(
    electronProcess,
    target.id,
    "Network.getCookies",
    options.urls?.length ? { urls: options.urls } : {}
  )) as { cookies?: unknown[] };
  return { targetId: target.id, cookies: result.cookies ?? [] };
}

export async function setCookie(
  electronProcess: ElectronProcess,
  cookie: {
    name: string;
    value: string;
    url?: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
    expires?: number;
  },
  targetId?: string
): Promise<{ targetId: string; success: boolean }> {
  await updateCDPTargets(electronProcess);
  const target = pickPageTarget(electronProcess, targetId);
  await executeCDPCommand(electronProcess, target.id, "Network.enable", {});
  if (!cookie.url && !cookie.domain) {
    const href = String(
      (await evalValue(electronProcess, target.id, "location.href")) ?? ""
    );
    if (!href || href === "about:blank") {
      throw new Error("Provide cookie.url or cookie.domain (page has no URL)");
    }
    cookie = { ...cookie, url: href };
  }
  const result = (await executeCDPCommand(
    electronProcess,
    target.id,
    "Network.setCookie",
    cookie
  )) as { success?: boolean };
  return { targetId: target.id, success: Boolean(result.success) };
}

export async function getStorage(
  electronProcess: ElectronProcess,
  kind: "localStorage" | "sessionStorage" = "localStorage",
  targetId?: string
): Promise<{ targetId: string; kind: string; entries: Record<string, string> }> {
  await updateCDPTargets(electronProcess);
  const target = pickPageTarget(electronProcess, targetId);
  const entries = (await evalValue(
    electronProcess,
    target.id,
    `(() => {
      const store = window[${JSON.stringify(kind)}];
      if (!store) return {};
      const out = {};
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key != null) out[key] = store.getItem(key);
      }
      return out;
    })()`
  )) as Record<string, string>;
  return { targetId: target.id, kind, entries: entries ?? {} };
}

export async function setStorage(
  electronProcess: ElectronProcess,
  kind: "localStorage" | "sessionStorage",
  entries: Record<string, string>,
  options: { clear?: boolean; targetId?: string } = {}
): Promise<{ targetId: string; kind: string; keys: string[] }> {
  await updateCDPTargets(electronProcess);
  const target = pickPageTarget(electronProcess, options.targetId);
  const keys = Object.keys(entries);
  await evalValue(
    electronProcess,
    target.id,
    `(() => {
      const store = window[${JSON.stringify(kind)}];
      if (!store) throw new Error(${JSON.stringify(kind)} + ' unavailable');
      if (${options.clear ? "true" : "false"}) store.clear();
      const entries = ${JSON.stringify(entries)};
      for (const [k, v] of Object.entries(entries)) store.setItem(k, String(v));
      return true;
    })()`
  );
  return { targetId: target.id, kind, keys };
}

type TraceSession = {
  targetId: string;
  events: unknown[];
  startedAt: number;
  categories: string;
};

const traceSessions = new Map<string, TraceSession>();

const DEFAULT_TRACE_CATEGORIES = [
  "devtools.timeline",
  "v8.execute",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.stack",
  "disabled-by-default-v8.cpu_profiler",
  "disabled-by-default-v8.cpu_profiler.hires",
].join(",");

export async function startTracing(
  electronProcess: ElectronProcess,
  options: { categories?: string; targetId?: string } = {}
): Promise<{ processId: string; targetId: string; categories: string }> {
  await updateCDPTargets(electronProcess);
  const target = pickPageTarget(electronProcess, options.targetId);
  if (traceSessions.has(electronProcess.id)) {
    throw new Error(
      `Tracing already active for ${electronProcess.id}. Call stop_tracing first.`
    );
  }

  const client = await connectToCDPTarget(electronProcess, target.id);
  const categories = options.categories?.trim() || DEFAULT_TRACE_CATEGORIES;
  const session: TraceSession = {
    targetId: target.id,
    events: [],
    startedAt: Date.now(),
    categories,
  };

  const onData = (params: unknown) => {
    const p = params as { value?: unknown[] };
    if (Array.isArray(p.value)) {
      session.events.push(...p.value);
    }
  };
  client.on("Tracing.dataCollected", onData);

  await client.send("Tracing.start", {
    categories,
    transferMode: "ReportEvents",
    options: "record-as-much-as-possible",
  });

  (session as TraceSession & { _onData?: (p: unknown) => void; _client?: CDP.Client })._onData =
    onData;
  (session as TraceSession & { _client?: CDP.Client })._client = client;
  traceSessions.set(electronProcess.id, session);

  return {
    processId: electronProcess.id,
    targetId: target.id,
    categories,
  };
}

export async function stopTracing(
  electronProcess: ElectronProcess,
  filePath?: string
): Promise<{
  processId: string;
  targetId: string;
  eventCount: number;
  path: string;
  elapsedMs: number;
}> {
  const session = traceSessions.get(electronProcess.id) as
    | (TraceSession & {
        _onData?: (p: unknown) => void;
        _client?: CDP.Client;
      })
    | undefined;
  if (!session) {
    throw new Error(`No active tracing session for ${electronProcess.id}`);
  }

  const client =
    session._client ??
    (await connectToCDPTarget(electronProcess, session.targetId));

  const complete = new Promise<void>((resolve) => {
    const onComplete = () => {
      client.removeListener("Tracing.tracingComplete", onComplete);
      resolve();
    };
    client.on("Tracing.tracingComplete", onComplete);
    setTimeout(resolve, 5000);
  });

  await client.send("Tracing.end");
  await complete;

  if (session._onData) {
    client.removeListener("Tracing.dataCollected", session._onData);
  }

  const resolved = path.resolve(
    filePath ??
      path.join(
        os.tmpdir(),
        `electron-mcp-trace-${electronProcess.id}-${Date.now()}.json`
      )
  );
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(
    resolved,
    JSON.stringify(
      {
        metadata: {
          processId: electronProcess.id,
          targetId: session.targetId,
          categories: session.categories,
          startedAt: session.startedAt,
          stoppedAt: Date.now(),
        },
        traceEvents: session.events,
      },
      null,
      2
    )
  );

  traceSessions.delete(electronProcess.id);

  return {
    processId: electronProcess.id,
    targetId: session.targetId,
    eventCount: session.events.length,
    path: resolved,
    elapsedMs: Date.now() - session.startedAt,
  };
}

function parseDebugPortFromCommand(command: string): number | undefined {
  const m =
    command.match(/--remote-debugging-port(?:=|\s+)(\d+)/i) ??
    command.match(/remote-debugging-port[=:](\d+)/i);
  if (!m) return undefined;
  const port = Number(m[1]);
  return Number.isFinite(port) ? port : undefined;
}

function parseInspectPortFromCommand(command: string): number | undefined {
  const m = command.match(/--inspect(?:=|\s+)(\d+)/i);
  if (!m) return undefined;
  const port = Number(m[1]);
  return Number.isFinite(port) && port > 0 ? port : undefined;
}

async function listOsProcesses(): Promise<
  Array<{ pid: number; command: string }>
> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
        ],
        { maxBuffer: 20 * 1024 * 1024 }
      );
      const parsed = JSON.parse(stdout || "[]") as
        | Array<{ ProcessId?: number; CommandLine?: string }>
        | { ProcessId?: number; CommandLine?: string };
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows
        .filter((r) => r.ProcessId && r.CommandLine)
        .map((r) => ({
          pid: Number(r.ProcessId),
          command: String(r.CommandLine),
        }));
    } catch (err) {
      log.warn("Windows process listing failed:", err);
      return [];
    }
  }

  // Linux / macOS: prefer `ps`
  try {
    const { stdout } = await execFileAsync(
      "ps",
      process.platform === "darwin"
        ? ["-ax", "-o", "pid=,command="]
        : ["-eo", "pid=,args="],
      { maxBuffer: 20 * 1024 * 1024 }
    );
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(\d+)\s+(.*)$/);
        if (!m) return null;
        return { pid: Number(m[1]), command: m[2] };
      })
      .filter((x): x is { pid: number; command: string } => Boolean(x));
  } catch (err) {
    log.warn("ps process listing failed:", err);
    return [];
  }
}

export type FoundElectronApp = {
  pid: number;
  command: string;
  debugPort?: number;
  inspectPort?: number;
  likelyElectron: boolean;
};

export async function findRunningElectronApps(): Promise<FoundElectronApp[]> {
  const procs = await listOsProcesses();
  const found: FoundElectronApp[] = [];
  for (const p of procs) {
    const cmd = p.command;
    const mentionsElectron =
      /(?:^|[\\/\s])electron(?:\.exe)?(?:\s|$)/i.test(cmd) ||
      /Electron\.app/i.test(cmd) ||
      /\belectron\b/i.test(cmd);
    if (!mentionsElectron) continue;

    const isHelper =
      /--type=/.test(cmd) ||
      /zygote/i.test(cmd) ||
      /gpu-process/i.test(cmd) ||
      /utility/i.test(cmd);
    const debugPort = parseDebugPortFromCommand(cmd);
    const inspectPort = parseInspectPortFromCommand(cmd);

    // Prefer main processes; still include helpers that expose a debug port.
    if (isHelper && !debugPort) continue;

    found.push({
      pid: p.pid,
      command: cmd.length > 400 ? `${cmd.slice(0, 400)}…` : cmd,
      debugPort,
      inspectPort,
      likelyElectron: true,
    });
  }

  const byPid = new Map<number, FoundElectronApp>();
  for (const f of found) byPid.set(f.pid, f);
  return Array.from(byPid.values()).sort((a, b) => a.pid - b.pid);
}

export async function resolveDebugPortForPid(
  pid: number
): Promise<{ pid: number; debugPort: number; command?: string }> {
  const apps = await findRunningElectronApps();
  const match = apps.find((a) => a.pid === pid);
  if (match?.debugPort) {
    return { pid, debugPort: match.debugPort, command: match.command };
  }

  // Fallback: read cmdline directly for this pid
  if (process.platform !== "win32") {
    try {
      const cmdline = fs
        .readFileSync(`/proc/${pid}/cmdline`, "utf8")
        .replace(/\0/g, " ")
        .trim();
      const debugPort = parseDebugPortFromCommand(cmdline);
      if (debugPort) {
        return { pid, debugPort, command: cmdline };
      }
    } catch {
      // ignore
    }
  }

  // Last resort: scan common ports and match version Browser target title/user-agent? Can't match PID easily.
  // Scan listening sockets owned by pid on Linux.
  if (process.platform === "linux") {
    try {
      const { stdout } = await execFileAsync("bash", [
        "-lc",
        `ss -ltnp 2>/dev/null | grep -E 'pid=${pid},' || true`,
      ]);
      const ports = Array.from(
        stdout.matchAll(/:(\d+)\s/g),
        (m) => Number(m[1])
      ).filter((p) => p >= 1024);
      for (const port of [...new Set(ports)]) {
        const probe = await probeDebugPort(port);
        if (probe.ok) {
          return { pid, debugPort: port };
        }
      }
    } catch {
      // ignore
    }
  }

  throw new Error(
    `Could not resolve a Chrome DevTools port for pid ${pid}. ` +
      `Start the app with --remote-debugging-port=PORT, or use discover_apps / find_apps.`
  );
}

export async function attachByPid(
  pid: number,
  name?: string
): Promise<ElectronProcess> {
  const resolved = await resolveDebugPortForPid(pid);
  const proc = await attachToDebugPort(
    resolved.debugPort,
    name ?? `pid:${pid}`
  );
  return proc;
}
