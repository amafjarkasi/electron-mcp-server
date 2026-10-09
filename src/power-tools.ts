/**
 * Creative CDP / Electron power tools layered on process-manager primitives.
 * Hardened: timeouts, session cleanup on stop/forget, bounded payloads.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
	type ElectronProcess,
	type IpcEntry,
	type NetworkEntry,
	captureScreenshot,
	connectToCDPTarget,
	ensureMonitoring,
	evaluateMain,
	executeCDPCommand,
	getPageInfo,
	getProcess,
	pickPageTarget,
	pushCapped,
	registerProcessCleanup,
	listTargetsByRole,
	saveScreenshot,
	updateCDPTargets,
	validateOutputPath,
	withTimeout,
} from "./process-manager.js";
import { log } from "./log.js";

const MAX_IPC = 500;
const DEFAULT_AX_NODES = 400;
const HEAP_TIMEOUT_MS = 60_000;
const CDP_TIMEOUT_MS = 20_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type CpuSession = {
	targetId: string;
	startedAt: number;
	/** Set while CDP start is in flight to serialize concurrent starts. */
	starting?: boolean;
};

const cpuProfileSessions = new Map<string, CpuSession>();

registerProcessCleanup((processId) => {
	const session = cpuProfileSessions.get(processId);
	cpuProfileSessions.delete(processId);
	if (!session || session.starting) return;
	// Best-effort stop for attach/detach (owned apps are dying anyway).
	void (async () => {
		try {
			const proc = getProcess(processId);
			if (!proc || proc.status !== "running") return;
			await executeCDPCommand(
				proc,
				session.targetId,
				"Profiler.stop",
				{},
				5_000,
			).catch(() => undefined);
			await executeCDPCommand(
				proc,
				session.targetId,
				"Profiler.disable",
				{},
				5_000,
			).catch(() => undefined);
		} catch {
			// ignore
		}
	})();
});

async function cdpTimed(
	electronProcess: ElectronProcess,
	targetId: string,
	method: string,
	params: Record<string, unknown> = {},
	ms = CDP_TIMEOUT_MS,
): Promise<unknown> {
	// executeCDPCommand already applies a timeout; pass through for clarity.
	return executeCDPCommand(electronProcess, targetId, method, params, ms);
}

function isPng(buf: Buffer): boolean {
	return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
}

/** Accessibility tree snapshot (roles / names / backend ids). */
export async function getAccessibilitySnapshot(
	electronProcess: ElectronProcess,
	options: { depth?: number; targetId?: string; maxNodes?: number } = {},
): Promise<{
	targetId: string;
	nodeCount: number;
	truncated: boolean;
	nodes: Array<{
		nodeId?: string;
		role?: string;
		name?: string;
		description?: string;
		backendDOMNodeId?: number;
		ignored?: boolean;
	}>;
}> {
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, options.targetId);
	await cdpTimed(electronProcess, target.id, "Accessibility.enable", {});
	const result = (await cdpTimed(
		electronProcess,
		target.id,
		"Accessibility.getFullAXTree",
		options.depth != null ? { depth: options.depth } : {},
	)) as {
		nodes?: Array<{
			nodeId?: string;
			ignored?: boolean;
			backendDOMNodeId?: number;
			role?: { value?: string };
			name?: { value?: string };
			description?: { value?: string };
		}>;
	};
	const maxNodes = options.maxNodes ?? DEFAULT_AX_NODES;
	const raw = result.nodes ?? [];
	const truncated = raw.length > maxNodes;
	const slice = truncated ? raw.slice(0, maxNodes) : raw;
	const nodes = slice.map((n) => ({
		nodeId: n.nodeId,
		role: n.role?.value,
		name: n.name?.value,
		description: n.description?.value,
		backendDOMNodeId: n.backendDOMNodeId,
		ignored: n.ignored,
	}));
	return {
		targetId: target.id,
		nodeCount: nodes.length,
		truncated,
		nodes,
	};
}

/** One-shot agent vision: screenshot + page + errors + network failures. */
export async function getAppVision(
	electronProcess: ElectronProcess,
	options: { targetId?: string; includeScreenshot?: boolean } = {},
): Promise<Record<string, unknown>> {
	await ensureMonitoring(electronProcess);
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, options.targetId);

	let page: unknown;
	let pageError: string | undefined;
	try {
		page = await withTimeout(
			getPageInfo(electronProcess, target.id),
			CDP_TIMEOUT_MS,
			"vision/page_info",
		);
	} catch (err) {
		pageError = err instanceof Error ? err.message : String(err);
	}

	const errors = electronProcess.consoleMessages
		.filter(
			(m) =>
				m.level === "error" ||
				m.level === "assert" ||
				m.source === "exception",
		)
		.slice(-20);
	const failedNetwork = electronProcess.networkEntries
		.filter((e) => e.event === "failed" || (e.status != null && e.status >= 400))
		.slice(-20);
	const windows = (electronProcess.targets ?? [])
		.filter((t) => t.type === "page")
		.map((t) => ({ id: t.id, title: t.title, url: t.url }));

	const out: Record<string, unknown> = {
		processId: electronProcess.id,
		name: electronProcess.name,
		status: electronProcess.status,
		pid: electronProcess.pid,
		debugPort: electronProcess.debugPort,
		page: page ?? null,
		...(pageError ? { pageError } : {}),
		windows,
		consoleErrors: errors,
		networkFailures: failedNetwork,
		auditIssueCount: electronProcess.auditIssues.length,
		recentAuditIssues: electronProcess.auditIssues.slice(-10),
	};

	if (options.includeScreenshot !== false) {
		try {
			const shot = await withTimeout(
				captureScreenshot(electronProcess, target.id, "png"),
				CDP_TIMEOUT_MS,
				"vision/screenshot",
			);
			out.screenshot = {
				targetId: shot.targetId,
				mimeType: shot.mimeType,
				base64Length: shot.data.length,
				data: shot.data,
			};
		} catch (err) {
			out.screenshotError =
				err instanceof Error ? err.message : String(err);
		}
	}
	return out;
}

export async function getResponseBody(
	electronProcess: ElectronProcess,
	requestId: string,
	targetId?: string,
): Promise<{
	targetId: string;
	requestId: string;
	body: string;
	base64Encoded: boolean;
}> {
	if (!requestId?.trim()) {
		throw new Error("requestId is required");
	}
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, targetId);
	await cdpTimed(electronProcess, target.id, "Network.enable", {});
	const result = (await cdpTimed(
		electronProcess,
		target.id,
		"Network.getResponseBody",
		{ requestId },
	)) as { body?: string; base64Encoded?: boolean };
	return {
		targetId: target.id,
		requestId,
		body: result.body ?? "",
		base64Encoded: Boolean(result.base64Encoded),
	};
}

export async function blockUrls(
	electronProcess: ElectronProcess,
	urls: string[],
	targetId?: string,
): Promise<{ targetId: string; urls: string[] }> {
	if (!Array.isArray(urls)) {
		throw new Error("urls must be an array of patterns");
	}
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, targetId);
	await cdpTimed(electronProcess, target.id, "Network.enable", {});
	await cdpTimed(electronProcess, target.id, "Network.setBlockedURLs", {
		urls,
	});
	return { targetId: target.id, urls };
}

export async function setExtraHeaders(
	electronProcess: ElectronProcess,
	headers: Record<string, string>,
	targetId?: string,
): Promise<{ targetId: string; headers: Record<string, string> }> {
	if (!headers || typeof headers !== "object") {
		throw new Error("headers must be an object of string values");
	}
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, targetId);
	await cdpTimed(electronProcess, target.id, "Network.enable", {});
	await cdpTimed(electronProcess, target.id, "Network.setExtraHTTPHeaders", {
		headers,
	});
	return { targetId: target.id, headers };
}

export async function getPerformanceMetrics(
	electronProcess: ElectronProcess,
	targetId?: string,
): Promise<{ targetId: string; metrics: Record<string, number> }> {
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, targetId);
	await cdpTimed(electronProcess, target.id, "Performance.enable", {});
	const result = (await cdpTimed(
		electronProcess,
		target.id,
		"Performance.getMetrics",
		{},
	)) as { metrics?: Array<{ name: string; value: number }> };
	const metrics: Record<string, number> = {};
	for (const m of result.metrics ?? []) {
		metrics[m.name] = m.value;
	}
	return { targetId: target.id, metrics };
}

export async function startCpuProfile(
	electronProcess: ElectronProcess,
	targetId?: string,
): Promise<{ processId: string; targetId: string }> {
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, targetId);
	const existing = cpuProfileSessions.get(electronProcess.id);
	if (existing) {
		throw new Error(
			`CPU profile already active for ${electronProcess.id}. Call stop_cpu_profile first.`,
		);
	}
	// Reserve the slot before awaiting CDP so concurrent starts cannot race.
	cpuProfileSessions.set(electronProcess.id, {
		targetId: target.id,
		startedAt: Date.now(),
		starting: true,
	});
	try {
		await cdpTimed(electronProcess, target.id, "Profiler.enable", {});
		await cdpTimed(electronProcess, target.id, "Profiler.start", {});
		cpuProfileSessions.set(electronProcess.id, {
			targetId: target.id,
			startedAt: Date.now(),
		});
	} catch (err) {
		cpuProfileSessions.delete(electronProcess.id);
		try {
			await cdpTimed(electronProcess, target.id, "Profiler.disable", {});
		} catch {
			// ignore
		}
		throw err;
	}
	return { processId: electronProcess.id, targetId: target.id };
}

export async function stopCpuProfile(
	electronProcess: ElectronProcess,
	filePath?: string,
): Promise<{
	processId: string;
	targetId: string;
	path: string;
	bytes: number;
	durationMs: number;
}> {
	const session = cpuProfileSessions.get(electronProcess.id);
	if (!session || session.starting) {
		throw new Error(`No active CPU profile for ${electronProcess.id}`);
	}

	let result: { profile?: unknown };
	try {
		result = (await cdpTimed(
			electronProcess,
			session.targetId,
			"Profiler.stop",
			{},
			30_000,
		)) as { profile?: unknown };
	} catch (err) {
		// Keep the session so the caller can retry stop.
		throw err;
	}

	cpuProfileSessions.delete(electronProcess.id);
	try {
		await cdpTimed(
			electronProcess,
			session.targetId,
			"Profiler.disable",
			{},
			5_000,
		);
	} catch {
		// ignore — target may be gone
	}

	const out =
		filePath?.trim() ||
		path.join(
			os.tmpdir(),
			`electron-mcp-cpu-${electronProcess.id}-${Date.now()}.cpuprofile`,
		);
	const resolved = validateOutputPath(out);
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	const json = JSON.stringify(result.profile ?? result, null, 2);
	fs.writeFileSync(resolved, json);
	return {
		processId: electronProcess.id,
		targetId: session.targetId,
		path: resolved,
		bytes: Buffer.byteLength(json),
		durationMs: Date.now() - session.startedAt,
	};
}

