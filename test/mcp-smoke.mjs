#!/usr/bin/env node
/**
 * End-to-end smoke test for the Electron Debug MCP server.
 * Spawns the server over stdio, drives tools against fixtures/minimal-electron-app.
 */
import { spawn } from "child_process";
import net from "net";
import os from "os";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const serverEntry = path.join(root, "build", "index.js");
const fixtureApp = path.join(root, "fixtures", "minimal-electron-app");
const smokeOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "electron-mcp-smoke-"));

/**
 * Find a TCP port we can actually bind to. On Windows, Hyper-V/WSL/Docker
 * reserve port ranges (netsh int ipv4 show excludedportrange) and bind()
 * returns WSAEACCES (0x271D) inside them even when nothing is listening —
 * which silently kills Chromium's DevTools HTTP server. Hard-coded ports
 * (e.g. 9339) fall in those ranges, so we probe a bindable port instead.
 * Prefers the 9555+ band, then falls back to an OS-assigned ephemeral port.
 */
function findFreePort(preferred = 9555) {
  return new Promise((resolve) => {
    const tryBind = (port, onFail) => {
      const srv = net.createServer();
      srv.unref();
      srv.on("error", () => onFail());
      srv.listen({ host: "127.0.0.1", port }, () => {
        const assigned = srv.address().port;
        srv.close(() => resolve(assigned));
      });
    };
    tryBind(preferred, () =>
      // Fallback: let the OS pick an ephemeral port (always bindable).
      tryBind(0, () => resolve(0))
    );
  });
}

const DEBUG_PORT = await findFreePort(9555);
const ATTACH_PORT = await findFreePort(DEBUG_PORT + 1);
console.log(`[smoke] using ports: start_app=${DEBUG_PORT} attach=${ATTACH_PORT}`);

class McpClient {
  constructor(command, args, env = {}) {
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
      cwd: root,
    });
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.logNotifications = [];

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.child.on("exit", (code, signal) => {
      for (const [, { reject }] of this.pending) {
        reject(
          new Error(`MCP server exited (code=${code}, signal=${signal})`)
        );
      }
      this.pending.clear();
    });
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (
        msg.method === "notifications/message" ||
        msg.method === "notifications/logging/message"
      ) {
        this.logNotifications.push(msg.params ?? msg);
      }
    }
  }

  request(method, params = {}, timeoutMs = 60000) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.child.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"
    );
  }

  async close() {
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    if (!this.child.killed) this.child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (this.child.exitCode != null) return resolve();
      this.child.once("exit", resolve);
      setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 2000);
    });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseToolText(result) {
  const textItem = (result?.content ?? []).find((c) => c.type === "text");
  assert(textItem?.type === "text", "tool result missing text");
  try {
    return JSON.parse(textItem.text);
  } catch {
    return textItem.text;
  }
}

async function launchFixture(port) {
  const { createRequire } = await import("module");
  const require = createRequire(import.meta.url);
  let electronPath;
  try {
    electronPath = require("electron");
  } catch (err) {
    throw new Error(
      `Electron binary missing for smoke fixture: ${
        err instanceof Error ? err.message : String(err)
      }. Run: npm run ensure-electron`
    );
  }
  if (!electronPath || typeof electronPath !== "string") {
    throw new Error("require('electron') did not return a binary path");
  }

  const child = spawn(
    electronPath,
    [
      "--no-sandbox",
      "--disable-gpu",
      `--remote-debugging-port=${port}`,
      fixtureApp,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ELECTRON_ENABLE_LOGGING: "1",
        ELECTRON_NO_ATTACH_CONSOLE: "1",
      },
      windowsHide: true,
    }
  );
  // Wait for debug port
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return child;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill("SIGKILL");
  throw new Error(`Fixture failed to expose debug port ${port}`);
}

