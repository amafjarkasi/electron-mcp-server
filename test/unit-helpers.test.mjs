#!/usr/bin/env node
/**
 * Unit tests for pure helpers in process-manager (no Electron GUI required).
 *
 * Covers: target role classification, allowlist enforcement, target pickers,
 * buffer capping/creation/clearing, port/inspect-port parsing from command
 * lines, console live-logging toggle, and process listing/getters.
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import {
  assertAppPathAllowed,
  clampClipToViewport,
  classifyTargetRole,
  clearProcessBuffers,
  classifyTargetRole as _classify, // re-import guard (unused, ensures module loads)
  createProcessRecord,
  getAllProcesses,
  getAllowedRoots,
  getElectronDebugInfo,
  getProcess,
  isConsoleLiveLoggingEnabled,
  listProcesses,
  listTargetsByRole,
  parseDebugPortFromCommand,
  parseInspectPortFromCommand,
  pickMainTarget,
  pickPageTarget,
  pickTargetByRole,
  pushCapped,
  setConsoleLiveLogging,
  validateOutputPath,
} from "../build/process-manager.js";

void _classify;

// --- Minimal factory for a fake ElectronProcess used across tests ---
function makeTargets(list) {
  return list.map((t) => ({
    id: t.id,
    type: t.type,
    title: t.title ?? "",
    url: t.url ?? "",
    webSocketDebuggerUrl: t.webSocketDebuggerUrl,
  }));
}

function makeProc(overrides = {}) {
  return createProcessRecord({
    id: overrides.id ?? "p1",
    name: overrides.name ?? "test",
    status: overrides.status ?? "running",
    attached: overrides.attached ?? false,
    pid: overrides.pid ?? 1234,
    debugPort: overrides.debugPort ?? 9222,
    startTime: overrides.startTime ?? new Date(0),
    appPath: overrides.appPath ?? "/tmp/app",
    targets: overrides.targets,
    logs: overrides.logs,
  });
}

// ===========================================================================
// classifyTargetRole
// ===========================================================================

test("classifyTargetRole maps known CDP types", () => {
  assert.equal(classifyTargetRole("page"), "page");
  assert.equal(classifyTargetRole("worker"), "worker");
  assert.equal(classifyTargetRole("service_worker"), "worker");
  assert.equal(classifyTargetRole("browser"), "browser");
});

test("classifyTargetRole collapses unknown types to 'other'", () => {
  assert.equal(classifyTargetRole("iframe"), "other");
  assert.equal(classifyTargetRole("node"), "other");
  assert.equal(classifyTargetRole("shared_worker"), "other");
  assert.equal(classifyTargetRole(""), "other");
  assert.equal(classifyTargetRole("whatever"), "other");
});

test("classifyTargetRole is case-sensitive (only lowercase CDP types match)", () => {
  // CDP always sends lowercase; uppercase should fall through to "other".
  assert.equal(classifyTargetRole("Page"), "other");
  assert.equal(classifyTargetRole("BROWSER"), "other");
});

// ===========================================================================
// getAllowedRoots
// ===========================================================================

test("getAllowedRoots returns [] when env unset", () => {
  const prev = process.env.ELECTRON_MCP_ALLOWED_ROOTS;
  delete process.env.ELECTRON_MCP_ALLOWED_ROOTS;
  try {
    assert.deepEqual(getAllowedRoots(), []);
  } finally {
    if (prev !== undefined) process.env.ELECTRON_MCP_ALLOWED_ROOTS = prev;
  }
});

test("getAllowedRoots returns [] when env is whitespace-only", () => {
  const prev = process.env.ELECTRON_MCP_ALLOWED_ROOTS;
  process.env.ELECTRON_MCP_ALLOWED_ROOTS = "   ";
  try {
    assert.deepEqual(getAllowedRoots(), []);
  } finally {
    if (prev === undefined) delete process.env.ELECTRON_MCP_ALLOWED_ROOTS;
    else process.env.ELECTRON_MCP_ALLOWED_ROOTS = prev;
  }
});

test("getAllowedRoots splits on both ';' and '|'", () => {
  const prev = process.env.ELECTRON_MCP_ALLOWED_ROOTS;
  process.env.ELECTRON_MCP_ALLOWED_ROOTS = `/tmp/a;/tmp/b|/tmp/c`;
  try {
    const roots = getAllowedRoots();
    assert.equal(roots.length, 3);
    assert.ok(roots.every((r) => path.isAbsolute(r)));
  } finally {
    if (prev === undefined) delete process.env.ELECTRON_MCP_ALLOWED_ROOTS;
    else process.env.ELECTRON_MCP_ALLOWED_ROOTS = prev;
  }
});

test("getAllowedRoots resolves to absolute + trims whitespace", () => {
  const prev = process.env.ELECTRON_MCP_ALLOWED_ROOTS;
  process.env.ELECTRON_MCP_ALLOWED_ROOTS = `  /tmp/x  `;
  try {
    const roots = getAllowedRoots();
    assert.equal(roots.length, 1);
    assert.equal(roots[0], path.resolve("/tmp/x"));
    assert.ok(path.isAbsolute(roots[0]));
  } finally {
    if (prev === undefined) delete process.env.ELECTRON_MCP_ALLOWED_ROOTS;
    else process.env.ELECTRON_MCP_ALLOWED_ROOTS = prev;
  }
});

// ===========================================================================
// assertAppPathAllowed
// ===========================================================================

test("assertAppPathAllowed is permissive when no roots configured", () => {
  const prev = process.env.ELECTRON_MCP_ALLOWED_ROOTS;
  delete process.env.ELECTRON_MCP_ALLOWED_ROOTS;
  try {
    // With no allowlist, anything resolves and is returned unchanged (resolved).
    assert.equal(
      assertAppPathAllowed("/anywhere/app"),
      path.resolve("/anywhere/app")
    );
  } finally {
    if (prev !== undefined) process.env.ELECTRON_MCP_ALLOWED_ROOTS = prev;
  }
});

test("assertAppPathAllowed accepts paths inside a configured root", () => {
  const prev = process.env.ELECTRON_MCP_ALLOWED_ROOTS;
  process.env.ELECTRON_MCP_ALLOWED_ROOTS = "/tmp/allowed-root";
  try {
    assert.equal(
      assertAppPathAllowed("/tmp/allowed-root/app"),
      path.resolve("/tmp/allowed-root/app")
    );
    // The root itself is allowed.
    assert.equal(
      assertAppPathAllowed("/tmp/allowed-root"),
      path.resolve("/tmp/allowed-root")
    );
  } finally {
    if (prev === undefined) delete process.env.ELECTRON_MCP_ALLOWED_ROOTS;
    else process.env.ELECTRON_MCP_ALLOWED_ROOTS = prev;
  }
});

test("assertAppPathAllowed rejects paths outside configured root", () => {
  const prev = process.env.ELECTRON_MCP_ALLOWED_ROOTS;
  process.env.ELECTRON_MCP_ALLOWED_ROOTS = "/tmp/allowed-root";
  try {
    assert.throws(
      () => assertAppPathAllowed("/tmp/other/app"),
      /outside ELECTRON_MCP_ALLOWED_ROOTS/
    );
  } finally {
    if (prev === undefined) delete process.env.ELECTRON_MCP_ALLOWED_ROOTS;
    else process.env.ELECTRON_MCP_ALLOWED_ROOTS = prev;
  }
});

test("assertAppPathAllowed rejects sibling-prefix attacks (not a real subdir)", () => {
  // "/tmp/allowed-root-evil" shares a string prefix with "/tmp/allowed-root"
  // but must NOT be considered inside it.
  const prev = process.env.ELECTRON_MCP_ALLOWED_ROOTS;
  process.env.ELECTRON_MCP_ALLOWED_ROOTS = "/tmp/allowed-root";
  try {
    assert.throws(
      () => assertAppPathAllowed("/tmp/allowed-root-evil/app"),
      /outside ELECTRON_MCP_ALLOWED_ROOTS/
    );
  } finally {
    if (prev === undefined) delete process.env.ELECTRON_MCP_ALLOWED_ROOTS;
    else process.env.ELECTRON_MCP_ALLOWED_ROOTS = prev;
  }
});

// ===========================================================================
// pushCapped
// ===========================================================================

test("pushCapped appends while under the cap", () => {
  const arr = [1, 2];
  pushCapped(arr, 3, 10);
  assert.deepEqual(arr, [1, 2, 3]);
});

test("pushCapped evicts oldest entries once cap exceeded", () => {
  const arr = [1, 2, 3];
  pushCapped(arr, 4, 3); // would be length 4 → trim to 3, drop first
  assert.deepEqual(arr, [2, 3, 4]);
});

test("pushCapped maintains exactly max items under sustained push", () => {
  const arr = [];
  const max = 3;
  for (let i = 0; i < 100; i++) pushCapped(arr, i, max);
  assert.equal(arr.length, max);
  assert.deepEqual(arr, [97, 98, 99]);
});

test("pushCapped with max=1 keeps only the latest", () => {
  const arr = [];
  pushCapped(arr, "a", 1);
  pushCapped(arr, "b", 1);
  assert.deepEqual(arr, ["b"]);
});

test("pushCapped works on empty array (first insert at cap boundary)", () => {
  const arr = [];
  pushCapped(arr, "x", 0);
  // length(1) > 0 → splice all but last 0 → empty
  assert.equal(arr.length, 0);
});

// ===========================================================================
// createProcessRecord
// ===========================================================================

test("createProcessRecord seeds empty buffers and a monitorClients map", () => {
  const proc = makeProc();
  assert.deepEqual(proc.consoleMessages, []);
  assert.deepEqual(proc.networkEntries, []);
  assert.deepEqual(proc.logs, []);
  assert.ok(proc.monitorClients instanceof Map);
  assert.equal(proc.monitorClients.size, 0);
});

test("createProcessRecord preserves caller-supplied fields", () => {
  const proc = makeProc({ id: "xyz", name: "myapp", debugPort: 9999 });
  assert.equal(proc.id, "xyz");
  assert.equal(proc.name, "myapp");
  assert.equal(proc.debugPort, 9999);
});

test("createProcessRecord accepts provided logs", () => {
  const proc = makeProc({ logs: ["line1", "line2"] });
  assert.deepEqual(proc.logs, ["line1", "line2"]);
});

test("createProcessRecord does not share buffer references between instances", () => {
  const a = makeProc({ id: "a" });
  const b = makeProc({ id: "b" });
  a.consoleMessages.push({ timestamp: "", targetId: "", level: "", text: "", source: "console" });
  a.logs.push("shared?");
  assert.equal(b.consoleMessages.length, 0);
  assert.equal(b.logs.length, 0);
});

// ===========================================================================
// parseDebugPortFromCommand
// ===========================================================================

test("parseDebugPortFromCommand parses --remote-debugging-port=PORT", () => {
  assert.equal(
    parseDebugPortFromCommand("/usr/bin/electron --remote-debugging-port=9222 ./app"),
    9222
  );
});

test("parseDebugPortFromCommand parses space-separated form", () => {
  assert.equal(
    parseDebugPortFromCommand("electron --remote-debugging-port 9333 app"),
    9333
  );
});

test("parseDebugPortFromCommand is case-insensitive", () => {
  assert.equal(
    parseDebugPortFromCommand("electron --REMOTE-DEBUGGING-PORT=9229"),
    9229
  );
});

test("parseDebugPortFromCommand returns undefined when absent", () => {
  assert.equal(parseDebugPortFromCommand("electron app"), undefined);
  assert.equal(parseDebugPortFromCommand(""), undefined);
});

test("parseDebugPortFromCommand returns undefined when no port digits follow", () => {
  // Regex requires digits after the separator; a non-numeric value yields no match.
  assert.equal(
    parseDebugPortFromCommand("electron --remote-debugging-port=abc"),
    undefined
  );
  assert.equal(
    parseDebugPortFromCommand("electron --remote-debugging-port"),
    undefined
  );
});

// ===========================================================================
// parseInspectPortFromCommand
// ===========================================================================

test("parseInspectPortFromCommand parses --inspect=PORT", () => {
  assert.equal(
    parseInspectPortFromCommand("electron --inspect=9229 app"),
    9229
  );
});

test("parseInspectPortFromCommand parses space-separated form", () => {
  assert.equal(
    parseInspectPortFromCommand("electron --inspect 9230 app"),
    9230
  );
});

test("parseInspectPortFromCommand is case-insensitive", () => {
  assert.equal(
    parseInspectPortFromCommand("electron --INSPECT=9231"),
    9231
  );
});

test("parseInspectPortFromCommand returns undefined when absent", () => {
  assert.equal(parseInspectPortFromCommand("electron app"), undefined);
  assert.equal(parseInspectPortFromCommand(""), undefined);
});

test("parseInspectPortFromCommand rejects port 0", () => {
  assert.equal(parseInspectPortFromCommand("electron --inspect=0"), undefined);
});

// ===========================================================================
// pickPageTarget
// ===========================================================================

test("pickPageTarget throws when process has no targets", () => {
  const proc = makeProc({ targets: undefined });
  assert.throws(() => pickPageTarget(proc), /No CDP targets available/);
});

test("pickPageTarget prefers page targets", () => {
  const proc = makeProc({
    targets: makeTargets([
      { id: "b", type: "browser", title: "browser", url: "" },
      { id: "p", type: "page", title: "Page", url: "file://x" },
    ]),
  });
  assert.equal(pickPageTarget(proc).id, "p");
});

test("pickPageTarget falls back to webSocketDebuggerUrl then first target", () => {
  const proc = makeProc({
    targets: makeTargets([
      { id: "first", type: "browser" },
      { id: "ws", type: "other", webSocketDebuggerUrl: "ws://x" },
    ]),
  });
  assert.equal(pickPageTarget(proc).id, "ws");
});

test("pickPageTarget falls back to first target if nothing else matches", () => {
  const proc = makeProc({
    targets: makeTargets([{ id: "only", type: "browser" }]),
  });
  assert.equal(pickPageTarget(proc).id, "only");
});

test("pickPageTarget honors explicit targetId when it exists", () => {
  const proc = makeProc({
    targets: makeTargets([
      { id: "b", type: "browser" },
      { id: "p", type: "page" },
    ]),
  });
  assert.equal(pickPageTarget(proc, "b").id, "b");
});

test("pickPageTarget throws when explicit targetId is missing", () => {
  const proc = makeProc({
    targets: makeTargets([{ id: "p", type: "page" }]),
  });
  assert.throws(() => pickPageTarget(proc, "missing"), /not found/);
});

test("pickPageTarget respects preferredRole when no page present", () => {
  const proc = makeProc({
    targets: makeTargets([
      { id: "sw", type: "service_worker" },
      { id: "br", type: "browser" },
    ]),
  });
  assert.equal(pickPageTarget(proc, undefined, "worker").id, "sw");
  assert.equal(pickPageTarget(proc, undefined, "browser").id, "br");
});

test("pickPageTarget preferredRole='any' skips role matching", () => {
  const proc = makeProc({
    targets: makeTargets([
      { id: "sw", type: "service_worker" },
      { id: "ws", type: "other", webSocketDebuggerUrl: "ws://x" },
    ]),
  });
  // No page; 'any' → falls through to webSocketDebuggerUrl target.
  assert.equal(pickPageTarget(proc, undefined, "any").id, "ws");
});

// ===========================================================================
// pickTargetByRole
// ===========================================================================

test("pickTargetByRole returns the first target matching the role", () => {
  const proc = makeProc({
    targets: makeTargets([
      { id: "p", type: "page" },
      { id: "sw", type: "service_worker" },
    ]),
  });
  assert.equal(pickTargetByRole(proc, "worker").id, "sw");
  assert.equal(pickTargetByRole(proc, "page").id, "p");
});

test("pickTargetByRole throws when no target of that role exists", () => {
  const proc = makeProc({
    targets: makeTargets([{ id: "p", type: "page" }]),
  });
  assert.throws(() => pickTargetByRole(proc, "browser"), /No browser target/);
});

test("pickTargetByRole delegates to pickPageTarget when targetId given", () => {
  const proc = makeProc({
    targets: makeTargets([
      { id: "p", type: "page" },
      { id: "br", type: "browser" },
    ]),
  });
  // targetId wins regardless of requested role.
  assert.equal(pickTargetByRole(proc, "browser", "p").id, "p");
  assert.throws(
    () => pickTargetByRole(proc, "page", "nope"),
    /not found/
  );
});

test("pickTargetByRole handles empty targets gracefully", () => {
  const proc = makeProc({ targets: [] });
  assert.throws(() => pickTargetByRole(proc, "page"), /No page target/);
});

// ===========================================================================
// pickMainTarget
// ===========================================================================

test("pickMainTarget prefers a 'node' target", () => {
  const proc = makeProc({
    targets: makeTargets([
      { id: "p", type: "page" },
      { id: "n", type: "node" },
    ]),
  });
  assert.equal(pickMainTarget(proc).id, "n");
});

test("pickMainTarget picks electron-like service_worker", () => {
  const proc = makeProc({
    targets: makeTargets([
      { id: "p", type: "page" },
      { id: "sw", type: "service_worker", title: "Electron Main", url: "" },
    ]),
  });
  assert.equal(pickMainTarget(proc).id, "sw");
});

test("pickMainTarget throws when no node-like target exists", () => {
  const proc = makeProc({
    targets: makeTargets([{ id: "p", type: "page" }]),
  });
  assert.throws(() => pickMainTarget(proc), /No main\/node target/);
});

test("pickMainTarget throws when process has no targets", () => {
  const proc = makeProc({ targets: undefined });
  assert.throws(() => pickMainTarget(proc), /No CDP targets available/);
});

test("pickMainTarget honors explicit targetId", () => {
  const proc = makeProc({
    targets: makeTargets([
      { id: "p", type: "page" },
      { id: "n", type: "node" },
    ]),
  });
  // Explicit id bypasses the node heuristic.
  assert.equal(pickMainTarget(proc, "p").id, "p");
});

// ===========================================================================
// listTargetsByRole
// ===========================================================================

test("listTargetsByRole maps each target to its role", () => {
  const proc = makeProc({
    targets: makeTargets([
      { id: "p", type: "page", title: "P", url: "file://p" },
      { id: "sw", type: "service_worker", title: "SW", url: "" },
      { id: "br", type: "browser", title: "BR", url: "" },
      { id: "if", type: "iframe", title: "IF", url: "" },
    ]),
  });
  const list = listTargetsByRole(proc);
  assert.equal(list.length, 4);
  assert.deepEqual(
    list.map((t) => t.role),
    ["page", "worker", "browser", "other"]
  );
});

test("listTargetsByRole flags node/browser/electron-ish targets as likelyMain", () => {
  const proc = makeProc({
    targets: makeTargets([
      { id: "p", type: "page", title: "Page", url: "" },
      { id: "n", type: "node", title: "n", url: "" },
      { id: "br", type: "browser", title: "br", url: "" },
      { id: "e", type: "other", title: "Electron main", url: "" },
    ]),
  });
  const list = listTargetsByRole(proc);
  const byId = Object.fromEntries(list.map((t) => [t.id, t.likelyMain]));
  assert.equal(byId.p, false);
  assert.equal(byId.n, true);
  assert.equal(byId.br, true);
  assert.equal(byId.e, true);
});

test("listTargetsByRole returns [] for process with no targets", () => {
  const proc = makeProc({ targets: undefined });
  assert.deepEqual(listTargetsByRole(proc), []);
});

// ===========================================================================
// clearProcessBuffers
// ===========================================================================

test("clearProcessBuffers clears all buffers by default", () => {
  const proc = makeProc();
  proc.consoleMessages.push({ timestamp: "", targetId: "", level: "", text: "", source: "console" });
  proc.networkEntries.push({ timestamp: "", targetId: "", requestId: "", event: "request" });
  proc.logs.push("a log line");
  const { cleared } = clearProcessBuffers(proc);
  assert.deepEqual(cleared.sort(), ["console", "logs", "network"]);
  assert.equal(proc.consoleMessages.length, 0);
  assert.equal(proc.networkEntries.length, 0);
  assert.equal(proc.logs.length, 0);
});

test("clearProcessBuffers clears only the requested buffers", () => {
  const proc = makeProc();
  proc.consoleMessages.push({ timestamp: "", targetId: "", level: "", text: "", source: "console" });
  proc.networkEntries.push({ timestamp: "", targetId: "", requestId: "", event: "request" });
  proc.logs.push("keep me");
  const { cleared } = clearProcessBuffers(proc, ["console"]);
  assert.deepEqual(cleared, ["console"]);
  assert.equal(proc.consoleMessages.length, 0);
  assert.equal(proc.networkEntries.length, 1); // untouched
  assert.deepEqual(proc.logs, ["keep me"]); // untouched
});

test("clearProcessBuffers with empty list clears nothing", () => {
  const proc = makeProc();
  proc.logs.push("stay");
  const { cleared } = clearProcessBuffers(proc, []);
  assert.deepEqual(cleared, []);
  assert.deepEqual(proc.logs, ["stay"]);
});

// ===========================================================================
// setConsoleLiveLogging / isConsoleLiveLoggingEnabled
// ===========================================================================

test("setConsoleLiveLogging toggles and reports the flag", () => {
  const before = isConsoleLiveLoggingEnabled();
  try {
    assert.equal(setConsoleLiveLogging(true), true);
    assert.equal(isConsoleLiveLoggingEnabled(), true);
    assert.equal(setConsoleLiveLogging(false), false);
    assert.equal(isConsoleLiveLoggingEnabled(), false);
  } finally {
    setConsoleLiveLogging(before);
  }
});

// ===========================================================================
// Process registry: getProcess / getAllProcesses / listProcesses
// ===========================================================================

test("getProcess returns undefined for unknown id", () => {
  assert.equal(getProcess("definitely-not-present"), undefined);
});

test("getAllProcesses returns a Map", () => {
  const all = getAllProcesses();
  assert.ok(all instanceof Map);
});

test("listProcesses returns an array of summary objects", () => {
  const list = listProcesses();
  assert.ok(Array.isArray(list));
  // Each entry, if present, has the documented summary shape.
  if (list.length > 0) {
    const entry = list[0];
    for (const key of [
      "id",
      "name",
      "status",
      "attached",
      "startTime",
      "appPath",
      "targetCount",
      "consoleCount",
      "networkCount",
    ]) {
      assert.ok(key in entry, `listProcesses entry missing ${key}`);
    }
  }
});

// ===========================================================================
// validateOutputPath
// ===========================================================================
// Blocks tool output (screenshots, traces) from landing in sensitive system
// locations. Blocklist is platform-specific; tests run on the host platform.

const isWin = process.platform === "win32";
const setEnv = (val) => {
  const prev = process.env.ELECTRON_MCP_OUTPUT_ROOTS;
  if (val === undefined) delete process.env.ELECTRON_MCP_OUTPUT_ROOTS;
  else process.env.ELECTRON_MCP_OUTPUT_ROOTS = val;
  return prev;
};
const restoreEnv = (prev) => {
  if (prev === undefined) delete process.env.ELECTRON_MCP_OUTPUT_ROOTS;
  else process.env.ELECTRON_MCP_OUTPUT_ROOTS = prev;
};

test("validateOutputPath resolves and returns ordinary paths", () => {
  const prev = setEnv(undefined);
  try {
    const p = isWin ? "C:\\tmp\\shot.png" : "/tmp/shot.png";
    assert.equal(validateOutputPath(p), path.resolve(p));
  } finally {
    restoreEnv(prev);
  }
});

test("validateOutputPath rejects system/sensitive locations", () => {
  const prev = setEnv(undefined);
  try {
    const blocked = isWin
      ? [
          "C:\\Windows\\System32\\evil.png",
          "C:\\Program Files\\x.png",
          "C:\\ProgramData\\y.json",
        ]
      : ["/etc/passwd.png", "/proc/self/x", "/usr/share/y.json", "/boot/evil"];
    for (const p of blocked) {
      assert.throws(
        () => validateOutputPath(p),
        /sensitive location/i,
        `expected ${p} to be blocked`
      );
    }
  } finally {
    restoreEnv(prev);
  }
});

test("validateOutputPath blocks the home .ssh directory", () => {
  const prev = setEnv(undefined);
  try {
    const sshPath = path.join(os.homedir(), ".ssh", "authorized_keys");
    assert.throws(
      () => validateOutputPath(sshPath),
      /sensitive location/i
    );
  } finally {
    restoreEnv(prev);
  }
});

test("validateOutputPath respects ELECTRON_MCP_OUTPUT_ROOTS allowlist", () => {
  const prev = setEnv(isWin ? "C:\\tmp\\out;C:\\tmp\\traces" : "/tmp/out|/tmp/traces");
  try {
    // Inside a listed root → allowed.
    assert.ok(
      validateOutputPath(isWin ? "C:\\tmp\\out\\a.png" : "/tmp/out/a.png")
        .length > 0
    );
    // The root itself is allowed.
    assert.ok(
      validateOutputPath(isWin ? "C:\\tmp\\out" : "/tmp/out").length > 0
    );
    // Outside all roots → rejected.
    assert.throws(
      () => validateOutputPath(isWin ? "C:\\other\\b.png" : "/other/b.png"),
      /outside ELECTRON_MCP_OUTPUT_ROOTS/i
    );
  } finally {
    restoreEnv(prev);
  }
});

test("validateOutputPath allowlist still blocks sensitive locations even when inside a root", () => {
  // Defense in depth: even if a root is configured, a blocked location is refused.
  const prev = setEnv(isWin ? "C:\\" : "/");
  try {
    const blocked = isWin ? "C:\\Windows\\x.png" : "/etc/x.png";
    assert.throws(
      () => validateOutputPath(blocked),
      /sensitive location/i
    );
  } finally {
    restoreEnv(prev);
  }
});

test("validateOutputPath treats sibling-prefix attacks as outside the root", () => {
  // /tmp/out-evil shares a string prefix with /tmp/out but is NOT inside it.
  const prev = setEnv(isWin ? "C:\\tmp\\out" : "/tmp/out");
  try {
    const evil = isWin ? "C:\\tmp\\out-evil\\x.png" : "/tmp/out-evil/x.png";
    assert.throws(
      () => validateOutputPath(evil),
      /outside ELECTRON_MCP_OUTPUT_ROOTS/i
    );
  } finally {
    restoreEnv(prev);
  }
});

test("validateOutputPath splits allowlist on both ';' and '|'", () => {
  const prev = setEnv(isWin ? "C:\\tmp\\a;C:\\tmp\\b" : "/tmp/a;/tmp/b");
  try {
    assert.ok(validateOutputPath(isWin ? "C:\\tmp\\a\\1" : "/tmp/a/1").length > 0);
    assert.ok(validateOutputPath(isWin ? "C:\\tmp\\b\\2" : "/tmp/b/2").length > 0);
  } finally {
    restoreEnv(prev);
  }
});

// ===========================================================================
// getElectronDebugInfo
// ===========================================================================
// Builds a debug summary (target role counts, webContents list, recent
// console errors) from a process record. Pure once the process exists in
// the registry -- we insert via getAllProcesses() and use a stopped/no-port
// process so updateCDPTargets (network) is skipped.

test("getElectronDebugInfo returns null for an unknown id", async () => {
  const info = await getElectronDebugInfo("definitely-not-present");
  assert.equal(info, null);
});

test("getElectronDebugInfo counts targets by role in targetSummary", async () => {
  const proc = makeProc({
    id: "info-roles",
    status: "stopped", // no debugPort call path -> stays pure
    debugPort: undefined,
    targets: makeTargets([
      { id: "p1", type: "page" },
      { id: "p2", type: "page" },
      { id: "sw", type: "service_worker" }, // -> worker
      { id: "br", type: "browser" },
      { id: "if", type: "iframe" }, // -> other
    ]),
  });
  getAllProcesses().set(proc.id, proc);
  try {
    const info = await getElectronDebugInfo(proc.id);
    assert.deepEqual(info.targetSummary, {
      pages: 2,
      workers: 1,
      browser: 1,
      other: 1,
    });
  } finally {
    getAllProcesses().delete(proc.id);
  }
});

test("getElectronDebugInfo maps webContents with debuggable flag from ws url", async () => {
  const proc = makeProc({
    id: "info-debuggable",
    status: "stopped",
    debugPort: undefined,
    targets: makeTargets([
      { id: "a", type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:9/page/a" },
      { id: "b", type: "page" }, // no ws url -> not debuggable
    ]),
  });
  getAllProcesses().set(proc.id, proc);
  try {
    const info = await getElectronDebugInfo(proc.id);
    assert.equal(info.webContents.length, 2);
    assert.equal(info.webContents[0].debuggable, true);
    assert.equal(info.webContents[1].debuggable, false);
    // webContents ids are 1-based positional.
    assert.deepEqual(
      info.webContents.map((w) => w.id),
      [1, 2]
    );
    assert.equal(info.webContents[0].targetId, "a");
  } finally {
    getAllProcesses().delete(proc.id);
  }
});

test("getElectronDebugInfo filters recentConsoleErrors to errors/exceptions only", async () => {
  const proc = makeProc({ id: "info-errors", status: "stopped", debugPort: undefined });
  proc.consoleMessages.push(
    { timestamp: "1", targetId: "t", level: "log", text: "fine", source: "log" },
    { timestamp: "2", targetId: "t", level: "error", text: "boom", source: "console" },
    { timestamp: "3", targetId: "t", level: "warning", text: "hmm", source: "log" },
    { timestamp: "4", targetId: "t", level: "info", text: "oops", source: "exception" }
  );
  getAllProcesses().set(proc.id, proc);
  try {
    const info = await getElectronDebugInfo(proc.id);
    // Only the error-level and exception-source messages survive.
    assert.equal(info.recentConsoleErrors.length, 2);
    assert.deepEqual(
      info.recentConsoleErrors.map((m) => m.text),
      ["boom", "oops"]
    );
  } finally {
    getAllProcesses().delete(proc.id);
  }
});

test("getElectronDebugInfo caps recentConsoleErrors at the last 10", async () => {
  const proc = makeProc({ id: "info-cap", status: "stopped", debugPort: undefined });
  for (let i = 0; i < 15; i++) {
    proc.consoleMessages.push({
      timestamp: String(i),
      targetId: "t",
      level: "error",
      text: `err-${i}`,
      source: "console",
    });
  }
  getAllProcesses().set(proc.id, proc);
  try {
    const info = await getElectronDebugInfo(proc.id);
    assert.equal(info.recentConsoleErrors.length, 10);
    // slice(-10) keeps the most recent.
    assert.equal(info.recentConsoleErrors[0].text, "err-5");
    assert.equal(info.recentConsoleErrors[9].text, "err-14");
  } finally {
    getAllProcesses().delete(proc.id);
  }
});

test("getElectronDebugInfo handles a process with no targets", async () => {
  const proc = makeProc({
    id: "info-notargets",
    status: "stopped",
    debugPort: undefined,
    targets: undefined,
  });
  getAllProcesses().set(proc.id, proc);
  try {
    const info = await getElectronDebugInfo(proc.id);
    assert.deepEqual(info.targetSummary, {
      pages: 0,
      workers: 0,
      browser: 0,
      other: 0,
    });
    assert.deepEqual(info.webContents, []);
  } finally {
    getAllProcesses().delete(proc.id);
  }
});

test("getElectronDebugInfo echoes process identity fields", async () => {
  const proc = makeProc({
    id: "info-id",
    name: "my-electron-app",
    status: "stopped",
    debugPort: undefined,
    pid: 4242,
    appPath: "/tmp/myapp",
  });
  getAllProcesses().set(proc.id, proc);
  try {
    const info = await getElectronDebugInfo(proc.id);
    assert.equal(info.id, "info-id");
    assert.equal(info.name, "my-electron-app");
    assert.equal(info.status, "stopped");
    assert.equal(info.pid, 4242);
    assert.equal(info.appPath, "/tmp/myapp");
  } finally {
    getAllProcesses().delete(proc.id);
  }
});

// ===========================================================================
// clampClipToViewport
// ===========================================================================

const VIEWPORT = { viewportWidth: 1900, viewportHeight: 1000 };

test("clampClipToViewport passes a fully visible element through untouched", () => {
  const clip = clampClipToViewport({
    x: 100,
    y: 200,
    width: 400,
    height: 300,
    ...VIEWPORT,
  });
  assert.deepEqual(clip, {
    x: 100,
    y: 200,
    width: 400,
    height: 300,
    truncated: false,
  });
});

test("clampClipToViewport cuts an element wider than the window", () => {
  // A horizontally scrolling table: the thead's box is its full scroll width.
  // Passed through unclamped, the capture comes back as the whole window.
  const clip = clampClipToViewport({
    x: 385,
    y: 94,
    width: 3057,
    height: 37,
    ...VIEWPORT,
  });
  assert.equal(clip.x, 385);
  assert.equal(clip.width, 1900 - 385);
  assert.equal(clip.height, 37);
  assert.equal(clip.truncated, true);
});

test("clampClipToViewport returns null for an element entirely off-screen", () => {
  // The exact rect a selector capture produced in practice: the element was
  // 1,714px above the viewport, and the capture came back as a full-window
  // image rather than reporting that the clip could not be honoured.
  assert.equal(
    clampClipToViewport({
      x: 385,
      y: -1714,
      width: 917,
      height: 384,
      ...VIEWPORT,
    }),
    null
  );
  assert.equal(
    clampClipToViewport({ x: 2100, y: 10, width: 100, height: 100, ...VIEWPORT }),
    null
  );
});

test("clampClipToViewport keeps the visible part of a partly scrolled element", () => {
  const clip = clampClipToViewport({
    x: 10,
    y: -50,
    width: 200,
    height: 300,
    ...VIEWPORT,
  });
  assert.deepEqual(clip, {
    x: 10,
    y: 0,
    width: 200,
    height: 250,
    truncated: true,
  });
});

test("clampClipToViewport leaves a fractional rect inside the viewport alone", () => {
  // Fractional geometry is the norm, not an edge case. A box that fits must
  // come back byte-identical, with no truncation reported.
  const box = { x: 384.7548828125, y: 58.046939849853516, width: 916.9063110351562, height: 383.994140625 };
  const clip = clampClipToViewport({ ...box, ...VIEWPORT });
  assert.deepEqual(clip, { ...box, truncated: false });
});

test("clampClipToViewport reports a sub-pixel crop rather than rounding it away", () => {
  // A whole CSS pixel of tolerance would call each of these complete. They
  // are not: part of the element is genuinely outside the capture.
  const left = clampClipToViewport({ x: -0.5, y: 10, width: 200, height: 100, ...VIEWPORT });
  assert.equal(left.x, 0);
  assert.equal(left.width, 199.5);
  assert.equal(left.truncated, true);

  const right = clampClipToViewport({ x: 0, y: 0, width: 1900.4, height: 999.6, ...VIEWPORT });
  assert.equal(right.width, 1900);
  assert.equal(right.truncated, true);

  const top = clampClipToViewport({ x: 10, y: -0.25, width: 100, height: 50, ...VIEWPORT });
  assert.equal(top.y, 0);
  assert.equal(top.truncated, true);
});