/** True when a CPU profile session is active for the process (tests / diagnose). */
export function hasCpuProfileSession(processId: string): boolean {
	return cpuProfileSessions.has(processId);
}

/**
 * Resolve Electron APIs inside CDP `Runtime.evaluate` on the `--inspect`
 * target. Bare `require` is usually missing on Electron's `browser_init`
 * context, so fall back to `_linkedBinding` for app / BrowserWindow.
 */
const LOAD_ELECTRON = `(() => {
	const req = typeof require === 'function'
		? require
		: (process.mainModule && typeof process.mainModule.require === 'function'
			? process.mainModule.require.bind(process.mainModule)
			: null);
	if (typeof req === 'function') {
		try {
			const mod = req('electron');
			if (mod && mod.app && mod.BrowserWindow) return mod;
		} catch { /* fall through */ }
	}
	const electron = {};
	try { electron.app = process._linkedBinding('electron_browser_app').app; } catch { /* */ }
	try { electron.BrowserWindow = process._linkedBinding('electron_browser_window').BrowserWindow; } catch { /* */ }
	try {
		const wc = process._linkedBinding('electron_browser_web_contents');
		electron.webContents = wc;
	} catch { /* */ }
	if (!electron.app || !electron.BrowserWindow) {
		throw new Error('Unable to access Electron APIs from this main-process evaluate context');
	}
	return electron;
})`;

export async function takeHeapSnapshot(
	electronProcess: ElectronProcess,
	filePath?: string,
	targetId?: string,
): Promise<{ processId: string; targetId: string; path: string; bytes: number }> {
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, targetId);
	// Enable first, then bind listeners on the *same* client that will send
	// takeHeapSnapshot — executeCDPCommand may reconnect and orphan listeners.
	await cdpTimed(electronProcess, target.id, "HeapProfiler.enable", {});
	const client = await connectToCDPTarget(electronProcess, target.id);

	const chunks: string[] = [];
	const onChunk = (params: unknown) => {
		const p = params as { chunk?: string };
		if (p.chunk) chunks.push(p.chunk);
	};
	const onProgress = (params: unknown) => {
		const p = params as { finished?: boolean };
		if (p.finished) finished = true;
	};
	let finished = false;

	client.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
	client.on("HeapProfiler.reportHeapSnapshotProgress", onProgress);

	const detach = () => {
		try {
			const c = client as unknown as {
				removeListener: (
					event: string,
					fn: (params: unknown) => void,
				) => void;
			};
			c.removeListener("HeapProfiler.addHeapSnapshotChunk", onChunk);
			c.removeListener("HeapProfiler.reportHeapSnapshotProgress", onProgress);
		} catch {
			// ignore
		}
	};

	try {
		await withTimeout(
			(async () => {
				// Use the bound client directly — never reconnect under live listeners.
				await withTimeout(
					client.send("HeapProfiler.takeHeapSnapshot", {
						reportProgress: true,
					}),
					HEAP_TIMEOUT_MS - 5_000,
					"HeapProfiler.takeHeapSnapshot",
				);
				const deadline = Date.now() + 2_000;
				while (!finished && Date.now() < deadline) {
					await new Promise((r) => setTimeout(r, 25));
				}
				await new Promise((r) => setTimeout(r, 50));
			})(),
			HEAP_TIMEOUT_MS,
			"HeapProfiler.takeHeapSnapshot",
		);
	} finally {
		detach();
		try {
			await withTimeout(
				client.send("HeapProfiler.disable", {}),
				5_000,
				"HeapProfiler.disable",
			);
		} catch {
			// ignore — target may be gone or domain already off
		}
	}

	if (chunks.length === 0) {
		throw new Error(
			"Heap snapshot produced no data (target may not support HeapProfiler)",
		);
	}

	const out =
		filePath?.trim() ||
		path.join(
			os.tmpdir(),
			`electron-mcp-heap-${electronProcess.id}-${Date.now()}.heapsnapshot`,
		);
	const resolved = validateOutputPath(out);
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	const body = chunks.join("");
	fs.writeFileSync(resolved, body);
	return {
		processId: electronProcess.id,
		targetId: target.id,
		path: resolved,
		bytes: Buffer.byteLength(body),
	};
}

/** Electron main-process nervous system dump via evaluate_main. */
export async function getMainState(
	electronProcess: ElectronProcess,
): Promise<Record<string, unknown>> {
	const expression = `(() => {
		const syn = (v) => {
			try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); }
		};
		try {
			const electron = (${LOAD_ELECTRON})();
			const { app, BrowserWindow } = electron;
			const windows = BrowserWindow.getAllWindows().map((w) => {
				try {
					return {
						id: w.id,
						title: w.getTitle(),
						url: (() => { try { return w.webContents.getURL(); } catch { return null; } })(),
						bounds: w.getBounds(),
						isVisible: w.isVisible(),
						isFocused: w.isFocused(),
						isMinimized: w.isMinimized(),
						isDestroyed: w.isDestroyed(),
					};
				} catch (err) {
					return { error: err && err.message ? err.message : String(err) };
				}
			});
			const paths = {};
			for (const name of ['home','appData','userData','sessionData','temp','exe','desktop','documents','downloads','music','pictures','videos','recent','logs','crashDumps']) {
				try { paths[name] = app.getPath(name); } catch { /* skip */ }
			}
			return {
				ok: true,
				versions: syn(process.versions),
				app: {
					name: app.getName(),
					version: app.getVersion(),
					locale: app.getLocale(),
					isReady: app.isReady(),
					isPackaged: app.isPackaged,
				},
				paths,
				metrics: syn(typeof app.getAppMetrics === 'function' ? app.getAppMetrics() : []),
				windows,
			};
		} catch (err) {
			return { ok: false, error: err && err.message ? err.message : String(err) };
		}
	})()`;
	const result = await withTimeout(
		evaluateMain(electronProcess, expression, undefined, true),
		CDP_TIMEOUT_MS,
		"main_state",
	);
	const value = (result.result as { result?: { value?: unknown } })?.result
		?.value as Record<string, unknown> | undefined;
	if (value && value.ok === false) {
		throw new Error(
			typeof value.error === "string"
				? value.error
				: "main_state failed in main process",
		);
	}
	return {
		processId: electronProcess.id,
		targetId: result.targetId,
		main: value ?? result.result,
	};
}

const IPC_TAP_EXPR = `(() => {
	const syn = (v) => {
		try {
			const s = JSON.stringify(v);
			return s.length > 400 ? s.slice(0, 400) + '…' : s;
		} catch { return String(v); }
	};
	try {
		const electron = (${LOAD_ELECTRON})();
		const { ipcMain, BrowserWindow, app } = electron;
		if (global.__electronMcpIpcTapInstalled) {
			return { ok: true, already: true, count: (global.__electronMcpIpcLog || []).length };
		}
		// Mark installed first so a partial failure cannot stack app.on listeners.
		global.__electronMcpIpcTapInstalled = true;
		global.__electronMcpIpcLog = global.__electronMcpIpcLog || [];
		const push = (entry) => {
			try {
				global.__electronMcpIpcLog.push(entry);
				if (global.__electronMcpIpcLog.length > 500) global.__electronMcpIpcLog.shift();
			} catch { /* ignore */ }
		};
		const wrapSend = (wc) => {
			try {
				if (!wc || wc.__electronMcpIpcWrapped) return;
				wc.__electronMcpIpcWrapped = true;
				const orig = wc.send.bind(wc);
				wc.send = (channel, ...args) => {
					push({ timestamp: new Date().toISOString(), direction: 'main->renderer', channel: String(channel), argsPreview: syn(args) });
					return orig(channel, ...args);
				};
				wc.on('ipc-message', (_e, channel, ...args) => {
					push({ timestamp: new Date().toISOString(), direction: 'renderer->main', channel: String(channel), argsPreview: syn(args) });
				});
				wc.on('ipc-message-sync', (_e, channel, ...args) => {
					push({ timestamp: new Date().toISOString(), direction: 'renderer->main', channel: String(channel), argsPreview: syn(args) });
				});
			} catch { /* ignore per-contents failures */ }
		};
		for (const w of BrowserWindow.getAllWindows()) wrapSend(w.webContents);
		app.on('web-contents-created', (_e, wc) => wrapSend(wc));
		// ipcMain is often unavailable on the inspect browser_init context —
		// webContents hooks above still cover send / ipc-message traffic.
		if (ipcMain && typeof ipcMain.handle === 'function') {
			const origHandle = ipcMain.handle.bind(ipcMain);
			ipcMain.handle = (channel, listener) => {
				return origHandle(channel, async (event, ...args) => {
					push({ timestamp: new Date().toISOString(), direction: 'handle', channel: String(channel), argsPreview: syn(args) });
					return listener(event, ...args);
				});
			};
		}
		return { ok: true, already: false, count: 0, ipcMainWrapped: Boolean(ipcMain) };
	} catch (err) {
		global.__electronMcpIpcTapInstalled = false;
		return { ok: false, error: err && err.message ? err.message : String(err) };
	}
})()`;

export async function enableIpcTap(
	electronProcess: ElectronProcess,
): Promise<Record<string, unknown>> {
	const result = await withTimeout(
		evaluateMain(electronProcess, IPC_TAP_EXPR, undefined, true),
		CDP_TIMEOUT_MS,
		"ipc_tap",
	);
	const value = (result.result as { result?: { value?: unknown } })?.result
		?.value as Record<string, unknown> | undefined;
	if (value && value.ok === false) {
		throw new Error(
			typeof value.error === "string"
				? value.error
				: "ipc_tap failed in main process",
		);
	}
	return { processId: electronProcess.id, targetId: result.targetId, ...(value ?? {}) };
}

