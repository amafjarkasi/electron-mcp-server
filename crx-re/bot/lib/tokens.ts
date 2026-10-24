export type TokenRole = "reconstruct" | "harness" | "ignored";

export type TokenRecord = {
  provider: string;
  envName: string;
  present: true;
  role: TokenRole;
  plan?: "token" | "paygo" | "unknown";
};

export type TokenDiscovery = {
  selected: TokenRecord | null;
  tokens: TokenRecord[];
};

const PREFERRED_HOST_MARKERS = [
  "xiaomimimo.com",
  "api.deepseek.com",
  "api.z.ai",
  "api.minimax.io",
  "api.minimax.cn",
];

const OFFICIAL_BLOCKED_HOSTS = ["api.openai.com", "api.anthropic.com"];

function present(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0;
}

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isPreferredHost(url: string | undefined): boolean {
  const host = hostOf(url);
  return PREFERRED_HOST_MARKERS.some((marker) => host === marker || host.endsWith(`.${marker}`));
}

function isOfficialBlockedHost(url: string | undefined): boolean {
  if (!url) return true;
  const host = hostOf(url);
  return OFFICIAL_BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

function mimoPlan(env: NodeJS.ProcessEnv): "token" | "paygo" | "unknown" {
  const key = env.MIMO_API_KEY?.trim() ?? "";
  if (/^t?tp-/i.test(key)) return "token";
  if (/^sk-/i.test(key)) return "paygo";
  return "unknown";
}

function providerForPreferredUrl(url: string | undefined): string | null {
  const host = hostOf(url);
  if (host.includes("xiaomimimo.com")) return "mimo";
  if (host.includes("deepseek.com")) return "deepseek";
  if (host.includes("z.ai")) return "zai";
  if (host.includes("minimax.")) return "minimax";
  return null;
}

/**
 * Discover agent-owned provider credentials. Never returns secret values.
 */
export function discoverTokens(env: NodeJS.ProcessEnv = process.env): TokenDiscovery {
  const tokens: TokenRecord[] = [];

  if (present(env, "MIMO_API_KEY")) {
    tokens.push({
      provider: "mimo",
      envName: "MIMO_API_KEY",
      present: true,
      role: "reconstruct",
      plan: mimoPlan(env),
    });
  }
  if (present(env, "DEEPSEEK_API_KEY")) {
    tokens.push({
      provider: "deepseek",
      envName: "DEEPSEEK_API_KEY",
      present: true,
      role: "reconstruct",
    });
  }
  if (present(env, "ZAI_API_KEY")) {
    tokens.push({
      provider: "zai",
      envName: "ZAI_API_KEY",
      present: true,
      role: "reconstruct",
    });
  }
  if (present(env, "ZHIPU_API_KEY")) {
    tokens.push({
      provider: "zhipu",
      envName: "ZHIPU_API_KEY",
      present: true,
      role: "reconstruct",
    });
  }
  if (present(env, "MINIMAX_API_KEY")) {
    tokens.push({
      provider: "minimax",
      envName: "MINIMAX_API_KEY",
      present: true,
      role: "reconstruct",
    });
  }
  if (present(env, "MOONSHOT_API_KEY")) {
    tokens.push({
      provider: "moonshot",
      envName: "MOONSHOT_API_KEY",
      present: true,
      role: "reconstruct",
    });
  }
  if (present(env, "KIMI_API_KEY")) {
    tokens.push({
      provider: "kimi",
      envName: "KIMI_API_KEY",
      present: true,
      role: "reconstruct",
    });
  }
  if (present(env, "DASHSCOPE_API_KEY")) {
    tokens.push({
      provider: "qwen",
      envName: "DASHSCOPE_API_KEY",
      present: true,
      role: "reconstruct",
    });
  }

  const openaiUrl = env.OPENAI_BASE_URL;
  if (present(env, "OPENAI_API_KEY")) {
    if (isPreferredHost(openaiUrl)) {
      tokens.push({
        provider: providerForPreferredUrl(openaiUrl) ?? "preferred-openai-compat",
        envName: "OPENAI_API_KEY",
        present: true,
        role: "reconstruct",
      });
    } else {
      tokens.push({
        provider: "openai",
        envName: "OPENAI_API_KEY",
        present: true,
        role: "ignored",
      });
    }
  }

  const anthropicUrl = env.ANTHROPIC_BASE_URL;
  if (present(env, "ANTHROPIC_API_KEY") || present(env, "ANTHROPIC_AUTH_TOKEN")) {
    const envName = present(env, "ANTHROPIC_API_KEY")
      ? "ANTHROPIC_API_KEY"
      : "ANTHROPIC_AUTH_TOKEN";
    if (isPreferredHost(anthropicUrl) && !isOfficialBlockedHost(anthropicUrl)) {
      tokens.push({
        provider: providerForPreferredUrl(anthropicUrl) ?? "preferred-anthropic-compat",
        envName,
        present: true,
        role: "reconstruct",
      });
    } else {
      tokens.push({
        provider: "anthropic",
        envName,
        present: true,
        role: "ignored",
      });
    }
  }

  if (present(env, "CURSOR_API_KEY")) {
    tokens.push({
      provider: "cursor",
      envName: "CURSOR_API_KEY",
      present: true,
      role: "harness",
    });
  } else if (present(env, "CURSOR_API_KEY_FILE")) {
    tokens.push({
      provider: "cursor",
      envName: "CURSOR_API_KEY_FILE",
      present: true,
      role: "harness",
    });
  } else if (present(env, "CURSOR_SERVICE_ACCOUNT_KEY")) {
    tokens.push({
      provider: "cursor",
      envName: "CURSOR_SERVICE_ACCOUNT_KEY",
      present: true,
      role: "harness",
    });
  }

  const selected = tokens.find((token) => token.role === "reconstruct") ?? null;
  return { selected, tokens };
}

export function resolveMimoBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MIMO_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const plan = mimoPlan(env);
  if (plan === "paygo") return "https://api.xiaomimimo.com/v1";
  return "https://token-plan-cn.xiaomimimo.com/v1";
}
