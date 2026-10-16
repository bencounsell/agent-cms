import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Cms } from "../src/core/cms.ts";
import { GOOD_POST, makeProject, openCms, SEO_POST } from "./helpers.ts";

let project: Awaited<ReturnType<typeof makeProject>>;
let cms: Cms;

beforeEach(async () => {
  project = await makeProject();
  cms = await openCms(project.root);
  await cms.create("posts", {
    title: "What is an agent-first CMS?",
    body: GOOD_POST,
    status: "published",
  });
  await cms.create("posts", { title: "SEO basics", slug: "seo-basics", body: SEO_POST });
});
afterEach(() => project.cleanup());

describe("briefing", () => {
  it("summarises state and proposes tool calls", async () => {
    const b = await cms.briefing();
    expect(b.counts.total).toBe(2);
    expect(b.drafts.map((d) => d.slug)).toEqual(["seo-basics"]);
    expect(b.nextActions.length).toBeGreaterThan(0);
    expect(
      b.nextActions.every((a) => typeof a.tool === "string" && typeof a.args === "object"),
    ).toBe(true);
    expect(b.nextActions.some((a) => a.tool === "add_competitor")).toBe(true);
    expect(b.ai.mode).toBe("deterministic");
    expect(b.headline).toContain("Test Site");
  });
});

describe("suggestions and improvement plans", () => {
  it("suggests expansions, refreshes and links deterministically", async () => {
    await cms.store.update(
      "posts",
      "what-is-an-agent-first-cms",
      { updatedAt: "2020-01-01T00:00:00.000Z", publishedAt: "2020-01-01T00:00:00.000Z" } as never,
      { touch: false },
    );
    const s = await cms.suggest({ useAi: false });
    const types = new Set(s.map((x) => x.type));
    expect(types.has("refresh")).toBe(true);
    expect(types.has("expand")).toBe(true);
    expect(s.every((x) => x.evidence.length > 0 && x.rationale.length > 0)).toBe(true);
    expect((await cms.suggest({ useAi: false, focus: "zzz-nothing" })).length).toBe(0);
  });

  it("builds an improvement plan with link candidates", async () => {
    const p = await cms.improve("posts", "seo-basics");
    expect(p.steps.length).toBeGreaterThan(0);
    expect(p.steps[0]?.priority).toBeLessThanOrEqual(p.steps[p.steps.length - 1]?.priority ?? 3);
    expect(p.summary).toContain("SEO basics");
    expect(p.scores.overall).toBeDefined();
  });
});
