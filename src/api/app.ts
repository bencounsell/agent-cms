import { randomUUID } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context } from "hono";
import type { Cms } from "../core/cms.ts";
import { EntryInputSchema, METADATA_FIELDS, StatusSchema } from "../core/content/schema.ts";
import { serializeEntry, summarizeEntry } from "../core/serialize.ts";
import { CmsError, type CmsErrorCode } from "../core/util/errors.ts";
import { log } from "../core/util/log.ts";
import { createMcpServer, SERVER_VERSION } from "../mcp/server.ts";

export interface ApiOptions {
  /** Bearer token; defaults to AGENTCMS_API_TOKEN. */
  token?: string;
  /** Require the token even for loopback clients (AGENTCMS_REQUIRE_TOKEN=1). */
  requireToken?: boolean;
}

const statusFor: Record<CmsErrorCode, number> = {
  NOT_FOUND: 404,
  VALIDATION: 400,
  CONFLICT: 409,
  BLOCKED: 409,
  UNSUPPORTED: 501,
  NETWORK: 502,
  CONFIG: 500,
  AI_UNAVAILABLE: 503,
};
const Loose = z.looseObject({});
const json = (schema: z.ZodTypeAny, description = "OK") => ({
  content: { "application/json": { schema } },
  description,
});
const ErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});

function isLoopback(c: Context): boolean {
  try {
    const addr = getConnInfo(c).remote.address ?? "";
    return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  } catch {
    return false;
  }
}

