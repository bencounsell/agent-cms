import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Cms } from "../src/core/cms.ts";
import { GOOD_POST, makeProject, openCms, SEO_POST } from "./helpers.ts";

let project: Awaited<ReturnType<typeof makeProject>>;
let cms: Cms;

beforeEach(async () => {
  project = await makeProject({
    config: (c) => {
      c.site.defaultAuthor = "ben";
    },
  });
  cms = await openCms(project.root);
  await cms.create("authors", { title: "Ben", body: "Bio" }, { enrich: false });
});
afterEach(() => project.cleanup());

describe("audit", () => {
  it("scores a well-structured post as publishable and a thin one as not", async () => {
    await cms.create("posts", { title: "SEO basics", slug: "seo-basics", body: SEO_POST });
    const good = await cms.create("posts", {
      title: "What is an agent-first CMS?",
      body: GOOD_POST,
      image: "/img.png",
    });
    expect(good.audit?.scores.aeo).toBeGreaterThanOrEqual(80);
    expect(good.audit?.publishable).toBe(true);
    expect(good.audit?.checks.find((c) => c.id === "aeo.faq")?.passed).toBe(true);
    expect(good.audit?.checks.find((c) => c.id === "aeo.answer-first")?.passed).toBe(true);
    expect(good.audit?.checks.find((c) => c.id === "links.broken")?.passed).toBe(true);
    const thin = await cms.create("posts", { title: "Thin", body: "Too short." });
    expect(thin.audit?.publishable).toBe(false);
    expect(thin.audit?.failed.map((c) => c.id)).toContain("seo.wordcount");
    expect(thin.audit?.failed.every((c) => typeof c.fix === "string")).toBe(true);
  });

  it("flags duplicate titles, broken links and missing alt text", async () => {
    await cms.create("posts", {
      title: "Same title",
      body: "Body one with [a broken link](/blog/missing) and ![](/img.png) here.",
    });
    const second = await cms.create("posts", {
      title: "Same title",
      slug: "same-2",
      body: "Body two.",
    });
    const ids = second.audit?.failed.map((c) => c.id) ?? [];
    expect(ids).toContain("seo.duplicate.title");
    const first = await cms.audit("posts", "same-title");
    expect(first.failed.map((c) => c.id)).toContain("links.broken");
    expect(first.failed.map((c) => c.id)).toContain("seo.images.alt");
  });

  it("gates publishing and reports stale content", async () => {
    const thin = await cms.create("posts", { title: "Thin", body: "Too short." });
    const blocked = await cms.setStatus("posts", thin.entry.slug, "published");
    expect(blocked.blocked).toMatch(/below the publish threshold/);
    const forced = await cms.setStatus("posts", thin.entry.slug, "published", { force: true });
    expect(forced.entry.frontmatter.status).toBe("published");
    await cms.store.update(
      "posts",
      thin.entry.slug,
      { updatedAt: "2020-01-01T00:00:00.000Z", publishedAt: "2020-01-01T00:00:00.000Z" } as never,
      { touch: false },
    );
    const audit = await cms.audit("posts", thin.entry.slug);
    expect(audit.failed.map((c) => c.id)).toContain("freshness.stale");
  });
});
