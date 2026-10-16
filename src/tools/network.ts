import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { textResult, requireRunningProcess } from "../tool-helpers.js";
import { log } from "../log.js";
import {
	ensureMonitoring,
	getProcess,
} from "../process-manager.js";
import {
	blockUrls,
	clearNetworkStubs,
	emulate,
	emulateNetwork,
	exportHar,
	getDownloads,
	getResponseBody,
	networkStub,
	setExtraHeaders,
	waitNetworkIdle,
} from "../power-tools.js";

export function registerNetworkTools(server: McpServer) {
	server.tool(
		"get_network_log",
		"Get buffered network request/response events captured via CDP Network domain",
		{
			processId: z.string(),
			tail: z.number().int().positive().optional(),
		},
		async ({ processId, tail }) => {
			const proc = getProcess(processId);
			if (!proc) {
				return textResult(`Process not found: ${processId}`, true);
			}
			try {
				if (proc.status === "running") {
					await ensureMonitoring(proc);
				}
				const entries = tail
					? proc.networkEntries.slice(-tail)
					: proc.networkEntries;
				return textResult({ processId, count: entries.length, entries });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"get_response_body",
		"Fetch body for a buffered network requestId (call after Network.loadingFinished)",
		{
			processId: z.string(),
			requestId: z.string(),
			targetId: z.string().optional(),
		},
		async ({ processId, requestId, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await getResponseBody(proc, requestId, targetId);
				return textResult({ processId, ...result });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"block_urls",
		"Block URL patterns via Network.setBlockedURLs (e.g. *.analytics.com/*)",
		{
			processId: z.string(),
			urls: z.array(z.string()).describe("URL patterns to block"),
			targetId: z.string().optional(),
		},
		async ({ processId, urls, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await blockUrls(proc, urls, targetId);
				return textResult({ processId, ...result });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"set_extra_headers",
		"Set extra HTTP headers for subsequent requests (Network.setExtraHTTPHeaders)",
		{
			processId: z.string(),
			headers: z.record(z.string()),
			targetId: z.string().optional(),
		},
		async ({ processId, headers, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				const result = await setExtraHeaders(proc, headers, targetId);
				return textResult({ processId, ...result });
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"network_stub",
		"Intercept matching URLs via Fetch and fulfill or fail them. Replaces a rule with the same urlPattern. Pair with clear_network_stubs.",
		{
			processId: z.string(),
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
		async ({
			processId,
			urlPattern,
			action,
			status,
			body,
			contentType,
			headers,
			errorReason,
			targetId,
		}) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(
					await networkStub(proc, {
						urlPattern,
						action,
						status,
						body,
						contentType,
						headers,
						errorReason,
						targetId,
					}),
				);
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"clear_network_stubs",
		"Disable Fetch interception and drop stub rules for this session",
		{
			processId: z.string(),
		},
		async ({ processId }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(await clearNetworkStubs(proc));
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"wait_network_idle",
		"Wait until no network request is in flight and the log has been quiet for idleMs",
		{
			processId: z.string(),
			idleMs: z.number().int().positive().max(10_000).optional(),
			timeoutMs: z.number().int().positive().max(30_000).optional(),
			targetId: z.string().optional(),
		},
		async ({ processId, idleMs, timeoutMs, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(
					await waitNetworkIdle(proc, { idleMs, timeoutMs, targetId }),
				);
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"export_har",
		"Write the buffered network log as HAR 1.2 JSON (method, URL, status; no bodies)",
		{
			processId: z.string(),
			path: z.string().optional(),
		},
		async ({ processId, path: filePath }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(await exportHar(proc, filePath));
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"emulate_network",
		"Set the page offline, or slow it with latency and throughput in bytes per second. clear:true restores a normal network. Does not change viewport, user agent, geolocation, or media; use emulate for those.",
		{
			processId: z.string(),
			offline: z.boolean().optional().describe("true makes navigator.onLine false and fails fetches"),
			latencyMs: z.number().nonnegative().optional().describe("Added round-trip latency in milliseconds"),
			downloadThroughput: z.number().optional().describe("Max download bytes/sec. -1 means unlimited"),
			uploadThroughput: z.number().optional().describe("Max upload bytes/sec. -1 means unlimited"),
			clear: z.boolean().optional(),
			targetId: z.string().optional(),
		},
		async ({ processId, offline, latencyMs, downloadThroughput, uploadThroughput, clear, targetId }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(
					await emulateNetwork(proc, {
						offline,
						latencyMs,
						downloadThroughput,
						uploadThroughput,
						clear,
						targetId,
					}),
				);
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);

	server.tool(
		"get_downloads",
		"Arm download capture and list files saved by the app. Requires inspectMain. The first call installs a will-download listener that writes into directory (default: OS temp) and suppresses the save dialog. Call it before the download starts, then call again for savePath.",
		{
			processId: z.string(),
			directory: z
				.string()
				.optional()
				.describe("Directory for saved files. Used when the listener is first armed."),
			url: z
				.string()
				.optional()
				.describe("Optional URL to start downloading on the app session after the listener is armed"),
		},
		async ({ processId, directory, url }) => {
			try {
				const proc = requireRunningProcess(processId);
				return textResult(await getDownloads(proc, { directory, url }));
			} catch (err) {
				return textResult(err instanceof Error ? err.message : String(err), true);
			}
		},
	);
}
