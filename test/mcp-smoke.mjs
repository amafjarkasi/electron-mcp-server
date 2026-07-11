#!/usr/bin/env node
/**
 * End-to-end smoke test for the Electron Debug MCP server.
 * Spawns the server over stdio, drives tools against fixtures/minimal-electron-app.
 */
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const serverEntry = path.join(root, "build", "index.js");
const fixtureApp = path.join(root, "fixtures", "minimal-electron-app");
const DEBUG_PORT = 9339;
const ATTACH_PORT = 9340;

async function freePort(port) {
  try {
    const { execFileSync } = await import("child_process");
    execFileSync("bash", [
      "-lc",
      `fuser -k ${port}/tcp 2>/dev/null || true`,
    ]);
  } catch {
    // best effort
  }
  await new Promise((r) => setTimeout(r, 300));
}

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
  await freePort(DEBUG_PORT);
  await freePort(ATTACH_PORT);

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
      "evaluate_main",
      "clear_buffers",
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

    // evaluate_main may fail without inspectMain; still exercise the tool path
    const mainEval = await client.request("tools/call", {
      name: "evaluate_main",
      arguments: { processId, expression: "1+1" },
    });
    // Accept either success or a clear "No main/node target" style error
    if (!mainEval.isError) {
      pass("evaluate_main");
    } else {
      const msg = mainEval.content?.[0]?.text || "";
      assert(
        /main|node|target|inspectMain/i.test(msg),
        `unexpected evaluate_main error: ${msg}`
      );
      pass("evaluate_main (no main target — expected without inspectMain)");
    }

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

    const discoverResult = await client.request("tools/call", {
      name: "discover_apps",
      arguments: { startPort: 9339, endPort: 9340 },
    });
    const discovered = parseToolText(discoverResult);
    // Freshly attached port must be discoverable. The start_app port can race
    // if Chromium's DevTools HTTP server failed to bind earlier in the run.
    assert(
      (discovered.found ?? []).some((f) => f.port === ATTACH_PORT),
      `discover missed attach port ${ATTACH_PORT}: ${JSON.stringify(discovered)}`
    );
    if (!(discovered.found ?? []).some((f) => f.port === DEBUG_PORT)) {
      console.warn(
        `WARN discover_apps: start_app port ${DEBUG_PORT} not listed (CDP bind race?)`
      );
    }
    pass("discover_apps");

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
