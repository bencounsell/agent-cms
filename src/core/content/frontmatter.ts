import YAML from "yaml";
import { CmsError } from "../util/errors.ts";

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface ParsedDocument {
  data: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(text: string): ParsedDocument {
  const normalized = text.replace(/^﻿/, "");
  if (!normalized.startsWith("---")) return { data: {}, body: normalized };
  const m = normalized.match(FENCE);
  if (!m) return { data: {}, body: normalized };
  let data: unknown;
  try {
    data = YAML.parse(m[1] ?? "") ?? {};
  } catch (err) {
    throw new CmsError("VALIDATION", `Invalid YAML frontmatter: ${(err as Error).message}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new CmsError("VALIDATION", "Frontmatter must be a YAML mapping");
  }
  return { data: data as Record<string, unknown>, body: (m[2] ?? "").replace(/^\r?\n/, "") };
}

/** Canonical key order so diffs stay readable and humans find the important fields first. */
export const FRONTMATTER_KEY_ORDER = [
  "id",
  "title",
  "slug",
  "status",
  "publishedAt",
  "updatedAt",
  "createdAt",
  "author",
  "category",
  "tags",
  "keywords",
  "description",
  "excerpt",
  "image",
  "imageAlt",
  "canonical",
  "language",
  "seo",
  "social",
  "aeo",
  "sources",
  "related",
  "schema",
  "readingTime",
  "wordCount",
  "generated",
  "review",
];

export function orderKeys(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of FRONTMATTER_KEY_ORDER) {
    if (key in data && data[key] !== undefined) out[key] = data[key];
  }
  for (const key of Object.keys(data).sort()) {
    if (!(key in out) && data[key] !== undefined) out[key] = data[key];
  }
  return out;
}

export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  const yaml = YAML.stringify(orderKeys(data), { lineWidth: 0, defaultStringType: "PLAIN" });
  const trimmedBody = body.replace(/^\s*\n/, "").replace(/\s+$/, "");
  return `---\n${yaml}---\n\n${trimmedBody}\n`;
}
