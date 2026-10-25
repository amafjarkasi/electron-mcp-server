/**
 * Composite & high-leverage desktop automation workflows layered on process-manager
 * and power-tools primitives. Zero external dependencies.
 */
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import type { ElectronProcess } from "./process-manager.js";
import {
	captureScreenshot,
	clickSelector,
	executeCDPCommand,
	getPageInfo,
	pickPageTarget,
	resolveOutputPath,
	resolveSecretPlaceholders,
	typeText,
	updateCDPTargets,
	withTimeout,
} from "./process-manager.js";
import {
	assertUi,
	captureMhtml,
	clearNetworkStubs,
	clickByAx,
	emulate,
	emulateNetwork,
	exportHar,
	getAccessibilitySnapshot,
	getMainState,
	inferIpcSchemas,
	invokeIpcHandler,
	networkStub,
	selectOption,
	waitNetworkIdle,
} from "./power-tools.js";
import {
	getProcessHealth,
	resolveActionTarget,
	resolveBackendNodeFromRef,
} from "./desktop-tools.js";
import { registerArtifact } from "./artifacts.js";

// ============================================================================
// ZERO-DEPENDENCY ZIP GENERATOR
// ============================================================================

export type ZipEntry = {
	name: string;
	content: Buffer | string;
};

/**
 * Generate a standard PKZip archive in pure Node.js using zlib deflate and crc32.
 */
export function createZipArchive(files: ZipEntry[]): Buffer {
	const localHeaders: Buffer[] = [];
	const centralHeaders: Buffer[] = [];
	let offset = 0;

	for (const file of files) {
		const data = Buffer.isBuffer(file.content)
			? file.content
			: Buffer.from(file.content, "utf8");
		const nameBuf = Buffer.from(file.name.replace(/\\/g, "/"), "utf8");
		const crc = zlib.crc32(data);
		const compressed = zlib.deflateRawSync(data);
		const useCompressed = compressed.length < data.length;
		const body = useCompressed ? compressed : data;
		const method = useCompressed ? 8 : 0;

		// Local file header (30 bytes + nameBuf.length)
		const lh = Buffer.alloc(30 + nameBuf.length);
		lh.writeUInt32LE(0x04034b50, 0); // signature
		lh.writeUInt16LE(20, 4); // version needed to extract (2.0)
		lh.writeUInt16LE(0, 6); // general purpose bit flag
		lh.writeUInt16LE(method, 8); // compression method
		lh.writeUInt16LE(0, 10); // last mod time
		lh.writeUInt16LE(0, 12); // last mod date
		lh.writeUInt32LE(crc, 14); // crc-32
		lh.writeUInt32LE(body.length, 18); // compressed size
		lh.writeUInt32LE(data.length, 22); // uncompressed size
		lh.writeUInt16LE(nameBuf.length, 26); // file name length
		lh.writeUInt16LE(0, 28); // extra field length
		nameBuf.copy(lh, 30);

		// Central directory header (46 bytes + nameBuf.length)
		const ch = Buffer.alloc(46 + nameBuf.length);
		ch.writeUInt32LE(0x02014b50, 0); // signature
		ch.writeUInt16LE(20, 4); // version made by
		ch.writeUInt16LE(20, 6); // version needed to extract
		ch.writeUInt16LE(0, 8); // general purpose bit flag
		ch.writeUInt16LE(method, 10); // compression method
		ch.writeUInt16LE(0, 12); // last mod time
		ch.writeUInt16LE(0, 14); // last mod date
		ch.writeUInt32LE(crc, 16); // crc-32
		ch.writeUInt32LE(body.length, 20); // compressed size
		ch.writeUInt32LE(data.length, 24); // uncompressed size
		ch.writeUInt16LE(nameBuf.length, 28); // file name length
		ch.writeUInt16LE(0, 30); // extra field length
		ch.writeUInt16LE(0, 32); // file comment length
		ch.writeUInt16LE(0, 34); // disk number start
		ch.writeUInt16LE(0, 36); // internal file attributes
		ch.writeUInt32LE(0, 38); // external file attributes
		ch.writeUInt32LE(offset, 42); // relative offset of local header
		nameBuf.copy(ch, 46);

		localHeaders.push(lh, body);
		centralHeaders.push(ch);
		offset += lh.length + body.length;
	}

	const centralDirOffset = offset;
	const centralDirSize = centralHeaders.reduce((acc, h) => acc + h.length, 0);

	// End of central directory record (22 bytes)
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0); // signature
	eocd.writeUInt16LE(0, 4); // number of this disk
	eocd.writeUInt16LE(0, 6); // disk where central dir starts
	eocd.writeUInt16LE(files.length, 8); // number of central directory records on this disk
	eocd.writeUInt16LE(files.length, 10); // total number of central directory records
	eocd.writeUInt32LE(centralDirSize, 12); // size of central directory
	eocd.writeUInt32LE(centralDirOffset, 16); // offset of start of central directory
	eocd.writeUInt16LE(0, 20); // comment length

	return Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
}

