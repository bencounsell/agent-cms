import { describe, expect, it } from "vitest";
import {
  orderKeys,
  parseFrontmatter,
  stringifyFrontmatter,
} from "../src/core/content/frontmatter.ts";

describe("frontmatter", () => {
  it("parses yaml frontmatter and body", () => {
    const { data, body } = parseFrontmatter("---\ntitle: Hi\ntags: [a, b]\n---\n\n# Body\n");
    expect(data).toEqual({ title: "Hi", tags: ["a", "b"] });
    expect(body).toBe("# Body\n");
  });

  it("treats documents without a fence as body only", () => {
    expect(parseFrontmatter("plain text")).toEqual({ data: {}, body: "plain text" });
  });

  it("rejects invalid yaml", () => {
    expect(() => parseFrontmatter("---\ntitle: [unclosed\n---\nbody")).toThrow(/Invalid YAML/);
  });

  it("round-trips with canonical key order", () => {
    const text = stringifyFrontmatter(
      { tags: ["x"], title: "T", id: "abc", custom: 2, slug: "t" },
      "Body",
    );
    expect(text.startsWith("---\nid: abc\ntitle: T\nslug: t\n")).toBe(true);
    expect(Object.keys(orderKeys({ zeta: 1, title: "a", alpha: 2 }))).toEqual([
      "title",
      "alpha",
      "zeta",
    ]);
    const back = parseFrontmatter(text);
    expect(back.data.custom).toBe(2);
    expect(back.body).toBe("Body\n");
  });
});
