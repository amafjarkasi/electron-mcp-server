import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { analyzeExtension } from "../bot/lib/pipeline.ts";

const fixtures = fileURLToPath(new URL("../fixtures", import.meta.url));

test("inventories the hello-world fixture without network", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "crx-re-hello-"));
  const result = await analyzeExtension({
    input: path.join(fixtures, "hello-world"),
    outDir: out,
  });
  assert.equal(result.format, "unpacked");
  assert.equal(result.architecture.manifestVersion, 3);
  assert.equal(result.architecture.popup, "hello.html");
  assert.equal(result.architecture.background, null);
  assert.ok(result.inventory.files.some((file) => file.path === "manifest.json"));
  assert.ok(result.architecture.capabilities.some((line) => /popup/i.test(line)));
});

test("maps reading-time content scripts and message passing", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "crx-re-read-"));
  const result = await analyzeExtension({
    input: path.join(fixtures, "reading-time"),
    outDir: out,
  });
  assert.equal(result.architecture.contentScripts[0]?.matches[0], "https://developer.chrome.com/*");
  assert.deepEqual(result.architecture.messagePassing, ["chrome.runtime.sendMessage"]);
});
