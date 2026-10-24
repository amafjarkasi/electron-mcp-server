import fs from "fs";
import path from "path";
import os from "os";
import type { ElectronProcess } from "./process-manager.js";
import {
	executeCDPCommand,
	pickPageTarget,
	pickMainTarget,
	updateCDPTargets,
	evaluateMain,
	resolveOutputPath,
	elementCenter,
	getCookies,
} from "./process-manager.js";
import {
	boxCenterForBackendNode,
	getAccessibilitySnapshot,
	LOAD_ELECTRON,
} from "./power-tools.js";

async function evalInMainProcess<T = any>(
	proc: ElectronProcess,
	expression: string,
	targetId?: string,
): Promise<{ value: T; targetId: string }> {
	const res = await evaluateMain(proc, expression, targetId, true);
	const cdpRes = res.result as {
		result?: { value?: T };
		exceptionDetails?: { text?: string; exception?: { description?: string } };
	};
	if (cdpRes?.exceptionDetails) {
		const desc =
			cdpRes.exceptionDetails.exception?.description ||
			cdpRes.exceptionDetails.text ||
			"Evaluation error in main process";
		throw new Error(desc);
	}
	return {
		value: (cdpRes?.result?.value as T) ?? ({} as T),
		targetId: res.targetId,
	};
}
import { registerArtifact } from "./artifacts.js";

// ============================================================================
// 1. REF RESOLUTION & SET-OF-MARKS HELPERS
// ============================================================================

/**
 * Resolve an accessibility reference string (e.g. "e1", "e12", or "12") to a backendDOMNodeId.
 */
export async function resolveBackendNodeFromRef(
	proc: ElectronProcess,
	ref: string,
	targetId?: string,
): Promise<number> {
	if (!proc.axRefMap) {
		proc.axRefMap = new Map();
	}

	const normalized = String(ref).trim();
	let id = proc.axRefMap.get(normalized);
	if (id != null) return id;

	// Try without 'e' or 'E' prefix, or adding 'e' prefix
	const stripped = normalized.replace(/^e/i, "");
	id = proc.axRefMap.get(stripped) ?? proc.axRefMap.get("e" + stripped) ?? proc.axRefMap.get("E" + stripped);
	if (id != null) return id;

	// If numeric, check if stored as numeric string
	if (/^\d+$/.test(stripped)) {
		const parsed = parseInt(stripped, 10);
		if (proc.axRefMap.has(String(parsed))) {
			return proc.axRefMap.get(String(parsed))!;
		}
	}

	// Not in cache: refresh accessibility snapshot to populate cache
	const snap = await getAccessibilitySnapshot(proc, {
		targetId,
		maxNodes: 2000,
	});

	id = proc.axRefMap.get(normalized) ?? proc.axRefMap.get(stripped);
	if (id != null) return id;

	if (/^\d+$/.test(stripped)) {
		const parsed = parseInt(stripped, 10);
		const match = snap.nodes.find((n) => n.backendDOMNodeId === parsed);
		if (match?.backendDOMNodeId != null) {
			proc.axRefMap.set(normalized, match.backendDOMNodeId);
			return match.backendDOMNodeId;
		}
	}

	throw new Error(
		`Accessibility ref "${ref}" not found. Run 'snapshot' to view available interactive elements and refs.`,
	);
}

/**
 * Resolve element center coordinates for an action, accepting either selector or ref.
 */
export async function resolveActionTarget(
	proc: ElectronProcess,
	options: { selector?: string; ref?: string; targetId?: string },
): Promise<{
	targetId: string;
	x: number;
	y: number;
	selector?: string;
	ref?: string;
	backendDOMNodeId?: number;
}> {
	await updateCDPTargets(proc);
	const target = pickPageTarget(proc, options.targetId);

	if (options.ref) {
		const backendDOMNodeId = await resolveBackendNodeFromRef(
			proc,
			options.ref,
			target.id,
		);
		const center = await boxCenterForBackendNode(
			proc,
			target.id,
			backendDOMNodeId,
		);
		return {
			targetId: target.id,
			x: Math.round(center.x),
			y: Math.round(center.y),
			ref: options.ref,
			backendDOMNodeId,
		};
	}

	if (options.selector) {
		const center = await elementCenter(proc, target.id, options.selector);
		return {
			targetId: target.id,
			x: Math.round(center.x),
			y: Math.round(center.y),
			selector: options.selector,
		};
	}

	throw new Error("Must provide either 'selector' or 'ref'");
}

