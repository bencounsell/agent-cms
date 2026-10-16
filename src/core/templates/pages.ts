import path from "node:path";
import type { Liquid } from "liquidjs";
import { exists, listFiles, readText, sha256 } from "../util/fs.ts";
import { slugify, truncateAtWord } from "../util/text.ts";
import {
  baseContext,
  type EntrySummaryView,
  type EntryView,
  type Pagination,
  type RenderContext,
  type SiteModel,
  summarize,
} from "./context.ts";
import { renderHead } from "./head.ts";
import { BUNDLED_THEME_DIR } from "./paths.ts";

export interface Route {
  kind: RenderContext["page"]["kind"];
  /** URL path, always starting with "/" and ending with "/" except file routes like /404.html. */
  path: string;
  /** Output file relative to the site root. */
  file: string;
  /** Template name without extension, e.g. "pages/post". */
  template: string;
  title: string;
  entry?: { collection: string; slug: string };
}

export interface PlannedRoute extends Route {
  context: () => Omit<
    RenderContext,
    "assets" | "build" | "head" | "site" | "theme" | "taxonomy"
  > & { head: Parameters<typeof renderHead>[0] };
}

function outputFile(p: string): string {
  if (p.endsWith("/")) return `${p.slice(1)}index.html`;
  return p.slice(1);
}

function paginate<T>(
  items: T[],
  basePath: string,
  perPage: number,
): { page: number; items: T[]; path: string; pagination: Pagination }[] {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const urlFor = (n: number) => (n === 1 ? basePath : `${basePath}page/${n}/`);
  const out: { page: number; items: T[]; path: string; pagination: Pagination }[] = [];
  for (let n = 1; n <= totalPages; n++) {
    out.push({
      page: n,
      items: items.slice((n - 1) * perPage, n * perPage),
      path: urlFor(n),
      pagination: {
        page: n,
        totalPages,
        perPage,
        total: items.length,
        prevUrl: n > 1 ? urlFor(n - 1) : undefined,
        nextUrl: n < totalPages ? urlFor(n + 1) : undefined,
        pages: Array.from({ length: totalPages }, (_, i) => ({
          number: i + 1,
          url: urlFor(i + 1),
        })),
      },
    });
  }
  return out;
}

async function templateExists(dirs: string[], name: string): Promise<boolean> {
  for (const d of dirs) if (await exists(path.join(d, `${name}.liquid`))) return true;
  return false;
}

