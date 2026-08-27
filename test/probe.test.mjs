#!/usr/bin/env node
/**
 * Unit tests for CDP port probing and discovery (no Electron GUI required).
 *
 * Covers the two ways a port scan hangs: a port that accepts the connection
 * but never speaks HTTP (`fetch` waits out undici's 5-minute headers timeout
 * unless given a signal), and a range wide enough that probing it serially
 * outlasts the caller even when each port is merely slow.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

import {
  PROBE_TIMEOUT_MS,
  discoverDebugPorts,
  probeDebugPort,
} from "../build/process-manager.js";

/**
 * Start an HTTP server on an ephemeral port.
 *
 * @param {(req: http.IncomingMessage, res: http.ServerResponse) => void} handler
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
async function startHttpServer(handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Start a TCP server that accepts connections and then says nothing at all —
 * a WebSocket-only listener, or a dev server still booting.
 *
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
async function startSilentServer() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A stand-in for a real CDP endpoint. */
function cdpHandler(req, res) {
  if (req.url === "/json/version") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ Browser: "Electron/43.4.0" }));
    return;
  }
  if (req.url === "/json/list") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ id: "a", type: "page", url: "app://index" }]));
    return;
  }
  res.writeHead(404).end();
}

test("probeDebugPort reports version and targets for a CDP endpoint", async () => {
  const server = await startHttpServer(cdpHandler);
  try {
    const probe = await probeDebugPort(server.port);
    assert.equal(probe.ok, true);
    assert.deepEqual(probe.version, { Browser: "Electron/43.4.0" });
    assert.equal(probe.targets?.length, 1);
  } finally {
    await server.close();
  }
});

test("probeDebugPort gives up on a port that accepts but never answers", async () => {
  const server = await startSilentServer();
  try {
    const startedAt = Date.now();
    const probe = await probeDebugPort(server.port, 250);
    const elapsed = Date.now() - startedAt;

    assert.equal(probe.ok, false);
    // The point of the timeout: `fetch` has none of its own here, so without
    // a signal this waits out undici's 5-minute headers timeout and the scan
    // reads as a hung server.
    assert.ok(
      elapsed < 2000,
      `probe should abort on its own budget, took ${elapsed}ms`
    );
  } finally {
    await server.close();
  }
});

test("probeDebugPort defaults to a bounded timeout", () => {
  assert.ok(PROBE_TIMEOUT_MS > 0 && PROBE_TIMEOUT_MS <= 5000);
});

test("probeDebugPort treats a reachable endpoint with no target list as up", async () => {
  const server = await startHttpServer((req, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Browser: "Electron/43.4.0" }));
      return;
    }
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("boom");
  });
  try {
    const probe = await probeDebugPort(server.port);
    assert.equal(probe.ok, true);
    assert.deepEqual(probe.targets, []);
  } finally {
    await server.close();
  }
});

test("discoverDebugPorts finds a CDP endpoint inside a scanned range", async () => {
  const server = await startHttpServer(cdpHandler);
  try {
    const found = await discoverDebugPorts(server.port, server.port + 4);
    assert.equal(found.length, 1);
    assert.equal(found[0].port, server.port);
    assert.equal(found[0].targetCount, 1);
  } finally {
    await server.close();
  }
});

/**
 * Bind a contiguous block of silent ports.
 *
 * A range where only one port stalls does not distinguish serial from batched
 * scanning — the rest are refused instantly. The cost only shows up when
 * several ports in the range accept and then go quiet, which is the realistic
 * case: dev servers clustered in one range.
 *
 * @param {number} count How many consecutive ports to occupy.
 * @returns {Promise<{start: number, end: number, close: () => Promise<void>}>}
 */
async function startSilentRange(count) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const probe = await startSilentServer();
    const start = probe.port + 1;
    await probe.close();

    const servers = [];
    let ok = true;
    for (let i = 0; i < count; i++) {
      try {
        servers.push(await startSilentServerOn(start + i));
      } catch {
        ok = false;
        break;
      }
    }
    if (ok) {
      return {
        start,
        end: start + count - 1,
        close: async () => {
          for (const s of servers) await s.close();
        },
      };
    }
    for (const s of servers) await s.close();
  }
  throw new Error(`could not find ${count} consecutive free ports`);
}

/**
 * Silent TCP server bound to a specific port.
 *
 * @param {number} port
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
function startSilentServerOn(port) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({
        port,
        close: async () => {
          for (const socket of sockets) socket.destroy();
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}

test("discoverDebugPorts scans a wide range without serializing on it", async () => {
  // Every port in this range accepts and then goes quiet, so a serial scan
  // pays the full per-port budget 48 times over — the case that makes a wide
  // scan look like a hung server even once each probe is individually bounded.
  const PORTS = 48;
  const range = await startSilentRange(PORTS);
  try {
    const startedAt = Date.now();
    const found = await discoverDebugPorts(range.start, range.end);
    const elapsed = Date.now() - startedAt;

    assert.deepEqual(found, []);
    // Serially this is 48 full timeouts; batched it is two rounds. The gap is
    // wide enough that the bound need not be delicate.
    assert.ok(
      elapsed < 10 * PROBE_TIMEOUT_MS,
      `${PORTS} silent ports should not scan serially, took ${elapsed}ms`
    );
  } finally {
    await range.close();
  }
});