/**
 * Injects Set-of-Marks visual badge overlays on interactive elements in the DOM.
 */
export async function injectSetOfMarks(
	proc: ElectronProcess,
	targetId: string,
): Promise<number> {
	const result = (await executeCDPCommand(
		proc,
		targetId,
		"Runtime.evaluate",
		{
			expression: `(() => {
				const existing = document.getElementById('__electron_som_container__');
				if (existing) existing.remove();

				const container = document.createElement('div');
				container.id = '__electron_som_container__';
				container.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;';

				const selectors = 'button, a, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';
				const elements = Array.from(document.querySelectorAll(selectors));
				let count = 0;
				for (const el of elements) {
					const r = el.getBoundingClientRect();
					if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth) {
						count++;
						const badge = document.createElement('div');
						badge.textContent = 'e' + count;
						badge.style.cssText = 'position:absolute;' +
							'left:' + Math.max(0, Math.round(r.left)) + 'px;' +
							'top:' + Math.max(0, Math.round(r.top)) + 'px;' +
							'background:#dc2626;color:#ffffff;font-family:monospace;' +
							'font-size:10px;font-weight:700;line-height:1;' +
							'padding:2px 4px;border-radius:3px;' +
							'border:1px solid #ffffff;box-shadow:0 1px 3px rgba(0,0,0,0.5);';
						container.appendChild(badge);
					}
				}
				document.body.appendChild(container);
				return count;
			})()`,
			returnByValue: true,
			awaitPromise: true,
		},
	)) as { result?: { value?: number } };

	return result.result?.value ?? 0;
}

/**
 * Removes injected Set-of-Marks badges from the DOM.
 */
export async function removeSetOfMarks(
	proc: ElectronProcess,
	targetId: string,
): Promise<void> {
	try {
		await executeCDPCommand(proc, targetId, "Runtime.evaluate", {
			expression: `(() => {
				const container = document.getElementById('__electron_som_container__');
				if (container) container.remove();
			})()`,
			returnByValue: true,
		});
	} catch {
		// Ignore cleanup errors
	}
}

// ============================================================================

async function resolveMainTargetWithRetry(
	proc: ElectronProcess,
	targetId?: string,
) {
	await updateCDPTargets(proc, true);
	try {
		return pickMainTarget(proc, targetId);
	} catch (err) {
		await new Promise((r) => setTimeout(r, 300));
		await updateCDPTargets(proc, true);
		return pickMainTarget(proc, targetId);
	}
}

// 2. ELECTRON NATIVE API MOCKING
// ============================================================================