export async function getIpcLog(
	electronProcess: ElectronProcess,
	options: { tail?: number; refreshFromMain?: boolean } = {},
): Promise<{ processId: string; entries: IpcEntry[] }> {
	if (options.refreshFromMain !== false) {
		try {
			const drain = await withTimeout(
				evaluateMain(
					electronProcess,
					`(() => {
						const log = global.__electronMcpIpcLog || [];
						global.__electronMcpIpcLog = [];
						return Array.isArray(log) ? log : [];
					})()`,
					undefined,
					true,
				),
				CDP_TIMEOUT_MS,
				"get_ipc_log/drain",
			);
			const value = (drain.result as { result?: { value?: IpcEntry[] } })?.result
				?.value;
			if (Array.isArray(value)) {
				for (const entry of value) {
					if (entry && typeof entry === "object") {
						pushCapped(electronProcess.ipcEntries, entry, MAX_IPC);
					}
				}
			}
		} catch (err) {
			log.warn(`[${electronProcess.id}] ipc drain failed:`, err);
		}
	}
	const entries =
		options.tail != null
			? electronProcess.ipcEntries.slice(-options.tail)
			: electronProcess.ipcEntries;
	return { processId: electronProcess.id, entries };
}

function byteSimilarity(a: Buffer, b: Buffer): number {
	const n = Math.min(a.length, b.length);
	if (n === 0) return a.length === b.length ? 1 : 0;
	let same = 0;
	const step = Math.max(1, Math.floor(n / 50000));
	let checked = 0;
	for (let i = 0; i < n; i += step) {
		if (a[i] === b[i]) same++;
		checked++;
	}
	const lengthPenalty =
		Math.min(a.length, b.length) / Math.max(a.length, b.length);
	return (same / checked) * lengthPenalty;
}

export async function diffScreenshot(
	electronProcess: ElectronProcess,
	options: {
		baselinePath: string;
		currentPath?: string;
		targetId?: string;
		selector?: string;
	},
): Promise<Record<string, unknown>> {
	const baseline = validateOutputPath(options.baselinePath);
	if (!fs.existsSync(baseline)) {
		throw new Error(`Baseline not found: ${baseline}`);
	}
	const baselineBuf = fs.readFileSync(baseline);
	if (!isPng(baselineBuf)) {
		throw new Error(`Baseline is not a PNG: ${baseline}`);
	}

	let currentPath = options.currentPath;
	let captured: Awaited<ReturnType<typeof saveScreenshot>> | undefined;
	if (!currentPath) {
		const tmp = path.join(
			os.tmpdir(),
			`electron-mcp-diff-${electronProcess.id}-${Date.now()}.png`,
		);
		captured = await withTimeout(
			saveScreenshot(
				electronProcess,
				tmp,
				options.targetId,
				"png",
				undefined,
				options.selector,
			),
			CDP_TIMEOUT_MS,
			"diff_screenshot/capture",
		);
		currentPath = captured.path;
	}
	const currentResolved = validateOutputPath(currentPath);
	if (!fs.existsSync(currentResolved)) {
		throw new Error(`Current screenshot not found: ${currentResolved}`);
	}
	const currentBuf = fs.readFileSync(currentResolved);
	if (!isPng(currentBuf)) {
		throw new Error(`Current file is not a PNG: ${currentResolved}`);
	}
	const identical = baselineBuf.equals(currentBuf);
	return {
		processId: electronProcess.id,
		baselinePath: baseline,
		currentPath: currentResolved,
		identical,
		similarity: identical
			? 1
			: Number(byteSimilarity(baselineBuf, currentBuf).toFixed(4)),
		baselineBytes: baselineBuf.length,
		currentBytes: currentBuf.length,
		baselineSha256: crypto.createHash("sha256").update(baselineBuf).digest("hex"),
		currentSha256: crypto.createHash("sha256").update(currentBuf).digest("hex"),
		note: identical
			? "Buffers match exactly"
			: "Byte-level similarity (not perceptual pixelmatch); use for smoke change detection",
		...(captured?.clip ? { clip: captured.clip } : {}),
	};
}

export function getAuditIssues(
	electronProcess: ElectronProcess,
	tail?: number,
): { processId: string; issues: ElectronProcess["auditIssues"] } {
	const issues =
		tail != null
			? electronProcess.auditIssues.slice(-tail)
			: electronProcess.auditIssues;
	return { processId: electronProcess.id, issues };
}

export type InstalledElectronApp = {
	name: string;
	path: string;
	platform: NodeJS.Platform;
	kind: "app-bundle" | "exe" | "desktop" | "asar-dir";
};

const MAX_INSTALLED = 200;

/** Best-effort scan for installed Electron apps (packaged). */
export async function findInstalledElectronApps(): Promise<
	InstalledElectronApp[]
> {
	const found: InstalledElectronApp[] = [];
	const seen = new Set<string>();
	const add = (app: InstalledElectronApp) => {
		if (found.length >= MAX_INSTALLED) return;
		const key = path.resolve(app.path);
		if (seen.has(key)) return;
		seen.add(key);
		found.push({ ...app, path: key });
	};

	const looksElectronDir = (dir: string): boolean => {
		try {
			return (
				fs.existsSync(path.join(dir, "Electron.app")) ||
				fs.existsSync(path.join(dir, "electron.exe")) ||
				fs.existsSync(path.join(dir, "chrome_100_percent.pak")) ||
				fs.existsSync(path.join(dir, "resources", "app.asar")) ||
				fs.existsSync(path.join(dir, "Resources", "app.asar"))
			);
		} catch {
			return false;
		}
	};

	const safeReaddir = (root: string): string[] => {
		try {
			return fs.readdirSync(root);
		} catch {
			return [];
		}
	};

	if (process.platform === "darwin") {
		for (const root of [
			"/Applications",
			path.join(os.homedir(), "Applications"),
		]) {
			for (const name of safeReaddir(root)) {
				if (!name.endsWith(".app")) continue;
				const appPath = path.join(root, name);
				const frameworks = path.join(
					appPath,
					"Contents",
					"Frameworks",
					"Electron Framework.framework",
				);
				const asar = path.join(appPath, "Contents", "Resources", "app.asar");
				if (
					fs.existsSync(frameworks) ||
					fs.existsSync(asar) ||
					looksElectronDir(path.join(appPath, "Contents", "MacOS"))
				) {
					add({
						name: name.replace(/\.app$/i, ""),
						path: appPath,
						platform: "darwin",
						kind: "app-bundle",
					});
				}
			}
		}
	} else if (process.platform === "win32") {
		const roots = [
			process.env.LOCALAPPDATA,
			process.env.PROGRAMFILES,
			process.env["PROGRAMFILES(X86)"],
		].filter(Boolean) as string[];
		for (const root of roots) {
			for (const name of safeReaddir(root)) {
				const dir = path.join(root, name);
				try {
					if (!fs.statSync(dir).isDirectory()) continue;
				} catch {
					continue;
				}
				if (looksElectronDir(dir)) {
					const exe =
						[path.join(dir, `${name}.exe`), path.join(dir, "app.exe")].find(
							(p) => fs.existsSync(p),
						) ?? dir;
					add({
						name,
						path: exe,
						platform: "win32",
						kind: "exe",
					});
				}
			}
		}
	} else {
		for (const root of [
			"/usr/share/applications",
			path.join(os.homedir(), ".local/share/applications"),
		]) {
			for (const name of safeReaddir(root)) {
				if (!name.endsWith(".desktop")) continue;
				const desktopPath = path.join(root, name);
				let body = "";
				try {
					body = fs.readFileSync(desktopPath, "utf8");
				} catch {
					continue;
				}
				if (!/electron|app\.asar/i.test(body)) continue;
				const execLine = body.match(/^Exec=(.+)$/m)?.[1]?.trim();
				const appName =
					body.match(/^Name=(.+)$/m)?.[1]?.trim() ??
					name.replace(/\.desktop$/i, "");
				add({
					name: appName,
					path: execLine?.split(/\s+/)[0] || desktopPath,
					platform: "linux",
					kind: "desktop",
				});
			}
		}
	}

	return found.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// v1.7 creative tools — coverage, file input, emulate, screencast, breakpoints,
// resolve_stack, perf_audit, mhtml, virtual_clock, webcontents_topology
// ---------------------------------------------------------------------------

type CoverageSession = {
	targetId: string;
	css: boolean;
	startedAt: number;
};

const coverageSessions = new Map<string, CoverageSession>();

registerProcessCleanup((processId) => {
	const session = coverageSessions.get(processId);
	coverageSessions.delete(processId);
	if (!session) return;
	void (async () => {
		try {
			const proc = getProcess(processId);
			if (!proc || proc.status !== "running") return;
			await executeCDPCommand(
				proc,
				session.targetId,
				"Profiler.stopPreciseCoverage",
				{},
				5_000,
			).catch(() => undefined);
			await executeCDPCommand(
				proc,
				session.targetId,
				"Profiler.disable",
				{},
				5_000,
			).catch(() => undefined);
			if (session.css) {
				await executeCDPCommand(
					proc,
					session.targetId,
					"CSS.stopRuleUsageTracking",
					{},
					5_000,
				).catch(() => undefined);
			}
		} catch {
			/* ignore */
		}
	})();
});

export async function startCoverage(
	electronProcess: ElectronProcess,
	options: { targetId?: string; css?: boolean } = {},
): Promise<{ processId: string; targetId: string; css: boolean }> {
	if (coverageSessions.has(electronProcess.id)) {
		throw new Error(
			`Coverage already active for ${electronProcess.id}. Call stop_coverage first.`,
		);
	}
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, options.targetId);
	const css = Boolean(options.css);
	await cdpTimed(electronProcess, target.id, "Profiler.enable", {});
	await cdpTimed(electronProcess, target.id, "Profiler.startPreciseCoverage", {
		callCount: true,
		detailed: true,
	});
	if (css) {
		await cdpTimed(electronProcess, target.id, "CSS.enable", {});
		await cdpTimed(electronProcess, target.id, "CSS.startRuleUsageTracking", {});
	}
	coverageSessions.set(electronProcess.id, {
		targetId: target.id,
		css,
		startedAt: Date.now(),
	});
	return { processId: electronProcess.id, targetId: target.id, css };
}

