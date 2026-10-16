import { z } from "zod";

export const CollectionKindSchema = z.enum(["post", "page", "doc", "author", "custom"]);
export type CollectionKind = z.infer<typeof CollectionKindSchema>;

export const FieldTypeSchema = z.enum([
  "string",
  "text",
  "number",
  "boolean",
  "date",
  "list",
  "enum",
  "reference",
  "object",
]);

export const FieldConfigSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "field names must be identifiers"),
  type: FieldTypeSchema,
  required: z.boolean().default(false),
  description: z.string().optional(),
  /** For `enum` fields: the allowed values. */
  values: z.array(z.string()).optional(),
  /** For `reference` fields: the collection the value points at (by slug). */
  collection: z.string().optional(),
});
export type FieldConfig = z.infer<typeof FieldConfigSchema>;

export const MetadataPolicySchema = z.object({
  /** Which metadata groups the CMS fills in automatically. */
  auto: z
    .array(
      z.enum([
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
      ]),
    )
    .default([
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
    ]),
  maxTags: z.number().int().min(0).max(30).default(8),
  maxKeywords: z.number().int().min(0).max(30).default(10),
});

export const CollectionConfigSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, "collection names are lowercase slugs"),
  label: z.string().optional(),
  description: z.string().optional(),
  kind: CollectionKindSchema.default("custom"),
  /** Directory relative to the project root. */
  path: z.string(),
  /** Public URL pattern. Tokens: {slug}, {year}, {month}, {day}, {category}. */
  urlPattern: z.string().default("/{slug}"),
  /** File name pattern. Tokens: {slug}, {date}. */
  filePattern: z.enum(["{slug}", "{date}-{slug}"]).default("{slug}"),
  fields: z.array(FieldConfigSchema).default([]),
  metadata: MetadataPolicySchema.prefault({}),
  /** Whether entries in this collection appear in feeds, sitemap, llms.txt. */
  listable: z.boolean().default(true),
});
export type CollectionConfig = z.infer<typeof CollectionConfigSchema>;

export const SiteConfigSchema = z.object({
  name: z.string().min(1),
  url: z.url().default("https://example.com"),
  description: z.string().default(""),
  language: z.string().default("en"),
  /** Who the site is for and what it is about. Used to steer AI generation and suggestions. */
  audience: z.string().optional(),
  topics: z.array(z.string()).default([]),
  tone: z.string().optional(),
  organization: z
    .object({
      name: z.string().optional(),
      url: z.url().optional(),
      logo: z.string().optional(),
    })
    .optional(),
  defaultAuthor: z.string().optional(),
  social: z
    .object({
      twitter: z.string().optional(),
      profiles: z.array(z.url()).default([]),
    })
    .prefault({}),
});

export const TaxonomyConfigSchema = z.object({
  categories: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        keywords: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  /** `closed`: only categories listed above may be used. `open`: anything goes. */
  categoryPolicy: z.enum(["open", "closed"]).default("open"),
  tagPolicy: z.enum(["open", "closed"]).default("open"),
  allowedTags: z.array(z.string()).default([]),
});

export const AiConfigSchema = z.object({
  /**
   * auto: Anthropic API if credentials resolve, else MCP sampling if the client supports it,
   * else delegate the generation to the calling agent. deterministic: never call a model.
   */
  provider: z.enum(["auto", "anthropic", "sampling", "delegate", "deterministic"]).default("auto"),
  model: z.string().default("claude-opus-5-5"),
  effort: z.enum(["low", "medium", "high"]).default("medium"),
  maxTokens: z.number().int().min(256).max(64000).default(8000),
});

export const ResearchConfigSchema = z.object({
  competitors: z
    .array(
      z.object({
        url: z.url(),
        name: z.string().optional(),
        notes: z.string().optional(),
        addedAt: z.string().optional(),
      }),
    )
    .default([]),
  maxPagesPerSite: z.number().int().min(1).max(500).default(40),
  requestDelayMs: z.number().int().min(0).max(10000).default(600),
  userAgent: z
    .string()
    .default("agentcms-research/0.1 (+https://github.com/bencounsell/agent-cms)"),
  refreshAfterDays: z.number().int().min(1).default(7),
  /** Only analyse competitor URLs whose path matches one of these prefixes (e.g. "/blog"). */
  pathPrefixes: z.array(z.string()).default([]),
});