export async function mockElectronApi(
	proc: ElectronProcess,
	options: {
		module: string;
		method: string;
		returns?: unknown;
		implementation?: string;
		targetId?: string;
	},
): Promise<{
	module: string;
	method: string;
	mocked: boolean;
	targetId: string;
}> {
	const expression = `(() => {
		const electron = (${LOAD_ELECTRON})();
		const modName = ${JSON.stringify(options.module)};
		const methodName = ${JSON.stringify(options.method)};
		const targetMod = electron[modName];
		if (!targetMod) {
			throw new Error("Electron module not found: " + modName);
		}

		globalThis.__ELECTRON_MCP_MOCKS__ = globalThis.__ELECTRON_MCP_MOCKS__ || {
			originals: new Map(),
			calls: new Map()
		};
		const store = globalThis.__ELECTRON_MCP_MOCKS__;
		const key = modName + '.' + methodName;

		if (!store.originals.has(key)) {
			store.originals.set(key, targetMod[methodName]);
		}
		store.calls.set(key, []);

		const returnVal = ${JSON.stringify(options.returns)};
		const customImpl = ${options.implementation ? options.implementation : "null"};

		targetMod[methodName] = function(...args) {
			const callEntry = {
				args: args.map(a => {
					try { return JSON.parse(JSON.stringify(a)); } catch { return String(a); }
				}),
				timestamp: Date.now()
			};
		if (!store.calls.has(key)) store.calls.set(key, []);
			store.calls.get(key).push(callEntry);

		if (typeof customImpl === 'function') {
				return customImpl(...args);
			}
			if (typeof returnVal !== 'undefined') {
				return Promise.resolve(returnVal);
			}
			return undefined;
		};

		return { module: modName, method: methodName, mocked: true };
	})()`;

	const res = await evalInMainProcess<{ module: string; method: string; mocked: boolean }>(
		proc,
		expression,
		options.targetId,
	);

	return {
		module: options.module,
		method: options.method,
		mocked: true,
		targetId: res.targetId,
	};
}

export async function getMockCalls(
	proc: ElectronProcess,
	options: {
		module: string;
		method: string;
		targetId?: string;
	},
): Promise<{
	module: string;
	method: string;
	callCount: number;
	calls: Array<{ args: unknown[]; timestamp: number }>;
}> {
	const expression = `(() => {
		const store = globalThis.__ELECTRON_MCP_MOCKS__;
		if (!store || !store.calls) return { callCount: 0, calls: [] };
		const key = ${JSON.stringify(options.module + "." + options.method)};
		const calls = store.calls.get(key) || [];
		return { callCount: calls.length, calls };
	})()`;

	const res = await evalInMainProcess<{ callCount: number; calls: Array<{ args: unknown[]; timestamp: number }> }>(
		proc,
		expression,
		options.targetId,
	);

	const val = res.value ?? { callCount: 0, calls: [] };
	return {
		module: options.module,
		method: options.method,
		callCount: val.callCount,
		calls: val.calls,
	};
}

export async function restoreElectronMocks(
	proc: ElectronProcess,
	options: {
		module?: string;
		method?: string;
		targetId?: string;
	} = {},
): Promise<{ restored: string[] }> {
	const expression = `(() => {
		const store = globalThis.__ELECTRON_MCP_MOCKS__;
		if (!store || !store.originals) return { restored: [] };
		const electron = (${LOAD_ELECTRON})();
		const restored = [];

		const filterKey = ${JSON.stringify(
			options.module && options.method ? `${options.module}.${options.method}` : null,
		)};

		for (const [key, orig] of store.originals.entries()) {
			if (filterKey && key !== filterKey) continue;
			const [modName, methodName] = key.split('.');
			if (electron[modName]) {
				if (typeof orig === 'undefined') {
					delete electron[modName][methodName];
				} else {
					electron[modName][methodName] = orig;
				}
				restored.push(key);
			}
		}

		if (filterKey) {
			store.originals.delete(filterKey);
			store.calls.delete(filterKey);
		} else {
			store.originals.clear();
			store.calls.clear();
		}

		return { restored };
	})()`;

	const res = await evalInMainProcess<{ restored: string[] }>(
		proc,
		expression,
		options.targetId,
	);

	return res.value ?? { restored: [] };
}

// ============================================================================
// 3. APPLICATION MENU & GLOBAL SHORTCUT DRIVER
// ============================================================================

export type MenuItemSummary = {
	label?: string;
	role?: string;
	id?: string;
	type?: string;
	enabled: boolean;
	visible: boolean;
	checked?: boolean;
	accelerator?: string;
	path: string;
	submenu?: MenuItemSummary[];
};

