import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { textResult, requireRunningProcess } from "../tool-helpers.js";
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
		"Drain / read captured IPC entries after ipc_tap. Requires inspectMain.",
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

	server.tool(
		"webcontents_topology",
		"Map BrowserWindows / webContents (main) to CDP targets. Requires inspectMain.",
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

	server.tool(
		"focus_window",
		"Bring an Electron BrowserWindow forward (show, focus, moveTop). Requires inspectMain. Omit windowId to use the first window. Pass show:false to focus without showing a hidden window.",
		{
			processId: z.string(),
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
		async ({ processId, windowId, show }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(await focusWindow(proc, { windowId, show }));
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"get_clipboard",
		"Read the OS clipboard. Returns text and, when present, imageDataUrl (PNG). Requires inspectMain.",
		{ processId: z.string() },
		async ({ processId }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(await readClipboard(proc));
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"set_clipboard",
		"Write the OS clipboard. Pass text, imageDataUrl (a data:image/... URL), or both. Requires inspectMain.",
		{
			processId: z.string(),
			text: z.string().optional(),
			imageDataUrl: z
				.string()
				.optional()
				.describe("data:image/png;base64,... or another image data URL"),
		},
		async ({ processId, text, imageDataUrl }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(await writeClipboard(proc, { text, imageDataUrl }));
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"set_permission",
		"Allow or deny an Electron permission and grant it to the page via Browser.grantPermissions. Returns checked, the page's Notification.permission or equivalent. Requires inspectMain. Unlisted permissions are denied after the handler is installed.",
		{
			processId: z.string(),
			permission: z
				.string()
				.describe('Electron permission name, e.g. "notifications", "media", "geolocation"'),
			grant: z.boolean().describe("true allows the prompt, false denies it"),
			probe: z
				.boolean()
				.optional()
				.describe("If true, query the page permission state and return it as checked"),
		},
		async ({ processId, permission, grant, probe }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(await setPermission(proc, { permission, grant, probe }));
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"set_window_bounds",
		"Move or resize a BrowserWindow. Omit a field to leave it unchanged. Requires inspectMain. Does not show a hidden window.",
		{
			processId: z.string(),
			windowId: z.number().int().optional().describe("BrowserWindow.id from webcontents_topology"),
			x: z.number().optional(),
			y: z.number().optional(),
			width: z.number().int().positive().optional(),
			height: z.number().int().positive().optional(),
		},
		async ({ processId, windowId, x, y, width, height }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(await setWindowBounds(proc, { windowId, x, y, width, height }));
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);
}
