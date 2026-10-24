import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, resolveProcess, textResult } from "../tool-helpers.js";
import { SERVER_VERSION, startedAt, resolveElectronBinary } from "../server-info.js";
import {
	allocateLocalPort,
	attachByPid,
	attachToDebugPort,
	diagnoseProcess,
	discoverDebugPorts,
	findRunningElectronApps,
	isConsoleLiveLoggingEnabled,
	listProcesses,
	startElectronApp,
	stopElectronApp,
} from "../process-manager.js";

export function registerConnectTools(server: McpServer, hooks: { notifyResourceListChanged: () => Promise<void> }) {
	registerTool(
		server,
		"start_app",
		{
			description:
				'Start an Electron application with remote debugging enabled. Example: {"appPath":"D:/apps/my-electron-app","debugPort":9222}',
			params: {
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
						"If true, open a pinned --inspect port for main-process tools: evaluate_main, main_state, ipc_tap, get_ipc_log, webcontents_topology, open_deep_link, focus_window, set_window_bounds, get_clipboard, set_clipboard, get_downloads, set_permission",
					),
			},
			annotations: { destructiveHint: false, openWorldHint: true },
		},
		async ({ appPath, debugPort, extraArgs, inspectMain }) => {
			try {
				const proc = await startElectronApp(appPath, debugPort, extraArgs ?? [], {
					inspectMain: inspectMain ?? false,
				});
				await hooks.notifyResourceListChanged();
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

	registerTool(
		server,
		"attach",
		{
			description:
				'Attach to an already-running Electron/Chromium app that was started with --remote-debugging-port. Example: {"debugPort":9222}',
			params: {
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
			annotations: { destructiveHint: false, openWorldHint: true },
		},
		async ({ debugPort, name }) => {
			try {
				const proc = await attachToDebugPort(debugPort, name);
				await hooks.notifyResourceListChanged();
				return textResult({
					id: proc.id,
					name: proc.name,
					status: proc.status,
					attached: proc.attached,
					debugPort: proc.debugPort,
					inspectPort: proc.inspectPort,
					targets: proc.targets ?? [],
				});
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"attach_by_pid",
		{
			description:
				"Attach to a running Electron app by PID. Resolves the remote-debugging port from process arguments. App must have been started with --remote-debugging-port.",
			params: {
				pid: z.number().int().positive().describe("OS process ID of the Electron app"),
				name: z.string().optional().describe("Optional friendly name for this attached session"),
			},
			annotations: { destructiveHint: false, openWorldHint: true },
		},
		async ({ pid, name }) => {
			try {
				const proc = await attachByPid(pid, name);
				await hooks.notifyResourceListChanged();
				return textResult({
					id: proc.id,
					name: proc.name,
					status: proc.status,
					attached: proc.attached,
					pid: proc.pid,
					debugPort: proc.debugPort,
					inspectPort: proc.inspectPort,
					targets: proc.targets ?? [],
				});
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"find_apps",
		{
			description:
				"Scan running OS processes for Electron apps. Returns PID, command, and any detected --remote-debugging-port / --inspect ports. Use to find targets for attach or attach_by_pid.",
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async () => {
			try {
				const apps = await findRunningElectronApps();
				return textResult({ count: apps.length, apps });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"discover_apps",
		{
			description:
				"Scan a local port range (default: 9222-9235) for reachable Chrome DevTools Protocol endpoints. Useful when an app was started with an unknown debug port.",
			params: {
				startPort: z.number().int().positive().optional(),
				endPort: z.number().int().positive().optional(),
			},
			annotations: { readOnlyHint: true, idempotentHint: true },
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

	registerTool(
		server,
		"stop_app",
		{
			description:
				"Stop a process started by start_app, or detach bookkeeping for an attached session",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process id returned by start_app or attach. If omitted, uses the single running app."),
			},
			annotations: { destructiveHint: true },
		},
		async ({ processId }) => {
			try {
				const resolvedId = processId ?? resolveProcess().id;
				const stopped = await stopElectronApp(resolvedId);
				if (!stopped) {
					return textResult(`Process not found: ${resolvedId}`, true);
				}
				await hooks.notifyResourceListChanged();
				return textResult({ processId: resolvedId, status: "stopped" });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"list_apps",
		{
			description: "List Electron applications managed or attached by this server",
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async () => textResult({ processes: listProcesses() }),
	);

	registerTool(
		server,
		"diagnose",
		{
			description:
				"Summarize process health: debug port reachability, target roles (page/worker/browser), recent console errors, and discovered local debug ports",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Optional process id; omit to diagnose all managed processes"),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ processId }) => {
			try {
				return textResult(await diagnoseProcess(processId));
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"doctor",
		{
			description:
				"Local environment health check: package/node/platform, Electron binary, env flags, managed process count, optional free-port sample (localhost bind only)",
			params: {
				sampleFreePort: z
					.boolean()
					.optional()
					.describe(
						"If true (default), allocate a free 127.0.0.1 port sample via bind; no remote network",
					),
			},
			annotations: { readOnlyHint: true, idempotentHint: true },
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
}