export async function stopCoverage(
	electronProcess: ElectronProcess,
	filePath?: string,
): Promise<{
	processId: string;
	targetId: string;
	path?: string;
	js: unknown;
	css?: unknown;
	durationMs: number;
}> {
	const session = coverageSessions.get(electronProcess.id);
	if (!session) {
		throw new Error(`No active coverage session for ${electronProcess.id}`);
	}
	let js: unknown;
	let cssResult: unknown;
	try {
		js = await cdpTimed(
			electronProcess,
			session.targetId,
			"Profiler.takePreciseCoverage",
			{},
			30_000,
		);
		if (session.css) {
			cssResult = await cdpTimed(
				electronProcess,
				session.targetId,
				"CSS.takeCoverageDelta",
				{},
				15_000,
			);
		}
	} catch (err) {
		throw err;
	}
	coverageSessions.delete(electronProcess.id);
	try {
		await cdpTimed(
			electronProcess,
			session.targetId,
			"Profiler.stopPreciseCoverage",
			{},
			5_000,
		);
		await cdpTimed(electronProcess, session.targetId, "Profiler.disable", {}, 5_000);
		if (session.css) {
			await cdpTimed(
				electronProcess,
				session.targetId,
				"CSS.stopRuleUsageTracking",
				{},
				5_000,
			);
		}
	} catch {
		/* ignore */
	}
	const durationMs = Date.now() - session.startedAt;
	const payload = { js, css: cssResult, durationMs };
	let outPath: string | undefined;
	if (filePath?.trim()) {
		outPath = validateOutputPath(filePath);
		fs.mkdirSync(path.dirname(outPath), { recursive: true });
		fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
	}
	return {
		processId: electronProcess.id,
		targetId: session.targetId,
		path: outPath,
		js,
		...(cssResult !== undefined ? { css: cssResult } : {}),
		durationMs,
	};
}

export async function setFileInput(
	electronProcess: ElectronProcess,
	options: { selector: string; files: string[]; targetId?: string },
): Promise<{ targetId: string; files: string[]; selector: string }> {
	if (!options.selector?.trim()) throw new Error("selector is required");
	if (!Array.isArray(options.files) || options.files.length === 0) {
		throw new Error("files must be a non-empty array of paths");
	}
	const resolvedFiles = options.files.map((f) => {
		const abs = path.resolve(f);
		if (!fs.existsSync(abs)) {
			throw new Error(`File not found: ${abs}`);
		}
		return abs;
	});
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, options.targetId);
	await cdpTimed(electronProcess, target.id, "DOM.enable", {});
	const doc = (await cdpTimed(electronProcess, target.id, "DOM.getDocument", {
		depth: 0,
	})) as { root?: { nodeId?: number } };
	const rootId = doc.root?.nodeId;
	if (rootId == null) throw new Error("DOM.getDocument returned no root");
	const q = (await cdpTimed(electronProcess, target.id, "DOM.querySelector", {
		nodeId: rootId,
		selector: options.selector,
	})) as { nodeId?: number };
	if (!q.nodeId) {
		throw new Error(`No element matched selector: ${options.selector}`);
	}
	await cdpTimed(electronProcess, target.id, "DOM.setFileInputFiles", {
		nodeId: q.nodeId,
		files: resolvedFiles,
	});
	return {
		targetId: target.id,
		files: resolvedFiles,
		selector: options.selector,
	};
}

export async function emulate(
	electronProcess: ElectronProcess,
	options: {
		targetId?: string;
		clear?: boolean;
		metrics?: {
			width: number;
			height: number;
			deviceScaleFactor?: number;
			mobile?: boolean;
		};
		userAgent?: string;
		geolocation?: {
			latitude: number;
			longitude: number;
			accuracy?: number;
		};
		media?: string;
	} = {},
): Promise<{ targetId: string; applied: string[] }> {
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, options.targetId);
	const applied: string[] = [];
	if (options.clear) {
		await cdpTimed(
			electronProcess,
			target.id,
			"Emulation.clearDeviceMetricsOverride",
			{},
		).catch(() => undefined);
		applied.push("clearDeviceMetricsOverride");
		await cdpTimed(
			electronProcess,
			target.id,
			"Emulation.clearGeolocationOverride",
			{},
		).catch(() => undefined);
		applied.push("clearGeolocationOverride");
		await cdpTimed(electronProcess, target.id, "Emulation.setUserAgentOverride", {
			userAgent: "",
		}).catch(() => undefined);
		applied.push("clearUserAgentOverride");
		await cdpTimed(electronProcess, target.id, "Emulation.setEmulatedMedia", {
			media: "",
		}).catch(() => undefined);
		applied.push("clearEmulatedMedia");
		return { targetId: target.id, applied };
	}
	if (options.metrics) {
		await cdpTimed(
			electronProcess,
			target.id,
			"Emulation.setDeviceMetricsOverride",
			{
				width: options.metrics.width,
				height: options.metrics.height,
				deviceScaleFactor: options.metrics.deviceScaleFactor ?? 1,
				mobile: Boolean(options.metrics.mobile),
			},
		);
		applied.push("setDeviceMetricsOverride");
	}
	if (options.userAgent != null) {
		await cdpTimed(electronProcess, target.id, "Emulation.setUserAgentOverride", {
			userAgent: options.userAgent,
		});
		applied.push("setUserAgentOverride");
	}
	if (options.geolocation) {
		await cdpTimed(
			electronProcess,
			target.id,
			"Emulation.setGeolocationOverride",
			{
				latitude: options.geolocation.latitude,
				longitude: options.geolocation.longitude,
				accuracy: options.geolocation.accuracy ?? 1,
			},
		);
		applied.push("setGeolocationOverride");
	}
	if (options.media != null) {
		await cdpTimed(electronProcess, target.id, "Emulation.setEmulatedMedia", {
			media: options.media,
		});
		applied.push("setEmulatedMedia");
	}
	if (applied.length === 0) {
		throw new Error(
			"emulate requires clear=true or at least one of metrics/userAgent/geolocation/media",
		);
	}
	return { targetId: target.id, applied };
}

type ScreencastSession = {
	targetId: string;
	frames: Array<{ data: string; metadata?: unknown; sessionId?: number }>;
	maxFrames: number;
	startedAt: number;
};

const screencastSessions = new Map<string, ScreencastSession>();

registerProcessCleanup((processId) => {
	const session = screencastSessions.get(processId);
	screencastSessions.delete(processId);
	if (!session) return;
	void (async () => {
		try {
			const proc = getProcess(processId);
			if (!proc || proc.status !== "running") return;
			await executeCDPCommand(
				proc,
				session.targetId,
				"Page.stopScreencast",
				{},
				5_000,
			).catch(() => undefined);
		} catch {
			/* ignore */
		}
	})();
});

export async function startScreencast(
	electronProcess: ElectronProcess,
	options: {
		targetId?: string;
		maxFrames?: number;
		everyNthFrame?: number;
		format?: "png" | "jpeg";
		quality?: number;
	} = {},
): Promise<{ processId: string; targetId: string; maxFrames: number }> {
	if (screencastSessions.has(electronProcess.id)) {
		throw new Error(
			`Screencast already active for ${electronProcess.id}. Call stop_screencast first.`,
		);
	}
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, options.targetId);
	const maxFrames = Math.min(Math.max(options.maxFrames ?? 5, 1), 30);
	const session: ScreencastSession = {
		targetId: target.id,
		frames: [],
		maxFrames,
		startedAt: Date.now(),
	};
	screencastSessions.set(electronProcess.id, session);

	const client = await connectToCDPTarget(electronProcess, target.id);
	const onFrame = (params: unknown) => {
		const p = params as {
			data?: string;
			metadata?: unknown;
			sessionId?: number;
		};
		if (!p.data) return;
		session.frames.push({
			data: p.data,
			metadata: p.metadata,
			sessionId: p.sessionId,
		});
		if (session.frames.length > maxFrames) {
			session.frames.splice(0, session.frames.length - maxFrames);
		}
		if (p.sessionId != null) {
			void client
				.send("Page.screencastFrameAck", { sessionId: p.sessionId })
				.catch(() => undefined);
		}
	};
	client.on("Page.screencastFrame", onFrame);
	(session as ScreencastSession & { _onFrame?: typeof onFrame; _client?: typeof client })._onFrame =
		onFrame;
	(session as ScreencastSession & { _client?: typeof client })._client = client;

	try {
		await withTimeout(
			client.send("Page.startScreencast", {
				format: options.format ?? "png",
				quality: options.quality ?? 80,
				everyNthFrame: options.everyNthFrame ?? 2,
			}),
			CDP_TIMEOUT_MS,
			"Page.startScreencast",
		);
	} catch (err) {
		screencastSessions.delete(electronProcess.id);
		try {
			client.removeListener("Page.screencastFrame", onFrame);
		} catch {
			/* ignore */
		}
		throw err;
	}
	return {
		processId: electronProcess.id,
		targetId: target.id,
		maxFrames,
	};
}

export async function stopScreencast(
	electronProcess: ElectronProcess,
	filePath?: string,
): Promise<{
	processId: string;
	targetId: string;
	frames: number;
	path?: string;
	lastFrameBase64?: string;
	durationMs: number;
}> {
	const session = screencastSessions.get(electronProcess.id) as
		| (ScreencastSession & {
				_onFrame?: (p: unknown) => void;
				_client?: Awaited<ReturnType<typeof connectToCDPTarget>>;
		  })
		| undefined;
	if (!session) {
		throw new Error(`No active screencast for ${electronProcess.id}`);
	}
	try {
		if (session._client) {
			await withTimeout(
				session._client.send("Page.stopScreencast", {}),
				5_000,
				"Page.stopScreencast",
			);
		} else {
			await cdpTimed(
				electronProcess,
				session.targetId,
				"Page.stopScreencast",
				{},
				5_000,
			);
		}
	} catch {
		/* ignore */
	}
	if (session._client && session._onFrame) {
		try {
			session._client.removeListener("Page.screencastFrame", session._onFrame);
		} catch {
			/* ignore */
		}
	}
	screencastSessions.delete(electronProcess.id);
	const last = session.frames[session.frames.length - 1];
	let outPath: string | undefined;
	if (filePath?.trim() && last?.data) {
		outPath = validateOutputPath(filePath);
		fs.mkdirSync(path.dirname(outPath), { recursive: true });
		fs.writeFileSync(outPath, Buffer.from(last.data, "base64"));
	}
	return {
		processId: electronProcess.id,
		targetId: session.targetId,
		frames: session.frames.length,
		path: outPath,
		lastFrameBase64: last?.data,
		durationMs: Date.now() - session.startedAt,
	};
}

type BreakpointEntry = { breakpointId: string; targetId: string };

const breakpointSessions = new Map<string, BreakpointEntry[]>();

registerProcessCleanup((processId) => {
	const entries = breakpointSessions.get(processId);
	breakpointSessions.delete(processId);
	if (!entries?.length) return;
	void (async () => {
		try {
			const proc = getProcess(processId);
			if (!proc || proc.status !== "running") return;
			for (const e of entries) {
				await executeCDPCommand(
					proc,
					e.targetId,
					"Debugger.removeBreakpoint",
					{ breakpointId: e.breakpointId },
					5_000,
				).catch(() => undefined);
			}
		} catch {
			/* ignore */
		}
	})();
});

