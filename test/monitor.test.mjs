#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
/**
 * Unit tests for attach-time monitoring against an unresponsive CDP target.
 *
 * `ensureMonitoring` walks every target and enables domains on each. Not every
 * target answers: a worker paused at start accepts the WebSocket and then never
 * replies to `Runtime.enable` — the request does not fail, it simply never
 * settles. Unbounded, that parks the loop forever and `attach` never returns.
 *
 * The fixture below is a CDP endpoint with one healthy page and one worker that
 * goes quiet after the handshake, which is the shape that reproduced it against
 * a real Electron app.
 */
import test from "node:test";
import { WebSocketServer } from "ws";

import {
	attachToDebugPort,
	ensureMonitoring,
	MONITOR_STEP_TIMEOUT_MS,
	stopElectronApp,
} from "../build/process-manager.js";

/**
 * A fake CDP endpoint: `/json/version`, `/json/list`, and a WebSocket per
 * target.
 *
 * @param {Array<{id: string, type: string, silent?: boolean, connectDelayMs?: number}>} targets
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
async function startFakeCdp(targets) {
	const sockets = new Set();
	const server = http.createServer((req, res) => {
		if (req.url === "/json/version") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ Browser: "Electron/43.4.0" }));
			return;
		}
		if (req.url === "/json/protocol") {
			// chrome-remote-interface fetches this to build its typed API surface.
			// The code under test uses `client.send(...)`, which does not depend on
			// it, but the connection fails outright if the endpoint is missing.
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ domains: [] }));
			return;
		}
		if (req.url === "/json/list") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify(
					targets.map((t) => ({
						id: t.id,
						type: t.type,
						title: t.id,
						url: t.type === "page" ? "app://index" : "",
						webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${t.id}`,
					})),
				),
			);
			return;
		}
		res.writeHead(404).end();
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});

	// `noServer` so the upgrade can be delayed per target: a connection that
	// completes AFTER its deadline is the case where a client can be leaked.
	const wss = new WebSocketServer({ noServer: true });
	const live = new Set();
	server.on("upgrade", (req, socket, head) => {
		const id = (req.url ?? "").split("/").pop();
		const target = targets.find((t) => t.id === id);
		const finish = () =>
			wss.handleUpgrade(req, socket, head, (ws) =>
				wss.emit("connection", ws, req),
			);
		if (target?.connectDelayMs) setTimeout(finish, target.connectDelayMs);
		else finish();
	});
	wss.on("connection", (ws, req) => {
		const id = (req.url ?? "").split("/").pop();
		const target = targets.find((t) => t.id === id);
		live.add(ws);
		ws.on("close", () => live.delete(ws));
		ws.on("message", (raw) => {
			let msg;
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				return;
			}
			// The point of the fixture: this target accepts commands and never
			// answers them, exactly like a worker paused at start.
			if (target?.silent) return;
			ws.send(JSON.stringify({ id: msg.id, result: {} }));
		});
	});

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	return {
		port,
		/** WebSockets currently open to the fixture. */
		liveSockets: () => live.size,
		close: async () => {
			for (const ws of live) ws.terminate();
			wss.close();
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

test("attachToDebugPort returns even when a target never answers", async () => {
	const cdp = await startFakeCdp([
		{ id: "page-ok", type: "page" },
		{ id: "worker-silent", type: "worker", silent: true },
	]);
	let attached;
	try {
		const startedAt = Date.now();
		attached = await attachToDebugPort(cdp.port, "fixture");
		const elapsed = Date.now() - startedAt;

		assert.equal(attached.status, "running");
		assert.equal(attached.debugPort, cdp.port);

		// One silent target costs one budget and then the walk moves on. Without
		// the bound this never returns at all, so the ceiling is generous — it is
		// pinning "terminates", not a precise duration.
		assert.ok(
			elapsed < MONITOR_STEP_TIMEOUT_MS * 3,
			`attach should not park on a silent target, took ${elapsed}ms`,
		);
	} finally {
		if (attached) await stopElectronApp(attached.id).catch(() => {});
		await cdp.close();
	}
});

test("attachToDebugPort still monitors the targets that do answer", async () => {
	const cdp = await startFakeCdp([
		{ id: "page-ok", type: "page" },
		{ id: "worker-silent", type: "worker", silent: true },
	]);
	let attached;
	try {
		attached = await attachToDebugPort(cdp.port, "fixture");

		// The healthy page is wired up; the silent one is skipped rather than
		// taking the whole attach down with it.
		assert.ok(
			attached.monitorClients.has("page-ok"),
			"expected the responsive page target to be monitored",
		);
		assert.equal(
			attached.monitorClients.has("worker-silent"),
			false,
			"expected the unresponsive worker target to be skipped",
		);
		assert.equal(attached.targets.length, 2, "both targets are still reported");
	} finally {
		if (attached) await stopElectronApp(attached.id).catch(() => {});
		await cdp.close();
	}
});

test("attachToDebugPort does not re-pay the timeout on later passes", async () => {
	// Most tools call `ensureMonitoring` to refresh before reading. A skipped
	// target has no entry in `monitorClients`, so without a separate record of
	// the failure it is retried — and its whole budget re-spent — on every one
	// of those calls. That turns a hang into a tax rather than fixing it.
	const cdp = await startFakeCdp([
		{ id: "page-ok", type: "page" },
		{ id: "worker-silent", type: "worker", silent: true },
	]);
	let attached;
	try {
		attached = await attachToDebugPort(cdp.port, "fixture");
		assert.ok(attached.unmonitorableTargets.has("worker-silent"));

		const startedAt = Date.now();
		await ensureMonitoring(attached);
		await ensureMonitoring(attached);
		const elapsed = Date.now() - startedAt;

		assert.ok(
			elapsed < MONITOR_STEP_TIMEOUT_MS,
			`two refreshes should not re-time-out, took ${elapsed}ms`,
		);
	} finally {
		if (attached) await stopElectronApp(attached.id).catch(() => {});
		await cdp.close();
	}
});

test("attachToDebugPort closes a connection that lands after its deadline", async () => {
	// `withTimeout` races the connection, it cannot cancel it. A connection that
	// resolves after the deadline hands back a live client nobody owns — a
	// WebSocket held open for the life of the process.
	const cdp = await startFakeCdp([
		{ id: "page-ok", type: "page" },
		{
			id: "worker-slow-connect",
			type: "worker",
			connectDelayMs: MONITOR_STEP_TIMEOUT_MS + 1500,
		},
	]);
	let attached;
	try {
		attached = await attachToDebugPort(cdp.port, "fixture");
		assert.ok(attached.unmonitorableTargets.has("worker-slow-connect"));

		// Let the abandoned connection complete, then be disposed of.
		await new Promise((r) => setTimeout(r, 3500));

		assert.equal(
			cdp.liveSockets(),
			1,
			`expected only the healthy page to hold a socket, found ${cdp.liveSockets()}`,
		);
	} finally {
		if (attached) await stopElectronApp(attached.id).catch(() => {});
		await cdp.close();
	}
});
