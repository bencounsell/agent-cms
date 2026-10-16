import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Cms } from "../core/cms.ts";
import {
  EntryFrontmatterSchema,
  EntryInputSchema,
  METADATA_FIELDS,
  StatusSchema,
} from "../core/content/schema.ts";
import { serializeEntry, summarizeEntry } from "../core/serialize.ts";
import { CmsError } from "../core/util/errors.ts";
import { log } from "../core/util/log.ts";
import { SERVER_VERSION } from "../core/version.ts";
import { AGENT_GUIDE, SERVER_INSTRUCTIONS } from "./guide.ts";
import { registerPrompts } from "./prompts.ts";
import { registerTemplateTools } from "./templates.ts";

export { SERVER_VERSION };

function ok(data: unknown, text?: string): CallToolResult {
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(data, null, 2) }],
    structuredContent:
      typeof data === "object" && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : { result: data },
  };
}

function fail(err: unknown): CallToolResult {
  const message =
    err instanceof CmsError
      ? `${err.code}: ${err.message}${err.details ? `\n${JSON.stringify(err.details, null, 2)}` : ""}`
      : err instanceof Error
        ? err.message
        : String(err);
  log.debug("tool error", err);
  return { isError: true, content: [{ type: "text", text: message }] };
}

const Loose = z.looseObject({});
const collectionArg = z
  .string()
  .describe("Collection name, e.g. posts, pages, authors (see get_config)");
const slugArg = z.string().describe("Entry slug");
const metadataFieldArg = z.enum(METADATA_FIELDS);

const entryInputShape = {
  title: z.string().optional(),
  body: z.string().optional().describe("Markdown body without frontmatter"),
  slug: z.string().optional(),
  status: StatusSchema.optional(),
  publishedAt: z.string().optional(),
  author: z.string().optional().describe("Slug of an authors entry"),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  description: z.string().optional(),
  excerpt: z.string().optional(),
  image: z.string().optional(),
  imageAlt: z.string().optional(),
  canonical: z.string().optional(),
  language: z.string().optional(),
  seo: z
    .looseObject({
      title: z.string().optional(),
      description: z.string().optional(),
      focusKeyword: z.string().optional(),
      noindex: z.boolean().optional(),
    })
    .optional(),
  social: Loose.optional(),
  aeo: z
    .looseObject({
      answer: z.string().optional(),
      keyTakeaways: z.array(z.string()).optional(),
      faq: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
      questions: z.array(z.string()).optional(),
    })
    .optional(),
  sources: z.array(z.string()).optional(),
  related: z.array(z.string()).optional(),
  schema: Loose.optional(),
  review: z
    .array(z.string())
    .optional()
    .describe("Set to [] once the flagged fields are confirmed"),
  fields: Loose.optional().describe("Custom collection fields as key/value pairs"),
};

