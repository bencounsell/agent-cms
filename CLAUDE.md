# agentcms — working notes for agents

agentcms is an agent-first headless CMS: content as Markdown files, metadata generated automatically, SEO/AEO audits, competitor research, managed Liquid templates, static output. Three surfaces over one core: MCP server (`src/mcp`), CLI (`src/cli`), HTTP API (`src/api`). Everything they call lives in `src/core` behind the `Cms` facade (`src/core/cms.ts`).

## Commands

- `pnpm test` — Vitest suite (fast, no network; HTTP is mocked). `pnpm test -- test/audit.test.ts` for one file.
- `pnpm lint` — Biome (format + lint). `pnpm lint:fix` applies fixes. Run it before committing; the formatter reflows long lines, so re-read a file after `lint:fix` before editing it again.
- `pnpm typecheck` — TypeScript 7, strict, `erasableSyntaxOnly` (no enums, no parameter properties, no namespaces).
- `pnpm check` — lint + typecheck + tests. Must be green before pushing.
- `pnpm build` — compiles `src/` to `dist/`; `bin/agentcms.js` runs the compiled CLI. In cloud sessions the SessionStart hook does this and links `agentcms` onto PATH.
- `pnpm cli -- <command> --root <project>` runs the CLI from source without building.

## Conventions

- ESM only. Relative imports use `.ts` extensions in source; `tsc` rewrites them on emit.
- Zod 4 everywhere (`z.looseObject`, `.prefault({})` for nested defaults, `z.toJSONSchema`).
- Never write to stdout in code the MCP stdio server can reach; use `log` from `src/core/util/log.ts` (stderr).
- Tool descriptions are the product: every MCP tool says when to use it, what it returns and what to do next. Keep `SERVER_INSTRUCTIONS` and `AGENT_GUIDE` in `src/mcp/guide.ts` in step with new tools; `docs/AGENT-GUIDE.md` is generated from the latter.
- The default theme lives in `theme/default/` and is shipped in the package (`files` in package.json). Project templates override it file by file.
- The CMS generates the SEO head block; templates place it with `{{ head | raw }}`. Do not hand-write meta tags in templates.
- Config schema changes: update `src/core/config/schema.ts`, run `pnpm schema` to regenerate `schemas/config.schema.json`, and update `docs/CONTENT-MODEL.md`.

## Trying it end to end

```bash
mkdir /tmp/site && cd /tmp/site
agentcms init --name Demo --url https://demo.example --author "Dev" --client claude-code
agentcms content publish welcome --force && agentcms build && agentcms preview / --screenshot home.png
```

Set `ai.provider` to `deterministic` in `agentcms.config.json` to avoid model calls in experiments.