export async function setBreakpointByUrl(
	electronProcess: ElectronProcess,
	options: {
		lineNumber: number;
		url?: string;
		urlRegex?: string;
		columnNumber?: number;
		targetId?: string;
	},
): Promise<{
	targetId: string;
	breakpointId: string;
	locations?: unknown;
}> {
	if (options.lineNumber == null || options.lineNumber < 0) {
		throw new Error("lineNumber is required (>= 0, 0-based)");
	}
	if (!options.url && !options.urlRegex) {
		throw new Error("Provide url or urlRegex");
	}
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, options.targetId);
	await cdpTimed(electronProcess, target.id, "Debugger.enable", {});
	const params: Record<string, unknown> = {
		lineNumber: options.lineNumber,
	};
	if (options.url) params.url = options.url;
	if (options.urlRegex) params.urlRegex = options.urlRegex;
	if (options.columnNumber != null) params.columnNumber = options.columnNumber;
	const result = (await cdpTimed(
		electronProcess,
		target.id,
		"Debugger.setBreakpointByUrl",
		params,
	)) as { breakpointId?: string; locations?: unknown };
	if (!result.breakpointId) {
		throw new Error("Debugger.setBreakpointByUrl returned no breakpointId");
	}
	const list = breakpointSessions.get(electronProcess.id) ?? [];
	list.push({ breakpointId: result.breakpointId, targetId: target.id });
	breakpointSessions.set(electronProcess.id, list);
	return {
		targetId: target.id,
		breakpointId: result.breakpointId,
		locations: result.locations,
	};
}

export async function removeBreakpoint(
	electronProcess: ElectronProcess,
	breakpointId: string,
	targetId?: string,
): Promise<{ ok: boolean; breakpointId: string }> {
	if (!breakpointId?.trim()) throw new Error("breakpointId is required");
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, targetId);
	await cdpTimed(electronProcess, target.id, "Debugger.removeBreakpoint", {
		breakpointId,
	});
	const list = breakpointSessions.get(electronProcess.id);
	if (list) {
		breakpointSessions.set(
			electronProcess.id,
			list.filter((e) => e.breakpointId !== breakpointId),
		);
	}
	return { ok: true, breakpointId };
}

export async function resolveStack(
	electronProcess: ElectronProcess,
	options: {
		frames: Array<{
			url?: string;
			scriptId?: string;
			lineNumber: number;
			columnNumber?: number;
			functionName?: string;
		}>;
		contextLines?: number;
		targetId?: string;
	},
): Promise<{
	targetId: string;
	frames: Array<Record<string, unknown>>;
}> {
	if (!Array.isArray(options.frames) || options.frames.length === 0) {
		throw new Error("frames must be a non-empty array");
	}
	const contextLines = Math.min(Math.max(options.contextLines ?? 3, 0), 20);
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, options.targetId);
	await cdpTimed(electronProcess, target.id, "Debugger.enable", {});

	try {
		const sourceCache = new Map<string, string>();
		const loadSource = async (frame: {
			url?: string;
			scriptId?: string;
		}): Promise<string | undefined> => {
			const key = frame.scriptId
				? `id:${frame.scriptId}`
				: frame.url
					? `url:${frame.url}`
					: "";
			if (!key) return undefined;
			if (sourceCache.has(key)) return sourceCache.get(key);
			if (frame.scriptId) {
				try {
					const res = (await cdpTimed(
						electronProcess,
						target.id,
						"Debugger.getScriptSource",
						{ scriptId: frame.scriptId },
					)) as { scriptSource?: string };
					if (res.scriptSource != null) {
						sourceCache.set(key, res.scriptSource);
						return res.scriptSource;
					}
				} catch {
					/* fall through */
				}
			}
			if (frame.url?.startsWith("file://")) {
				try {
					const filePath = decodeURIComponent(
						frame.url.replace(/^file:\/\//, ""),
					);
					if (fs.existsSync(filePath)) {
						const body = fs.readFileSync(filePath, "utf8");
						sourceCache.set(key, body);
						return body;
					}
				} catch {
					/* ignore */
				}
			}
			return undefined;
		};

		const out: Array<Record<string, unknown>> = [];
		for (const frame of options.frames.slice(0, 50)) {
			const source = await loadSource(frame);
			let snippet: string | undefined;
			let resolved = false;
			if (source) {
				const lines = source.split(/\r?\n/);
				const line = frame.lineNumber; // 0-based in CDP stacks often; accept as given
				const start = Math.max(0, line - contextLines);
				const end = Math.min(lines.length, line + contextLines + 1);
				snippet = lines
					.slice(start, end)
					.map((text, i) => {
						const n = start + i;
						const mark = n === line ? ">" : " ";
						return `${mark} ${n}: ${text}`;
					})
					.join("\n");
				resolved = true;
			}
			out.push({
				...frame,
				resolved,
				snippet,
			});
		}
		return { targetId: target.id, frames: out };
	} finally {
		// Don't leave Debugger attached — it interferes with pause/resume smoke.
		try {
			await cdpTimed(
				electronProcess,
				target.id,
				"Debugger.disable",
				{},
				5_000,
			);
		} catch {
			/* ignore */
		}
	}
}

export async function runPerfAudit(
	electronProcess: ElectronProcess,
	options: {
		targetId?: string;
		includeAudits?: boolean;
		includeNavTiming?: boolean;
	} = {},
): Promise<Record<string, unknown>> {
	await ensureMonitoring(electronProcess);
	const metrics = await getPerformanceMetrics(
		electronProcess,
		options.targetId,
	);
	const out: Record<string, unknown> = {
		processId: electronProcess.id,
		targetId: metrics.targetId,
		metrics: metrics.metrics,
		note: "CDP performance + audits proxy (not full Lighthouse)",
	};
	if (options.includeAudits !== false) {
		out.auditIssues = electronProcess.auditIssues.slice(-30);
		out.auditIssueCount = electronProcess.auditIssues.length;
	}
	if (options.includeNavTiming !== false) {
		try {
			const evalResult = (await cdpTimed(
				electronProcess,
				metrics.targetId,
				"Runtime.evaluate",
				{
					expression: `(() => {
						const nav = performance.getEntriesByType('navigation')[0];
						const paint = performance.getEntriesByType('paint').map((e) => ({ name: e.name, startTime: e.startTime }));
						return {
							navigation: nav ? {
								type: nav.type,
								domContentLoaded: nav.domContentLoadedEventEnd,
								loadEventEnd: nav.loadEventEnd,
								duration: nav.duration,
								transferSize: nav.transferSize,
								encodedBodySize: nav.encodedBodySize,
							} : null,
							paint,
							memory: performance.memory ? {
								usedJSHeapSize: performance.memory.usedJSHeapSize,
								totalJSHeapSize: performance.memory.totalJSHeapSize,
							} : null,
						};
					})()`,
					returnByValue: true,
					awaitPromise: true,
				},
			)) as { result?: { value?: unknown } };
			out.navigationTiming = evalResult.result?.value ?? null;
		} catch (err) {
			out.navigationTimingError =
				err instanceof Error ? err.message : String(err);
		}
	}
	return out;
}

export async function captureMhtml(
	electronProcess: ElectronProcess,
	filePath?: string,
	targetId?: string,
): Promise<{ processId: string; targetId: string; path: string; bytes: number }> {
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, targetId);
	const result = (await cdpTimed(
		electronProcess,
		target.id,
		"Page.captureSnapshot",
		{ format: "mhtml" },
		60_000,
	)) as { data?: string };
	if (!result.data) {
		throw new Error("Page.captureSnapshot returned no MHTML data");
	}
	const out =
		filePath?.trim() ||
		path.join(
			os.tmpdir(),
			`electron-mcp-mhtml-${electronProcess.id}-${Date.now()}.mhtml`,
		);
	const resolved = validateOutputPath(out);
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	fs.writeFileSync(resolved, result.data);
	return {
		processId: electronProcess.id,
		targetId: target.id,
		path: resolved,
		bytes: Buffer.byteLength(result.data),
	};
}

export async function setVirtualClock(
	electronProcess: ElectronProcess,
	options: {
		policy: "pause" | "advance" | "pauseIfNetworkFetchesPending";
		budget?: number;
		targetId?: string;
	},
): Promise<{ targetId: string; policy: string; expired?: boolean }> {
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, options.targetId);
	const params: Record<string, unknown> = { policy: options.policy };
	if (options.budget != null) params.budget = options.budget;

	if (options.policy !== "pause" && options.budget != null) {
		const client = await connectToCDPTarget(electronProcess, target.id);
		let expired = false;
		const onExpired = () => {
			expired = true;
		};
		client.on("Emulation.virtualTimeBudgetExpired", onExpired);
		try {
			await withTimeout(
				client.send("Emulation.setVirtualTimePolicy", params),
				CDP_TIMEOUT_MS,
				"Emulation.setVirtualTimePolicy",
			);
			const deadline = Date.now() + Math.min((options.budget ?? 0) + 5_000, 30_000);
			while (!expired && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 25));
			}
			// Budget expiry leaves virtual time paused — grant a large advance so
			// subsequent navigations / timers are not frozen for the rest of the session.
			try {
				await withTimeout(
					client.send("Emulation.setVirtualTimePolicy", {
						policy: "advance",
						budget: 24 * 60 * 60 * 1000,
					}),
					5_000,
					"Emulation.setVirtualTimePolicy(unstick)",
				);
			} catch {
				/* ignore */
			}
			return { targetId: target.id, policy: options.policy, expired };
		} finally {
			try {
				client.removeListener("Emulation.virtualTimeBudgetExpired", onExpired);
			} catch {
				/* ignore */
			}
		}
	}

	await cdpTimed(
		electronProcess,
		target.id,
		"Emulation.setVirtualTimePolicy",
		params,
	);
	return { targetId: target.id, policy: options.policy };
}

