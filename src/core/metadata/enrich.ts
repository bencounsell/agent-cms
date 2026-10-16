import { z } from "zod";
import type { AiResolution } from "../ai/types.ts";
import type { CmsConfig, CollectionConfig } from "../config/schema.ts";
import {
  type Entry,
  type EntryFrontmatter,
  METADATA_FIELDS,
  type MetadataField,
} from "../content/schema.ts";
import type { ContentStore } from "../content/store.ts";
import type { MarkdownAnalysis } from "../markdown/analyze.ts";
import { nowIso } from "../util/dates.ts";
import { CmsError } from "../util/errors.ts";
import { log } from "../util/log.ts";
import { slugify, uniq } from "../util/text.ts";
import {
  type AiMetadata,
  AiMetadataSchema,
  metadataSystemPrompt,
  metadataUserPrompt,
} from "./ai-metadata.ts";
import { type DeterministicContext, deterministicMetadata } from "./deterministic.ts";

export interface EnrichOptions {
  /** Restrict to these metadata groups. Default: the collection's `metadata.auto` policy. */
  fields?: MetadataField[];
  /** Overwrite values a human set. Default false: only empty or previously generated fields change. */
  force?: boolean;
  /** Skip the model even when one is available. */
  deterministicOnly?: boolean;
}

export interface DelegatedTask {
  kind: "generate_metadata";
  collection: string;
  slug: string;
  reason: string;
  fields: MetadataField[];
  instructions: string;
  system: string;
  prompt: string;
  /** JSON Schema the agent's reply must satisfy. */
  schema: Record<string, unknown>;
  submit: {
    tool: "submit_metadata";
    args: { collection: string; slug: string; metadata: "<object matching schema>" };
  };
}

export interface EnrichResult {
  entry: Entry;
  /** Metadata groups written in this run. */
  generated: MetadataField[];
  provider: string;
  review: string[];
  notes: string[];
  skipped: { field: MetadataField; reason: string }[];
  delegated?: DelegatedTask;
}

export interface EnrichContext extends DeterministicContext {
  store: ContentStore;
  ai: AiResolution;
  existingTags: string[];
}

const AI_FIELDS: ReadonlySet<MetadataField> = new Set([
  "description",
  "excerpt",
  "category",
  "tags",
  "keywords",
  "social",
  "aeo",
]);

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

function currentValue(fm: EntryFrontmatter, field: MetadataField): unknown {
  switch (field) {
    case "readingTime":
      return fm.readingTime;
    default:
      return fm[field];
  }
}

/** Decide which metadata groups may be written in this run. */
export function selectFields(
  entry: Entry,
  collection: CollectionConfig,
  opts: EnrichOptions,
): { allowed: Set<MetadataField>; skipped: { field: MetadataField; reason: string }[] } {
  const requested = new Set<MetadataField>(opts.fields ?? collection.metadata.auto);
  const generated = new Set(entry.frontmatter.generated?.fields ?? []);
  const allowed = new Set<MetadataField>();
  const skipped: { field: MetadataField; reason: string }[] = [];
  for (const field of METADATA_FIELDS) {
    if (!requested.has(field)) continue;
    const value = currentValue(entry.frontmatter, field);
    // Derived facts and structured data are always safe to refresh.
    const derived = field === "readingTime" || field === "schema";
    if (opts.force || derived || isEmpty(value) || generated.has(field)) allowed.add(field);
    else skipped.push({ field, reason: "set by a human; pass force to overwrite" });
  }
  return { allowed, skipped };
}

export async function enrichEntry(
  entry: Entry,
  analysis: MarkdownAnalysis,
  ctx: EnrichContext,
  opts: EnrichOptions = {},
): Promise<EnrichResult> {
  const { collection, config } = ctx;
  const { allowed, skipped } = selectFields(entry, collection, opts);
  const notes: string[] = [];
  if (allowed.size === 0) {
    return {
      entry,
      generated: [],
      provider: "none",
      review: entry.frontmatter.review ?? [],
      notes: ["nothing to generate"],
      skipped,
    };
  }

  const det = deterministicMetadata(entry, analysis, ctx, allowed);
  let fm: EntryFrontmatter = { ...entry.frontmatter, ...det.values };
  let review = uniq([...(entry.frontmatter.review ?? []), ...det.review]);
  notes.push(...det.notes);
  let provider = "deterministic";
  let delegated: DelegatedTask | undefined;
  const generatedNow = new Set<MetadataField>([...allowed].filter((f) => f !== "schema"));

  const aiFields = [...allowed].filter((f) => AI_FIELDS.has(f));
  if (aiFields.length > 0 && !opts.deterministicOnly && ctx.ai.mode !== "deterministic") {
    const system = metadataSystemPrompt(config, collection);
    const prompt = metadataUserPrompt({ ...entry, frontmatter: fm }, analysis, ctx.existingTags);
    if (ctx.ai.mode === "provider") {
      try {
        const ai = await ctx.ai.provider.generateStructured({
          system,
          prompt,
          schema: AiMetadataSchema,
          schemaName: "entry_metadata",
        });
        const applied = applyAiMetadata(fm, ai, new Set(aiFields), config, collection);
        fm = applied.frontmatter;
        review = uniq([
          ...review.filter((r) => !applied.resolvedReview.includes(r)),
          ...applied.review,
        ]);
        notes.push(...applied.notes);
        provider = ctx.ai.provider.name;
      } catch (err) {
        log.warn("AI enrichment failed, keeping deterministic metadata:", err);
        notes.push(
          `model enrichment failed (${(err as Error).message}); deterministic metadata was kept`,
        );
      }
    } else {
      delegated = {
        kind: "generate_metadata",
        collection: entry.collection,
        slug: entry.slug,
        reason: ctx.ai.reason,
        fields: aiFields,
        instructions:
          "No model is configured for the CMS, so you (the agent) generate the metadata. Read the system and prompt text, produce a JSON object that satisfies `schema`, then call the `submit_metadata` tool with it. Deterministic metadata has already been written as a baseline.",
        system,
        prompt,
        schema: z.toJSONSchema(AiMetadataSchema) as Record<string, unknown>,
        submit: {
          tool: "submit_metadata",
          args: {
            collection: entry.collection,
            slug: entry.slug,
            metadata: "<object matching schema>",
          },
        },
      };
    }
  }

  fm.generated = {
    fields: uniq([...(entry.frontmatter.generated?.fields ?? []), ...generatedNow]),
    provider: provider === "deterministic" ? "deterministic" : `${provider}+deterministic`,
    at: nowIso(),
  };
  fm.review = review.length ? review : undefined;
  const saved = await ctx.store.save({ ...entry, frontmatter: fm });
  return {
    entry: saved,
    generated: [...generatedNow],
    provider: fm.generated.provider,
    review,
    notes,
    skipped,
    delegated,
  };
}

