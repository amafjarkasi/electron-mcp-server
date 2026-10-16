import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { textResult } from "../tool-helpers.js";
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
					"If true, open a pinned --inspect port for main-process tools: evaluate_main, main_state, ipc_tap, get_ipc_log, webcontents_topology, open_deep_link, focus_window, set_window_bounds, get_clipboard, set_clipboard, get_downloads, set_permission",
				),
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
				await hooks.notifyResourceListChanged();
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
				await hooks.notifyResourceListChanged();
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
				await hooks.notifyResourceListChanged();
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
}