export async function getWebContentsTopology(
	electronProcess: ElectronProcess,
): Promise<Record<string, unknown>> {
	await updateCDPTargets(electronProcess);
	const cdpTargets = listTargetsByRole(electronProcess);

	const expression = `(() => {
		try {
			const electron = (${LOAD_ELECTRON})();
			const { app, BrowserWindow } = electron;
			const wcBinding = (() => {
				try { return process._linkedBinding('electron_browser_web_contents'); } catch { return null; }
			})();
			const windows = BrowserWindow.getAllWindows().map((w) => {
				try {
					const wc = w.webContents;
					return {
						id: w.id,
						title: w.getTitle(),
						bounds: w.getBounds(),
						isVisible: w.isVisible(),
						isDestroyed: w.isDestroyed(),
						webContentsId: wc.id,
						url: (() => { try { return wc.getURL(); } catch { return null; } })(),
						osProcessId: (() => { try { return wc.getOSProcessId(); } catch { return null; } })(),
						type: (() => { try { return wc.getType(); } catch { return null; } })(),
						hostWebContentsId: (() => {
							try { return wc.hostWebContents ? wc.hostWebContents.id : null; } catch { return null; }
						})(),
					};
				} catch (err) {
					return { error: err && err.message ? err.message : String(err) };
				}
			});
			let webContents = [];
			if (wcBinding && typeof wcBinding.getAllWebContents === 'function') {
				webContents = wcBinding.getAllWebContents().map((wc) => {
					try {
						return {
							id: wc.id,
							url: (() => { try { return wc.getURL(); } catch { return null; } })(),
							type: (() => { try { return wc.getType(); } catch { return null; } })(),
							osProcessId: (() => { try { return wc.getOSProcessId(); } catch { return null; } })(),
							hostWebContentsId: (() => {
								try { return wc.hostWebContents ? wc.hostWebContents.id : null; } catch { return null; }
							})(),
						};
					} catch (err) {
						return { error: err && err.message ? err.message : String(err) };
					}
				});
			}
			return { ok: true, appName: app.getName(), windows, webContents };
		} catch (err) {
			return { ok: false, error: err && err.message ? err.message : String(err) };
		}
	})()`;

	let main: Record<string, unknown> | undefined;
	try {
		const result = await withTimeout(
			evaluateMain(electronProcess, expression, undefined, true),
			CDP_TIMEOUT_MS,
			"webcontents_topology",
		);
		main = (result.result as { result?: { value?: unknown } })?.result
			?.value as Record<string, unknown> | undefined;
		if (main && main.ok === false) {
			main = { ok: false, error: main.error };
		}
	} catch (err) {
		main = {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}

	const windows = Array.isArray(main?.windows) ? main!.windows : [];
	const links: Array<{ webContentsId?: number; cdpTargetId?: string; url?: string }> =
		[];
	for (const w of windows as Array<Record<string, unknown>>) {
		const url = typeof w.url === "string" ? w.url : undefined;
		const match = cdpTargets.find(
			(t) => url && t.url && (t.url === url || t.url.startsWith(url) || url.startsWith(t.url)),
		);
		links.push({
			webContentsId: typeof w.webContentsId === "number" ? w.webContentsId : undefined,
			cdpTargetId: match?.id,
			url,
		});
	}

	return {
		processId: electronProcess.id,
		cdpTargets,
		main,
		links,
	};
}

// ---------------------------------------------------------------------------
// v1.8 creative tools — a11y act, network stub/HAR/idle, dialogs, assert, deep link
// ---------------------------------------------------------------------------

export type AxMatchNode = {
	nodeId?: string;
	role?: string;
	name?: string;
	description?: string;
	backendDOMNodeId?: number;
	ignored?: boolean;
};

/** Pick the best accessibility node for a name (and optional role). */
export function matchAxNode(
	nodes: AxMatchNode[],
	query: { name: string; role?: string; exact?: boolean },
): AxMatchNode | undefined {
	const want = query.name.trim().toLowerCase();
	const role = query.role?.trim().toLowerCase();
	if (!want) return undefined;
	let best: { node: AxMatchNode; score: number } | undefined;
	for (const node of nodes) {
		if (node.ignored || node.backendDOMNodeId == null) continue;
		if (role && (node.role ?? "").toLowerCase() !== role) continue;
		const name = (node.name ?? "").trim().toLowerCase();
		const desc = (node.description ?? "").trim().toLowerCase();
		let score = 0;
		if (name === want) score = 4;
		else if (!query.exact && name.includes(want)) score = 3;
		else if (desc === want) score = 2;
		else if (!query.exact && desc.includes(want)) score = 1;
		if (score > 0 && (!best || score > best.score)) {
			best = { node, score };
		}
	}
	return best?.node;
}

function axHint(nodes: AxMatchNode[]): string {
	return nodes
		.filter((n) => !n.ignored && (n.name || n.role))
		.slice(0, 12)
		.map((n) => `${n.role ?? "?"}:${n.name ?? ""}`)
		.join(", ");
}

/** CDP `urlPattern`: `*` is a wildcard. Anchored, case-insensitive. */
export function urlPatternMatches(pattern: string, url: string): boolean {
	const trimmed = pattern.trim();
	if (!trimmed || !url) return false;
	const escaped = trimmed
		.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i").test(url);
}

/** Requests whose latest event is still `request` or `response`. */
export function countInFlight(
	entries: Array<{ requestId: string; event: string }>,
): number {
	const last = new Map<string, string>();
	for (const entry of entries) {
		if (entry.requestId) last.set(entry.requestId, entry.event);
	}
	let inflight = 0;
	for (const event of last.values()) {
		if (event === "request" || event === "response") inflight += 1;
	}
	return inflight;
}

/** Best-effort HAR 1.2 from the buffered network log (no bodies/headers). */
export function networkEntriesToHar(entries: NetworkEntry[]): {
	log: {
		version: string;
		creator: { name: string; version: string };
		entries: Array<Record<string, unknown>>;
	};
} {
	const groups = new Map<string, NetworkEntry[]>();
	for (const entry of entries) {
		const list = groups.get(entry.requestId) ?? [];
		list.push(entry);
		groups.set(entry.requestId, list);
	}
	const harEntries: Array<Record<string, unknown>> = [];
	for (const [, evs] of groups) {
		if (harEntries.length >= 500) break;
		const req = evs.find((e) => e.event === "request");
		const res = evs.find((e) => e.event === "response");
		const fail = evs.find((e) => e.event === "failed");
		const url = req?.url ?? res?.url;
		if (!url) continue;
		harEntries.push({
			startedDateTime: req?.timestamp ?? evs[0]?.timestamp,
			time: 0,
			request: {
				method: req?.method ?? "GET",
				url,
				httpVersion: "HTTP/1.1",
				headers: [],
				queryString: [],
				cookies: [],
				headersSize: -1,
				bodySize: -1,
			},
			response: {
				status: res?.status ?? 0,
				statusText: fail?.errorText ?? "",
				httpVersion: "HTTP/1.1",
				headers: [],
				cookies: [],
				content: { size: 0, mimeType: res?.mimeType ?? "" },
				redirectURL: "",
				headersSize: -1,
				bodySize: -1,
			},
			cache: {},
			timings: { send: 0, wait: 0, receive: 0 },
			_requestId: req?.requestId ?? evs[0]?.requestId,
			...(fail ? { _errorText: fail.errorText } : {}),
		});
	}
	return {
		log: {
			version: "1.2",
			creator: { name: "electron-debug-mcp", version: "1.8.0" },
			entries: harEntries,
		},
	};
}

type EvalPayload = {
	result?: { value?: unknown; subtype?: string; description?: string };
	exceptionDetails?: { text?: string; exception?: { description?: string } };
};

async function evalPage(
	electronProcess: ElectronProcess,
	targetId: string,
	expression: string,
): Promise<unknown> {
	const result = (await cdpTimed(
		electronProcess,
		targetId,
		"Runtime.evaluate",
		{
			expression,
			returnByValue: true,
			awaitPromise: true,
		},
	)) as EvalPayload;
	if (result.exceptionDetails) {
		throw new Error(
			result.exceptionDetails.exception?.description ||
				result.exceptionDetails.text ||
				"evaluate error",
		);
	}
	if (result.result?.subtype === "error") {
		throw new Error(result.result.description || "evaluate error");
	}
	return result.result?.value;
}

async function dispatchClick(
	electronProcess: ElectronProcess,
	targetId: string,
	x: number,
	y: number,
	button: "left" | "right" | "middle",
): Promise<void> {
	const btn =
		button === "right" ? "right" : button === "middle" ? "middle" : "left";
	await cdpTimed(electronProcess, targetId, "Input.dispatchMouseEvent", {
		type: "mousePressed",
		x,
		y,
		button: btn,
		clickCount: 1,
	});
	await cdpTimed(electronProcess, targetId, "Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x,
		y,
		button: btn,
		clickCount: 1,
	});
}

async function boxCenterForBackendNode(
	electronProcess: ElectronProcess,
	targetId: string,
	backendNodeId: number,
): Promise<{ x: number; y: number; nodeId?: number }> {
	await cdpTimed(electronProcess, targetId, "DOM.enable", {});
	const described = (await cdpTimed(
		electronProcess,
		targetId,
		"DOM.describeNode",
		{ backendNodeId },
	)) as { node?: { nodeId?: number } };
	const nodeId = described.node?.nodeId;
	if (nodeId) {
		try {
			await cdpTimed(electronProcess, targetId, "DOM.scrollIntoViewIfNeeded", {
				nodeId,
			});
		} catch {
			/* node may already be in view */
		}
	}
	const model = (await cdpTimed(
		electronProcess,
		targetId,
		"DOM.getBoxModel",
		nodeId ? { nodeId } : { backendNodeId },
	)) as { model?: { content?: number[] } };
	const quad = model.model?.content;
	if (!quad || quad.length < 8) {
		throw new Error(`No box model for backend node ${backendNodeId}`);
	}
	const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
	const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
	return { x, y, nodeId };
}

async function resolveAxTarget(
	electronProcess: ElectronProcess,
	options: { name: string; role?: string; exact?: boolean; targetId?: string },
): Promise<{ targetId: string; node: AxMatchNode }> {
	const snap = await getAccessibilitySnapshot(electronProcess, {
		targetId: options.targetId,
		maxNodes: 2000,
	});
	const node = matchAxNode(snap.nodes, options);
	if (!node?.backendDOMNodeId) {
		const hint = axHint(snap.nodes);
		throw new Error(
			`No accessibility node matching name "${options.name}"${
				options.role ? ` role "${options.role}"` : ""
			}${hint ? `. Nearby: ${hint}` : ""}`,
		);
	}
	return { targetId: snap.targetId, node };
}

export async function clickByAx(
	electronProcess: ElectronProcess,
	options: {
		name: string;
		role?: string;
		exact?: boolean;
		button?: "left" | "right" | "middle";
		targetId?: string;
	},
): Promise<{
	processId: string;
	targetId: string;
	name?: string;
	role?: string;
	x: number;
	y: number;
	backendDOMNodeId: number;
}> {
	const { targetId, node } = await resolveAxTarget(electronProcess, options);
	const center = await boxCenterForBackendNode(
		electronProcess,
		targetId,
		node.backendDOMNodeId!,
	);
	const x = Math.round(center.x);
	const y = Math.round(center.y);
	await dispatchClick(
		electronProcess,
		targetId,
		x,
		y,
		options.button ?? "left",
	);
	return {
		processId: electronProcess.id,
		targetId,
		name: node.name,
		role: node.role,
		x,
		y,
		backendDOMNodeId: node.backendDOMNodeId!,
	};
}

