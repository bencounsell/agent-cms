import { describe, expect, it } from "vitest";
import { analyzeMarkdown, renderHtml, tableOfContents } from "../src/core/markdown/analyze.ts";
import { GOOD_POST } from "./helpers.ts";

describe("markdown analysis", () => {
  const a = analyzeMarkdown(GOOD_POST, { siteUrl: "https://test.example" });

  it("extracts structure", () => {
    expect(a.headings.map((h) => h.text)).toContain("What is an agent-first CMS?");
    expect(a.headings.find((h) => h.text.startsWith("What is"))?.isQuestion).toBe(true);
    expect(a.headings[0]?.id).toBe("what-is-an-agent-first-cms");
    expect(a.links.filter((l) => l.internal).map((l) => l.url)).toEqual(["/blog/seo-basics"]);
    expect(a.links.filter((l) => !l.internal).length).toBe(1);
    expect(a.hasFaqSection).toBe(true);
    expect(a.hasTakeawaysSection).toBe(true);
    expect(a.lists).toBe(1);
    expect(a.wordCount).toBeGreaterThan(150);
    expect(a.firstParagraph.startsWith("An agent-first CMS is")).toBe(true);
    expect(a.sections.filter((s) => s.heading?.depth === 2).length).toBe(4);
  });

  it("treats same-host absolute links as internal", () => {
    const b = analyzeMarkdown("[x](https://test.example/blog/x) [y](https://other.example/y)", {
      siteUrl: "https://test.example",
    });
    expect(b.links.map((l) => l.internal)).toEqual([true, false]);
  });

  it("renders html with heading ids and a toc", async () => {
    const html = await renderHtml("## Hello World\n\ntext\n\n## Hello World");
    expect(html).toContain('<h2 id="hello-world">');
    expect(html).toContain('<h2 id="hello-world-1">');
    expect(tableOfContents(a.headings).length).toBe(a.headings.length);
  });
});
