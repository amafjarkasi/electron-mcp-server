import assert from "node:assert/strict";
import { test } from "node:test";
import { stripCrx } from "../bot/lib/crx.ts";
import { extractExtensionId, resolveSource, storeDownloadUrl } from "../bot/lib/resolve.ts";

test("extracts store IDs from modern and legacy URLs", () => {
  const id = "jifpbeccnghkjeaalbbjmodiffmgedin";
  assert.equal(extractExtensionId(id), id);
  assert.equal(
    extractExtensionId(`https://chromewebstore.google.com/detail/crx-viewer/${id}`),
    id,
  );
  assert.equal(
    extractExtensionId(`https://chrome.google.com/webstore/detail/name/${id}?hl=en`),
    id,
  );
});

test("builds the store download URL", () => {
  const url = storeDownloadUrl("jifpbeccnghkjeaalbbjmodiffmgedin");
  assert.match(url, /clients2\.google\.com\/service\/update2\/crx/);
  assert.match(url, /acceptformat=crx2,crx3/);
  assert.match(url, /id%3Djifpbeccnghkjeaalbbjmodiffmgedin%26uc/);
});

test("resolves a local fixture directory", () => {
  const source = resolveSource(new URL("../fixtures/hello-world", import.meta.url).pathname);
  assert.equal(source.kind, "local-dir");
});

test("strips a CRX3 header to expose the zip", () => {
  const zip = Buffer.from("PK\u0003\u0004payload");
  const header = Buffer.alloc(12);
  header.write("Cr24", 0);
  header.writeUInt32LE(3, 4);
  header.writeUInt32LE(0, 8);
  const info = stripCrx(Buffer.concat([header, zip]));
  assert.equal(info.format, "crx3");
  assert.equal(info.zip.subarray(0, 2).toString(), "PK");
});

test("accepts a raw zip", () => {
  const info = stripCrx(Buffer.from("PK\u0003\u0004raw"));
  assert.equal(info.format, "zip");
});