export async function typeByAx(
	electronProcess: ElectronProcess,
	options: {
		name: string;
		text: string;
		role?: string;
		exact?: boolean;
		clear?: boolean;
		targetId?: string;
	},
): Promise<{
	processId: string;
	targetId: string;
	name?: string;
	role?: string;
	typed: string;
}> {
	const { targetId, node } = await resolveAxTarget(electronProcess, options);
	await cdpTimed(electronProcess, targetId, "DOM.focus", {
		backendNodeId: node.backendDOMNodeId,
	});
	if (options.clear) {
		await evalPage(
			electronProcess,
			targetId,
			`(() => {
				const el = document.activeElement;
				if (!el) return false;
				if ("value" in el) el.value = "";
				else el.textContent = "";
				el.dispatchEvent(new Event("input", { bubbles: true }));
				return true;
			})()`,
		);
	}
	if (options.text) {
		await cdpTimed(electronProcess, targetId, "Input.insertText", {
			text: options.text,
		});
	}
	return {
		processId: electronProcess.id,
		targetId,
		name: node.name,
		role: node.role,
		typed: options.text,
	};
}

type StubRule = {
	id: string;
	urlPattern: string;
	action: "fulfill" | "fail";
	status: number;
	body?: string;
	contentType?: string;
	headers?: Record<string, string>;
	errorReason?: string;
};

type BoundClient = {
	on(event: string, callback: (params: unknown) => void): void;
	removeListener(event: string, callback: (params: unknown) => void): void;
	send(method: string, params?: object): Promise<unknown>;
};

type StubSession = {
	targetId: string;
	rules: StubRule[];
	client?: BoundClient;
	handler?: (params: unknown) => void;
};

const stubSessions = new Map<string, StubSession>();

function unbind(
	client: BoundClient | undefined,
	event: string,
	handler?: (params: unknown) => void,
): void {
	if (!client || !handler) return;
	try {
		client.removeListener(event, handler);
	} catch {
		/* ignore */
	}
}

async function onFetchPaused(
	electronProcess: ElectronProcess,
	targetId: string,
	params: unknown,
): Promise<void> {
	const paused = (params ?? {}) as {
		requestId?: string;
		request?: { url?: string };
	};
	if (!paused.requestId) return;
	const session = stubSessions.get(electronProcess.id);
	const url = paused.request?.url ?? "";
	const rule = session?.rules.find((r) => urlPatternMatches(r.urlPattern, url));
	try {
		const client = await connectToCDPTarget(electronProcess, targetId);
		if (!rule) {
			await client.send("Fetch.continueRequest", { requestId: paused.requestId });
			return;
		}
		if (rule.action === "fail") {
			await client.send("Fetch.failRequest", {
				requestId: paused.requestId,
				errorReason: rule.errorReason ?? "Failed",
			});
			return;
		}
		const headerMap = new Map<string, string>();
		headerMap.set(
			"Content-Type",
			rule.contentType ?? "text/plain; charset=utf-8",
		);
		for (const [name, value] of Object.entries(rule.headers ?? {})) {
			headerMap.set(name, value);
		}
		const responseHeaders = [...headerMap.entries()].map(([name, value]) => ({
			name,
			value,
		}));
		await client.send("Fetch.fulfillRequest", {
			requestId: paused.requestId,
			responseCode: rule.status,
			responsePhrase: rule.status === 200 ? "OK" : "Stubbed",
			responseHeaders,
			body: Buffer.from(rule.body ?? "", "utf8").toString("base64"),
		});
	} catch (err) {
		log.warn(
			`[${electronProcess.id}] Fetch stub for ${url || paused.requestId} failed:`,
			err,
		);
	}
}

async function bindStubSession(
	electronProcess: ElectronProcess,
	session: StubSession,
): Promise<void> {
	await ensureMonitoring(electronProcess);
	const client = await connectToCDPTarget(electronProcess, session.targetId);
	if (session.client && session.handler && session.client !== client) {
		unbind(session.client, "Fetch.requestPaused", session.handler);
	}
	if (!session.handler || session.client !== client) {
		unbind(session.client, "Fetch.requestPaused", session.handler);
		const handler = (params: unknown) => {
			void onFetchPaused(electronProcess, session.targetId, params);
		};
		client.on("Fetch.requestPaused", handler);
		session.handler = handler;
		session.client = client;
	}
	await withTimeout(
		client.send("Fetch.enable", {
			patterns: session.rules.map((rule) => ({
				urlPattern: rule.urlPattern,
				requestStage: "Request",
			})),
		}),
		CDP_TIMEOUT_MS,
		"Fetch.enable",
	);
}

registerProcessCleanup((processId) => {
	const session = stubSessions.get(processId);
	stubSessions.delete(processId);
	if (!session) return;
	unbind(session.client, "Fetch.requestPaused", session.handler);
	void (async () => {
		try {
			const proc = getProcess(processId);
			if (!proc) return;
			await executeCDPCommand(
				proc,
				session.targetId,
				"Fetch.disable",
				{},
				5_000,
			).catch(() => undefined);
		} catch {
			/* ignore */
		}
	})();
});

const MAX_STUB_BODY = 256_000;

export async function networkStub(
	electronProcess: ElectronProcess,
	options: {
		urlPattern: string;
		action: "fulfill" | "fail";
		status?: number;
		body?: string;
		contentType?: string;
		headers?: Record<string, string>;
		errorReason?: string;
		targetId?: string;
	},
): Promise<{
	processId: string;
	targetId: string;
	rule: { id: string; urlPattern: string; action: string; status: number };
	ruleCount: number;
}> {
	const pattern = options.urlPattern.trim();
	if (!pattern) throw new Error("urlPattern is required");
	if (options.body && options.body.length > MAX_STUB_BODY) {
		throw new Error(`Stub body exceeds ${MAX_STUB_BODY} characters`);
	}
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, options.targetId);
	let session = stubSessions.get(electronProcess.id);
	if (!session || session.targetId !== target.id) {
		if (session) {
			unbind(session.client, "Fetch.requestPaused", session.handler);
			try {
				await executeCDPCommand(
					electronProcess,
					session.targetId,
					"Fetch.disable",
					{},
					5_000,
				);
			} catch {
				/* previous target may already be gone */
			}
		}
		session = { targetId: target.id, rules: [] };
		stubSessions.set(electronProcess.id, session);
	}
	const rule: StubRule = {
		id: crypto.randomBytes(4).toString("hex"),
		urlPattern: pattern,
		action: options.action,
		status: options.status ?? (options.action === "fail" ? 0 : 200),
		body: options.body,
		contentType: options.contentType,
		headers: options.headers,
		errorReason: options.errorReason,
	};
	session.rules = [
		...session.rules.filter((existing) => existing.urlPattern !== pattern),
		rule,
	];
	await bindStubSession(electronProcess, session);
	return {
		processId: electronProcess.id,
		targetId: target.id,
		rule: {
			id: rule.id,
			urlPattern: rule.urlPattern,
			action: rule.action,
			status: rule.status,
		},
		ruleCount: session.rules.length,
	};
}

export async function clearNetworkStubs(
	electronProcess: ElectronProcess,
): Promise<{ processId: string; cleared: boolean; removed: number }> {
	const session = stubSessions.get(electronProcess.id);
	stubSessions.delete(electronProcess.id);
	const removed = session?.rules.length ?? 0;
	if (session) {
		unbind(session.client, "Fetch.requestPaused", session.handler);
		try {
			await executeCDPCommand(
				electronProcess,
				session.targetId,
				"Fetch.disable",
				{},
				5_000,
			);
		} catch {
			/* session may already be gone */
		}
	}
	return { processId: electronProcess.id, cleared: true, removed };
}

