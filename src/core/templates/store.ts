import path from "node:path";
import type { Liquid } from "liquidjs";
import type { CmsConfig } from "../config/schema.ts";
import { CmsError } from "../util/errors.ts";
import { exists, listFiles, readText, remove, writeText } from "../util/fs.ts";
import type { RenderContext, SiteModel } from "./context.ts";
import { baseContext } from "./context.ts";
import { createEngine } from "./engine.ts";
import { renderHead } from "./head.ts";
import { type PlannedRoute, planRoutes } from "./pages.ts";
import { BUNDLED_THEME_DIR, type TemplateKind, templateKind } from "./paths.ts";

export interface TemplateInfo {
  path: string;
  kind: TemplateKind;
  /** "project" when the file exists in the project, "default" when only the bundled theme has it. */
  origin: "project" | "default";
  /** True when a project file shadows a bundled one. */
  overridesDefault: boolean;
  purpose?: string;
  bytes: number;
  routes: string[];
}

export interface TemplateDetail extends TemplateInfo {
  source: string;
  defaultSource?: string;
  variables: string[];
  sampleContext?: Record<string, unknown>;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface WriteResult extends ValidationResult {
  path: string;
  diff: string;
  previewPath?: string;
}

const KNOWN_VARIABLES: Record<Exclude<TemplateKind, "asset">, string[]> = {
  layout: [
    "site",
    "theme",
    "page",
    "assets",
    "head",
    "build",
    "entry",
    "entries",
    "collection",
    "taxonomy",
  ],
  page: [
    "site",
    "theme",
    "page",
    "assets",
    "head",
    "build",
    "entry",
    "author",
    "related",
    "entries",
    "pagination",
    "collection",
    "term",
    "terms",
    "taxonomy",
    "forloop",
  ],
  partial: [
    "site",
    "theme",
    "page",
    "assets",
    "head",
    "build",
    "entry",
    "author",
    "related",
    "entries",
    "pagination",
    "collection",
    "term",
    "terms",
    "taxonomy",
    "forloop",
    "item",
    "tag",
  ],
};

const VARIABLE_DOCS: Record<string, string> = {
  site: "site.name, url, description, language, nav[{label,url}], dataPath, searchCollection, feeds, llmsTxt, social, organization",
  theme:
    "theme.colors, dark, fonts, layout, features{darkMode,toc,answerBox,takeaways,faq,authorCard,related,search}, footer.text",
  page: "page.kind (home|entry|collection|term|taxonomy|404), title, description, path, url, language",
  entry:
    "entry.title, slug, path, url, description, excerpt, image, imageAlt, publishedAt, updatedAt, author, category, categoryUrl, tags, tagLinks[{name,url}], readingTime, wordCount, html (use | raw), text, toc[{depth,text,id}], headings, seo, social, aeo{answer,keyTakeaways,faq,questions}, answerIsLead, sources, related, custom",
  author: "author.title, path, url, description, image (null when the entry has no author entry)",
  related:
    "related[]: entry summaries (title, path, url, description, image, publishedAt, category, tags, readingTime)",
  entries: "entries[]: entry summaries for the current list",
  pagination: "pagination.page, totalPages, perPage, total, prevUrl, nextUrl, pages[{number,url}]",
  collection: "collection.name, label, description, url, kind",
  term: "term.kind (tag|category), name, url, count",
  terms: "terms[{name,url,count}] on taxonomy index pages",
  taxonomy: "taxonomy.categories[{name,url,count}], taxonomy.tags[{name,url,count}]",
  assets: "assets['styles.css'] etc.: hashed public paths of theme assets",
  head: "the generated SEO head block; place it with {{ head | raw }} inside <head>",
  build: "build.generatedAt, year, version",
};

const HEAD_RE = /\{\{-?\s*head\s*\|\s*raw\s*-?\}\}/;

/** Manages the project's templates/ directory with the bundled theme as the fallback layer. */
export class TemplateStore {
  readonly dir: string;
  private readonly config: CmsConfig;

  constructor(root: string, config: CmsConfig) {
    this.dir = path.join(root, config.build.html.templatesDir);
    this.config = config;
  }

  get roots(): string[] {
    return [this.dir, BUNDLED_THEME_DIR];
  }

  engine(opts: { strictVariables?: boolean } = {}): Liquid {
    return createEngine({
      roots: this.roots,
      siteUrl: this.config.site.url,
      strictVariables: opts.strictVariables,
    });
  }

