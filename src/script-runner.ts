import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerArtifact } from "./artifacts.js";
import { resolveProcess } from "./tool-helpers.js";
import {
	type ElectronProcess,
	saveScreenshot,
} from "./process-manager.js";

export interface StepExpectation {
	status?: "success" | "error";
	contains?: string;
	equals?: { path: string; value: unknown };
	js?: string;
}

export interface StepRetryConfig {
	maxAttempts: number;
	delayMs?: number;
	backoff?: number;
}

export interface ScriptStep {
	name?: string;
	tool: string;
	args?: Record<string, unknown>;
	assign?: string;
	if?: string;
	expect?: StepExpectation;
	retry?: StepRetryConfig;
	timeoutMs?: number;
	delayBeforeMs?: number;
	delayAfterMs?: number;
	onError?: "abort" | "continue";
}

export interface StepExecutionResult {
	index: number;
	name?: string;
	tool: string;
	args: Record<string, unknown>;
	status: "passed" | "failed" | "skipped";
	durationMs: number;
	result?: unknown;
	error?: string;
	failureScreenshotUri?: string;
	diagnostics?: {
		consoleErrors?: unknown[];
		networkFailures?: unknown[];
	};
}

export interface ScriptExecutionReport {
	success: boolean;
	totalSteps: number;
	passedSteps: number;
	failedSteps: number;
	skippedSteps: number;
	durationMs: number;
	vars: Record<string, unknown>;
	timeline: StepExecutionResult[];
	exportedCode?: string;
	exportedPath?: string;
}

export function getByPath(obj: unknown, pathStr: string): unknown {
	if (obj == null) return undefined;
	const parts = pathStr.replace(/\[(\w+)\]/g, ".$1").split(".").filter(Boolean);
	let current: any = obj;
	for (const part of parts) {
		if (current == null) return undefined;
		current = current[part];
	}
	return current;
}

export function interpolateVariables(
	val: unknown,
	ctx: {
		vars: Record<string, unknown>;
		steps: StepExecutionResult[];
		env: Record<string, string | undefined>;
	},
	onSecret?: (secret: string) => void,
): unknown {
	if (typeof val === "string") {
		const exact = val.match(/^\{\{([^{}]+)\}\}$/);
		if (exact) {
			const expr = exact[1].trim();
			if (expr.startsWith("secret:")) {
				const s = ctx.env[expr.slice(7)];
				if (s !== undefined && onSecret) onSecret(s);
				return s;
			}
			if (expr.startsWith("vars.")) return getByPath(ctx.vars, expr.slice(5));
			if (expr.startsWith("steps[")) return getByPath(ctx.steps, expr.slice(5));
			if (expr.startsWith("env.")) return ctx.env[expr.slice(4)];
		}
		return val.replace(/\{\{([^{}]+)\}\}/g, (_, exprRaw) => {
			const expr = exprRaw.trim();
			if (expr.startsWith("secret:")) {
				const s = ctx.env[expr.slice(7)] || "";
				if (s && onSecret) onSecret(s);
				return s;
			}
			if (expr.startsWith("vars.")) return String(getByPath(ctx.vars, expr.slice(5)) ?? "");
			if (expr.startsWith("steps[")) return String(getByPath(ctx.steps, expr.slice(5)) ?? "");
			if (expr.startsWith("env.")) return ctx.env[expr.slice(4)] ?? "";
			return "";
		});
	}
	if (Array.isArray(val)) {
		return val.map((item) => interpolateVariables(item, ctx, onSecret));
	}
	if (val && typeof val === "object") {
		const res: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(val)) {
			res[k] = interpolateVariables(v, ctx, onSecret);
		}
		return res;
	}
	return val;
}

export function evaluateCondition(
	condition: string,
	ctx: { vars: Record<string, unknown>; steps: StepExecutionResult[] },
): boolean {
	try {
		// First check simple boolean or truthy string
		const trimmed = condition.trim();
		if (trimmed === "true") return true;
		if (trimmed === "false") return false;
		if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) {
			const interpolated = interpolateVariables(trimmed, { ...ctx, env: process.env });
			return Boolean(interpolated);
		}
		// Safe predicate evaluator with limited scope
		const fn = new Function("vars", "steps", `return Boolean(${condition});`);
		return Boolean(fn(ctx.vars, ctx.steps));
	} catch {
		return false;
	}
}

