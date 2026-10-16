import type { AiConfig } from "../config/schema.ts";
import { AnthropicProvider, hasAnthropicCredentials } from "./anthropic.ts";
import { SamplingProvider } from "./sampling.ts";
import type { AiProvider, AiResolution, SamplingFn } from "./types.ts";

export interface ResolveAiOptions {
  config: AiConfig;
  /** Present when an MCP client that supports sampling is connected. */
  sampling?: SamplingFn;
  /** Test seam. */
  provider?: AiProvider;
  env?: NodeJS.ProcessEnv;
}

export function resolveAi(opts: ResolveAiOptions): AiResolution {
  const { config } = opts;
  if (opts.provider) return { mode: "provider", provider: opts.provider };
  const anthropicAvailable = hasAnthropicCredentials(opts.env);
  switch (config.provider) {
    case "deterministic":
      return { mode: "deterministic", reason: "ai.provider is set to deterministic" };
    case "anthropic":
      if (anthropicAvailable) return { mode: "provider", provider: new AnthropicProvider(config) };
      return {
        mode: "delegate",
        reason:
          "ai.provider is anthropic but no credentials were found (set ANTHROPIC_API_KEY or run `ant auth login`)",
      };
    case "sampling":
      if (opts.sampling)
        return { mode: "provider", provider: new SamplingProvider(opts.sampling, config) };
      return {
        mode: "delegate",
        reason: "ai.provider is sampling but the connected client does not support MCP sampling",
      };
    case "delegate":
      return { mode: "delegate", reason: "ai.provider is set to delegate" };
    default:
      if (anthropicAvailable) return { mode: "provider", provider: new AnthropicProvider(config) };
      if (opts.sampling)
        return { mode: "provider", provider: new SamplingProvider(opts.sampling, config) };
      return {
        mode: "delegate",
        reason:
          "no Anthropic credentials and the client does not support sampling; the calling agent generates metadata itself",
      };
  }
}
