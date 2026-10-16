import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { textResult, requireRunningProcess } from "../tool-helpers.js";
import {
	startTracing,
	stopTracing,
} from "../process-manager.js";
import {
	captureMhtml,
	diffScreenshot,
	emulate,
	getAuditIssues,
	getPerformanceMetrics,
	printPdf,
	removeBreakpoint,
	resolveStack,
	runPerfAudit,
	setBreakpointByUrl,
	setFileInput,
	setVirtualClock,
	startCoverage,
	startCpuProfile,
	startScreencast,
	stopCoverage,
	stopCpuProfile,
	stopScreencast,
	takeHeapSnapshot,
} from "../power-tools.js";

export function registerProfileTools(server: McpServer) {
	server.tool(
		"start_tracing",
		"Start Chrome DevTools Protocol performance tracing (pair with stop_tracing)",
		{
			processId: z.string(),
			categories: z
				.string()
				.optional()
				.describe(
					"Comma-separated CDP trace categories (default: timeline + v8)",
				),
			targetId: z.string().optional(),
		},
		async ({ processId, categories, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await startTracing(proc, { categories, targetId });
				return textResult(result);
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"stop_tracing",
		"Stop CDP tracing and write a JSON trace file (open in chrome://tracing)",
		{
			processId: z.string(),
			path: z
				.string()
				.optional()
				.describe("Output file path (default: OS temp dir)"),
		},
		async ({ processId, path: filePath }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await stopTracing(proc, filePath);
				return textResult(result);
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"get_performance_metrics",
		"Renderer Performance.getMetrics (JS heap, layout count, task duration, …)",
		{
			processId: z.string(),
			targetId: z.string().optional(),
		},
		async ({ processId, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await getPerformanceMetrics(proc, targetId);
				return textResult({ processId, ...result });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"start_cpu_profile",
		"Start V8 CPU profiler on a page target (pair with stop_cpu_profile)",
		{
			processId: z.string(),
			targetId: z.string().optional(),
		},
		async ({ processId, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(await startCpuProfile(proc, targetId));
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"stop_cpu_profile",
		"Stop CPU profiler and write a .cpuprofile JSON file",
		{
			processId: z.string(),
			path: z.string().optional().describe("Output path (default: OS temp)"),
		},
		async ({ processId, path: filePath }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(await stopCpuProfile(proc, filePath));
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"heap_snapshot",
		"Take a V8 heap snapshot (.heapsnapshot) for leak investigation",
		{
			processId: z.string(),
			path: z.string().optional(),
			targetId: z.string().optional(),
		},
		async ({ processId, path: filePath, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(await takeHeapSnapshot(proc, filePath, targetId));
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"diff_screenshot",
		"Capture (or compare) a screenshot against a baseline PNG; reports identical + byte similarity",
		{
			processId: z.string(),
			baselinePath: z.string(),
			currentPath: z
				.string()
				.optional()
				.describe("Existing PNG to compare; if omitted, captures fresh"),
			selector: z.string().optional(),
			targetId: z.string().optional(),
		},
		async ({ processId, baselinePath, currentPath, selector, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(
					await diffScreenshot(proc, {
						baselinePath,
						currentPath,
						selector,
						targetId,
					}),
				);
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"get_audit_issues",
		"Buffered Chromium Audits issues (cookie/CORS/mixed-content/deprecations) captured since attach",
		{
			processId: z.string(),
			tail: z.number().int().positive().optional(),
		},
		async ({ processId, tail }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(getAuditIssues(proc, tail));
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"start_coverage",
		"Start JS precise coverage (optional CSS rule usage). Pair with stop_coverage.",
		{
			processId: z.string(),
			targetId: z.string().optional(),
			css: z.boolean().optional().describe("Also track CSS rule usage"),
		},
		async ({ processId, targetId, css }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(await startCoverage(proc, { targetId, css }));
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"stop_coverage",
		"Stop coverage and return JS (and optional CSS) coverage data; optionally write JSON",
		{
			processId: z.string(),
			path: z.string().optional(),
		},
		async ({ processId, path: filePath }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(await stopCoverage(proc, filePath));
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"set_file_input",
		"Set files on an <input type=file> via DOM.setFileInputFiles (host paths)",
		{
			processId: z.string(),
			selector: z.string(),
			files: z.array(z.string()).min(1),
			targetId: z.string().optional(),
		},
		async ({ processId, selector, files, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(
					await setFileInput(proc, { selector, files, targetId }),
				);
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"emulate",
		"Device metrics / UA / geolocation / media emulation (or clear=true to reset)",
		{
			processId: z.string(),
			targetId: z.string().optional(),
			clear: z.boolean().optional(),
			metrics: z
				.object({
					width: z.number().int().positive(),
					height: z.number().int().positive(),
					deviceScaleFactor: z.number().positive().optional(),
					mobile: z.boolean().optional(),
				})
				.optional(),
			userAgent: z.string().optional(),
			geolocation: z
				.object({
					latitude: z.number(),
					longitude: z.number(),
					accuracy: z.number().optional(),
				})
				.optional(),
			media: z.string().optional().describe('e.g. "print" or "screen"'),
		},
		async ({ processId, targetId, clear, metrics, userAgent, geolocation, media }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(
					await emulate(proc, {
						targetId,
						clear,
						metrics,
						userAgent,
						geolocation,
						media,
					}),
				);
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"start_screencast",
		"Start Page.startScreencast; buffers up to maxFrames (ack frames). Pair with stop_screencast.",
		{
			processId: z.string(),
			targetId: z.string().optional(),
			maxFrames: z.number().int().positive().max(30).optional(),
			everyNthFrame: z.number().int().positive().optional(),
			format: z.enum(["png", "jpeg"]).optional(),
			quality: z.number().int().min(0).max(100).optional(),
		},
		async ({ processId, targetId, maxFrames, everyNthFrame, format, quality }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(
					await startScreencast(proc, {
						targetId,
						maxFrames,
						everyNthFrame,
						format,
						quality,
					}),
				);
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"stop_screencast",
		"Stop screencast; optionally write last frame PNG/JPEG to path",
		{
			processId: z.string(),
			path: z.string().optional(),
		},
		async ({ processId, path: filePath }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await stopScreencast(proc, filePath);
				const { lastFrameBase64, ...rest } = result;
				if (lastFrameBase64 && !filePath) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{ ...rest, lastFrameBase64: "[see image]" },
									null,
									2,
								),
							},
							{
								type: "image" as const,
								data: lastFrameBase64,
								mimeType: "image/png",
							},
						],
					};
				}
				return textResult(rest);
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"set_breakpoint",
		"Debugger.setBreakpointByUrl (0-based lineNumber). Keep debugger enabled while BPs exist.",
		{
			processId: z.string(),
			lineNumber: z.number().int().nonnegative(),
			url: z.string().optional(),
			urlRegex: z.string().optional(),
			columnNumber: z.number().int().nonnegative().optional(),
			targetId: z.string().optional(),
		},
		async ({ processId, lineNumber, url, urlRegex, columnNumber, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(
					await setBreakpointByUrl(proc, {
						lineNumber,
						url,
						urlRegex,
						columnNumber,
						targetId,
					}),
				);
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"remove_breakpoint",
		"Debugger.removeBreakpoint by breakpointId from set_breakpoint",
		{
			processId: z.string(),
			breakpointId: z.string(),
			targetId: z.string().optional(),
		},
		async ({ processId, breakpointId, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(await removeBreakpoint(proc, breakpointId, targetId));
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"resolve_stack",
		"Resolve stack frames to source snippets (Debugger.getScriptSource / file://)",
		{
			processId: z.string(),
			frames: z
				.array(
					z.object({
						url: z.string().optional(),
						scriptId: z.string().optional(),
						lineNumber: z.number().int(),
						columnNumber: z.number().int().optional(),
						functionName: z.string().optional(),
					}),
				)
				.min(1),
			contextLines: z.number().int().nonnegative().max(20).optional(),
			targetId: z.string().optional(),
		},
		async ({ processId, frames, contextLines, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(
					await resolveStack(proc, { frames, contextLines, targetId }),
				);
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"perf_audit",
		"Lighthouse-lite: Performance.getMetrics + nav/paint timing + recent Audits issues (not full Lighthouse)",
		{
			processId: z.string(),
			targetId: z.string().optional(),
			includeAudits: z.boolean().optional(),
			includeNavTiming: z.boolean().optional(),
		},
		async ({ processId, targetId, includeAudits, includeNavTiming }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(
					await runPerfAudit(proc, { targetId, includeAudits, includeNavTiming }),
				);
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"capture_mhtml",
		"Save page as MHTML via Page.captureSnapshot",
		{
			processId: z.string(),
			path: z.string().optional(),
			targetId: z.string().optional(),
		},
		async ({ processId, path: filePath, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(await captureMhtml(proc, filePath, targetId));
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"virtual_clock",
		"Emulation.setVirtualTimePolicy — pause / advance virtual time (use budget when advancing)",
		{
			processId: z.string(),
			policy: z.enum(["pause", "advance", "pauseIfNetworkFetchesPending"]),
			budget: z.number().positive().optional().describe("Virtual ms to grant when advancing"),
			targetId: z.string().optional(),
		},
		async ({ processId, policy, budget, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(await setVirtualClock(proc, { policy, budget, targetId }));
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"print_pdf",
		"Write the page to a PDF. Uses Page.printToPDF, and falls back to webContents.printToPDF when that method is missing (needs inspectMain). printBackground defaults to true.",
		{
			processId: z.string(),
			path: z.string().optional(),
			landscape: z.boolean().optional(),
			printBackground: z.boolean().optional(),
			targetId: z.string().optional(),
		},
		async ({ processId, path: filePath, landscape, printBackground, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(await printPdf(proc, { path: filePath, landscape, printBackground, targetId }));
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);
}
