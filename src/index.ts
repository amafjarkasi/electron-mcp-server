#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { log } from "./log.js";
import {
  connectToCDPTarget,
  executeCDPCommand,
  getAllProcesses,
  getElectronDebugInfo,
  getProcess,
  listProcesses,
  pickPageTarget,
  startElectronApp,
  stopElectronApp,
  updateCDPTargets,
} from "./process-manager.js";

function textResult(data: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof data === "string" ? data : JSON.stringify(data, null, 2),
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

const server = new McpServer({
  name: "electron-debug-mcp",
  version: "1.0.0",
});

// --- Tools (mutations / actions) ---

server.tool(
  "start_app",
  "Start an Electron application with remote debugging enabled",
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
  },
  async ({ appPath, debugPort }) => {
    try {
      const proc = await startElectronApp(appPath, debugPort);
      return textResult({
        id: proc.id,
        name: proc.name,
        status: proc.status,
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
  "stop_app",
  "Stop a running Electron application started by this server",
  {
    processId: z.string().describe("Process id returned by start_app"),
  },
  async ({ processId }) => {
    try {
      const stopped = await stopElectronApp(processId);
      if (!stopped) {
        return textResult(`Process not found: ${processId}`, true);
      }
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
  "List Electron applications managed by this server",
  async () => textResult({ processes: listProcesses() })
);

server.tool(
  "get_logs",
  "Get captured stdout/stderr logs for a managed Electron process",
  {
    processId: z.string().describe("Process id returned by start_app"),
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
  "list_targets",
  "List Chrome DevTools Protocol targets for a process (or all processes)",
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
            allTargets.push({ processId: id, target });
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
  "Evaluate JavaScript in an Electron page/renderer via CDP Runtime.evaluate",
  {
    processId: z.string().describe("Process id returned by start_app"),
    expression: z.string().describe("JavaScript expression to evaluate"),
    targetId: z
      .string()
      .optional()
      .describe("Optional CDP target id; defaults to the first page target"),
    returnByValue: z
      .boolean()
      .optional()
      .describe("Whether to return the result by value (default true)"),
  },
  async ({ processId, expression, targetId, returnByValue }) => {
    try {
      const proc = requireRunningProcess(processId);
      await updateCDPTargets(proc);
      const target = pickPageTarget(proc, targetId);
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
  "reload",
  "Reload a page target (or all page targets) in an Electron app",
  {
    processId: z.string().describe("Process id returned by start_app"),
    targetId: z
      .string()
      .optional()
      .describe("Optional CDP target id; omit to reload all page targets"),
    ignoreCache: z
      .boolean()
      .optional()
      .describe("If true, reload ignoring cache"),
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
    processId: z.string().describe("Process id returned by start_app"),
    targetId: z
      .string()
      .optional()
      .describe("Optional CDP target id; defaults to the first page target"),
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
    processId: z.string().describe("Process id returned by start_app"),
    targetId: z
      .string()
      .optional()
      .describe("Optional CDP target id; defaults to the first page target"),
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
  "Execute an arbitrary Chrome DevTools Protocol method on a target",
  {
    processId: z.string().describe("Process id returned by start_app"),
    method: z
      .string()
      .describe('CDP method name, e.g. "Page.navigate" or "Runtime.evaluate"'),
    targetId: z
      .string()
      .optional()
      .describe("Optional CDP target id; defaults to the first page target"),
    params: z
      .record(z.unknown())
      .optional()
      .describe("Optional JSON object of CDP method parameters"),
  },
  async ({ processId, method, targetId, params }) => {
    try {
      if (!method.includes(".")) {
        return textResult(
          'CDP method must be in "Domain.method" form',
          true
        );
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

// --- Resources (read-only inspection) ---

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
              hint: "Use the evaluate, reload, pause, resume, or cdp_command tools to act on this target",
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