/** Decide every page the site has and the data each one renders with. */
export async function planRoutes(
  model: SiteModel,
  templateDirs: string[],
): Promise<PlannedRoute[]> {
  const { config, site } = model;
  const html = config.build.html;
  const routes: PlannedRoute[] = [];
  const siteUrl = config.site.url.replace(/\/+$/, "");
  const abs = (p: string) => `${siteUrl}${p}`;
  const headBase = {
    siteName: config.site.name,
    twitterSite: config.site.social.twitter,
    feeds: config.build.feeds,
    siteUrl: config.site.url,
    language: config.site.language,
  };
  const listable = (v: EntryView) =>
    config.collections.find((c) => c.name === v.collection)?.listable !== false &&
    v.kind !== "author";
  const posts = model.visible.filter(
    (v) => v.kind === "post" || (listable(v) && v.kind !== "page"),
  );
  const postCollection =
    config.collections.find((c) => c.kind === "post") ??
    config.collections.find((c) => c.listable)!;
  const postBase = model.collectionBase.get(postCollection.name);

  routes.push({
    kind: "home",
    path: "/",
    file: "index.html",
    template: "pages/home",
    title: config.site.name,
    context: () => ({
      page: {
        kind: "home",
        title: config.site.name,
        description: config.site.description,
        path: "/",
        url: abs("/"),
      },
      entries: posts.slice(0, html.pageSize).map(summarize),
      collection: postBase
        ? {
            name: postCollection.name,
            label: postCollection.label ?? postCollection.name,
            description: postCollection.description,
            url: postBase,
            kind: postCollection.kind,
          }
        : undefined,
      head: {
        ...headBase,
        title: config.site.name,
        description: config.site.description || undefined,
        url: abs("/"),
        type: "website",
        jsonld: {
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: config.site.name,
          url: config.site.url,
          description: config.site.description || undefined,
        },
      },
    }),
  });

  for (const collection of config.collections) {
    const base = model.collectionBase.get(collection.name);
    const items = (model.byCollection.get(collection.name) ?? []).filter(listable);
    if (base && collection.listable && collection.kind !== "author" && items.length > 0) {
      for (const p of paginate(items, base, html.pageSize)) {
        routes.push({
          kind: "collection",
          path: p.path,
          file: outputFile(p.path),
          template: "pages/collection",
          title: collection.label ?? collection.name,
          context: () => ({
            page: {
              kind: "collection",
              title: collection.label ?? collection.name,
              description: collection.description,
              path: p.path,
              url: abs(p.path),
            },
            collection: {
              name: collection.name,
              label: collection.label ?? collection.name,
              description: collection.description,
              url: base,
              kind: collection.kind,
            },
            entries: p.items.map(summarize),
            pagination: p.pagination,
            head: {
              ...headBase,
              title:
                p.page > 1
                  ? `${collection.label ?? collection.name} (page ${p.page})`
                  : (collection.label ?? collection.name),
              description:
                collection.description ??
                `${collection.label ?? collection.name} from ${config.site.name}${p.page > 1 ? `, page ${p.page}` : ""}.`,
              url: abs(p.path),
              type: "website",
              noindex: p.page > 1,
              jsonld: {
                "@context": "https://schema.org",
                "@type": "CollectionPage",
                name: collection.label ?? collection.name,
                url: abs(p.path),
                description: collection.description,
                isPartOf: { "@type": "WebSite", name: config.site.name, url: config.site.url },
              },
            },
          }),
        });
      }
    }
    const kindTemplate =
      collection.kind === "page"
        ? "pages/page"
        : collection.kind === "author"
          ? "pages/author"
          : "pages/post";
    const perCollection = `pages/${collection.name}`;
    const template = (await templateExists(templateDirs, perCollection))
      ? perCollection
      : kindTemplate;
    for (const view of model.byCollection.get(collection.name) ?? []) {
      const author = view.author
        ? [...model.views.values()].find((v) => v.kind === "author" && v.slug === view.author)
        : undefined;
      const related = view.related
        .map((slug) => model.views.get(`${view.collection}/${slug}`))
        .filter((v): v is EntryView => Boolean(v))
        .map(summarize);
      const byAuthor =
        collection.kind === "author"
          ? model.visible
              .filter((v) => v.author === view.slug && v.kind !== "author")
              .map(summarize)
          : undefined;
      const description =
        view.description ??
        view.excerpt ??
        (view.text ? truncateAtWord(view.text, 155, "") : undefined);
      routes.push({
        kind: "entry",
        path: view.path.endsWith("/") ? view.path : `${view.path}/`,
        file: outputFile(view.path.endsWith("/") ? view.path : `${view.path}/`),
        template,
        title: view.title,
        entry: { collection: view.collection, slug: view.slug },
        context: () => ({
          page: {
            kind: "entry",
            title: view.title,
            description,
            path: view.path,
            url: view.url,
            language: view.language,
          },
          entry: view,
          author: author ? { ...summarize(author), description: author.description } : undefined,
          related,
          entries: byAuthor,
          collection: {
            name: collection.name,
            label: collection.label ?? collection.name,
            description: collection.description,
            url: base ?? "/",
            kind: collection.kind,
          },
          head: {
            ...headBase,
            title: (view.seo.title as string | undefined) ?? view.title,
            description,
            url: view.url,
            canonical: view.canonical,
            image: view.image,
            imageAlt: view.imageAlt,
            type:
              collection.kind === "author"
                ? "profile"
                : collection.kind === "page"
                  ? "website"
                  : "article",
            publishedAt: view.publishedAt,
            updatedAt: view.updatedAt,
            section: view.category,
            tags: view.tags,
            noindex: Boolean(view.seo.noindex),
            language: view.language ?? config.site.language,
            jsonld: view.jsonld,
          },
        }),
      });
    }
  }

  for (const kind of ["tag", "category"] as const) {
    const terms = kind === "tag" ? model.taxonomy.tags : model.taxonomy.categories;
    const root = `${(kind === "tag" ? html.tagsPath : html.categoriesPath).replace(/\/+$/, "")}/`;
    if (terms.length === 0) continue;
    routes.push({
      kind: "taxonomy",
      path: root,
      file: outputFile(root),
      template: "pages/taxonomy",
      title: kind === "tag" ? "Tags" : "Categories",
      context: () => ({
        page: {
          kind: "taxonomy",
          title: kind === "tag" ? "Tags" : "Categories",
          description: `All ${kind === "tag" ? "tags" : "categories"} on ${config.site.name}.`,
          path: root,
          url: abs(root),
        },
        term: { kind, name: "", url: root, count: terms.length },
        terms,
        head: {
          ...headBase,
          title: kind === "tag" ? "Tags" : "Categories",
          description: `All ${kind === "tag" ? "tags" : "categories"} on ${config.site.name}.`,
          url: abs(root),
          type: "website",
          jsonld: {
            "@context": "https://schema.org",
            "@type": "CollectionPage",
            name: kind === "tag" ? "Tags" : "Categories",
            url: abs(root),
            isPartOf: { "@type": "WebSite", name: config.site.name, url: config.site.url },
          },
        },
      }),
    });
    for (const term of terms) {
      const items = model.visible.filter(
        (v) =>
          listable(v) && (kind === "tag" ? v.tags.includes(term.name) : v.category === term.name),
      );
      for (const p of paginate(items, term.url, html.pageSize)) {
        routes.push({
          kind: "term",
          path: p.path,
          file: outputFile(p.path),
          template: "pages/term",
          title: term.name,
          context: () => ({
            page: { kind: "term", title: term.name, path: p.path, url: abs(p.path) },
            term: { kind, name: term.name, url: term.url, count: items.length },
            entries: p.items.map(summarize),
            pagination: p.pagination,
            head: {
              ...headBase,
              title: `${term.name} · ${kind === "tag" ? "Tag" : "Category"}`,
              description: `${items.length} ${kind === "tag" ? "posts tagged" : "posts in"} ${term.name} on ${config.site.name}.`,
              url: abs(p.path),
              type: "website",
              noindex: p.page > 1,
              jsonld: {
                "@context": "https://schema.org",
                "@type": "CollectionPage",
                name: term.name,
                url: abs(p.path),
                isPartOf: { "@type": "WebSite", name: config.site.name, url: config.site.url },
              },
            },
          }),
        });
      }
    }
  }

  routes.push({
    kind: "404",
    path: "/404.html",
    file: "404.html",
    template: "pages/404",
    title: "Page not found",
    context: () => ({
      page: {
        kind: "404",
        title: "Page not found",
        description: "The page you were looking for does not exist.",
        path: "/404.html",
        url: abs("/404.html"),
      },
      entries: posts.slice(0, 5).map(summarize),
      head: {
        ...headBase,
        title: "Page not found",
        description: "The page you were looking for does not exist.",
        url: abs("/404.html"),
        type: "website",
        noindex: true,
        jsonld: {
          "@context": "https://schema.org",
          "@type": "WebPage",
          name: "Page not found",
          url: abs("/404.html"),
        },
      },
    }),
  });

  // Site-level unused warning guard: ensure the home template exists somewhere (bundled theme always has it).
  void site;
  return routes;
}

