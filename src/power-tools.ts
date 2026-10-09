/**
 * Creative CDP / Electron power tools layered on process-manager primitives.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
	type ElectronProcess,
	type IpcEntry,
	captureScreenshot,
	connectToCDPTarget,
	ensureMonitoring,
	evaluateMain,
	executeCDPCommand,
	getPageInfo,
	pickPageTarget,
	pushCapped,
	saveScreenshot,
	updateCDPTargets,
	validateOutputPath,
} from "./process-manager.js";
import { log } from "./log.js";

const MAX_IPC = 500;
const cpuProfileSessions = new Map<
	string,
	{ targetId: string; startedAt: number }
>();

function previewArgs(args: unknown): string {
	try {
		const s = JSON.stringify(args);
		return s.length > 500 ? `${s.slice(0, 500)}…` : s;
	} catch {
		return String(args);
	}
}

/** Accessibility tree snapshot (roles / names / backend ids). */
export async function getAccessibilitySnapshot(
	electronProcess: ElectronProcess,
	options: { depth?: number; targetId?: string } = {},
): Promise<{
	targetId: string;
	nodeCount: number;
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
	await executeCDPCommand(electronProcess, target.id, "Accessibility.enable", {});
	const result = (await executeCDPCommand(
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
	const nodes = (result.nodes ?? []).map((n) => ({
		nodeId: n.nodeId,
		role: n.role?.value,
		name: n.name?.value,
		description: n.description?.value,
		backendDOMNodeId: n.backendDOMNodeId,
		ignored: n.ignored,
	}));
	return { targetId: target.id, nodeCount: nodes.length, nodes };
}

/** One-shot agent vision: screenshot + page + errors + network failures. */
export async function getAppVision(
	electronProcess: ElectronProcess,
	options: { targetId?: string; includeScreenshot?: boolean } = {},
): Promise<Record<string, unknown>> {
	await ensureMonitoring(electronProcess);
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, options.targetId);
	const pageInfo = await getPageInfo(electronProcess, target.id);
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
		pid: electronProcess.pid,
		debugPort: electronProcess.debugPort,
		page: pageInfo,
		windows,
		consoleErrors: errors,
		networkFailures: failedNetwork,
		auditIssueCount: electronProcess.auditIssues.length,
		recentAuditIssues: electronProcess.auditIssues.slice(-10),
	};

	if (options.includeScreenshot !== false) {
		try {
			const shot = await captureScreenshot(
				electronProcess,
				target.id,
				"png",
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
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, targetId);
	await executeCDPCommand(electronProcess, target.id, "Network.enable", {});
	const result = (await executeCDPCommand(
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
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, targetId);
	await executeCDPCommand(electronProcess, target.id, "Network.enable", {});
	await executeCDPCommand(electronProcess, target.id, "Network.setBlockedURLs", {
		urls,
	});
	return { targetId: target.id, urls };
}

export async function setExtraHeaders(
	electronProcess: ElectronProcess,
	headers: Record<string, string>,
	targetId?: string,
): Promise<{ targetId: string; headers: Record<string, string> }> {
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, targetId);
	await executeCDPCommand(electronProcess, target.id, "Network.enable", {});
	await executeCDPCommand(
		electronProcess,
		target.id,
		"Network.setExtraHTTPHeaders",
		{ headers },
	);
	return { targetId: target.id, headers };
}

export async function getPerformanceMetrics(
	electronProcess: ElectronProcess,
	targetId?: string,
): Promise<{ targetId: string; metrics: Record<string, number> }> {
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, targetId);
	await executeCDPCommand(electronProcess, target.id, "Performance.enable", {});
	const result = (await executeCDPCommand(
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
	if (cpuProfileSessions.has(electronProcess.id)) {
		throw new Error(
			`CPU profile already active for ${electronProcess.id}. Call stop_cpu_profile first.`,
		);
	}
	await executeCDPCommand(electronProcess, target.id, "Profiler.enable", {});
	await executeCDPCommand(electronProcess, target.id, "Profiler.start", {});
	cpuProfileSessions.set(electronProcess.id, {
		targetId: target.id,
		startedAt: Date.now(),
	});
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
	if (!session) {
		throw new Error(`No active CPU profile for ${electronProcess.id}`);
	}
	const result = (await executeCDPCommand(
		electronProcess,
		session.targetId,
		"Profiler.stop",
		{},
	)) as { profile?: unknown };
	cpuProfileSessions.delete(electronProcess.id);
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

export async function takeHeapSnapshot(
	electronProcess: ElectronProcess,
	filePath?: string,
	targetId?: string,
): Promise<{ processId: string; targetId: string; path: string; bytes: number }> {
	await updateCDPTargets(electronProcess);
	const target = pickPageTarget(electronProcess, targetId);
	const client = await connectToCDPTarget(electronProcess, target.id);

	await executeCDPCommand(electronProcess, target.id, "HeapProfiler.enable", {});

	const chunks: string[] = [];
	const onChunk = (params: unknown) => {
		const p = params as { chunk?: string };
		if (p.chunk) chunks.push(p.chunk);
	};
	client.on("HeapProfiler.addHeapSnapshotChunk", onChunk);

	try {
		await executeCDPCommand(
			electronProcess,
			target.id,
			"HeapProfiler.takeHeapSnapshot",
			{ reportProgress: false },
		);
		// Allow final chunks to flush
		await new Promise((r) => setTimeout(r, 50));
	} finally {
		try {
			(
				client as {
					removeListener: (event: string, fn: typeof onChunk) => void;
				}
			).removeListener("HeapProfiler.addHeapSnapshotChunk", onChunk);
		} catch {
			// ignore
		}
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
			const electron = require('electron');
			const { app, BrowserWindow } = electron;
			const windows = BrowserWindow.getAllWindows().map((w) => ({
				id: w.id,
				title: w.getTitle(),
				url: (() => { try { return w.webContents.getURL(); } catch { return null; } })(),
				bounds: w.getBounds(),
				isVisible: w.isVisible(),
				isFocused: w.isFocused(),
				isMinimized: w.isMinimized(),
				isDestroyed: w.isDestroyed(),
			}));
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
				metrics: syn(app.getAppMetrics?.() ?? []),
				windows,
			};
		} catch (err) {
			return { ok: false, error: err && err.message ? err.message : String(err) };
		}
	})()`;
	const result = await evaluateMain(electronProcess, expression, undefined, true);
	const value = (result.result as { result?: { value?: unknown } })?.result
		?.value;
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
		const { ipcMain, BrowserWindow } = require('electron');
		if (global.__electronMcpIpcTapInstalled) {
			return { ok: true, already: true, count: (global.__electronMcpIpcLog || []).length };
		}
		global.__electronMcpIpcLog = global.__electronMcpIpcLog || [];
		const push = (entry) => {
			global.__electronMcpIpcLog.push(entry);
			if (global.__electronMcpIpcLog.length > 500) global.__electronMcpIpcLog.shift();
		};
		const wrapSend = (wc) => {
			if (wc.__electronMcpIpcWrapped) return;
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
		};
		for (const w of BrowserWindow.getAllWindows()) wrapSend(w.webContents);
		const { app } = require('electron');
		app.on('web-contents-created', (_e, wc) => wrapSend(wc));
		const origHandle = ipcMain.handle.bind(ipcMain);
		ipcMain.handle = (channel, listener) => {
			return origHandle(channel, async (event, ...args) => {
				push({ timestamp: new Date().toISOString(), direction: 'handle', channel: String(channel), argsPreview: syn(args) });
				return listener(event, ...args);
			});
		};
		global.__electronMcpIpcTapInstalled = true;
		return { ok: true, already: false, count: 0 };
	} catch (err) {
		return { ok: false, error: err && err.message ? err.message : String(err) };
	}
})()`;

export async function enableIpcTap(
	electronProcess: ElectronProcess,
): Promise<Record<string, unknown>> {
	const result = await evaluateMain(electronProcess, IPC_TAP_EXPR, undefined, true);
	const value = (result.result as { result?: { value?: unknown } })?.result
		?.value as Record<string, unknown> | undefined;
	return { processId: electronProcess.id, targetId: result.targetId, ...(value ?? {}) };
}

export async function getIpcLog(
	electronProcess: ElectronProcess,
	options: { tail?: number; refreshFromMain?: boolean } = {},
): Promise<{ processId: string; entries: IpcEntry[] }> {
	if (options.refreshFromMain !== false) {
		try {
			const drain = await evaluateMain(
				electronProcess,
				`(() => {
					const log = global.__electronMcpIpcLog || [];
					global.__electronMcpIpcLog = [];
					return log;
				})()`,
				undefined,
				true,
			);
			const value = (drain.result as { result?: { value?: IpcEntry[] } })?.result
				?.value;
			if (Array.isArray(value)) {
				for (const entry of value) {
					pushCapped(electronProcess.ipcEntries, entry, MAX_IPC);
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

	let currentPath = options.currentPath;
	let captured: Awaited<ReturnType<typeof saveScreenshot>> | undefined;
	if (!currentPath) {
		const tmp = path.join(
			os.tmpdir(),
			`electron-mcp-diff-${electronProcess.id}-${Date.now()}.png`,
		);
		captured = await saveScreenshot(
			electronProcess,
			tmp,
			options.targetId,
			"png",
			undefined,
			options.selector,
		);
		currentPath = captured.path;
	}
	const currentResolved = validateOutputPath(currentPath);
	const currentBuf = fs.readFileSync(currentResolved);
	const identical = baselineBuf.equals(currentBuf);
	return {
		processId: electronProcess.id,
		baselinePath: baseline,
		currentPath: currentResolved,
		identical,
		similarity: identical ? 1 : Number(byteSimilarity(baselineBuf, currentBuf).toFixed(4)),
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

/** Best-effort scan for installed Electron apps (packaged). */
export async function findInstalledElectronApps(): Promise<
	InstalledElectronApp[]
> {
	const found: InstalledElectronApp[] = [];
	const seen = new Set<string>();
	const add = (app: InstalledElectronApp) => {
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

	if (process.platform === "darwin") {
		for (const root of [
			"/Applications",
			path.join(os.homedir(), "Applications"),
		]) {
			let entries: string[] = [];
			try {
				entries = fs.readdirSync(root);
			} catch {
				continue;
			}
			for (const name of entries) {
				if (!name.endsWith(".app")) continue;
				const appPath = path.join(root, name);
				const frameworks = path.join(
					appPath,
					"Contents",
					"Frameworks",
					"Electron Framework.framework",
				);
				const asar = path.join(appPath, "Contents", "Resources", "app.asar");
				if (fs.existsSync(frameworks) || fs.existsSync(asar) || looksElectronDir(path.join(appPath, "Contents", "MacOS"))) {
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
			let entries: string[] = [];
			try {
				entries = fs.readdirSync(root);
			} catch {
				continue;
			}
			for (const name of entries) {
				const dir = path.join(root, name);
				try {
					if (!fs.statSync(dir).isDirectory()) continue;
				} catch {
					continue;
				}
				if (looksElectronDir(dir)) {
					const exe =
						[
							path.join(dir, `${name}.exe`),
							path.join(dir, "app.exe"),
						].find((p) => fs.existsSync(p)) ?? dir;
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
		// Linux: .desktop files that mention electron / asar
		for (const root of [
			"/usr/share/applications",
			path.join(os.homedir(), ".local/share/applications"),
		]) {
			let entries: string[] = [];
			try {
				entries = fs.readdirSync(root);
			} catch {
				continue;
			}
			for (const name of entries) {
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
