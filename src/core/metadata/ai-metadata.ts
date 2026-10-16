import { z } from "zod";
import type { CmsConfig, CollectionConfig } from "../config/schema.ts";
import type { Entry } from "../content/schema.ts";
import type { MarkdownAnalysis } from "../markdown/analyze.ts";

/**
 * What a model (or the calling agent) produces for an entry. Kept flat and free of length
 * constraints so it works as a strict structured-output schema; limits are enforced after.
 */
export const AiMetadataSchema = z.object({
  seoTitle: z
    .string()
    .describe(
      "Search-optimised title, 30-60 characters, contains the focus keyword near the start",
    ),
  description: z
    .string()
    .describe(
      "Meta description, 120-160 characters, contains the focus keyword, gives a reason to read",
    ),
  excerpt: z
    .string()
    .describe("One or two plain sentences that tease the content for listing pages"),
  focusKeyword: z.string().describe("The single search phrase this content should rank for"),
  keywords: z.array(z.string()).describe("5-10 search phrases, most important first"),
  category: z
    .string()
    .nullable()
    .describe(
      "One category. If a taxonomy is given, use one of its names exactly, else propose one",
    ),
  tags: z.array(z.string()).describe("3-8 short lowercase tags"),
  social: z.object({
    ogTitle: z.string().describe("Open Graph title, may be more conversational than seoTitle"),
    ogDescription: z.string().describe("Open Graph description, up to 200 characters"),
    twitterTitle: z.string().describe("Short title for X/Twitter cards, up to 70 characters"),
    twitterDescription: z.string().describe("Up to 200 characters"),
    linkedinPost: z.string().describe("A 2-4 sentence post announcing this content on LinkedIn"),
    xPost: z.string().describe("A post under 280 characters announcing this content on X"),
  }),
  aeo: z.object({
    answer: z
      .string()
      .describe(
        "40-70 word direct answer to the main question the content addresses, quotable on its own",
      ),
    keyTakeaways: z.array(z.string()).describe("3-5 one-sentence takeaways"),
    faq: z
      .array(z.object({ question: z.string(), answer: z.string() }))
      .describe(
        "3-5 questions readers actually ask, each with a 1-3 sentence answer grounded in the content",
      ),
    questions: z
      .array(z.string())
      .describe("3-6 search questions this content should be the answer for"),
  }),
  imageAlt: z.string().nullable().describe("Alt text for the featured image, or null if no image"),
  reviewNotes: z
    .array(z.string())
    .describe("Anything a human should double-check: claims, missing facts, taxonomy mismatches"),
});
export type AiMetadata = z.infer<typeof AiMetadataSchema>;

export function metadataSystemPrompt(config: CmsConfig, collection: CollectionConfig): string {
  const site = config.site;
  const taxonomy = config.taxonomy;
  const lines = [
    "You are the metadata editor for a website. You write search- and answer-engine-optimised metadata that is accurate to the content, specific, and free of hype.",
    `Site: ${site.name} (${site.url}). ${site.description}`.trim(),
    site.audience ? `Audience: ${site.audience}` : "",
    site.topics.length ? `Site topics: ${site.topics.join(", ")}` : "",
    site.tone ? `Tone: ${site.tone}` : "",
    `Collection: ${collection.label ?? collection.name} (${collection.kind}). ${collection.description ?? ""}`.trim(),
    `Language: ${site.language}`,
  ];
  if (taxonomy.categories.length) {
    lines.push(
      `Categories (${taxonomy.categoryPolicy === "closed" ? "choose exactly one of these" : "prefer one of these"}): ${taxonomy.categories.map((c) => (c.description ? `${c.name} – ${c.description}` : c.name)).join("; ")}`,
    );
  }
  if (taxonomy.tagPolicy === "closed" && taxonomy.allowedTags.length) {
    lines.push(`Only these tags are allowed: ${taxonomy.allowedTags.join(", ")}`);
  }
  lines.push(
    "Rules: never invent facts that are not in the content; keep the focus keyword natural; the answer must stand alone without the article; FAQ answers must be supported by the content; tags are lowercase and short.",
  );
  return lines.filter(Boolean).join("\n");
}

export function metadataUserPrompt(
  entry: Entry,
  analysis: MarkdownAnalysis,
  existingTags: string[],
): string {
  const fm = entry.frontmatter;
  const humanSet: string[] = [];
  const generated = new Set(fm.generated?.fields ?? []);
  for (const f of ["description", "category", "tags", "keywords"] as const) {
    const v = fm[f];
    if (v !== undefined && !(Array.isArray(v) && v.length === 0) && !generated.has(f)) {
      humanSet.push(`${f}: ${JSON.stringify(v)}`);
    }
  }
  return [
    `Title: ${fm.title}`,
    fm.author ? `Author: ${fm.author}` : "",
    fm.image ? `Featured image: ${fm.image}` : "No featured image.",
    humanSet.length
      ? `Metadata set by a human (respect it, do not contradict it):\n${humanSet.join("\n")}`
      : "",
    existingTags.length
      ? `Tags already used on the site (reuse when they fit): ${existingTags.slice(0, 60).join(", ")}`
      : "",
    `Outline: ${analysis.headings.map((h) => `${"#".repeat(h.depth)} ${h.text}`).join(" | ") || "(no headings)"}`,
    `Word count: ${analysis.wordCount}`,
    "",
    "Content (Markdown):",
    entry.body,
  ]
    .filter((l) => l !== "")
    .join("\n");
}