  private async walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const sub of ["layouts", "pages", "partials", "assets"]) {
      for (const f of await listFiles(path.join(dir, sub), [
        ".liquid",
        ".css",
        ".js",
        ".svg",
        ".png",
        ".jpg",
        ".webp",
        ".ico",
        ".woff",
        ".woff2",
      ])) {
        out.push(`${sub}/${path.basename(f)}`);
      }
    }
    return out;
  }

  async list(model?: SiteModel): Promise<TemplateInfo[]> {
    const project = new Set(await this.walk(this.dir));
    const bundled = new Set(await this.walk(BUNDLED_THEME_DIR));
    const routesByTemplate = new Map<string, string[]>();
    if (model) {
      for (const r of await planRoutes(model, this.roots)) {
        const key = `${r.template}.liquid`;
        routesByTemplate.set(key, [...(routesByTemplate.get(key) ?? []), r.path]);
      }
    }
    const all = [...new Set([...project, ...bundled])].sort();
    const infos: TemplateInfo[] = [];
    for (const rel of all) {
      const origin = project.has(rel) ? "project" : "default";
      const file = path.join(origin === "project" ? this.dir : BUNDLED_THEME_DIR, rel);
      const text = await readText(file);
      infos.push({
        path: rel,
        kind: templateKind(rel) ?? "partial",
        origin,
        overridesDefault: origin === "project" && bundled.has(rel),
        purpose: purposeOf(text),
        bytes: Buffer.byteLength(text),
        routes: (routesByTemplate.get(rel) ?? []).slice(0, 8),
      });
    }
    return infos;
  }

  private resolveFile(rel: string): { project: string; bundled: string } {
    const safe = rel.replace(/^\/+/, "").replace(/\.\.(\/|\\|$)/g, "");
    if (!templateKind(safe))
      throw new CmsError(
        "VALIDATION",
        `Template path must start with layouts/, pages/, partials/ or assets/ (got "${rel}")`,
      );
    return { project: path.join(this.dir, safe), bundled: path.join(BUNDLED_THEME_DIR, safe) };
  }

  async get(rel: string, model?: SiteModel): Promise<TemplateDetail> {
    const files = this.resolveFile(rel);
    const inProject = await exists(files.project);
    const inBundle = await exists(files.bundled);
    if (!inProject && !inBundle) throw new CmsError("NOT_FOUND", `No template "${rel}"`);
    const source = await readText(inProject ? files.project : files.bundled);
    const kind = templateKind(rel) ?? "partial";
    const info = (await this.list(model)).find((i) => i.path === rel)!;
    const detail: TemplateDetail = {
      ...info,
      source,
      defaultSource: inProject && inBundle ? await readText(files.bundled) : undefined,
      variables: kind === "asset" ? [] : KNOWN_VARIABLES[kind].map((v) => VARIABLE_DOCS[v] ?? v),
    };
    if (model && kind !== "asset") detail.sampleContext = await this.sampleContext(model, rel);
    return detail;
  }

  /** A compact, real context an agent can read to see what a template receives. */
  async sampleContext(model: SiteModel, rel: string): Promise<Record<string, unknown> | undefined> {
    const route = await this.sampleRoute(model, rel);
    if (!route) return undefined;
    const partial = route.context();
    const ctx: RenderContext = {
      ...baseContext(model, {
        "styles.css": "/assets/styles.hash.css",
        "search.js": "/assets/search.hash.js",
      }),
      ...partial,
      head: "<title>…</title>",
    };
    const compact = (v: unknown, depth = 0): unknown => {
      if (typeof v === "string") return v.length > 160 ? `${v.slice(0, 160)}…` : v;
      if (Array.isArray(v)) return v.slice(0, 3).map((x) => compact(x, depth + 1));
      if (v && typeof v === "object") {
        if (depth > 3) return "{…}";
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, compact(x, depth + 1)]),
        );
      }
      return v;
    };
    return compact(ctx) as Record<string, unknown>;
  }

  async sampleRoute(model: SiteModel, rel: string): Promise<PlannedRoute | undefined> {
    const routes = await planRoutes(model, this.roots);
    const name = rel.replace(/\.liquid$/, "");
    const kind = templateKind(rel);
    if (kind === "page")
      return (
        routes.find((r) => r.template === name) ??
        routes.find((r) => r.kind === "entry") ??
        routes[0]
      );
    return routes.find((r) => r.kind === "entry") ?? routes[0];
  }

  async validate(rel: string, source: string, model?: SiteModel): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const kind = templateKind(rel);
    if (!kind) errors.push("path must start with layouts/, pages/, partials/ or assets/");
    if (kind === "asset") return { ok: true, errors, warnings };
    const engine = this.engine();
    try {
      engine.parse(source);
    } catch (err) {
      errors.push(`Liquid syntax: ${(err as Error).message}`);
      return { ok: false, errors, warnings };
    }
    if (kind === "layout" && !HEAD_RE.test(source)) {
      errors.push("layouts must place the generated SEO block with {{ head | raw }} inside <head>");
    }
    if (kind === "page" && !/\{%-?\s*layout\s/.test(source) && !/<html/i.test(source)) {
      warnings.push('page templates normally start with {% layout "layouts/base" %}');
    }
    if (kind) {
      try {
        // Top-level names this template reads that it does not define itself (partials are
        // analysed on their own when they are written).
        const vars = (await engine.globalVariables(source)).map((v) => String(v));
        const known = new Set([...KNOWN_VARIABLES[kind], ...declaredNames(source)]);
        for (const v of vars) {
          if (!known.has(v))
            warnings.push(
              `"${v}" is not a variable templates receive (known: ${[...known].join(", ")})`,
            );
        }
      } catch {
        // variable analysis is best effort
      }
    }
    if (model && kind === "page") {
      const route = await this.sampleRoute(model, rel);
      if (route) {
        try {
          const partial = route.context();
          const head = renderHead(partial.head, model.config, model.theme);
          const ctx: RenderContext = { ...baseContext(model, {}), ...partial, head };
          const tmp = createEngine({ roots: this.roots, siteUrl: this.config.site.url });
          await tmp.parseAndRender(source, ctx);
        } catch (err) {
          errors.push(`render failed against ${route.path}: ${(err as Error).message}`);
        }
      }
    }
    return { ok: errors.length === 0, errors, warnings };
  }

  async write(rel: string, source: string, model?: SiteModel): Promise<WriteResult> {
    const files = this.resolveFile(rel);
    const validation = await this.validate(rel, source, model);
    if (!validation.ok) {
      return { ...validation, path: rel, diff: "" };
    }
    const before = (await exists(files.project))
      ? await readText(files.project)
      : (await exists(files.bundled))
        ? await readText(files.bundled)
        : "";
    await writeText(files.project, source);
    return { ...validation, path: rel, diff: lineDiff(before, source) };
  }

  async remove(rel: string): Promise<{ removed: string; fallsBackToDefault: boolean }> {
    const files = this.resolveFile(rel);
    if (!(await exists(files.project)))
      throw new CmsError("NOT_FOUND", `"${rel}" is not a project template (nothing to delete)`);
    await remove(files.project);
    return { removed: rel, fallsBackToDefault: await exists(files.bundled) };
  }

  async reset(rel: string): Promise<{ path: string; diff: string }> {
    const files = this.resolveFile(rel);
    if (!(await exists(files.bundled)))
      throw new CmsError("NOT_FOUND", `"${rel}" has no bundled default`);
    const before = (await exists(files.project)) ? await readText(files.project) : "";
    const source = await readText(files.bundled);
    await writeText(files.project, source);
    return { path: rel, diff: lineDiff(before, source) };
  }

  /** Copy the whole bundled theme into the project (used by init). Existing files are kept. */
  async eject(): Promise<string[]> {
    const written: string[] = [];
    for (const rel of await this.walk(BUNDLED_THEME_DIR)) {
      const target = path.join(this.dir, rel);
      if (await exists(target)) continue;
      const { readFile, mkdir, copyFile } = await import("node:fs/promises");
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(BUNDLED_THEME_DIR, rel), target);
      void readFile;
      written.push(path.join(this.config.build.html.templatesDir, rel));
    }
    return written;
  }
}

