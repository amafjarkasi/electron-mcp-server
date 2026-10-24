import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, textResult, withProcess, requireRunningProcess } from "../tool-helpers.js";
import { registerArtifact } from "../artifacts.js";
import {
	pickPageTarget,
	executeCDPCommand,
	startTracing,
	stopTracing,
} from "../process-manager.js";
import {
	checkMemoryLeaks,
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
	registerTool(
		server,
		"start_tracing",
		{
			description:
				"Start Chrome DevTools Protocol performance tracing (pair with stop_tracing)",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				categories: z
					.string()
					.optional()
					.describe(
						"Comma-separated CDP trace categories (default: timeline + v8)",
					),
				targetId: z.string().optional(),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, { categories, targetId }) => {
			return await startTracing(proc, { categories, targetId });
		}),
	);

	registerTool(
		server,
		"stop_tracing",
		{
			description:
				"Stop CDP tracing and write a JSON trace file (open in chrome://tracing)",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				path: z
					.string()
					.optional()
					.describe("Output file path (default: OS temp dir)"),
			},
			annotations: { readOnlyHint: false, idempotentHint: true },
		},
		withProcess(async (proc, { path: filePath }) => {
			const result = await stopTracing(proc, filePath);
			if (result && typeof result === "object" && "path" in result && (result as any).path) {
				const art = registerArtifact(proc.id, "trace", (result as any).path);
				return { ...result, artifactUri: `electron://artifact/${art.id}` };
			}
			return result;
		}),
	);

	registerTool(
		server,
		"get_performance_metrics",
		{
			description:
				"Renderer Performance.getMetrics (JS heap, layout count, task duration, …)",
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
			const result = await getPerformanceMetrics(proc, targetId);
			return { processId: proc.id, ...result };
		}),
	);

	registerTool(
		server,
		"start_cpu_profile",
		{
			description:
				"Start V8 CPU profiler on a page target (pair with stop_cpu_profile)",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				targetId: z.string().optional(),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, { targetId }) => {
			return await startCpuProfile(proc, targetId);
		}),
	);

	registerTool(
		server,
		"stop_cpu_profile",
		{
			description:
				"Stop CPU profiler and write a .cpuprofile JSON file",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				path: z.string().optional().describe("Output path (default: OS temp)"),
			},
			annotations: { readOnlyHint: false, idempotentHint: true },
		},
		withProcess(async (proc, { path: filePath }) => {
			const result = await stopCpuProfile(proc, filePath);
			if (result?.path) {
				const art = registerArtifact(proc.id, "cpuprofile", result.path);
				return { ...result, artifactUri: `electron://artifact/${art.id}` };
			}
			return result;
		}),
	);

	registerTool(
		server,
		"heap_snapshot",
		{
			description:
				"Take a V8 heap snapshot (.heapsnapshot) for leak investigation",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				path: z.string().optional(),
				targetId: z.string().optional(),
			},
			annotations: { readOnlyHint: false, idempotentHint: true },
		},
		withProcess(async (proc, { path: filePath, targetId }) => {
			const result = await takeHeapSnapshot(proc, filePath, targetId);
			if (result?.path) {
				const art = registerArtifact(proc.id, "heapsnapshot", result.path);
				return { ...result, artifactUri: `electron://artifact/${art.id}` };
			}
			return result;
		}),
	);

	registerTool(
		server,
		"diff_screenshot",
		{
			description:
				"Capture (or compare) a screenshot against a baseline PNG; reports identical + byte similarity",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				baselinePath: z.string(),
				currentPath: z
					.string()
					.optional()
					.describe("Existing PNG to compare; if omitted, captures fresh"),
				selector: z.string().optional(),
				targetId: z.string().optional(),
			},
			annotations: { readOnlyHint: true },
		},
		withProcess(async (proc, { baselinePath, currentPath, selector, targetId }) => {
			return await diffScreenshot(proc, {
				baselinePath,
				currentPath,
				selector,
				targetId,
			});
		}),
	);

	registerTool(
		server,
		"get_audit_issues",
		{
			description:
				"Buffered Chromium Audits issues (cookie/CORS/mixed-content/deprecations) captured since attach",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				tail: z.number().int().positive().optional(),
			},
			annotations: { readOnlyHint: true },
		},
		withProcess(async (proc, { tail }) => {
			return getAuditIssues(proc, tail);
		}),
	);

	registerTool(
		server,
		"start_coverage",
		{
			description:
				"Start JS precise coverage (optional CSS rule usage). Pair with stop_coverage.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				targetId: z.string().optional(),
				css: z.boolean().optional().describe("Also track CSS rule usage"),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, { targetId, css }) => {
			return await startCoverage(proc, { targetId, css });
		}),
	);

	registerTool(
		server,
		"stop_coverage",
		{
			description:
				"Stop coverage and return JS (and optional CSS) coverage data; optionally write JSON",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				path: z.string().optional(),
			},
			annotations: { readOnlyHint: false, idempotentHint: true },
		},
		withProcess(async (proc, { path: filePath }) => {
			return await stopCoverage(proc, filePath);
		}),
	);

	registerTool(
		server,
		"set_file_input",
		{
			description:
				"Set files on an <input type=file> via DOM.setFileInputFiles (host paths)",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				selector: z.string(),
				files: z.array(z.string()).min(1),
				targetId: z.string().optional(),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, { selector, files, targetId }) => {
			return await setFileInput(proc, { selector, files, targetId });
		}),
	);

	registerTool(
		server,
		"emulate",
		{
			description:
				"Device metrics / UA / geolocation / media emulation (or clear=true to reset)",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
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
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, { targetId, clear, metrics, userAgent, geolocation, media }) => {
			return await emulate(proc, {
				targetId,
				clear,
				metrics,
				userAgent,
				geolocation,
				media,
			});
		}),
	);

	registerTool(
		server,
		"start_screencast",
		{
			description:
				"Start Page.startScreencast; buffers up to maxFrames (ack frames). Pair with stop_screencast.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				targetId: z.string().optional(),
				maxFrames: z.number().int().positive().max(30).optional(),
				everyNthFrame: z.number().int().positive().optional(),
				format: z.enum(["png", "jpeg"]).optional(),
				quality: z.number().int().min(0).max(100).optional(),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, { targetId, maxFrames, everyNthFrame, format, quality }) => {
			return await startScreencast(proc, {
				targetId,
				maxFrames,
				everyNthFrame,
				format,
				quality,
			});
		}),
	);

	registerTool(
		server,
		"stop_screencast",
		{
			description:
				"Stop screencast; optionally write last frame PNG/JPEG to path",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				path: z.string().optional(),
			},
			annotations: { readOnlyHint: false },
		},
		async ({ processId, path: filePath }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await stopScreencast(proc, filePath);
				const { lastFrameBase64, ...rest } = result;
				if (filePath && result.path) {
					registerArtifact(proc.id, "screenshot", result.path);
				}
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

	registerTool(
		server,
		"set_breakpoint",
		{
			description:
				"Debugger.setBreakpointByUrl (0-based lineNumber). Keep debugger enabled while BPs exist.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				lineNumber: z.number().int().nonnegative(),
				url: z.string().optional(),
				urlRegex: z.string().optional(),
				columnNumber: z.number().int().nonnegative().optional(),
				targetId: z.string().optional(),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, { lineNumber, url, urlRegex, columnNumber, targetId }) => {
			return await setBreakpointByUrl(proc, {
				lineNumber,
				url,
				urlRegex,
				columnNumber,
				targetId,
			});
		}),
	);

	registerTool(
		server,
		"remove_breakpoint",
		{
			description:
				"Debugger.removeBreakpoint by breakpointId from set_breakpoint",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				breakpointId: z.string(),
				targetId: z.string().optional(),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, { breakpointId, targetId }) => {
			return await removeBreakpoint(proc, breakpointId, targetId);
		}),
	);

	registerTool(
		server,
		"resolve_stack",
		{
			description:
				"Resolve stack frames to source snippets (Debugger.getScriptSource / file://)",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
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
			annotations: { readOnlyHint: true },
		},
		withProcess(async (proc, { frames, contextLines, targetId }) => {
			return await resolveStack(proc, { frames, contextLines, targetId });
		}),
	);

	registerTool(
		server,
		"perf_audit",
		{
			description:
				"Lighthouse-lite: Performance.getMetrics + nav/paint timing + recent Audits issues (not full Lighthouse)",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				targetId: z.string().optional(),
				includeAudits: z.boolean().optional(),
				includeNavTiming: z.boolean().optional(),
			},
			annotations: { readOnlyHint: true },
		},
		withProcess(async (proc, { targetId, includeAudits, includeNavTiming }) => {
			return await runPerfAudit(proc, { targetId, includeAudits, includeNavTiming });
		}),
	);

	registerTool(
		server,
		"capture_mhtml",
		{
			description:
				"Save page as MHTML via Page.captureSnapshot. Also registers the file as an artifact resource.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				path: z.string().optional(),
				targetId: z.string().optional(),
			},
			annotations: { readOnlyHint: false, idempotentHint: true },
		},
		withProcess(async (proc, { path: filePath, targetId }) => {
			const res = await captureMhtml(proc, filePath, targetId);
			if (res?.path) {
				const art = registerArtifact(proc.id, "mhtml", res.path);
				return { ...res, artifactUri: `electron://artifact/${art.id}` };
			}
			return res;
		}),
	);

	registerTool(
		server,
		"virtual_clock",
		{
			description:
				"Emulation.setVirtualTimePolicy — pause / advance virtual time (use budget when advancing)",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				policy: z.enum(["pause", "advance", "pauseIfNetworkFetchesPending"]),
				budget: z.number().positive().optional().describe("Virtual ms to grant when advancing"),
				targetId: z.string().optional(),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, { policy, budget, targetId }) => {
			return await setVirtualClock(proc, { policy, budget, targetId });
		}),
	);

	registerTool(
		server,
		"print_pdf",
		{
			description:
				"Write the page to a PDF. Uses Page.printToPDF, and falls back to webContents.printToPDF when that method is missing (needs inspectMain). printBackground defaults to true. Also registers as an artifact resource.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				path: z.string().optional(),
				landscape: z.boolean().optional(),
				printBackground: z.boolean().optional(),
				targetId: z.string().optional(),
			},
			annotations: { readOnlyHint: false, idempotentHint: true },
		},
		withProcess(async (proc, { path: filePath, landscape, printBackground, targetId }) => {
			const res = await printPdf(proc, { path: filePath, landscape, printBackground, targetId });
			if (res?.path) {
				const art = registerArtifact(proc.id, "pdf", res.path);
				return { ...res, artifactUri: `electron://artifact/${art.id}` };
			}
			return res;
		}),
	);

	registerTool(
		server,
		"perf_snapshot",
		{
			description:
				"Composite performance profiler: coordinates start_tracing + start_cpu_profile + start_coverage, optionally captures an interaction or reload, stops all collectors, and bundles perf audit, metrics, and artifact URIs.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				durationMs: z
					.number()
					.int()
					.positive()
					.max(60000)
					.optional()
					.describe("Capture window duration in milliseconds (default: 1000)"),
				reload: z
					.boolean()
					.optional()
					.describe("If true, reloads the current page during trace capture"),
				targetId: z.string().optional(),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, { durationMs, reload: shouldReload, targetId }) => {
			const dur = Math.max(100, Math.min(durationMs ?? 1000, 30000));
			await Promise.all([
				startTracing(proc, { targetId }),
				startCpuProfile(proc, targetId),
				startCoverage(proc, { css: true, targetId }),
			]);

			if (shouldReload) {
				const target = pickPageTarget(proc, targetId);
				await executeCDPCommand(proc, target.id, "Page.reload", {});
			}
			await new Promise((r) => setTimeout(r, dur));

			const [traceRes, cpuRes, covRes, auditRes, metricsRes] = await Promise.all([
				stopTracing(proc).catch((e) => ({ error: String(e) })),
				stopCpuProfile(proc, undefined).catch((e) => ({ error: String(e) })),
				stopCoverage(proc, targetId).catch((e) => ({ error: String(e) })),
				runPerfAudit(proc, { targetId, includeAudits: true, includeNavTiming: true }).catch((e) => ({ error: String(e) })),
				getPerformanceMetrics(proc, targetId).catch((e) => ({ error: String(e) })),
			]);

			let traceArtifactUri: string | undefined;
			let cpuArtifactUri: string | undefined;
			if (traceRes && typeof traceRes === "object" && (traceRes as any).path) {
				const art = registerArtifact(proc.id, "trace", (traceRes as any).path);
				traceArtifactUri = `electron://artifact/${art.id}`;
			}
			if (cpuRes && typeof cpuRes === "object" && (cpuRes as any).path) {
				const art = registerArtifact(proc.id, "cpuprofile", (cpuRes as any).path);
				cpuArtifactUri = `electron://artifact/${art.id}`;
			}

			return {
				processId: proc.id,
				durationMs: dur,
				trace: { ...(traceRes as any), ...(traceArtifactUri ? { artifactUri: traceArtifactUri } : {}) },
				cpuProfile: { ...(cpuRes as any), ...(cpuArtifactUri ? { artifactUri: cpuArtifactUri } : {}) },
				coverage: covRes,
				perfAudit: auditRes,
				metrics: (metricsRes as any)?.metrics ?? metricsRes,
			};
		}),
	);

	registerTool(
		server,
		"leak_check",
		{
			description:
				"Memory leak detector: triggers garbage collection, measures baseline DOM and heap counters, repeats an action or wait, runs GC again, and reports retained node/listener/heap growth.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				iterations: z
					.number()
					.int()
					.positive()
					.max(20)
					.optional()
					.describe("Number of test action iterations (default: 3)"),
				actionScript: z
					.string()
					.optional()
					.describe("Optional JavaScript expression evaluated in the renderer on each iteration"),
				targetId: z.string().optional(),
				captureSnapshots: z
					.boolean()
					.optional()
					.describe("Whether to capture heap snapshot files before and after (default: false)"),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, { iterations, actionScript, targetId, captureSnapshots }) => {
			const res = await checkMemoryLeaks(proc, { iterations, actionScript, targetId, captureSnapshots });
			if (res.baselineSnapshotUri) {
				const art = registerArtifact(proc.id, "heapsnapshot", res.baselineSnapshotUri);
				res.baselineSnapshotUri = `electron://artifact/${art.id}`;
			}
			if (res.finalSnapshotUri) {
				const art = registerArtifact(proc.id, "heapsnapshot", res.finalSnapshotUri);
				res.finalSnapshotUri = `electron://artifact/${art.id}`;
			}
			return res;
		}),
	);
}

