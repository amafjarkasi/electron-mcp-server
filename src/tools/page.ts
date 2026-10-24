import * as os from "os";
import * as path from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { textResult, requireRunningProcess, resolveProcess, registerTool, withProcess } from "../tool-helpers.js";
import { registerArtifact } from "../artifacts.js";
import { log } from "../log.js";
import {
	redactSecretsString,
	redactSecretsDeep,
	diagnoseProcess,
	captureScreenshot,
	clearProcessBuffers,
	clickSelector,
	connectToCDPTarget,
	deleteCookie,
	dragSelector,
	ensureMonitoring,
	executeCDPCommand,
	getAllProcesses,
	getCookies,
	getOuterHtml,
	getPageInfo,
	getProcess,
	getStorage,
	hoverSelector,
	navigatePage,
	pickPageTarget,
	pickTargetByRole,
	pressKey,
	saveScreenshot,
	scrollTarget,
	setConsoleLiveLogging,
	setCookie,
	setStorage,
	typeText,
	updateCDPTargets,
	waitForCondition,
	withTimeout,
} from "../process-manager.js";
import {
	waitNetworkIdle,
	resolveStack,
	assertUi,
	clickByAx,
	getAccessibilitySnapshot,
	getAppVision,
	handleDialog,
	highlightSelector,
	selectOption,
	typeByAx,
} from "../power-tools.js";

