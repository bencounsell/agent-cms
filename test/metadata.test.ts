import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Cms } from "../src/core/cms.ts";
import {
  AiMetadataSchema,
  applyAiMetadata,
  describeFromText,
  extractAeo,
  selectFields,
} from "../src/core/metadata/index.ts";
import { GOOD_POST, makeProject, openCms, SEO_POST } from "./helpers.ts";

let project: Awaited<ReturnType<typeof makeProject>>;
let cms: Cms;

beforeEach(async () => {
  project = await makeProject();
  cms = await openCms(project.root);
});
afterEach(() => project.cleanup());

describe("deterministic enrichment", () => {
  it("fills metadata on create and flags review fields", async () => {
    const r = await cms.create("posts", {
      title: "What is an agent-first CMS?",
      body: GOOD_POST,
      image: "/img.png",
    });
    const fm = r.entry.frontmatter;
    expect(fm.keywords[0]).toBe("agent-first cms");
    expect(fm.seo?.focusKeyword).toBe("agent-first cms");
    expect(fm.category).toBe("Engineering");
    expect(fm.tags).toContain("agent-first-cms");
    expect(fm.description?.length).toBeLessThanOrEqual(160);
    expect(fm.description?.endsWith(".")).toBe(true);
    expect(fm.excerpt).toBeDefined();
    expect(fm.readingTime).toBeGreaterThanOrEqual(1);
    expect(fm.wordCount).toBeGreaterThan(100);
    expect(fm.social?.og?.type).toBe("article");
    expect(fm.social?.twitter?.card).toBe("summary_large_image");
    expect(fm.aeo?.answer?.startsWith("An agent-first CMS")).toBe(true);
    expect(fm.aeo?.keyTakeaways?.length).toBe(3);
    expect(fm.aeo?.faq?.length).toBe(2);
    expect(fm.aeo?.questions).toContain("Does an agent-first CMS need a database?");
    expect(fm.generated?.provider).toBe("deterministic");
    expect(fm.generated?.fields).toContain("description");
    expect(fm.review).toContain("description");
    expect(r.enrichment?.delegated).toBeUndefined();
  });

  it("never overwrites human-written fields unless forced", async () => {
    const r = await cms.create("posts", {
      title: "SEO basics",
      body: SEO_POST,
      description: "Human description.",
      tags: ["human-tag"],
    });
    expect(r.entry.frontmatter.description).toBe("Human description.");
    expect(r.entry.frontmatter.tags).toEqual(["human-tag"]);
    const { allowed, skipped } = selectFields(r.entry, cms.store.collection("posts"), {});
    expect(allowed.has("description")).toBe(false);
    expect(skipped.map((s) => s.field)).toContain("description");
    const forced = await cms.enrich("posts", r.entry.slug, { force: true });
    expect(forced.entry.frontmatter.description).not.toBe("Human description.");
  });

  it("computes related entries across the collection", async () => {
    await cms.create("posts", { title: "What is an agent-first CMS?", body: GOOD_POST });
    const r = await cms.create("posts", {
      title: "SEO basics for an agent-first CMS",
      body: SEO_POST,
    });
    expect(r.entry.frontmatter.related).toContain("what-is-an-agent-first-cms");
  });

  it("returns a delegated task when no model is available", async () => {
    await cms.updateConfig({ ai: { provider: "delegate" } });
    const r = await cms.create("posts", { title: "Delegated", body: SEO_POST });
    expect(r.enrichment?.delegated?.kind).toBe("generate_metadata");
    expect(r.enrichment?.delegated?.submit.tool).toBe("submit_metadata");
    expect(r.enrichment?.delegated?.schema).toHaveProperty("properties");
    expect(r.nextActions.some((a) => a.tool === "submit_metadata")).toBe(true);
  });
});