export const SeoConfigSchema = z.object({
  targetWordCount: z.number().int().min(100).default(1200),
  titleLength: z.object({ min: z.number().default(30), max: z.number().default(60) }).prefault({}),
  descriptionLength: z
    .object({ min: z.number().default(70), max: z.number().default(160) })
    .prefault({}),
  staleAfterDays: z.number().int().min(1).default(180),
  minInternalLinks: z.number().int().min(0).default(2),
  minAuditScoreToPublish: z.number().int().min(0).max(100).default(60),
});

export const HtmlConfigSchema = z.object({
  /** Render full HTML pages from templates. Turn off to use agentcms headlessly. */
  enabled: z.boolean().default(true),
  /** Project templates directory; files missing here fall back to the bundled default theme. */
  templatesDir: z.string().default("templates"),
  /** Entries per list page. */
  pageSize: z.number().int().min(1).max(200).default(10),
  /** URL path for hashed theme assets. */
  assetsPath: z.string().default("/assets"),
  tagsPath: z.string().default("/tags"),
  categoriesPath: z.string().default("/categories"),
  /** Navigation items rendered by the theme; defaults to the listable collections. */
  nav: z.array(z.object({ label: z.string(), url: z.string() })).optional(),
});

export const BuildConfigSchema = z.object({
  /** Site root. Pages, assets, sitemap, robots, llms.txt and feeds are written here. */
  outDir: z.string().default("dist"),
  /** Sub-directory of outDir for the JSON content API, taxonomy and search index. */
  dataPath: z.string().default("cms"),
  feeds: z.boolean().default(true),
  feedLimit: z.number().int().min(1).default(20),
  sitemap: z.boolean().default(true),
  llmsTxt: z.boolean().default(true),
  searchIndex: z.boolean().default(true),
  robots: z.boolean().default(true),
  includeDrafts: z.boolean().default(false),
  html: HtmlConfigSchema.prefault({}),
});

export const CmsConfigSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal(1).default(1),
  site: SiteConfigSchema,
  collections: z.array(CollectionConfigSchema).min(1),
  taxonomy: TaxonomyConfigSchema.prefault({}),
  ai: AiConfigSchema.prefault({}),
  research: ResearchConfigSchema.prefault({}),
  seo: SeoConfigSchema.prefault({}),
  build: BuildConfigSchema.prefault({}),
});

export type CmsConfig = z.infer<typeof CmsConfigSchema>;
export type CmsConfigInput = z.input<typeof CmsConfigSchema>;

export const CONFIG_FILENAME = "agentcms.config.json";
export const CACHE_DIRNAME = ".agentcms";

export function defaultCollections(): CollectionConfig[] {
  return [
    CollectionConfigSchema.parse({
      name: "posts",
      label: "Blog posts",
      description: "Articles published on the blog.",
      kind: "post",
      path: "content/posts",
      urlPattern: "/blog/{slug}",
    }),
    CollectionConfigSchema.parse({
      name: "pages",
      label: "Pages",
      description: "Evergreen site pages such as About or Pricing.",
      kind: "page",
      path: "content/pages",
      urlPattern: "/{slug}",
      metadata: { auto: ["description", "excerpt", "keywords", "social", "schema", "readingTime"] },
    }),
    CollectionConfigSchema.parse({
      name: "authors",
      label: "Authors",
      description: "People who write for the site.",
      kind: "author",
      path: "content/authors",
      urlPattern: "/authors/{slug}",
      listable: false,
      metadata: { auto: ["description", "schema"] },
    }),
  ];
}

export function defaultConfig(input: {
  name: string;
  url?: string;
  description?: string;
}): CmsConfig {
  return CmsConfigSchema.parse({
    $schema:
      "https://raw.githubusercontent.com/bencounsell/agent-cms/main/schemas/config.schema.json",
    site: {
      name: input.name,
      url: input.url ?? "https://example.com",
      description: input.description ?? "",
    },
    collections: defaultCollections(),
  });
}

export type AiConfig = z.infer<typeof AiConfigSchema>;
export type SeoConfig = z.infer<typeof SeoConfigSchema>;
export type BuildConfig = z.infer<typeof BuildConfigSchema>;
export type HtmlConfig = z.infer<typeof HtmlConfigSchema>;
export type ResearchConfig = z.infer<typeof ResearchConfigSchema>;
export type TaxonomyConfig = z.infer<typeof TaxonomyConfigSchema>;
export type SiteConfig = z.infer<typeof SiteConfigSchema>;