export interface AssetFile {
  name: string;
  rel: string;
  content: Buffer;
}

/** Collect theme assets (project files win over bundled ones) with content-hashed output names. */
export async function collectAssets(
  projectTemplatesDir: string,
  assetsPath: string,
): Promise<{ files: AssetFile[]; map: Record<string, string> }> {
  const { readFile } = await import("node:fs/promises");
  const sources = new Map<string, string>();
  for (const dir of [
    path.join(BUNDLED_THEME_DIR, "assets"),
    path.join(projectTemplatesDir, "assets"),
  ]) {
    for (const file of await listFiles(dir, [
      ".css",
      ".js",
      ".svg",
      ".png",
      ".jpg",
      ".jpeg",
      ".webp",
      ".ico",
      ".woff",
      ".woff2",
      ".txt",
    ])) {
      sources.set(path.basename(file), file);
    }
  }
  const files: AssetFile[] = [];
  const map: Record<string, string> = {};
  const prefix = assetsPath.replace(/^\/+|\/+$/g, "");
  for (const [name, file] of sources) {
    const content = await readFile(file);
    const hash = sha256(content.toString("base64")).slice(0, 8);
    const ext = path.extname(name);
    const hashed = `${name.slice(0, -ext.length)}.${hash}${ext}`;
    const rel = `${prefix}/${hashed}`;
    files.push({ name, rel, content });
    map[name] = `/${rel}`;
  }
  return { files, map };
}

export interface RenderedPage {
  route: Route;
  html: string;
}

export async function renderRoute(
  engine: Liquid,
  model: SiteModel,
  route: PlannedRoute,
  assets: Record<string, string>,
): Promise<string> {
  const partial = route.context();
  const head = renderHead(partial.head, model.config, model.theme);
  const ctx: RenderContext = { ...baseContext(model, assets), ...partial, head };
  return engine.renderFile(route.template, ctx);
}

export function routeSummary(r: Route): Route {
  const { kind, path: p, file, template, title, entry } = r;
  return { kind, path: p, file, template, title, entry };
}

export function slugPath(s: string): string {
  return slugify(s);
}

export async function readTemplateSource(
  dirs: string[],
  name: string,
): Promise<string | undefined> {
  for (const d of dirs) {
    const f = path.join(d, `${name}.liquid`);
    if (await exists(f)) return readText(f);
  }
  return undefined;
}

export type { EntrySummaryView };
