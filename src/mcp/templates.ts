import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Cms } from "../core/cms.ts";
import { CmsError } from "../core/util/errors.ts";
import { log } from "../core/util/log.ts";
import { PREVIEW_APP_URI, previewAppHtml } from "./preview-app.ts";

const Loose = z.looseObject({});

function ok(data: object, text?: string, extra: CallToolResult["content"] = []): CallToolResult {
  return {
    content: [{ type: "text", text: text ?? JSON.stringify(data, null, 2) }, ...extra],
    structuredContent: data as Record<string, unknown>,
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

const pathArg = z
  .string()
  .describe("Template path relative to templates/, e.g. pages/post.liquid or partials/nav.liquid");

/** Tools, resources and prompts for managed templates, themes and previews. */
export function registerTemplateTools(server: McpServer, cms: Cms): void {
  server.registerTool(
    "list_templates",
    {
      title: "List templates",
      description:
        "Every template and theme asset the site renders with: layouts, page templates, partials and assets. origin tells you whether the file lives in the project (editable) or only in the bundled default theme (copied into the project on first edit). routes lists the pages each template renders. Use get_template before editing.",
      inputSchema: {},
      outputSchema: z.looseObject({ templates: z.array(Loose) }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return ok({
          templatesDir: cms.templates.dir,
          htmlEnabled: cms.config.build.html.enabled,
          templates: await cms.templates.list(await cms.siteModel(undefined, true)),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_template",
    {
      title: "Get template",
      description:
        "Read a template's source together with the variables it can use and a sample context taken from a real page, so you edit against actual data. Liquid syntax; every output is HTML-escaped unless piped through `raw` (entry.html and head must use `| raw`).",
      inputSchema: { path: pathArg },
      outputSchema: z.looseObject({ path: z.string(), source: z.string() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ path }) => {
      try {
        return ok(await cms.templates.get(path, await cms.siteModel(undefined, true)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  const writeTool = (name: string, title: string, description: string) =>
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: { path: pathArg, source: z.string().describe("Full template source") },
        outputSchema: z.looseObject({
          ok: z.boolean(),
          errors: z.array(z.string()),
          warnings: z.array(z.string()),
          diff: z.string(),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ path, source }) => {
        try {
          const model = await cms.siteModel(undefined, true);
          const result = await cms.templates.write(path, source, model);
          if (!result.ok) return ok(result, `Rejected ${path}:\n- ${result.errors.join("\n- ")}`);
          let note = "";
          if (path.startsWith("pages/") || path.startsWith("layouts/")) {
            const sample = await cms.templates.sampleRoute(model, path);
            if (sample) {
              const preview = await cms.preview({ path: sample.path });
              note = `\nRendered ${sample.path}: page score ${preview.audit.score}${preview.audit.failed.length ? `; ${preview.audit.failed[0]!.message}` : ""}. Call preview_page to see it, build_site to publish it.`;
            }
          }
          return ok(
            result,
            `Wrote ${path}.${result.warnings.length ? `\nWarnings:\n- ${result.warnings.join("\n- ")}` : ""}${note}\n\nDiff:\n${result.diff || "(no change)"}`,
          );
        } catch (err) {
          return fail(err);
        }
      },
    );
  writeTool(
    "update_template",
    "Update template",
    "Replace a template's source. The source is parsed, checked for unknown variables and (for pages and layouts) rendered against a real page before it is written; syntax errors and layouts without {{ head | raw }} are rejected. Returns a diff to show the user and the rendered page's audit score. Try update_theme first for colours, fonts and layout widths.",
  );
  writeTool(
    "create_template",
    "Create template",
    'Add a new template or partial (same validation as update_template). Name page templates pages/<collection>.liquid to override how one collection renders, or partials/<name>.liquid and render them with {% render "partials/<name>", entry: entry %}.',
  );

  server.registerTool(
    "delete_template",
    {
      title: "Delete template",
      description:
        "Remove a project template. If the bundled theme has the same file the site falls back to it; otherwise pages using it stop rendering. Requires confirm: true after the user agreed.",
      inputSchema: { path: pathArg, confirm: z.boolean() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path, confirm }) => {
      if (!confirm)
        return fail(
          new CmsError(
            "BLOCKED",
            "Deletion requires confirm: true after the user explicitly agreed.",
          ),
        );
      try {
        return ok(await cms.templates.remove(path));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "reset_template",
    {
      title: "Reset template",
      description: "Restore a template to the bundled default theme version. Returns the diff.",
      inputSchema: { path: pathArg },
      outputSchema: z.looseObject({ path: z.string(), diff: z.string() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path }) => {
      try {
        return ok(await cms.templates.reset(path));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_theme",
    {
      title: "Get theme",
      description:
        "Design tokens in theme.json: colours (light and dark palettes), fonts, layout widths, feature flags (toc, answerBox, takeaways, faq, authorCard, related, search, darkMode) and footer text. Change these with update_theme before touching templates or CSS.",
      inputSchema: {},
      outputSchema: z.looseObject({ theme: Loose }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return ok({
          theme: await cms.theme.resolve(),
          projectOverrides: (await cms.theme.project()) ?? null,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "update_theme",
    {
      title: "Update theme",
      description:
        'Deep-merge a patch into theme.json, e.g. { colors: { accent: "#ff0066" }, features: { toc: false } }. Takes effect on the next preview or build.',
      inputSchema: { patch: Loose },
      outputSchema: z.looseObject({ theme: Loose }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ patch }) => {
      try {
        return ok({ theme: await cms.theme.update(patch) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_routes",
    {
      title: "List routes",
      description:
        "Every page the site renders (home, entries, collection lists with pagination, tags, categories, 404) with the template each uses. Use the path with preview_page.",
      inputSchema: { includeDrafts: z.boolean().default(true) },
      outputSchema: z.looseObject({ routes: z.array(Loose) }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ includeDrafts }) => {
      try {
        const routes = await cms.routes({ includeDrafts });
        return ok({ total: routes.length, routes });
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerAppTool(
    server,
    "preview_page",
    {
      title: "Preview page",
      description:
        'Render one page of the site without building: by route path (e.g. "/", "/blog/", "/tags/mcp/") or by collection and slug. Returns a self-contained HTML document (styles inlined, links absolute) that can be shown to the user as an artifact, PNG screenshots at desktop and/or mobile width when headless Chromium is available, and the rendered-page audit. Hosts that support MCP Apps show the page inline in the chat. Look at the screenshot yourself to check layout before telling the user it is done.',
      inputSchema: {
        path: z.string().optional().describe("Route path from list_routes"),
        collection: z.string().optional(),
        slug: z.string().optional(),
        screenshots: z.enum(["none", "desktop", "mobile", "both"]).default("desktop"),
        includeHtml: z
          .boolean()
          .default(true)
          .describe("Include the self-contained HTML in the result"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: PREVIEW_APP_URI } },
    },
    async ({ path, collection, slug, screenshots, includeHtml }) => {
      try {
        if (!path && !(collection && slug))
          throw new CmsError("VALIDATION", "Pass path, or collection and slug.");
        const viewports =
          screenshots === "none"
            ? []
            : screenshots === "both"
              ? (["desktop", "mobile"] as const)
              : ([screenshots] as const);
        const result = await cms.preview(
          { path, collection, slug },
          { screenshots: [...viewports] },
        );
        const images: CallToolResult["content"] = [];
        const shots: Record<string, unknown>[] = [];
        for (const s of result.screenshots) {
          if (s.result.ok) {
            images.push({
              type: "image",
              data: s.result.png.toString("base64"),
              mimeType: "image/png",
            });
            shots.push({
              viewport: s.viewport,
              width: s.result.width,
              height: s.result.height,
              available: true,
            });
          } else {
            shots.push({
              viewport: s.viewport,
              available: false,
              reason: s.result.reason,
              hint: s.result.hint,
            });
          }
        }
        const unavailable = shots.find((s) => s.available === false);
        const summary = [
          `${result.route.path} (${result.route.template}) rendered. Page audit ${result.audit.score}/100.`,
          result.audit.failed.length
            ? `Issues: ${result.audit.failed
                .slice(0, 4)
                .map((c) => c.message)
                .join(" ")}`
            : "No page issues.",
          unavailable
            ? `Screenshots unavailable: ${unavailable.reason}. ${unavailable.hint}`
            : images.length
              ? `${images.length} screenshot(s) attached.`
              : "",
          includeHtml
            ? "structuredContent.html is a self-contained document; open it as an HTML artifact to show the user the page."
            : "",
        ]
          .filter(Boolean)
          .join("\n");
        const data: Record<string, unknown> = {
          route: result.route,
          url: `${cms.config.site.url.replace(/\/+$/, "")}${result.route.path}`,
          audit: {
            score: result.audit.score,
            failed: result.audit.failed.map((c) => ({
              id: c.id,
              severity: c.severity,
              message: c.message,
              fix: c.fix,
            })),
          },
          screenshots: shots,
          html: includeHtml ? result.html : undefined,
        };
        return ok(data, summary, images);
      } catch (err) {
        return fail(err);
      }
    },
  );

  registerAppResource(
    server,
    "preview-app",
    PREVIEW_APP_URI,
    {
      title: "agentcms page preview",
      description: "Interactive preview of a rendered page for hosts that support MCP Apps.",
      mimeType: RESOURCE_MIME_TYPE,
      _meta: {
        ui: {
          prefersBorder: true,
          csp: { resourceDomains: [safeOrigin(cms.config.site.url)].filter(Boolean) as string[] },
        },
      },
    },
    async () => ({
      contents: [
        { uri: PREVIEW_APP_URI, mimeType: RESOURCE_MIME_TYPE, text: await previewAppHtml() },
      ],
    }),
  );

  server.registerTool(
    "audit_pages",
    {
      title: "Audit pages",
      description:
        "Render every route and check the final HTML: title, description, canonical, Open Graph, JSON-LD, single H1, lang, viewport, image alt text, landmarks, internal links that resolve, page weight. Worst pages first.",
      inputSchema: { includeDrafts: z.boolean().default(false) },
      outputSchema: z.looseObject({ results: z.array(Loose) }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ includeDrafts }) => {
      try {
        const results = await cms.auditPages({ includeDrafts });
        return ok({
          total: results.length,
          results: results.map((r) => ({
            path: r.path,
            score: r.score,
            failed: r.failed.map((c) => ({
              id: c.id,
              severity: c.severity,
              message: c.message,
              fix: c.fix,
            })),
          })),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---------------------------------------------------------------- resources

  server.registerResource(
    "template",
    new ResourceTemplate("agentcms://template/{+path}", {
      list: async () => ({
        resources: (await cms.templates.list()).map((t) => ({
          uri: `agentcms://template/${t.path}`,
          name: t.path,
          title: t.path,
          description: t.purpose,
          mimeType:
            t.kind === "asset"
              ? t.path.endsWith(".css")
                ? "text/css"
                : "text/javascript"
              : "text/plain",
        })),
      }),
    }),
    { title: "Template source", description: "A template or theme asset.", mimeType: "text/plain" },
    async (uri, { path }) => {
      const detail = await cms.templates.get(String(path));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType:
              detail.kind === "asset" && detail.path.endsWith(".css") ? "text/css" : "text/plain",
            text: detail.source,
          },
        ],
      };
    },
  );
  server.registerResource(
    "theme",
    "agentcms://theme",
    { title: "Theme tokens", mimeType: "application/json" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await cms.theme.resolve(), null, 2),
        },
      ],
    }),
  );
  server.registerResource(
    "preview",
    new ResourceTemplate("agentcms://preview/{collection}/{slug}", { list: undefined }),
    {
      title: "Rendered page",
      description: "Self-contained HTML of an entry's page.",
      mimeType: "text/html",
    },
    async (uri, { collection, slug }) => {
      const p = await cms.preview({ collection: String(collection), slug: String(slug) });
      return { contents: [{ uri: uri.href, mimeType: "text/html", text: p.html }] };
    },
  );

  // ---------------------------------------------------------------- prompts

  const text = (t: string) => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text: t } }],
  });
  server.registerPrompt(
    "restyle_site",
    {
      title: "Restyle the site",
      description:
        "Change the look of the site from a brief, tokens first, templates second, with previews.",
      argsSchema: {
        brief: z
          .string()
          .describe("What the user wants, e.g. 'warmer colours, serif headings, wider posts'"),
      },
    },
    ({ brief }) =>
      text(`Restyle the site: ${brief}
1. get_theme. Make as much of the change as possible with update_theme (colours, dark palette, fonts, layout widths, feature flags).
2. If templates must change, list_templates then get_template for the ones involved; keep {{ head | raw }} and the semantic structure; update_template with the full source.
3. preview_page the home page and one post (screenshots: both). Look at the screenshots and fix anything broken on mobile.
4. Show the user the before/after summary and the diffs. Ask before build_site.`),
  );
  server.registerPrompt(
    "add_section",
    {
      title: "Add a section to pages",
      description: "Add a new block to a page template, as a partial, with a preview.",
      argsSchema: {
        what: z.string().describe("What to add, e.g. 'newsletter signup box under each post'"),
        where: z.string().optional().describe("Which template or page kind"),
      },
    },
    ({ what, where }) =>
      text(`Add this to the site: ${what}${where ? ` (${where})` : ""}.
1. list_templates and get_template for the target page template; read its sample context so you use real variables.
2. Put the new block in its own partial (create_template partials/<name>.liquid) and render it from the page template with {% render "partials/<name>", entry: entry %}. Style it with CSS variables from the theme in assets/styles.css if needed (get_template assets/styles.css, then update_template).
3. preview_page with screenshots and check the result. Report what changed with the diffs; ask before build_site.`),
  );
  server.registerPrompt(
    "fix_page_audit",
    {
      title: "Fix page audit issues",
      description: "Run audit_pages and fix template-level problems.",
      argsSchema: { path: z.string().optional().describe("Limit to one route path") },
    },
    ({ path }) =>
      text(
        `${path ? `preview_page ${path} and read its audit.` : "Run audit_pages."} Group the failures by cause: entry metadata problems go through update_content or enrich_metadata; template problems (missing landmarks, H1 count, alt attributes, head block) go through update_template. Fix, re-run, and report before/after scores.`,
      ),
  );
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
