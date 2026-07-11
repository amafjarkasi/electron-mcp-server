#!/usr/bin/env node
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { log } from "./log.js";
import { processEvents } from "./events.js";
import {
  attachToDebugPort,
  captureScreenshot,
  clearProcessBuffers,
  clickSelector,
  connectToCDPTarget,
  diagnoseProcess,
  discoverDebugPorts,
  ensureMonitoring,
  evaluateMain,
  executeCDPCommand,
  getAllProcesses,
  getElectronDebugInfo,
  getOuterHtml,
  getPageInfo,
  getProcess,
  isConsoleLiveLoggingEnabled,
  listProcesses,
  listTargetsByRole,
  navigatePage,
  pickPageTarget,
  pickTargetByRole,
  pressKey,
  saveScreenshot,
  setConsoleLiveLogging,
  startElectronApp,
  stopElectronApp,
  typeText,
  updateCDPTargets,
  waitForCondition,
} from "./process-manager.js";

function textResult(data: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
    isError,
  };
}

function requireRunningProcess(processId: string) {
  const proc = getProcess(processId);
  if (!proc) {
    throw new Error(`Process not found: ${processId}`);
  }
  if (proc.status !== "running") {
    throw new Error(`Process ${processId} is ${proc.status}`);
  }
  return proc;
}

async function notifyResourceListChanged(): Promise<void> {
  try {
    await server.server.sendResourceListChanged();
  } catch {
    // Client may not support it yet
  }
}

async function notifyLog(
  level: "info" | "warning" | "error" | "debug",
  data: string
): Promise<void> {
  try {
    await server.server.sendLoggingMessage({ level, data });
  } catch {
    // Client may not have enabled logging
  }
}

const server = new McpServer(
  {
    name: "electron-debug-mcp",
    version: "1.3.0",
  },
  {
    capabilities: {
      logging: {},
    },
    instructions: [
      "Electron Debug MCP controls and inspects Electron apps over Chrome DevTools Protocol.",
      "Preferred workflow: start_app or attach → diagnose → get_console_messages(level=error) → screenshot/save_screenshot → get_dom/evaluate.",
      "Use wait_for (selector/hidden/enabled/count/text) before interacting with UI that may still be loading.",
      "Use click/type_text/press_key/navigate for UI automation; evaluate_main for Electron main-process targets (start with inspectMain:true).",
      "Enable set_console_live for streaming console events as MCP log notifications.",
      "Console and network events are buffered automatically for monitored page targets.",
    ].join(" "),
  }
);

processEvents.onEvent((event) => {
  void notifyResourceListChanged();
  if (event.type === "console") {
    const isError = event.level === "error" || event.level === "assert";
    if (isError || isConsoleLiveLoggingEnabled()) {
      void notifyLog(
        isError ? "error" : event.level === "warning" || event.level === "warn" ? "warning" : "info",
        `[${event.processId}/${event.targetId}] ${event.level}: ${event.text}`
      );
    }
  } else if (
    event.type === "process_started" ||
    event.type === "process_attached" ||
    event.type === "process_stopped" ||
    event.type === "process_crashed" ||
    event.type === "targets_changed"
  ) {
    void notifyLog("info", JSON.stringify(event));
  }
});

// --- Tools ---

