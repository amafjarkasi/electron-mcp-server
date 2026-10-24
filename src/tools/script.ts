import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, textResult } from "../tool-helpers.js";
import { runScriptEngine, type ScriptStep } from "../script-runner.js";

const StepExpectSchema = z.object({
	status: z.enum(["success", "error"]).optional(),
	contains: z.string().optional(),
	equals: z.object({
		path: z.string(),
		value: z.unknown(),
	}).optional(),
	js: z.string().optional().describe("JavaScript predicate expression evaluated with argument 'result'"),
}).optional();

const StepRetrySchema = z.object({
	maxAttempts: z.number().int().positive().max(10),
	delayMs: z.number().nonnegative().optional(),
	backoff: z.number().positive().optional(),
}).optional();

const ScriptStepSchema = z.object({
	name: z.string().optional().describe("Human readable label for this step"),
	tool: z.string().describe("MCP tool name to invoke (e.g. 'click_ax', 'type_text', 'assert_ui', 'wait_for')"),
	args: z.record(z.unknown()).optional().describe("Arguments to pass to the tool. Supports {{vars.x}}, {{steps[0].result.x}}, and {{secret:KEY}} templating."),
	assign: z.string().optional().describe("Variable name to store this step's output into for subsequent steps"),
	if: z.string().optional().describe("Conditional expression; step is skipped if falsy"),
	expect: StepExpectSchema,
	retry: StepRetrySchema,
	timeoutMs: z.number().positive().optional(),
	delayBeforeMs: z.number().nonnegative().optional(),
	delayAfterMs: z.number().nonnegative().optional(),
	onError: z.enum(["abort", "continue"]).optional().describe("Whether to abort or continue script on step failure (default: abort)"),
});

export function registerScriptTools(server: McpServer) {
	registerTool(
		server,
		"run_script",
		{
			description:
				"Advanced server-side step runner & workflow engine: executes an array of tool steps sequentially with templating ({{vars.x}}, {{steps[0].result.x}}, {{secret:KEY}}), conditional branching (if), assertions (expect), automatic retries, diagnostic failure screenshots, and optional export to Playwright test specs.",
			params: {
				script: z.union([
					z.array(ScriptStepSchema),
					z.string().describe("JSON array of steps or path to a .json script file on disk"),
				]).describe("Array of steps or path/JSON string to execute"),
				variables: z.record(z.unknown()).optional().describe("Initial variables map for {{vars.name}} interpolation"),
				processId: z.string().optional().describe("Target process ID. If omitted, uses the single running app."),
				stopOnFirstError: z.boolean().optional().describe("Whether to halt script execution upon first step failure (default: true)"),
				captureFailureArtifacts: z.boolean().optional().describe("Whether to automatically capture screenshot artifacts and diagnostic logs on step failure (default: true)"),
				exportAs: z.enum(["playwright", "json"]).optional().describe("Export the executed steps as executable Playwright test code or JSON recipe"),
				exportPath: z.string().optional().describe("Optional file path on disk to save the exported test or JSON recipe"),
			},
			annotations: { destructiveHint: false },
		},
		async ({ script, variables, processId, stopOnFirstError, captureFailureArtifacts, exportAs, exportPath }) => {
			try {
				const report = await runScriptEngine(server, {
					script: script as ScriptStep[] | string,
					variables,
					processId,
					stopOnFirstError,
					captureFailureArtifacts,
					exportAs,
					exportPath,
				});
				return textResult(report);
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);
}
