import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CreateMessageRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.ts";
import { GOOD_POST, makeProject, openCms, SEO_POST } from "./helpers.ts";

const META = {
  seoTitle: "Static output explained",
  description:
    "Learn how agentcms writes JSON, feeds and a sitemap to disk so any static host can serve your content without a server.",
  excerpt: "How static output works.",
  focusKeyword: "static output",
  keywords: ["static output", "json content api"],
  category: "Engineering",
  tags: ["static-output"],
  social: {
    ogTitle: "OG",
    ogDescription: "OG",
    twitterTitle: "TW",
    twitterDescription: "TW",
    linkedinPost: "LI",
    xPost: "X",
  },
  aeo: {
    answer: "Static output means files on disk.",
    keyTakeaways: ["a", "b", "c"],
    faq: [{ question: "Q?", answer: "A." }],
    questions: ["How?"],
  },
  imageAlt: null,
  reviewNotes: [],
};

let project: Awaited<ReturnType<typeof makeProject>>;

async function connect(opts: { sampling?: boolean; provider?: "auto" | "deterministic" } = {}) {
  const cms = await openCms(project.root);
  if (opts.provider) await cms.updateConfig({ ai: { provider: opts.provider } });
  const server = createMcpServer(cms);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test", version: "1" },
    { capabilities: opts.sampling ? { sampling: {} } : {} },
  );
  if (opts.sampling)
    client.setRequestHandler(CreateMessageRequestSchema, async () => ({
      model: "fake",
      role: "assistant",
      content: { type: "text", text: JSON.stringify(META) },
    }));
  await server.connect(st);
  await client.connect(ct);
  return {
    client,
    cms,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

beforeEach(async () => {
  project = await makeProject();
  const cms = await openCms(project.root);
  await cms.create("posts", {
    title: "What is an agent-first CMS?",
    body: GOOD_POST,
    status: "published",
  });
});
afterEach(() => project.cleanup());

describe("MCP server", () => {
  it("exposes tools, resources, prompts and instructions", async () => {
    const { client, close } = await connect();
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "get_briefing",
        "create_content",
        "audit_content",
        "suggest_content",
        "research_competitors",
        "build_site",
        "submit_metadata",
      ]),
    );
    expect(tools.find((t) => t.name === "delete_content")?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "get_briefing")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "get_briefing")?.outputSchema).toBeDefined();
    expect(client.getInstructions()).toContain("get_briefing");
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining([
        "agentcms://guide",
        "agentcms://config",
        "agentcms://content/posts/what-is-an-agent-first-cms",
      ]),
    );
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toContain("write_post");
    const guide = await client.readResource({ uri: "agentcms://guide" });
    expect((guide.contents[0] as { text: string }).text).toContain("# agentcms agent guide");
    const schema = await client.readResource({ uri: "agentcms://schema/posts" });
    expect(
      JSON.parse((schema.contents[0] as { text: string }).text).frontmatterSchema.properties.title,
    ).toBeDefined();
    const prompt = await client.getPrompt({ name: "write_post", arguments: { topic: "Hosting" } });
    expect((prompt.messages[0]!.content as { text: string }).text).toContain("Hosting");
    await close();
  });

  it("creates content with structured output and next actions", async () => {
    const { client, close } = await connect();
    const r = await client.callTool({
      name: "create_content",
      arguments: { collection: "posts", title: "SEO basics", body: SEO_POST },
    });
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as {
      entry: { slug: string };
      audit: { scores: { overall: number } };
      nextActions: unknown[];
    };
    expect(sc.entry.slug).toBe("seo-basics");
    expect(sc.audit.scores.overall).toBeGreaterThan(0);
    expect(sc.nextActions.length).toBeGreaterThan(0);
    const b = await client.callTool({ name: "get_briefing", arguments: {} });
    expect((b.structuredContent as { counts: { total: number } }).counts.total).toBe(2);
    await close();
  });

  it("delegates metadata generation when no model is available and accepts submissions", async () => {
    const { client, close } = await connect({ provider: "auto" });
    const r = await client.callTool({
      name: "create_content",
      arguments: { collection: "posts", title: "Delegated", body: SEO_POST },
    });
    const sc = r.structuredContent as {
      enrichment: { delegated?: { submit: { tool: string }; schema: unknown } };
    };
    expect(sc.enrichment.delegated?.submit.tool).toBe("submit_metadata");
    const s = await client.callTool({
      name: "submit_metadata",
      arguments: { collection: "posts", slug: "delegated", metadata: META },
    });
    expect(s.isError).toBeFalsy();
    expect((s.structuredContent as { frontmatter: { tags: string[] } }).frontmatter.tags).toEqual([
      "static-output",
    ]);
    await close();
  });

  it("uses client sampling when offered", async () => {
    const { client, cms, close } = await connect({ provider: "auto", sampling: true });
    expect(cms.ai.mode).toBe("provider");
    const r = await client.callTool({
      name: "enrich_metadata",
      arguments: { collection: "posts", slug: "what-is-an-agent-first-cms", force: true },
    });
    const res = (
      r.structuredContent as {
        results: { provider: string; frontmatter: { description: string } }[];
      }
    ).results[0]!;
    expect(res.provider).toBe("sampling+deterministic");
    expect(res.frontmatter.description).toContain("Learn how agentcms");
    await close();
  });

  it("guards destructive actions and reports errors as tool errors", async () => {
    const { client, close } = await connect();
    const d = await client.callTool({
      name: "delete_content",
      arguments: { collection: "posts", slug: "what-is-an-agent-first-cms", confirm: false },
    });
    expect(d.isError).toBe(true);
    const nf = await client.callTool({
      name: "get_content",
      arguments: { collection: "posts", slug: "missing" },
    });
    expect(nf.isError).toBe(true);
    expect((nf.content as { text: string }[])[0]!.text).toContain("NOT_FOUND");
    const ok = await client.callTool({
      name: "delete_content",
      arguments: { collection: "posts", slug: "what-is-an-agent-first-cms", confirm: true },
    });
    expect(ok.isError).toBeFalsy();
    await close();
  });
});
