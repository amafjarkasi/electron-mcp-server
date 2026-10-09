#!/usr/bin/env node
import {
	McpServer,
	ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { z } from "zod";
import { processEvents } from "./events.js";
import { log } from "./log.js";
import {
	allocateLocalPort,
	attachByPid,
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
	findRunningElectronApps,
	getAllProcesses,
	getCookies,
	getElectronDebugInfo,
	getOuterHtml,
	getPageInfo,
	getProcess,
	getStorage,
	isConsoleLiveLoggingEnabled,
	listProcesses,
	listTargetsByRole,
	navigatePage,
	pickPageTarget,
	pickTargetByRole,
	pressKey,
	saveScreenshot,
	setConsoleLiveLogging,
	setCookie,
	setStorage,
	startElectronApp,
	startTracing,
	stopElectronApp,
	stopTracing,
	typeText,
	updateCDPTargets,
	waitForCondition,
	withTimeout,
} from "./process-manager.js";
import {
	assertUi,
	blockUrls,
	captureMhtml,
	clearNetworkStubs,
	clickByAx,
	diffScreenshot,
	emulate,
	enableIpcTap,
	exportHar,
	findInstalledElectronApps,
	getAccessibilitySnapshot,
	getAppVision,
	getAuditIssues,
	getIpcLog,
	getMainState,
	getPerformanceMetrics,
	getResponseBody,
	getWebContentsTopology,
	handleDialog,
	highlightSelector,
	networkStub,
	openDeepLink,
	removeBreakpoint,
	resolveStack,
	runPerfAudit,
	setBreakpointByUrl,
	setExtraHeaders,
	setFileInput,
	setVirtualClock,
	startCoverage,
	startCpuProfile,
	startScreencast,
	stopCoverage,
	stopCpuProfile,
	stopScreencast,
	takeHeapSnapshot,
	typeByAx,
	waitNetworkIdle,
} from "./power-tools.js";

const require = createRequire(import.meta.url);
const SERVER_VERSION = (
	require("../package.json") as { version: string }
).version;
const startedAt = Date.now();

function resolveElectronBinary(): {
	resolved: boolean;
	path?: string;
	via?: string;
	error?: string;
} {
	const envPath = process.env.ELECTRON_PATH?.trim();
	if (envPath) {
		return {
			resolved: existsSync(envPath),
			path: envPath,
			via: "ELECTRON_PATH",
		};
	}
	try {
		const fromPackage = require("electron") as string;
		if (fromPackage && existsSync(fromPackage)) {
			return {
				resolved: true,
				path: fromPackage,
				via: "require(electron)",
			};
		}
		return {
			resolved: false,
			path: fromPackage || undefined,
			via: "require(electron)",
		};
	} catch (err) {
		return {
			resolved: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

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
	data: string,
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
		version: SERVER_VERSION,
	},
	{
		capabilities: {
			logging: {},
		},
		instructions: [
			"Electron Debug MCP controls and inspects Electron apps over Chrome DevTools Protocol.",
			"Start with doctor when the environment is unknown (Electron binary, DISPLAY, sandbox flags, free port sample).",
			"Preferred workflow: start_app / attach / attach_by_pid / find_apps → diagnose → get_console_messages(level=error) → screenshot/save_screenshot → get_dom/evaluate.",
			"Use wait_for (selector/hidden/enabled/count/text) before interacting with UI that may still be loading.",
			"Use click/type_text/press_key/navigate/reload for UI automation.",
			"For main-process JS use start_app({ inspectMain: true }) then evaluate_main — inspectMain opens a pinned --inspect port and merges the node target into list_targets.",
			"screenshot/save_screenshot accept selector to clip an element. Use get/set_cookies and get/set_storage for web state; start_tracing/stop_tracing for perf traces; get_logs for stdout/stderr.",
			"Enable set_console_live for streaming console events as MCP log notifications.",
			"Console and network events are buffered automatically for monitored page targets.",
			"stop_app removes the session from list_apps (owned processes are killed; attached sessions detach only). Do not retry tools against a stopped processId — start or attach again.",
			"Read electron://server for package version, uptime, and capability counts without calling a tool.",
		].join(" "),
	},
);

processEvents.onEvent((event) => {
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
    void notifyResourceListChanged();
    void notifyLog("info", JSON.stringify(event));
  }
});

// --- Tools ---

server.tool(
	"start_app",
	'Start an Electron application with remote debugging enabled. Example: {"appPath":"D:/apps/my-electron-app","debugPort":9222}',
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
			.describe(
				"Optional Chrome DevTools debugging port (default: random 9222-9999)",
			),
		extraArgs: z
			.array(z.string())
			.optional()
			.describe(
				'Optional extra Electron CLI args (e.g. ["--no-sandbox"] for CI/containers)',
			),
		inspectMain: z
			.boolean()
			.optional()
			.describe(
				"If true, pass --inspect so the Electron main process appears as a CDP node target for evaluate_main",
			),
	},
	async ({ appPath, debugPort, extraArgs, inspectMain }) => {
		try {
			const proc = await startElectronApp(appPath, debugPort, extraArgs ?? [], {
				inspectMain: inspectMain ?? false,
			});
			await notifyResourceListChanged();
			return textResult({
				id: proc.id,
				name: proc.name,
				status: proc.status,
				attached: proc.attached,
				pid: proc.pid,
				debugPort: proc.debugPort,
				inspectPort: proc.inspectPort,
				appPath: proc.appPath,
				targets: proc.targets ?? [],
			});
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"attach",
	'Attach to an already-running Electron/Chromium app that was started with --remote-debugging-port. Example: {"debugPort":9222}',
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
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"attach_by_pid",
	"Attach to a running Electron app by OS process id (resolves --remote-debugging-port from the process command line)",
	{
		pid: z
			.number()
			.int()
			.positive()
			.describe("OS process id of the Electron main process"),
		name: z.string().optional(),
	},
	async ({ pid, name }) => {
		try {
			const proc = await attachByPid(pid, name);
			await notifyResourceListChanged();
			return textResult({
				id: proc.id,
				name: proc.name,
				status: proc.status,
				attached: proc.attached,
				debugPort: proc.debugPort,
				pid,
				targets: proc.targets ?? [],
			});
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"find_apps",
	"Find running Electron processes on this machine (PID, command, debugPort if present in argv)",
	{},
	async () => {
		try {
			const apps = await findRunningElectronApps();
			return textResult({ apps, count: apps.length });
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
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
			const found = await discoverDebugPorts(
				startPort ?? 9222,
				endPort ?? 9235,
			);
			return textResult({ found });
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
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
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"list_apps",
	"List Electron applications managed or attached by this server",
	async () => textResult({ processes: listProcesses() }),
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
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"doctor",
	"Local environment health check: package/node/platform, Electron binary, env flags, managed process count, optional free-port sample (localhost bind only)",
	{
		sampleFreePort: z
			.boolean()
			.optional()
			.describe(
				"If true (default), allocate a free 127.0.0.1 port sample via bind; no remote network",
			),
	},
	async ({ sampleFreePort }) => {
		try {
			const electronBinary = resolveElectronBinary();
			const report: Record<string, unknown> = {
				ok: electronBinary.resolved,
				version: SERVER_VERSION,
				uptimeMs: Date.now() - startedAt,
				node: process.version,
				platform: process.platform,
				arch: process.arch,
				electronBinary,
				env: {
					ELECTRON_MCP_NO_SANDBOX:
						process.env.ELECTRON_MCP_NO_SANDBOX ?? null,
					ELECTRON_MCP_ALLOWED_ROOTS: process.env
						.ELECTRON_MCP_ALLOWED_ROOTS
						? "(set)"
						: null,
					ELECTRON_MCP_OUTPUT_ROOTS: process.env.ELECTRON_MCP_OUTPUT_ROOTS
						? "(set)"
						: null,
					CI: process.env.CI ?? null,
					DISPLAY: process.env.DISPLAY ?? null,
				},
				managedProcessCount: listProcesses().length,
				consoleLiveLogging: isConsoleLiveLoggingEnabled(),
			};
			if (sampleFreePort !== false) {
				report.freePortSample = await allocateLocalPort();
			}
			return textResult(report);
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"get_logs",
	"Get captured stdout/stderr logs for a managed Electron process",
	{
		processId: z
			.string()
			.describe("Process id returned by start_app or attach"),
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
	},
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
      const targetLevel = level ? level.toLowerCase() : null;
      if (tail && tail > 0) {
        const result = [];
        for (let i = messages.length - 1; i >= 0 && result.length < tail; i--) {
          const msg = messages[i];
          if (!targetLevel || msg.level.toLowerCase() === targetLevel) {
            result.push(msg);
          }
        }
        result.reverse();
        messages = result;
      } else if (targetLevel) {
        messages = messages.filter(
          (m) => m.level.toLowerCase() === targetLevel
        );
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
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"list_targets",
	"List Chrome DevTools Protocol targets with role classification (page/worker/browser/other)",
	{
		processId: z
			.string()
			.optional()
			.describe(
				"Optional process id; omit to list targets for all running apps",
			),
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
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
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
			.describe(
				"Preferred target role when targetId is omitted (default page)",
			),
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
				},
			);
			return textResult({
				processId,
				targetId: target.id,
				targetType: target.type,
				result,
			});
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"screenshot",
	"Capture a PNG/JPEG screenshot of a page target via Page.captureScreenshot (optional CSS selector clips to element bounds)",
	{
		processId: z.string(),
		targetId: z.string().optional(),
		format: z.enum(["png", "jpeg"]).optional(),
		quality: z.number().int().min(0).max(100).optional(),
		selector: z
			.string()
			.optional()
			.describe(
				"Optional CSS selector — capture only that element's bounding box",
			),
	},
	async ({ processId, targetId, format, quality, selector }) => {
		try {
			const proc = requireRunningProcess(processId);
			const shot = await captureScreenshot(
				proc,
				targetId,
				format ?? "png",
				quality,
				selector,
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
								clip: shot.clip ?? null,
							},
							null,
							2,
						),
					},
				],
			};
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"save_screenshot",
	"Capture a screenshot and write it to a local file path (PNG/JPEG); optional selector clips to element",
	{
		processId: z.string(),
		path: z.string().describe("Absolute or relative file path to write"),
		targetId: z.string().optional(),
		format: z.enum(["png", "jpeg"]).optional(),
		quality: z.number().int().min(0).max(100).optional(),
		selector: z
			.string()
			.optional()
			.describe(
				"Optional CSS selector — capture only that element's bounding box",
			),
	},
	async ({
		processId,
		path: filePath,
		targetId,
		format,
		quality,
		selector,
	}) => {
		try {
			const proc = requireRunningProcess(processId);
			const saved = await saveScreenshot(
				proc,
				filePath,
				targetId,
				format ?? "png",
				quality,
				selector,
			);
			return textResult({ processId, ...saved });
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"get_dom",
	"Read documentElement.outerHTML or a specific element's outerHTML",
	{
		processId: z.string(),
		selector: z
			.string()
			.optional()
			.describe(
				"Optional CSS selector; omit for full documentElement.outerHTML",
			),
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
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
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
							selector,
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
				},
			)) as { result?: { value?: unknown } };
			return textResult({
				processId,
				targetId: target.id,
				selector,
				result: result.result?.value,
			});
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
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
						(t) =>
							t.type === "page" ||
							// Fallback only for unusual page-like targets; never reload
							// main-process `node` inspect targets (no Page domain).
							(Boolean(t.webSocketDebuggerUrl) &&
								t.type !== "node" &&
								t.type !== "browser"),
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
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
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
			const client = await connectToCDPTarget(proc, target.id);
			await withTimeout(
				client.send("Debugger.enable", {}),
				20_000,
				"Debugger.enable",
			);
			const paused = new Promise<unknown>((resolve) => {
				const onPaused = (params: unknown) => {
					try {
						client.removeListener("Debugger.paused", onPaused);
					} catch {
						/* ignore */
					}
					resolve(params);
				};
				client.on("Debugger.paused", onPaused);
			});
			await withTimeout(
				client.send("Debugger.pause", {}),
				20_000,
				"Debugger.pause",
			);
			// Idle pages never hit a JS statement — kick the event loop so pause lands.
			void client
				.send("Runtime.evaluate", {
					expression: "void 0",
					returnByValue: true,
				})
				.catch(() => undefined);
			const pauseEvent = await withTimeout(
				paused,
				10_000,
				"Debugger.paused event",
			);
			return textResult({
				processId,
				targetId: target.id,
				paused: true,
				pauseEvent,
			});
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
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
				{},
			);
			// Detach the debugger so later Page.captureScreenshot / Input commands
			// are not blocked by an open Debugger session.
			try {
				await executeCDPCommand(proc, target.id, "Debugger.disable", {});
			} catch {
				// optional
			}
			return textResult({ processId, targetId: target.id, result });
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
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
				params ?? {},
			);
			return textResult({
				processId,
				targetId: target.id,
				method,
				result,
			});
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
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
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
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
				timeoutMs ?? 15000,
			);
			return textResult({ processId, ...result });
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
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
		text: z
			.string()
			.optional()
			.describe("Text that must appear in document.body"),
		urlIncludes: z
			.string()
			.optional()
			.describe("Substring that location.href must include"),
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
					true,
				);
			}
			if (
				(countSelector && minCount == null) ||
				(!countSelector && minCount != null)
			) {
				return textResult(
					"countSelector and minCount must be provided together",
					true,
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
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
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
				button ?? "left",
			);
			return textResult({ processId, ...result });
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
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
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
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
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
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
	},
);

server.tool(
	"get_cookies",
	"Read cookies for the page (optionally filtered by URL)",
	{
		processId: z.string(),
		urls: z.array(z.string()).optional(),
		targetId: z.string().optional(),
	},
	async ({ processId, urls, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			const result = await getCookies(proc, { urls, targetId });
			return textResult({ processId, ...result });
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"set_cookie",
	"Set a cookie on the page (provide url or domain; defaults to current location.href)",
	{
		processId: z.string(),
		name: z.string(),
		value: z.string(),
		url: z.string().optional(),
		domain: z.string().optional(),
		path: z.string().optional(),
		secure: z.boolean().optional(),
		httpOnly: z.boolean().optional(),
		sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
		expires: z.number().optional().describe("Unix time in seconds"),
		targetId: z.string().optional(),
	},
	async ({
		processId,
		name,
		value,
		url,
		domain,
		path: cookiePath,
		secure,
		httpOnly,
		sameSite,
		expires,
		targetId,
	}) => {
		try {
			const proc = requireRunningProcess(processId);
			const result = await setCookie(
				proc,
				{
					name,
					value,
					url,
					domain,
					path: cookiePath,
					secure,
					httpOnly,
					sameSite,
					expires,
				},
				targetId,
			);
			return textResult({ processId, ...result });
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"get_storage",
	"Read localStorage or sessionStorage key/value pairs from the page",
	{
		processId: z.string(),
		kind: z.enum(["localStorage", "sessionStorage"]).optional(),
		targetId: z.string().optional(),
	},
	async ({ processId, kind, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			const result = await getStorage(proc, kind ?? "localStorage", targetId);
			return textResult({ processId, ...result });
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"set_storage",
	"Write localStorage or sessionStorage entries (optionally clear first)",
	{
		processId: z.string(),
		kind: z.enum(["localStorage", "sessionStorage"]).optional(),
		entries: z.record(z.string()),
		clear: z.boolean().optional(),
		targetId: z.string().optional(),
	},
	async ({ processId, kind, entries, clear, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			const result = await setStorage(proc, kind ?? "localStorage", entries, {
				clear,
				targetId,
			});
			return textResult({ processId, ...result });
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"start_tracing",
	"Start Chrome DevTools Protocol performance tracing (pair with stop_tracing)",
	{
		processId: z.string(),
		categories: z
			.string()
			.optional()
			.describe(
				"Comma-separated CDP trace categories (default: timeline + v8)",
			),
		targetId: z.string().optional(),
	},
	async ({ processId, categories, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			const result = await startTracing(proc, { categories, targetId });
			return textResult(result);
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"stop_tracing",
	"Stop CDP tracing and write a JSON trace file (open in chrome://tracing)",
	{
		processId: z.string(),
		path: z
			.string()
			.optional()
			.describe("Output file path (default: OS temp dir)"),
	},
	async ({ processId, path: filePath }) => {
		try {
			const proc = requireRunningProcess(processId);
			const result = await stopTracing(proc, filePath);
			return textResult(result);
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
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
				returnByValue ?? true,
			);
			return textResult({
				processId,
				...result,
				targets: listTargetsByRole(proc),
			});
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"clear_buffers",
	"Clear buffered console messages, network events, process logs, ipc, and/or audits",
	{
		processId: z.string(),
		console: z.boolean().optional(),
		network: z.boolean().optional(),
		logs: z.boolean().optional(),
		ipc: z.boolean().optional(),
		audits: z.boolean().optional(),
	},
	async ({ processId, console: clearConsole, network, logs, ipc, audits }) => {
		try {
			const proc = getProcess(processId);
			if (!proc) {
				return textResult(`Process not found: ${processId}`, true);
			}
			const hasExplicitFlag =
				clearConsole !== undefined ||
				network !== undefined ||
				logs !== undefined ||
				ipc !== undefined ||
				audits !== undefined;

			const what: Array<"console" | "network" | "logs" | "ipc" | "audits"> =
				[];
			if (hasExplicitFlag) {
				if (clearConsole) what.push("console");
				if (network) what.push("network");
				if (logs) what.push("logs");
				if (ipc) what.push("ipc");
				if (audits) what.push("audits");
			} else {
				what.push("console", "network", "logs");
			}

			return textResult({
				processId,
				...clearProcessBuffers(proc, what),
			});
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

// --- Creative power tools (v1.6) ---

server.tool(
	"snapshot",
	"Accessibility tree snapshot (roles/names) via CDP Accessibility.getFullAXTree — agent-friendly UI map",
	{
		processId: z.string(),
		depth: z.number().int().positive().optional(),
		targetId: z.string().optional(),
	},
	async ({ processId, depth, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			const result = await getAccessibilitySnapshot(proc, { depth, targetId });
			return textResult({ processId, ...result });
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"vision",
	"One-shot app state: screenshot + page_info + recent console errors + network failures + windows",
	{
		processId: z.string(),
		targetId: z.string().optional(),
		includeScreenshot: z
			.boolean()
			.optional()
			.describe("Include base64 PNG (default true)"),
	},
	async ({ processId, targetId, includeScreenshot }) => {
		try {
			const proc = requireRunningProcess(processId);
			const result = await getAppVision(proc, { targetId, includeScreenshot });
			const shot = result.screenshot as
				| { mimeType?: string; data?: string }
				| undefined;
			if (shot?.data) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{ ...result, screenshot: { ...shot, data: "[see image]" } },
								null,
								2,
							),
						},
						{
							type: "image" as const,
							data: shot.data,
							mimeType: shot.mimeType ?? "image/png",
						},
					],
				};
			}
			return textResult(result);
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"get_response_body",
	"Fetch body for a buffered network requestId (call after Network.loadingFinished)",
	{
		processId: z.string(),
		requestId: z.string(),
		targetId: z.string().optional(),
	},
	async ({ processId, requestId, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			const result = await getResponseBody(proc, requestId, targetId);
			return textResult({ processId, ...result });
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"block_urls",
	"Block URL patterns via Network.setBlockedURLs (e.g. *.analytics.com/*)",
	{
		processId: z.string(),
		urls: z.array(z.string()).describe("URL patterns to block"),
		targetId: z.string().optional(),
	},
	async ({ processId, urls, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			const result = await blockUrls(proc, urls, targetId);
			return textResult({ processId, ...result });
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"set_extra_headers",
	"Set extra HTTP headers for subsequent requests (Network.setExtraHTTPHeaders)",
	{
		processId: z.string(),
		headers: z.record(z.string()),
		targetId: z.string().optional(),
	},
	async ({ processId, headers, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			const result = await setExtraHeaders(proc, headers, targetId);
			return textResult({ processId, ...result });
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"get_performance_metrics",
	"Renderer Performance.getMetrics (JS heap, layout count, task duration, …)",
	{
		processId: z.string(),
		targetId: z.string().optional(),
	},
	async ({ processId, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			const result = await getPerformanceMetrics(proc, targetId);
			return textResult({ processId, ...result });
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"start_cpu_profile",
	"Start V8 CPU profiler on a page target (pair with stop_cpu_profile)",
	{
		processId: z.string(),
		targetId: z.string().optional(),
	},
	async ({ processId, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(await startCpuProfile(proc, targetId));
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"stop_cpu_profile",
	"Stop CPU profiler and write a .cpuprofile JSON file",
	{
		processId: z.string(),
		path: z.string().optional().describe("Output path (default: OS temp)"),
	},
	async ({ processId, path: filePath }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(await stopCpuProfile(proc, filePath));
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"heap_snapshot",
	"Take a V8 heap snapshot (.heapsnapshot) for leak investigation",
	{
		processId: z.string(),
		path: z.string().optional(),
		targetId: z.string().optional(),
	},
	async ({ processId, path: filePath, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(await takeHeapSnapshot(proc, filePath, targetId));
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"main_state",
	"Electron main-process nervous system: windows, app paths, versions, metrics (requires inspectMain / node target)",
	{
		processId: z.string(),
	},
	async ({ processId }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(await getMainState(proc));
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"ipc_tap",
	"Install main-process IPC tap (ipcMain.handle wrap + webContents send/ipc-message). Requires inspectMain.",
	{
		processId: z.string(),
	},
	async ({ processId }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(await enableIpcTap(proc));
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"get_ipc_log",
	"Drain / read captured IPC entries after ipc_tap",
	{
		processId: z.string(),
		tail: z.number().int().positive().optional(),
		refreshFromMain: z.boolean().optional(),
	},
	async ({ processId, tail, refreshFromMain }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(await getIpcLog(proc, { tail, refreshFromMain }));
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"diff_screenshot",
	"Capture (or compare) a screenshot against a baseline PNG; reports identical + byte similarity",
	{
		processId: z.string(),
		baselinePath: z.string(),
		currentPath: z
			.string()
			.optional()
			.describe("Existing PNG to compare; if omitted, captures fresh"),
		selector: z.string().optional(),
		targetId: z.string().optional(),
	},
	async ({ processId, baselinePath, currentPath, selector, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(
				await diffScreenshot(proc, {
					baselinePath,
					currentPath,
					selector,
					targetId,
				}),
			);
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"get_audit_issues",
	"Buffered Chromium Audits issues (cookie/CORS/mixed-content/deprecations) captured since attach",
	{
		processId: z.string(),
		tail: z.number().int().positive().optional(),
	},
	async ({ processId, tail }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(getAuditIssues(proc, tail));
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"find_installed_apps",
	"Scan common install locations for packaged Electron apps (.app / exe / .desktop)",
	{},
	async () => {
		try {
			const apps = await findInstalledElectronApps();
			return textResult({ count: apps.length, apps });
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

// --- Creative power tools (v1.7) ---

server.tool(
	"start_coverage",
	"Start JS precise coverage (optional CSS rule usage). Pair with stop_coverage.",
	{
		processId: z.string(),
		targetId: z.string().optional(),
		css: z.boolean().optional().describe("Also track CSS rule usage"),
	},
	async ({ processId, targetId, css }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(await startCoverage(proc, { targetId, css }));
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"stop_coverage",
	"Stop coverage and return JS (and optional CSS) coverage data; optionally write JSON",
	{
		processId: z.string(),
		path: z.string().optional(),
	},
	async ({ processId, path: filePath }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(await stopCoverage(proc, filePath));
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"set_file_input",
	"Set files on an <input type=file> via DOM.setFileInputFiles (host paths)",
	{
		processId: z.string(),
		selector: z.string(),
		files: z.array(z.string()).min(1),
		targetId: z.string().optional(),
	},
	async ({ processId, selector, files, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(
				await setFileInput(proc, { selector, files, targetId }),
			);
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"emulate",
	"Device metrics / UA / geolocation / media emulation (or clear=true to reset)",
	{
		processId: z.string(),
		targetId: z.string().optional(),
		clear: z.boolean().optional(),
		metrics: z
			.object({
				width: z.number().int().positive(),
				height: z.number().int().positive(),
				deviceScaleFactor: z.number().positive().optional(),
				mobile: z.boolean().optional(),
			})
			.optional(),
		userAgent: z.string().optional(),
		geolocation: z
			.object({
				latitude: z.number(),
				longitude: z.number(),
				accuracy: z.number().optional(),
			})
			.optional(),
		media: z.string().optional().describe('e.g. "print" or "screen"'),
	},
	async ({ processId, targetId, clear, metrics, userAgent, geolocation, media }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(
				await emulate(proc, {
					targetId,
					clear,
					metrics,
					userAgent,
					geolocation,
					media,
				}),
			);
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"start_screencast",
	"Start Page.startScreencast; buffers up to maxFrames (ack frames). Pair with stop_screencast.",
	{
		processId: z.string(),
		targetId: z.string().optional(),
		maxFrames: z.number().int().positive().max(30).optional(),
		everyNthFrame: z.number().int().positive().optional(),
		format: z.enum(["png", "jpeg"]).optional(),
		quality: z.number().int().min(0).max(100).optional(),
	},
	async ({ processId, targetId, maxFrames, everyNthFrame, format, quality }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(
				await startScreencast(proc, {
					targetId,
					maxFrames,
					everyNthFrame,
					format,
					quality,
				}),
			);
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"stop_screencast",
	"Stop screencast; optionally write last frame PNG/JPEG to path",
	{
		processId: z.string(),
		path: z.string().optional(),
	},
	async ({ processId, path: filePath }) => {
		try {
			const proc = requireRunningProcess(processId);
			const result = await stopScreencast(proc, filePath);
			const { lastFrameBase64, ...rest } = result;
			if (lastFrameBase64 && !filePath) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{ ...rest, lastFrameBase64: "[see image]" },
								null,
								2,
							),
						},
						{
							type: "image" as const,
							data: lastFrameBase64,
							mimeType: "image/png",
						},
					],
				};
			}
			return textResult(rest);
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"set_breakpoint",
	"Debugger.setBreakpointByUrl (0-based lineNumber). Keep debugger enabled while BPs exist.",
	{
		processId: z.string(),
		lineNumber: z.number().int().nonnegative(),
		url: z.string().optional(),
		urlRegex: z.string().optional(),
		columnNumber: z.number().int().nonnegative().optional(),
		targetId: z.string().optional(),
	},
	async ({ processId, lineNumber, url, urlRegex, columnNumber, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(
				await setBreakpointByUrl(proc, {
					lineNumber,
					url,
					urlRegex,
					columnNumber,
					targetId,
				}),
			);
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"remove_breakpoint",
	"Debugger.removeBreakpoint by breakpointId from set_breakpoint",
	{
		processId: z.string(),
		breakpointId: z.string(),
		targetId: z.string().optional(),
	},
	async ({ processId, breakpointId, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(await removeBreakpoint(proc, breakpointId, targetId));
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"resolve_stack",
	"Resolve stack frames to source snippets (Debugger.getScriptSource / file://)",
	{
		processId: z.string(),
		frames: z
			.array(
				z.object({
					url: z.string().optional(),
					scriptId: z.string().optional(),
					lineNumber: z.number().int(),
					columnNumber: z.number().int().optional(),
					functionName: z.string().optional(),
				}),
			)
			.min(1),
		contextLines: z.number().int().nonnegative().max(20).optional(),
		targetId: z.string().optional(),
	},
	async ({ processId, frames, contextLines, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(
				await resolveStack(proc, { frames, contextLines, targetId }),
			);
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"perf_audit",
	"Lighthouse-lite: Performance.getMetrics + nav/paint timing + recent Audits issues (not full Lighthouse)",
	{
		processId: z.string(),
		targetId: z.string().optional(),
		includeAudits: z.boolean().optional(),
		includeNavTiming: z.boolean().optional(),
	},
	async ({ processId, targetId, includeAudits, includeNavTiming }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(
				await runPerfAudit(proc, { targetId, includeAudits, includeNavTiming }),
			);
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"capture_mhtml",
	"Save page as MHTML via Page.captureSnapshot",
	{
		processId: z.string(),
		path: z.string().optional(),
		targetId: z.string().optional(),
	},
	async ({ processId, path: filePath, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(await captureMhtml(proc, filePath, targetId));
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"virtual_clock",
	"Emulation.setVirtualTimePolicy — pause / advance virtual time (use budget when advancing)",
	{
		processId: z.string(),
		policy: z.enum(["pause", "advance", "pauseIfNetworkFetchesPending"]),
		budget: z.number().positive().optional().describe("Virtual ms to grant when advancing"),
		targetId: z.string().optional(),
	},
	async ({ processId, policy, budget, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(await setVirtualClock(proc, { policy, budget, targetId }));
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"webcontents_topology",
	"Map BrowserWindows / webContents (main) to CDP targets — agent topology for multi-window apps",
	{
		processId: z.string(),
	},
	async ({ processId }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(await getWebContentsTopology(proc));
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

// --- Creative power tools (v1.8) ---

server.tool(
	"click_ax",
	"Click an element by accessibility name (optional role). Uses the AX tree, not CSS.",
	{
		processId: z.string(),
		name: z.string().describe('Accessible name, e.g. "Go" or "Submit"'),
		role: z.string().optional().describe('AX role, e.g. "button" or "link"'),
		exact: z.boolean().optional().describe("Require an exact name match"),
		button: z.enum(["left", "right", "middle"]).optional(),
		targetId: z.string().optional(),
	},
	async ({ processId, name, role, exact, button, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(
				await clickByAx(proc, { name, role, exact, button, targetId }),
			);
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"type_ax",
	"Focus an element by accessibility name and insert text (optional clear)",
	{
		processId: z.string(),
		name: z.string().describe("Accessible name of the field"),
		text: z.string(),
		role: z.string().optional().describe('AX role, e.g. "textbox"'),
		exact: z.boolean().optional(),
		clear: z.boolean().optional(),
		targetId: z.string().optional(),
	},
	async ({ processId, name, text, role, exact, clear, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(
				await typeByAx(proc, { name, text, role, exact, clear, targetId }),
			);
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"network_stub",
	"Intercept matching URLs via Fetch and fulfill or fail them. Replaces a rule with the same urlPattern. Pair with clear_network_stubs.",
	{
		processId: z.string(),
		urlPattern: z
			.string()
			.describe('CDP urlPattern; * is a wildcard, e.g. "*api/users*"'),
		action: z.enum(["fulfill", "fail"]),
		status: z.number().int().min(0).max(599).optional(),
		body: z.string().optional(),
		contentType: z.string().optional(),
		headers: z.record(z.string()).optional(),
		errorReason: z
			.enum([
				"Failed",
				"Aborted",
				"TimedOut",
				"BlockedByClient",
				"NameNotResolved",
			])
			.optional(),
		targetId: z.string().optional(),
	},
	async ({
		processId,
		urlPattern,
		action,
		status,
		body,
		contentType,
		headers,
		errorReason,
		targetId,
	}) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(
				await networkStub(proc, {
					urlPattern,
					action,
					status,
					body,
					contentType,
					headers,
					errorReason,
					targetId,
				}),
			);
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"clear_network_stubs",
	"Disable Fetch interception and drop stub rules for this session",
	{
		processId: z.string(),
	},
	async ({ processId }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(await clearNetworkStubs(proc));
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"wait_network_idle",
	"Wait until no network request is in flight and the log has been quiet for idleMs",
	{
		processId: z.string(),
		idleMs: z.number().int().positive().max(10_000).optional(),
		timeoutMs: z.number().int().positive().max(30_000).optional(),
		targetId: z.string().optional(),
	},
	async ({ processId, idleMs, timeoutMs, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(
				await waitNetworkIdle(proc, { idleMs, timeoutMs, targetId }),
			);
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"export_har",
	"Write the buffered network log as HAR 1.2 JSON (method, URL, status; no bodies)",
	{
		processId: z.string(),
		path: z.string().optional(),
	},
	async ({ processId, path: filePath }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(await exportHar(proc, filePath));
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"handle_dialog",
	"Auto accept or dismiss the next JavaScript dialogs (alert/confirm/prompt). clear:true disarms.",
	{
		processId: z.string(),
		action: z.enum(["accept", "dismiss"]).optional(),
		promptText: z.string().optional().describe("Value when accepting a prompt"),
		clear: z.boolean().optional(),
		targetId: z.string().optional(),
	},
	async ({ processId, action, promptText, clear, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(
				await handleDialog(proc, { action, promptText, clear, targetId }),
			);
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"highlight",
	"Scroll a CSS selector into view and paint a CDP overlay highlight (auto-hides when durationMs > 0)",
	{
		processId: z.string(),
		selector: z.string(),
		durationMs: z.number().int().nonnegative().max(5000).optional(),
		targetId: z.string().optional(),
	},
	async ({ processId, selector, durationMs, targetId }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(
				await highlightSelector(proc, { selector, durationMs, targetId }),
			);
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"assert_ui",
	"Check url/title/text/selector/console-error budget/expression. Returns pass:false with per-check detail (does not throw on a failed check).",
	{
		processId: z.string(),
		urlIncludes: z.string().optional(),
		titleIncludes: z.string().optional(),
		textIncludes: z.string().optional(),
		selector: z.string().optional(),
		selectorHidden: z.string().optional(),
		maxConsoleErrors: z.number().int().nonnegative().optional(),
		expression: z
			.string()
			.optional()
			.describe("JS expression that must be truthy"),
		targetId: z.string().optional(),
	},
	async ({
		processId,
		urlIncludes,
		titleIncludes,
		textIncludes,
		selector,
		selectorHidden,
		maxConsoleErrors,
		expression,
		targetId,
	}) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(
				await assertUi(proc, {
					urlIncludes,
					titleIncludes,
					textIncludes,
					selector,
					selectorHidden,
					maxConsoleErrors,
					expression,
					targetId,
				}),
			);
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

server.tool(
	"open_deep_link",
	"Emit Electron open-url and second-instance (requires inspectMain). Returns the URL the app recorded and mirrors it to window.__DEEP_LINK__.",
	{
		processId: z.string(),
		url: z.string().describe("Deep link or URL to deliver"),
		channel: z
			.string()
			.optional()
			.describe("Also webContents.send(channel, url) when set"),
	},
	async ({ processId, url, channel }) => {
		try {
			const proc = requireRunningProcess(processId);
			return textResult(await openDeepLink(proc, { url, channel }));
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), true);
		}
	},
);

// --- Prompts ---

server.prompt(
	"debug_blank_window",
	"Workflow for diagnosing a blank or white Electron window",
	{
		processId: z
			.string()
			.describe("Managed process id from start_app or attach"),
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
	}),
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
	}),
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
	}),
);

server.prompt(
	"attach_and_screenshot",
	"Find or attach to an Electron app, then screenshot and collect console errors",
	{
		processId: z
			.string()
			.optional()
			.describe("Existing managed process id, if already attached"),
		debugPort: z
			.string()
			.optional()
			.describe("Known remote-debugging port to attach to, if any"),
	},
	async ({ processId, debugPort }) => {
		const hints = [
			processId ? `Known processId: ${processId}.` : null,
			debugPort ? `Known debugPort: ${debugPort}.` : null,
		]
			.filter(Boolean)
			.join(" ");
		return {
			messages: [
				{
					role: "user",
					content: {
						type: "text",
						text: `Attach to a running Electron app and capture its UI + errors.${hints ? ` ${hints}` : ""}
1. If processId is given, use list_apps / diagnose to confirm it is running; otherwise if debugPort is given, call attach with that port; else call find_apps (and discover_apps if needed) then attach or attach_by_pid.
2. Call screenshot (or save_screenshot) on a page target.
3. Call get_console_messages(level=error) and summarize any exceptions.
4. Report processId, debugPort, screenshot result, and error summary.`,
					},
				},
			],
		};
	},
);

server.prompt(
	"vision_then_act",
	"Agent loop: vision → snapshot → act → verify (screenshot/diff)",
	{
		processId: z.string(),
		goal: z
			.string()
			.describe("What the agent should accomplish in the Electron UI"),
	},
	async ({ processId, goal }) => ({
		messages: [
			{
				role: "user",
				content: {
					type: "text",
					text: `Goal: ${goal}
Process: ${processId}

Agent loop (prefer tools over guessing):
1. vision — one-shot screenshot + console errors + network failures.
2. snapshot — accessibility tree for roles/names to choose selectors.
3. Act — click_ax / type_ax by accessible name, or wait_for / click / type_text / press_key / navigate.
4. Verify — assert_ui, screenshot, or diff_screenshot; re-check get_console_messages.
5. If stuck — webcontents_topology, main_state / ipc_tap, perf_audit.
6. Summarize what changed and remaining risks.`,
				},
			},
		],
	}),
);

server.prompt(
	"ax_then_assert",
	"Agent loop: snapshot → click_ax/type_ax → assert_ui (accessibility-first)",
	{
		processId: z.string(),
		goal: z.string().describe("What the agent should accomplish in the Electron UI"),
	},
	async ({ processId, goal }) => ({
		messages: [
			{
				role: "user",
				content: {
					type: "text",
					text: `Goal: ${goal}
Process: ${processId}

Accessibility-first loop:
1. snapshot — read roles and accessible names.
2. Act with click_ax / type_ax using those names (CSS click/type_text only if AX matching fails).
3. If a fetch is involved, network_stub or wait_network_idle as needed.
4. If alert/confirm/prompt can appear, handle_dialog before the action.
5. assert_ui with the expected title, text, selector, or expression.
6. Summarize pass/fail from assert_ui checks.`,
				},
			},
		],
	}),
);

// --- Resources ---

server.resource(
	"server",
	"electron://server",
	{
		description:
			"Server identity: package version, uptime, Node/platform, capability counts",
		mimeType: "application/json",
	},
	async (uri) => ({
		contents: [
			{
				uri: uri.href,
				mimeType: "application/json",
				text: JSON.stringify(
					{
						name: "electron-debug-mcp",
						version: SERVER_VERSION,
						uptimeMs: Date.now() - startedAt,
						node: process.version,
						platform: process.platform,
						arch: process.arch,
						managedProcessCount: listProcesses().length,
						consoleLiveLogging: isConsoleLiveLoggingEnabled(),
						capabilities: {
							tools:
								"see tools/list (75 tools: lifecycle, inspect, vision/snapshot, a11y act, network stub, profiling, coverage, emulate, screencast, IPC, audits…)",
							prompts: [
								"debug_blank_window",
								"find_renderer_exception",
								"ui_smoke_check",
								"attach_and_screenshot",
								"vision_then_act",
								"ax_then_assert",
							],
							resources: [
								"electron://server",
								"electron://info",
								"electron://targets",
								"electron://process/{id}",
								"electron://logs/{id}",
								"electron://console/{id}",
								"electron://cdp/{processId}/{targetId}",
							],
						},
					},
					null,
					2,
				),
			},
		],
	}),
);

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
	}),
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
	},
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
	},
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
	},
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
	},
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
						2,
					),
				},
			],
		};
	},
);

const transport = new StdioServerTransport();
await server.connect(transport);
log.info("Electron Debug MCP Server running on stdio");
