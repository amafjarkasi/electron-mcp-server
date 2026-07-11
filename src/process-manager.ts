import { spawn, ChildProcess, execFile } from "child_process";
import { createRequire } from "module";
import * as fs from "fs";
import * as path from "path";
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
  extraArgs: string[] = []
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

export async function captureScreenshot(
  electronProcess: ElectronProcess,
  targetId?: string,
  format: "png" | "jpeg" = "png",
  quality?: number
): Promise<{ targetId: string; mimeType: string; data: string }> {
  await updateCDPTargets(electronProcess);
  const target = pickPageTarget(electronProcess, targetId);
  await ensureMonitoring(electronProcess, target.id);
  const result = (await executeCDPCommand(
    electronProcess,
    target.id,
    "Page.captureScreenshot",
    {
      format,
      ...(format === "jpeg" && quality ? { quality } : {}),
      fromSurface: true,
    }
  )) as { data: string };

  return {
    targetId: target.id,
    mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
    data: result.data,
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
