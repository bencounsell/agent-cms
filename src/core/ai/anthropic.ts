import { accessSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { AiConfig } from "../config/schema.ts";
import { CmsError } from "../util/errors.ts";
import { log } from "../util/log.ts";
import {
  type AiProvider,
  extractJsonObject,
  type StructuredRequest,
  type TextRequest,
} from "./types.ts";

/**
 * True when the Anthropic SDK will find credentials on its own: an API key or auth token in the
 * environment, or a profile written by `ant auth login`. We check cheaply instead of making a
 * request so `auto` mode can decide without a network round trip.
 */
export function hasAnthropicCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return true;
  if (env.ANTHROPIC_FEDERATION_RULE_ID && env.ANTHROPIC_IDENTITY_TOKEN_FILE) return true;
  const configDir = env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config");
  try {
    accessSync(path.join(configDir, "anthropic"));
    return true;
  } catch {
    return false;
  }
}

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic" as const;
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: AiConfig["effort"];
  private readonly maxTokens: number;

  constructor(config: AiConfig, client: Anthropic = new Anthropic()) {
    this.client = client;
    this.model = config.model;
    this.effort = config.effort;
    this.maxTokens = config.maxTokens;
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<T> {
    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: req.maxTokens ?? this.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
        output_config: {
          effort: this.effort,
          format: zodOutputFormat(req.schema),
        },
      });
      if (response.stop_reason === "refusal") {
        throw new CmsError(
          "AI_UNAVAILABLE",
          "The model declined this request.",
          response.stop_details,
        );
      }
      if (response.parsed_output) return response.parsed_output as T;
      // Fall back to parsing the text block when the SDK could not parse the output.
      const text = response.content.find((b) => b.type === "text");
      if (text && text.type === "text") return req.schema.parse(extractJsonObject(text.text));
      throw new CmsError("AI_UNAVAILABLE", "The model returned no structured output.");
    } catch (err) {
      throw wrap(err);
    }
  }

  async generateText(req: TextRequest): Promise<string> {
    try {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: req.maxTokens ?? this.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
        output_config: { effort: this.effort },
      });
      const message = await stream.finalMessage();
      if (message.stop_reason === "refusal") {
        throw new CmsError(
          "AI_UNAVAILABLE",
          "The model declined this request.",
          message.stop_details,
        );
      }
      return message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    } catch (err) {
      throw wrap(err);
    }
  }
}

function wrap(err: unknown): Error {
  if (err instanceof CmsError) return err;
  if (err instanceof Anthropic.AuthenticationError) {
    return new CmsError(
      "AI_UNAVAILABLE",
      "Anthropic authentication failed. Set ANTHROPIC_API_KEY or run `ant auth login`.",
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new CmsError("AI_UNAVAILABLE", "Anthropic rate limit hit. Retry shortly.");
  }
  if (err instanceof Anthropic.APIError) {
    log.debug("anthropic api error", err);
    return new CmsError("AI_UNAVAILABLE", `Anthropic API error ${err.status}: ${err.message}`);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new CmsError("NETWORK", `Could not reach the Anthropic API: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
