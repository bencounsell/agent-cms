# agentcms

**An agent-first headless CMS.** No admin UI. Content lives as Markdown files in your repo, every operation is a tool for an AI agent (MCP), a CLI command, or an HTTP API call, and the only thing it ever produces is static files.

Your agent (Claude Code, Claude Desktop, Cursor, VS Code, Codex, or anything that speaks MCP) *is* the editor. agentcms tells it how to work, fills in the metadata, audits for search and answer engines, watches competitors, and keeps a list of what to do next.

```
you ──▶ agent ──▶ agentcms (MCP / CLI / HTTP) ──▶ content/*.md ──▶ build ──▶ public/cms/*.json, feeds, sitemap, llms.txt
```

## What it does

- **Content as files.** `content/posts/my-post.md` with YAML frontmatter. Git is the history. Humans and agents edit the same files.
- **Metadata on autopilot.** Create or update an entry and the CMS fills in description, excerpt, category, tags, keywords, focus keyword, Open Graph and Twitter cards, a direct answer, key takeaways, FAQ pairs, target questions, related entries, reading time and JSON-LD. Generated fields carry provenance; doubtful ones are flagged for review. Human-written values are never overwritten.
- **Audits that gate publishing.** SEO, AEO (answer-engine optimisation), readability, links and freshness, scored 0–100 with a concrete fix for every failed check. Publishing below the threshold is refused unless forced.
- **Proactive.** `get_briefing` opens every session with drafts, stale posts, thin metadata, broken links, new competitor pages and an ordered list of next actions expressed as tool calls. Mutations return next actions too.
- **Competitor research.** Crawls competitor blogs politely (robots.txt, sitemaps, one request at a time), records titles, headings, dates, depth, FAQ and structured-data usage, diffs each run, and turns it into topic gaps and ranked opportunities.
- **Content suggestions.** New topics from gaps, questions competitors answer that you do not, series for thin clusters, refreshes, expansions, internal links. With a model available, each idea comes with an outline.
- **Static output only.** `build_site` writes a JSON content API, RSS/Atom/JSON feeds, `sitemap.xml`, `llms.txt` and `llms-full.txt`, a MiniSearch index, `taxonomy.json` and a suggested `robots.txt`. Any site generator consumes them.
- **Three surfaces, one core.** MCP (stdio and Streamable HTTP), a CLI, and an HTTP API with an OpenAPI 3.1 document.

## Install

Requires Node.js 22.12 or newer.

```bash
npm install -g agentcms
# or run it on demand with: npx agentcms …
```

From source (until the package is published, or for development):

```bash
git clone https://github.com/bencounsell/agent-cms
cd agent-cms && pnpm install && pnpm build && pnpm link --global
```

## First steps

1. **Create a project** in your site's repository (or an empty folder):

   ```bash
   cd my-site
   agentcms init --name "My Site" --url https://mysite.com --description "What the site is about" --author "Your Name" --client claude-code
   ```

   This writes `agentcms.config.json`, `content/{posts,pages,authors}/` with sample entries, `AGENTS.md` (so any agent knows the project uses agentcms), a `.gitignore` entry for the cache, and the MCP config for your client (`.mcp.json` for Claude Code).

2. **Connect your agent.** Claude Code picks up `.mcp.json` automatically. For other clients see [docs/INSTALL.md](docs/INSTALL.md) or run `agentcms install <client>`.

3. **Give it a model (optional but recommended).** Set `ANTHROPIC_API_KEY` (or run `ant auth login`) and the CMS writes model-quality metadata with `claude-opus-5-5`. Without it, the CMS uses the connected client's model through MCP sampling where supported, and otherwise hands the generation task to the agent itself. Deterministic metadata (keywords, reading time, structured data, social defaults, extracted FAQ) always works offline.

4. **Talk to it.** In your agent:

   > Run get_briefing and tell me what to work on.
   > Write a post about "how we handle on-call" for engineering managers.
   > Add https://competitor.com/blog as a competitor and compare us.
   > Build the site.

   Or from the terminal:

   ```bash
   agentcms briefing
   agentcms content create --title "Hello" --body-file post.md
   agentcms audit hello
   agentcms research add https://competitor.com/blog && agentcms research refresh && agentcms research compare
   agentcms build
   ```

5. **Consume the output.** After `agentcms build`, `public/cms/` holds everything your site needs:

   ```
   public/cms/
   ├── site.json                      # site info, collections, taxonomy
   ├── content/posts/index.json       # list with metadata
   ├── content/posts/<slug>.json      # frontmatter + html + text + toc + jsonld
   ├── taxonomy.json
   ├── feeds/rss.xml · atom.xml · feed.json
   ├── sitemap.xml
   ├── llms.txt · llms-full.txt       # answer-engine index (llmstxt.org)
   ├── search-index.json              # MiniSearch, load client-side
   └── robots.txt                     # suggested, includes AI crawler rules
   ```

   For example, in Astro: `const posts = (await import("../../public/cms/content/posts/index.json")).entries;`

## How an agent works with it

The MCP server ships **instructions** that tell the agent the workflow: start with `get_briefing`; search before creating; write answer-first content with question headings, key takeaways and an FAQ; `create_content` (metadata is generated); fix what the audit flags; ask the human before publishing; `build_site` afterwards. The full guide is served as the `agentcms://guide` resource and printed by `agentcms guide`.

| Tools | |
| --- | --- |
| `get_briefing` | Session opener: state of the site plus ordered next actions |
| `list_content` · `get_content` · `search_content` | Read |
| `create_content` · `update_content` · `set_status` · `delete_content` | Write (publishing is audit-gated, deletion needs explicit confirmation) |
| `enrich_metadata` · `submit_metadata` | Generate metadata, or accept metadata the agent generated itself |
| `audit_content` · `improve_content` · `validate_content` | Analyse |
| `suggest_content` | Ideas with evidence |
| `add_competitor` · `list_competitors` · `research_competitors` · `compare_competitors` · `remove_competitor` | Research |
| `build_site` · `get_config` · `update_config` | Output and configuration |

Resources: `agentcms://guide`, `agentcms://config`, `agentcms://briefing`, `agentcms://content/{collection}/{slug}`, `agentcms://schema/{collection}`.
Prompts: `write_post`, `improve_post`, `seo_audit`, `aeo_optimize`, `competitor_brief`, `content_calendar`.

## AI modes

`ai.provider` in `agentcms.config.json`:

| Value | Behaviour |
| --- | --- |
| `auto` (default) | Anthropic API if credentials resolve → MCP sampling if the client supports it → delegate to the agent |
| `anthropic` | Anthropic API (`ai.model`, default `claude-opus-5-5`; `ai.effort` low/medium/high) |
| `sampling` | The connected MCP client's model (VS Code supports this; Claude Desktop and Claude Code currently do not) |
| `delegate` | Tool results include a `delegated` task: system prompt, prompt, JSON schema and the `submit_metadata` call to make |
| `deterministic` | Never call a model |

## Documentation

- [Install and connect clients](docs/INSTALL.md)
- [Agent guide](docs/AGENT-GUIDE.md) (what the agent is told)
- [Content model and configuration](docs/CONTENT-MODEL.md)
- [SEO and AEO checks](docs/SEO-AEO.md)
- [HTTP API](docs/API.md)
- [Implementation plan](docs/PLAN.md)

## Development

```bash
pnpm install
pnpm test          # vitest
pnpm check         # biome + tsc + vitest
pnpm build         # compile to dist/
pnpm cli -- briefing --root path/to/project   # run from source
```

MIT licensed.
