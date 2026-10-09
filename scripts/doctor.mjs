#!/usr/bin/env node
/** Spawn built MCP server; call tools/list, doctor, electron://server; print JSON. */
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "build", "index.js");
const parse = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

class McpClient {
  constructor() {
    this.child = spawn(process.execPath, [entry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      cwd: root,
    });
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (c) => this.#onData(c));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (c) => {
      this.stderr += c;
    });
    this.child.on("exit", (code, signal) => {
      for (const [, { reject }] of this.pending)
        reject(new Error(`server exited code=${code} signal=${signal}`));
      this.pending.clear();
    });
  }

  #onData(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id == null || !this.pending.has(msg.id)) continue;
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }

  request(method, params = {}, ms = 15000) {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, ms);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });
  }

  async close() {
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    if (!this.child.killed) this.child.kill("SIGTERM");
    await new Promise((r) => {
      if (this.child.exitCode != null) return r();
      this.child.once("exit", r);
      setTimeout(() => {
        this.child.kill("SIGKILL");
        r();
      }, 1500);
    });
  }
}

const client = new McpClient();
try {
  await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "electron-debug-mcp-doctor", version: "0.0.0" },
  });
  client.child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );
  const [tools, doctor, server] = await Promise.all([
    client.request("tools/list"),
    client.request("tools/call", { name: "doctor", arguments: {} }),
    client.request("resources/read", { uri: "electron://server" }),
  ]);
  const names = (tools?.tools ?? []).map((t) => t.name);
  console.log(
    JSON.stringify(
      {
        ok: true,
        toolCount: names.length,
        hasDoctor: names.includes("doctor"),
        doctor: parse((doctor?.content ?? []).find((c) => c.type === "text")?.text ?? ""),
        server: parse(server?.contents?.[0]?.text ?? ""),
      },
      null,
      2,
    ),
  );
  await client.close();
  process.exit(0);
} catch (err) {
  console.error(
    JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      stderr: client.stderr.slice(-2000),
    }),
  );
  await client.close();
  process.exit(1);
}