export function evaluateExpectation(
	expectConfig: StepExpectation,
	rawOutput: unknown,
	isError: boolean,
): { pass: boolean; error?: string } {
	if (expectConfig.status) {
		const expectedError = expectConfig.status === "error";
		if (isError !== expectedError) {
			return {
				pass: false,
				error: `Expected status "${expectConfig.status}", but step finished with ${isError ? "error" : "success"}`,
			};
		}
	}

	if (expectConfig.contains) {
		const str = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);
		if (!str.includes(expectConfig.contains)) {
			return {
				pass: false,
				error: `Output does not contain expected substring "${expectConfig.contains}"`,
			};
		}
	}

	if (expectConfig.equals) {
		const actual = getByPath(rawOutput, expectConfig.equals.path);
		if (actual !== expectConfig.equals.value) {
			return {
				pass: false,
				error: `Expected path "${expectConfig.equals.path}" to equal ${JSON.stringify(expectConfig.equals.value)}, got ${JSON.stringify(actual)}`,
			};
		}
	}

	if (expectConfig.js) {
		try {
			const fn = new Function("result", `return Boolean(${expectConfig.js});`);
			const passed = Boolean(fn(rawOutput));
			if (!passed) {
				return {
					pass: false,
					error: `JavaScript expectation expression failed: ${expectConfig.js}`,
				};
			}
		} catch (err) {
			return {
				pass: false,
				error: `Error evaluating expectation JS (${expectConfig.js}): ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	return { pass: true };
}

export function generatePlaywrightCode(steps: ScriptStep[], appPath = "."): string {
	const codeLines: string[] = [
		`import { test, expect, _electron as electron } from "@playwright/test";`,
		``,
		`test("automated electron workflow generated by electron-debug-mcp", async () => {`,
		`  const electronApp = await electron.launch({`,
		`    args: [${JSON.stringify(appPath)}],`,
		`  });`,
		`  const page = await electronApp.firstWindow();`,
		``,
	];

	for (let i = 0; i < steps.length; i++) {
		const s = steps[i];
		const args = s.args || {};
		const label = s.name ? `// [${i + 1}] ${s.name}` : `// [${i + 1}] ${s.tool}`;
		codeLines.push(`  ${label}`);

		switch (s.tool) {
			case "navigate":
				codeLines.push(`  await page.goto(${JSON.stringify(args.url || "")});`);
				break;
			case "click":
				codeLines.push(`  await page.locator(${JSON.stringify(args.selector || "")}).click();`);
				break;
			case "click_ax":
				if (args.role) {
					codeLines.push(`  await page.getByRole(${JSON.stringify(args.role)}, { name: ${JSON.stringify(args.name || "")} }).click();`);
				} else {
					codeLines.push(`  await page.getByRole("button", { name: ${JSON.stringify(args.name || "")} }).click();`);
				}
				break;
			case "type_text":
				if (args.clear) {
					codeLines.push(`  await page.locator(${JSON.stringify(args.selector || "")}).fill(${JSON.stringify(args.text || "")});`);
				} else {
					codeLines.push(`  await page.locator(${JSON.stringify(args.selector || "")}).pressSequentially(${JSON.stringify(args.text || "")});`);
				}
				if (args.pressEnter) {
					codeLines.push(`  await page.keyboard.press("Enter");`);
				}
				break;
			case "type_ax":
				codeLines.push(`  await page.getByRole("textbox", { name: ${JSON.stringify(args.name || "")} }).fill(${JSON.stringify(args.text || "")});`);
				break;
			case "press_key":
				codeLines.push(`  await page.keyboard.press(${JSON.stringify(args.key || "")});`);
				break;
			case "hover":
				codeLines.push(`  await page.locator(${JSON.stringify(args.selector || "")}).hover();`);
				break;
			case "select_option":
				codeLines.push(`  await page.locator(${JSON.stringify(args.selector || "")}).selectOption(${JSON.stringify(args.value || args.label || "")});`);
				break;
			case "wait_for":
				if (args.selector) {
					codeLines.push(`  await page.locator(${JSON.stringify(args.selector)}).waitFor({ state: "visible" });`);
				} else {
					codeLines.push(`  await page.waitForTimeout(1000);`);
				}
				break;
			case "assert_ui":
				if (args.selector) {
					codeLines.push(`  await expect(page.locator(${JSON.stringify(args.selector)})).toBeVisible();`);
				}
				if (args.textIncludes) {
					codeLines.push(`  await expect(page.locator("body")).toContainText(${JSON.stringify(args.textIncludes)});`);
				}
				if (args.titleIncludes) {
					codeLines.push(`  await expect(page).toHaveTitle(new RegExp(${JSON.stringify(args.titleIncludes)}));`);
				}
				if (args.urlIncludes) {
					codeLines.push(`  await expect(page).toHaveURL(new RegExp(${JSON.stringify(args.urlIncludes)}));`);
				}
				break;
			case "save_screenshot":
				codeLines.push(`  await page.screenshot({ path: ${JSON.stringify(args.path || "screenshot.png")} });`);
				break;
			case "evaluate":
				codeLines.push(`  await page.evaluate(${JSON.stringify(args.expression || "")});`);
				break;
			case "evaluate_main":
				codeLines.push(`  await electronApp.evaluate(async () => { ${args.expression || ""} });`);
				break;
			default:
				codeLines.push(`  // MCP tool "${s.tool}" without direct Playwright translation`);
				break;
		}
		codeLines.push(``);
	}

	codeLines.push(`  await electronApp.close();`);
	codeLines.push(`});`);
	return codeLines.join("\n");
}

export async function runScriptEngine(
	server: McpServer,
	options: {
		script: ScriptStep[] | string;
		variables?: Record<string, unknown>;
		processId?: string;
		stopOnFirstError?: boolean;
		captureFailureArtifacts?: boolean;
		exportAs?: "playwright" | "json";
		exportPath?: string;
	},
): Promise<ScriptExecutionReport> {
	let steps: ScriptStep[] = [];
	if (typeof options.script === "string") {
		const trimmed = options.script.trim();
		if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
			const parsed = JSON.parse(trimmed);
			steps = Array.isArray(parsed) ? parsed : (parsed.steps || []);
		} else if (fs.existsSync(trimmed)) {
			const fileContent = fs.readFileSync(trimmed, "utf8");
			const parsed = JSON.parse(fileContent);
			steps = Array.isArray(parsed) ? parsed : (parsed.steps || []);
		} else {
			throw new Error(`Invalid script: expected JSON array or existing file path, got "${trimmed}"`);
		}
	} else if (Array.isArray(options.script)) {
		steps = options.script;
	} else {
		throw new Error("Invalid script: steps array required");
	}

	const context = {
		vars: { ...(options.variables || {}) },
		steps: [] as StepExecutionResult[],
		env: process.env,
	};

	const startTime = Date.now();
	let passedSteps = 0;
	let failedSteps = 0;
	let skippedSteps = 0;
	let scriptSuccess = true;
	const stopOnError = options.stopOnFirstError !== false;
	const captureArtifacts = options.captureFailureArtifacts !== false;

	// Resolve running process for failure screenshot capture if available
	let proc: ElectronProcess | undefined;
	try {
		proc = resolveProcess(options.processId);
	} catch { /* may be started within script */ }

	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		const stepStart = Date.now();

		// Check condition
		if (step.if) {
			const shouldRun = evaluateCondition(step.if, context);
			if (!shouldRun) {
				const skipResult: StepExecutionResult = {
					index: i,
					name: step.name,
					tool: step.tool,
					args: step.args || {},
					status: "skipped",
					durationMs: 0,
				};
				context.steps.push(skipResult);
				skippedSteps++;
				continue;
			}
		}

		if (step.delayBeforeMs && step.delayBeforeMs > 0) {
			await new Promise((r) => setTimeout(r, step.delayBeforeMs));
		}

		// Interpolate arguments with context
		const rawArgs = { ...(step.args || {}) };
		if (options.processId && rawArgs.processId === undefined) {
			rawArgs.processId = options.processId;
		}

		const interpolatedArgs = interpolateVariables(rawArgs, context, (secret) => {
			if (proc?.redactedSecrets) proc.redactedSecrets.add(secret);
		}) as Record<string, unknown>;

		const toolName = step.tool;
		const toolRecord = (server as any)._registeredTools?.[toolName];
		if (!toolRecord || typeof toolRecord.callback !== "function") {
			const errorMsg = `Tool "${toolName}" is not registered on this MCP server`;
			const failResult: StepExecutionResult = {
				index: i,
				name: step.name,
				tool: toolName,
				args: interpolatedArgs,
				status: "failed",
				durationMs: Date.now() - stepStart,
				error: errorMsg,
			};
			context.steps.push(failResult);
			failedSteps++;
			scriptSuccess = false;
			if (stopOnError) break;
			continue;
		}

		// Execute with retry
		const maxAttempts = step.retry?.maxAttempts ? Math.max(1, step.retry.maxAttempts) : 1;
		const delayMs = step.retry?.delayMs ?? 500;
		const backoff = step.retry?.backoff ?? 1;

		let attempt = 0;
		let lastError: string | undefined;
		let lastParsedResult: unknown = undefined;
		let stepPassed = false;

		while (attempt < maxAttempts) {
			attempt++;
			try {
				const callResult = await toolRecord.callback(interpolatedArgs, {});
				let parsedResult: unknown = callResult;
				const text = callResult?.content?.[0]?.text;
				if (typeof text === "string") {
					try {
						parsedResult = JSON.parse(text);
					} catch {
						parsedResult = text;
					}
				}
				lastParsedResult = parsedResult;

				if (callResult?.isError) {
					lastError = typeof parsedResult === "string" ? parsedResult : (callResult?.content?.[0]?.text || "Tool execution failed");
				} else if (step.expect) {
					const expCheck = evaluateExpectation(step.expect, parsedResult, Boolean(callResult?.isError));
					if (!expCheck.pass) {
						lastError = expCheck.error || "Expectation assertion failed";
					} else {
						stepPassed = true;
						break;
					}
				} else {
					stepPassed = true;
					break;
				}
			} catch (err) {
				lastError = err instanceof Error ? err.message : String(err);
			}

			if (!stepPassed && attempt < maxAttempts) {
				const sleepTime = delayMs * Math.pow(backoff, attempt - 1);
				await new Promise((r) => setTimeout(r, sleepTime));
			}
		}

		const stepDuration = Date.now() - stepStart;
		let failureScreenshotUri: string | undefined;
		let failureDiag: StepExecutionResult["diagnostics"] = undefined;

		if (!stepPassed) {
			failedSteps++;
			scriptSuccess = false;

			// Gather diagnostics
			if (!proc) {
				try { proc = resolveProcess(options.processId); } catch { /* ignore */ }
			}
			if (proc && captureArtifacts) {
				try {
					const outPath = path.join(os.tmpdir(), `script-failure-step-${i}-${Date.now()}.png`);
					const snap = await saveScreenshot(proc, outPath);
					const art = registerArtifact(proc.id, "screenshot", snap.path);
					failureScreenshotUri = `electron://artifact/${art.id}`;
				} catch { /* ignore */ }

				failureDiag = {
					consoleErrors: proc.consoleMessages
						.filter((m: any) => m.level === "error" || m.type === "error")
						.slice(-5),
					networkFailures: proc.networkEntries
						.filter((e: any) => Boolean(e.failed || (typeof e.status === "number" && e.status >= 400)))
						.slice(-5),
				};
			}

			const stepResult: StepExecutionResult = {
				index: i,
				name: step.name,
				tool: toolName,
				args: interpolatedArgs,
				status: "failed",
				durationMs: stepDuration,
				error: lastError,
				result: lastParsedResult,
				...(failureScreenshotUri ? { failureScreenshotUri } : {}),
				...(failureDiag ? { diagnostics: failureDiag } : {}),
			};
			context.steps.push(stepResult);

			if (step.onError === "continue") {
				// Continue despite failure
			} else if (stopOnError) {
				break;
			}
		} else {
			passedSteps++;
			if (step.assign) {
				context.vars[step.assign] = lastParsedResult;
			}

			const stepResult: StepExecutionResult = {
				index: i,
				name: step.name,
				tool: toolName,
				args: interpolatedArgs,
				status: "passed",
				durationMs: stepDuration,
				result: lastParsedResult,
			};
			context.steps.push(stepResult);
		}

		if (step.delayAfterMs && step.delayAfterMs > 0) {
			await new Promise((r) => setTimeout(r, step.delayAfterMs));
		}
	}

	let exportedCode: string | undefined;
	let exportedPath: string | undefined;

	if (options.exportAs === "playwright") {
		exportedCode = generatePlaywrightCode(steps, proc?.appPath || ".");
		if (options.exportPath) {
			fs.mkdirSync(path.dirname(options.exportPath), { recursive: true });
			fs.writeFileSync(options.exportPath, exportedCode, "utf8");
			exportedPath = path.resolve(options.exportPath);
		}
	} else if (options.exportAs === "json") {
		const jsonRecipe = JSON.stringify({ steps, variables: context.vars }, null, 2);
		if (options.exportPath) {
			fs.mkdirSync(path.dirname(options.exportPath), { recursive: true });
			fs.writeFileSync(options.exportPath, jsonRecipe, "utf8");
			exportedPath = path.resolve(options.exportPath);
		} else {
			exportedCode = jsonRecipe;
		}
	}

	return {
		success: scriptSuccess,
		totalSteps: steps.length,
		passedSteps,
		failedSteps,
		skippedSteps,
		durationMs: Date.now() - startTime,
		vars: context.vars,
		timeline: context.steps,
		...(exportedCode ? { exportedCode } : {}),
		...(exportedPath ? { exportedPath } : {}),
	};
}