export function createApp(cms: Cms, opts: ApiOptions = {}): OpenAPIHono {
  const token = opts.token ?? process.env.AGENTCMS_API_TOKEN;
  const requireToken = opts.requireToken ?? process.env.AGENTCMS_REQUIRE_TOKEN === "1";
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json(
          {
            error: { code: "VALIDATION", message: "Invalid request", details: result.error.issues },
          },
          400,
        );
    },
  });

  app.onError((err, c) => {
    if (err instanceof CmsError) return c.json({ error: err.toJSON() }, statusFor[err.code] as 400);
    log.error("api error", err);
    return c.json({ error: { code: "INTERNAL", message: err.message } }, 500);
  });

  app.use("*", async (c, next) => {
    if (c.req.path === "/health" || c.req.path === "/openapi.json") return next();
    if (token) {
      const header = c.req.header("authorization") ?? "";
      const presented = header.startsWith("Bearer ") ? header.slice(7) : c.req.header("x-api-key");
      if (presented === token) return next();
      if (!requireToken && isLoopback(c) && !presented) return next();
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Missing or invalid bearer token" } },
        401,
      );
    }
    if (requireToken)
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "AGENTCMS_API_TOKEN is not configured" } },
        401,
      );
    return next();
  });

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "agentcms API",
      version: SERVER_VERSION,
      description:
        "Agent-first headless CMS. Every operation available to MCP agents is also available here. The MCP Streamable HTTP endpoint is mounted at /mcp.",
    },
    tags: [
      { name: "content" },
      { name: "metadata" },
      { name: "analysis" },
      { name: "insights" },
      { name: "research" },
      { name: "build" },
      { name: "config" },
    ],
  });

  app.get("/health", (c) =>
    c.json({ ok: true, version: SERVER_VERSION, root: cms.root, ai: cms.ai.mode }),
  );

  // ------------------------------------------------------------------ content
  const collectionParam = z.object({ collection: z.string() });
  const entryParams = z.object({ collection: z.string(), slug: z.string() });

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/content/{collection}",
      tags: ["content"],
      summary: "List entries",
      request: {
        params: collectionParam,
        query: z.object({
          status: StatusSchema.optional(),
          tag: z.string().optional(),
          category: z.string().optional(),
          author: z.string().optional(),
          q: z.string().optional(),
          limit: z.coerce.number().int().optional(),
          offset: z.coerce.number().int().optional(),
          sort: z.enum(["publishedAt", "updatedAt", "title", "slug"]).optional(),
          order: z.enum(["asc", "desc"]).optional(),
        }),
      },
      responses: {
        200: json(z.object({ total: z.number(), entries: z.array(Loose) })),
        404: json(ErrorSchema, "Unknown collection"),
      },
    }),
    async (c) => {
      const { collection } = c.req.valid("param");
      const { q, ...rest } = c.req.valid("query");
      const entries = await cms.list(collection, { ...rest, query: q });
      return c.json({ total: entries.length, entries: entries.map(summarizeEntry) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/content/{collection}",
      tags: ["content"],
      summary: "Create an entry (metadata generated automatically)",
      request: {
        params: collectionParam,
        body: {
          content: {
            "application/json": {
              schema: EntryInputSchema.extend({
                title: z.string().min(1),
                enrich: z.boolean().optional(),
              }),
            },
          },
        },
      },
      responses: { 201: json(Loose), 409: json(ErrorSchema, "Slug exists") },
    }),
    async (c) => {
      const { collection } = c.req.valid("param");
      const { enrich, ...input } = c.req.valid("json");
      const r = await cms.create(collection, input, { enrich });
      return c.json({ ...r, entry: serializeEntry(r.entry) }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/content/{collection}/{slug}",
      tags: ["content"],
      summary: "Get an entry",
      request: { params: entryParams },
      responses: { 200: json(Loose), 404: json(ErrorSchema) },
    }),
    async (c) => {
      const { collection, slug } = c.req.valid("param");
      return c.json(serializeEntry(await cms.get(collection, slug)), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/content/{collection}/{slug}",
      tags: ["content"],
      summary: "Update an entry",
      request: {
        params: entryParams,
        body: {
          content: {
            "application/json": {
              schema: EntryInputSchema.extend({ enrich: z.boolean().optional() }),
            },
          },
        },
      },
      responses: { 200: json(Loose), 404: json(ErrorSchema) },
    }),
    async (c) => {
      const { collection, slug } = c.req.valid("param");
      const { enrich, ...patch } = c.req.valid("json");
      const r = await cms.update(collection, slug, patch, { enrich });
      return c.json({ ...r, entry: serializeEntry(r.entry) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/content/{collection}/{slug}",
      tags: ["content"],
      summary: "Delete an entry",
      request: { params: entryParams },
      responses: { 200: json(z.object({ deleted: z.string() })), 404: json(ErrorSchema) },
    }),
    async (c) => {
      const { collection, slug } = c.req.valid("param");
      return c.json(await cms.delete(collection, slug), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/content/{collection}/{slug}/status",
      tags: ["content"],
      summary: "Change status (publishing runs the audit gate)",
      request: {
        params: entryParams,
        body: {
          content: {
            "application/json": {
              schema: z.object({ status: StatusSchema, force: z.boolean().optional() }),
            },
          },
        },
      },
      responses: { 200: json(Loose), 409: json(Loose, "Blocked by the audit gate") },
    }),
    async (c) => {
      const { collection, slug } = c.req.valid("param");
      const { status, force } = c.req.valid("json");
      const r = await cms.setStatus(collection, slug, status, { force });
      return c.json(
        { ...r, entry: serializeEntry(r.entry, { body: false }) },
        r.blocked ? 409 : 200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/search",
      tags: ["content"],
      summary: "Full-text search",
      request: {
        query: z.object({
          q: z.string(),
          collection: z.string().optional(),
          status: StatusSchema.optional(),
          limit: z.coerce.number().int().optional(),
        }),
      },
      responses: { 200: json(z.object({ hits: z.array(Loose) })) },
    }),
    async (c) => {
      const { q, ...rest } = c.req.valid("query");
      return c.json({ hits: await cms.search(q, rest) }, 200);
    },
  );

  // ------------------------------------------------------------------ metadata & analysis
  const fieldsSchema = z.array(z.enum(METADATA_FIELDS)).optional();

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/content/{collection}/{slug}/enrich",
      tags: ["metadata"],
      summary: "Generate metadata for an entry",
      request: {
        params: entryParams,
        body: {
          content: {
            "application/json": {
              schema: z.object({
                fields: fieldsSchema,
                force: z.boolean().optional(),
                deterministicOnly: z.boolean().optional(),
              }),
            },
          },
          required: false,
        },
      },
      responses: { 200: json(Loose) },
    }),
    async (c) => {
      const { collection, slug } = c.req.valid("param");
      const body = c.req.valid("json") ?? {};
      const r = await cms.enrich(collection, slug, body);
      return c.json({ ...r, entry: serializeEntry(r.entry) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/content/{collection}/{slug}/metadata",
      tags: ["metadata"],
      summary: "Submit agent-generated metadata (delegate mode)",
      request: {
        params: entryParams,
        body: {
          content: {
            "application/json": { schema: z.object({ metadata: Loose, fields: fieldsSchema }) },
          },
        },
      },
      responses: { 200: json(Loose), 400: json(ErrorSchema) },
    }),
    async (c) => {
      const { collection, slug } = c.req.valid("param");
      const { metadata, fields } = c.req.valid("json");
      const r = await cms.submitMetadata(collection, slug, metadata, fields);
      return c.json({ ...r, entry: serializeEntry(r.entry) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/enrich",
      tags: ["metadata"],
      summary: "Generate metadata for many entries",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                collection: z.string().optional(),
                status: StatusSchema.optional(),
                fields: fieldsSchema,
                force: z.boolean().optional(),
                deterministicOnly: z.boolean().optional(),
              }),
            },
          },
          required: false,
        },
      },
      responses: { 200: json(z.object({ results: z.array(Loose) })) },
    }),
    async (c) => {
      const results = await cms.enrichAll(c.req.valid("json") ?? {});
      return c.json(
        { results: results.map((r) => ({ ...r, entry: summarizeEntry(r.entry) })) },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/content/{collection}/{slug}/audit",
      tags: ["analysis"],
      summary: "Audit an entry",
      request: { params: entryParams },
      responses: { 200: json(Loose) },
    }),
    async (c) => {
      const { collection, slug } = c.req.valid("param");
      return c.json(await cms.audit(collection, slug), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/audit",
      tags: ["analysis"],
      summary: "Audit all entries",
      request: {
        query: z.object({ collection: z.string().optional(), status: StatusSchema.optional() }),
      },
      responses: { 200: json(z.object({ results: z.array(Loose) })) },
    }),
    async (c) => c.json({ results: await cms.auditAll(c.req.valid("query")) }, 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/content/{collection}/{slug}/improve",
      tags: ["analysis"],
      summary: "Improvement plan for an entry",
      request: { params: entryParams },
      responses: { 200: json(Loose) },
    }),
    async (c) => {
      const { collection, slug } = c.req.valid("param");
      return c.json(await cms.improve(collection, slug), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/validate",
      tags: ["analysis"],
      summary: "Validate all content files",
      responses: { 200: json(z.object({ ok: z.boolean(), issues: z.array(Loose) })) },
    }),
    async (c) => {
      const issues = await cms.validate();
      return c.json({ ok: !issues.some((i) => i.severity === "error"), issues }, 200);
    },
  );

  // ------------------------------------------------------------------ insights
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/briefing",
      tags: ["insights"],
      summary: "Site briefing with next actions",
      responses: { 200: json(Loose) },
    }),
    async (c) => c.json(await cms.briefing(), 200),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/suggestions",
      tags: ["insights"],
      summary: "Content suggestions",
      request: {
        query: z.object({
          limit: z.coerce.number().int().optional(),
          focus: z.string().optional(),
          ai: z.enum(["true", "false"]).optional(),
        }),
      },
      responses: { 200: json(z.object({ suggestions: z.array(Loose) })) },
    }),
    async (c) => {
      const { limit, focus, ai } = c.req.valid("query");
      return c.json(
        { suggestions: await cms.suggest({ limit, focus, useAi: ai !== "false" }) },
        200,
      );
    },
  );

  // ------------------------------------------------------------------ research
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/competitors",
      tags: ["research"],
      summary: "Tracked competitors",
      responses: { 200: json(z.object({ competitors: z.array(Loose) })) },
    }),
    async (c) => {
      const list = await cms.research.list();
      return c.json(
        {
          competitors: list.map((r) => ({
            host: r.host,
            url: r.url,
            name: r.name,
            notes: r.notes,
            addedAt: r.addedAt,
            lastFetched: r.latest?.fetchedAt,
            pages: r.latest?.pages.length ?? 0,
            history: r.history,
          })),
        },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/competitors",
      tags: ["research"],
      summary: "Track a competitor",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                url: z.url(),
                name: z.string().optional(),
                notes: z.string().optional(),
              }),
            },
          },
        },
      },
      responses: { 201: json(Loose) },
    }),
    async (c) => {
      const { url, ...meta } = c.req.valid("json");
      return c.json(await cms.addCompetitor(url, meta), 201);
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/competitors/{host}/refresh",
      tags: ["research"],
      summary: "Crawl a competitor",
      request: {
        params: z.object({ host: z.string() }),
        body: {
          content: {
            "application/json": { schema: z.object({ maxPages: z.number().int().optional() }) },
          },
          required: false,
        },
      },
      responses: { 200: json(Loose) },
    }),
    async (c) => {
      const { host } = c.req.valid("param");
      const { record, snapshot } = await cms.refreshCompetitor(host, {
        maxPages: c.req.valid("json")?.maxPages,
      });
      return c.json(
        {
          host,
          pages: snapshot.pages.length,
          discovered: snapshot.discovered,
          newPages: record.history.at(-1)?.newPages ?? [],
          errors: snapshot.errors,
        },
        200,
      );
    },
  );
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/competitors/refresh",
      tags: ["research"],
      summary: "Crawl all competitors",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                maxPages: z.number().int().optional(),
                onlyStale: z.boolean().optional(),
              }),
            },
          },
          required: false,
        },
      },
      responses: { 200: json(z.object({ results: z.array(Loose) })) },
    }),
    async (c) =>
      c.json({ results: await cms.refreshAllCompetitors(c.req.valid("json") ?? {}) }, 200),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/competitors/compare",
      tags: ["research"],
      summary: "Compare against competitors",
      responses: { 200: json(Loose), 404: json(ErrorSchema) },
    }),
    async (c) => c.json(await cms.compare(), 200),
  );
  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/competitors/{host}",
      tags: ["research"],
      summary: "Stop tracking a competitor",
      request: { params: z.object({ host: z.string() }) },
      responses: { 200: json(z.object({ removed: z.string() })) },
    }),
    async (c) => {
      const { host } = c.req.valid("param");
      await cms.removeCompetitor(host);
      return c.json({ removed: host }, 200);
    },
  );

  // ------------------------------------------------------------------ build & config
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/build",
      tags: ["build"],
      summary: "Write static output",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({
                outDir: z.string().optional(),
                includeDrafts: z.boolean().optional(),
              }),
            },
          },
          required: false,
        },
      },
      responses: { 200: json(Loose) },
    }),
    async (c) => c.json(await cms.build(c.req.valid("json") ?? {}), 200),
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/config",
      tags: ["config"],
      summary: "Project configuration",
      responses: { 200: json(Loose) },
    }),
    (c) =>
      c.json(
        {
          root: cms.root,
          config: cms.config,
          ai:
            cms.ai.mode === "provider"
              ? { mode: "provider", provider: cms.ai.provider.name, model: cms.ai.provider.model }
              : { mode: cms.ai.mode, reason: cms.ai.reason },
        },
        200,
      ),
  );
  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/config",
      tags: ["config"],
      summary: "Deep-merge a patch into the configuration",
      request: { body: { content: { "application/json": { schema: Loose } } } },
      responses: { 200: json(Loose), 400: json(ErrorSchema) },
    }),
    async (c) => c.json({ config: await cms.updateConfig(c.req.valid("json")) }, 200),
  );

  // ------------------------------------------------------------------ MCP over Streamable HTTP (stateful sessions)
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  app.all("/mcp", async (c) => {
    const sessionId = c.req.header("mcp-session-id");
    let transport = sessionId ? sessions.get(sessionId) : undefined;
    if (!transport) {
      if (sessionId)
        return c.json(
          { jsonrpc: "2.0", error: { code: -32001, message: "Unknown session" }, id: null },
          404,
        );
      if (c.req.method !== "POST")
        return c.json(
          {
            jsonrpc: "2.0",
            error: { code: -32000, message: "Initialize with POST first" },
            id: null,
          },
          400,
        );
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport!);
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });
      const server = createMcpServer(cms);
      await server.connect(transport);
    }
    return transport.handleRequest(c.req.raw);
  });

  return app;
}