/** Variable names a template declares itself: for-loop targets, assign, capture, tablerow, increment. */
export function declaredNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/\{%-?\s*(?:for|tablerow)\s+([a-zA-Z_][\w]*)\s+in\b/g))
    names.add(m[1]!);
  for (const m of source.matchAll(
    /\{%-?\s*(?:assign|capture|increment|decrement)\s+([a-zA-Z_][\w]*)/g,
  ))
    names.add(m[1]!);
  return [...names];
}

function purposeOf(text: string): string | undefined {
  const m = text.match(/\{%-?\s*comment\s*-?%\}([\s\S]*?)\{%-?\s*endcomment\s*-?%\}/);
  const body = m?.[1] ?? text.match(/^\/\*([\s\S]*?)\*\//)?.[1];
  return body?.replace(/\s+/g, " ").trim().slice(0, 240);
}

/** Small unified-style line diff (LCS); enough for agents to show what changed. */
export function lineDiff(before: string, after: string, context = 2): string {
  const a = before.split("\n");
  const b = after.split("\n");
  if (before === after) return "";
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const ops: { t: " " | "-" | "+"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) ops.push({ t: "-", line: a[i++]! });
    else ops.push({ t: "+", line: b[j++]! });
  }
  while (i < n) ops.push({ t: "-", line: a[i++]! });
  while (j < m) ops.push({ t: "+", line: b[j++]! });
  const keep = new Set<number>();
  ops.forEach((op, idx) => {
    if (op.t !== " ")
      for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++)
        keep.add(k);
  });
  const out: string[] = [];
  let last = -2;
  ops.forEach((op, idx) => {
    if (!keep.has(idx)) return;
    if (idx !== last + 1) out.push("@@");
    out.push(`${op.t} ${op.line}`);
    last = idx;
  });
  return out.join("\n");
}
