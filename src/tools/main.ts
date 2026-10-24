import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, textResult, withProcess, requireRunningProcess } from "../tool-helpers.js";
import {
	evaluateMain,
	listTargetsByRole,
	updateCDPTargets,
} from "../process-manager.js";
import {
	enableIpcTap,
	findInstalledElectronApps,
	focusWindow,
	getIpcLog,
	getMainState,
	getWebContentsTopology,
	openDeepLink,
	readClipboard,
	setPermission,
	setWindowBounds,
	writeClipboard,
} from "../power-tools.js";

export function registerMainTools(server: McpServer) {
	registerTool(
		server,
		"evaluate_main",
		{
			description:
				"Evaluate JavaScript in the Electron main/node CDP target (use start_app with inspectMain:true for best results)",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				expression: z.string(),
				targetId: z
					.string()
					.optional()
					.describe("Optional explicit main/node target id from list_targets"),
				returnByValue: z.boolean().optional(),
			},
			annotations: { destructiveHint: false, openWorldHint: true },
		},
		withProcess(async (proc, { expression, targetId, returnByValue }) => {
			await updateCDPTargets(proc);
			const result = await evaluateMain(
				proc,
				expression,
				targetId,
				returnByValue ?? true,
			);
			return {
				processId: proc.id,
				...result,
				targets: listTargetsByRole(proc),
			};
		}),
	);

	registerTool(
		server,
		"main_state",
		{
			description:
				"Electron main-process nervous system: windows, app paths, versions, metrics (requires inspectMain / node target)",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
			},
			annotations: { readOnlyHint: true },
		},
		withProcess(async (proc) => {
			return await getMainState(proc);
		}),
	);

	registerTool(
		server,
		"ipc_tap",
		{
			description:
				"Install main-process IPC tap (ipcMain.handle wrap + webContents send/ipc-message). Requires inspectMain.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc) => {
			return await enableIpcTap(proc);
		}),
	);

	registerTool(
		server,
		"get_ipc_log",
		{
			description:
				"Drain / read captured IPC entries after ipc_tap. Requires inspectMain.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				tail: z.number().int().positive().optional(),
				refreshFromMain: z.boolean().optional(),
			},
			annotations: { readOnlyHint: true },
		},
		withProcess(async (proc, { tail, refreshFromMain }) => {
			return await getIpcLog(proc, { tail, refreshFromMain });
		}),
	);

	registerTool(
		server,
		"find_installed_apps",
		{
			description:
				"Scan common install locations for packaged Electron apps (.app / exe / .desktop)",
			annotations: { readOnlyHint: true, idempotentHint: true },
		},
		async () => {
			try {
				const apps = await findInstalledElectronApps();
				return textResult({ count: apps.length, apps });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"webcontents_topology",
		{
			description:
				"Map BrowserWindows / webContents (main) to CDP targets. Requires inspectMain.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
			},
			annotations: { readOnlyHint: true },
		},
		withProcess(async (proc) => {
			return await getWebContentsTopology(proc);
		}),
	);

	registerTool(
		server,
		"open_deep_link",
		{
			description:
				"Emit Electron open-url and second-instance (requires inspectMain). Returns the URL the app recorded and mirrors it to window.__DEEP_LINK__.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				url: z.string().describe("Deep link or URL to deliver"),
				channel: z
					.string()
					.optional()
					.describe("Also webContents.send(channel, url) when set"),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, { url, channel }) => {
			return await openDeepLink(proc, { url, channel });
		}),
	);

	registerTool(
		server,
		"focus_window",
		{
			description:
				"Bring an Electron BrowserWindow forward (show, focus, moveTop). Requires inspectMain. Omit windowId to use the first window. Pass show:false to focus without showing a hidden window.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				windowId: z
					.number()
					.int()
					.optional()
					.describe("BrowserWindow.id from webcontents_topology"),
				show: z
					.boolean()
					.optional()
					.describe("Call show() before focus. Default true."),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, { windowId, show }) => {
			return await focusWindow(proc, { windowId, show });
		}),
	);

	registerTool(
		server,
		"get_clipboard",
		{
			description:
				"Read the OS clipboard. Returns text and, when present, imageDataUrl (PNG). Requires inspectMain.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
			},
			annotations: { readOnlyHint: true },
		},
		withProcess(async (proc) => {
			return await readClipboard(proc);
		}),
	);

	registerTool(
		server,
		"set_clipboard",
		{
			description:
				"Write the OS clipboard. Pass text, imageDataUrl (a data:image/... URL), or both. Requires inspectMain.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				text: z.string().optional(),
				imageDataUrl: z
					.string()
					.optional()
					.describe("data:image/png;base64,... or another image data URL"),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, { text, imageDataUrl }) => {
			return await writeClipboard(proc, { text, imageDataUrl });
		}),
	);

	registerTool(
		server,
		"set_permission",
		{
			description:
				"Allow or deny an Electron permission and grant it to the page via Browser.grantPermissions. Returns checked, the page's Notification.permission or equivalent. Requires inspectMain. Unlisted permissions are denied after the handler is installed.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				permission: z
					.string()
					.describe('Electron permission name, e.g. "notifications", "media", "geolocation"'),
				grant: z.boolean().describe("true allows the prompt, false denies it"),
				probe: z
					.boolean()
					.optional()
					.describe("If true, query the page permission state and return it as checked"),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, { permission, grant, probe }) => {
			return await setPermission(proc, { permission, grant, probe });
		}),
	);

	registerTool(
		server,
		"set_window_bounds",
		{
			description:
				"Move or resize a BrowserWindow. Omit a field to leave it unchanged. Requires inspectMain. Does not show a hidden window.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				windowId: z.number().int().optional().describe("BrowserWindow.id from webcontents_topology"),
				x: z.number().optional(),
				y: z.number().optional(),
				width: z.number().int().positive().optional(),
				height: z.number().int().positive().optional(),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, { windowId, x, y, width, height }) => {
			return await setWindowBounds(proc, { windowId, x, y, width, height });
		}),
	);
}