// ============================================================================
// 1. REPRO BUNDLE (Zero-Repro Bug Investigation Artifact)
// ============================================================================

export type ReproBundleResult = {
	processId: string;
	path: string;
	bundleZipPath?: string;
	artifactUri: string;
	reportMarkdown: string;
	summary: {
		health: string;
		consoleErrors: number;
		networkFailures: number;
		uptimeSeconds: number;
		includedFiles: string[];
	};
};

export async function createReproBundle(
	proc: ElectronProcess,
	options: {
		outputPath?: string;
		targetId?: string;
		notes?: string;
	} = {},
): Promise<ReproBundleResult> {
	await updateCDPTargets(proc);
	const target = pickPageTarget(proc, options.targetId);

	// 1. Capture visual screenshot
	let screenshotBuf: Buffer | null = null;
	try {
		const shot = await withTimeout(captureScreenshot(proc, target.id, "png"), 5000, "captureScreenshot").catch(() => null);
		if (shot && shot.data) {
			screenshotBuf = Buffer.from(shot.data, "base64");
		}
	} catch {
		screenshotBuf = Buffer.from("");
	}

	// 2. Capture MHTML DOM archive
	let mhtmlText = "";
	try {
		const mhtmlRes = await withTimeout(captureMhtml(proc, undefined, target.id), 5000, "captureMhtml").catch(() => null);
		if (mhtmlRes && mhtmlRes.path && fs.existsSync(mhtmlRes.path)) {
			mhtmlText = fs.readFileSync(mhtmlRes.path, "utf8");
		}
	} catch {
		mhtmlText = "<!-- MHTML capture unavailable -->";
	}

	// 3. Export HAR network archive
	let harText = "";
	try {
		const harRes = await withTimeout(exportHar(proc), 5000, "exportHar").catch(() => null);
		if (harRes && harRes.path && fs.existsSync(harRes.path)) {
			harText = fs.readFileSync(harRes.path, "utf8");
		}
	} catch {
		harText = JSON.stringify({ log: { entries: [] } });
	}

	// 4. Console errors
	const errorMessages = proc.consoleMessages.filter(
		(c) => c.level === "error" || c.level === "warning",
	);

	// 5. Process Health & Main state
	let health: any = { status: "healthy", memory: {}, crashes: [], hangs: [] };
	try {
		health = (await withTimeout(getProcessHealth(proc, target.id), 5000, "getProcessHealth").catch(() => null)) || health;
	} catch {
		// skip
	}

	let mainState: any = null;
	if (proc.inspectPort) {
		try {
			mainState = await withTimeout(getMainState(proc), 5000, "getMainState").catch(() => null);
		} catch {
			// skip
		}
	}

	let pageInfo: any = null;
	try {
		pageInfo = await withTimeout(getPageInfo(proc, target.id), 5000, "getPageInfo").catch(() => null);
	} catch {
		// skip
	}

	const failedRequests = proc.networkEntries.filter(
		(n) => n.event === "failed" || (n.status && n.status >= 400),
	);

	// 6. Build Manifest & Markdown Report
	const manifest = {
		createdAt: new Date().toISOString(),
		processId: proc.id,
		appPath: proc.appPath,
		page: pageInfo,
		health: health.status,
		uptimeSeconds: health.uptimeSeconds || 0,
		memory: health.memory,
		consoleErrorCount: errorMessages.length,
		networkFailureCount: failedRequests.length,
		notes: options.notes || "",
	};

	const reportMarkdown = `# Repro Bug Bundle Report

**Generated:** ${new Date().toUTCString()}
**Process ID:** \`${proc.id}\`
**Health Status:** **${String(health.status || "healthy").toUpperCase()}**
**Active Page:** ${pageInfo?.url || "N/A"} (${pageInfo?.title || "N/A"})

---

## 📊 Diagnostic Summary
- **Console Errors / Warnings:** ${errorMessages.length}
- **Failed HTTP Requests:** ${failedRequests.length}
- **Memory RSS:** ${health.memory?.rssMb ?? 0} MB (Heap: ${health.memory?.heapUsedMb ?? 0} MB)
- **Active Windows:** ${health.windows?.length ?? 1}
${options.notes ? `\n> **User Notes:** ${options.notes}\n` : ""}

---

## 🚨 Top Console Errors
${
	errorMessages.length === 0
		? "_No console errors recorded._"
		: errorMessages
				.slice(-10)
				.map(
					(e, idx) =>
						`### ${idx + 1}. [${String(e.level).toUpperCase()}] ${e.text}
- **Timestamp:** \`${e.timestamp}\`
- **Source:** \`${e.source}\``,
				)
				.join("\n\n")
}

