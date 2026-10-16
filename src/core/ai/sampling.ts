import type { AiConfig } from "../config/schema.ts";
import { CmsError } from "../util/errors.ts";
import {
  type AiProvider,
  extractJsonObject,
  type SamplingFn,
  type StructuredRequest,
  type TextRequest,
} from "./types.ts";

/**
 * Uses MCP sampling: the connected client (Claude Code, VS Code, …) runs the completion with
 * its own model and credentials. Structured output is requested through the prompt and validated
 * locally, with one corrective retry.
 */
export class SamplingProvider implements AiProvider {
  readonly name = "sampling" as const;
  readonly model = "client";
  private readonly sample: SamplingFn;
  private readonly maxTokens: number;

  constructor(sample: SamplingFn, config: AiConfig) {
    this.sample = sample;
    this.maxTokens = config.maxTokens;
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<T> {
    const { z } = await import("zod");
    const jsonSchema = JSON.stringify(z.toJSONSchema(req.schema));
    const prompt = `${req.prompt}\n\nRespond with a single JSON object (no prose, no code fences) that conforms to this JSON Schema named "${req.schemaName}":\n${jsonSchema}`;
    let text = await this.sample({
      system: req.system,
      prompt,
      maxTokens: req.maxTokens ?? this.maxTokens,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return req.schema.parse(extractJsonObject(text));
      } catch (err) {
        if (attempt === 1) {
          throw new CmsError(
            "AI_UNAVAILABLE",
            `Sampling reply did not match the schema: ${(err as Error).message}`,
          );
        }
        text = await this.sample({
          system: req.system,
          prompt: `${prompt}\n\nYour previous reply was invalid (${(err as Error).message}). Reply again with only the JSON object.`,
          maxTokens: req.maxTokens ?? this.maxTokens,
        });
      }
    }
    throw new CmsError("AI_UNAVAILABLE", "Sampling failed");
  }

  generateText(req: TextRequest): Promise<string> {
    return this.sample({
      system: req.system,
      prompt: req.prompt,
      maxTokens: req.maxTokens ?? this.maxTokens,
    });
  }
}
