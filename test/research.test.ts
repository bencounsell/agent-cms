import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Cms } from "../src/core/cms.ts";
import { compareCompetitors } from "../src/core/research/compare.ts";
import { extractPage } from "../src/core/research/extract.ts";
import { isAllowed, parseRobots } from "../src/core/research/robots.ts";
import { parseSitemap } from "../src/core/research/sitemap.ts";
import { GOOD_POST, makeProject, openCms } from "./helpers.ts";

const PAGE = (
  title: string,
  extra = "",
) => `<!doctype html><html lang="en"><head><title>${title} | Rival</title>
<meta name="description" content="Desc for ${title}">
<meta property="article:published_time" content="2026-10-01T10:00:00Z">
<link rel="canonical" href="https://rival.example/blog/${title.toLowerCase().replace(/\s+/g, "-")}">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BlogPosting","author":{"@type":"Person","name":"Rae"}},{"@type":"FAQPage"}]}</script>
</head><body><nav><a href="/">home</a></nav><main><h1>${title}</h1>
<p>Content velocity planning helps teams ship. Content velocity planning is a repeatable system. Teams that plan content velocity publish weekly.</p>
<h2>How do you plan content velocity?</h2><p>You set a cadence and measure. Editorial calendars make content velocity planning visible to everyone.</p>
<h2>FAQ</h2><h3>Is content velocity planning hard?</h3><p>No.</p>
<a href="/blog/other">other</a> <a href="https://elsewhere.example">ext</a> <img src="/a.png">${extra}</main><footer>f</footer></body></html>`;

const ROBOTS =
  "User-agent: *\nDisallow: /private/\nAllow: /private/ok\nSitemap: https://rival.example/sitemap.xml\n";
const SITEMAP = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://rival.example/blog/content-velocity</loc><lastmod>2026-10-01</lastmod></url><url><loc>https://rival.example/blog/second-post</loc><lastmod>2026-09-01</lastmod></url><url><loc>https://rival.example/private/secret</loc></url><url><loc>https://rival.example/a.png</loc></url></urlset>`;

function fakeFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const body = (text: string, type = "text/html") =>
      new Response(text, { status: 200, headers: { "content-type": type } });
    if (url.endsWith("/robots.txt")) return body(ROBOTS, "text/plain");
    if (url.endsWith("/sitemap.xml")) return body(SITEMAP, "application/xml");
    if (url.includes("/blog/content-velocity")) return body(PAGE("Content Velocity Planning"));
    if (url.includes("/blog/second-post")) return body(PAGE("Second Post"));
    if (url.includes("/private/")) throw new Error("should not be fetched");
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
}

describe("research primitives", () => {
  it("parses robots.txt with longest-match semantics", () => {
    const r = parseRobots(ROBOTS);
    expect(r.sitemaps).toEqual(["https://rival.example/sitemap.xml"]);
    expect(isAllowed(r, "agentcms-research/0.1", "/private/x")).toBe(false);
    expect(isAllowed(r, "agentcms-research/0.1", "/private/ok")).toBe(true);
    expect(isAllowed(r, "agentcms-research/0.1", "/blog/x")).toBe(true);
  });
  it("parses sitemaps and sitemap indexes", () => {
    expect(parseSitemap(SITEMAP).entries.length).toBe(4);
    const index = parseSitemap(
      "<sitemapindex><sitemap><loc>https://x/a.xml</loc></sitemap></sitemapindex>",
    );
    expect(index.kind).toBe("index");
    expect(parseSitemap("not xml").kind).toBe("unknown");
  });
  it("extracts page facts", () => {
    const p = extractPage(
      PAGE("Content Velocity Planning"),
      "https://rival.example/blog/content-velocity",
    );
    expect(p.title).toBe("Content Velocity Planning | Rival");
    expect(p.h1).toBe("Content Velocity Planning");
    expect(p.h2).toContain("How do you plan content velocity?");
    expect(p.publishedAt).toBe("2026-10-01T10:00:00.000Z");
    expect(p.author).toBe("Rae");
    expect(p.schemaTypes).toContain("FAQPage");
    expect(p.hasFaq).toBe(true);
    expect(p.questionHeadings).toBeGreaterThanOrEqual(2);
    expect(p.internalLinks).toBe(1);
    expect(p.externalLinks).toBe(1);
    expect(p.wordCount).toBeGreaterThan(20);
  });
});

describe("crawl and compare", () => {
  let project: Awaited<ReturnType<typeof makeProject>>;
  let cms: Cms;
  beforeEach(async () => {
    project = await makeProject({
      config: (c) => {
        c.research.requestDelayMs = 0;
      },
    });
    cms = await openCms(project.root, { fetchImpl: fakeFetch() });
    await cms.create("posts", {
      title: "What is an agent-first CMS?",
      body: GOOD_POST,
      status: "published",
    });
  });
  afterEach(() => project.cleanup());

  it("tracks, crawls politely and diffs snapshots", async () => {
    const rec = await cms.addCompetitor("https://rival.example/blog", { name: "Rival" });
    expect(rec.host).toBe("rival.example");
    expect(cms.config.research.competitors[0]?.url).toBe("https://rival.example/blog");
    const { snapshot } = await cms.refreshCompetitor("rival.example");
    expect(snapshot.pages.map((p) => p.url)).toEqual([
      "https://rival.example/blog/content-velocity",
      "https://rival.example/blog/second-post",
    ]);
    expect(snapshot.pages[0]?.keywords).toContain("content velocity planning");
    const again = await cms.refreshCompetitor("rival.example");
    expect(again.record.history.length).toBe(2);
    expect(again.record.history[1]?.newPages).toEqual([]);
    const list = await cms.research.list();
    expect(list[0]?.latest?.pages.length).toBe(2);
  });

  it("finds topic gaps and opportunities", async () => {
    await cms.addCompetitor("https://rival.example/blog");
    await cms.refreshCompetitor("rival.example");
    const report = await cms.compare();
    expect(report.competitors[0]?.faqShare).toBe(1);
    expect(report.gaps.some((g) => g.topic.includes("content velocity"))).toBe(true);
    expect(report.opportunities.some((o) => o.type === "new_topic")).toBe(true);
    expect(report.summary).toContain("1 competitor");
    const s = await cms.suggest({ useAi: false });
    expect(
      s.some((x) => x.type === "new" && x.title.toLowerCase().includes("content velocity")),
    ).toBe(true);
    await cms.removeCompetitor("rival.example");
    expect(await cms.research.list()).toEqual([]);
    expect(cms.config.research.competitors).toEqual([]);
  });

  it("compares deterministically via the pure function", () => {
    const report = compareCompetitors({
      config: cms.config,
      entries: [],
      analyses: new Map(),
      competitors: [],
    });
    expect(report.competitors).toEqual([]);
    expect(report.gaps).toEqual([]);
  });
});
