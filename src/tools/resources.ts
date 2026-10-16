import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SERVER_VERSION, startedAt } from "../server-info.js";
import { log } from "../log.js";
import {
	getAllProcesses,
	getElectronDebugInfo,
	getProcess,
	isConsoleLiveLoggingEnabled,
	listProcesses,
	updateCDPTargets,
} from "../process-manager.js";

export function registerResources(server: McpServer) {
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
									"see tools/list (88 tools: lifecycle, inspect, hover, scroll, drag, select, permissions, clipboard, downloads, network emulation, pdf, vision/snapshot, a11y act, network stub, profiling, coverage, emulate, screencast, IPC, audits…)",
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
}