export async function getApplicationMenu(
	proc: ElectronProcess,
	targetId?: string,
): Promise<{
	hasMenu: boolean;
	itemCount: number;
	items: MenuItemSummary[];
}> {
	const expression = `(() => {
		const electron = (${LOAD_ELECTRON})();
		const { Menu } = electron;
		if (!Menu || typeof Menu.getApplicationMenu !== 'function') return { hasMenu: false, itemCount: 0, items: [] };
		const menu = Menu.getApplicationMenu();
		if (!menu || !menu.items) return { hasMenu: false, itemCount: 0, items: [] };

		function serializeItem(item, parentPath) {
			const label = item.label || item.role || '';
			const currentPath = parentPath ? (parentPath + ' > ' + label) : label;
			const res = {
				label: item.label,
				role: item.role,
				id: item.id,
				type: item.type,
				enabled: item.enabled !== false,
				visible: item.visible !== false,
				checked: Boolean(item.checked),
				accelerator: item.accelerator ? String(item.accelerator) : undefined,
				path: currentPath,
			};
		if (item.submenu && item.submenu.items) {
				res.submenu = item.submenu.items.map(sub => serializeItem(sub, currentPath));
			}
			return res;
		}

		const items = menu.items.map(i => serializeItem(i, ''));
		return { hasMenu: true, itemCount: items.length, items };
	})()`;

	const res = await evalInMainProcess<{ hasMenu: boolean; itemCount: number; items: MenuItemSummary[] }>(
		proc,
		expression,
		targetId,
	);

	return res.value ?? { hasMenu: false, itemCount: 0, items: [] };
}

export async function clickMenuItem(
	proc: ElectronProcess,
	options: {
		path?: string;
		id?: string;
		role?: string;
		targetId?: string;
	},
): Promise<{
	clicked: boolean;
	path?: string;
	role?: string;
	id?: string;
}> {
	const expression = `(() => {
		const electron = (${LOAD_ELECTRON})();
		const { Menu, BrowserWindow } = electron;
		if (!Menu || typeof Menu.getApplicationMenu !== 'function') throw new Error("Electron Menu module unavailable in this process");
		const menu = Menu.getApplicationMenu();
		if (!menu || !menu.items) throw new Error("No application menu found in active Electron app");

		const targetPath = ${JSON.stringify(options.path ?? null)};
		const targetId = ${JSON.stringify(options.id ?? null)};
		const targetRole = ${JSON.stringify(options.role ?? null)};

		function findItem(items, parentPath) {
			for (const item of items) {
				const label = item.label || item.role || '';
				const currentPath = parentPath ? (parentPath + ' > ' + label) : label;
				if (
					(targetPath && (currentPath.toLowerCase() === targetPath.toLowerCase() || label.toLowerCase() === targetPath.toLowerCase())) ||
					(targetId && item.id === targetId) ||
					(targetRole && item.role && item.role.toLowerCase() === targetRole.toLowerCase())
				) {
					return { item, path: currentPath };
				}
				if (item.submenu && item.submenu.items) {
					const found = findItem(item.submenu.items, currentPath);
					if (found) return found;
				}
			}
			return null;
		}

		const match = findItem(menu.items, '');
		if (!match) {
			throw new Error("Menu item not found for path/id/role: " + (targetPath || targetId || targetRole));
		}
		if (match.item.enabled === false) {
			throw new Error("Menu item is disabled: " + match.path);
		}

		const focusedWindow = (BrowserWindow && typeof BrowserWindow.getFocusedWindow === 'function') ? (BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]) : null;
		if (typeof match.item.click === 'function') {
			match.item.click(match.item, focusedWindow, {});
		}
		return { clicked: true, path: match.path, role: match.item.role, id: match.item.id };
	})()`;

	const res = await evalInMainProcess<{ clicked: boolean; path?: string; role?: string; id?: string }>(
		proc,
		expression,
		options.targetId,
	);

	return res.value ?? { clicked: true };
}

