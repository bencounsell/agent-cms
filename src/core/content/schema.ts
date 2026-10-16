import { z } from "zod";

export const StatusSchema = z.enum(["draft", "review", "published", "archived"]);
export type Status = z.infer<typeof StatusSchema>;

export const FaqItemSchema = z.object({
  question: z.string().min(1),
  answer: z.string().min(1),
});
export type FaqItem = z.infer<typeof FaqItemSchema>;

export const SeoFieldsSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    focusKeyword: z.string().optional(),
    noindex: z.boolean().optional(),
  })
  .loose();

export const SocialSchema = z
  .object({
    og: z
      .object({
        title: z.string().optional(),
        description: z.string().optional(),
        image: z.string().optional(),
        type: z.string().optional(),
      })
      .loose()
      .optional(),
    twitter: z
      .object({
        card: z.enum(["summary", "summary_large_image"]).optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        image: z.string().optional(),
        site: z.string().optional(),
        creator: z.string().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();
export type Social = z.infer<typeof SocialSchema>;

export const AeoSchema = z
  .object({
    /** A direct, self-contained answer to the main question the content addresses. */
    answer: z.string().optional(),
    keyTakeaways: z.array(z.string()).optional(),
    faq: z.array(FaqItemSchema).optional(),
    /** Search questions this content should be the answer to. */
    questions: z.array(z.string()).optional(),
  })
  .loose();
export type Aeo = z.infer<typeof AeoSchema>;

export const GeneratedSchema = z.object({
  fields: z.array(z.string()).default([]),
  provider: z.string().default("deterministic"),
  at: z.string().optional(),
});

export const EntryFrontmatterSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    slug: z.string().min(1),
    status: StatusSchema.default("draft"),
    publishedAt: z.string().optional(),
    updatedAt: z.string().optional(),
    createdAt: z.string().optional(),
    author: z.string().optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).default([]),
    keywords: z.array(z.string()).default([]),
    description: z.string().optional(),
    excerpt: z.string().optional(),
    image: z.string().optional(),
    imageAlt: z.string().optional(),
    canonical: z.string().optional(),
    language: z.string().optional(),
    seo: SeoFieldsSchema.optional(),
    social: SocialSchema.optional(),
    aeo: AeoSchema.optional(),
    /** URLs or citations backing the content. */
    sources: z.array(z.string()).optional(),
    /** Slugs of related entries in the same collection. */
    related: z.array(z.string()).optional(),
    /** JSON-LD override or extension. Merged over the generated structured data. */
    schema: z.record(z.string(), z.unknown()).optional(),
    readingTime: z.number().optional(),
    wordCount: z.number().optional(),
    generated: GeneratedSchema.optional(),
    /** Field names a human or agent should confirm before publishing. */
    review: z.array(z.string()).optional(),
  })
  .loose();

export type EntryFrontmatter = z.infer<typeof EntryFrontmatterSchema>;
export type EntryFrontmatterInput = z.input<typeof EntryFrontmatterSchema>;

export interface Entry {
  collection: string;
  slug: string;
  /** Absolute file path. */
  file: string;
  /** Path relative to the project root. */
  relativePath: string;
  frontmatter: EntryFrontmatter;
  body: string;
  /** Public URL derived from the collection's urlPattern and site url. */
  url: string;
  /** Path portion of `url`. */
  path: string;
}

/** The shape agents send to create or update an entry. Everything but title is optional. */
export const EntryInputSchema = z
  .object({
    title: z.string().min(1).optional(),
    slug: z.string().optional(),
    body: z.string().optional(),
    status: StatusSchema.optional(),
    publishedAt: z.string().optional(),
    author: z.string().optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    keywords: z.array(z.string()).optional(),
    description: z.string().optional(),
    excerpt: z.string().optional(),
    image: z.string().optional(),
    imageAlt: z.string().optional(),
    canonical: z.string().optional(),
    language: z.string().optional(),
    seo: SeoFieldsSchema.optional(),
    social: SocialSchema.optional(),
    aeo: AeoSchema.optional(),
    sources: z.array(z.string()).optional(),
    related: z.array(z.string()).optional(),
    schema: z.record(z.string(), z.unknown()).optional(),
    review: z.array(z.string()).optional(),
  })
  .loose();
export type EntryInput = z.infer<typeof EntryInputSchema>;

export const METADATA_FIELDS = [
  "description",
  "excerpt",
  "category",
  "tags",
  "keywords",
  "social",
  "aeo",
  "schema",
  "related",
  "readingTime",
] as const;
export type MetadataField = (typeof METADATA_FIELDS)[number];
