import path from "node:path";
import { z } from "zod";
import { CmsError } from "../util/errors.ts";
import { readJsonIfExists, writeJson } from "../util/fs.ts";
import { BUNDLED_THEME_DIR } from "./paths.ts";

const Colors = z.record(z.string(), z.string());

export const ThemeTokensSchema = z
  .object({
    name: z.string().default("custom"),
    colors: Colors.default({}),
    dark: Colors.default({}),
    fonts: z
      .object({ body: z.string(), heading: z.string(), mono: z.string() })
      .partial()
      .default({}),
    layout: z
      .object({ maxWidth: z.string(), proseWidth: z.string(), radius: z.string() })
      .partial()
      .default({}),
    features: z
      .object({
        darkMode: z.boolean(),
        toc: z.boolean(),
        answerBox: z.boolean(),
        takeaways: z.boolean(),
        faq: z.boolean(),
        authorCard: z.boolean(),
        related: z.boolean(),
        search: z.boolean(),
      })
      .partial()
      .default({}),
    footer: z.object({ text: z.string() }).partial().default({}),
  })
  .loose();

export type ThemeTokensInput = z.input<typeof ThemeTokensSchema>;

/** Fully resolved tokens: the project theme merged over the bundled default. */
export interface ThemeTokens {
  name: string;
  colors: Record<string, string>;
  dark: Record<string, string>;
  fonts: { body: string; heading: string; mono: string };
  layout: { maxWidth: string; proseWidth: string; radius: string };
  features: {
    darkMode: boolean;
    toc: boolean;
    answerBox: boolean;
    takeaways: boolean;
    faq: boolean;
    authorCard: boolean;
    related: boolean;
    search: boolean;
  };
  footer: { text: string };
  [key: string]: unknown;
}

export const THEME_FILENAME = "theme.json";

export class ThemeStore {
  private readonly file: string;

  constructor(root: string) {
    this.file = path.join(root, THEME_FILENAME);
  }

  async defaults(): Promise<ThemeTokens> {
    const raw = await readJsonIfExists(path.join(BUNDLED_THEME_DIR, THEME_FILENAME));
    return raw as ThemeTokens;
  }

  async project(): Promise<ThemeTokensInput | undefined> {
    const raw = await readJsonIfExists(this.file);
    if (raw === undefined) return undefined;
    const parsed = ThemeTokensSchema.safeParse(raw);
    if (!parsed.success)
      throw new CmsError("VALIDATION", `Invalid ${THEME_FILENAME}`, parsed.error.issues);
    return parsed.data;
  }

  async resolve(): Promise<ThemeTokens> {
    const base = await this.defaults();
    const project = await this.project();
    return merge(base, project ?? {}) as ThemeTokens;
  }

  async update(patch: Record<string, unknown>): Promise<ThemeTokens> {
    const current = (await this.project()) ?? {};
    const next = merge(current as Record<string, unknown>, patch);
    const parsed = ThemeTokensSchema.safeParse(next);
    if (!parsed.success)
      throw new CmsError("VALIDATION", "Invalid theme patch", parsed.error.issues);
    await writeJson(this.file, parsed.data);
    return this.resolve();
  }

  async reset(): Promise<ThemeTokens> {
    await writeJson(this.file, await this.defaults());
    return this.resolve();
  }
}

function merge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    const existing = out[k];
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      out[k] = merge(existing as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v === null) {
      delete out[k];
    } else {
      out[k] = v;
    }
  }
  return out;
}