export async function triggerShortcut(
	proc: ElectronProcess,
	options: {
		accelerator: string;
		targetId?: string;
	},
): Promise<{
	accelerator: string;
	registered: boolean;
	windowFound: boolean;
}> {
	const expression = `(() => {
		const electron = (${LOAD_ELECTRON})();
		const { globalShortcut, BrowserWindow } = electron;
		const acc = ${JSON.stringify(options.accelerator)};
		const isRegistered = Boolean(globalShortcut && typeof globalShortcut.isRegistered === 'function' && globalShortcut.isRegistered(acc));
		const win = (BrowserWindow && typeof BrowserWindow.getFocusedWindow === 'function') ? (BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]) : null;
		return {
			accelerator: acc,
			registered: isRegistered,
			windowFound: Boolean(win)
		};
	})()`;

	const res = await evalInMainProcess<{ accelerator: string; registered: boolean; windowFound: boolean }>(
		proc,
		expression,
		options.targetId,
	);

	return res.value ?? {
		accelerator: options.accelerator,
		registered: false,
		windowFound: false,
	};
}

// ============================================================================
// 4. PROCESS HEALTH & CRASH WATCHDOG
// ============================================================================

export async function getProcessHealth(
	proc: ElectronProcess,
	targetId?: string,
): Promise<{
	status: "healthy" | "unresponsive" | "crashed";
	pid?: number;
	uptimeSeconds: number;
	memory: {
		rssMb: number;
		heapUsedMb: number;
		heapTotalMb: number;
		externalMb: number;
	};
	windows: Array<{ id: number; title: string; responsive: boolean }>;
	crashes: Array<{
		type: string;
		details?: unknown;
		timestamp: number;
		webContentsId?: number;
	}>;
	hangs: Array<{ windowId: number; state: string; timestamp: number }>;
	recentStderrTail: string[];
}> {
	const expression = `(() => {
		const electron = (${LOAD_ELECTRON})();
		const { app, BrowserWindow } = electron;

		// Install listeners once
		if (!globalThis.__ELECTRON_HEALTH_WATCHDOG__) {
			globalThis.__ELECTRON_HEALTH_WATCHDOG__ = true;
			globalThis.__ELECTRON_HEALTH_EVENTS__ = { crashes: [], hangs: [] };

			if (app && typeof app.on === 'function') {
				app.on('render-process-gone', (event, webContents, details) => {
					globalThis.__ELECTRON_HEALTH_EVENTS__.crashes.push({
						type: 'render-process-gone',
						details: details ? JSON.parse(JSON.stringify(details)) : null,
						webContentsId: webContents ? webContents.id : null,
						timestamp: Date.now()
					});
				});

				app.on('child-process-gone', (event, details) => {
					globalThis.__ELECTRON_HEALTH_EVENTS__.crashes.push({
						type: 'child-process-gone',
						details: details ? JSON.parse(JSON.stringify(details)) : null,
						timestamp: Date.now()
					});
				});
			}

			if (app && typeof app.on === 'function') {
				app.on('browser-window-created', (e, win) => {
					win.on('unresponsive', () => {
						globalThis.__ELECTRON_HEALTH_EVENTS__.hangs.push({
							windowId: win.id,
							state: 'unresponsive',
							timestamp: Date.now()
						});
					});
					win.on('responsive', () => {
						globalThis.__ELECTRON_HEALTH_EVENTS__.hangs.push({
							windowId: win.id,
							state: 'responsive',
							timestamp: Date.now()
						});
					});
				});
			}

			// Hook existing windows
			if (BrowserWindow && typeof BrowserWindow.getAllWindows === 'function') {
				for (const win of BrowserWindow.getAllWindows()) {
					win.on('unresponsive', () => {
						globalThis.__ELECTRON_HEALTH_EVENTS__.hangs.push({
							windowId: win.id,
							state: 'unresponsive',
							timestamp: Date.now()
						});
					});
					win.on('responsive', () => {
						globalThis.__ELECTRON_HEALTH_EVENTS__.hangs.push({
							windowId: win.id,
							state: 'responsive',
							timestamp: Date.now()
						});
					});
				}
			}
		}

		const mem = process.memoryUsage();
		const windows = (BrowserWindow && typeof BrowserWindow.getAllWindows === 'function')
			? BrowserWindow.getAllWindows().map(w => ({
				id: w.id,
				title: typeof w.getTitle === 'function' ? w.getTitle() : '',
				responsive: typeof w.isDestroyed === 'function' ? !w.isDestroyed() : true
			}))
			: [];

		const events = globalThis.__ELECTRON_HEALTH_EVENTS__ || { crashes: [], hangs: [] };

		return {
			pid: process.pid,
		uptime: Math.round(process.uptime()),
			memory: {
				rssMb: Math.round(mem.rss / (1024 * 1024)),
				heapUsedMb: Math.round(mem.heapUsed / (1024 * 1024)),
				heapTotalMb: Math.round(mem.heapTotal / (1024 * 1024)),
				externalMb: Math.round(mem.external / (1024 * 1024))
			},
		windows,
			crashes: events.crashes.slice(-20),
			hangs: events.hangs.slice(-20)
		};
	})()`;

	const res = await evalInMainProcess<{
		pid: number;
		uptime: number;
		memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number };
		windows: Array<{ id: number; title: string; responsive: boolean }>;
		crashes: Array<{ type: string; details?: unknown; timestamp: number; webContentsId?: number }>;
		hangs: Array<{ windowId: number; state: string; timestamp: number }>;
	}>(proc, expression, targetId);

	const val = res.value ?? {
		pid: proc.pid ?? process.pid,
		uptime: 0,
		memory: { rssMb: 0, heapUsedMb: 0, heapTotalMb: 0, externalMb: 0 },
		windows: [],
		crashes: [],
		hangs: [],
	};

	const recentStderrTail = proc.logs
		.filter((l) => l.includes("[stderr]") || l.includes("Error") || l.includes("crashed"))
		.slice(-10);

	let status: "healthy" | "unresponsive" | "crashed" = "healthy";
	if (val.crashes && val.crashes.length > 0) {
		status = "crashed";
	} else if (
		(val.hangs && val.hangs.some((h) => h.state === "unresponsive")) ||
		(val.windows && val.windows.some((w) => !w.responsive))
	) {
		status = "unresponsive";
	}

	return {
		status,
		pid: val.pid,
		uptimeSeconds: val.uptime,
		memory: val.memory,
		windows: val.windows,
		crashes: val.crashes,
		hangs: val.hangs,
		recentStderrTail,
	};
}

