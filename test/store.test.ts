import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config/index.ts";
import { ContentStore } from "../src/core/content/store.ts";
import { makeProject, postFile } from "./helpers.ts";

let project: Awaited<ReturnType<typeof makeProject>>;
let store: ContentStore;

beforeEach(async () => {
  project = await makeProject({
    files: {
      "content/posts/existing.md": postFile(
        {
          id: "e1",
          title: "Existing",
          slug: "existing",
          status: "published",
          publishedAt: "2026-01-01T00:00:00.000Z",
          tags: ["one"],
        },
        "Hello world",
      ),
    },
  });
  store = new ContentStore(project.root, await loadConfig(project.root));
});
afterEach(() => project.cleanup());

describe("ContentStore", () => {
  it("creates entries with generated ids, slugs and dates", async () => {
    const e = await store.create("posts", { title: "Hello, World!", body: "Body" });
    expect(e.slug).toBe("hello-world");
    expect(e.frontmatter.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.frontmatter.status).toBe("draft");
    expect(e.frontmatter.createdAt).toBeDefined();
    expect(e.url).toBe("https://test.example/blog/hello-world");
    expect(e.relativePath).toBe("content/posts/hello-world.md");
  });

  it("refuses duplicate slugs and unknown collections", async () => {
    await expect(store.create("posts", { title: "Existing" })).rejects.toThrow(/already exists/);
    await expect(store.list("nope")).rejects.toThrow(/Unknown collection/);
  });

  it("lists with filters and sorting", async () => {
    await store.create("posts", { title: "Draft one", tags: ["two"] });
    expect((await store.list("posts")).length).toBe(2);
    expect((await store.list("posts", { status: "published" })).map((e) => e.slug)).toEqual([
      "existing",
    ]);
    expect((await store.list("posts", { tag: "two" })).map((e) => e.slug)).toEqual(["draft-one"]);
    expect((await store.list("posts", { query: "draft" })).length).toBe(1);
    expect((await store.list("posts", { sort: "title", order: "asc" })).map((e) => e.slug)).toEqual(
      ["draft-one", "existing"],
    );
  });

  it("updates, renames and preserves ids", async () => {
    const updated = await store.update("posts", "existing", {
      title: "Renamed",
      slug: "renamed",
      body: "New body",
    });
    expect(updated.frontmatter.id).toBe("e1");
    expect(updated.slug).toBe("renamed");
    expect(updated.body).toBe("New body");
    expect(updated.relativePath).toBe("content/posts/renamed.md");
    await expect(store.get("posts", "existing")).rejects.toThrow(/No entry/);
    expect((await store.get("posts", "e1")).slug).toBe("renamed");
  });

  it("sets publishedAt when publishing", async () => {
    const e = await store.create("posts", { title: "Soon" });
    expect(e.frontmatter.publishedAt).toBeUndefined();
    const p = await store.update("posts", "soon", { status: "published" });
    expect(p.frontmatter.publishedAt).toBeDefined();
  });

  it("deletes files", async () => {
    await store.delete("posts", "existing");
    expect(await store.list("posts")).toEqual([]);
  });

  it("validates duplicates, missing ids and closed taxonomies", async () => {
    const { writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    await writeFile(
      path.join(project.root, "content/posts/dup.md"),
      postFile({ id: "e1", title: "Dup", slug: "existing" }, "x"),
    );
    await writeFile(
      path.join(project.root, "content/posts/noid.md"),
      "---\ntitle: No id\n---\nbody",
    );
    await writeFile(path.join(project.root, "content/posts/broken.md"), "---\ntitle: [\n---\nbody");
    const issues = await store.validate();
    const messages = issues.map((i) => i.message);
    expect(messages.some((m) => m.includes("Duplicate slug"))).toBe(true);
    expect(messages.some((m) => m.includes("Duplicate id"))).toBe(true);
    expect(issues.find((i) => i.file.endsWith("noid.md"))?.severity).toBe("warning");
    expect(issues.find((i) => i.file.endsWith("broken.md"))?.severity).toBe("error");
  });
});