async function main() {
  const pass = (name) => console.log(`PASS ${name}`);

  const client = new McpClient("node", [serverEntry], {
    ELECTRON_MCP_NO_SANDBOX: "1",
  });

  let processId;
  let attachedId;
  let external;
  let exitCode = 0;

  try {
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { logging: {} },
      clientInfo: { name: "mcp-smoke-test", version: "1.0.0" },
    });
    assert(init?.serverInfo?.name === "electron-debug-mcp", "bad serverInfo");
    assert(init?.capabilities?.tools, "tools capability missing");
    assert(init?.capabilities?.prompts, "prompts capability missing");
    client.notify("notifications/initialized");
    pass("initialize");

    const EXPECTED_TOOLS = [
      "start_app",
      "attach",
      "attach_by_pid",
      "find_apps",
      "discover_apps",
      "stop_app",
      "list_apps",
      "diagnose",
      "doctor",
      "evaluate",
      "screenshot",
      "get_dom",
      "query_selector",
      "get_console_messages",
      "get_network_log",
      "list_targets",
      "cdp_command",
      "page_info",
      "navigate",
      "wait_for",
      "click",
      "type_text",
      "press_key",
      "save_screenshot",
      "set_console_live",
      "get_cookies",
      "set_cookie",
      "get_storage",
      "set_storage",
      "start_tracing",
      "stop_tracing",
      "evaluate_main",
      "clear_buffers",
      "get_logs",
      "reload",
      "pause",
      "resume",
      // v1.6 creative power tools
      "snapshot",
      "vision",
      "get_response_body",
      "block_urls",
      "set_extra_headers",
      "get_performance_metrics",
      "start_cpu_profile",
      "stop_cpu_profile",
      "heap_snapshot",
      "main_state",
      "ipc_tap",
      "get_ipc_log",
      "diff_screenshot",
      "get_audit_issues",
      "find_installed_apps",
      // v1.7
      "start_coverage",
      "stop_coverage",
      "set_file_input",
      "emulate",
      "start_screencast",
      "stop_screencast",
      "set_breakpoint",
      "remove_breakpoint",
      "resolve_stack",
      "perf_audit",
      "capture_mhtml",
      "virtual_clock",
      "webcontents_topology",
    ];
    const tools = await client.request("tools/list");
    const names = new Set((tools.tools ?? []).map((t) => t.name));
    for (const required of EXPECTED_TOOLS) {
      assert(names.has(required), `missing tool ${required}`);
    }
    // Allow additive tools but never drop required ones.
    assert(
      names.size >= EXPECTED_TOOLS.length,
      `expected at least ${EXPECTED_TOOLS.length} tools, got ${names.size}`
    );
    pass(`tools/list (${names.size})`);

    const doctorResult = await client.request("tools/call", {
      name: "doctor",
      arguments: { sampleFreePort: true },
    });
    assert(!doctorResult.isError, `doctor error: ${doctorResult.content?.[0]?.text}`);
    const doctor = parseToolText(doctorResult);
    assert(doctor.version, "doctor missing version");
    assert(typeof doctor.freePortSample === "number", "doctor missing freePortSample");
    pass(`doctor (v${doctor.version}, port=${doctor.freePortSample})`);

    const prompts = await client.request("prompts/list");
    const promptNames = new Set((prompts.prompts ?? []).map((p) => p.name));
    for (const required of [
      "debug_blank_window",
      "find_renderer_exception",
      "ui_smoke_check",
      "attach_and_screenshot",
      "vision_then_act",
    ]) {
      assert(promptNames.has(required), `missing prompt ${required}`);
    }
    // Allow additive prompts but never drop required ones.
    assert(
      promptNames.size >= 5,
      `expected at least 5 prompts, got ${promptNames.size}`
    );
    pass(`prompts/list (${promptNames.size})`);

    const resources = await client.request("resources/list");
    const resourceUris = new Set((resources.resources ?? []).map((r) => r.uri));
    assert(resourceUris.has("electron://server"), "electron://server resource missing");
    assert(resourceUris.has("electron://info"), "electron://info resource missing");
    pass("resources/list");

    const serverRes = await client.request("resources/read", {
      uri: "electron://server",
    });
    const serverJson = JSON.parse(serverRes.contents?.[0]?.text ?? "{}");
    assert(serverJson.version, "electron://server missing version");
    assert(serverJson.name === "electron-debug-mcp", "electron://server bad name");
    pass("resources/read electron://server");

    const startResult = await client.request("tools/call", {
      name: "start_app",
      arguments: {
        appPath: fixtureApp,
        debugPort: DEBUG_PORT,
        extraArgs: ["--no-sandbox"],
        inspectMain: true,
      },
    });
    assert(
      !startResult.isError,
      `start_app error: ${startResult.content?.[0]?.text}`
    );
    const started = parseToolText(startResult);
    processId = started.id;
    assert(processId, "start_app did not return process id");
    pass(`start_app (${processId})`);

    await new Promise((r) => setTimeout(r, 1500));

    const targetsResult = await client.request("tools/call", {
      name: "list_targets",
      arguments: { processId },
    });
    const targets = parseToolText(targetsResult);
    assert(
      Array.isArray(targets.targets) && targets.targets.length > 0,
      "expected at least one CDP target"
    );
    pass(`list_targets (${targets.targets.length})`);

    const evalResult = await client.request("tools/call", {
      name: "evaluate",
      arguments: {
        processId,
        expression: "document.title + '|' + (window.__FIXTURE__?.name || '')",
      },
    });
    assert(
      !evalResult.isError,
      `evaluate error: ${evalResult.content?.[0]?.text}`
    );
    const evaluated = parseToolText(evalResult);
    const value = evaluated?.result?.result?.value;
    assert(
      typeof value === "string" &&
        value.includes("Minimal Electron Fixture") &&
        value.includes("minimal-electron-app"),
      `unexpected evaluate value: ${JSON.stringify(value)}`
    );
    pass(`evaluate (${value})`);

    // Trigger console after monitoring is up
    await client.request("tools/call", {
      name: "evaluate",
      arguments: {
        processId,
        expression: "console.log('smoke-console-ping'); 'pinged'",
      },
    });
    await new Promise((r) => setTimeout(r, 500));

    const consoleResult = await client.request("tools/call", {
      name: "get_console_messages",
      arguments: { processId },
    });
    assert(!consoleResult.isError, `console error: ${consoleResult.content?.[0]?.text}`);
    const consoleData = parseToolText(consoleResult);
    assert(
      (consoleData.messages ?? []).some((m) =>
        String(m.text).includes("smoke-console-ping")
      ),
      `expected console ping, got ${JSON.stringify(consoleData.messages)}`
    );
    pass("get_console_messages");

    await client.request("tools/call", {
      name: "evaluate",
      arguments: {
        processId,
        expression:
          "fetch('data:application/json,{\"n\":1}').then(r => r.ok).catch(() => false)",
      },
    });
    await new Promise((r) => setTimeout(r, 500));
    const networkResult = await client.request("tools/call", {
      name: "get_network_log",
      arguments: { processId, tail: 50 },
    });
    assert(!networkResult.isError, `network error: ${networkResult.content?.[0]?.text}`);
    const networkData = parseToolText(networkResult);
    assert(
      (networkData.entries ?? []).length > 0,
      "expected network entries"
    );
    pass(`get_network_log (${networkData.entries.length})`);

    const domResult = await client.request("tools/call", {
      name: "get_dom",
      arguments: { processId, selector: "#heading" },
    });
    assert(!domResult.isError, `get_dom error: ${domResult.content?.[0]?.text}`);
    const dom = parseToolText(domResult);
    assert(
      String(dom.html).includes("Hello from fixture"),
      `unexpected dom: ${dom.html}`
    );
    pass("get_dom");

    const queryResult = await client.request("tools/call", {
      name: "query_selector",
      arguments: { processId, selector: "#app-root button" },
    });
    assert(
      !queryResult.isError,
      `query_selector error: ${queryResult.content?.[0]?.text}`
    );
    const queried = parseToolText(queryResult);
    assert(
      queried?.result?.count >= 1,
      `expected button match: ${JSON.stringify(queried)}`
    );
    pass("query_selector");

    const pageInfoResult = await client.request("tools/call", {
      name: "page_info",
      arguments: { processId },
    });
    assert(!pageInfoResult.isError, `page_info error: ${pageInfoResult.content?.[0]?.text}`);
    const pageInfo = parseToolText(pageInfoResult);
    assert(pageInfo.title?.includes("Minimal Electron Fixture"), "bad page title");
    pass("page_info");

    const typeResult = await client.request("tools/call", {
      name: "type_text",
      arguments: {
        processId,
        selector: "#name",
        text: "ada",
        clear: true,
      },
    });
    assert(!typeResult.isError, `type_text error: ${typeResult.content?.[0]?.text}`);
    pass("type_text");

    const clickResult = await client.request("tools/call", {
      name: "click",
      arguments: { processId, selector: "#go" },
    });
    assert(!clickResult.isError, `click error: ${clickResult.content?.[0]?.text}`);
    pass("click");

    const waitResult = await client.request("tools/call", {
      name: "wait_for",
      arguments: { processId, text: "clicked:ada", timeoutMs: 5000 },
    });
    assert(!waitResult.isError, `wait_for error: ${waitResult.content?.[0]?.text}`);
    pass("wait_for");

    const pressResult = await client.request("tools/call", {
      name: "press_key",
      arguments: { processId, key: "Escape" },
    });
    assert(!pressResult.isError, `press_key error: ${pressResult.content?.[0]?.text}`);
    pass("press_key");

    const liveResult = await client.request("tools/call", {
      name: "set_console_live",
      arguments: { enabled: true },
    });
    assert(!liveResult.isError, `set_console_live error: ${liveResult.content?.[0]?.text}`);
    const logsBeforeLive = client.logNotifications.length;
    await client.request("tools/call", {
      name: "evaluate",
      arguments: {
        processId,
        expression: "console.log('smoke-live-log-ping'); 'live'",
      },
    });
    // Wait for MCP logging notification from set_console_live
    const liveDeadline = Date.now() + 5000;
    while (
      Date.now() < liveDeadline &&
      !client.logNotifications
        .slice(logsBeforeLive)
        .some((n) => String(n.data ?? n.message ?? "").includes("smoke-live-log-ping"))
    ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(
      client.logNotifications
        .slice(logsBeforeLive)
        .some((n) => String(n.data ?? n.message ?? "").includes("smoke-live-log-ping")),
      `set_console_live did not emit MCP log for console.log; got ${JSON.stringify(
        client.logNotifications.slice(logsBeforeLive).slice(-5)
      )}`
    );
    pass("set_console_live (MCP log notification)");

    const savePath = path.join(smokeOutDir, "smoke-screenshot.png");
    const saveResult = await client.request("tools/call", {
      name: "save_screenshot",
      arguments: { processId, path: savePath, format: "png" },
    });
    assert(!saveResult.isError, `save_screenshot error: ${saveResult.content?.[0]?.text}`);
    const saved = parseToolText(saveResult);
    assert(saved.path && fs.existsSync(saved.path), `screenshot file missing: ${JSON.stringify(saved)}`);
    pass("save_screenshot");

    const clipPath = path.join(smokeOutDir, "smoke-clip.png");
    const clipResult = await client.request("tools/call", {
      name: "save_screenshot",
      arguments: {
        processId,
        path: clipPath,
        format: "png",
        selector: "#heading",
      },
    });
    assert(!clipResult.isError, `element screenshot error: ${clipResult.content?.[0]?.text}`);
    const clipped = parseToolText(clipResult);
    assert(clipped.clip?.selector === "#heading", `expected clip meta: ${JSON.stringify(clipped)}`);
    assert(fs.existsSync(clipPath), "clip screenshot file missing");
    pass("save_screenshot selector clip");

    const setStore = await client.request("tools/call", {
      name: "set_storage",
      arguments: {
        processId,
        kind: "localStorage",
        entries: { smoke: "1" },
        clear: true,
      },
    });
    assert(!setStore.isError, `set_storage error: ${setStore.content?.[0]?.text}`);
    const getStore = await client.request("tools/call", {
      name: "get_storage",
      arguments: { processId, kind: "localStorage" },
    });
    assert(!getStore.isError, `get_storage error: ${getStore.content?.[0]?.text}`);
    const store = parseToolText(getStore);
    assert(store.entries?.smoke === "1", `storage mismatch: ${JSON.stringify(store)}`);
    pass("get/set_storage");

    // Use an http(s) URL — Chromium rejects cookies on file:// pages.
    const setCookieResult = await client.request("tools/call", {
      name: "set_cookie",
      arguments: {
        processId,
        name: "smoke",
        value: "ok",
        url: "http://127.0.0.1/",
        path: "/",
      },
    });
    assert(
      !setCookieResult.isError,
      `set_cookie error: ${setCookieResult.content?.[0]?.text}`
    );
    const cookiesResult = await client.request("tools/call", {
      name: "get_cookies",
      arguments: { processId, urls: ["http://127.0.0.1/"] },
    });
    assert(!cookiesResult.isError, `get_cookies error: ${cookiesResult.content?.[0]?.text}`);
    const cookies = parseToolText(cookiesResult);
    assert(
      (cookies.cookies ?? []).some((c) => c.name === "smoke" && c.value === "ok"),
      `expected smoke cookie: ${JSON.stringify(cookies)}`
    );
    pass("get/set_cookie");

    const traceStart = await client.request("tools/call", {
      name: "start_tracing",
      arguments: { processId },
    });
    assert(!traceStart.isError, `start_tracing error: ${traceStart.content?.[0]?.text}`);
    await new Promise((r) => setTimeout(r, 400));
    const tracePath = path.join(smokeOutDir, "smoke-trace.json");
    const traceStop = await client.request("tools/call", {
      name: "stop_tracing",
      arguments: { processId, path: tracePath },
    });
    assert(!traceStop.isError, `stop_tracing error: ${traceStop.content?.[0]?.text}`);
    const trace = parseToolText(traceStop);
    assert(fs.existsSync(trace.path || tracePath), `trace file missing: ${JSON.stringify(trace)}`);
    pass("start/stop_tracing");

    const findResult = await client.request("tools/call", {
      name: "find_apps",
      arguments: {},
    });
    assert(!findResult.isError, `find_apps error: ${findResult.content?.[0]?.text}`);
    const foundApps = parseToolText(findResult);
    assert(
      (foundApps.apps ?? []).some((a) => a.debugPort === DEBUG_PORT || /minimal-electron-app/.test(a.command || "")),
      `find_apps missed fixture: ${JSON.stringify(foundApps)}`
    );
    pass("find_apps");

    const startedPid = started.pid;
    assert(startedPid, "start_app must return pid for attach_by_pid coverage");
    const byPid = await client.request("tools/call", {
      name: "attach_by_pid",
      arguments: { pid: startedPid, name: "by-pid" },
    });
    assert(
      !byPid.isError,
      `attach_by_pid must succeed for start_app pid ${startedPid}: ${byPid.content?.[0]?.text}`
    );
    const attachedPid = parseToolText(byPid);
    assert(
      attachedPid.debugPort === DEBUG_PORT,
      `attach_by_pid wrong port: ${JSON.stringify(attachedPid)}`
    );
    pass("attach_by_pid");
    if (attachedPid.id && attachedPid.id !== processId) {
      await client.request("tools/call", {
        name: "stop_app",
        arguments: { processId: attachedPid.id },
      });
    }

    const waitEnabled = await client.request("tools/call", {
      name: "wait_for",
      arguments: { processId, enabled: "#go", timeoutMs: 3000 },
    });
    assert(!waitEnabled.isError, `wait_for enabled error: ${waitEnabled.content?.[0]?.text}`);
    pass("wait_for enabled");

    const waitCount = await client.request("tools/call", {
      name: "wait_for",
      arguments: {
        processId,
        countSelector: "#app-root button",
        minCount: 1,
        timeoutMs: 3000,
      },
    });
    assert(!waitCount.isError, `wait_for count error: ${waitCount.content?.[0]?.text}`);
    pass("wait_for count");

    const clearResult = await client.request("tools/call", {
      name: "clear_buffers",
      arguments: { processId, console: true, network: true, logs: false },
    });
    assert(!clearResult.isError, `clear_buffers error: ${clearResult.content?.[0]?.text}`);
    pass("clear_buffers");

    const logsResult = await client.request("tools/call", {
      name: "get_logs",
      arguments: { processId, tail: 50 },
    });
    assert(!logsResult.isError, `get_logs error: ${logsResult.content?.[0]?.text}`);
    const logsData = parseToolText(logsResult);
    assert(
      typeof logsData.logs === "string",
      `get_logs missing logs string: ${JSON.stringify(logsData)}`
    );
    pass("get_logs");

    // Screenshot/diagnose before navigate/pause — hidden windows can lose a
    // capturable surface after Debugger.pause or about:blank navigations.
    const shotResult = await client.request("tools/call", {
      name: "screenshot",
      arguments: { processId, format: "png" },
    });
    assert(
      !shotResult.isError,
      `screenshot error: ${shotResult.content?.[0]?.text}`
    );
    assert(
      (shotResult.content ?? []).some((c) => c.type === "image" && c.data),
      "screenshot missing image content"
    );
    pass("screenshot");

    const diagnoseResult = await client.request("tools/call", {
      name: "diagnose",
      arguments: { processId },
    });
    assert(
      !diagnoseResult.isError,
      `diagnose error: ${diagnoseResult.content?.[0]?.text}`
    );
    const diagnosis = parseToolText(diagnoseResult);
    assert(
      diagnosis?.processes?.[0]?.debugPortReachable === true,
      `diagnose port not reachable: ${JSON.stringify(diagnosis)}`
    );
    pass("diagnose");

    // Pause/resume before creative tools — virtual_clock / screencast can leave
    // the Debugger session in a state where pause never emits Debugger.paused.
    const pauseResult = await client.request("tools/call", {
      name: "pause",
      arguments: { processId },
    });
    assert(!pauseResult.isError, `pause error: ${pauseResult.content?.[0]?.text}`);
    pass("pause");

    const resumeResult = await client.request("tools/call", {
      name: "resume",
      arguments: { processId },
    });
    assert(!resumeResult.isError, `resume error: ${resumeResult.content?.[0]?.text}`);
    pass("resume");

    // Navigate/reload before creative soft tools — virtual_clock can leave the
    // renderer unable to complete a subsequent file:// navigation in CI.
    const pageBeforeNav = await client.request("tools/call", {
      name: "page_info",
      arguments: { processId },
    });
    assert(!pageBeforeNav.isError, `page_info before navigate: ${pageBeforeNav.content?.[0]?.text}`);
    const beforeNav = parseToolText(pageBeforeNav);
    const originalUrl = beforeNav.url;
    assert(originalUrl, `page_info missing url: ${JSON.stringify(beforeNav)}`);

    const navAway = await client.request("tools/call", {
      name: "navigate",
      arguments: {
        processId,
        url: "about:blank",
        waitUntilLoad: true,
        timeoutMs: 15000,
      },
    });
    assert(!navAway.isError, `navigate about:blank error: ${navAway.content?.[0]?.text}`);
    pass("navigate (about:blank)");

    const navBack = await client.request("tools/call", {
      name: "navigate",
      arguments: {
        processId,
        url: originalUrl,
        waitUntilLoad: true,
        timeoutMs: 15000,
      },
    });
    assert(!navBack.isError, `navigate back error: ${navBack.content?.[0]?.text}`);
    pass("navigate (restore)");

    const reloadResult = await client.request("tools/call", {
      name: "reload",
      arguments: { processId, ignoreCache: false },
    });
    assert(!reloadResult.isError, `reload error: ${reloadResult.content?.[0]?.text}`);
    const reloaded = parseToolText(reloadResult);
    assert(
      Array.isArray(reloaded.reloaded) && reloaded.reloaded.length > 0,
      `reload returned no targets: ${JSON.stringify(reloaded)}`
    );
    pass("reload");

    const cdpResultEarly = await client.request("tools/call", {
      name: "cdp_command",
      arguments: {
        processId,
        method: "Runtime.evaluate",
        params: { expression: "1+2", returnByValue: true },
      },
    });
    assert(!cdpResultEarly.isError, `cdp_command error: ${cdpResultEarly.content?.[0]?.text}`);
    const cdpEarly = parseToolText(cdpResultEarly);
    const cdpEarlyValue = cdpEarly?.result?.result?.value ?? cdpEarly?.result?.value;
    assert(
      cdpEarlyValue === 3,
      `cdp_command unexpected value: ${JSON.stringify(cdpEarly)}`
    );
    pass("cdp_command");

    // --- v1.6 creative power tools (soft-skip heavy/optional CDP where flaky) ---
    const soft = async (label, fn) => {
      try {
        await fn();
      } catch (err) {
        pass(`${label} soft-skip (${err instanceof Error ? err.message : String(err)})`);
      }
    };

    await soft("snapshot", async () => {
      const snap = await client.request("tools/call", {
        name: "snapshot",
        arguments: { processId, depth: 8 },
      });
      assert(!snap.isError, `snapshot error: ${snap.content?.[0]?.text}`);
      const snapData = parseToolText(snap);
      assert(
        Array.isArray(snapData.nodes) && snapData.nodeCount >= 1,
        `snapshot empty: ${JSON.stringify(snapData).slice(0, 200)}`
      );
      pass(`snapshot (${snapData.nodeCount} nodes)`);
    });

    await soft("vision", async () => {
      const vision = await client.request("tools/call", {
        name: "vision",
        arguments: { processId, includeScreenshot: true },
      });
      assert(!vision.isError, `vision error: ${vision.content?.[0]?.text}`);
      assert(
        (vision.content ?? []).some((c) => c.type === "image" || c.type === "text"),
        "vision missing content"
      );
      pass("vision");
    });

    await soft("get_performance_metrics", async () => {
      const perf = await client.request("tools/call", {
        name: "get_performance_metrics",
        arguments: { processId },
      });
      assert(!perf.isError, `get_performance_metrics error: ${perf.content?.[0]?.text}`);
      const perfData = parseToolText(perf);
      assert(perfData.metrics && typeof perfData.metrics === "object", "perf metrics missing");
      pass("get_performance_metrics");
    });

    await soft("start/stop_cpu_profile", async () => {
      let started = false;
      let profilePath;
      try {
        const cpuStart = await client.request("tools/call", {
          name: "start_cpu_profile",
          arguments: { processId },
        });
        assert(!cpuStart.isError, `start_cpu_profile error: ${cpuStart.content?.[0]?.text}`);
        started = true;
        await new Promise((r) => setTimeout(r, 100));
        const cpuStop = await client.request("tools/call", {
          name: "stop_cpu_profile",
          arguments: { processId },
        });
        started = false;
        assert(!cpuStop.isError, `stop_cpu_profile error: ${cpuStop.content?.[0]?.text}`);
        const cpuData = parseToolText(cpuStop);
        assert(cpuData.path && cpuData.bytes > 0, `cpu profile missing file: ${JSON.stringify(cpuData)}`);
        profilePath = cpuData.path;
        pass("start/stop_cpu_profile");
      } finally {
        if (started) {
          try {
            await client.request(
              "tools/call",
              { name: "stop_cpu_profile", arguments: { processId } },
              15_000,
            );
          } catch {
            /* ignore — soft path already failed */
          }
        }
        if (profilePath) {
          try {
            fs.unlinkSync(profilePath);
          } catch {
            /* ignore */
          }
        }
      }
    });

    await soft("block_urls", async () => {
      const block = await client.request("tools/call", {
        name: "block_urls",
        arguments: { processId, urls: ["*://blocked.example/*"] },
      });
      assert(!block.isError, `block_urls error: ${block.content?.[0]?.text}`);
      pass("block_urls");
    });

    await soft("set_extra_headers", async () => {
      const headers = await client.request("tools/call", {
        name: "set_extra_headers",
        arguments: { processId, headers: { "X-Electron-Mcp": "1" } },
      });
      assert(!headers.isError, `set_extra_headers error: ${headers.content?.[0]?.text}`);
      pass("set_extra_headers");
    });

    await soft("get_audit_issues", async () => {
      const audits = await client.request("tools/call", {
        name: "get_audit_issues",
        arguments: { processId },
      });
      assert(!audits.isError, `get_audit_issues error: ${audits.content?.[0]?.text}`);
      pass("get_audit_issues");
    });

    await soft("find_installed_apps", async () => {
      const installed = await client.request("tools/call", {
        name: "find_installed_apps",
        arguments: {},
      });
      assert(!installed.isError, `find_installed_apps error: ${installed.content?.[0]?.text}`);
      const installedData = parseToolText(installed);
      assert(typeof installedData.count === "number", "find_installed_apps missing count");
      pass(`find_installed_apps (${installedData.count})`);
    });

    const baselinePath = path.join(smokeOutDir, `mcp-smoke-baseline-${Date.now()}.png`);
    await soft("diff_screenshot", async () => {
      let currentPath;
      try {
        const baseShot = await client.request("tools/call", {
          name: "save_screenshot",
          arguments: { processId, path: baselinePath },
        });
        assert(!baseShot.isError, `baseline screenshot error: ${baseShot.content?.[0]?.text}`);
        const diff = await client.request("tools/call", {
          name: "diff_screenshot",
          arguments: { processId, baselinePath },
        });
        assert(!diff.isError, `diff_screenshot error: ${diff.content?.[0]?.text}`);
        const diffData = parseToolText(diff);
        assert(typeof diffData.identical === "boolean", "diff_screenshot missing identical");
        currentPath = diffData.currentPath;
        pass(`diff_screenshot (identical=${diffData.identical})`);
      } finally {
        for (const p of [baselinePath, currentPath].filter(Boolean)) {
          try {
            fs.unlinkSync(p);
          } catch {
            /* ignore */
          }
        }
      }
    });

    await soft("heap_snapshot", async () => {
      let heapPath;
      try {
        const heap = await client.request("tools/call", {
          name: "heap_snapshot",
          arguments: { processId },
        });
        assert(!heap.isError, `heap_snapshot error: ${heap.content?.[0]?.text}`);
        const heapData = parseToolText(heap);
        assert(heapData.path && heapData.bytes > 0, `heap_snapshot missing file: ${JSON.stringify(heapData)}`);
        heapPath = heapData.path;
        pass("heap_snapshot");
      } finally {
        if (heapPath) {
          try {
            fs.unlinkSync(heapPath);
          } catch {
            /* ignore */
          }
        }
      }
    });

    // --- v1.7 creative tools (soft) ---
    await soft("start/stop_coverage", async () => {
      const start = await client.request("tools/call", {
        name: "start_coverage",
        arguments: { processId },
      });
      assert(!start.isError, `start_coverage: ${start.content?.[0]?.text}`);
      const stop = await client.request("tools/call", {
        name: "stop_coverage",
        arguments: { processId },
      });
      assert(!stop.isError, `stop_coverage: ${stop.content?.[0]?.text}`);
      pass("start/stop_coverage");
    });

    await soft("emulate", async () => {
      const emu = await client.request("tools/call", {
        name: "emulate",
        arguments: {
          processId,
          metrics: { width: 800, height: 600, deviceScaleFactor: 1, mobile: false },
        },
      });
      assert(!emu.isError, `emulate: ${emu.content?.[0]?.text}`);
      await client.request("tools/call", {
        name: "emulate",
        arguments: { processId, clear: true },
      });
      pass("emulate");
    });

    await soft("start/stop_screencast", async () => {
      let started = false;
      try {
        const start = await client.request("tools/call", {
          name: "start_screencast",
          arguments: { processId, maxFrames: 2, everyNthFrame: 1 },
        });
        assert(!start.isError, `start_screencast: ${start.content?.[0]?.text}`);
        started = true;
        await new Promise((r) => setTimeout(r, 200));
        const stop = await client.request("tools/call", {
          name: "stop_screencast",
          arguments: { processId },
        });
        started = false;
        assert(!stop.isError, `stop_screencast: ${stop.content?.[0]?.text}`);
        pass("start/stop_screencast");
      } finally {
        if (started) {
          try {
            await client.request(
              "tools/call",
              { name: "stop_screencast", arguments: { processId } },
              15_000,
            );
          } catch {
            /* ignore */
          }
        }
      }
    });

    await soft("perf_audit", async () => {
      const audit = await client.request("tools/call", {
        name: "perf_audit",
        arguments: { processId },
      });
      assert(!audit.isError, `perf_audit: ${audit.content?.[0]?.text}`);
      const data = parseToolText(audit);
      assert(data.metrics && typeof data.metrics === "object", "perf_audit missing metrics");
      pass("perf_audit");
    });

    await soft("capture_mhtml", async () => {
      let mhtmlPath;
      try {
        const mhtml = await client.request("tools/call", {
          name: "capture_mhtml",
          arguments: { processId },
        });
        assert(!mhtml.isError, `capture_mhtml: ${mhtml.content?.[0]?.text}`);
        const data = parseToolText(mhtml);
        assert(data.path && data.bytes > 0, `capture_mhtml missing file: ${JSON.stringify(data)}`);
        mhtmlPath = data.path;
        pass("capture_mhtml");
      } finally {
        if (mhtmlPath) {
          try {
            fs.unlinkSync(mhtmlPath);
          } catch {
            /* ignore */
          }
        }
      }
    });

    await soft("virtual_clock", async () => {
      const clock = await client.request("tools/call", {
        name: "virtual_clock",
        arguments: { processId, policy: "advance", budget: 50 },
      });
      assert(!clock.isError, `virtual_clock: ${clock.content?.[0]?.text}`);
      // ignoreCache reload — virtual time can otherwise stick across navigations in CI.
      const reloadAfterClock = await client.request("tools/call", {
        name: "reload",
        arguments: { processId, ignoreCache: true },
      });
      assert(
        !reloadAfterClock.isError,
        `reload after virtual_clock: ${reloadAfterClock.content?.[0]?.text}`,
      );
      pass("virtual_clock");
    });

    await soft("webcontents_topology", async () => {
      const topo = await client.request("tools/call", {
        name: "webcontents_topology",
        arguments: { processId },
      });
      assert(!topo.isError, `webcontents_topology: ${topo.content?.[0]?.text}`);
      const data = parseToolText(topo);
      assert(Array.isArray(data.cdpTargets), "webcontents_topology missing cdpTargets");
      pass("webcontents_topology");
    });

    await soft("resolve_stack", async () => {
      const stack = await client.request("tools/call", {
        name: "resolve_stack",
        arguments: {
          processId,
          frames: [{ url: "file:///nonexistent.js", lineNumber: 0 }],
          contextLines: 1,
        },
      });
      assert(!stack.isError, `resolve_stack: ${stack.content?.[0]?.text}`);
      pass("resolve_stack");
    });

    // Soft: get_response_body needs a finished requestId — use latest if any.
    const netForBody = await client.request("tools/call", {
      name: "get_network_log",
      arguments: { processId, tail: 20 },
    });
    const netEntries = parseToolText(netForBody)?.entries ?? [];
    const finished = [...netEntries]
      .reverse()
      .find((e) => e.event === "finished" || e.event === "response");
    if (finished?.requestId) {
      const body = await client.request("tools/call", {
        name: "get_response_body",
        arguments: { processId, requestId: finished.requestId },
      });
      if (!body.isError) {
        pass("get_response_body");
      } else {
        pass(`get_response_body soft-skip (${body.content?.[0]?.text ?? "error"})`);
      }
    } else {
      pass("get_response_body soft-skip (no requestId)");
    }

    // start_app used inspectMain:true — main/node target must be evaluable.
    let mainEval;
    let mainOk = false;
    let lastMainMsg = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      mainEval = await client.request("tools/call", {
        name: "evaluate_main",
        arguments: { processId, expression: "1+1" },
      });
      if (!mainEval.isError) {
        mainOk = true;
        break;
      }
      lastMainMsg = mainEval.content?.[0]?.text || "";
      await new Promise((r) => setTimeout(r, 400));
    }
    assert(
      mainOk,
      `evaluate_main failed with inspectMain:true: ${lastMainMsg}`
    );
    const mainVal = parseToolText(mainEval);
    const mainValue =
      mainVal?.result?.result?.value ?? mainVal?.result?.value ?? mainVal?.value;
    assert(
      mainValue === 2,
      `evaluate_main unexpected value: ${JSON.stringify(mainVal)}`
    );
    pass("evaluate_main");

    {
      const mainState = await client.request("tools/call", {
        name: "main_state",
        arguments: { processId },
      });
      if (mainState.isError) {
        pass(`main_state soft-skip (${mainState.content?.[0]?.text})`);
      } else {
        const mainStateData = parseToolText(mainState);
        assert(
          mainStateData.main,
          `main_state empty: ${JSON.stringify(mainStateData).slice(0, 200)}`
        );
        pass("main_state");
      }
    }

    {
      const ipcTap = await client.request("tools/call", {
        name: "ipc_tap",
        arguments: { processId },
      });
      if (ipcTap.isError) {
        pass(`ipc_tap soft-skip (${ipcTap.content?.[0]?.text})`);
      } else {
        const ipcLog = await client.request("tools/call", {
          name: "get_ipc_log",
          arguments: { processId },
        });
        assert(!ipcLog.isError, `get_ipc_log error: ${ipcLog.content?.[0]?.text}`);
        pass("ipc_tap / get_ipc_log");
      }
    }

    // Attach flow: launch external electron, attach via MCP
    external = await launchFixture(ATTACH_PORT);
    const attachResult = await client.request("tools/call", {
      name: "attach",
      arguments: { debugPort: ATTACH_PORT, name: "external-fixture" },
    });
    assert(
      !attachResult.isError,
      `attach error: ${attachResult.content?.[0]?.text}`
    );
    const attached = parseToolText(attachResult);
    attachedId = attached.id;
    assert(attached.attached === true, "expected attached=true");
    pass(`attach (${attachedId})`);

    // Probe the actual live ports (may be far apart if ephemeral fallback kicked in).
    const foundPorts = new Set();
    for (const port of [DEBUG_PORT, ATTACH_PORT]) {
      const discoverResult = await client.request("tools/call", {
        name: "discover_apps",
        arguments: { startPort: port, endPort: port },
      });
      assert(
        !discoverResult.isError,
        `discover_apps(${port}) error: ${discoverResult.content?.[0]?.text}`
      );
      const discovered = parseToolText(discoverResult);
      for (const f of discovered.found ?? []) foundPorts.add(f.port);
    }
    assert(
      foundPorts.has(ATTACH_PORT),
      `discover missed attach port ${ATTACH_PORT}: found=${[...foundPorts]}`
    );
    assert(
      foundPorts.has(DEBUG_PORT),
      `discover missed start_app port ${DEBUG_PORT}: found=${[...foundPorts]}`
    );
    pass(`discover_apps (ports ${DEBUG_PORT}, ${ATTACH_PORT})`);

    const listResult = await client.request("tools/call", {
      name: "list_apps",
      arguments: {},
    });
    const listed = parseToolText(listResult);
    assert(
      (listed.processes ?? []).some((p) => p.id === processId) &&
        (listed.processes ?? []).some((p) => p.id === attachedId),
      "list_apps missing processes"
    );
    pass("list_apps");

    const info = await client.request("resources/read", {
      uri: "electron://info",
    });
    assert(
      info?.contents?.[0]?.text?.includes(processId),
      "info resource missing process"
    );
    pass("resources/read electron://info");

    const targetsRes = await client.request("resources/read", {
      uri: "electron://targets",
    });
    assert(
      targetsRes?.contents?.[0]?.text?.includes(processId),
      "targets resource missing process"
    );
    pass("resources/read electron://targets");

    const processRes = await client.request("resources/read", {
      uri: `electron://process/${processId}`,
    });
    assert(
      processRes?.contents?.[0]?.text?.includes(processId),
      "process resource missing id"
    );
    pass("resources/read electron://process/{id}");

    const logsRes = await client.request("resources/read", {
      uri: `electron://logs/${processId}`,
    });
    assert(
      typeof logsRes?.contents?.[0]?.text === "string",
      "logs resource missing text"
    );
    pass("resources/read electron://logs/{id}");

    const consoleRes = await client.request("resources/read", {
      uri: `electron://console/${processId}`,
    });
    assert(
      consoleRes?.contents?.[0]?.text != null,
      "console resource missing text"
    );
    pass("resources/read electron://console/{id}");

    const listedResources = await client.request("resources/list");
    const cdpUri = (listedResources.resources ?? []).find((r) =>
      String(r.uri).startsWith(`electron://cdp/${processId}/`)
    )?.uri;
    assert(cdpUri, `no electron://cdp/${processId}/… resource listed`);
    const cdpRes = await client.request("resources/read", { uri: cdpUri });
    assert(
      cdpRes?.contents?.[0]?.text?.includes(processId),
      `cdp resource missing process: ${cdpUri}`
    );
    pass("resources/read electron://cdp/{processId}/{targetId}");

    const stoppedAttachedId = attachedId;
    const stoppedProcessId = processId;

    const stopAttached = await client.request("tools/call", {
      name: "stop_app",
      arguments: { processId: attachedId },
    });
    assert(!stopAttached.isError, "stop attached failed");
    pass("stop_app (detach)");
    attachedId = undefined;

    const stopResult = await client.request("tools/call", {
      name: "stop_app",
      arguments: { processId },
    });
    assert(!stopResult.isError, `stop_app error: ${stopResult.content?.[0]?.text}`);
    pass("stop_app");
    processId = undefined;

    // Delete-on-stop: stopped sessions must not linger in list_apps.
    const afterStop = await client.request("tools/call", {
      name: "list_apps",
      arguments: {},
    });
    assert(!afterStop.isError, `list_apps after stop: ${afterStop.content?.[0]?.text}`);
    const remaining = parseToolText(afterStop);
    const leftover = (remaining.processes ?? []).filter(
      (p) => p.id === stoppedProcessId || p.id === stoppedAttachedId
    );
    assert(
      leftover.length === 0,
      `stopped sessions still listed: ${JSON.stringify(leftover)}`
    );
    pass("list_apps post-stop cleanup");

    // Idempotent stop on already-removed session.
    const stopAgain = await client.request("tools/call", {
      name: "stop_app",
      arguments: { processId: stoppedProcessId },
    });
    assert(
      !stopAgain.isError,
      `idempotent stop_app error: ${stopAgain.content?.[0]?.text}`
    );
    pass("stop_app idempotent");

    console.log("\nAll smoke tests passed.");
  } catch (err) {
    exitCode = 1;
    console.error(`FAIL smoke: ${err instanceof Error ? err.message : String(err)}`);
    if (client.stderr) {
      console.error("\n--- server stderr (tail) ---");
      console.error(client.stderr.slice(-2500));
    }
  } finally {
    // Always tear down managed apps / external fixture / temp dir / MCP child.
    if (attachedId) {
      try {
        await client.request(
          "tools/call",
          { name: "stop_app", arguments: { processId: attachedId } },
          15_000,
        );
      } catch {
        // ignore
      }
    }
    if (processId) {
      try {
        await client.request(
          "tools/call",
          { name: "stop_app", arguments: { processId } },
          15_000,
        );
      } catch {
        // ignore
      }
    }
    if (external && !external.killed) {
      try {
        external.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    try {
      fs.rmSync(smokeOutDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      await client.close();
    } catch {
      // ignore
    }
  }
  process.exit(exitCode);
}

main();
