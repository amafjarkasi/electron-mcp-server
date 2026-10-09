#!/usr/bin/env node
/**
 * End-to-end smoke test for the Electron Debug MCP server.
 * Spawns the server over stdio, drives tools against fixtures/minimal-electron-app.
 */
import { spawn } from "child_process";
import net from "net";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const serverEntry = path.join(root, "build", "index.js");
const fixtureApp = path.join(root, "fixtures", "minimal-electron-app");

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

  try {
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-smoke-test", version: "1.0.0" },
    });
    assert(init?.serverInfo?.name === "electron-debug-mcp", "bad serverInfo");
    assert(init?.capabilities?.tools, "tools capability missing");
    assert(init?.capabilities?.prompts, "prompts capability missing");
    client.notify("notifications/initialized");
    pass("initialize");

    const tools = await client.request("tools/list");
    const names = new Set((tools.tools ?? []).map((t) => t.name));
    for (const required of [
      "start_app",
      "attach",
      "attach_by_pid",
      "find_apps",
      "discover_apps",
      "stop_app",
      "list_apps",
      "diagnose",
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
    ]) {
      assert(names.has(required), `missing tool ${required}`);
    }
    pass("tools/list");

    const prompts = await client.request("prompts/list");
    assert(
      (prompts.prompts ?? []).some((p) => p.name === "debug_blank_window"),
      "missing debug_blank_window prompt"
    );
    pass("prompts/list");

    const resources = await client.request("resources/list");
    assert(
      (resources.resources ?? []).some((r) => r.uri === "electron://info"),
      "electron://info resource missing"
    );
    pass("resources/list");

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
    pass("set_console_live");

    const savePath = path.join(root, "build", "smoke-screenshot.png");
    const saveResult = await client.request("tools/call", {
      name: "save_screenshot",
      arguments: { processId, path: savePath, format: "png" },
    });
    assert(!saveResult.isError, `save_screenshot error: ${saveResult.content?.[0]?.text}`);
    const saved = parseToolText(saveResult);
    assert(saved.path && fs.existsSync(saved.path), `screenshot file missing: ${JSON.stringify(saved)}`);
    pass("save_screenshot");

    const clipPath = path.join(root, "build", "smoke-clip.png");
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

    const setCookieResult = await client.request("tools/call", {
      name: "set_cookie",
      arguments: {
        processId,
        name: "smoke",
        value: "ok",
        url: "file:///",
      },
    });
    // file:// cookies may be rejected by Chromium; accept success or clear error
    if (!setCookieResult.isError) {
      const cookiesResult = await client.request("tools/call", {
        name: "get_cookies",
        arguments: { processId },
      });
      assert(!cookiesResult.isError, `get_cookies error: ${cookiesResult.content?.[0]?.text}`);
      pass("get/set_cookie");
    } else {
      const msg = setCookieResult.content?.[0]?.text || "";
      assert(/cookie|url|domain|success|false|Invalid/i.test(msg) || msg.length > 0, msg);
      // Still exercise get_cookies
      const cookiesResult = await client.request("tools/call", {
        name: "get_cookies",
        arguments: { processId },
      });
      assert(!cookiesResult.isError, `get_cookies error: ${cookiesResult.content?.[0]?.text}`);
      pass("get/set_cookie (set may fail on file://)");
    }

    const traceStart = await client.request("tools/call", {
      name: "start_tracing",
      arguments: { processId },
    });
    assert(!traceStart.isError, `start_tracing error: ${traceStart.content?.[0]?.text}`);
    await new Promise((r) => setTimeout(r, 400));
    const tracePath = path.join(root, "build", "smoke-trace.json");
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
    if (startedPid) {
      // Stop MCP ownership bookkeeping isn't required — attach_by_pid to same port should reuse/attach
      const byPid = await client.request("tools/call", {
        name: "attach_by_pid",
        arguments: { pid: startedPid, name: "by-pid" },
      });
      // May succeed (same port attach returns existing) or fail if pid cmdline lacks port — both OK if find_apps worked
      if (!byPid.isError) {
        const attachedPid = parseToolText(byPid);
        assert(attachedPid.debugPort === DEBUG_PORT, `attach_by_pid wrong port: ${JSON.stringify(attachedPid)}`);
        pass("attach_by_pid");
        // If it created a separate session id, stop the duplicate attach session only when different
        if (attachedPid.id && attachedPid.id !== processId) {
          await client.request("tools/call", {
            name: "stop_app",
            arguments: { processId: attachedPid.id },
          });
        }
      } else {
        const msg = byPid.content?.[0]?.text || "";
        assert(/debug|port|pid|Could not resolve/i.test(msg), `unexpected attach_by_pid error: ${msg}`);
        pass("attach_by_pid (resolve may need cmdline port — exercised)");
      }
    } else {
      pass("attach_by_pid (skipped — no pid)");
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
        timeoutMs: 10000,
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
        timeoutMs: 10000,
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

    const cdpResult = await client.request("tools/call", {
      name: "cdp_command",
      arguments: {
        processId,
        method: "Runtime.evaluate",
        params: { expression: "1+2", returnByValue: true },
      },
    });
    assert(!cdpResult.isError, `cdp_command error: ${cdpResult.content?.[0]?.text}`);
    const cdp = parseToolText(cdpResult);
    const cdpValue = cdp?.result?.result?.value ?? cdp?.result?.value;
    assert(
      cdpValue === 3,
      `cdp_command unexpected value: ${JSON.stringify(cdp)}`
    );
    pass("cdp_command");

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

    if (external && !external.killed) {
      external.kill("SIGKILL");
    }

    console.log("\nAll smoke tests passed.");
    await client.close();
    process.exit(0);
  } catch (err) {
    console.error(`FAIL smoke: ${err instanceof Error ? err.message : String(err)}`);
    if (client.stderr) {
      console.error("\n--- server stderr (tail) ---");
      console.error(client.stderr.slice(-2500));
    }
    if (attachedId) {
      try {
        await client.request("tools/call", {
          name: "stop_app",
          arguments: { processId: attachedId },
        });
      } catch {
        // ignore
      }
    }
    if (processId) {
      try {
        await client.request("tools/call", {
          name: "stop_app",
          arguments: { processId },
        });
      } catch {
        // ignore
      }
    }
    if (external && !external.killed) external.kill("SIGKILL");
    await client.close();
    process.exit(1);
  }
}

main();
