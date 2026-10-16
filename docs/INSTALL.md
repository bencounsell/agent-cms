# Install and connect

## Requirements

- Node.js 22.12+ (`node -v`)
- A folder for your site (an existing repo is fine)
- Optional: an Anthropic API key for model-written metadata

## 1. Install the CLI

```bash
npm install -g agentcms
agentcms --version
```

`npx -y agentcms …` works without a global install; the MCP configs below use that form so they work on any machine.

From source: `git clone https://github.com/bencounsell/agent-cms && cd agent-cms && pnpm install && pnpm build && pnpm link --global`.

## 2. Create the project

```bash
cd my-site
agentcms init --name "My Site" --url https://mysite.com --description "…" --author "Your Name" --client claude-code
```

Options: `--client claude-code | claude-desktop | cursor | vscode | codex | windsurf`, `--force` to overwrite an existing config.

What is created:

| File | Purpose |
| --- | --- |
| `agentcms.config.json` | Site, collections, taxonomy, AI, research, SEO and build settings (JSON schema in `schemas/config.schema.json`) |
| `content/posts/welcome.md`, `content/pages/about.md`, `content/authors/<you>.md` | Sample entries |
| `AGENTS.md` | Tells any agent that this project uses agentcms and how to behave |
| `.mcp.json` (or the client's file) | MCP server registration |
| `.gitignore` | Adds `.agentcms/` (research snapshots and caches) |

## 3. Connect a client

All clients run the same stdio command: `npx -y agentcms mcp` from the project directory (the server finds `agentcms.config.json` by walking up from the working directory, or pass `--root`).

### Claude Code

`.mcp.json` in the project root is picked up automatically:

```json
{ "mcpServers": { "agentcms": { "command": "npx", "args": ["-y", "agentcms", "mcp"] } } }
```

Or: `claude mcp add agentcms -- npx -y agentcms mcp`

### Claude Desktop

Claude → Settings → Developer → Edit Config, add (the `cwd` matters so the server finds the project):

```json
{ "mcpServers": { "agentcms": { "command": "npx", "args": ["-y", "agentcms", "mcp"], "cwd": "/absolute/path/to/my-site" } } }
```

`agentcms install claude-desktop` prints this with the right path.

### Cursor

`.cursor/mcp.json` in the project (written by `agentcms install cursor`):

```json
{ "mcpServers": { "agentcms": { "command": "npx", "args": ["-y", "agentcms", "mcp"] } } }
```

### VS Code (Copilot agent mode)

`.vscode/mcp.json` (written by `agentcms install vscode`). VS Code supports MCP sampling, so the CMS can use the editor's model when no API key is set.

```json
{ "servers": { "agentcms": { "type": "stdio", "command": "npx", "args": ["-y", "agentcms", "mcp"] } } }
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.agentcms]
command = "npx"
args = ["-y", "agentcms", "mcp"]
cwd = "/absolute/path/to/my-site"
```

### Remote agents (Streamable HTTP)

```bash
AGENTCMS_API_TOKEN=change-me agentcms serve --host 0.0.0.0 --port 4321
```

Connect MCP clients to `http://host:4321/mcp` with `Authorization: Bearer change-me`. The same server exposes the REST API and `GET /openapi.json`. Loopback requests are allowed without a token unless `AGENTCMS_REQUIRE_TOKEN=1`.

## 4. Choose how metadata is generated

| Situation | What happens |
| --- | --- |
| `ANTHROPIC_API_KEY` set, or `ant auth login` done | The CMS calls `claude-opus-5-5` (configurable via `ai.model`) with structured outputs |
| Client supports MCP sampling (VS Code) | The CMS asks the client's model |
| Neither | Tool results include a `delegated` task; the agent generates the JSON and calls `submit_metadata`. The server instructions tell it to do so without asking |

Deterministic metadata (keywords, reading time, excerpt, social defaults, related entries, JSON-LD, FAQ and takeaways extracted from the body) is always produced.

Check what is active: `agentcms doctor`.

## 5. Screenshots in previews (optional)

`preview_page` and `agentcms preview --screenshot` render pages in headless Chromium when it is available:

```bash
npm i playwright-core
npx playwright install chromium
# or reuse an existing browser:
export AGENTCMS_CHROMIUM_PATH=/path/to/chrome
```

Without a browser, previews still return the self-contained HTML and the page audit, and the result explains how to enable screenshots.

## 6. Verify

```bash
agentcms doctor      # environment, config, AI mode
agentcms briefing    # state of the site and next actions
agentcms guide       # what the agent is told
```

Then, in your agent: "Run get_briefing and tell me what to do."

## Environment variables

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | Enables the Anthropic provider |
| `AGENTCMS_API_TOKEN` | Bearer token for `agentcms serve` |
| `AGENTCMS_REQUIRE_TOKEN=1` | Require the token even from localhost |
| `AGENTCMS_LOG=debug\|info\|warn\|error` | Log level (stderr only; stdout is reserved for MCP) |
| `AGENTCMS_CHROMIUM_PATH` | Chromium binary for preview screenshots |
