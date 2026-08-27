#!/usr/bin/env node
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
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";

import {
  MONITOR_STEP_TIMEOUT_MS,
  attachToDebugPort,
  stopElectronApp,
} from "../build/process-manager.js";

/**
 * A fake CDP endpoint: `/json/version`, `/json/list`, and a WebSocket per
 * target.
 *
 * @param {Array<{id: string, type: string, silent?: boolean}>} targets
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
          }))
        )
      );
      return;
    }
    res.writeHead(404).end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    const id = (req.url ?? "").split("/").pop();
    const target = targets.find((t) => t.id === id);
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
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
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
      `attach should not park on a silent target, took ${elapsed}ms`
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
      "expected the responsive page target to be monitored"
    );
    assert.equal(
      attached.monitorClients.has("worker-silent"),
      false,
      "expected the unresponsive worker target to be skipped"
    );
    assert.equal(attached.targets.length, 2, "both targets are still reported");
  } finally {
    if (attached) await stopElectronApp(attached.id).catch(() => {});
    await cdp.close();
  }
});
