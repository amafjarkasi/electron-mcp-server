import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPrompts(server: McpServer) {
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
1. Call vision for a screenshot plus console errors and network failures.
2. Call get_console_messages (level=error), get_audit_issues, and get_logs.
3. Call snapshot if the accessibility tree explains an empty shell.
4. Call get_dom / query_selector only if you still need raw markup.
5. Summarize likely causes (renderer crash, failed load URL, CSP, route error) and next fixes.`,
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
1. Call vision, then get_console_messages (level=error).
2. If the buffer is empty, reproduce the bug and call get_console_messages again.
3. Use get_network_log and get_response_body for failed requests.
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
1. vision to see the window, console errors, and failed requests.
2. wait_for selector=${selector}.
3. If selector is an input, type_text a sample value; if a button, click or click_ax it. Use hover or drag when the control needs them.
4. assert_ui for the expected text or selector. screenshot only if the assertion is unclear.
5. get_console_messages(level=error) and summarize pass/fail.`,
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
2. Call vision on a page target.
3. Call get_console_messages(level=error) and summarize any exceptions.
4. Report processId, debugPort, what the window shows, and the error summary.`,
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
}