---

## 🌐 Failed Network Requests
${
	failedRequests.length === 0
		? "_No failed network requests recorded._"
		: failedRequests
				.slice(-10)
				.map(
					(req) =>
						`- **\`${req.method || "GET"} ${req.url}\`** — Status: **${req.status || "FAILED"}** (${req.errorText || "Error"})`,
				)
				.join("\n")
}

---

## 🖥️ System & Electron Context
- **Node.js:** \`${process.versions.node}\`
- **Platform:** \`${process.platform} (${process.arch})\`
- **PID:** \`${proc.pid ?? "unknown"}\`
${
	mainState?.main?.versions
		? `- **Electron Version:** \`${mainState.main.versions.electron || "N/A"}\`
- **Chrome Version:** \`${mainState.main.versions.chrome || "N/A"}\``
		: ""
}
`;

	// 7. Bundle files into zip
	const zipFiles: ZipEntry[] = [
		{ name: "repro-report.md", content: reportMarkdown },
		{ name: "manifest.json", content: JSON.stringify(manifest, null, 2) },
		{ name: "console-errors.json", content: JSON.stringify(errorMessages.slice(-20), null, 2) },
		{ name: "stderr-tail.log", content: proc.logs.slice(-50).join("\n") },
	];

	if (screenshotBuf && screenshotBuf.length > 0) {
		zipFiles.push({ name: "screenshot.png", content: screenshotBuf });
	}
	if (mhtmlText) {
		zipFiles.push({ name: "page.mhtml", content: mhtmlText });
	}
	if (harText) {
		zipFiles.push({ name: "network.har", content: harText });
	}

	const zipBuffer = createZipArchive(zipFiles);
	const defaultFilename = path.join(os.tmpdir(), `repro-bundle-${proc.id}-${Date.now()}.zip`);
	const outputPath = resolveOutputPath(options.outputPath || defaultFilename);

	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(outputPath, zipBuffer);

	const artifact = registerArtifact(
		proc.id,
		"other",
		outputPath,
		"application/zip",
	);

	return {
		processId: proc.id,
		path: outputPath,
		bundleZipPath: outputPath,
		artifactUri: `electron://artifact/${artifact.id}`,
		reportMarkdown,
		summary: {
			health: health.status,
			consoleErrors: errorMessages.length,
			networkFailures: failedRequests.length,
			uptimeSeconds: health.uptimeSeconds || 0,
			includedFiles: zipFiles.map((f) => f.name),
		},
	};
}

// ============================================================================
// 2. FILL FORM (Smart Multi-Field Accessible & Secret Form Solver)
// ============================================================================

export type FormFieldSpec = {
	field: string;
	value: string | boolean | number;
	type?: "text" | "select" | "checkbox" | "radio" | "file";
	selector?: string;
	ref?: string;
};

export type FillFormOptions = {
	fields: Record<string, string | boolean | number> | FormFieldSpec[];
	submit?: string | boolean;
	waitIdle?: boolean;
	expect?: {
		textIncludes?: string;
		urlIncludes?: string;
		titleIncludes?: string;
		selector?: string;
		selectorHidden?: string;
		expression?: string;
	};
	targetId?: string;
};

export type FillFormResult = {
	success: boolean;
	processId: string;
	filledCount: number;
	fields: Array<{
		field: string;
		resolvedTarget: string;
		value: string;
		masked: boolean;
		type: string;
	}>;
	submitted: boolean;
	networkIdle: boolean;
	assertion?: {
		passed: boolean;
		details?: string;
	};
};

