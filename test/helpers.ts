import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Cms } from "../src/core/cms.ts";
import { type CmsConfig, defaultConfig, saveConfig } from "../src/core/config/index.ts";

export interface ProjectOptions {
  config?: (c: CmsConfig) => void;
  files?: Record<string, string>;
}

export async function makeProject(
  opts: ProjectOptions = {},
): Promise<{ root: string; cleanup: () => Promise<void>; config: CmsConfig }> {
  const root = await mkdtemp(path.join(tmpdir(), "agentcms-test-"));
  const config = defaultConfig({
    name: "Test Site",
    url: "https://test.example",
    description: "A test site about agent-first content tooling.",
  });
  config.ai.provider = "deterministic";
  config.build.html.enabled = false;
  config.taxonomy.categories = [
    { name: "Engineering", keywords: ["mcp", "api", "typescript"] },
    { name: "Marketing", keywords: ["seo", "content strategy"] },
  ];
  opts.config?.(config);
  await saveConfig(root, config);
  for (const c of config.collections) await mkdir(path.join(root, c.path), { recursive: true });
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content);
  }
  return { root, config, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export async function openCms(
  root: string,
  extra: Parameters<typeof Cms.open>[0] = {},
): Promise<Cms> {
  return Cms.open({ root, env: {}, ...extra });
}

export const GOOD_POST = `An agent-first CMS is a content system that AI agents operate through tools instead of a dashboard. It stores content as Markdown files, generates metadata automatically and emits static output your site can consume.

## What is an agent-first CMS?

An agent-first CMS is a system where every action is a tool call. Agents create, enrich, audit and publish content through MCP while humans review in git. The agent-first CMS keeps a complete history because every change is a commit.

## How does metadata generation work?

Metadata generation runs in two layers. Deterministic rules compute reading time, keywords and structured data; a model writes descriptions, tags and FAQ answers. Read [our SEO guide](/blog/seo-basics) and [the MCP spec](https://modelcontextprotocol.io) for background.

## Key takeaways

- Agents operate the CMS through MCP tools
- Metadata generation is automatic and reviewable
- Output is static files

## FAQ

### Does an agent-first CMS need a database?

No. Content lives in Markdown files tracked by git, and builds produce static JSON.

### Can humans still edit content?

Yes. Any editor that writes Markdown works, and the CMS re-enriches on the next update.
`;

export const SEO_POST = `Search engine optimization for agent-written content starts with the same fundamentals: a clear title, a meta description and headings that match search intent.

## Titles and descriptions

Keep titles between 30 and 60 characters. Descriptions should be 120 to 160 characters and include the focus keyword. See [the agent-first CMS post](/blog/what-is-an-agent-first-cms) and [Google's guidance](https://developers.google.com/search/docs).

## Internal links

Internal links tell crawlers how pages relate. Every post should link to two others.
`;

export function postFile(fm: Record<string, unknown>, body: string): string {
  const yaml = Object.entries(fm)
    .map(
      ([k, v]) =>
        `${k}: ${Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : typeof v === "string" ? JSON.stringify(v) : String(v)}`,
    )
    .join("\n");
  return `---\n${yaml}\n---\n\n${body}`;
}