describe("AI metadata application", () => {
  const ai = AiMetadataSchema.parse({
    seoTitle: "Agent-first CMS explained",
    description:
      "A description from the model that is long enough to pass the length checks of the audit engine, honestly.",
    excerpt: "Short teaser.",
    focusKeyword: "agent-first cms",
    keywords: ["agent-first cms", "mcp cms"],
    category: "Engineering",
    tags: ["Agent First", "MCP", "mcp"],
    social: {
      ogTitle: "OG",
      ogDescription: "OG desc",
      twitterTitle: "TW",
      twitterDescription: "TW desc",
      linkedinPost: "LI",
      xPost: "X",
    },
    aeo: {
      answer: "Answer.",
      keyTakeaways: ["one", "two"],
      faq: [{ question: "Q?", answer: "A." }],
      questions: ["Q?"],
    },
    imageAlt: "An alt",
    reviewNotes: ["check"],
  });

  it("applies values, slugifies tags, honours the taxonomy and limits", async () => {
    const r = await cms.create(
      "posts",
      { title: "T", body: "Body text here.", image: "/i.png" },
      { enrich: false },
    );
    const applied = applyAiMetadata(
      r.entry.frontmatter,
      ai,
      new Set(["description", "tags", "keywords", "category", "social", "aeo"]),
      cms.config,
      cms.store.collection("posts"),
    );
    expect(applied.frontmatter.tags).toEqual(["agent-first", "mcp"]);
    expect(applied.frontmatter.category).toBe("Engineering");
    expect(applied.frontmatter.seo?.title).toBe("Agent-first CMS explained");
    expect(applied.frontmatter.social?.twitter?.card).toBe("summary_large_image");
    expect((applied.frontmatter.social as { posts?: { x?: string } }).posts?.x).toBe("X");
    expect(applied.frontmatter.aeo?.faq?.length).toBe(1);
    expect(applied.frontmatter.imageAlt).toBe("An alt");
    expect(applied.notes[0]).toContain("model note");
  });

  it("rejects categories outside a closed taxonomy", async () => {
    await cms.updateConfig({ taxonomy: { categoryPolicy: "closed" } });
    const r = await cms.create("posts", { title: "T2", body: "Body." }, { enrich: false });
    const applied = applyAiMetadata(
      r.entry.frontmatter,
      { ...ai, category: "Nope" },
      new Set(["category"]),
      cms.config,
      cms.store.collection("posts"),
    );
    expect(applied.frontmatter.category).toBeUndefined();
    expect(applied.review).toContain("category");
  });

  it("submitMetadata persists agent output", async () => {
    const r = await cms.create("posts", { title: "T3", body: "Body." }, { enrich: false });
    const s = await cms.submitMetadata("posts", r.entry.slug, ai);
    expect(s.provider).toBe("agent");
    expect(s.entry.frontmatter.generated?.provider).toBe("agent+deterministic");
    expect(s.entry.frontmatter.description).toContain("from the model");
    await expect(cms.submitMetadata("posts", r.entry.slug, { bad: true })).rejects.toThrow(
      /schema/,
    );
  });
});

describe("helpers", () => {
  it("extracts AEO blocks written in the body", () => {
    const entry = {
      collection: "posts",
      slug: "x",
      file: "",
      relativePath: "",
      url: "",
      path: "",
      body: GOOD_POST,
      frontmatter: {
        id: "1",
        title: "x",
        slug: "x",
        status: "draft" as const,
        tags: [],
        keywords: [],
      },
    };
    const { analyzeMarkdown } =
      require("../src/core/markdown/analyze.ts") as typeof import("../src/core/markdown/analyze.ts");
    const aeo = extractAeo(entry, analyzeMarkdown(GOOD_POST));
    expect(aeo.faq?.[0]?.question).toBe("Does an agent-first CMS need a database?");
    expect(aeo.keyTakeaways?.length).toBe(3);
  });
  it("builds descriptions from whole sentences", () => {
    expect(
      describeFromText(
        "First sentence is here. Second sentence follows it. Third one is quite a bit longer than the others and goes on.",
        60,
      ),
    ).toBe("First sentence is here. Second sentence follows it.");
    expect(describeFromText("A".repeat(200), 50).endsWith("…")).toBe(true);
  });
});