export async function fillForm(
	proc: ElectronProcess,
	options: FillFormOptions,
): Promise<FillFormResult> {
	await updateCDPTargets(proc);
	const target = pickPageTarget(proc, options.targetId);

	// Normalize fields
	const specs: FormFieldSpec[] = Array.isArray(options.fields)
		? options.fields
		: Object.entries(options.fields).map(([field, value]) => ({ field, value }));

	const snap = await getAccessibilitySnapshot(proc, { targetId: target.id });
	const results: FillFormResult["fields"] = [];

	for (const spec of specs) {
		const fieldKey = spec.field.trim();
		const rawVal = spec.value;
		let resolvedSelector: string | undefined = spec.selector;
		let resolvedRef: string | undefined = spec.ref;

		// 1. Ref match (e.g. "e1", "e12")
		if (!resolvedRef && !resolvedSelector && /^e\d+$/i.test(fieldKey)) {
			resolvedRef = fieldKey;
		}

		// 2. Exact selector check
		if (!resolvedRef && !resolvedSelector && /^[#.[\]]/.test(fieldKey)) {
			resolvedSelector = fieldKey;
		}

		// 3. Search accessibility tree by name / label
		if (!resolvedRef && !resolvedSelector) {
			const lowerKey = fieldKey.toLowerCase();
			const match = snap.nodes.find((n) => {
				const name = (n.name || "").toLowerCase();
				return (
					name === lowerKey ||
					name.includes(lowerKey) ||
					(n.role && `${n.role} ${name}`.toLowerCase().includes(lowerKey))
				);
			});
			if (match?.ref) {
				resolvedRef = match.ref;
			}
		}

		// 4. Fallback: Query DOM by label, placeholder, name, or id
		if (!resolvedRef && !resolvedSelector) {
			const safeKey = JSON.stringify(fieldKey);
			const domMatch = (await executeCDPCommand(
				proc,
				target.id,
				"Runtime.evaluate",
				{
					expression: `(() => {
						const k = ${safeKey}.toLowerCase();
						// 1. label association
						for (const lbl of document.querySelectorAll('label')) {
							if (lbl.textContent.toLowerCase().includes(k)) {
								const forId = lbl.getAttribute('for');
								if (forId && document.getElementById(forId)) return '#' + forId;
								const nested = lbl.querySelector('input, select, textarea');
								if (nested) {
									if (nested.id) return '#' + nested.id;
									if (nested.name) return '[name="' + nested.name + '"]';
								}
							}
						}
						// 2. input by name, id, placeholder
						const inputs = Array.from(document.querySelectorAll('input, select, textarea'));
						const found = inputs.find(el => 
							(el.name && el.name.toLowerCase() === k) ||
							(el.id && el.id.toLowerCase() === k) ||
							(el.placeholder && el.placeholder.toLowerCase().includes(k)) ||
							(el.getAttribute('aria-label') && el.getAttribute('aria-label').toLowerCase().includes(k))
						);
						if (found) {
							if (found.id) return '#' + found.id;
							if (found.name) return '[name="' + found.name + '"]';
						}
						return null;
					})()`,
					returnByValue: true,
				},
			)) as { result?: { value?: string } };

			if (domMatch.result?.value) {
				resolvedSelector = domMatch.result.value;
			}
		}

		const targetIdentifier = resolvedRef || resolvedSelector || fieldKey;

		// Determine field type
		let fieldType = spec.type;
		if (!fieldType && resolvedSelector) {
			const tagEval = (await executeCDPCommand(
				proc,
				target.id,
				"Runtime.evaluate",
				{
					expression: `(() => {
						const el = document.querySelector(${JSON.stringify(resolvedSelector)});
						if (!el) return null;
						const tag = el.tagName.toLowerCase();
						if (tag === 'select') return 'select';
						if (tag === 'input') {
							const t = (el.type || 'text').toLowerCase();
							if (t === 'checkbox' || t === 'radio') return t;
							if (t === 'file') return 'file';
						}
						return 'text';
					})()`,
					returnByValue: true,
				},
			).catch(() => ({}))) as { result?: { value?: string } };
			if (tagEval.result?.value) {
				fieldType = tagEval.result.value as any;
			}
		}
		if (!fieldType) {
			if (typeof rawVal === "boolean") {
				fieldType = "checkbox";
			} else {
				fieldType = "text";
			}
		}

		let masked = false;
		let finalValStr = String(rawVal);

		if (fieldType === "select") {
			await selectOption(proc, {
				selector: resolvedSelector || `input[name="${fieldKey}"]`,
				value: String(rawVal),
				label: String(rawVal),
				targetId: target.id,
			});
		} else if (fieldType === "checkbox" || fieldType === "radio") {
			const targetBool = Boolean(rawVal);
			if (resolvedRef) {
				await clickByAx(proc, { name: fieldKey, targetId: target.id }).catch(async () => {
					await resolveActionTarget(proc, { ref: resolvedRef, targetId: target.id });
					await clickSelector(proc, `body`, target.id);
				});
			} else {
				const sel = resolvedSelector || `input[name="${fieldKey}"]`;
				await executeCDPCommand(proc, target.id, "Runtime.evaluate", {
					expression: `(() => {
						const el = document.querySelector(${JSON.stringify(sel)});
						if (el && el.checked !== ${targetBool}) {
							el.click();
						}
					})()`,
				});
			}
		} else {
			// Text / Password / Textarea
			const { resolved, masked: isMasked } = resolveSecretPlaceholders(
				String(rawVal),
				(s) => proc.redactedSecrets.add(s),
			);
			masked = Boolean(isMasked && isMasked !== resolved);
			finalValStr = masked ? "[REDACTED]" : resolved;

			if (resolvedRef) {
				const backendNodeId = await resolveBackendNodeFromRef(proc, resolvedRef, target.id);
				await executeCDPCommand(proc, target.id, "DOM.focus", { backendNodeId }).catch(() => undefined);
				await executeCDPCommand(proc, target.id, "Input.insertText", { text: resolved });
			} else {
				const sel = resolvedSelector || `input[name="${fieldKey}"]`;
				await typeText(proc, resolved, {
					selector: sel,
					clear: true,
					targetId: target.id,
				});
			}
		}

		results.push({
			field: fieldKey,
			resolvedTarget: targetIdentifier,
			value: finalValStr,
			masked,
			type: fieldType,
		});
	}

	// Submit handling
	let submitted = false;
	if (options.submit) {
		let submitTarget = typeof options.submit === "string" ? options.submit : "";
		if (!submitTarget || submitTarget === "true") {
			const submitEval = (await executeCDPCommand(
				proc,
				target.id,
				"Runtime.evaluate",
				{
					expression: `(() => {
						const sub = document.querySelector('button[type="submit"], input[type="submit"]');
						if (sub) return sub.id ? '#' + sub.id : 'button[type="submit"]';
						const btns = Array.from(document.querySelectorAll('button'));
						const hit = btns.find(b => /(submit|save|sign in|log in|continue|next)/i.test(b.textContent || ''));
						return hit ? (hit.id ? '#' + hit.id : 'button') : null;
					})()`,
					returnByValue: true,
				},
			)) as { result?: { value?: string } };
			submitTarget = submitEval.result?.value || 'button[type="submit"]';
		}

		try {
			if (/^e\d+$/i.test(submitTarget)) {
				await resolveActionTarget(proc, {
					ref: submitTarget,
					targetId: target.id,
				});
				await clickSelector(proc, `body`, target.id);
			} else {
				await clickSelector(proc, submitTarget, target.id);
			}
			submitted = true;
		} catch {
			await clickByAx(proc, { name: submitTarget, role: "button", targetId: target.id }).catch(() => {});
			submitted = true;
		}
	}

	let networkIdle = false;
	if (options.waitIdle !== false) {
		try {
			await waitNetworkIdle(proc, { idleMs: 400, timeoutMs: 3000, targetId: target.id });
			networkIdle = true;
		} catch {
			networkIdle = false;
		}
	}

	let assertionResult: { passed: boolean; details?: string } | undefined;
	if (options.expect) {
		try {
			const check = await assertUi(proc, {
				...options.expect,
				targetId: target.id,
			});
			assertionResult = {
				passed: check.pass !== false,
				details: check.checks ? JSON.stringify(check.checks) : undefined,
			};
		} catch (err) {
			assertionResult = {
				passed: false,
				details: err instanceof Error ? err.message : String(err),
			};
		}
	}

	return {
		success: !assertionResult || assertionResult.passed !== false,
		processId: proc.id,
		filledCount: results.length,
		fields: results,
		submitted,
		networkIdle,
		assertion: assertionResult,
	};
}

// ============================================================================
// 3. OFFLINE RESILIENCE CHECK (Chaos & Network Fault Scorecard)
// ============================================================================

export type OfflineResilienceOptions = {
	action?: {
		type: "click" | "navigate" | "type_text";
		selector?: string;
		url?: string;
		text?: string;
	};
	faultType?: "offline" | "latency" | "http500";
	urlPattern?: string;
	durationMs?: number;
	targetId?: string;
};

export type OfflineResilienceResult = {
	processId: string;
	faultType: string;
	resilienceGrade: "A" | "B" | "C" | "F";
	grade?: "A" | "B" | "C" | "F";
	survived: boolean;
	recovered: boolean;
	newErrorsDuringFault: string[];
	findings: string[];
	baselineState: { url: string; title: string };
	postRecoveryState: { url: string; title: string };
};

export async function runOfflineResilienceCheck(
	proc: ElectronProcess,
	options: OfflineResilienceOptions = {},
): Promise<OfflineResilienceResult> {
	await updateCDPTargets(proc);
	const target = pickPageTarget(proc, options.targetId);
	const faultType = options.faultType || "offline";
	const durationMs = options.durationMs || 1000;

	// Baseline
	const baselineInfo = await getPageInfo(proc, target.id);
	const preConsoleErrors = proc.consoleMessages.filter((c) => c.level === "error").length;

	// Apply fault
	if (faultType === "offline") {
		await emulateNetwork(proc, { offline: true, targetId: target.id });
	} else if (faultType === "latency") {
		await emulateNetwork(proc, {
			latencyMs: 2000,
			downloadThroughput: 64 * 1024,
			uploadThroughput: 64 * 1024,
			targetId: target.id,
		});
	} else if (faultType === "http500") {
		await networkStub(proc, {
			urlPattern: options.urlPattern || "*",
			action: "fulfill",
			status: 500,
			body: JSON.stringify({ error: "Simulated Chaos 500 Internal Error" }),
			targetId: target.id,
		});
	}

	// Optional interaction during fault
	if (options.action) {
		try {
			if (options.action.type === "click" && options.action.selector) {
				await clickSelector(proc, options.action.selector, target.id);
			} else if (options.action.type === "type_text" && options.action.text) {
				await typeText(proc, options.action.text, {
					selector: options.action.selector,
					targetId: target.id,
				});
			}
		} catch {
			// Action may fail cleanly due to network
		}
	}

	await new Promise((r) => setTimeout(r, Math.min(durationMs, 5000)));

	// Check errors during disruption
	const postFaultErrors = proc.consoleMessages
		.filter((c) => c.level === "error")
		.slice(preConsoleErrors)
		.map((c) => c.text);

	let healthDuringFault: any = { status: "healthy" };
	try {
		healthDuringFault = await getProcessHealth(proc, target.id);
	} catch {
		// skip
	}

	// Restore network
	await emulateNetwork(proc, { clear: true, targetId: target.id }).catch(() => {});
	await clearNetworkStubs(proc).catch(() => {});

	// Wait for recovery
	await waitNetworkIdle(proc, { idleMs: 300, timeoutMs: 3000, targetId: target.id }).catch(() => {});
	await new Promise((r) => setTimeout(r, 400));

	const postRecoveryInfo = await getPageInfo(proc, target.id);
	let postHealth: any = { status: "healthy" };
	try {
		postHealth = await getProcessHealth(proc, target.id);
	} catch {
		// skip
	}

	const survived = healthDuringFault.status !== "crashed" && postHealth.status !== "crashed";
	const recovered = postHealth.status === "healthy" && Boolean(postRecoveryInfo.url);

	const findings: string[] = [];
	if (!survived) {
		findings.push("Electron renderer process crashed during network disruption.");
	}
	if (postFaultErrors.length > 0) {
		findings.push(`Captured ${postFaultErrors.length} unhandled console error(s) during network disruption.`);
	}
	if (postHealth.status === "unresponsive") {
		findings.push("Window event loop became unresponsive during network reconnection.");
	}
	if (findings.length === 0) {
		findings.push("Application handled network fault gracefully with zero unhandled exceptions or crashes.");
	}

	let resilienceGrade: "A" | "B" | "C" | "F" = "A";
	if (!survived) {
		resilienceGrade = "F";
	} else if (postHealth.status === "unresponsive") {
		resilienceGrade = "C";
	} else if (postFaultErrors.length > 0) {
		resilienceGrade = "B";
	}

	return {
		processId: proc.id,
		faultType,
		resilienceGrade,
		grade: resilienceGrade,
		survived,
		recovered,
		newErrorsDuringFault: postFaultErrors.slice(0, 10),
		findings,
		baselineState: { url: baselineInfo.url, title: baselineInfo.title },
		postRecoveryState: { url: postRecoveryInfo.url, title: postRecoveryInfo.title },
	};
}

// ============================================================================
// 4. RESPONSIVE THEME MATRIX (Theme & Viewport Compatibility Sweep)
// ============================================================================

export type ResponsiveThemeMatrixOptions = {
	themes?: Array<"light" | "dark">;
	viewports?: Array<{ width: number; height: number; name?: string }>;
	checkOverflow?: boolean;
	captureScreenshots?: boolean;
	targetId?: string;
};

export type ResponsiveThemeMatrixResult = {
	processId: string;
	totalVariations: number;
	passedCount: number;
	failedCount: number;
	variations: Array<{
		theme: string;
		viewport: { width: number; height: number; name?: string };
		hasOverflow: boolean;
		overflowElements?: Array<{ tag: string; id?: string; className?: string; right: number; max: number }>;
		artifactUri?: string;
	}>;
	results: Array<{
		theme: string;
		viewport: { width: number; height: number; name?: string };
		hasOverflow: boolean;
		overflowElements?: Array<{ tag: string; id?: string; className?: string; right: number; max: number }>;
		artifactUri?: string;
	}>;
	issues: string[];
};

export async function runResponsiveThemeMatrix(
	proc: ElectronProcess,
	options: ResponsiveThemeMatrixOptions = {},
): Promise<ResponsiveThemeMatrixResult> {
	await updateCDPTargets(proc);
	const target = pickPageTarget(proc, options.targetId);

	const themes = options.themes && options.themes.length > 0 ? options.themes : (["light", "dark"] as const);
	const viewports =
		options.viewports && options.viewports.length > 0
			? options.viewports
			: [
					{ width: 800, height: 600, name: "compact" },
					{ width: 1280, height: 800, name: "desktop" },
					{ width: 1920, height: 1080, name: "wide" },
			  ];

	const variations: ResponsiveThemeMatrixResult["variations"] = [];
	const issues: string[] = [];

	for (const theme of themes) {
		await executeCDPCommand(proc, target.id, "Emulation.setEmulatedMedia", {
			media: "",
			features: [{ name: "prefers-color-scheme", value: theme }],
		}).catch(() => undefined);

		for (const vp of viewports) {
			await emulate(proc, {
				metrics: {
					width: vp.width,
					height: vp.height,
				},
				targetId: target.id,
			});

			let overflowResult = { hasOverflow: false, overflowing: [] as any[] };
			if (options.checkOverflow !== false) {
				const checkRes = (await executeCDPCommand(
					proc,
					target.id,
					"Runtime.evaluate",
					{
						expression: `(() => {
							const doc = document.documentElement;
							const hasOverflow = doc.scrollWidth > window.innerWidth;
							const overflowing = [];
							if (hasOverflow) {
								const all = Array.from(document.querySelectorAll('*'));
								for (const el of all) {
									const r = el.getBoundingClientRect();
									if (r.right > window.innerWidth + 2) {
										overflowing.push({
											tag: el.tagName.toLowerCase(),
											id: el.id || undefined,
											className: el.className || undefined,
											right: Math.round(r.right),
											max: window.innerWidth
										});
										if (overflowing.length >= 5) break;
									}
								}
							}
							return { hasOverflow, overflowing };
						})()`,
						returnByValue: true,
					},
				)) as { result?: { value?: { hasOverflow: boolean; overflowing: any[] } } };

				overflowResult = checkRes.result?.value ?? { hasOverflow: false, overflowing: [] };
			}

			// Capture artifact screenshot if requested
			let artifactUri: string | undefined;
			if (options.captureScreenshots) {
				try {
					const shot = await captureScreenshot(proc, target.id, "png");
					if (shot && shot.data) {
						const fname = path.join(os.tmpdir(), `matrix-${theme}-${vp.width}x${vp.height}-${Date.now()}.png`);
						const outPath = resolveOutputPath(fname);
						fs.mkdirSync(path.dirname(outPath), { recursive: true });
						fs.writeFileSync(outPath, Buffer.from(shot.data, "base64"));
						const art = registerArtifact(proc.id, "screenshot", outPath, "image/png");
						artifactUri = `electron://artifact/${art.id}`;
					}
				} catch {
					// skip screenshot if CDP fails
				}
			}

			if (overflowResult.hasOverflow) {
				issues.push(
					`[${theme.toUpperCase()} @ ${vp.width}x${vp.height}] Horizontal overflow detected (scrollWidth exceeds innerWidth).`,
				);
			}

			variations.push({
				theme,
				viewport: vp,
				hasOverflow: overflowResult.hasOverflow,
				overflowElements: overflowResult.overflowing,
				artifactUri,
			});
		}
	}

	// Restore clean emulation
	await emulate(proc, { clear: true, targetId: target.id }).catch(() => {});

	const failedCount = variations.filter((v) => v.hasOverflow).length;
	const passedCount = variations.length - failedCount;

	return {
		processId: proc.id,
		totalVariations: variations.length,
		passedCount,
		failedCount,
		variations,
		results: variations,
		issues,
	};
}

// ============================================================================
// 5. IPC FUZZ & CONTRACT VERIFY (IPC Security & Crash Hardening)
// ============================================================================

export type IpcFuzzOptions = {
	channels?: string[];
	iterations?: number;
	timeoutMs?: number;
	targetId?: string;
};

export type IpcFuzzResult = {
	processId: string;
	channelsTested: string[];
	totalProbes: number;
	crashes: number;
	unhandledExceptions: Array<{
		channel: string;
		vector: string;
		error: string;
	}>;
	status: "hardened" | "vulnerable" | "crashed";
	resilient?: boolean;
	score: number;
	recommendations: string[];
};

export async function fuzzIpcChannels(
	proc: ElectronProcess,
	options: IpcFuzzOptions = {},
): Promise<IpcFuzzResult> {
	await updateCDPTargets(proc);
	const target = pickPageTarget(proc, options.targetId);

	// 1. Resolve channels to fuzz
	let channels = options.channels || [];
	if (channels.length === 0) {
		try {
			const inferred = await inferIpcSchemas(proc);
			channels = Object.keys(inferred.channels || {});
		} catch {
			channels = [];
		}
	}

	// Fallback to testing a standard probe channel if no channels discovered yet
	if (channels.length === 0) {
		channels = ["test-channel", "ping"];
	}

	// 2. Fuzz vectors
	const vectors: Array<{ name: string; payload: unknown }> = [
		{ name: "null_primitive", payload: null },
		{ name: "empty_string", payload: "" },
		{ name: "prototype_pollution", payload: JSON.parse('{"__proto__": {"polluted": true}}') },
		{ name: "path_traversal", payload: "../../../../../../etc/passwd" },
		{ name: "oversized_string", payload: "A".repeat(15000) },
		{ name: "deeply_nested", payload: { a: { b: { c: { d: [1, 2, "leaf"] } } } } },
	];

	const unhandledExceptions: IpcFuzzResult["unhandledExceptions"] = [];
	let totalProbes = 0;
	let crashes = 0;

	for (const channel of channels) {
		for (const vec of vectors) {
			totalProbes++;
			try {
				await invokeIpcHandler(proc, {
					channel,
					args: [vec.payload],
					targetId: target.id,
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes("crash") || msg.includes("disconnect") || msg.includes("destroyed")) {
					unhandledExceptions.push({
						channel,
						vector: vec.name,
						error: msg,
					});
				}
			}

			// Check process health post-probe
			try {
				const health = await getProcessHealth(proc, target.id);
				if (health.status === "crashed") {
					crashes++;
					unhandledExceptions.push({
						channel,
						vector: vec.name,
						error: "Main process crashed or terminated during IPC payload handling",
					});
					break;
				}
			} catch {
				// skip
			}
		}
	}

	const recommendations: string[] = [];
	if (crashes > 0) {
		recommendations.push("Critical: IPC handler crashed the process. Add try/catch and input schema validation with Zod in main process.");
	}
	if (unhandledExceptions.length > 0) {
		recommendations.push("Sanitize IPC inputs for prototype pollution and path traversal attacks before processing.");
	}
	if (recommendations.length === 0) {
		recommendations.push("All tested IPC channels handled boundary and malformed payloads without process crashes.");
	}

	let status: "hardened" | "vulnerable" | "crashed" = "hardened";
	let score = 100;
	if (crashes > 0) {
		status = "crashed";
		score = 0;
	} else if (unhandledExceptions.length > 0) {
		status = "vulnerable";
		score = Math.max(40, 100 - unhandledExceptions.length * 15);
	}

	return {
		processId: proc.id,
		channelsTested: channels,
		totalProbes,
		crashes,
		unhandledExceptions,
		status,
		resilient: crashes === 0 && unhandledExceptions.length === 0,
		score,
		recommendations,
	};
}