export async function waitNetworkIdle(
	electronProcess: ElectronProcess,
	options: { idleMs?: number; timeoutMs?: number; targetId?: string } = {},
): Promise<{
	processId: string;
	idle: true;
	waitedMs: number;
	requests: number;
	inFlight: number;
}> {
	await ensureMonitoring(electronProcess);
	const idleMs = Math.min(Math.max(options.idleMs ?? 500, 50), 10_000);
	const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 8_000, idleMs), 30_000);
	const started = Date.now();
	let lastCount = -1;
	let lastChange = started;
	const entriesFor = () =>
		options.targetId
			? electronProcess.networkEntries.filter(
					(entry) => entry.targetId === options.targetId,
				)
			: electronProcess.networkEntries;

	while (Date.now() - started < timeoutMs) {
		const entries = entriesFor();
		if (entries.length !== lastCount) {
			lastCount = entries.length;
			lastChange = Date.now();
		}
		const inFlight = countInFlight(entries);
		if (inFlight === 0 && Date.now() - lastChange >= idleMs) {
			return {
				processId: electronProcess.id,
				idle: true,
				waitedMs: Date.now() - started,
				requests: entries.length,
				inFlight: 0,
			};
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	const entries = entriesFor();
	throw new Error(
		`Network not idle after ${timeoutMs}ms (${countInFlight(entries)} in flight, ${entries.length} buffered)`,
	);
}

export async function exportHar(
	electronProcess: ElectronProcess,
	filePath?: string,
): Promise<{ processId: string; path: string; bytes: number; entries: number }> {
	await ensureMonitoring(electronProcess);
	const har = networkEntriesToHar(electronProcess.networkEntries);
	const out =
		filePath?.trim() ||
		path.join(
			os.tmpdir(),
			`electron-mcp-har-${electronProcess.id}-${Date.now()}.har`,
		);
	const resolved = validateOutputPath(out);
	const body = JSON.stringify(har, null, 2);
	fs.mkdirSync(path.dirname(resolved), { recursive: true });
	fs.writeFileSync(resolved, body);
	return {
		processId: electronProcess.id,
		path: resolved,
		bytes: Buffer.byteLength(body),
		entries: har.log.entries.length,
	};
}

type DialogSeen = {
	at: string;
	type?: string;
	message?: string;
	url?: string;
};

type DialogSession = {
	targetId: string;
	action: "accept" | "dismiss";
	promptText?: string;
	seen: DialogSeen[];
	client?: BoundClient;
	handler?: (params: unknown) => void;
};

const dialogSessions = new Map<string, DialogSession>();

async function onDialogOpened(
	electronProcess: ElectronProcess,
	params: unknown,
): Promise<void> {
	const session = dialogSessions.get(electronProcess.id);
	if (!session?.client) return;
	const dialog = (params ?? {}) as {
		type?: string;
		message?: string;
		url?: string;
		defaultPrompt?: string;
	};
	session.seen.push({
		at: new Date().toISOString(),
		type: dialog.type,
		message: dialog.message,
		url: dialog.url,
	});
	if (session.seen.length > 20) session.seen.splice(0, session.seen.length - 20);
	try {
		await session.client.send("Page.handleJavaScriptDialog", {
			accept: session.action === "accept",
			...(session.action === "accept" && session.promptText != null
				? { promptText: session.promptText }
				: {}),
		});
	} catch (err) {
		log.warn(`[${electronProcess.id}] handle dialog failed:`, err);
	}
}

registerProcessCleanup((processId) => {
	const session = dialogSessions.get(processId);
	dialogSessions.delete(processId);
	if (!session) return;
	unbind(session.client, "Page.javascriptDialogOpening", session.handler);
});

export async function handleDialog(
	electronProcess: ElectronProcess,
	options: {
		action?: "accept" | "dismiss";
		promptText?: string;
		clear?: boolean;
		targetId?: string;
	},
): Promise<{
	processId: string;
	targetId?: string;
	action?: "accept" | "dismiss";
	cleared?: boolean;
	seen: DialogSeen[];
}> {
	if (options.clear) {
		const existing = dialogSessions.get(electronProcess.id);
		dialogSessions.delete(electronProcess.id);
		if (existing) {
			unbind(existing.client, "Page.javascriptDialogOpening", existing.handler);
		}
		return {
			processId: electronProcess.id,
			cleared: true,
			seen: existing?.seen ?? [],
		};
	}
	if (!options.action) {
		throw new Error("handle_dialog requires action or clear:true");
	}
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, options.targetId);
	await ensureMonitoring(electronProcess);
	const client = await connectToCDPTarget(electronProcess, target.id);
	let session = dialogSessions.get(electronProcess.id);
	if (!session || session.targetId !== target.id || session.client !== client) {
		if (session) {
			unbind(session.client, "Page.javascriptDialogOpening", session.handler);
		}
		session = {
			targetId: target.id,
			action: options.action,
			promptText: options.promptText,
			seen: session?.seen ?? [],
		};
		const handler = (params: unknown) => {
			void onDialogOpened(electronProcess, params);
		};
		client.on("Page.javascriptDialogOpening", handler);
		session.handler = handler;
		session.client = client;
		dialogSessions.set(electronProcess.id, session);
	}
	session.action = options.action;
	session.promptText = options.promptText;
	await cdpTimed(electronProcess, target.id, "Page.enable", {});
	return {
		processId: electronProcess.id,
		targetId: target.id,
		action: session.action,
		seen: session.seen,
	};
}

export async function highlightSelector(
	electronProcess: ElectronProcess,
	options: { selector: string; targetId?: string; durationMs?: number },
): Promise<{
	processId: string;
	targetId: string;
	selector: string;
	nodeId: number;
	hidden: boolean;
}> {
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, options.targetId);
	await cdpTimed(electronProcess, target.id, "DOM.enable", {});
	const doc = (await cdpTimed(electronProcess, target.id, "DOM.getDocument", {
		depth: 0,
		pierce: true,
	})) as { root?: { nodeId?: number } };
	const rootId = doc.root?.nodeId;
	if (!rootId) throw new Error("DOM.getDocument returned no root");
	const queried = (await cdpTimed(
		electronProcess,
		target.id,
		"DOM.querySelector",
		{ nodeId: rootId, selector: options.selector },
	)) as { nodeId?: number };
	if (!queried.nodeId) {
		throw new Error(`No node for selector ${options.selector}`);
	}
	try {
		await cdpTimed(electronProcess, target.id, "DOM.scrollIntoViewIfNeeded", {
			nodeId: queried.nodeId,
		});
	} catch {
		/* ignore */
	}
	await cdpTimed(electronProcess, target.id, "Overlay.enable", {});
	await cdpTimed(electronProcess, target.id, "Overlay.highlightNode", {
		nodeId: queried.nodeId,
		highlightConfig: {
			showInfo: true,
			contentColor: { r: 16, g: 185, b: 129, a: 0.35 },
			borderColor: { r: 15, g: 118, b: 110, a: 0.9 },
		},
	});
	const durationMs = Math.min(Math.max(options.durationMs ?? 0, 0), 5_000);
	if (durationMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, durationMs));
		try {
			await cdpTimed(electronProcess, target.id, "Overlay.hideHighlight", {});
		} catch {
			/* ignore */
		}
	}
	return {
		processId: electronProcess.id,
		targetId: target.id,
		selector: options.selector,
		nodeId: queried.nodeId,
		hidden: durationMs > 0,
	};
}

export type UiAssertion = {
	name: string;
	ok: boolean;
	detail?: string;
};

export async function assertUi(
	electronProcess: ElectronProcess,
	options: {
		urlIncludes?: string;
		titleIncludes?: string;
		textIncludes?: string;
		selector?: string;
		selectorHidden?: string;
		maxConsoleErrors?: number;
		expression?: string;
		targetId?: string;
	},
): Promise<{
	processId: string;
	targetId: string;
	pass: boolean;
	checks: UiAssertion[];
}> {
	await ensureMonitoring(electronProcess);
	await updateCDPTargets(electronProcess);
	const page = await getPageInfo(electronProcess, options.targetId);
	const checks: UiAssertion[] = [];

	if (options.urlIncludes != null) {
		checks.push({
			name: "urlIncludes",
			ok: page.url.includes(options.urlIncludes),
			detail: page.url,
		});
	}
	if (options.titleIncludes != null) {
		checks.push({
			name: "titleIncludes",
			ok: page.title.includes(options.titleIncludes),
			detail: page.title,
		});
	}
	if (options.textIncludes != null) {
		try {
			const text = String(
				(await evalPage(
					electronProcess,
					page.targetId,
					"document.body ? document.body.innerText : ''",
				)) ?? "",
			);
			checks.push({
				name: "textIncludes",
				ok: text.includes(options.textIncludes),
				detail: text.slice(0, 300),
			});
		} catch (err) {
			checks.push({
				name: "textIncludes",
				ok: false,
				detail: err instanceof Error ? err.message : String(err),
			});
		}
	}
	if (options.selector != null) {
		try {
			const found = await evalPage(
				electronProcess,
				page.targetId,
				`!!document.querySelector(${JSON.stringify(options.selector)})`,
			);
			checks.push({
				name: "selector",
				ok: Boolean(found),
				detail: options.selector,
			});
		} catch (err) {
			checks.push({
				name: "selector",
				ok: false,
				detail: err instanceof Error ? err.message : String(err),
			});
		}
	}
	if (options.selectorHidden != null) {
		try {
			const found = await evalPage(
				electronProcess,
				page.targetId,
				`!!document.querySelector(${JSON.stringify(options.selectorHidden)})`,
			);
			checks.push({
				name: "selectorHidden",
				ok: !found,
				detail: options.selectorHidden,
			});
		} catch (err) {
			checks.push({
				name: "selectorHidden",
				ok: false,
				detail: err instanceof Error ? err.message : String(err),
			});
		}
	}
	if (options.maxConsoleErrors != null) {
		const errors = electronProcess.consoleMessages.filter(
			(message) => message.level === "error" || message.source === "exception",
		).length;
		checks.push({
			name: "maxConsoleErrors",
			ok: errors <= options.maxConsoleErrors,
			detail: String(errors),
		});
	}
	if (options.expression != null) {
		try {
			const value = await evalPage(
				electronProcess,
				page.targetId,
				options.expression,
			);
			checks.push({
				name: "expression",
				ok: Boolean(value),
				detail: JSON.stringify(value)?.slice(0, 200),
			});
		} catch (err) {
			checks.push({
				name: "expression",
				ok: false,
				detail: err instanceof Error ? err.message : String(err),
			});
		}
	}
	if (checks.length === 0) {
		throw new Error("assert_ui needs at least one check");
	}
	return {
		processId: electronProcess.id,
		targetId: page.targetId,
		pass: checks.every((check) => check.ok),
		checks,
	};
}

export async function openDeepLink(
	electronProcess: ElectronProcess,
	options: { url: string; channel?: string },
): Promise<Record<string, unknown>> {
	const url = options.url.trim();
	if (!url) throw new Error("url is required");
	const expression = `(() => {
		try {
			const electron = (${LOAD_ELECTRON})();
			const { app, BrowserWindow } = electron;
			const url = ${JSON.stringify(url)};
			const channel = ${JSON.stringify(options.channel ?? "")};
			const delivered = [];
			try {
				const listeners = app.emit("open-url", { preventDefault() {} }, url);
				delivered.push({ event: "open-url", listeners: !!listeners });
			} catch (err) {
				delivered.push({ event: "open-url", error: err && err.message ? err.message : String(err) });
			}
			try {
				const listeners = app.emit("second-instance", {}, [process.execPath, url], process.cwd());
				delivered.push({ event: "second-instance", listeners: !!listeners });
			} catch (err) {
				delivered.push({ event: "second-instance", error: err && err.message ? err.message : String(err) });
			}
			const wins = BrowserWindow.getAllWindows().filter((w) => w && !w.isDestroyed());
			if (channel && wins[0]) {
				try {
					wins[0].webContents.send(channel, url);
					delivered.push({ event: "ipc", channel });
				} catch (err) {
					delivered.push({ event: "ipc", error: err && err.message ? err.message : String(err) });
				}
			}
			return {
				ok: true,
				url,
				windowCount: wins.length,
				delivered,
				recorded: global.__LAST_DEEP_LINK__ || null,
			};
		} catch (err) {
			return { ok: false, error: err && err.message ? err.message : String(err) };
		}
	})()`;

	const result = await withTimeout(
		evaluateMain(electronProcess, expression, undefined, true),
		CDP_TIMEOUT_MS,
		"open_deep_link",
	);
	const value = (result.result as { result?: { value?: Record<string, unknown> } })
		?.result?.value;
	if (!value || value.ok === false) {
		throw new Error(
			typeof value?.error === "string" ? value.error : "open_deep_link failed",
		);
	}

	let renderer: unknown = null;
	try {
		const page = await getPageInfo(electronProcess);
		await evalPage(
			electronProcess,
			page.targetId,
			`window.__DEEP_LINK__ = ${JSON.stringify(url)}; true`,
		);
		renderer = url;
	} catch (err) {
		renderer = { error: err instanceof Error ? err.message : String(err) };
	}
	return { processId: electronProcess.id, ...value, renderer };
}
