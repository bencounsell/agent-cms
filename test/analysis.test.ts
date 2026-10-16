import { describe, expect, it } from "vitest";
import {
  canonicalPhrase,
  containsPhrase,
  extractKeywords,
  keywordOverlap,
} from "../src/core/analysis/keywords.ts";
import { analyzeReadability, countSyllables } from "../src/core/analysis/readability.ts";

const corpus = [
  {
    id: "1",
    title: "Why agent-first CMS tools win",
    headings: ["What is an agent-first CMS?"],
    text: "An agent-first CMS lets AI agents manage content through MCP. Agent-first CMS tools generate metadata automatically. Static files are the output of an agent-first CMS. Metadata generation is automatic, and metadata generation saves time.",
  },
  {
    id: "2",
    title: "Static site generators compared",
    text: "Static site generators like Astro and Eleventy build static files. Static site generators are fast. Compare static site generators by build speed.",
  },
  {
    id: "3",
    title: "SEO basics",
    text: "Search engine optimization improves ranking. SEO basics include titles and descriptions. Search engine optimization needs keywords.",
  },
];

describe("keywords", () => {
  it("ranks the title phrase first and keeps multi-word phrases", () => {
    const k = extractKeywords(corpus[0]!, corpus, 5).map((x) => x.phrase);
    expect(k[0]).toBe("agent-first cms");
    expect(k).toContain("metadata generation");
    expect(k).not.toContain("agent-first");
  });
  it("does not span sentence boundaries", () => {
    const k = extractKeywords(corpus[0]!, corpus, 20).map((x) => x.phrase);
    expect(k.some((p) => p.includes("cms metadata"))).toBe(false);
  });
  it("matches phrases regardless of hyphens and case", () => {
    expect(containsPhrase("An Agent-First CMS is great", "agent first cms")).toBe(true);
    expect(containsPhrase("Totally unrelated", "agent-first cms")).toBe(false);
    expect(canonicalPhrase("Agent-First CMS")).toBe("agent first cms");
    expect(keywordOverlap(["a", "b"], ["B", "c"])).toBe(0.5);
  });
});

describe("readability", () => {
  it("counts syllables roughly right", () => {
    expect(countSyllables("cat")).toBe(1);
    expect(countSyllables("content")).toBe(2);
    expect(countSyllables("automatically")).toBeGreaterThanOrEqual(4);
  });
  it("scores simple text as easy", () => {
    const r = analyzeReadability("The cat sat on the mat. It was warm. The dog ran home.");
    expect(r.fleschReadingEase).toBeGreaterThan(80);
    expect(r.sentences).toBe(3);
    expect(r.level).toMatch(/easy/);
  });
  it("detects passive voice", () => {
    const r = analyzeReadability("The report was written by the team. The bug was fixed.");
    expect(r.passiveRatio).toBe(1);
  });
});
