import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Cms } from "../src/core/cms.ts";
import { GOOD_POST, makeProject, openCms, SEO_POST } from "./helpers.ts";

let project: Awaited<ReturnType<typeof makeProject>>;
let cms: Cms;

beforeEach(async () => {
  project = await makeProject();
  cms = await openCms(project.root);
  await cms.create(
    "authors",
    { title: "Ben", body: "Bio", status: "published" },
    { enrich: false },
  );
  await cms.create("posts", {
    title: "What is an agent-first CMS?",
    body: GOOD_POST,
    status: "published",
    author: "ben",
    image: "/img.png",
  });
  await cms.create("posts", { title: "SEO basics", body: SEO_POST });
});
afterEach(() => project.cleanup());

describe("build", () => {
  it("writes every static artifact for published entries only", async () => {
    const m = await cms.build();
    const out = m.outDir;
    expect(m.entries).toBe(2);
    const files = m.files.map((f) => f.path);
    for (const f of [
      "cms/content/posts/index.json",
      "cms/content/posts/what-is-an-agent-first-cms.json",
      "cms/site.json",
      "cms/taxonomy.json",
      "feeds/rss.xml",
      "feeds/atom.xml",
      "feeds/feed.json",
      "sitemap.xml",
      "llms.txt",
      "llms-full.txt",
      "cms/search-index.json",
      "robots.txt",
    ]) {
      expect(files).toContain(f);
    }
    expect(files).not.toContain("cms/content/posts/seo-basics.json");
    const entry = JSON.parse(
      await readFile(path.join(out, "cms/content/posts/what-is-an-agent-first-cms.json"), "utf8"),
    );
    expect(entry.html).toContain('<h2 id="what-is-an-agent-first-cms">');
    expect(entry.jsonld["@graph"].map((g: { "@type": string }) => g["@type"])).toEqual([
      "BlogPosting",
      "FAQPage",
      "BreadcrumbList",
    ]);
    expect(entry.jsonld["@graph"][0].author.name).toBe("Ben");
    expect(entry.toc.length).toBeGreaterThan(2);
    const llms = await readFile(path.join(out, "llms.txt"), "utf8");
    expect(llms.startsWith("# Test Site")).toBe(true);
    expect(llms).toContain(
      "[What is an agent-first CMS?](https://test.example/blog/what-is-an-agent-first-cms)",
    );
    const rss = await readFile(path.join(out, "feeds/rss.xml"), "utf8");
    expect(rss).toContain("<item>");
    expect(rss).toContain("What is an agent-first CMS?");
    const sitemap = await readFile(path.join(out, "sitemap.xml"), "utf8");
    expect(sitemap).toContain("https://test.example/blog/what-is-an-agent-first-cms");
    expect(sitemap).not.toContain("seo-basics");
    const search = JSON.parse(await readFile(path.join(out, "cms/search-index.json"), "utf8"));
    expect(search.documentCount).toBe(1);
    expect(await readFile(path.join(out, "robots.txt"), "utf8")).toContain("ClaudeBot");
  });

  it("includes drafts on request and removes stale files", async () => {
    const m1 = await cms.build({ includeDrafts: true });
    expect(m1.files.map((f) => f.path)).toContain("cms/content/posts/seo-basics.json");
    await cms.delete("posts", "seo-basics");
    const m2 = await cms.build({ includeDrafts: true });
    expect(m2.files.map((f) => f.path)).not.toContain("cms/content/posts/seo-basics.json");
    await expect(stat(path.join(m2.outDir, "cms/content/posts/seo-basics.json"))).rejects.toThrow();
  });
});