// ============================================================================
// 5. STORAGE STATE SNAPSHOT & RESTORE
// ============================================================================

export type StorageStatePayload = {
	cookies: Array<{
		name: string;
		value: string;
		domain: string;
		path: string;
		expires?: number;
		httpOnly?: boolean;
		secure?: boolean;
		sameSite?: "Strict" | "Lax" | "None";
	}>;
	origins: Array<{
		origin: string;
		localStorage: Array<{ name: string; value: string }>;
		sessionStorage: Array<{ name: string; value: string }>;
	}>;
};

export async function saveStorageState(
	proc: ElectronProcess,
	options: {
		path?: string;
		targetId?: string;
	} = {},
): Promise<{
	processId: string;
	path?: string;
	artifactUri?: string;
	cookieCount: number;
	originCount: number;
	state: StorageStatePayload;
}> {
	await updateCDPTargets(proc);
	const target = pickPageTarget(proc, options.targetId);

	const cookiesData = await getCookies(proc, { targetId: target.id });
	const cookies = (cookiesData.cookies || []).map((c: any) => ({
		name: c.name,
		value: c.value,
		domain: c.domain,
		path: c.path,
		expires: c.expires,
		httpOnly: c.httpOnly,
		secure: c.secure,
		sameSite: c.sameSite as "Strict" | "Lax" | "None" | undefined,
	}));

	const evalRes = (await executeCDPCommand(
		proc,
		target.id,
		"Runtime.evaluate",
		{
			expression: `(() => {
				const origins = [];
				try {
					const origin = window.location.origin;
					const local = Object.entries(localStorage || {}).map(([name, value]) => ({ name, value: String(value) }));
					const session = Object.entries(sessionStorage || {}).map(([name, value]) => ({ name, value: String(value) }));
					origins.push({ origin, localStorage: local, sessionStorage: session });
				} catch {}
				return origins;
			})()`,
			returnByValue: true,
			awaitPromise: true,
		},
	)) as { result?: { value?: Array<{ origin: string; localStorage: Array<{ name: string; value: string }>; sessionStorage: Array<{ name: string; value: string }> }> } };

	const origins = evalRes.result?.value ?? [];

	const state: StorageStatePayload = {
		cookies,
		origins,
	};

	let finalPath = options.path;
	let artifactUri: string | undefined;

	if (finalPath) {
		finalPath = resolveOutputPath(finalPath);
		fs.mkdirSync(path.dirname(finalPath), { recursive: true });
		fs.writeFileSync(finalPath, JSON.stringify(state, null, 2), "utf8");
		const artifact = registerArtifact(
			proc.id,
			"other",
			finalPath,
			"application/json",
		);
		artifactUri = `electron://artifact/${artifact.id}`;
	} else {
		// Write to temporary artifact file
		const tempFile = path.join(
			os.tmpdir(),
			`storage-state-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
		);
		fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), "utf8");
		const artifact = registerArtifact(
			proc.id,
			"other",
			tempFile,
			"application/json",
		);
		artifactUri = `electron://artifact/${artifact.id}`;
		finalPath = tempFile;
	}

	return {
		processId: proc.id,
		path: finalPath,
		artifactUri,
		cookieCount: cookies.length,
		originCount: origins.length,
		state,
	};
}

export async function loadStorageState(
	proc: ElectronProcess,
	options: {
		path?: string;
		state?: StorageStatePayload;
		targetId?: string;
	},
): Promise<{
	processId: string;
	restoredCookies: number;
	restoredOrigins: number;
}> {
	let state = options.state;
	if (!state && options.path) {
		const resolved = resolveOutputPath(options.path);
		if (!fs.existsSync(resolved)) {
			throw new Error(`Storage state file not found: ${options.path}`);
		}
		const content = fs.readFileSync(resolved, "utf8");
		state = JSON.parse(content) as StorageStatePayload;
	}

	if (!state) {
		throw new Error("Must provide either 'path' or 'state' object to loadStorageState");
	}

	await updateCDPTargets(proc);
	const target = pickPageTarget(proc, options.targetId);

	// Restore cookies
	let cookieCount = 0;
	if (Array.isArray(state.cookies)) {
		for (const c of state.cookies) {
			try {
				await executeCDPCommand(proc, target.id, "Network.setCookie", {
					name: c.name,
					value: c.value,
					domain: c.domain,
					path: c.path,
					secure: c.secure,
					httpOnly: c.httpOnly,
					sameSite: c.sameSite,
					expires: c.expires,
				});
				cookieCount++;
			} catch {
				// Best-effort cookie restoration
			}
		}
	}

	// Restore origins (localStorage & sessionStorage)
	let originCount = 0;
	if (Array.isArray(state.origins) && state.origins.length > 0) {
		await executeCDPCommand(proc, target.id, "Runtime.evaluate", {
			expression: `((origins) => {
				for (const o of origins) {
					if (!o) continue;
					if (window.location.origin === o.origin || o.origin === "*" || window.location.origin === "null") {
						for (const item of (o.localStorage || [])) {
							try { localStorage.setItem(item.name, item.value); } catch {}
						}
						for (const item of (o.sessionStorage || [])) {
							try { sessionStorage.setItem(item.name, item.value); } catch {}
						}
					}
				}
			})(${JSON.stringify(state.origins)})`,
			returnByValue: true,
			awaitPromise: true,
		});
		originCount = state.origins.length;
	}

	return {
		processId: proc.id,
		restoredCookies: cookieCount,
		restoredOrigins: originCount,
	};
}
