#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { processEvents } from "./events.js";
import { log } from "./log.js";
import { isConsoleLiveLoggingEnabled } from "./process-manager.js";
import { SERVER_VERSION } from "./server-info.js";
import { registerConnectTools } from "./tools/connect.js";
import { registerMainTools } from "./tools/main.js";
import { registerNetworkTools } from "./tools/network.js";
import { registerPageTools } from "./tools/page.js";
import { registerProfileTools } from "./tools/profile.js";
import { registerScriptTools } from "./tools/script.js";
import { registerPrompts } from "./tools/prompts.js";
import { registerResources } from "./tools/resources.js";

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
			"Preferred workflow: start_app (inspectMain:true if you will touch main) or find_apps/attach → vision or snapshot → get_console_messages(level=error) → wait_for → click_ax/type_ax or click/hover/type_text → assert_ui.",
			"vision is the one-shot look (screenshot, page, console errors, network failures). snapshot is the accessibility tree. Use click_ax/type_ax when you have an accessible name; use CSS click/hover/drag/scroll/type_text otherwise.",
			"assert_ui returns pass:false with per-check detail. That is a failed check, not a tool error.",
			"For a failed request use get_network_log, then get_response_body with a finished requestId. network_stub fulfills or fails a urlPattern (* wildcard). export_har has no bodies.",
			"inspectMain on start_app opens a pinned --inspect port. These tools need it: evaluate_main, main_state, ipc_tap, get_ipc_log, webcontents_topology, open_deep_link, focus_window, set_window_bounds, get_clipboard, set_clipboard, get_downloads, set_permission.",
			"emulate_network sets offline, latency, and throughput. select_option sets a <select> by value or label. print_pdf writes the page to a PDF.",
			"get_downloads must be called before the download (or pass url to start one). It returns savePath. delete_cookie removes a cookie set with set_cookie. file:// pages need an http(s) url or domain for cookies.",
			"screenshot/save_screenshot accept selector to clip an element. resume after pause or later screenshots fail. stop_app kills an owned app and only detaches an attached one, then drops the processId.",
			"Read electron://server for package version, uptime, and capability counts without calling a tool.",
			"Read electron://artifacts for exported screenshots, traces, heap snapshots, and HAR files.",
		].join(" "),
	},
);

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

processEvents.onEvent((event) => {
	if (event.type === "console") {
		const isError = event.level === "error" || event.level === "assert";
		if (isError || isConsoleLiveLoggingEnabled()) {
			void notifyLog(
				isError
					? "error"
					: event.level === "warning" || event.level === "warn"
						? "warning"
						: "info",
				`[${event.processId}/${event.targetId}] ${event.level}: ${event.text}`,
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

registerConnectTools(server, { notifyResourceListChanged });
registerPageTools(server);
registerNetworkTools(server);
registerProfileTools(server);
registerMainTools(server);
registerScriptTools(server);
registerPrompts(server);
registerResources(server);

// Hook tools/list to pass through tool annotations
server.server.setRequestHandler(ListToolsRequestSchema, () => {
	const registered = (server as any)._registeredTools ?? {};
	return {
		tools: Object.entries(registered).map(([name, tool]: [string, any]) => ({
			name,
			description: tool.description,
			inputSchema: tool.inputSchema
				? zodToJsonSchema(tool.inputSchema, { strictUnions: true })
				: { type: "object" },
			...(tool.annotations ? { annotations: tool.annotations } : {}),
		})),
	};
});

const transport = new StdioServerTransport();
await server.connect(transport);
log.info("Electron Debug MCP Server running on stdio");
