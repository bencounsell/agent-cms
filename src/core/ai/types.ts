import type { z } from "zod";

export type AiProviderName = "anthropic" | "sampling";

export interface StructuredRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  schemaName: string;
  maxTokens?: number;
}

export interface TextRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
}

export interface AiProvider {
  readonly name: AiProviderName;
  readonly model: string;
  generateStructured<T>(req: StructuredRequest<T>): Promise<T>;
  generateText(req: TextRequest): Promise<string>;
}

/** How the CMS will obtain model output for this session. */
export type AiResolution =
  | { mode: "provider"; provider: AiProvider }
  | { mode: "delegate"; reason: string }
  | { mode: "deterministic"; reason: string };

/**
 * The MCP sampling primitive, injected by the MCP server so the core never imports the SDK.
 * Returns the text of the model's reply.
 */
export type SamplingFn = (req: {
  system: string;
  prompt: string;
  maxTokens: number;
}) => Promise<string>;

/** Pull a JSON object out of a model reply that may be wrapped in prose or code fences. */
export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model reply did not contain a JSON object");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}
