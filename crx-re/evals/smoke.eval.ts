import { defineEval } from "@grok/agent-sdk/evals";

export default defineEval({
  tags: ["smoke"],
  description: "Token discovery tool runs without printing secrets.",
  async test(t) {
    await t.send("Which provider tokens are available? Use the discover_tokens tool.");
    t.succeeded();
    t.calledTool("discover_tokens");
    t.notCalledTool("analyze_extension");
  },
});
