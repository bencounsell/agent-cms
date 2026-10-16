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

Until the package is published on npm, install it from the repository. Either way you end up with an `agentcms` command on your PATH.

```bash
git clone https://github.com/bencounsell/agent-cms
cd agent-cms
pnpm install          # or: corepack enable && pnpm install
pnpm build
pnpm pack             # writes agentcms-0.1.0.tgz
npm install -g ./agentcms-0.1.0.tgz
agentcms --version
```

For hacking on agentcms itself, `pnpm link --global` instead of pack-and-install makes the global command follow your working copy (run `pnpm build` after changes).

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

All clients run the same stdio server, `agentcms mcp`, from the project directory (the server finds `agentcms.config.json` by walking up from the working directory, or pass `--root`). Project-level configs call the `agentcms` command from your PATH; app-level configs (Claude Desktop, Codex, Windsurf) get absolute paths to Node and the launcher plus the project `cwd`, because desktop apps do not see your shell PATH. `agentcms install <client>` prints or writes the right form with your paths filled in.

### Claude Code

`.mcp.json` in the project root is picked up automatically:

```json
{ "mcpServers": { "agentcms": { "command": "agentcms", "args": ["mcp"] } } }
```

Or: `claude mcp add agentcms -- agentcms mcp`

### Claude Desktop

Run `agentcms install claude-desktop` inside the project; it prints a block like this with your real paths:

```json
{ "mcpServers": { "agentcms": { "command": "/usr/local/bin/node", "args": ["/usr/local/lib/node_modules/agentcms/bin/agentcms.js", "mcp"], "cwd": "/absolute/path/to/my-site" } } }
```

Paste it into Claude → Settings → Developer → Edit Config (`claude_desktop_config.json`) and restart Claude Desktop. The absolute paths are deliberate: desktop apps do not inherit your shell PATH, and the `cwd` tells the server which project to open.

### Cursor

`.cursor/mcp.json` in the project (written by `agentcms install cursor`):

```json
{ "mcpServers": { "agentcms": { "command": "agentcms", "args": ["mcp"] } } }
```

### VS Code (Copilot agent mode)

`.vscode/mcp.json` (written by `agentcms install vscode`). VS Code supports MCP sampling, so the CMS can use the editor's model when no API key is set.

```json
{ "servers": { "agentcms": { "type": "stdio", "command": "agentcms", "args": ["mcp"] } } }
```

### Codex

`agentcms install codex` prints the block for `~/.codex/config.toml` with absolute paths:

```toml
[mcp_servers.agentcms]
command = "/usr/local/bin/node"
args = ["/usr/local/lib/node_modules/agentcms/bin/agentcms.js", "mcp"]
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
