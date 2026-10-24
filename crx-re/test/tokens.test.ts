import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverTokens } from "../bot/lib/tokens.ts";

test("selects MiMo token plan first and never echoes secrets", () => {
  const result = discoverTokens({
    MIMO_API_KEY: "tp-secret-value",
    DEEPSEEK_API_KEY: "ds-secret",
    OPENAI_API_KEY: "sk-openai",
    ANTHROPIC_API_KEY: "sk-ant",
  });
  assert.equal(result.selected?.provider, "mimo");
  assert.equal(result.selected?.plan, "token");
  assert.equal(result.selected?.role, "reconstruct");
  const dumped = JSON.stringify(result);
  assert.equal(dumped.includes("secret-value"), false);
  assert.equal(dumped.includes("sk-openai"), false);
  assert.equal(dumped.includes("sk-ant"), false);
  assert.equal(result.tokens.find((row) => row.envName === "OPENAI_API_KEY")?.role, "ignored");
  assert.equal(result.tokens.find((row) => row.envName === "ANTHROPIC_API_KEY")?.role, "ignored");
});

test("treats OpenAI-compat host rewrite as preferred", () => {
  const result = discoverTokens({
    OPENAI_API_KEY: "tp-from-mimo",
    OPENAI_BASE_URL: "https://token-plan-cn.xiaomimimo.com/v1",
  });
  assert.equal(result.selected?.provider, "mimo");
  assert.equal(result.selected?.role, "reconstruct");
});

test("Cursor keys are harness only", () => {
  const result = discoverTokens({ CURSOR_API_KEY: "cursor-secret" });
  assert.equal(result.selected, null);
  assert.equal(result.tokens[0]?.role, "harness");
  assert.equal(JSON.stringify(result).includes("cursor-secret"), false);
});
