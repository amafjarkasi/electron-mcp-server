#!/usr/bin/env node
/**
 * End-to-end smoke test for the Electron Debug MCP server.
 * Spawns the server over stdio, drives tools against fixtures/minimal-electron-app.
 */
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const serverEntry = path.join(root, "build", "index.js");
const fixtureApp = path.join(root, "fixtures", "minimal-electron-app");
const DEBUG_PORT = 9339;

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
        if (msg.error) {
          reject(new Error(JSON.stringify(msg.error)));
        } else {
          resolve(msg.result);
        }
      }
    }
  }

  request(method, params = {}) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
    if (!this.child.killed) {
      this.child.kill("SIGTERM");
    }
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
  if (!condition) {
    throw new Error(message);
  }
}

function parseToolText(result) {
  assert(result?.content?.[0]?.type === "text", "tool result missing text");
  const text = result.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main() {
  const steps = [];
  const pass = (name) => {
    steps.push(`PASS ${name}`);
    console.log(`PASS ${name}`);
  };
  const fail = (name, err) => {
    steps.push(`FAIL ${name}: ${err}`);
    console.error(`FAIL ${name}: ${err}`);
  };

  const client = new McpClient("node", [serverEntry], {
    ELECTRON_MCP_NO_SANDBOX: "1",
  });

  let processId;

  try {
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-smoke-test", version: "1.0.0" },
    });
    assert(init?.serverInfo?.name === "electron-debug-mcp", "bad serverInfo");
    assert(init?.capabilities?.tools, "tools capability missing");
    client.notify("notifications/initialized");
    pass("initialize");

    const tools = await client.request("tools/list");
    const names = new Set((tools.tools ?? []).map((t) => t.name));
    for (const required of [
      "start_app",
      "stop_app",
      "list_apps",
      "evaluate",
      "list_targets",
      "cdp_command",
    ]) {
      assert(names.has(required), `missing tool ${required}`);
    }
    pass("tools/list");

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
    assert(!startResult.isError, `start_app error: ${startResult.content?.[0]?.text}`);
    const started = parseToolText(startResult);
    processId = started.id;
    assert(processId, "start_app did not return process id");
    assert(started.debugPort === DEBUG_PORT, "debug port mismatch");
    pass(`start_app (${processId})`);

    // Give the page a moment to finish loading after CDP port is up.
    await new Promise((r) => setTimeout(r, 1500));

    const targetsResult = await client.request("tools/call", {
      name: "list_targets",
      arguments: { processId },
    });
    assert(!targetsResult.isError, `list_targets error: ${targetsResult.content?.[0]?.text}`);
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
    assert(!evalResult.isError, `evaluate error: ${evalResult.content?.[0]?.text}`);
    const evaluated = parseToolText(evalResult);
    const value = evaluated?.result?.result?.value;
    assert(
      typeof value === "string" &&
        value.includes("Minimal Electron Fixture") &&
        value.includes("minimal-electron-app"),
      `unexpected evaluate value: ${JSON.stringify(value)}`
    );
    pass(`evaluate (${value})`);

    const listResult = await client.request("tools/call", {
      name: "list_apps",
      arguments: {},
    });
    const listed = parseToolText(listResult);
    assert(
      (listed.processes ?? []).some((p) => p.id === processId),
      "list_apps missing started process"
    );
    pass("list_apps");

    const info = await client.request("resources/read", {
      uri: "electron://info",
    });
    assert(info?.contents?.[0]?.text?.includes(processId), "info resource missing process");
    pass("resources/read electron://info");

    const stopResult = await client.request("tools/call", {
      name: "stop_app",
      arguments: { processId },
    });
    assert(!stopResult.isError, `stop_app error: ${stopResult.content?.[0]?.text}`);
    pass("stop_app");
    processId = undefined;

    console.log("\nAll smoke tests passed.");
    await client.close();
    process.exit(0);
  } catch (err) {
    fail("smoke", err instanceof Error ? err.message : String(err));
    if (client.stderr) {
      console.error("\n--- server stderr (tail) ---");
      console.error(client.stderr.slice(-2000));
    }
    if (processId) {
      try {
        await client.request("tools/call", {
          name: "stop_app",
          arguments: { processId },
        });
      } catch {
        // best effort
      }
    }
    await client.close();
    process.exit(1);
  }
}

main();