/** Apply model-produced metadata to frontmatter, honouring taxonomy policies and limits. */
export function applyAiMetadata(
  fm: EntryFrontmatter,
  ai: AiMetadata,
  fields: ReadonlySet<MetadataField>,
  config: CmsConfig,
  collection: CollectionConfig,
): { frontmatter: EntryFrontmatter; review: string[]; resolvedReview: string[]; notes: string[] } {
  const out: EntryFrontmatter = { ...fm };
  const review: string[] = [];
  const resolvedReview: string[] = [];
  const notes: string[] = [];
  const policy = collection.metadata;
  const taxonomy = config.taxonomy;
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

  if (fields.has("description")) {
    if (clean(ai.description)) {
      out.description = clean(ai.description);
      resolvedReview.push("description");
    }
    const seoTitle = clean(ai.seoTitle);
    if (seoTitle && seoTitle !== fm.title) out.seo = { ...(out.seo ?? {}), title: seoTitle };
  }
  if (fields.has("excerpt") && clean(ai.excerpt)) out.excerpt = clean(ai.excerpt);
  if (fields.has("keywords")) {
    const kws = uniq(ai.keywords.map(clean).filter(Boolean)).slice(0, policy.maxKeywords);
    if (kws.length) out.keywords = kws;
    const focus = clean(ai.focusKeyword);
    if (focus) out.seo = { ...(out.seo ?? {}), focusKeyword: focus };
  }
  if (fields.has("category")) {
    const cat = clean(ai.category);
    if (cat) {
      const known = taxonomy.categories.find((c) => c.name.toLowerCase() === cat.toLowerCase());
      if (known) {
        out.category = known.name;
        resolvedReview.push("category");
      } else if (taxonomy.categoryPolicy === "open") {
        out.category = cat;
        review.push("category");
        notes.push(`model proposed a category outside the taxonomy: "${cat}"`);
      } else {
        notes.push(`model proposed "${cat}" which is not an allowed category; category left as is`);
        review.push("category");
      }
    }
  }
  if (fields.has("tags")) {
    let tags = uniq(ai.tags.map((t) => slugify(clean(t))).filter(Boolean));
    if (taxonomy.tagPolicy === "closed") {
      const allowed = new Set(taxonomy.allowedTags.map((t) => slugify(t)));
      const dropped = tags.filter((t) => !allowed.has(t));
      tags = tags.filter((t) => allowed.has(t));
      if (dropped.length)
        notes.push(`dropped tags outside the allowed list: ${dropped.join(", ")}`);
    }
    if (tags.length) {
      out.tags = tags.slice(0, policy.maxTags);
      resolvedReview.push("tags");
    }
  }
  if (fields.has("social")) {
    const image = out.image;
    out.social = {
      og: {
        title: clean(ai.social.ogTitle) || out.seo?.title || out.title,
        description: clean(ai.social.ogDescription) || out.description,
        image,
        type: collection.kind === "post" || collection.kind === "doc" ? "article" : "website",
      },
      twitter: {
        card: image ? "summary_large_image" : "summary",
        title: clean(ai.social.twitterTitle) || out.seo?.title || out.title,
        description: clean(ai.social.twitterDescription) || out.description,
        image,
        site: config.site.social.twitter,
      },
      posts: {
        linkedin: clean(ai.social.linkedinPost) || undefined,
        x: clean(ai.social.xPost) || undefined,
      },
    };
  }
  if (fields.has("aeo")) {
    out.aeo = {
      ...(out.aeo ?? {}),
      answer: clean(ai.aeo.answer) || out.aeo?.answer,
      keyTakeaways: ai.aeo.keyTakeaways.map(clean).filter(Boolean),
      faq: ai.aeo.faq
        .map((f) => ({ question: clean(f.question), answer: clean(f.answer) }))
        .filter((f) => f.question && f.answer),
      questions: uniq(ai.aeo.questions.map(clean).filter(Boolean)),
    };
    resolvedReview.push("aeo");
  }
  if (out.image && !out.imageAlt && clean(ai.imageAlt)) out.imageAlt = clean(ai.imageAlt);
  if (ai.reviewNotes.length) notes.push(...ai.reviewNotes.map((n) => `model note: ${n}`));
  return { frontmatter: out, review: uniq(review), resolvedReview, notes };
}

export function assertMetadataField(field: string): MetadataField {
  if ((METADATA_FIELDS as readonly string[]).includes(field)) return field as MetadataField;
  throw new CmsError(
    "VALIDATION",
    `Unknown metadata field "${field}". Valid: ${METADATA_FIELDS.join(", ")}`,
  );
}
