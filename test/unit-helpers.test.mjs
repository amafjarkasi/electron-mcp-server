#!/usr/bin/env node
/**
 * Unit tests for pure helpers (no Electron GUI required).
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import {
  assertAppPathAllowed,
  classifyTargetRole,
  getAllowedRoots,
  pickPageTarget,
} from "../build/process-manager.js";

test("classifyTargetRole maps CDP types", () => {
  assert.equal(classifyTargetRole("page"), "page");
  assert.equal(classifyTargetRole("worker"), "worker");
  assert.equal(classifyTargetRole("service_worker"), "worker");
  assert.equal(classifyTargetRole("browser"), "browser");
  assert.equal(classifyTargetRole("iframe"), "other");
});

test("getAllowedRoots parses ELECTRON_MCP_ALLOWED_ROOTS", () => {
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

test("assertAppPathAllowed enforces allowlist", () => {
  const prev = process.env.ELECTRON_MCP_ALLOWED_ROOTS;
  process.env.ELECTRON_MCP_ALLOWED_ROOTS = "/tmp/allowed-root";
  try {
    const ok = assertAppPathAllowed("/tmp/allowed-root/app");
    assert.equal(ok, path.resolve("/tmp/allowed-root/app"));
    assert.throws(
      () => assertAppPathAllowed("/tmp/other/app"),
      /outside ELECTRON_MCP_ALLOWED_ROOTS/
    );
  } finally {
    if (prev === undefined) delete process.env.ELECTRON_MCP_ALLOWED_ROOTS;
    else process.env.ELECTRON_MCP_ALLOWED_ROOTS = prev;
  }
});

test("pickPageTarget prefers page targets", () => {
  const proc = {
    id: "p1",
    targets: [
      { id: "b", type: "browser", title: "browser", url: "" },
      { id: "p", type: "page", title: "Page", url: "file://x" },
    ],
  };
  const target = pickPageTarget(proc);
  assert.equal(target.id, "p");
  assert.equal(pickPageTarget(proc, "b").id, "b");
  assert.throws(() => pickPageTarget(proc, "missing"), /not found/);
});