export function registerPageTools(server: McpServer) {
	registerTool(
		server,
		"get_logs",
		{
			description: "Get captured stdout/stderr logs for a managed Electron process",
			params: {
			processId: z
				.string()
				.describe("Process id returned by start_app or attach"),
			tail: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Optional number of trailing log chunks to return"),
		},
			annotations: {"readOnlyHint":true},
		},
		async ({ processId, tail }) => {
			const proc = resolveProcess(processId);
			if (!proc) {
				return textResult(`Process not found: ${processId}`, true);
			}
			const logs = tail ? proc.logs.slice(-tail) : proc.logs;
			let logText = logs.join("");
			if (proc.redactedSecrets && proc.redactedSecrets.size > 0) {
				logText = redactSecretsString(logText, proc.redactedSecrets);
			}
			return textResult({
				processId,
				status: proc.status,
				logs: logText,
			});
		},
	);

	registerTool(
		server,
		"get_console_messages",
		{
			description: "Get buffered page console/log/exception messages captured via CDP",
			params: {
	    processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
	    tail: z.number().int().positive().optional(),
	    level: z
	      .string()
	      .optional()
	      .describe("Optional filter, e.g. error, warning, log"),
	  },
			annotations: {"readOnlyHint":true},
		},
		async ({ processId, tail, level }) => {
	    const proc = resolveProcess(processId);
	    if (!proc) {
	      return textResult(`Process not found: ${processId}`, true);
	    }
	    try {
	      if (proc.status === "running") {
	        await ensureMonitoring(proc);
	      }
	      let messages = proc.consoleMessages;
	      const targetLevel = level ? level.toLowerCase() : null;
	      if (tail && tail > 0) {
	        const result = [];
	        for (let i = messages.length - 1; i >= 0 && result.length < tail; i--) {
	          const msg = messages[i];
	          if (!targetLevel || msg.level.toLowerCase() === targetLevel) {
	            result.push(msg);
	          }
	        }
	        result.reverse();
	        messages = result;
	      } else if (targetLevel) {
	        messages = messages.filter(
	          (m) => m.level.toLowerCase() === targetLevel
	        );
	      }
	      return textResult({ processId, count: messages.length, messages });
	    } catch (err) {
	      return textResult(
	        err instanceof Error ? err.message : String(err),
	        true
	      );
	    }
	  }
	);

	registerTool(
		server,
		"list_targets",
		{
			description: "List Chrome DevTools Protocol targets with role classification (page/worker/browser/other)",
			params: {
			processId: z
				.string()
				.optional()
				.describe(
					"Optional process id; omit to list targets for all running apps",
				),
		},
			annotations: {"readOnlyHint":true,"idempotentHint":true},
		},
		async ({ processId }) => {
			try {
				const allTargets: Array<{
					processId: string;
					role: string;
					target: unknown;
				}> = [];

				const entries = processId
					? ([[processId, requireRunningProcess(processId)]] as const)
					: Array.from(getAllProcesses().entries());

				for (const [id, proc] of entries) {
					if (proc.status !== "running" || !proc.debugPort) {
						continue;
					}
					try {
						await updateCDPTargets(proc);
						for (const target of proc.targets ?? []) {
							allTargets.push({
								processId: id,
								role:
									target.type === "page"
										? "page"
										: target.type === "worker" || target.type === "service_worker"
											? "worker"
											: target.type === "browser"
												? "browser"
												: "other",
								target,
							});
						}
					} catch (err) {
						log.warn(`Could not update targets for ${id}:`, err);
					}
				}

				return textResult({ targets: allTargets });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"evaluate",
		{
			description: "Evaluate JavaScript in an Electron target via CDP Runtime.evaluate. Defaults to the first page/renderer target.",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			expression: z.string().describe("JavaScript expression to evaluate"),
			targetId: z.string().optional(),
			role: z
				.enum(["page", "worker", "browser", "other"])
				.optional()
				.describe(
					"Preferred target role when targetId is omitted (default page)",
				),
			returnByValue: z.boolean().optional(),
		},
			annotations: {"destructiveHint":false,"openWorldHint":true},
		},
		async ({ processId, expression, targetId, role, returnByValue }) => {
			try {
				const proc = requireRunningProcess(processId);
				await updateCDPTargets(proc);
				const target = targetId
					? pickPageTarget(proc, targetId, "any")
					: role
						? pickTargetByRole(proc, role)
						: pickPageTarget(proc);
				const result = await executeCDPCommand(
					proc,
					target.id,
					"Runtime.evaluate",
					{
						expression,
						returnByValue: returnByValue ?? true,
						awaitPromise: true,
					},
				);
				return textResult({
					processId,
					targetId: target.id,
					targetType: target.type,
					result,
				});
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"screenshot",
		{
			description: "Capture a PNG/JPEG screenshot of a page target via Page.captureScreenshot (optional CSS selector clips to element bounds)",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			targetId: z.string().optional(),
			format: z.enum(["png", "jpeg"]).optional(),
			quality: z.number().int().min(0).max(100).optional(),
			selector: z
				.string()
				.optional()
				.describe(
					"Optional CSS selector — capture only that element's bounding box",
				),
		},
			annotations: {"readOnlyHint":true},
		},
		async ({ processId, targetId, format, quality, selector }) => {
			try {
				const proc = requireRunningProcess(processId);
				const shot = await captureScreenshot(
					proc,
					targetId,
					format ?? "png",
					quality,
					selector,
				);
				return {
					content: [
						{
							type: "image" as const,
							data: shot.data,
							mimeType: shot.mimeType,
						},
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									processId,
									targetId: shot.targetId,
									mimeType: shot.mimeType,
									bytesBase64: shot.data.length,
									clip: shot.clip ?? null,
								},
								null,
								2,
							),
						},
					],
				};
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"save_screenshot",
		{
			description: "Capture a screenshot and write it to a local file path (PNG/JPEG); optional selector clips to element",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			path: z.string().describe("Absolute or relative file path to write"),
			targetId: z.string().optional(),
			format: z.enum(["png", "jpeg"]).optional(),
			quality: z.number().int().min(0).max(100).optional(),
			selector: z
				.string()
				.optional()
				.describe(
					"Optional CSS selector — capture only that element's bounding box",
				),
		},
			annotations: {"readOnlyHint":false,"idempotentHint":true},
		},
		async ({
			processId,
			path: filePath,
			targetId,
			format,
			quality,
			selector,
		}) => {
			try {
				const proc = requireRunningProcess(processId);
				const saved = await saveScreenshot(
					proc,
					filePath,
					targetId,
					format ?? "png",
					quality,
					selector,
				);
				return textResult({ processId, ...saved });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"get_dom",
		{
			description: "Read documentElement.outerHTML or a specific element's outerHTML",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			selector: z
				.string()
				.optional()
				.describe(
					"Optional CSS selector; omit for full documentElement.outerHTML",
				),
			targetId: z.string().optional(),
		},
			annotations: {"readOnlyHint":true},
		},
		async ({ processId, selector, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await getOuterHtml(proc, selector, targetId);
				return textResult({
					processId,
					targetId: result.targetId,
					selector: selector ?? null,
					html: result.html,
				});
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"query_selector",
		{
			description: "Query DOM nodes with document.querySelectorAll and return tag/id/class/text summary",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			selector: z.string().describe("CSS selector"),
			targetId: z.string().optional(),
			limit: z.number().int().positive().max(100).optional(),
		},
			annotations: {"readOnlyHint":true},
		},
		async ({ processId, selector, targetId, limit }) => {
			try {
				const proc = requireRunningProcess(processId);
				await updateCDPTargets(proc);
				const target = pickPageTarget(proc, targetId);
				const max = limit ?? 20;
				const result = (await executeCDPCommand(
					proc,
					target.id,
					"Runtime.evaluate",
					{
						expression: `(() => {
            const nodes = Array.from(document.querySelectorAll(${JSON.stringify(
								selector,
							)}));
            return {
              count: nodes.length,
              nodes: nodes.slice(0, ${max}).map((el, index) => ({
                index,
                tag: el.tagName.toLowerCase(),
                id: el.id || null,
                className: typeof el.className === 'string' ? el.className : null,
                text: (el.innerText || '').trim().slice(0, 200),
              })),
            };
          })()`,
						returnByValue: true,
						awaitPromise: true,
					},
				)) as { result?: { value?: unknown } };
				return textResult({
					processId,
					targetId: target.id,
					selector,
					result: result.result?.value,
				});
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"reload",
		{
			description: "Reload a page target (or all page targets) in an Electron app",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			targetId: z.string().optional(),
			ignoreCache: z.boolean().optional(),
		},
			annotations: {"destructiveHint":false},
		},
		async ({ processId, targetId, ignoreCache }) => {
			try {
				const proc = requireRunningProcess(processId);
				await updateCDPTargets(proc);

				const targets = targetId
					? [pickPageTarget(proc, targetId)]
					: (proc.targets ?? []).filter(
							(t) =>
								t.type === "page" ||
								// Fallback only for unusual page-like targets; never reload
								// main-process `node` inspect targets (no Page domain).
								(Boolean(t.webSocketDebuggerUrl) &&
									t.type !== "node" &&
									t.type !== "browser"),
						);

				if (!targets.length) {
					return textResult("No reloadable targets found", true);
				}

				const results = [];
				for (const target of targets) {
					const result = await executeCDPCommand(proc, target.id, "Page.reload", {
						ignoreCache: ignoreCache ?? false,
					});
					results.push({ targetId: target.id, result });
				}

				return textResult({ processId, reloaded: results });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"pause",
		{
			description: "Pause JavaScript execution on a target via Debugger.pause",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			targetId: z.string().optional(),
		},
			annotations: {"destructiveHint":false},
		},
		async ({ processId, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				await updateCDPTargets(proc);
				const target = pickPageTarget(proc, targetId);
				const client = await connectToCDPTarget(proc, target.id);
				await withTimeout(
					client.send("Debugger.enable", {}),
					20_000,
					"Debugger.enable",
				);
				const paused = new Promise<unknown>((resolve) => {
					const onPaused = (params: unknown) => {
						try {
							client.removeListener("Debugger.paused", onPaused);
						} catch {
							/* ignore */
						}
						resolve(params);
					};
					client.on("Debugger.paused", onPaused);
				});
				await withTimeout(
					client.send("Debugger.pause", {}),
					20_000,
					"Debugger.pause",
				);
				// Idle pages never hit a JS statement — kick the event loop so pause lands.
				void client
					.send("Runtime.evaluate", {
						expression: "void 0",
						returnByValue: true,
					})
					.catch(() => undefined);
				const pauseEvent = await withTimeout(
					paused,
					10_000,
					"Debugger.paused event",
				);
				return textResult({
					processId,
					targetId: target.id,
					paused: true,
					pauseEvent,
				});
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"resume",
		{
			description: "Resume JavaScript execution on a target via Debugger.resume",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			targetId: z.string().optional(),
		},
			annotations: {"destructiveHint":false},
		},
		async ({ processId, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				await updateCDPTargets(proc);
				const target = pickPageTarget(proc, targetId);
				await executeCDPCommand(proc, target.id, "Debugger.enable", {});
				const result = await executeCDPCommand(
					proc,
					target.id,
					"Debugger.resume",
					{},
				);
				// Detach the debugger so later Page.captureScreenshot / Input commands
				// are not blocked by an open Debugger session.
				try {
					await executeCDPCommand(proc, target.id, "Debugger.disable", {});
				} catch {
					// optional
				}
				return textResult({ processId, targetId: target.id, result });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"cdp_command",
		{
			description: "Execute an arbitrary Chrome DevTools Protocol method on a target (Domain.method)",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			method: z
				.string()
				.describe('CDP method name, e.g. "Page.navigate" or "Runtime.evaluate"'),
			targetId: z.string().optional(),
			params: z.record(z.unknown()).optional(),
		},
			annotations: {"destructiveHint":false,"openWorldHint":true},
		},
		async ({ processId, method, targetId, params }) => {
			try {
				if (!method.includes(".")) {
					return textResult('CDP method must be in "Domain.method" form', true);
				}
				const proc = requireRunningProcess(processId);
				await updateCDPTargets(proc);
				const target = pickPageTarget(proc, targetId);
				const result = await executeCDPCommand(
					proc,
					target.id,
					method,
					params ?? {},
				);
				return textResult({
					processId,
					targetId: target.id,
					method,
					result,
				});
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"page_info",
		{
			description: "Get URL, title, readyState, and userAgent for a page target",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			targetId: z.string().optional(),
		},
			annotations: {"readOnlyHint":true},
		},
		async ({ processId, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(await getPageInfo(proc, targetId));
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"navigate",
		{
			description: "Navigate a page target to a URL (Page.navigate) and optionally wait for load",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			url: z.string().describe("Absolute or app URL to navigate to"),
			targetId: z.string().optional(),
			waitUntilLoad: z.boolean().optional(),
			timeoutMs: z.number().int().positive().max(120000).optional(),
		},
			annotations: {"destructiveHint":false},
		},
		async ({ processId, url, targetId, waitUntilLoad, timeoutMs }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await navigatePage(
					proc,
					url,
					targetId,
					waitUntilLoad ?? true,
					timeoutMs ?? 15000,
				);
				return textResult({ processId, ...result });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"wait_for",
		{
			description: "Wait until a selector exists/hides/enables, text/URL/console matches, or node count is met",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			selector: z.string().optional().describe("CSS selector that must exist"),
			hidden: z
				.string()
				.optional()
				.describe("CSS selector that must be absent or not visible"),
			enabled: z
				.string()
				.optional()
				.describe("CSS selector that must exist and not be disabled"),
			countSelector: z
				.string()
				.optional()
				.describe("CSS selector to count (use with minCount)"),
			minCount: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Minimum matches required for countSelector"),
			text: z
				.string()
				.optional()
				.describe("Text that must appear in document.body"),
			urlIncludes: z
				.string()
				.optional()
				.describe("Substring that location.href must include"),
			consoleIncludes: z
				.string()
				.optional()
				.describe("Substring that a buffered console message must include"),
			timeoutMs: z.number().int().positive().max(120000).optional(),
			screenshotOnTimeout: z
				.boolean()
				.optional()
				.describe("If true, save a PNG to the OS temp dir when wait times out"),
			targetId: z.string().optional(),
		},
			annotations: {"readOnlyHint":true},
		},
		async ({
			processId,
			selector,
			hidden,
			enabled,
			countSelector,
			minCount,
			text,
			urlIncludes,
			consoleIncludes,
			timeoutMs,
			screenshotOnTimeout,
			targetId,
		}) => {
			try {
				if (
					!selector &&
					!hidden &&
					!enabled &&
					!countSelector &&
					!text &&
					!urlIncludes &&
					!consoleIncludes
				) {
					return textResult(
						"Provide at least one of: selector, hidden, enabled, countSelector, text, urlIncludes, consoleIncludes",
						true,
					);
				}
				if (
					(countSelector && minCount == null) ||
					(!countSelector && minCount != null)
				) {
					return textResult(
						"countSelector and minCount must be provided together",
						true,
					);
				}
				const proc = requireRunningProcess(processId);
				if (consoleIncludes) {
					await ensureMonitoring(proc);
				}
				const result = await waitForCondition(proc, {
					selector,
					hidden,
					enabled,
					count:
						countSelector && minCount != null
							? { selector: countSelector, min: minCount }
							: undefined,
					text,
					urlIncludes,
					consoleIncludes,
					timeoutMs,
					screenshotOnTimeout,
					targetId,
				});
				return textResult({ processId, ...result });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"click",
		{
			description: "Click the center of a CSS selector via CDP Input.dispatchMouseEvent",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			selector: z.string().describe("CSS selector to click"),
			targetId: z.string().optional(),
			button: z.enum(["left", "right", "middle"]).optional(),
		},
			annotations: {"destructiveHint":false},
		},
		async ({ processId, selector, targetId, button }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await clickSelector(
					proc,
					selector,
					targetId,
					button ?? "left",
				);
				return textResult({ processId, ...result });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"hover",
		{
			description: "Move the pointer over a CSS selector (mouseover / hover menus). Does not click.",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			selector: z.string().describe("CSS selector to hover"),
			targetId: z.string().optional(),
		},
			annotations: {"destructiveHint":false},
		},
		async ({ processId, selector, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await hoverSelector(proc, selector, targetId);
				return textResult({ processId, ...result });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"scroll",
		{
			description: "Scroll the page or an element. With a selector and no deltas, scrolls that element into view. With deltaY/deltaX, sends a mouse wheel at the element (or the viewport).",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			selector: z.string().optional().describe("Element to scroll into view, or the wheel target"),
			deltaX: z.number().optional().describe("Horizontal wheel delta. Positive scrolls right."),
			deltaY: z.number().optional().describe("Vertical wheel delta. Positive scrolls down. Default 400 when no selector."),
			targetId: z.string().optional(),
		},
			annotations: {"destructiveHint":false},
		},
		async ({ processId, selector, deltaX, deltaY, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await scrollTarget(proc, { selector, deltaX, deltaY, targetId });
				return textResult({ processId, ...result });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"drag",
		{
			description: "Press on fromSelector, move to toSelector, and release. Also sends an HTML5 drag with text/plain dataTransfer so drop listeners receive the payload. Pass data to override the source text.",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			fromSelector: z.string(),
			toSelector: z.string(),
			data: z.string().optional().describe("text/plain payload. Defaults to the source element's text."),
			targetId: z.string().optional(),
		},
			annotations: {"destructiveHint":false},
		},
		async ({ processId, fromSelector, toSelector, data, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await dragSelector(proc, fromSelector, toSelector, targetId, data);
				return textResult({ processId, ...result });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"type_text",
		{
			description: "Type text into the focused element (optionally click a selector first)",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			text: z.string(),
			selector: z
				.string()
				.optional()
				.describe("Optional CSS selector to focus before typing"),
			clear: z
				.boolean()
				.optional()
				.describe("If true and selector is set, clear the field first"),
			pressEnter: z.boolean().optional(),
			targetId: z.string().optional(),
		},
			annotations: {"destructiveHint":false},
		},
		async ({ processId, text, selector, clear, pressEnter, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await typeText(proc, text, {
					selector,
					clear,
					pressEnter,
					targetId,
				});
				return textResult({ processId, ...result });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"press_key",
		{
			description: "Press a key or shortcut (Enter, Escape, Tab, Arrow*, or a character) with optional modifiers",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			key: z
				.string()
				.describe('Key name, e.g. "Enter", "Escape", "a", "Tab", "ArrowDown"'),
			selector: z
				.string()
				.optional()
				.describe("Optional CSS selector to focus before keypress"),
			modifiers: z
				.array(z.enum(["Alt", "Control", "Meta", "Shift"]))
				.optional()
				.describe('Modifier keys, e.g. ["Control"] for Ctrl+A'),
			repeat: z.number().int().positive().max(50).optional(),
			targetId: z.string().optional(),
		},
			annotations: {"destructiveHint":false},
		},
		async ({ processId, key, selector, modifiers, repeat, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await pressKey(proc, key, {
					selector,
					modifiers,
					repeat,
					targetId,
				});
				return textResult({ processId, ...result });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"set_console_live",
		{
			description: "Enable/disable live MCP log notifications for console events (all levels when enabled; errors always notify)",
			params: {
			enabled: z.boolean().describe("true to stream console events as MCP logs"),
		},
			annotations: {"destructiveHint":false},
		},
		async ({ enabled }) => {
			const value = setConsoleLiveLogging(enabled);
			return textResult({
				consoleLiveLogging: value,
				note: "Errors/asserts always emit MCP logs. When enabled, log/info/warn/debug also stream live.",
			});
		},
	);

	registerTool(
		server,
		"get_cookies",
		{
			description: "Read cookies for the page (optionally filtered by URL)",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			urls: z.array(z.string()).optional(),
			targetId: z.string().optional(),
		},
			annotations: {"readOnlyHint":true},
		},
		async ({ processId, urls, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await getCookies(proc, { urls, targetId });
				return textResult({ processId, ...result });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"set_cookie",
		{
			description: "Set a cookie on the page (provide url or domain; defaults to current location.href). file:// pages usually reject cookies unless you pass an http(s) url or domain.",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			name: z.string(),
			value: z.string(),
			url: z.string().optional(),
			domain: z.string().optional(),
			path: z.string().optional(),
			secure: z.boolean().optional(),
			httpOnly: z.boolean().optional(),
			sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
			expires: z.number().optional().describe("Unix time in seconds"),
			targetId: z.string().optional(),
		},
			annotations: {"destructiveHint":false},
		},
		async ({
			processId,
			name,
			value,
			url,
			domain,
			path: cookiePath,
			secure,
			httpOnly,
			sameSite,
			expires,
			targetId,
		}) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await setCookie(
					proc,
					{
						name,
						value,
						url,
						domain,
						path: cookiePath,
						secure,
						httpOnly,
						sameSite,
						expires,
					},
					targetId,
				);
				return textResult({ processId, ...result });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"delete_cookie",
		{
			description: "Delete a cookie by name. Provide url or domain, same as set_cookie. Defaults url to the page location.",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			name: z.string(),
			url: z.string().optional(),
			domain: z.string().optional(),
			path: z.string().optional(),
			targetId: z.string().optional(),
		},
			annotations: {"destructiveHint":true},
		},
		async ({ processId, name, url, domain, path: cookiePath, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await deleteCookie(
					proc,
					{ name, url, domain, path: cookiePath },
					targetId,
				);
				return textResult({ processId, ...result });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"get_storage",
		{
			description: "Read localStorage or sessionStorage key/value pairs from the page",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			kind: z.enum(["localStorage", "sessionStorage"]).optional(),
			targetId: z.string().optional(),
		},
			annotations: {"readOnlyHint":true},
		},
		async ({ processId, kind, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await getStorage(proc, kind ?? "localStorage", targetId);
				return textResult({ processId, ...result });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"set_storage",
		{
			description: "Write localStorage or sessionStorage entries (optionally clear first)",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			kind: z.enum(["localStorage", "sessionStorage"]).optional(),
			entries: z.record(z.string()),
			clear: z.boolean().optional(),
			targetId: z.string().optional(),
		},
			annotations: {"destructiveHint":false},
		},
		async ({ processId, kind, entries, clear, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await setStorage(proc, kind ?? "localStorage", entries, {
					clear,
					targetId,
				});
				return textResult({ processId, ...result });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"clear_buffers",
		{
			description: "Clear buffered console messages, network events, process logs, ipc, and/or audits",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			console: z.boolean().optional(),
			network: z.boolean().optional(),
			logs: z.boolean().optional(),
			ipc: z.boolean().optional(),
			audits: z.boolean().optional(),
		},
			annotations: {"destructiveHint":true},
		},
		async ({ processId, console: clearConsole, network, logs, ipc, audits }) => {
			try {
				const proc = resolveProcess(processId);
				if (!proc) {
					return textResult(`Process not found: ${processId}`, true);
				}
				const hasExplicitFlag =
					clearConsole !== undefined ||
					network !== undefined ||
					logs !== undefined ||
					ipc !== undefined ||
					audits !== undefined;

				const what: Array<"console" | "network" | "logs" | "ipc" | "audits"> =
					[];
				if (hasExplicitFlag) {
					if (clearConsole) what.push("console");
					if (network) what.push("network");
					if (logs) what.push("logs");
					if (ipc) what.push("ipc");
					if (audits) what.push("audits");
				} else {
					what.push("console", "network", "logs");
				}

				return textResult({
					processId,
					...clearProcessBuffers(proc, what),
				});
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"snapshot",
		{
			description: "Accessibility tree snapshot (roles/names) via CDP Accessibility.getFullAXTree — agent-friendly UI map",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			depth: z.number().int().positive().optional(),
			targetId: z.string().optional(),
		},
			annotations: {"readOnlyHint":true},
		},
		async ({ processId, depth, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await getAccessibilitySnapshot(proc, { depth, targetId });
				return textResult({ processId, ...result });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"vision",
		{
			description: "One-shot app state: screenshot + page_info + recent console errors + network failures + windows",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			targetId: z.string().optional(),
			includeScreenshot: z
				.boolean()
				.optional()
				.describe("Include base64 PNG (default true)"),
		},
			annotations: {"readOnlyHint":true},
		},
		async ({ processId, targetId, includeScreenshot }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await getAppVision(proc, { targetId, includeScreenshot });
				const shot = result.screenshot as
					| { mimeType?: string; data?: string }
					| undefined;
				if (shot?.data) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{ ...result, screenshot: { ...shot, data: "[see image]" } },
									null,
									2,
								),
							},
							{
								type: "image" as const,
								data: shot.data,
								mimeType: shot.mimeType ?? "image/png",
							},
						],
					};
				}
				return textResult(result);
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"highlight",
		{
			description: "Scroll a CSS selector into view and paint a CDP overlay highlight (auto-hides when durationMs > 0)",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			selector: z.string(),
			durationMs: z.number().int().nonnegative().max(5000).optional(),
			targetId: z.string().optional(),
		},
			annotations: {"destructiveHint":false},
		},
		async ({ processId, selector, durationMs, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(
					await highlightSelector(proc, { selector, durationMs, targetId }),
				);
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"click_ax",
		{
			description: "Click an element by accessibility name (optional role). Uses the AX tree, not CSS.",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			name: z.string().describe('Accessible name, e.g. "Go" or "Submit"'),
			role: z.string().optional().describe('AX role, e.g. "button" or "link"'),
			exact: z.boolean().optional().describe("Require an exact name match"),
			button: z.enum(["left", "right", "middle"]).optional(),
			targetId: z.string().optional(),
		},
			annotations: {"destructiveHint":false},
		},
		async ({ processId, name, role, exact, button, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(
					await clickByAx(proc, { name, role, exact, button, targetId }),
				);
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"type_ax",
		{
			description: "Focus an element by accessibility name and insert text (optional clear)",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			name: z.string().describe("Accessible name of the field"),
			text: z.string(),
			role: z.string().optional().describe('AX role, e.g. "textbox"'),
			exact: z.boolean().optional(),
			clear: z.boolean().optional(),
			targetId: z.string().optional(),
		},
			annotations: {"destructiveHint":false},
		},
		async ({ processId, name, text, role, exact, clear, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(
					await typeByAx(proc, { name, text, role, exact, clear, targetId }),
				);
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"handle_dialog",
		{
			description: "Auto accept or dismiss the next JavaScript dialogs (alert/confirm/prompt). clear:true disarms.",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			action: z.enum(["accept", "dismiss"]).optional(),
			promptText: z.string().optional().describe("Value when accepting a prompt"),
			clear: z.boolean().optional(),
			targetId: z.string().optional(),
		},
			annotations: {"destructiveHint":false},
		},
		async ({ processId, action, promptText, clear, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(
					await handleDialog(proc, { action, promptText, clear, targetId }),
				);
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"assert_ui",
		{
			description: "Check url/title/text/selector/console-error budget/expression. Returns pass:false with per-check detail (does not throw on a failed check).",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			urlIncludes: z.string().optional(),
			titleIncludes: z.string().optional(),
			textIncludes: z.string().optional(),
			selector: z.string().optional(),
			selectorHidden: z.string().optional(),
			maxConsoleErrors: z.number().int().nonnegative().optional(),
			expression: z
				.string()
				.optional()
				.describe("JS expression that must be truthy"),
			targetId: z.string().optional(),
		},
			annotations: {"readOnlyHint":true},
		},
		async ({
			processId,
			urlIncludes,
			titleIncludes,
			textIncludes,
			selector,
			selectorHidden,
			maxConsoleErrors,
			expression,
			targetId,
		}) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(
					await assertUi(proc, {
						urlIncludes,
						titleIncludes,
						textIncludes,
						selector,
						selectorHidden,
						maxConsoleErrors,
						expression,
						targetId,
					}),
				);
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"select_option",
		{
			description: "Choose an option in a <select> by value or visible label, then fire input and change.",
			params: {
			processId: z.string().optional().describe("Target process ID. Omit if only one app is running."),
			selector: z.string(),
			value: z.string().optional().describe("Option value attribute"),
			label: z.string().optional().describe("Visible option label"),
			targetId: z.string().optional(),
		},
			annotations: {"destructiveHint":false},
		},
		async ({ processId, selector, value, label, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(await selectOption(proc, { selector, value, label, targetId }));
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"act_and_verify",
		{
			description:
				"Composite action & assertion: performs a UI action (click, click_ax, type_text, type_ax), waits for network idle, verifies assertion (assert_ui), and captures a screenshot immediately if assertion fails.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				action: z.object({
					type: z.enum(["click", "click_ax", "type_text", "type_ax"]),
					selector: z.string().optional(),
					name: z.string().optional(),
					text: z.string().optional(),
					clear: z.boolean().optional(),
					pressEnter: z.boolean().optional(),
					role: z.string().optional(),
				}),
				assertion: z.object({
					selector: z.string().optional(),
					selectorHidden: z.string().optional(),
					textIncludes: z.string().optional(),
					urlIncludes: z.string().optional(),
					titleIncludes: z.string().optional(),
					expression: z.string().optional(),
				}),
				waitForSelector: z.string().optional(),
				targetId: z.string().optional(),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, { action, assertion, waitForSelector, targetId }) => {
			if (waitForSelector) {
				await waitForCondition(proc, { selector: waitForSelector, targetId });
			}

			let actionResult: unknown = null;
			if (action.type === "click" && action.selector) {
				actionResult = await clickSelector(proc, action.selector, targetId);
			} else if (action.type === "click_ax" && action.name) {
				actionResult = await clickByAx(proc, { name: action.name, role: action.role, targetId });
			} else if (action.type === "type_text" && action.text !== undefined) {
				actionResult = await typeText(proc, action.text, {
					selector: action.selector,
					clear: action.clear,
					pressEnter: action.pressEnter,
					targetId,
				});
			} else if (action.type === "type_ax" && action.name && action.text !== undefined) {
				actionResult = await typeByAx(proc, {
					name: action.name,
					text: action.text,
					role: action.role,
					clear: action.clear,
					targetId,
				});
			}

			await waitNetworkIdle(proc, { idleMs: 300, targetId }).catch(() => {});

			let assertionResult: any = null;
			let assertionPassed = true;
			try {
				assertionResult = await assertUi(proc, {
					selector: assertion.selector,
					selectorHidden: assertion.selectorHidden,
					textIncludes: assertion.textIncludes,
					urlIncludes: assertion.urlIncludes,
					titleIncludes: assertion.titleIncludes,
					expression: assertion.expression,
					targetId,
				});
				assertionPassed = assertionResult.pass !== false;
			} catch (err) {
				assertionResult = { passed: false, error: err instanceof Error ? err.message : String(err) };
				assertionPassed = false;
			}

			let failureScreenshotUri: string | undefined;
			if (!assertionPassed) {
				try {
					const outPath = path.join(os.tmpdir(), `electron-verify-failure-${Date.now()}.png`);
					const snap = await saveScreenshot(proc, outPath, targetId);
					const art = registerArtifact(proc.id, "screenshot", snap.path);
					failureScreenshotUri = `electron://artifact/${art.id}`;
				} catch { /* ignore screenshot failure */ }
			}

			return {
				processId: proc.id,
				actionPassed: true,
				actionResult,
				assertionPassed,
				assertionResult,
				...(failureScreenshotUri ? { failureScreenshotUri } : {}),
			};
		}),
	);

	registerTool(
		server,
		"triage",
		{
			description:
				"One-shot crash and failure triage: inspects page state, collects console errors, failed network calls, audit issues, log tail, and resolves the stack trace of the top exception.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				targetId: z.string().optional(),
			},
			annotations: { readOnlyHint: true },
		},
		withProcess(async (proc, { targetId }) => {
			if (proc.status === "running") {
				await ensureMonitoring(proc);
			}
			const pageInfo = await getPageInfo(proc, targetId).catch(() => null);
			const diag = await diagnoseProcess(proc.id).catch(() => null);

			const consoleErrors = proc.consoleMessages.filter(
				(m) => m.level === "error" || (m as any).type === "error" || (m as any).type === "assert",
			).slice(-10);

			const networkFailures = proc.networkEntries.filter(
				(e) => Boolean((e as any).failed || (typeof e.status === "number" && e.status >= 400)),
			).slice(-10);

			const auditIssues = (proc.auditIssues || []).slice(-10);
			const logsTail = (proc.logs || []).slice(-20).join("");

			let topExceptionResolved: unknown = null;
			if (consoleErrors.length > 0) {
				const firstErr = consoleErrors[consoleErrors.length - 1];
				if ((firstErr as any).stackTrace && Array.isArray(((firstErr as any).stackTrace as any).callFrames)) {
					const frames = ((firstErr as any).stackTrace as any).callFrames.map((f: any) => ({
						url: f.url,
						scriptId: f.scriptId,
						lineNumber: f.lineNumber,
						columnNumber: f.columnNumber,
						functionName: f.functionName,
					}));
					if (frames.length > 0) {
						topExceptionResolved = await resolveStack(proc, { frames, contextLines: 3, targetId }).catch(() => null);
					}
				}
			}

			return {
				processId: proc.id,
				status: proc.status,
				page: pageInfo,
				diagnosis: diag,
				summary: {
					consoleErrorCount: consoleErrors.length,
					networkFailureCount: networkFailures.length,
					auditIssueCount: auditIssues.length,
				},
				consoleErrors,
				networkFailures,
				auditIssues,
				topExceptionResolved,
				logsTail,
			};
		}),
	);
}

