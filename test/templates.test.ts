import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditPage } from "../src/core/analysis/page-audit.ts";
import type { Cms } from "../src/core/cms.ts";
import { makeSelfContained, screenshotHtml } from "../src/core/preview/index.ts";
import { renderHead, themeCss } from "../src/core/templates/head.ts";
import { declaredNames, lineDiff } from "../src/core/templates/store.ts";
import { GOOD_POST, makeProject, openCms, SEO_POST } from "./helpers.ts";

let project: Awaited<ReturnType<typeof makeProject>>;
let cms: Cms;

beforeEach(async () => {
  project = await makeProject({
    config: (c) => {
      c.build.html.enabled = true;
      c.build.html.pageSize = 2;
      c.site.defaultAuthor = "ben";
    },
  });
  cms = await openCms(project.root);
  await cms.create(
    "authors",
    { title: "Ben", body: "Ben builds content tools.", status: "published" },
    { enrich: false },
  );
  await cms.create("posts", {
    title: "What is an agent-first CMS?",
    body: GOOD_POST,
    status: "published",
    image: "/img/a.png",
    tags: ["agents", "mcp"],
  });
  await cms.create("posts", {
    title: "SEO basics",
    slug: "seo-basics",
    body: SEO_POST,
    status: "published",
    tags: ["agents"],
  });
  await cms.create("posts", {
    title: "Third post",
    body: SEO_POST,
    status: "published",
    tags: ["static"],
  });
  await cms.create("pages", {
    title: "About",
    body: "About this site in one sentence.",
    status: "published",
  });
});
afterEach(() => project.cleanup());

describe("routes and page build", () => {
  it("plans home, lists with pagination, entries, terms and 404", async () => {
    const routes = await cms.routes();
    const paths = routes.map((r) => r.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/",
        "/blog/",
        "/blog/page/2/",
        "/blog/what-is-an-agent-first-cms/",
        "/about/",
        "/authors/ben/",
        "/tags/",
        "/tags/agents/",
        "/categories/",
        "/404.html",
      ]),
    );
    expect(routes.find((r) => r.path === "/about/")?.template).toBe("pages/page");
    expect(routes.find((r) => r.path === "/authors/ben/")?.template).toBe("pages/author");
  });

  it("writes pages, hashed assets and the data API in one build", async () => {
    const m = await cms.build();
    const files = m.files.map((f) => f.path);
    expect(m.pages).toBeGreaterThan(8);
    expect(files).toEqual(
      expect.arrayContaining([
        "index.html",
        "blog/index.html",
        "blog/page/2/index.html",
        "blog/what-is-an-agent-first-cms/index.html",
        "404.html",
        "sitemap.xml",
        "cms/site.json",
      ]),
    );
    expect(files.some((f) => /^assets\/styles\.[0-9a-f]{8}\.css$/.test(f))).toBe(true);
    const html = await readFile(
      path.join(m.outDir, "blog/what-is-an-agent-first-cms/index.html"),
      "utf8",
    );
    expect(html).toContain("<title>What is an agent-first CMS? · Test Site</title>");
    expect(html).toContain(
      '<link rel="canonical" href="https://test.example/blog/what-is-an-agent-first-cms">',
    );
    expect(html).toContain('property="og:image" content="https://test.example/img/a.png"');
    expect(html).toContain('<script type="application/ld+json">');
    // The answer equals the opening paragraph here, so the theme shows it once, in the body.
    expect(html).not.toContain('class="answer"');
    expect(html).not.toContain('class="lede"');
    expect(html).toContain('class="faq"');
    expect(html).toContain("author-card");
    expect(html).toMatch(/<link rel="stylesheet" href="\/assets\/styles\.[0-9a-f]{8}\.css">/);
    expect(html).toContain("--color-accent:#2457d6");
    const list = await readFile(path.join(m.outDir, "blog/index.html"), "utf8");
    expect(list).toContain("Page 1 of 2");
    expect((list.match(/class="card"/g) ?? []).length).toBe(2);
  });

  it("shows the answer box when the answer is not the opening paragraph", async () => {
    await cms.update("posts", "seo-basics", { aeo: { answer: "A distinct forty word answer that search engines can quote without the surrounding article, written separately from the body." } }, { enrich: false });
    const p = await cms.preview({ collection: "posts", slug: "seo-basics" });
    expect(p.html).toContain('class="answer"');
    expect(p.html).toContain('class="lede"');
  });

  it("skips pages when html rendering is off", async () => {
    await cms.updateConfig({ build: { html: { enabled: false } } });
    const m = await cms.build();
    expect(m.pages).toBe(0);
    expect(m.files.map((f) => f.path)).not.toContain("index.html");
  });

  it("escapes template output but passes raw html through", async () => {
    const created = await cms.create("posts", {
      title: "Tricky <b>title</b>",
      body: "Body with **bold**.",
      status: "published",
    });
    const p = await cms.preview({ collection: "posts", slug: created.entry.slug });
    expect(p.html).toContain("Tricky &lt;b&gt;title&lt;/b&gt;");
    expect(p.html).toContain("<strong>bold</strong>");
  });
});

