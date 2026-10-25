import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, textResult, withProcess, requireRunningProcess } from "../tool-helpers.js";
import { registerArtifact } from "../artifacts.js";
import {
	redactSecretsDeep,
	redactSecretsString,
	ensureMonitoring,
	getProcess,
} from "../process-manager.js";
import {
	blockUrls,
	clearNetworkStubs,
	emulateNetwork,
	exportHar,
	getDownloads,
	getResponseBody,
	networkStub,
	setExtraHeaders,
	waitNetworkIdle,
} from "../power-tools.js";
import { runOfflineResilienceCheck } from "../composite-tools.js";

export function registerNetworkTools(server: McpServer) {
	registerTool(
		server,
		"get_network_log",
		{
			description:
				"Get buffered network request/response events captured via CDP Network domain. Supports optional filtering by tail, status code, failure status, or URL pattern.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				tail: z.number().int().positive().optional(),
				status: z
					.number()
					.int()
					.optional()
					.describe("Optional HTTP status filter (e.g. 404, 500)"),
				failedOnly: z
					.boolean()
					.optional()
					.describe("If true, only return requests that failed or responded with status >= 400"),
				urlPattern: z
					.string()
					.optional()
					.describe("Optional URL substring or glob filter"),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ processId, tail, status, failedOnly, urlPattern }) => {
			try {
				const proc = requireRunningProcess(processId);
				if (proc.status === "running") {
					await ensureMonitoring(proc);
				}
				let entries = proc.networkEntries;

				if (status !== undefined) {
					entries = entries.filter((e) => e.status === status);
				}
				if (failedOnly) {
					entries = entries.filter(
						(e) => Boolean((e as any).failed || (typeof e.status === "number" && e.status >= 400) || (e as any).errorText),
					);
				}
				if (urlPattern) {
					const clean = urlPattern.toLowerCase();
					entries = entries.filter((e) => (e.url || "").toLowerCase().includes(clean));
				}
				if (tail && tail > 0) {
					entries = entries.slice(-tail);
				}

				if (proc.redactedSecrets && proc.redactedSecrets.size > 0) {
					entries = redactSecretsDeep(entries, proc.redactedSecrets);
				}
				return textResult({ processId: proc.id, count: entries.length, entries });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	registerTool(
		server,
		"get_response_body",
		{
			description:
				"Fetch body for a buffered network requestId (call after Network.loadingFinished)",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				requestId: z.string(),
				targetId: z.string().optional(),
			},
			annotations: { readOnlyHint: true },
		},
		withProcess(async (proc, { requestId, targetId }) => {
			const result = await getResponseBody(proc, requestId, targetId);
			return { processId: proc.id, ...result };
		}),
	);

	registerTool(
		server,
		"block_urls",
		{
			description:
				"Block URL patterns via Network.setBlockedURLs (e.g. *.analytics.com/*)",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				urls: z.array(z.string()).describe("URL patterns to block"),
				targetId: z.string().optional(),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, { urls, targetId }) => {
			const result = await blockUrls(proc, urls, targetId);
			return { processId: proc.id, ...result };
		}),
	);

	registerTool(
		server,
		"set_extra_headers",
		{
			description:
				"Set extra HTTP headers for subsequent requests (Network.setExtraHTTPHeaders)",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				headers: z.record(z.string()),
				targetId: z.string().optional(),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, { headers, targetId }) => {
			const result = await setExtraHeaders(proc, headers, targetId);
			return { processId: proc.id, ...result };
		}),
	);

	registerTool(
		server,
		"network_stub",
		{
			description:
				"Intercept matching URLs via Fetch and fulfill or fail them. Replaces a rule with the same urlPattern. Pair with clear_network_stubs.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				urlPattern: z
					.string()
					.describe('CDP urlPattern; * is a wildcard, e.g. "*api/users*"'),
				action: z.enum(["fulfill", "fail"]),
				status: z.number().int().min(0).max(599).optional(),
				body: z.string().optional(),
				contentType: z.string().optional(),
				headers: z.record(z.string()).optional(),
				errorReason: z
					.enum([
						"Failed",
						"Aborted",
						"TimedOut",
						"BlockedByClient",
						"NameNotResolved",
					])
					.optional(),
				targetId: z.string().optional(),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, {
			urlPattern,
			action,
			status,
			body,
			contentType,
			headers,
			errorReason,
			targetId,
		}) => {
			return await networkStub(proc, {
				urlPattern,
				action,
				status,
				body,
				contentType,
				headers,
				errorReason,
				targetId,
			});
		}),
	);

	registerTool(
		server,
		"clear_network_stubs",
		{
			description:
				"Disable Fetch interception and drop stub rules for this session",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc) => {
			return await clearNetworkStubs(proc);
		}),
	);

	registerTool(
		server,
		"wait_network_idle",
		{
			description:
				"Wait until no network request is in flight and the log has been quiet for idleMs",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				idleMs: z.number().int().positive().max(10_000).optional(),
				timeoutMs: z.number().int().positive().max(30_000).optional(),
				targetId: z.string().optional(),
			},
			annotations: { readOnlyHint: true },
		},
		withProcess(async (proc, { idleMs, timeoutMs, targetId }) => {
			return await waitNetworkIdle(proc, { idleMs, timeoutMs, targetId });
		}),
	);

	registerTool(
		server,
		"export_har",
		{
			description:
				"Write the buffered network log as HAR 1.2 JSON (method, URL, status; no bodies). Also exposes the file as an artifact resource.",
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
			const res = await exportHar(proc, filePath);
			if (res.path) {
				const art = registerArtifact(proc.id, "har", res.path);
				return { ...res, artifactUri: `electron://artifact/${art.id}` };
			}
			return res;
		}),
	);

	registerTool(
		server,
		"emulate_network",
		{
			description:
				"Set the page offline, or slow it with latency and throughput in bytes per second. clear:true restores a normal network. Does not change viewport, user agent, geolocation, or media; use emulate for those.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				offline: z.boolean().optional().describe("true makes navigator.onLine false and fails fetches"),
				latencyMs: z.number().nonnegative().optional().describe("Added round-trip latency in milliseconds"),
				downloadThroughput: z.number().optional().describe("Max download bytes/sec. -1 means unlimited"),
				uploadThroughput: z.number().optional().describe("Max upload bytes/sec. -1 means unlimited"),
				clear: z.boolean().optional(),
				targetId: z.string().optional(),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, { offline, latencyMs, downloadThroughput, uploadThroughput, clear, targetId }) => {
			return await emulateNetwork(proc, {
				offline,
				latencyMs,
				downloadThroughput,
				uploadThroughput,
				clear,
				targetId,
			});
		}),
	);

	registerTool(
		server,
		"get_downloads",
		{
			description:
				"Arm download capture and list files saved by the app. Requires inspectMain. The first call installs a will-download listener that writes into directory (default: OS temp) and suppresses the save dialog. Call it before the download starts, then call again for savePath.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				directory: z
					.string()
					.optional()
					.describe("Directory for saved files. Used when the listener is first armed."),
				url: z
					.string()
					.optional()
					.describe("Optional URL to start downloading on the app session after the listener is armed"),
			},
			annotations: { destructiveHint: false },
		},
		withProcess(async (proc, { directory, url }) => {
			const res = await getDownloads(proc, { directory, url });
			if (typeof res.savePath === "string") {
				registerArtifact(proc.id, "other", res.savePath);
			}
			return res;
		}),
	);

	registerTool(
		server,
		"network_failure_report",
		{
			description:
				"Composite network diagnostics: gathers all failed HTTP requests (status >= 400 or failed requests), fetches response bodies inline, and exports a HAR artifact.",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				urlPattern: z
					.string()
					.optional()
					.describe("Optional URL substring or pattern filter"),
				tail: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Optional limit of recent failures to return"),
				exportHarFile: z
					.boolean()
					.optional()
					.describe("Whether to export a HAR file (default: true)"),
				harPath: z
					.string()
					.optional()
					.describe("Optional path for the exported HAR file"),
			},
			annotations: { readOnlyHint: false, idempotentHint: true },
		},
		withProcess(async (proc, { urlPattern, tail, exportHarFile, harPath }) => {
			if (proc.status === "running") {
				await ensureMonitoring(proc);
			}
			let failures = proc.networkEntries.filter(
				(e) => Boolean((e as any).failed || (typeof e.status === "number" && e.status >= 400) || (e as any).errorText),
			);
			if (urlPattern) {
				const clean = urlPattern.toLowerCase();
				failures = failures.filter((e) => (e.url || "").toLowerCase().includes(clean));
			}
			if (tail && tail > 0) {
				failures = failures.slice(-tail);
			}

			const failuresWithBodies = await Promise.all(
				failures.map(async (entry) => {
					let bodyInfo: { body?: string; base64Encoded?: boolean; error?: string } = {};
					if (entry.requestId) {
						try {
							const res = await getResponseBody(proc, entry.requestId, (entry as any).targetId);
							bodyInfo = { body: res.body, base64Encoded: res.base64Encoded };
						} catch (err) {
							bodyInfo = { error: err instanceof Error ? err.message : String(err) };
						}
					}
					return {
						...entry,
						responseBody: bodyInfo.body,
						responseError: bodyInfo.error,
					};
				}),
			);

			let harResult: unknown = undefined;
			if (exportHarFile !== false) {
				const har = await exportHar(proc, harPath);
				const art = registerArtifact(proc.id, "har", har.path);
				harResult = { ...har, artifactUri: `electron://artifact/${art.id}` };
			}

			const report = {
				processId: proc.id,
				failureCount: failuresWithBodies.length,
				failures: failuresWithBodies,
				har: harResult,
			};

			if (proc.redactedSecrets && proc.redactedSecrets.size > 0) {
				return redactSecretsDeep(report, proc.redactedSecrets);
			}
			return report;
		}),
	);

	registerTool(
		server,
		"offline_resilience_check",
		{
			description:
				"Audit how gracefully the Electron app handles network loss, high latency, or HTTP 500 server faults during interactions. Emulates faults, checks for crashes or unhandled rejections, restores network, and computes a Resilience Grade (A-F).",
			params: {
				processId: z
					.string()
					.optional()
					.describe("Process ID. If omitted, uses the single running app."),
				faultType: z
					.enum(["offline", "latency", "http500"])
					.optional()
					.describe("Type of network disruption to simulate (default 'offline')"),
				action: z
					.object({
						type: z.enum(["click", "navigate", "type_text"]),
						selector: z.string().optional(),
						url: z.string().optional(),
						text: z.string().optional(),
					})
					.optional()
					.describe("Optional user action to trigger during network disruption"),
				urlPattern: z
					.string()
					.optional()
					.describe("URL pattern to intercept/fault (default '*')"),
				durationMs: z
					.number()
					.int()
					.positive()
					.max(10_000)
					.optional()
					.describe("Disruption window duration in ms (default 1000)"),
				targetId: z.string().optional(),
			},
			annotations: { destructiveHint: false, openWorldHint: true },
		},
		withProcess(async (proc, { faultType, action, urlPattern, durationMs, targetId }) => {
			return await runOfflineResilienceCheck(proc, { faultType, action, urlPattern, durationMs, targetId });
		}),
	);
}

