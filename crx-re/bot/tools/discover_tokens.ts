import { defineTool } from "@grok/agent-sdk/tools";
import * as z from "zod/v4";
import { discoverTokens } from "../lib/tokens.ts";

export default defineTool({
  description:
    "List agent-owned LLM provider keys that are present. Never returns secret values. Marks official OpenAI/Anthropic keys as ignored.",
  execution: "server",
  effect: "read",
  inputSchema: z.object({}),
  async execute() {
    return discoverTokens();
  },
});