export function createMcpServer(cms: Cms): McpServer {
  const server = new McpServer(
    { name: "agentcms", version: SERVER_VERSION, title: "agentcms – agent-first CMS" },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { logging: {} } },
  );

  // Once the client announces its capabilities, enable sampling-backed generation if it supports it.
  server.server.oninitialized = () => {
    const caps = server.server.getClientCapabilities();
    if (caps?.sampling) {
      cms.setSampling(async ({ system, prompt, maxTokens }) => {
        const res = await server.server.createMessage({
          systemPrompt: system,
          maxTokens,
          messages: [{ role: "user", content: { type: "text", text: prompt } }],
          modelPreferences: { intelligencePriority: 0.9, speedPriority: 0.2 },
        });
        const blocks = Array.isArray(res.content) ? res.content : [res.content];
        const text = blocks
          .filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join("\n");
        if (!text) throw new CmsError("AI_UNAVAILABLE", "Sampling returned no text");
        return text;
      });
      log.info(
        "MCP client supports sampling; using it for metadata generation when no API key is present",
      );
    }
  };

  const progress = (msg: string) => {
    server.server
      .sendLoggingMessage({ level: "info", logger: "agentcms", data: msg })
      .catch(() => {});
  };

  // ------------------------------------------------------------------ briefing & reading

  server.registerTool(
    "get_briefing",
    {
      title: "Get briefing",
      description:
        "Call this first in every session. Returns the state of the site: counts per collection and status, drafts, entries awaiting review, stale content, entries with thin metadata, low audit scores, orphan entries, broken links, validation problems, competitor research status (including new competitor pages since the last check), the active AI mode, and an ordered list of nextActions expressed as tool calls. Share the headline with the user and offer the top actions.",
      inputSchema: {},
      outputSchema: z.looseObject({ headline: z.string(), nextActions: z.array(Loose) }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return ok(await cms.briefing());
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_content",
    {
      title: "List content",
      description:
        "List entries with their core metadata (no body). Filter by collection, status, tag, category, author or a title query. Omit collection to list every collection. Use get_content for the body.",
      inputSchema: {
        collection: collectionArg.optional(),
        status: z.union([StatusSchema, z.array(StatusSchema)]).optional(),
        tag: z.string().optional(),
        category: z.string().optional(),
        author: z.string().optional(),
        query: z
          .string()
          .optional()
          .describe("Case-insensitive match on title, slug or description"),
        sort: z.enum(["publishedAt", "updatedAt", "title", "slug"]).optional(),
        order: z.enum(["asc", "desc"]).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      },
      outputSchema: z.looseObject({ total: z.number(), entries: z.array(Loose) }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ collection, ...opts }) => {
      try {
        const entries = collection ? await cms.list(collection, opts) : await cms.store.all(opts);
        return ok({ total: entries.length, entries: entries.map(summarizeEntry) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_content",
    {
      title: "Get content",
      description:
        "Read one entry: frontmatter, body, URL and file path. Accepts the slug or the entry id.",
      inputSchema: {
        collection: collectionArg,
        slug: slugArg,
        includeBody: z.boolean().default(true),
      },
      outputSchema: z.looseObject({ slug: z.string(), title: z.string(), frontmatter: Loose }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ collection, slug, includeBody }) => {
      try {
        const entry = await cms.get(collection, slug);
        return ok(serializeEntry(entry, { body: includeBody }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "search_content",
    {
      title: "Search content",
      description:
        "Full-text search across titles, descriptions, tags and bodies. Use it before creating content to avoid duplicates and to find entries to link to.",
      inputSchema: {
        query: z.string(),
        collection: collectionArg.optional(),
        status: StatusSchema.optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
      outputSchema: z.looseObject({ hits: z.array(Loose) }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, collection, status, limit }) => {
      try {
        return ok({ query, hits: await cms.search(query, { collection, status, limit }) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ------------------------------------------------------------------ writing

  server.registerTool(
    "create_content",
    {
      title: "Create content",
      description:
        "Create a new entry as a Markdown file. Metadata (description, category, tags, keywords, social, answer/FAQ/takeaways, JSON-LD) is generated automatically unless enrich is false. Returns the saved entry, what was generated, fields flagged for review, an audit, and nextActions. If the result contains enrichment.delegated, generate that metadata yourself and call submit_metadata. New entries start as drafts; ask the user before publishing.",
      inputSchema: {
        collection: collectionArg,
        ...entryInputShape,
        title: z.string().min(1),
        enrich: z.boolean().default(true),
      },
      outputSchema: z.looseObject({ entry: Loose, nextActions: z.array(Loose) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ collection, enrich, fields, ...input }) => {
      try {
        const result = await cms.create(collection, { ...input, ...(fields ?? {}) }, { enrich });
        return ok({
          ...result,
          entry: serializeEntry(result.entry, { body: false }),
          enrichment: result.enrichment ? { ...result.enrichment, entry: undefined } : undefined,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "update_content",
    {
      title: "Update content",
      description:
        "Patch an entry's frontmatter and/or body. Only the fields you pass change. Pass body to replace the Markdown. Metadata is re-generated for machine-written fields when the body or title changes (enrich controls this); human-written fields are never overwritten. To confirm reviewed fields pass review: []. Changing the slug of a published entry breaks links: confirm with the user first.",
      inputSchema: {
        ...entryInputShape,
        collection: collectionArg,
        slug: slugArg,
        newSlug: z
          .string()
          .optional()
          .describe("Rename the entry (confirm with the user if it is published)"),
        enrich: z
          .boolean()
          .optional()
          .describe(
            "Force (true) or skip (false) metadata regeneration; default: only when body or title changed",
          ),
      },
      outputSchema: z.looseObject({ entry: Loose, nextActions: z.array(Loose) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ collection, slug, newSlug, enrich, fields, ...patch }) => {
      try {
        const result = await cms.update(
          collection,
          slug,
          { ...patch, ...(fields ?? {}), slug: newSlug },
          { enrich },
        );
        return ok({
          ...result,
          entry: serializeEntry(result.entry, { body: false }),
          enrichment: result.enrichment ? { ...result.enrichment, entry: undefined } : undefined,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "set_status",
    {
      title: "Set status",
      description:
        "Move an entry between draft, review, published and archived. Publishing runs the audit gate and is refused below the configured score unless force is true. Always get the user's explicit go-ahead before publishing or archiving.",
      inputSchema: {
        collection: collectionArg,
        slug: slugArg,
        status: StatusSchema,
        force: z.boolean().default(false),
      },
      outputSchema: z.looseObject({ entry: Loose, blocked: z.string().optional() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ collection, slug, status, force }) => {
      try {
        const result = await cms.setStatus(collection, slug, status, { force });
        return ok(
          { ...result, entry: serializeEntry(result.entry, { body: false }) },
          result.blocked ? `Blocked: ${result.blocked}` : undefined,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "delete_content",
    {
      title: "Delete content",
      description:
        "Permanently delete an entry's file. Requires confirm: true, which you may only pass after the user explicitly agreed to delete this specific entry. Prefer status archived.",
      inputSchema: {
        collection: collectionArg,
        slug: slugArg,
        confirm: z.boolean().describe("Must be true; only after explicit user confirmation"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ collection, slug, confirm }) => {
      if (!confirm)
        return fail(
          new CmsError(
            "BLOCKED",
            "Deletion requires confirm: true after the user explicitly agreed. Consider set_status archived instead.",
          ),
        );
      try {
        return ok(await cms.delete(collection, slug));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ------------------------------------------------------------------ metadata

  server.registerTool(
    "enrich_metadata",
    {
      title: "Enrich metadata",
      description:
        "Generate or refresh metadata for one entry (slug) or every entry in a collection (omit slug) or the whole site (omit both). Fields: description, excerpt, category, tags, keywords, social, aeo, schema, related, readingTime. Human-written values are kept unless force is true. If a result contains delegated, produce that JSON yourself and call submit_metadata.",
      inputSchema: {
        collection: collectionArg.optional(),
        slug: slugArg.optional(),
        fields: z.array(metadataFieldArg).optional(),
        force: z.boolean().default(false),
        deterministicOnly: z
          .boolean()
          .default(false)
          .describe("Skip the model even if one is available"),
        status: StatusSchema.optional().describe(
          "When enriching many entries, limit to this status",
        ),
      },
      outputSchema: z.looseObject({ results: z.array(Loose) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ collection, slug, fields, force, deterministicOnly, status }) => {
      try {
        const opts = { fields, force, deterministicOnly };
        const results =
          collection && slug
            ? [await cms.enrich(collection, slug, opts)]
            : await cms.enrichAll({ ...opts, collection, status });
        return ok({
          results: results.map((r) => ({
            ...r,
            entry: summarizeEntry(r.entry),
            frontmatter: r.entry.frontmatter,
          })),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "submit_metadata",
    {
      title: "Submit metadata",
      description:
        "Apply metadata you generated yourself (after a delegated task). metadata must match the JSON schema given in delegated.schema: seoTitle, description, excerpt, focusKeyword, keywords, category, tags, social{ogTitle,ogDescription,twitterTitle,twitterDescription,linkedinPost,xPost}, aeo{answer,keyTakeaways,faq[{question,answer}],questions}, imageAlt, reviewNotes.",
      inputSchema: {
        collection: collectionArg,
        slug: slugArg,
        metadata: Loose,
        fields: z.array(metadataFieldArg).optional(),
      },
      outputSchema: z.looseObject({ entry: Loose, generated: z.array(z.string()) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ collection, slug, metadata, fields }) => {
      try {
        const r = await cms.submitMetadata(collection, slug, metadata, fields);
        return ok({ ...r, entry: summarizeEntry(r.entry), frontmatter: r.entry.frontmatter });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ------------------------------------------------------------------ analysis

  server.registerTool(
    "audit_content",
    {
      title: "Audit content",
      description:
        "Score an entry (or every entry when slug is omitted) for SEO, AEO (answer-engine readiness), readability, links and freshness. Each failed check carries a concrete fix. publishable tells you whether set_status published would be accepted.",
      inputSchema: {
        collection: collectionArg.optional(),
        slug: slugArg.optional(),
        status: StatusSchema.optional(),
      },
      outputSchema: z.looseObject({ results: z.array(Loose) }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ collection, slug, status }) => {
      try {
        if (collection && slug) {
          const a = await cms.audit(collection, slug);
          return ok({ results: [a] }, `${a.summary}\n\n${JSON.stringify(a, null, 2)}`);
        }
        const results = await cms.auditAll({ collection, status });
        const compact = results.map((a) => ({
          collection: a.collection,
          slug: a.slug,
          title: a.title,
          status: a.status,
          scores: a.scores,
          publishable: a.publishable,
          topIssues: a.failed.slice(0, 3).map((c) => c.message),
        }));
        return ok({ results: compact });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "improve_content",
    {
      title: "Improve content",
      description:
        "Prioritised improvement plan for one entry: audit fixes, internal link candidates, FAQ and question candidates (from the content and from competitor pages on the same topic), thin sections, and competitor benchmarks. Apply the plan with update_content.",
      inputSchema: { collection: collectionArg, slug: slugArg },
      outputSchema: z.looseObject({ steps: z.array(Loose), summary: z.string() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ collection, slug }) => {
      try {
        return ok(await cms.improve(collection, slug));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "suggest_content",
    {
      title: "Suggest content",
      description:
        "Content ideas with evidence: topic gaps versus competitors, questions competitors answer that the site does not, thin topic clusters to build into series, stale entries to refresh, short entries to expand, internal links to add, and AEO structure fixes. When a model is available the ideas come with outlines. Pass focus to narrow to a theme.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(15),
        focus: z.string().optional(),
        useAi: z.boolean().default(true),
      },
      outputSchema: z.looseObject({ suggestions: z.array(Loose) }),
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ limit, focus, useAi }) => {
      try {
        return ok({ suggestions: await cms.suggest({ limit, focus, useAi }) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "validate_content",
    {
      title: "Validate content",
      description:
        "Check every content file against the frontmatter schema, collection field definitions, taxonomy policy, duplicate slugs and ids.",
      inputSchema: {},
      outputSchema: z.looseObject({ ok: z.boolean(), issues: z.array(Loose) }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const issues = await cms.validate();
        return ok({ ok: !issues.some((i) => i.severity === "error"), issues });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ------------------------------------------------------------------ research

  server.registerTool(
    "add_competitor",
    {
      title: "Add competitor",
      description:
        "Track a competitor site for research. Pass the URL of their blog or content hub (e.g. https://example.com/blog) so only that section is analysed. Follow up with research_competitors to crawl it.",
      inputSchema: {
        url: z.url(),
        name: z.string().optional(),
        notes: z.string().optional().describe("Why this competitor matters"),
      },
      outputSchema: z.looseObject({ host: z.string() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ url, name, notes }) => {
      try {
        return ok(await cms.addCompetitor(url, { name, notes }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_competitors",
    {
      title: "List competitors",
      description:
        "Tracked competitor sites with their last crawl date, page counts and what was new in the last refresh.",
      inputSchema: {},
      outputSchema: z.looseObject({ competitors: z.array(Loose) }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const list = await cms.research.list();
        return ok({
          competitors: list.map((c) => ({
            host: c.host,
            url: c.url,
            name: c.name,
            notes: c.notes,
            addedAt: c.addedAt,
            lastFetched: c.latest?.fetchedAt,
            pages: c.latest?.pages.length ?? 0,
            lastRefresh: c.history[c.history.length - 1],
            errors: c.latest?.errors ?? [],
          })),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "research_competitors",
    {
      title: "Research competitors",
      description:
        "Crawl one tracked competitor (host) or all of them: discovers sitemaps, fetches the most recent pages politely, extracts titles, headings, word counts, dates, structured data and FAQ usage, and records which pages are new since the last run. Takes a few seconds per page. Then call compare_competitors.",
      inputSchema: {
        host: z
          .string()
          .optional()
          .describe("Competitor host as returned by list_competitors; omit for all"),
        maxPages: z.number().int().min(1).max(200).optional(),
        onlyStale: z
          .boolean()
          .default(false)
          .describe("Skip competitors refreshed within research.refreshAfterDays"),
      },
      outputSchema: z.looseObject({ results: z.array(Loose) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ host, maxPages, onlyStale }) => {
      try {
        if (host) {
          const { record, snapshot } = await cms.refreshCompetitor(host, {
            maxPages,
            onProgress: progress,
          });
          return ok({
            results: [
              {
                host,
                pages: snapshot.pages.length,
                discovered: snapshot.discovered,
                newPages: record.history[record.history.length - 1]?.newPages ?? [],
                errors: snapshot.errors,
                sample: snapshot.pages.slice(0, 5).map((p) => ({
                  title: p.title,
                  url: p.url,
                  publishedAt: p.publishedAt,
                  wordCount: p.wordCount,
                })),
              },
            ],
          });
        }
        return ok({
          results: await cms.refreshAllCompetitors({ maxPages, onlyStale, onProgress: progress }),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "compare_competitors",
    {
      title: "Compare competitors",
      description:
        "Compare the site with tracked competitors: publishing cadence, average depth, FAQ and structured-data usage, topic gaps (what they cover that we do not) and a ranked list of opportunities with evidence. Requires research_competitors to have run.",
      inputSchema: {},
      outputSchema: z.looseObject({
        gaps: z.array(Loose),
        opportunities: z.array(Loose),
        summary: z.string(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return ok(await cms.compare());
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "remove_competitor",
    {
      title: "Remove competitor",
      description: "Stop tracking a competitor and delete its research snapshots.",
      inputSchema: { host: z.string() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ host }) => {
      try {
        await cms.removeCompetitor(host);
        return ok({ removed: host });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ------------------------------------------------------------------ build & config

  server.registerTool(
    "build_site",
    {
      title: "Build site",
      description:
        "Write the static output: JSON content API per collection and entry (with HTML, text, TOC and JSON-LD), site.json, taxonomy.json, RSS/Atom/JSON feeds, sitemap.xml, llms.txt and llms-full.txt, search-index.json and a suggested robots.txt. Only published entries are included unless includeDrafts is true.",
      inputSchema: {
        outDir: z
          .string()
          .optional()
          .describe("Override build.outDir (relative to the project root)"),
        includeDrafts: z.boolean().optional(),
      },
      outputSchema: z.looseObject({
        outDir: z.string(),
        entries: z.number(),
        files: z.array(Loose),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ outDir, includeDrafts }) => {
      try {
        const m = await cms.build({ outDir, includeDrafts });
        return ok(
          m,
          `Built ${m.entries} entries into ${m.outDir} (${m.files.length} files).${m.warnings.length ? `\nWarnings: ${m.warnings.join("; ")}` : ""}`,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_config",
    {
      title: "Get config",
      description:
        "The project configuration: site identity, collections (names, kinds, paths, URL patterns, custom fields, metadata policy), taxonomy, AI provider settings, research settings, SEO thresholds and build options. Also reports the active AI mode.",
      inputSchema: {},
      outputSchema: z.looseObject({ config: Loose, ai: Loose }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      ok({
        root: cms.root,
        config: cms.config,
        ai:
          cms.ai.mode === "provider"
            ? { mode: "provider", provider: cms.ai.provider.name, model: cms.ai.provider.model }
            : { mode: cms.ai.mode, reason: cms.ai.reason },
      }),
  );

  server.registerTool(
    "update_config",
    {
      title: "Update config",
      description:
        "Deep-merge a patch into agentcms.config.json (arrays are replaced, null deletes a key). Use it to set site details, add taxonomy categories, add collections, change thresholds or the AI provider. Confirm structural changes (collections, paths) with the user.",
      inputSchema: { patch: Loose },
      outputSchema: z.looseObject({ config: Loose }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ patch }) => {
      try {
        return ok({ config: await cms.updateConfig(patch) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ------------------------------------------------------------------ resources

  server.registerResource(
    "guide",
    "agentcms://guide",
    {
      title: "Agent guide",
      description: "How to work with this CMS: workflow, writing rules, frontmatter reference.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: AGENT_GUIDE }],
    }),
  );
  server.registerResource(
    "config",
    "agentcms://config",
    { title: "Configuration", mimeType: "application/json" },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "application/json", text: JSON.stringify(cms.config, null, 2) },
      ],
    }),
  );
  server.registerResource(
    "briefing",
    "agentcms://briefing",
    {
      title: "Briefing",
      description: "Current site status and next actions.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await cms.briefing(), null, 2),
        },
      ],
    }),
  );
  server.registerResource(
    "content",
    new ResourceTemplate("agentcms://content/{collection}/{slug}", {
      list: async () => {
        const entries = await cms.store.all({ limit: 200 });
        return {
          resources: entries.map((e) => ({
            uri: `agentcms://content/${e.collection}/${e.slug}`,
            name: `${e.collection}/${e.slug}`,
            title: e.frontmatter.title,
            description: e.frontmatter.description,
            mimeType: "text/markdown",
          })),
        };
      },
      complete: {
        collection: async (value) =>
          cms.store
            .collections()
            .map((c) => c.name)
            .filter((n) => n.startsWith(value)),
        slug: async (value, ctx) => {
          const collection = ctx?.arguments?.collection;
          const entries = collection ? await cms.list(collection) : await cms.store.all();
          return entries
            .map((e) => e.slug)
            .filter((s) => s.startsWith(value))
            .slice(0, 50);
        },
      },
    }),
    {
      title: "Content entry",
      description: "Raw Markdown file (frontmatter + body) of an entry.",
      mimeType: "text/markdown",
    },
    async (uri, { collection, slug }) => {
      const entry = await cms.get(String(collection), String(slug));
      const { stringifyFrontmatter } = await import("../core/content/frontmatter.ts");
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: stringifyFrontmatter(entry.frontmatter, entry.body),
          },
        ],
      };
    },
  );
  server.registerResource(
    "schema",
    new ResourceTemplate("agentcms://schema/{collection}", {
      list: async () => ({
        resources: cms.store.collections().map((c) => ({
          uri: `agentcms://schema/${c.name}`,
          name: `schema/${c.name}`,
          title: `${c.label ?? c.name} schema`,
          mimeType: "application/json",
        })),
      }),
    }),
    {
      title: "Collection schema",
      description:
        "JSON Schema for an entry's frontmatter in this collection, including custom fields.",
      mimeType: "application/json",
    },
    async (uri, { collection }) => {
      const c = cms.store.collection(String(collection));
      const base = z.toJSONSchema(EntryFrontmatterSchema) as Record<string, unknown>;
      const custom = Object.fromEntries(
        c.fields.map((f) => [
          f.name,
          {
            type:
              f.type === "number"
                ? "number"
                : f.type === "boolean"
                  ? "boolean"
                  : f.type === "list"
                    ? "array"
                    : f.type === "object"
                      ? "object"
                      : "string",
            description: f.description,
            enum: f.values,
          },
        ]),
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                collection: c,
                frontmatterSchema: {
                  ...base,
                  properties: { ...(base.properties as Record<string, unknown>), ...custom },
                },
                inputSchema: z.toJSONSchema(EntryInputSchema),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  registerPrompts(server, cms);
  registerTemplateTools(server, cms);
  return server;
}