describe("page audit and previews", () => {
  it("audits every route and merges page checks into entry audits", async () => {
    const pages = await cms.auditPages();
    expect(pages.length).toBeGreaterThan(8);
    expect(pages.every((p) => p.score >= 90)).toBe(true);
    const audit = await cms.audit("posts", "seo-basics");
    expect(audit.scores.page).toBeDefined();
    expect(audit.checks.some((c) => c.area === "page")).toBe(true);
  });

  it("catches broken pages", () => {
    const r = auditPage({
      html: "<html><body><h1>a</h1><h1>b</h1><img src=x><a href='/nope/'>x</a></body></html>",
      path: "/x/",
      url: "https://t/x/",
      knownPaths: new Set(["/x/"]),
    });
    const ids = r.failed.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "page.title",
        "page.h1",
        "page.img-alt",
        "page.links",
        "page.landmarks",
        "page.viewport",
      ]),
    );
    expect(r.score).toBeLessThan(40);
  });

  it("produces a self-contained preview document", async () => {
    const p = await cms.preview({ path: "/" });
    expect(p.route.kind).toBe("home");
    expect(p.html).toContain("<style data-inlined=");
    expect(p.html).not.toContain("<script defer src=");
    expect(p.html).toContain('href="https://test.example/blog/');
    expect(
      makeSelfContained('<a href="/x">x</a><a href="//cdn/y">y</a>', {
        siteUrl: "https://s.example",
        assets: [],
        assetMap: {},
      }),
    ).toBe('<a href="https://s.example/x">x</a><a href="//cdn/y">y</a>');
    await expect(cms.preview({ path: "/missing/" })).rejects.toThrow(/list_routes/);
  });

  it("takes a screenshot when a browser is available and explains when it is not", async () => {
    const r = await screenshotHtml("<html><body><h1>hi</h1></body></html>", {
      width: 320,
      height: 200,
    });
    if (r.ok) {
      expect(r.png.subarray(1, 4).toString()).toBe("PNG");
    } else {
      expect(r.hint).toContain("playwright");
    }
  });
});

