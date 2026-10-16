import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { CmsConfig } from "../core/config/schema.ts";

/** Absolute path of the agentcms launcher, valid from both src/ and dist/. */
export const BIN_PATH = fileURLToPath(new URL("../../bin/agentcms.js", import.meta.url));

export function agentsMd(config: CmsConfig): string {
  return `# AGENTS.md

This project's content is managed by **agentcms**, an agent-first headless CMS. There is no admin UI: content is edited through the agentcms MCP server, CLI, or HTTP API, and lives as Markdown files under \`content/\`.

## How to work with the content

- Prefer the MCP server (\`agentcms mcp\`) when it is connected: start with \`get_briefing\`, create with \`create_content\`, check with \`audit_content\`, publish only after the user agrees, then \`build_site\`.
- Without MCP, use the CLI: \`agentcms briefing\`, \`agentcms content create\`, \`agentcms audit\`, \`agentcms build\`. Run \`agentcms guide\` for the full agent guide.
- Editing the Markdown files directly is fine. Keep the frontmatter valid (\`agentcms validate\`) and run \`agentcms enrich <slug>\` afterwards so metadata stays in sync.
- Never publish, delete, or rename published content without explicit confirmation from the user.

## Layout

- \`agentcms.config.json\` – site identity, collections, taxonomy, AI/research/SEO/build settings
${config.collections.map((c) => `- \`${c.path}/\` – ${c.label ?? c.name} (${c.kind}), served at \`${c.urlPattern}\``).join("\n")}
- \`${config.build.html.templatesDir}/\` and \`theme.json\` – Liquid templates and design tokens the site is rendered with (managed through the agentcms template tools; a bundled default theme fills in missing files)
- \`${config.build.outDir}/\` – the built site: pages, assets, sitemap, feeds, llms.txt, plus the JSON API under \`${config.build.dataPath}/\`
- \`.agentcms/\` – cache: competitor research snapshots, last briefing and comparison

## Writing rules

Answer-first opening (40-70 words), H2 headings phrased as questions, a "Key takeaways" list, an FAQ section, internal links by path, cited sources, no H1 in the body, no invented facts.
`;
}

export function welcomePost(config: CmsConfig, author?: string): string {
  const now = new Date().toISOString();
  return `---
id: ${randomUUID()}
title: Welcome to ${config.site.name}
slug: welcome
status: draft
createdAt: ${now}
updatedAt: ${now}
${author ? `author: ${author}\n` : ""}tags: []
keywords: []
---

This site is managed by agentcms, a headless CMS operated through AI agents instead of a dashboard. Content lives in Markdown files, metadata is generated automatically, and every publish produces static files your site can consume.

## How does publishing work here?

An agent drafts a post, the CMS fills in the description, tags, keywords, social cards and structured data, an audit scores the result for search and answer engines, and a human says "publish".

## Key takeaways

- Content is plain Markdown in git
- Metadata is generated, then reviewed
- Output is static JSON, feeds, a sitemap and llms.txt

## FAQ

### Can I edit these files by hand?

Yes. Any editor works. Run \`agentcms enrich welcome\` afterwards to refresh the generated metadata.

### Where does the output go?

Into \`${config.build.outDir}/\` after \`agentcms build\`.
`;
}

export function aboutPage(config: CmsConfig): string {
  const now = new Date().toISOString();
  return `---
id: ${randomUUID()}
title: About
slug: about
status: draft
createdAt: ${now}
updatedAt: ${now}
tags: []
keywords: []
---

${config.site.description || `${config.site.name} is a new site.`} Replace this page with a description of who you are, who the site is for, and how to get in touch.
`;
}

export function authorEntry(name: string, slug: string): string {
  const now = new Date().toISOString();
  return `---
id: ${randomUUID()}
title: ${name}
slug: ${slug}
status: published
publishedAt: ${now}
createdAt: ${now}
updatedAt: ${now}
tags: []
keywords: []
---

${name} writes for this site. Add a short bio, areas of expertise and links to profiles so author structured data carries real E-E-A-T signals.
`;
}

export type ClientName =
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "vscode"
  | "codex"
  | "windsurf";

export function clientConfig(
  client: ClientName,
  projectRoot: string,
): { file?: string; content: string; note: string } {
  // Project-level files are committed, so they call the `agentcms` command from PATH.
  // App-level files (Claude Desktop, Codex, Windsurf) run without a shell PATH, so they get
  // absolute paths to this Node binary and this install's launcher, plus the project cwd.
  const fromPath = { command: "agentcms", args: ["mcp"] };
  const absolute = { command: process.execPath, args: [BIN_PATH, "mcp"], cwd: projectRoot };
  const pathNote =
    "Requires `agentcms` on your PATH (npm install -g agentcms, or the global link from the install guide).";
  switch (client) {
    case "claude-code":
      return {
        file: ".mcp.json",
        content: `${JSON.stringify({ mcpServers: { agentcms: fromPath } }, null, 2)}\n`,
        note: `Claude Code picks up .mcp.json automatically from the project root. ${pathNote}\nAlternatively: claude mcp add agentcms -- agentcms mcp`,
      };
    case "cursor":
      return {
        file: ".cursor/mcp.json",
        content: `${JSON.stringify({ mcpServers: { agentcms: fromPath } }, null, 2)}\n`,
        note: `Cursor reads .cursor/mcp.json in the project. Enable the server in Settings → MCP. ${pathNote}`,
      };
    case "vscode":
      return {
        file: ".vscode/mcp.json",
        content: `${JSON.stringify({ servers: { agentcms: { type: "stdio", ...fromPath } } }, null, 2)}\n`,
        note: `VS Code (Copilot agent mode) reads .vscode/mcp.json. VS Code supports sampling, so the CMS can use the editor's model when no API key is set. ${pathNote}`,
      };
    case "windsurf":
      return {
        content: `${JSON.stringify({ mcpServers: { agentcms: absolute } }, null, 2)}\n`,
        note: "Add this to ~/.codeium/windsurf/mcp_config.json.",
      };
    case "codex":
      return {
        content: `[mcp_servers.agentcms]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(BIN_PATH)}, "mcp"]\ncwd = ${JSON.stringify(projectRoot)}\n`,
        note: "Add this to ~/.codex/config.toml.",
      };
    default:
      return {
        content: `${JSON.stringify({ mcpServers: { agentcms: absolute } }, null, 2)}\n`,
        note: "Add this to claude_desktop_config.json (Claude → Settings → Developer → Edit Config), then restart Claude Desktop. The absolute paths mean it works even though desktop apps do not see your shell PATH; the cwd tells the server which project to open.",
      };
  }
}
