import fs from "fs";
import path from "path";

async function generate() {
	const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
	const { zodToJsonSchema } = await import("zod-to-json-schema");
	const server = new McpServer({ name: "test", version: "1.0.0" });
	const c = await import("../build/tools/connect.js");
	const p = await import("../build/tools/page.js");
	const n = await import("../build/tools/network.js");
	const prof = await import("../build/tools/profile.js");
	const m = await import("../build/tools/main.js");
	const s = await import("../build/tools/script.js");

	c.registerConnectTools(server, { notifyResourceListChanged: async () => {} });
	p.registerPageTools(server);
	n.registerNetworkTools(server);
	prof.registerProfileTools(server);
	m.registerMainTools(server);
	s.registerScriptTools(server);

	const categories = [
		{
			title: "1. Application Lifecycle & Process Discovery",
			tools: [
				"start_app",
				"attach",
				"attach_by_pid",
				"find_apps",
				"discover_apps",
				"stop_app",
				"list_apps",
				"diagnose",
				"doctor",
				"get_logs",
				"clear_buffers",
			],
		},
		{
			title: "2. Page & DOM Inspection",
			tools: [
				"list_targets",
				"page_info",
				"get_dom",
				"query_selector",
				"navigate",
				"reload",
				"pause",
				"resume",
				"cdp_command",
				"evaluate",
				"snapshot",
			],
		},
		{
			title: "3. Input, Mouse & Keyboard Interaction",
			tools: [
				"click",
				"hover",
				"scroll",
				"drag",
				"type_text",
				"press_key",
				"select_option",
				"set_file_input",
				"click_ax",
				"type_ax",
				"handle_dialog",
			],
		},
		{
			title: "4. Visual & Accessibility Intelligence",
			tools: [
				"screenshot",
				"save_screenshot",
				"vision",
				"highlight",
				"diff_screenshot",
				"start_screencast",
				"stop_screencast",
				"print_pdf",
				"capture_mhtml",
			],
		},
		{
			title: "5. Console, Debugging & Source Maps",
			tools: [
				"get_console_messages",
				"set_console_live",
				"set_breakpoint",
				"remove_breakpoint",
				"resolve_stack",
				"get_audit_issues",
				"virtual_clock",
			],
		},
		{
			title: "6. State, Cookies & Storage Management",
			tools: [
				"get_cookies",
				"set_cookie",
				"delete_cookie",
				"get_storage",
				"set_storage",
				"save_storage_state",
				"load_storage_state",
			],
		},
		{
			title: "7. Network Monitoring, Interception & Chaos",
			tools: [
				"get_network_log",
				"get_response_body",
				"block_urls",
				"set_extra_headers",
				"network_stub",
				"clear_network_stubs",
				"wait_network_idle",
				"export_har",
				"emulate_network",
				"get_downloads",
				"network_failure_report",
			],
		},
		{
			title: "8. Performance, Profiling & Memory",
			tools: [
				"start_tracing",
				"stop_tracing",
				"get_performance_metrics",
				"start_cpu_profile",
				"stop_cpu_profile",
				"heap_snapshot",
				"start_coverage",
				"stop_coverage",
				"perf_audit",
			],
		},
		{
			title: "9. Main Process, Windowing & Native OS API",
			tools: [
				"evaluate_main",
				"main_state",
				"find_installed_apps",
				"webcontents_topology",
				"open_deep_link",
				"focus_window",
				"get_clipboard",
				"set_clipboard",
				"set_permission",
				"set_window_bounds",
				"get_application_menu",
				"click_menu_item",
				"trigger_shortcut",
				"get_process_health",
			],
		},
		{
			title: "10. IPC Inspection, Mocking & Security",
			tools: [
				"ipc_tap",
				"get_ipc_log",
				"ipc_invoke",
				"ipc_schema_inference",
				"mock_electron_api",
				"get_mock_calls",
				"restore_electron_mocks",
				"electron_security_audit",
			],
		},
		{
			title: "11. Composite Workflows & Automation Engine",
			tools: [
				"wait_for",
				"emulate",
				"perf_snapshot",
				"leak_check",
				"assert_ui",
				"act_and_verify",
				"triage",
				"fill_form",
				"responsive_theme_matrix",
				"offline_resilience_check",
				"ipc_fuzz_and_verify",
				"repro_bundle",
				"run_script",
			],
		},
	];

	// Realistic sample values tailored to the Electron MCP domain
	const sampleValue = (key, prop, toolName) => {
		if (prop.default !== undefined) return prop.default;
		if (prop.enum && prop.enum.length > 0) return prop.enum[0];

		const lower = key.toLowerCase();
		if (prop.type === "string") {
			if (lower === "selector") return "button#submit-btn";
			if (lower === "fromselector") return "div.draggable-card[data-id='101']";
			if (lower === "toselector") return "div.dropzone-lane";
			if (lower === "ref") return "e12";
			if (lower === "role") return "button";
			if (lower === "name") return "Submit";
			if (lower === "text") return "jane.doe@example.com";
			if (lower === "key") return "Enter";
			if (lower === "url") return "https://internal.app/dashboard";
			if (lower === "urlpattern") return "**/api/v1/telemetry/**";
			if (lower === "pattern") return "error|failed";
			if (lower === "path") return "./fixtures/auth-state.json";
			if (lower === "outputpath") return "./artifacts/capture.png";
			if (lower === "baselinepath") return "./baselines/login.png";
			if (lower === "candidatepath") return "./artifacts/login-current.png";
			if (lower === "diffoutputpath") return "./artifacts/diff-result.png";
			if (lower === "scriptpath" || lower === "filepath") return "./fixtures/sample.json";
			if (lower === "apppath") return "D:/repos/my-electron-app";
			if (lower === "expression") return "process.versions.electron";
			if (lower === "method") return "Network.clearBrowserCache";
			if (lower === "channel") return "app:get-user-settings";
			if (lower === "api") return "dialog.showOpenDialog";
			if (lower === "accelerator") return "CommandOrControl+Shift+P";
			if (lower === "color") return "rgba(255, 0, 0, 0.4)";
			if (lower === "action") return "click";
			if (lower === "theme") return "dark";
			if (lower === "mode") return "network-idle";
			return "example-" + key;
		}

		if (prop.type === "number" || prop.type === "integer") {
			if (lower.includes("port")) return 9222;
			if (lower.includes("timeout") || lower.includes("delay") || lower.includes("wait") || lower.includes("ms")) return 5000;
			if (lower.includes("width")) return 1280;
			if (lower.includes("height")) return 800;
			if (lower.includes("pid")) return 14820;
			if (lower.includes("limit") || lower.includes("count")) return 25;
			if (lower.includes("x") || lower.includes("y")) return 150;
			if (lower.includes("index")) return 0;
			if (lower.includes("deltax")) return 0;
			if (lower.includes("deltay")) return 200;
			return 1;
		}

		if (prop.type === "boolean") {
			if (lower.includes("clean") || lower.includes("clear") || lower.includes("full") || lower.includes("wait")) return true;
			return true;
		}

		if (prop.type === "array") {
			if (lower === "files") return ["./artifacts/upload-document.pdf"];
			if (lower === "urls") return ["*analytics*", "*doubleclick.net*"];
			if (lower === "themes") return ["light", "dark"];
			if (lower === "viewports") return [{ width: 1280, height: 800 }, { width: 800, height: 600 }];
			if (lower === "cookies") return [{ name: "session_id", value: "tok_secure_8912", domain: "localhost", path: "/" }];
			if (lower === "stubs") return [{ urlPattern: "**/api/user", statusCode: 200, body: JSON.stringify({ name: "Demo User" }) }];
			if (lower === "fields") return [{ field: "Username", value: "admin" }, { field: "Password", value: "{{secret:APP_PWD}}" }];
			if (lower === "steps") return [{ tool: "page_info" }, { tool: "snapshot" }];
			return ["example_item"];
		}

		if (prop.type === "object") {
			if (toolName === "fill_form" && lower === "fields") return { "Username": "admin@desktop.org", "Agree to terms": true };
			if (lower === "variables" || lower === "vars") return { "env": "staging", "retries": 3 };
			if (lower === "params" || lower === "args") return { "paramKey": "paramVal" };
			if (lower === "headers") return { "X-Test-Suite": "Electron-E2E", "Authorization": "Bearer tok_123" };
			if (lower === "state") return { cookies: [], origins: [] };
			return {};
		}

		return "sample-value";
	};

	let md = `# Electron Debug MCP — Complete All-111-Tools Catalog & Reference\n\n`;
	md += `This reference catalog provides concrete documentation and working invocation examples for **all 111 tools** in \`electron-debug-mcp\`.\n\n`;
	md += `Total Tools: **111** · Categories: **11** · Resources: **9** · Prompts: **6**\n\n`;
	md += `## Table of Contents\n\n`;

	for (const cat of categories) {
		const anchor = cat.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
		md += `- [${cat.title}](#${anchor}) (${cat.tools.length} tools)\n`;
	}
	md += `\n---\n\n`;

	let toolCounter = 0;
	for (const cat of categories) {
		md += `## ${cat.title}\n\n`;

		for (const toolName of cat.tools) {
			toolCounter++;
			const t = server._registeredTools[toolName];
			if (!t) {
				console.error(`Tool not found: ${toolName}`);
				continue;
			}

			const schema = t.inputSchema ? zodToJsonSchema(t.inputSchema) : {};
			const props = schema.properties || {};
			const required = schema.required || [];

			// Build sample invocation arguments
			const exampleArgs = {};
			for (const [k, v] of Object.entries(props)) {
				// keep optional processId/targetId omitted or minimal for cleaner readability unless required
				if (!required.includes(k) && (k === "processId" || k === "targetId")) continue;
				exampleArgs[k] = sampleValue(k, v, toolName);
			}

			md += `### ${toolCounter}. \`${toolName}\`\n\n`;
			md += `**Description**: ${t.description || "No description provided."}\n\n`;

			if (Object.keys(props).length > 0) {
				md += `**Parameters**:\n\n`;
				md += `| Parameter | Type | Required | Description |\n`;
				md += `|-----------|------|:--------:|-------------|\n`;
				for (const [k, v] of Object.entries(props)) {
					const isReq = required.includes(k) ? "**Yes**" : "No";
					const type = v.type ? `\`${v.type}\`` : (v.enum ? `\`enum\` (${v.enum.join(", ")})` : "`any`");
					const desc = (v.description || "—").replace(/\|/g, "\\|").replace(/\n/g, " ");
					md += `| \`${k}\` | ${type} | ${isReq} | ${desc} |\n`;
				}
				md += "\n";
			} else {
				md += `*This tool takes no parameters (operates on the active/default session).*\n\n`;
			}

			md += `**Example Invocation**:\n\n`;
			md += "```json\n";
			md += JSON.stringify({
				name: toolName,
				arguments: exampleArgs,
			}, null, 2);
			md += "\n```\n\n";
			md += "---\n\n";
		}
	}

	fs.writeFileSync("examples/all-tools-reference.md", md, "utf8");
	console.log(`Generated examples/all-tools-reference.md with ${toolCounter} tools!`);
}

generate().catch((err) => {
	console.error(err);
	process.exit(1);
});
