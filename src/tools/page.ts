import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { textResult, requireRunningProcess } from "../tool-helpers.js";
import { log } from "../log.js";
import {
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
	server.tool(
		"get_logs",
		"Get captured stdout/stderr logs for a managed Electron process",
		{
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
		async ({ processId, tail }) => {
			const proc = getProcess(processId);
			if (!proc) {
				return textResult(`Process not found: ${processId}`, true);
			}
			const logs = tail ? proc.logs.slice(-tail) : proc.logs;
			return textResult({
				processId,
				status: proc.status,
				logs: logs.join(""),
			});
		},
	);

	server.tool(
	  "get_console_messages",
	  "Get buffered page console/log/exception messages captured via CDP",
	  {
	    processId: z.string(),
	    tail: z.number().int().positive().optional(),
	    level: z
	      .string()
	      .optional()
	      .describe("Optional filter, e.g. error, warning, log"),
	  },
	  async ({ processId, tail, level }) => {
	    const proc = getProcess(processId);
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

	server.tool(
		"list_targets",
		"List Chrome DevTools Protocol targets with role classification (page/worker/browser/other)",
		{
			processId: z
				.string()
				.optional()
				.describe(
					"Optional process id; omit to list targets for all running apps",
				),
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

	server.tool(
		"evaluate",
		"Evaluate JavaScript in an Electron target via CDP Runtime.evaluate. Defaults to the first page/renderer target.",
		{
			processId: z.string(),
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

	server.tool(
		"screenshot",
		"Capture a PNG/JPEG screenshot of a page target via Page.captureScreenshot (optional CSS selector clips to element bounds)",
		{
			processId: z.string(),
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

	server.tool(
		"save_screenshot",
		"Capture a screenshot and write it to a local file path (PNG/JPEG); optional selector clips to element",
		{
			processId: z.string(),
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

	server.tool(
		"get_dom",
		"Read documentElement.outerHTML or a specific element's outerHTML",
		{
			processId: z.string(),
			selector: z
				.string()
				.optional()
				.describe(
					"Optional CSS selector; omit for full documentElement.outerHTML",
				),
			targetId: z.string().optional(),
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

	server.tool(
		"query_selector",
		"Query DOM nodes with document.querySelectorAll and return tag/id/class/text summary",
		{
			processId: z.string(),
			selector: z.string().describe("CSS selector"),
			targetId: z.string().optional(),
			limit: z.number().int().positive().max(100).optional(),
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

	server.tool(
		"reload",
		"Reload a page target (or all page targets) in an Electron app",
		{
			processId: z.string(),
			targetId: z.string().optional(),
			ignoreCache: z.boolean().optional(),
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

	server.tool(
		"pause",
		"Pause JavaScript execution on a target via Debugger.pause",
		{
			processId: z.string(),
			targetId: z.string().optional(),
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

	server.tool(
		"resume",
		"Resume JavaScript execution on a target via Debugger.resume",
		{
			processId: z.string(),
			targetId: z.string().optional(),
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

	server.tool(
		"cdp_command",
		"Execute an arbitrary Chrome DevTools Protocol method on a target (Domain.method)",
		{
			processId: z.string(),
			method: z
				.string()
				.describe('CDP method name, e.g. "Page.navigate" or "Runtime.evaluate"'),
			targetId: z.string().optional(),
			params: z.record(z.unknown()).optional(),
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

	server.tool(
		"page_info",
		"Get URL, title, readyState, and userAgent for a page target",
		{
			processId: z.string(),
			targetId: z.string().optional(),
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

	server.tool(
		"navigate",
		"Navigate a page target to a URL (Page.navigate) and optionally wait for load",
		{
			processId: z.string(),
			url: z.string().describe("Absolute or app URL to navigate to"),
			targetId: z.string().optional(),
			waitUntilLoad: z.boolean().optional(),
			timeoutMs: z.number().int().positive().max(120000).optional(),
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

	server.tool(
		"wait_for",
		"Wait until a selector exists/hides/enables, text/URL/console matches, or node count is met",
		{
			processId: z.string(),
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

	server.tool(
		"click",
		"Click the center of a CSS selector via CDP Input.dispatchMouseEvent",
		{
			processId: z.string(),
			selector: z.string().describe("CSS selector to click"),
			targetId: z.string().optional(),
			button: z.enum(["left", "right", "middle"]).optional(),
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

	server.tool(
		"hover",
		"Move the pointer over a CSS selector (mouseover / hover menus). Does not click.",
		{
			processId: z.string(),
			selector: z.string().describe("CSS selector to hover"),
			targetId: z.string().optional(),
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

	server.tool(
		"scroll",
		"Scroll the page or an element. With a selector and no deltas, scrolls that element into view. With deltaY/deltaX, sends a mouse wheel at the element (or the viewport).",
		{
			processId: z.string(),
			selector: z.string().optional().describe("Element to scroll into view, or the wheel target"),
			deltaX: z.number().optional().describe("Horizontal wheel delta. Positive scrolls right."),
			deltaY: z.number().optional().describe("Vertical wheel delta. Positive scrolls down. Default 400 when no selector."),
			targetId: z.string().optional(),
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

	server.tool(
		"drag",
		"Press on fromSelector, move to toSelector, and release. Also sends an HTML5 drag with text/plain dataTransfer so drop listeners receive the payload. Pass data to override the source text.",
		{
			processId: z.string(),
			fromSelector: z.string(),
			toSelector: z.string(),
			data: z.string().optional().describe("text/plain payload. Defaults to the source element's text."),
			targetId: z.string().optional(),
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

	server.tool(
		"type_text",
		"Type text into the focused element (optionally click a selector first)",
		{
			processId: z.string(),
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

	server.tool(
		"press_key",
		"Press a key or shortcut (Enter, Escape, Tab, Arrow*, or a character) with optional modifiers",
		{
			processId: z.string(),
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

	server.tool(
		"set_console_live",
		"Enable/disable live MCP log notifications for console events (all levels when enabled; errors always notify)",
		{
			enabled: z.boolean().describe("true to stream console events as MCP logs"),
		},
		async ({ enabled }) => {
			const value = setConsoleLiveLogging(enabled);
			return textResult({
				consoleLiveLogging: value,
				note: "Errors/asserts always emit MCP logs. When enabled, log/info/warn/debug also stream live.",
			});
		},
	);

	server.tool(
		"get_cookies",
		"Read cookies for the page (optionally filtered by URL)",
		{
			processId: z.string(),
			urls: z.array(z.string()).optional(),
			targetId: z.string().optional(),
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

	server.tool(
		"set_cookie",
		"Set a cookie on the page (provide url or domain; defaults to current location.href). file:// pages usually reject cookies unless you pass an http(s) url or domain.",
		{
			processId: z.string(),
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

	server.tool(
		"delete_cookie",
		"Delete a cookie by name. Provide url or domain, same as set_cookie. Defaults url to the page location.",
		{
			processId: z.string(),
			name: z.string(),
			url: z.string().optional(),
			domain: z.string().optional(),
			path: z.string().optional(),
			targetId: z.string().optional(),
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

	server.tool(
		"get_storage",
		"Read localStorage or sessionStorage key/value pairs from the page",
		{
			processId: z.string(),
			kind: z.enum(["localStorage", "sessionStorage"]).optional(),
			targetId: z.string().optional(),
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

	server.tool(
		"set_storage",
		"Write localStorage or sessionStorage entries (optionally clear first)",
		{
			processId: z.string(),
			kind: z.enum(["localStorage", "sessionStorage"]).optional(),
			entries: z.record(z.string()),
			clear: z.boolean().optional(),
			targetId: z.string().optional(),
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

	server.tool(
		"clear_buffers",
		"Clear buffered console messages, network events, process logs, ipc, and/or audits",
		{
			processId: z.string(),
			console: z.boolean().optional(),
			network: z.boolean().optional(),
			logs: z.boolean().optional(),
			ipc: z.boolean().optional(),
			audits: z.boolean().optional(),
		},
		async ({ processId, console: clearConsole, network, logs, ipc, audits }) => {
			try {
				const proc = getProcess(processId);
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

	server.tool(
		"snapshot",
		"Accessibility tree snapshot (roles/names) via CDP Accessibility.getFullAXTree — agent-friendly UI map",
		{
			processId: z.string(),
			depth: z.number().int().positive().optional(),
			targetId: z.string().optional(),
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

	server.tool(
		"vision",
		"One-shot app state: screenshot + page_info + recent console errors + network failures + windows",
		{
			processId: z.string(),
			targetId: z.string().optional(),
			includeScreenshot: z
				.boolean()
				.optional()
				.describe("Include base64 PNG (default true)"),
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

	server.tool(
		"highlight",
		"Scroll a CSS selector into view and paint a CDP overlay highlight (auto-hides when durationMs > 0)",
		{
			processId: z.string(),
			selector: z.string(),
			durationMs: z.number().int().nonnegative().max(5000).optional(),
			targetId: z.string().optional(),
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

	server.tool(
		"click_ax",
		"Click an element by accessibility name (optional role). Uses the AX tree, not CSS.",
		{
			processId: z.string(),
			name: z.string().describe('Accessible name, e.g. "Go" or "Submit"'),
			role: z.string().optional().describe('AX role, e.g. "button" or "link"'),
			exact: z.boolean().optional().describe("Require an exact name match"),
			button: z.enum(["left", "right", "middle"]).optional(),
			targetId: z.string().optional(),
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

	server.tool(
		"type_ax",
		"Focus an element by accessibility name and insert text (optional clear)",
		{
			processId: z.string(),
			name: z.string().describe("Accessible name of the field"),
			text: z.string(),
			role: z.string().optional().describe('AX role, e.g. "textbox"'),
			exact: z.boolean().optional(),
			clear: z.boolean().optional(),
			targetId: z.string().optional(),
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

	server.tool(
		"handle_dialog",
		"Auto accept or dismiss the next JavaScript dialogs (alert/confirm/prompt). clear:true disarms.",
		{
			processId: z.string(),
			action: z.enum(["accept", "dismiss"]).optional(),
			promptText: z.string().optional().describe("Value when accepting a prompt"),
			clear: z.boolean().optional(),
			targetId: z.string().optional(),
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

	server.tool(
		"assert_ui",
		"Check url/title/text/selector/console-error budget/expression. Returns pass:false with per-check detail (does not throw on a failed check).",
		{
			processId: z.string(),
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

	server.tool(
		"select_option",
		"Choose an option in a <select> by value or visible label, then fire input and change.",
		{
			processId: z.string(),
			selector: z.string(),
			value: z.string().optional().describe("Option value attribute"),
			label: z.string().optional().describe("Visible option label"),
			targetId: z.string().optional(),
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
}