describe("template store", () => {
  it("lists bundled templates, reads with sample context, writes with validation and resets", async () => {
    const model = await cms.siteModel(undefined, true);
    const list = await cms.templates.list(model);
    expect(list.find((t) => t.path === "pages/post.liquid")?.origin).toBe("default");
    expect(list.find((t) => t.path === "pages/post.liquid")?.routes.length).toBeGreaterThan(0);
    const detail = await cms.templates.get("pages/post.liquid", model);
    expect(detail.source).toContain("{% layout");
    expect(detail.variables.some((v) => v.startsWith("entry."))).toBe(true);
    expect((detail.sampleContext as { entry: { title: string } }).entry.title).toBeDefined();

    const bad = await cms.templates.write(
      "layouts/base.liquid",
      "<html><body>{{ page.title }}</body></html>",
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toContain("head | raw");
    const syntax = await cms.templates.write(
      "pages/post.liquid",
      "{% layout 'layouts/base' %}{% block content %}{{ entry.title }}{% endblock",
    );
    expect(syntax.ok).toBe(false);
    expect(syntax.errors[0]).toContain("Liquid syntax");

    const good = await cms.templates.write(
      "pages/post.liquid",
      detail.source.replace("<h1>{{ entry.title }}</h1>", '<h1 class="big">{{ entry.title }}</h1>'),
      model,
    );
    expect(good.ok).toBe(true);
    expect(good.warnings).toEqual([]);
    expect(good.diff).toMatch(/\+\s+<h1 class="big">/);
    expect((await cms.templates.list()).find((t) => t.path === "pages/post.liquid")?.origin).toBe(
      "project",
    );
    const p = await cms.preview({ collection: "posts", slug: "seo-basics" });
    expect(p.html).toContain('<h1 class="big">');

    const unknown = await cms.templates.write(
      "partials/x.liquid",
      "{% for item in entries %}{{ item.title }}{{ bogus.thing }}{% endfor %}",
    );
    expect(unknown.ok).toBe(true);
    expect(unknown.warnings.length).toBe(1);
    expect(unknown.warnings[0]).toContain("bogus");

    const reset = await cms.templates.reset("pages/post.liquid");
    expect(reset.diff).toMatch(/-\s+<h1 class="big">/);
    await expect(cms.templates.remove("pages/404.liquid")).rejects.toThrow(
      /not a project template/,
    );
    expect((await cms.templates.remove("partials/x.liquid")).fallsBackToDefault).toBe(false);
    await expect(cms.templates.get("../etc/passwd")).rejects.toThrow(/must start with/);
  });

  it("ejects the theme and overrides per collection", async () => {
    const written = await cms.templates.eject();
    expect(written.length).toBeGreaterThan(15);
    await cms.templates.write(
      "pages/posts.liquid",
      '{% layout "layouts/base" %}{% block content %}<h1>CUSTOM {{ entry.title }}</h1>{% endblock %}',
    );
    const routes = await cms.routes();
    expect(routes.find((r) => r.path === "/blog/seo-basics/")?.template).toBe("pages/posts");
    const p = await cms.preview({ collection: "posts", slug: "seo-basics" });
    expect(p.html).toContain("CUSTOM SEO basics");
  });

  it("helpers: declared names, diffs, head, theme css", () => {
    expect(
      declaredNames("{% for item in x %}{% assign foo = 1 %}{% capture bar %}{% endcapture %}"),
    ).toEqual(["item", "foo", "bar"]);
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toContain("- b");
    expect(lineDiff("same", "same")).toBe("");
    const head = renderHead(
      {
        title: "T",
        description: "D",
        url: "https://s/x/",
        type: "article",
        siteName: "S",
        feeds: true,
        siteUrl: "https://s",
        noindex: true,
        jsonld: { "@type": "Thing", name: "<x>" },
      },
      cms.config,
      {
        name: "t",
        colors: { background: "#fff" },
        dark: {},
        fonts: { body: "a", heading: "b", mono: "c" },
        layout: { maxWidth: "1", proseWidth: "2", radius: "3" },
        features: {
          darkMode: false,
          toc: true,
          answerBox: true,
          takeaways: true,
          faq: true,
          authorCard: true,
          related: true,
          search: true,
        },
        footer: { text: "" },
      },
    );
    expect(head).toContain("<title>T · S</title>");
    expect(head).toContain('name="robots" content="noindex, follow"');
    expect(head).toContain("\\u003c");
    expect(head).toContain("application/rss+xml");
    expect(
      themeCss({
        name: "t",
        colors: { accentText: "#000" },
        dark: { accentText: "#fff" },
        fonts: { body: "a", heading: "b", mono: "c" },
        layout: { maxWidth: "1", proseWidth: "2", radius: "3" },
        features: {
          darkMode: true,
          toc: true,
          answerBox: true,
          takeaways: true,
          faq: true,
          authorCard: true,
          related: true,
          search: true,
        },
        footer: { text: "" },
      }),
    ).toContain("@media (prefers-color-scheme:dark){:root{--color-accent-text:#fff}}");
  });

  it("theme store merges project tokens over defaults", async () => {
    const t = await cms.theme.update({ colors: { accent: "#ff0066" }, features: { toc: false } });
    expect(t.colors.accent).toBe("#ff0066");
    expect(t.colors.background).toBe("#ffffff");
    expect(t.features.toc).toBe(false);
    const p = await cms.preview({ collection: "posts", slug: "what-is-an-agent-first-cms" });
    expect(p.html).toContain("--color-accent:#ff0066");
    expect(p.html).not.toContain('class="toc"');
    await expect(cms.theme.update({ fonts: 5 })).rejects.toThrow(/Invalid theme/);
    await cms.theme.reset();
    expect((await cms.theme.resolve()).colors.accent).toBe("#2457d6");
  });
});