server.tool(
  "start_app",
  "Start an Electron application with remote debugging enabled. Example: {\"appPath\":\"D:/apps/my-electron-app\",\"debugPort\":9222}",
  {
    appPath: z
      .string()
      .describe("Path to the Electron app (directory or main script)"),
    debugPort: z
      .number()
      .int()
      .min(1024)
      .max(65535)
      .optional()
      .describe("Optional Chrome DevTools debugging port (default: random 9222-9999)"),
    extraArgs: z
      .array(z.string())
      .optional()
      .describe(
        'Optional extra Electron CLI args (e.g. ["--no-sandbox"] for CI/containers)'
      ),
    inspectMain: z
      .boolean()
      .optional()
      .describe(
        "If true, pass --inspect so the Electron main process appears as a CDP node target for evaluate_main"
      ),
  },
  async ({ appPath, debugPort, extraArgs, inspectMain }) => {
    try {
      const proc = await startElectronApp(
        appPath,
        debugPort,
        extraArgs ?? [],
        { inspectMain: inspectMain ?? false }
      );
      await notifyResourceListChanged();
      return textResult({
        id: proc.id,
        name: proc.name,
        status: proc.status,
        attached: proc.attached,
        pid: proc.pid,
        debugPort: proc.debugPort,
        appPath: proc.appPath,
        targets: proc.targets ?? [],
      });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "attach",
  "Attach to an already-running Electron/Chromium app that was started with --remote-debugging-port. Example: {\"debugPort\":9222}",
  {
    debugPort: z
      .number()
      .int()
      .min(1024)
      .max(65535)
      .describe("Remote debugging port the app is listening on"),
    name: z
      .string()
      .optional()
      .describe("Optional friendly name for this attached session"),
  },
  async ({ debugPort, name }) => {
    try {
      const proc = await attachToDebugPort(debugPort, name);
      await notifyResourceListChanged();
      return textResult({
        id: proc.id,
        name: proc.name,
        status: proc.status,
        attached: proc.attached,
        debugPort: proc.debugPort,
        targets: proc.targets ?? [],
      });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "discover_apps",
  "Scan local ports for Electron/Chromium instances exposing Chrome DevTools Protocol",
  {
    startPort: z.number().int().min(1).max(65535).optional(),
    endPort: z.number().int().min(1).max(65535).optional(),
  },
  async ({ startPort, endPort }) => {
    try {
      const found = await discoverDebugPorts(startPort ?? 9222, endPort ?? 9235);
      return textResult({ found });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "stop_app",
  "Stop a process started by start_app, or detach bookkeeping for an attached session",
  {
    processId: z
      .string()
      .describe("Process id returned by start_app or attach"),
  },
  async ({ processId }) => {
    try {
      const stopped = await stopElectronApp(processId);
      if (!stopped) {
        return textResult(`Process not found: ${processId}`, true);
      }
      await notifyResourceListChanged();
      return textResult({ processId, status: "stopped" });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "list_apps",
  "List Electron applications managed or attached by this server",
  async () => textResult({ processes: listProcesses() })
);

server.tool(
  "diagnose",
  "Summarize process health: debug port reachability, target roles (page/worker/browser), recent console errors, and discovered local debug ports",
  {
    processId: z
      .string()
      .optional()
      .describe("Optional process id; omit to diagnose all managed processes"),
  },
  async ({ processId }) => {
    try {
      return textResult(await diagnoseProcess(processId));
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "get_logs",
  "Get captured stdout/stderr logs for a managed Electron process",
  {
    processId: z.string().describe("Process id returned by start_app or attach"),
    tail: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Optional number of trailing log chunks to return"),
  },
  async ({ processId, tail }) => {
    const proc = getProcess(processId);
    if (!proc) {
      return textResult(`Process not found: ${processId}`, true);
    }
    const logs = tail ? proc.logs.slice(-tail) : proc.logs;
    return textResult({
      processId,
      status: proc.status,
      logs: logs.join(""),
    });
  }
);

server.tool(
  "get_console_messages",
  "Get buffered page console/log/exception messages captured via CDP",
  {
    processId: z.string(),
    tail: z.number().int().positive().optional(),
    level: z
      .string()
      .optional()
      .describe("Optional filter, e.g. error, warning, log"),
  },
  async ({ processId, tail, level }) => {
    const proc = getProcess(processId);
    if (!proc) {
      return textResult(`Process not found: ${processId}`, true);
    }
    try {
      if (proc.status === "running") {
        await ensureMonitoring(proc);
      }
      let messages = proc.consoleMessages;
      if (level) {
        messages = messages.filter(
          (m) => m.level.toLowerCase() === level.toLowerCase()
        );
      }
      if (tail) {
        messages = messages.slice(-tail);
      }
      return textResult({ processId, count: messages.length, messages });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "get_network_log",
  "Get buffered network request/response events captured via CDP Network domain",
  {
    processId: z.string(),
    tail: z.number().int().positive().optional(),
  },
  async ({ processId, tail }) => {
    const proc = getProcess(processId);
    if (!proc) {
      return textResult(`Process not found: ${processId}`, true);
    }
    try {
      if (proc.status === "running") {
        await ensureMonitoring(proc);
      }
      const entries = tail
        ? proc.networkEntries.slice(-tail)
        : proc.networkEntries;
      return textResult({ processId, count: entries.length, entries });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "list_targets",
  "List Chrome DevTools Protocol targets with role classification (page/worker/browser/other)",
  {
    processId: z
      .string()
      .optional()
      .describe("Optional process id; omit to list targets for all running apps"),
  },
  async ({ processId }) => {
    try {
      const allTargets: Array<{
        processId: string;
        role: string;
        target: unknown;
      }> = [];

      const entries = processId
        ? ([[processId, requireRunningProcess(processId)]] as const)
        : Array.from(getAllProcesses().entries());

      for (const [id, proc] of entries) {
        if (proc.status !== "running" || !proc.debugPort) {
          continue;
        }
        try {
          await updateCDPTargets(proc);
          for (const target of proc.targets ?? []) {
            allTargets.push({
              processId: id,
              role:
                target.type === "page"
                  ? "page"
                  : target.type === "worker" || target.type === "service_worker"
                    ? "worker"
                    : target.type === "browser"
                      ? "browser"
                      : "other",
              target,
            });
          }
        } catch (err) {
          log.warn(`Could not update targets for ${id}:`, err);
        }
      }

      return textResult({ targets: allTargets });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "evaluate",
  "Evaluate JavaScript in an Electron target via CDP Runtime.evaluate. Defaults to the first page/renderer target.",
  {
    processId: z.string(),
    expression: z.string().describe("JavaScript expression to evaluate"),
    targetId: z.string().optional(),
    role: z
      .enum(["page", "worker", "browser", "other"])
      .optional()
      .describe("Preferred target role when targetId is omitted (default page)"),
    returnByValue: z.boolean().optional(),
  },
  async ({ processId, expression, targetId, role, returnByValue }) => {
    try {
      const proc = requireRunningProcess(processId);
      await updateCDPTargets(proc);
      const target = targetId
        ? pickPageTarget(proc, targetId, "any")
        : role
          ? pickTargetByRole(proc, role)
          : pickPageTarget(proc);
      const result = await executeCDPCommand(
        proc,
        target.id,
        "Runtime.evaluate",
        {
          expression,
          returnByValue: returnByValue ?? true,
          awaitPromise: true,
        }
      );
      return textResult({
        processId,
        targetId: target.id,
        targetType: target.type,
        result,
      });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "screenshot",
  "Capture a PNG/JPEG screenshot of a page target via Page.captureScreenshot",
  {
    processId: z.string(),
    targetId: z.string().optional(),
    format: z.enum(["png", "jpeg"]).optional(),
    quality: z.number().int().min(0).max(100).optional(),
  },
  async ({ processId, targetId, format, quality }) => {
    try {
      const proc = requireRunningProcess(processId);
      const shot = await captureScreenshot(
        proc,
        targetId,
        format ?? "png",
        quality
      );
      return {
        content: [
          {
            type: "image" as const,
            data: shot.data,
            mimeType: shot.mimeType,
          },
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                processId,
                targetId: shot.targetId,
                mimeType: shot.mimeType,
                bytesBase64: shot.data.length,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "save_screenshot",
  "Capture a screenshot and write it to a local file path (PNG/JPEG)",
  {
    processId: z.string(),
    path: z.string().describe("Absolute or relative file path to write"),
    targetId: z.string().optional(),
    format: z.enum(["png", "jpeg"]).optional(),
    quality: z.number().int().min(0).max(100).optional(),
  },
  async ({ processId, path: filePath, targetId, format, quality }) => {
    try {
      const proc = requireRunningProcess(processId);
      const saved = await saveScreenshot(
        proc,
        filePath,
        targetId,
        format ?? "png",
        quality
      );
      return textResult({ processId, ...saved });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "get_dom",
  "Read documentElement.outerHTML or a specific element's outerHTML",
  {
    processId: z.string(),
    selector: z
      .string()
      .optional()
      .describe("Optional CSS selector; omit for full documentElement.outerHTML"),
    targetId: z.string().optional(),
  },
  async ({ processId, selector, targetId }) => {
    try {
      const proc = requireRunningProcess(processId);
      const result = await getOuterHtml(proc, selector, targetId);
      return textResult({
        processId,
        targetId: result.targetId,
        selector: selector ?? null,
        html: result.html,
      });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "query_selector",
  "Query DOM nodes with document.querySelectorAll and return tag/id/class/text summary",
  {
    processId: z.string(),
    selector: z.string().describe("CSS selector"),
    targetId: z.string().optional(),
    limit: z.number().int().positive().max(100).optional(),
  },
  async ({ processId, selector, targetId, limit }) => {
    try {
      const proc = requireRunningProcess(processId);
      await updateCDPTargets(proc);
      const target = pickPageTarget(proc, targetId);
      const max = limit ?? 20;
      const result = (await executeCDPCommand(
        proc,
        target.id,
        "Runtime.evaluate",
        {
          expression: `(() => {
            const nodes = Array.from(document.querySelectorAll(${JSON.stringify(
              selector
            )}));
            return {
              count: nodes.length,
              nodes: nodes.slice(0, ${max}).map((el, index) => ({
                index,
                tag: el.tagName.toLowerCase(),
                id: el.id || null,
                className: typeof el.className === 'string' ? el.className : null,
                text: (el.innerText || '').trim().slice(0, 200),
              })),
            };
          })()`,
          returnByValue: true,
          awaitPromise: true,
        }
      )) as { result?: { value?: unknown } };
      return textResult({
        processId,
        targetId: target.id,
        selector,
        result: result.result?.value,
      });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "reload",
  "Reload a page target (or all page targets) in an Electron app",
  {
    processId: z.string(),
    targetId: z.string().optional(),
    ignoreCache: z.boolean().optional(),
  },
  async ({ processId, targetId, ignoreCache }) => {
    try {
      const proc = requireRunningProcess(processId);
      await updateCDPTargets(proc);

      const targets = targetId
        ? [pickPageTarget(proc, targetId)]
        : (proc.targets ?? []).filter(
            (t) => t.type === "page" || Boolean(t.webSocketDebuggerUrl)
          );

      if (!targets.length) {
        return textResult("No reloadable targets found", true);
      }

      const results = [];
      for (const target of targets) {
        const result = await executeCDPCommand(proc, target.id, "Page.reload", {
          ignoreCache: ignoreCache ?? false,
        });
        results.push({ targetId: target.id, result });
      }

      return textResult({ processId, reloaded: results });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "pause",
  "Pause JavaScript execution on a target via Debugger.pause",
  {
    processId: z.string(),
    targetId: z.string().optional(),
  },
  async ({ processId, targetId }) => {
    try {
      const proc = requireRunningProcess(processId);
      await updateCDPTargets(proc);
      const target = pickPageTarget(proc, targetId);
      await connectToCDPTarget(proc, target.id);
      await executeCDPCommand(proc, target.id, "Debugger.enable", {});
      const result = await executeCDPCommand(
        proc,
        target.id,
        "Debugger.pause",
        {}
      );
      return textResult({ processId, targetId: target.id, result });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "resume",
  "Resume JavaScript execution on a target via Debugger.resume",
  {
    processId: z.string(),
    targetId: z.string().optional(),
  },
  async ({ processId, targetId }) => {
    try {
      const proc = requireRunningProcess(processId);
      await updateCDPTargets(proc);
      const target = pickPageTarget(proc, targetId);
      await executeCDPCommand(proc, target.id, "Debugger.enable", {});
      const result = await executeCDPCommand(
        proc,
        target.id,
        "Debugger.resume",
        {}
      );
      return textResult({ processId, targetId: target.id, result });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "cdp_command",
  "Execute an arbitrary Chrome DevTools Protocol method on a target (Domain.method)",
  {
    processId: z.string(),
    method: z
      .string()
      .describe('CDP method name, e.g. "Page.navigate" or "Runtime.evaluate"'),
    targetId: z.string().optional(),
    params: z.record(z.unknown()).optional(),
  },
  async ({ processId, method, targetId, params }) => {
    try {
      if (!method.includes(".")) {
        return textResult('CDP method must be in "Domain.method" form', true);
      }
      const proc = requireRunningProcess(processId);
      await updateCDPTargets(proc);
      const target = pickPageTarget(proc, targetId);
      const result = await executeCDPCommand(
        proc,
        target.id,
        method,
        params ?? {}
      );
      return textResult({
        processId,
        targetId: target.id,
        method,
        result,
      });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "page_info",
  "Get URL, title, readyState, and userAgent for a page target",
  {
    processId: z.string(),
    targetId: z.string().optional(),
  },
  async ({ processId, targetId }) => {
    try {
      const proc = requireRunningProcess(processId);
      return textResult(await getPageInfo(proc, targetId));
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "navigate",
  "Navigate a page target to a URL (Page.navigate) and optionally wait for load",
  {
    processId: z.string(),
    url: z.string().describe("Absolute or app URL to navigate to"),
    targetId: z.string().optional(),
    waitUntilLoad: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(120000).optional(),
  },
  async ({ processId, url, targetId, waitUntilLoad, timeoutMs }) => {
    try {
      const proc = requireRunningProcess(processId);
      const result = await navigatePage(
        proc,
        url,
        targetId,
        waitUntilLoad ?? true,
        timeoutMs ?? 15000
      );
      return textResult({ processId, ...result });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "wait_for",
  "Wait until a selector exists/hides/enables, text/URL/console matches, or node count is met",
  {
    processId: z.string(),
    selector: z.string().optional().describe("CSS selector that must exist"),
    hidden: z
      .string()
      .optional()
      .describe("CSS selector that must be absent or not visible"),
    enabled: z
      .string()
      .optional()
      .describe("CSS selector that must exist and not be disabled"),
    countSelector: z
      .string()
      .optional()
      .describe("CSS selector to count (use with minCount)"),
    minCount: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Minimum matches required for countSelector"),
    text: z.string().optional().describe("Text that must appear in document.body"),
    urlIncludes: z.string().optional().describe("Substring that location.href must include"),
    consoleIncludes: z
      .string()
      .optional()
      .describe("Substring that a buffered console message must include"),
    timeoutMs: z.number().int().positive().max(120000).optional(),
    screenshotOnTimeout: z
      .boolean()
      .optional()
      .describe("If true, save a PNG to the OS temp dir when wait times out"),
    targetId: z.string().optional(),
  },
  async ({
    processId,
    selector,
    hidden,
    enabled,
    countSelector,
    minCount,
    text,
    urlIncludes,
    consoleIncludes,
    timeoutMs,
    screenshotOnTimeout,
    targetId,
  }) => {
    try {
      if (
        !selector &&
        !hidden &&
        !enabled &&
        !countSelector &&
        !text &&
        !urlIncludes &&
        !consoleIncludes
      ) {
        return textResult(
          "Provide at least one of: selector, hidden, enabled, countSelector, text, urlIncludes, consoleIncludes",
          true
        );
      }
      if ((countSelector && minCount == null) || (!countSelector && minCount != null)) {
        return textResult(
          "countSelector and minCount must be provided together",
          true
        );
      }
      const proc = requireRunningProcess(processId);
      if (consoleIncludes) {
        await ensureMonitoring(proc);
      }
      const result = await waitForCondition(proc, {
        selector,
        hidden,
        enabled,
        count:
          countSelector && minCount != null
            ? { selector: countSelector, min: minCount }
            : undefined,
        text,
        urlIncludes,
        consoleIncludes,
        timeoutMs,
        screenshotOnTimeout,
        targetId,
      });
      return textResult({ processId, ...result });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "click",
  "Click the center of a CSS selector via CDP Input.dispatchMouseEvent",
  {
    processId: z.string(),
    selector: z.string().describe("CSS selector to click"),
    targetId: z.string().optional(),
    button: z.enum(["left", "right", "middle"]).optional(),
  },
  async ({ processId, selector, targetId, button }) => {
    try {
      const proc = requireRunningProcess(processId);
      const result = await clickSelector(
        proc,
        selector,
        targetId,
        button ?? "left"
      );
      return textResult({ processId, ...result });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "type_text",
  "Type text into the focused element (optionally click a selector first)",
  {
    processId: z.string(),
    text: z.string(),
    selector: z
      .string()
      .optional()
      .describe("Optional CSS selector to focus before typing"),
    clear: z
      .boolean()
      .optional()
      .describe("If true and selector is set, clear the field first"),
    pressEnter: z.boolean().optional(),
    targetId: z.string().optional(),
  },
  async ({ processId, text, selector, clear, pressEnter, targetId }) => {
    try {
      const proc = requireRunningProcess(processId);
      const result = await typeText(proc, text, {
        selector,
        clear,
        pressEnter,
        targetId,
      });
      return textResult({ processId, ...result });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "press_key",
  "Press a key or shortcut (Enter, Escape, Tab, Arrow*, or a character) with optional modifiers",
  {
    processId: z.string(),
    key: z
      .string()
      .describe('Key name, e.g. "Enter", "Escape", "a", "Tab", "ArrowDown"'),
    selector: z
      .string()
      .optional()
      .describe("Optional CSS selector to focus before keypress"),
    modifiers: z
      .array(z.enum(["Alt", "Control", "Meta", "Shift"]))
      .optional()
      .describe('Modifier keys, e.g. ["Control"] for Ctrl+A'),
    repeat: z.number().int().positive().max(50).optional(),
    targetId: z.string().optional(),
  },
  async ({ processId, key, selector, modifiers, repeat, targetId }) => {
    try {
      const proc = requireRunningProcess(processId);
      const result = await pressKey(proc, key, {
        selector,
        modifiers,
        repeat,
        targetId,
      });
      return textResult({ processId, ...result });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "set_console_live",
  "Enable/disable live MCP log notifications for console events (all levels when enabled; errors always notify)",
  {
    enabled: z.boolean().describe("true to stream console events as MCP logs"),
  },
  async ({ enabled }) => {
    const value = setConsoleLiveLogging(enabled);
    return textResult({
      consoleLiveLogging: value,
      note: "Errors/asserts always emit MCP logs. When enabled, log/info/warn/debug also stream live.",
    });
  }
);

server.tool(
  "evaluate_main",
  "Evaluate JavaScript in the Electron main/node CDP target (use start_app with inspectMain:true for best results)",
  {
    processId: z.string(),
    expression: z.string(),
    targetId: z
      .string()
      .optional()
      .describe("Optional explicit main/node target id from list_targets"),
    returnByValue: z.boolean().optional(),
  },
  async ({ processId, expression, targetId, returnByValue }) => {
    try {
      const proc = requireRunningProcess(processId);
      await updateCDPTargets(proc);
      const result = await evaluateMain(
        proc,
        expression,
        targetId,
        returnByValue ?? true
      );
      return textResult({
        processId,
        ...result,
        targets: listTargetsByRole(proc),
      });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

server.tool(
  "clear_buffers",
  "Clear buffered console messages, network events, and/or process logs",
  {
    processId: z.string(),
    console: z.boolean().optional(),
    network: z.boolean().optional(),
    logs: z.boolean().optional(),
  },
  async ({ processId, console: clearConsole, network, logs }) => {
    try {
      const proc = getProcess(processId);
      if (!proc) {
        return textResult(`Process not found: ${processId}`, true);
      }
      const what: Array<"console" | "network" | "logs"> = [];
      if (clearConsole ?? true) what.push("console");
      if (network ?? true) what.push("network");
      if (logs ?? false) what.push("logs");
      return textResult({
        processId,
        ...clearProcessBuffers(proc, what),
      });
    } catch (err) {
      return textResult(
        err instanceof Error ? err.message : String(err),
        true
      );
    }
  }
);

// --- Prompts ---

server.prompt(
  "debug_blank_window",
  "Workflow for diagnosing a blank or white Electron window",
  {
    processId: z.string().describe("Managed process id from start_app or attach"),
  },
  async ({ processId }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Diagnose a blank/white Electron window for process ${processId}.
1. Call diagnose with this processId.
2. Call list_targets and identify page targets.
3. Call get_console_messages (level=error) and get_logs.
4. Call screenshot to see the current UI.
5. Call get_dom / query_selector to inspect #root/app containers.
6. Summarize likely causes (renderer crash, failed load URL, CSP, route error) and next fixes.`,
        },
      },
    ],
  })
);

server.prompt(
  "find_renderer_exception",
  "Workflow for finding renderer exceptions and console errors",
  {
    processId: z.string(),
  },
  async ({ processId }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Find renderer exceptions for process ${processId}.
1. ensure monitoring by calling get_console_messages.
2. Filter errors/exceptions; if empty, evaluate a canary then reproduce the user bug.
3. Use get_network_log for failed requests.
4. Report stack/text, targetId, and suggested fix.`,
        },
      },
    ],
  })
);

server.prompt(
  "ui_smoke_check",
  "Workflow for a quick interactive UI smoke check in an Electron window",
  {
    processId: z.string(),
    selector: z
      .string()
      .describe("Primary interactive CSS selector, e.g. a button or input"),
  },
  async ({ processId, selector }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Run a quick UI smoke check for process ${processId}.
1. page_info to confirm URL/title.
2. wait_for selector=${selector}.
3. screenshot before interaction.
4. If selector is an input, type_text a sample value; if a button, click it.
5. wait_for a visible status/text change, then screenshot again.
6. get_console_messages(level=error) and summarize pass/fail.`,
        },
      },
    ],
  })
);

// --- Resources ---

server.resource(
  "info",
  "electron://info",
  {
    description: "Overview of Electron apps managed by this server",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({ processes: listProcesses() }, null, 2),
      },
    ],
  })
);

server.resource(
  "targets",
  "electron://targets",
  {
    description: "All CDP targets across running Electron processes",
    mimeType: "application/json",
  },
  async (uri) => {
    const allTargets: Array<{ processId: string; target: unknown }> = [];

    for (const [id, proc] of getAllProcesses().entries()) {
      if (proc.status !== "running" || !proc.debugPort) {
        continue;
      }
      try {
        await updateCDPTargets(proc);
        for (const target of proc.targets ?? []) {
          allTargets.push({ processId: id, target });
        }
      } catch (err) {
        log.warn(`Could not update targets for ${id}:`, err);
      }
    }

    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(allTargets, null, 2),
        },
      ],
    };
  }
);

server.resource(
  "process",
  new ResourceTemplate("electron://process/{id}", {
    list: async () => ({
      resources: listProcesses().map((proc) => ({
        uri: `electron://process/${proc.id}`,
        name: `Electron Process: ${proc.name}`,
        description: `Debug information for ${proc.name} (${proc.status})`,
        mimeType: "application/json",
      })),
    }),
  }),
  {
    description: "Detailed debug info for a managed Electron process",
    mimeType: "application/json",
  },
  async (uri, { id }) => {
    const processId = String(id);
    const debugInfo = await getElectronDebugInfo(processId);
    if (!debugInfo) {
      throw new Error(`Process not found: ${processId}`);
    }
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(debugInfo, null, 2),
        },
      ],
    };
  }
);

server.resource(
  "logs",
  new ResourceTemplate("electron://logs/{id}", {
    list: async () => ({
      resources: listProcesses().map((proc) => ({
        uri: `electron://logs/${proc.id}`,
        name: `Electron Logs: ${proc.name}`,
        description: `Captured logs for ${proc.name}`,
        mimeType: "text/plain",
      })),
    }),
  }),
  {
    description: "Captured logs for a managed Electron process",
    mimeType: "text/plain",
  },
  async (uri, { id }) => {
    const processId = String(id);
    const proc = getProcess(processId);
    if (!proc) {
      throw new Error(`Process not found: ${processId}`);
    }
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "text/plain",
          text: proc.logs.join(""),
        },
      ],
    };
  }
);

server.resource(
  "console",
  new ResourceTemplate("electron://console/{id}", {
    list: async () => ({
      resources: listProcesses().map((proc) => ({
        uri: `electron://console/${proc.id}`,
        name: `Console: ${proc.name}`,
        description: `Buffered console messages for ${proc.name}`,
        mimeType: "application/json",
      })),
    }),
  }),
  {
    description: "Buffered console/exception messages",
    mimeType: "application/json",
  },
  async (uri, { id }) => {
    const proc = getProcess(String(id));
    if (!proc) {
      throw new Error(`Process not found: ${id}`);
    }
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(proc.consoleMessages, null, 2),
        },
      ],
    };
  }
);

server.resource(
  "cdp-target",
  new ResourceTemplate("electron://cdp/{processId}/{targetId}", {
    list: async () => {
      const resources = [];
      for (const [processId, proc] of getAllProcesses().entries()) {
        for (const target of proc.targets ?? []) {
          resources.push({
            uri: `electron://cdp/${processId}/${target.id}`,
            name: `CDP: ${target.title || target.url || target.id}`,
            description: `CDP target info for ${target.id}`,
            mimeType: "application/json",
          });
        }
      }
      return { resources };
    },
  }),
  {
    description: "Read-only CDP target metadata",
    mimeType: "application/json",
  },
  async (uri, { processId, targetId }) => {
    const proc = getProcess(String(processId));
    if (!proc) {
      throw new Error(`Process not found: ${processId}`);
    }
    if (proc.status === "running" && proc.debugPort) {
      try {
        await updateCDPTargets(proc);
      } catch (err) {
        log.warn(`Could not refresh targets for ${processId}:`, err);
      }
    }
    const target = proc.targets?.find((t) => t.id === String(targetId));
    if (!target) {
      throw new Error(`Target ${targetId} not found in process ${processId}`);
    }
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              processId,
              target,
              hint: "Use evaluate, screenshot, get_dom, get_console_messages, or cdp_command tools",
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
log.info("Electron Debug MCP Server running on stdio");
