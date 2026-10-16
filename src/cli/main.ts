#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { Cms } from "../core/cms.ts";
import { CONFIG_FILENAME, defaultConfig, saveConfig } from "../core/config/index.ts";
import {
  METADATA_FIELDS,
  type MetadataField,
  type Status,
  StatusSchema,
} from "../core/content/schema.ts";
import { serializeEntry, summarizeEntry } from "../core/serialize.ts";
import { TemplateStore } from "../core/templates/store.ts";
import { THEME_FILENAME } from "../core/templates/theme.ts";
import { CmsError } from "../core/util/errors.ts";
import { ensureDir, exists, readTextIfExists, writeText } from "../core/util/fs.ts";
import { setLogLevel } from "../core/util/log.ts";
import { slugify } from "../core/util/text.ts";
import { AGENT_GUIDE } from "../mcp/guide.ts";
import { SERVER_VERSION } from "../mcp/server.ts";
import {
  aboutPage,
  agentsMd,
  authorEntry,
  type ClientName,
  clientConfig,
  welcomePost,
} from "./templates.ts";

const program = new Command();
program
  .name("agentcms")
  .description(
    "Agent-first headless CMS: content as files, static output, operated through MCP, CLI and HTTP API.",
  )
  .version(SERVER_VERSION)
  .option("--root <dir>", "project root (default: nearest directory with agentcms.config.json)")
  .option("--json", "machine-readable JSON output")
  .option("-v, --verbose", "verbose logging to stderr");

type GlobalOpts = { root?: string; json?: boolean; verbose?: boolean };
const globals = (): GlobalOpts => program.opts<GlobalOpts>();

async function open(): Promise<Cms> {
  const g = globals();
  if (g.verbose) setLogLevel("debug");
  return Cms.open({ root: g.root });
}

function out(data: unknown, human: () => void): void {
  if (globals().json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else human();
}

function statusColor(s: string): string {
  return s === "published"
    ? pc.green(s)
    : s === "draft"
      ? pc.yellow(s)
      : s === "review"
        ? pc.cyan(s)
        : pc.dim(s);
}

function score(n: number): string {
  return n >= 80 ? pc.green(String(n)) : n >= 60 ? pc.yellow(String(n)) : pc.red(String(n));
}

function run<A extends unknown[]>(
  fn: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      if (err instanceof CmsError) {
        process.stderr.write(`${pc.red(`error (${err.code})`)}: ${err.message}\n`);
        if (err.details) process.stderr.write(`${JSON.stringify(err.details, null, 2)}\n`);
      } else {
        process.stderr.write(`${pc.red("error")}: ${(err as Error).stack ?? String(err)}\n`);
      }
      process.exitCode = 1;
    }
  };
}

function parseStatus(v: string): Status {
  const r = StatusSchema.safeParse(v);
  if (!r.success)
    throw new InvalidArgumentError(`status must be one of ${StatusSchema.options.join(", ")}`);
  return r.data;
}

function parseFields(v: string): MetadataField[] {
  return v.split(",").map((f) => {
    const t = f.trim() as MetadataField;
    if (!(METADATA_FIELDS as readonly string[]).includes(t))
      throw new InvalidArgumentError(`unknown field "${t}"; valid: ${METADATA_FIELDS.join(", ")}`);
    return t;
  });
}

function parseSet(values: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of values) {
    const idx = kv.indexOf("=");
    if (idx === -1) throw new InvalidArgumentError(`--set expects key=value, got "${kv}"`);
    const key = kv.slice(0, idx);
    const raw = kv.slice(idx + 1);
    let value: unknown = raw;
    if (raw === "true") value = true;
    else if (raw === "false") value = false;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
    else if (raw.startsWith("[") || raw.startsWith("{")) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    } else if (key === "tags" || key === "keywords")
      value = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const parts = key.split(".");
    let target = out;
    for (const p of parts.slice(0, -1)) target = (target[p] as Record<string, unknown>) ??= {};
    target[parts[parts.length - 1]!] = value;
  }
  return out;
}

async function readBody(opts: { body?: string; bodyFile?: string }): Promise<string | undefined> {
  if (opts.body !== undefined) return opts.body;
  if (opts.bodyFile === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  }
  if (opts.bodyFile) return readFile(opts.bodyFile, "utf8");
  return undefined;
}

// ---------------------------------------------------------------- init

program
  .command("init [dir]")
  .description(
    "Create an agentcms project: config, content folders, sample content, AGENTS.md and MCP client config",
  )
  .option("--name <name>", "site name")
  .option("--url <url>", "site URL", "https://example.com")
  .option("--description <text>", "one-line site description")
  .option("--author <name>", "default author name")
  .option(
    "--client <client>",
    "write MCP config for: claude-code, claude-desktop, cursor, vscode, codex, windsurf",
    "claude-code",
  )
  .option("--force", "overwrite an existing config")
  .action(
    run(
      async (
        dir: string | undefined,
        opts: {
          name?: string;
          url: string;
          description?: string;
          author?: string;
          client: ClientName;
          force?: boolean;
        },
      ) => {
        const root = path.resolve(dir ?? ".");
        await ensureDir(root);
        const configFile = path.join(root, CONFIG_FILENAME);
        if ((await exists(configFile)) && !opts.force)
          throw new CmsError(
            "CONFLICT",
            `${CONFIG_FILENAME} already exists in ${root} (use --force to overwrite)`,
          );
        const name = opts.name ?? path.basename(root);
        const config = defaultConfig({ name, url: opts.url, description: opts.description });
        const authorSlug = opts.author ? slugify(opts.author) : undefined;
        if (authorSlug) config.site.defaultAuthor = authorSlug;
        await saveConfig(root, config);
        const written = [CONFIG_FILENAME];
        for (const c of config.collections) await ensureDir(path.join(root, c.path));
        const posts = config.collections.find((c) => c.kind === "post")!;
        const pages = config.collections.find((c) => c.kind === "page")!;
        const authors = config.collections.find((c) => c.kind === "author")!;
        const files: [string, string][] = [
          [path.join(posts.path, "welcome.md"), welcomePost(config, authorSlug)],
          [path.join(pages.path, "about.md"), aboutPage(config)],
          ["AGENTS.md", agentsMd(config)],
        ];
        if (authorSlug && opts.author)
          files.push([
            path.join(authors.path, `${authorSlug}.md`),
            authorEntry(opts.author, authorSlug),
          ]);
        for (const [rel, content] of files) {
          const abs = path.join(root, rel);
          if (!(await exists(abs))) {
            await writeText(abs, content);
            written.push(rel);
          }
        }
        const templates = new TemplateStore(root, config);
        for (const rel of await templates.eject()) written.push(rel);
        const themeFile = path.join(root, THEME_FILENAME);
        if (!(await exists(themeFile))) {
          const { ThemeStore } = await import("../core/templates/theme.ts");
          await new ThemeStore(root).reset();
          written.push(THEME_FILENAME);
        }
        const gi = path.join(root, ".gitignore");
        const existing = (await readTextIfExists(gi)) ?? "";
        if (!existing.includes(".agentcms/")) {
          await writeFile(
            gi,
            `${existing.trimEnd()}${existing ? "\n" : ""}# agentcms cache\n.agentcms/\n`,
          );
          written.push(".gitignore");
        }
        const client = clientConfig(opts.client, root);
        if (client.file) {
          const abs = path.join(root, client.file);
          if (!(await exists(abs))) {
            await writeText(abs, client.content);
            written.push(client.file);
          }
        }
        out({ root, written, client: opts.client }, () => {
          process.stdout.write(`${pc.green("✔")} Created agentcms project in ${root}\n`);
          for (const w of written) process.stdout.write(`  ${pc.dim("+")} ${w}\n`);
          process.stdout.write(
            `\n${pc.bold("Connect your agent")} (${opts.client}):\n${client.note}\n`,
          );
          if (!client.file) process.stdout.write(`\n${client.content}\n`);
          process.stdout.write(
            `\n${pc.bold("Next")}: ask your agent to run get_briefing, or try:\n  agentcms briefing\n  agentcms doctor\n`,
          );
        });
      },
    ),
  );

program
  .command("install <client>")
  .description(
    "Print or write MCP client configuration (claude-code, claude-desktop, cursor, vscode, codex, windsurf)",
  )
  .action(
    run(async (client: ClientName) => {
      const cms = await open();
      const cfg = clientConfig(client, cms.root);
      if (cfg.file) {
        await writeText(path.join(cms.root, cfg.file), cfg.content);
        process.stdout.write(`${pc.green("✔")} wrote ${cfg.file}\n${cfg.note}\n`);
      } else {
        process.stdout.write(`${cfg.note}\n\n${cfg.content}`);
      }
    }),
  );

// ---------------------------------------------------------------- servers

program
  .command("mcp")
  .description(
    "Run the MCP server over stdio (for Claude Code, Claude Desktop, Cursor, VS Code, …)",
  )
  .action(
    run(async () => {
      const { runStdio } = await import("../mcp/stdio.ts");
      await runStdio({ root: globals().root });
    }),
  );

program
  .command("serve")
  .description("Run the HTTP API (OpenAPI at /openapi.json) with the MCP server at /mcp")
  .option("-p, --port <port>", "port", "4321")
  .option("-H, --host <host>", "host", "127.0.0.1")
  .action(
    run(async (opts: { port: string; host: string }) => {
      const cms = await open();
      const { serve } = await import("../api/serve.ts");
      await serve(cms, { port: Number(opts.port), host: opts.host });
    }),
  );

// ---------------------------------------------------------------- briefing / insights

program
  .command("briefing")
  .description("What changed, what is stale, what needs review, what to do next")
  .action(
    run(async () => {
      const cms = await open();
      const b = await cms.briefing();
      out(b, () => {
        process.stdout.write(`${pc.bold(b.headline)}\n\n`);
        for (const c of b.counts.byCollection)
          process.stdout.write(
            `  ${c.name.padEnd(12)} ${c.total} ${pc.dim(
              Object.entries(c.byStatus)
                .map(([s, n]) => `${s}:${n}`)
                .join(" "),
            )}\n`,
          );
        const section = (title: string, items: string[]) => {
          if (!items.length) return;
          process.stdout.write(`\n${pc.bold(title)}\n${items.map((i) => `  • ${i}`).join("\n")}\n`);
        };
        section(
          "Drafts",
          b.drafts.map(
            (d) =>
              `${d.title} ${pc.dim(`(${d.ageDays}d${d.auditScore !== undefined ? `, score ${d.auditScore}` : ""})`)}`,
          ),
        );
        section(
          "Needs review",
          b.inReview.map((r) => `${r.title} ${pc.dim(r.review.join(", "))}`),
        );
        section(
          "Stale",
          b.stale.map((s) => `${s.title} ${pc.dim(`${s.ageDays}d`)}`),
        );
        section(
          "Thin metadata",
          b.weakMetadata.map((w) => `${w.title} ${pc.dim(`missing ${w.missing.join(", ")}`)}`),
        );
        section(
          "Below publish threshold",
          b.lowScores.map((l) => `${l.title} ${score(l.overall)} ${pc.dim(l.topIssue)}`),
        );
        section(
          "Orphans",
          b.orphans.map((o) => o.title),
        );
        section(
          "Broken links",
          b.brokenLinks.map((l) => `${l.from} → ${l.url}`),
        );
        if (b.research.competitors)
          process.stdout.write(
            `\n${pc.bold("Research")}: ${b.research.competitors} competitor(s), last refresh ${b.research.lastRefresh?.slice(0, 10) ?? "never"}${b.research.refreshDue ? pc.yellow(" (refresh due)") : ""}\n`,
          );
        for (const n of b.research.newPages)
          process.stdout.write(`  • ${n.host}: ${n.count} new – ${n.titles.join("; ")}\n`);
        process.stdout.write(
          `\n${pc.bold("AI")}: ${b.ai.mode}${b.ai.provider ? ` ${b.ai.provider}` : ""}${b.ai.reason ? pc.dim(` (${b.ai.reason})`) : ""}\n`,
        );
        section(
          "Next actions",
          b.nextActions.map(
            (a) => `${a.action} ${pc.dim(`→ ${a.tool} ${JSON.stringify(a.args)} · ${a.reason}`)}`,
          ),
        );
      });
    }),
  );

program
  .command("suggest")
  .description("Content ideas with evidence: gaps, questions, refreshes, expansions, links")
  .option("-n, --limit <n>", "number of suggestions", "15")
  .option("--focus <theme>", "narrow to a theme")
  .option("--no-ai", "do not use a model to refine ideas")
  .action(
    run(async (opts: { limit: string; focus?: string; ai: boolean }) => {
      const cms = await open();
      const s = await cms.suggest({ limit: Number(opts.limit), focus: opts.focus, useAi: opts.ai });
      out(s, () => {
        for (const x of s) {
          process.stdout.write(
            `${pc.bold(x.title)} ${pc.dim(`[${x.type}, ${x.effort}, score ${Math.round(x.score)}]`)}\n  ${x.rationale}\n`,
          );
          if (x.targetKeywords.length)
            process.stdout.write(`  ${pc.dim("keywords:")} ${x.targetKeywords.join(", ")}\n`);
          if (x.outline?.length)
            process.stdout.write(`  ${pc.dim("outline:")} ${x.outline.join(" | ")}\n`);
          if (x.evidence.length)
            process.stdout.write(`  ${pc.dim("evidence:")} ${x.evidence.slice(0, 3).join("; ")}\n`);
          process.stdout.write("\n");
        }
        if (!s.length)
          process.stdout.write("No suggestions yet. Add content and competitors first.\n");
      });
    }),
  );

program
  .command("improve <slug>")
  .description("Improvement plan for an entry")
  .option("-c, --collection <name>", "collection", "posts")
  .action(
    run(async (slug: string, opts: { collection: string }) => {
      const cms = await open();
      const p = await cms.improve(opts.collection, slug);
      out(p, () => {
        process.stdout.write(
          `${pc.bold(p.title)} – overall ${score(p.scores.overall!)} ${p.publishable ? pc.green("publishable") : pc.yellow("not publishable")}\n\n`,
        );
        for (const s of p.steps)
          process.stdout.write(
            `  ${s.priority === 1 ? pc.red("!") : s.priority === 2 ? pc.yellow("•") : pc.dim("·")} [${s.area}] ${s.action}\n`,
          );
        if (p.linkCandidates.length)
          process.stdout.write(
            `\n${pc.bold("Link to")}: ${p.linkCandidates.map((l) => `${l.title} (${l.url})`).join(", ")}\n`,
          );
        if (p.faqCandidates.length)
          process.stdout.write(`${pc.bold("FAQ candidates")}: ${p.faqCandidates.join(" | ")}\n`);
      });
    }),
  );

// ---------------------------------------------------------------- content

const content = program.command("content").description("Create, read, update and delete entries");

content
  .command("list [collection]")
  .description("List entries")
  .option("-s, --status <status>", "filter by status", parseStatus)
  .option("-t, --tag <tag>")
  .option("-q, --query <text>")
  .option("-n, --limit <n>")
  .action(
    run(
      async (
        collection: string | undefined,
        opts: { status?: Status; tag?: string; query?: string; limit?: string },
      ) => {
        const cms = await open();
        const o = {
          status: opts.status,
          tag: opts.tag,
          query: opts.query,
          limit: opts.limit ? Number(opts.limit) : undefined,
        };
        const entries = collection ? await cms.list(collection, o) : await cms.store.all(o);
        out(entries.map(summarizeEntry), () => {
          for (const e of entries)
            process.stdout.write(
              `${statusColor(e.frontmatter.status).padEnd(20)} ${pc.bold(`${e.collection}/${e.slug}`)}  ${e.frontmatter.title}${e.frontmatter.review?.length ? pc.yellow(`  review: ${e.frontmatter.review.join(",")}`) : ""}\n`,
            );
          if (!entries.length) process.stdout.write("No entries.\n");
        });
      },
    ),
  );

content
  .command("get <slug>")
  .description("Show an entry")
  .option("-c, --collection <name>", "collection", "posts")
  .option("--raw", "print the raw Markdown file")
  .action(
    run(async (slug: string, opts: { collection: string; raw?: boolean }) => {
      const cms = await open();
      const e = await cms.get(opts.collection, slug);
      if (opts.raw) {
        process.stdout.write(await readFile(e.file, "utf8"));
        return;
      }
      out(serializeEntry(e), () => {
        process.stdout.write(
          `${pc.bold(e.frontmatter.title)} ${statusColor(e.frontmatter.status)}\n${pc.dim(e.url)}\n${pc.dim(e.relativePath)}\n\n${JSON.stringify(e.frontmatter, null, 2)}\n\n${e.body}\n`,
        );
      });
    }),
  );

content
  .command("create")
  .description("Create an entry (metadata is generated automatically)")
  .requiredOption("--title <title>")
  .option("-c, --collection <name>", "collection", "posts")
  .option("--body <markdown>")
  .option("--body-file <path>", "read the body from a file, or - for stdin")
  .option("--slug <slug>")
  .option("-s, --status <status>", "draft|review|published", parseStatus)
  .option("--set <key=value...>", "extra frontmatter fields (dot paths, JSON values allowed)")
  .option("--no-enrich", "skip metadata generation")
  .action(
    run(
      async (opts: {
        title: string;
        collection: string;
        body?: string;
        bodyFile?: string;
        slug?: string;
        status?: Status;
        set?: string[];
        enrich: boolean;
      }) => {
        const cms = await open();
        const r = await cms.create(
          opts.collection,
          {
            title: opts.title,
            body: await readBody(opts),
            slug: opts.slug,
            status: opts.status,
            ...parseSet(opts.set ?? []),
          },
          { enrich: opts.enrich },
        );
        out({ ...r, entry: serializeEntry(r.entry, { body: false }) }, () => {
          process.stdout.write(
            `${pc.green("✔")} created ${r.entry.collection}/${r.entry.slug} (${r.entry.relativePath})\n`,
          );
          if (r.enrichment)
            process.stdout.write(
              `  generated: ${r.enrichment.generated.join(", ") || "nothing"} via ${r.enrichment.provider}${r.enrichment.review.length ? pc.yellow(`; review: ${r.enrichment.review.join(", ")}`) : ""}\n`,
            );
          if (r.enrichment?.delegated)
            process.stdout.write(
              pc.yellow(
                "  no model available: run with ANTHROPIC_API_KEY or use the MCP server so the agent generates metadata\n",
              ),
            );
          if (r.audit)
            process.stdout.write(
              `  audit: overall ${score(r.audit.scores.overall)} (seo ${r.audit.scores.seo}, aeo ${r.audit.scores.aeo}, readability ${r.audit.scores.readability})\n`,
            );
          for (const a of r.nextActions) process.stdout.write(`  → ${a.action}\n`);
        });
      },
    ),
  );

content
  .command("update <slug>")
  .description("Update an entry's fields and/or body")
  .option("-c, --collection <name>", "collection", "posts")
  .option("--body <markdown>")
  .option("--body-file <path>")
  .option(
    "--set <key=value...>",
    "fields to set (e.g. --set title=New --set tags=a,b --set seo.title=X)",
  )
  .option("--enrich", "force metadata regeneration")
  .action(
    run(
      async (
        slug: string,
        opts: {
          collection: string;
          body?: string;
          bodyFile?: string;
          set?: string[];
          enrich?: boolean;
        },
      ) => {
        const cms = await open();
        const r = await cms.update(
          opts.collection,
          slug,
          { body: await readBody(opts), ...parseSet(opts.set ?? []) },
          { enrich: opts.enrich },
        );
        out({ ...r, entry: serializeEntry(r.entry, { body: false }) }, () => {
          process.stdout.write(`${pc.green("✔")} updated ${r.entry.collection}/${r.entry.slug}\n`);
          if (r.audit) process.stdout.write(`  audit: overall ${score(r.audit.scores.overall)}\n`);
          for (const a of r.nextActions) process.stdout.write(`  → ${a.action}\n`);
        });
      },
    ),
  );

content
  .command("delete <slug>")
  .description("Delete an entry's file")
  .option("-c, --collection <name>", "collection", "posts")
  .option("-y, --yes", "skip confirmation")
  .action(
    run(async (slug: string, opts: { collection: string; yes?: boolean }) => {
      if (!opts.yes)
        throw new CmsError(
          "BLOCKED",
          "Pass --yes to confirm deletion (or set status archived instead)",
        );
      const cms = await open();
      const r = await cms.delete(opts.collection, slug);
      out(r, () => process.stdout.write(`${pc.green("✔")} deleted ${r.deleted}\n`));
    }),
  );

for (const [name, status] of [
  ["publish", "published"],
  ["unpublish", "draft"],
  ["archive", "archived"],
] as const) {
  content
    .command(`${name} <slug>`)
    .description(`Set status to ${status}${status === "published" ? " (runs the audit gate)" : ""}`)
    .option("-c, --collection <name>", "collection", "posts")
    .option("--force", "bypass the audit gate")
    .action(
      run(async (slug: string, opts: { collection: string; force?: boolean }) => {
        const cms = await open();
        const r = await cms.setStatus(opts.collection, slug, status, { force: opts.force });
        out({ ...r, entry: serializeEntry(r.entry, { body: false }) }, () => {
          if (r.blocked) {
            process.stdout.write(`${pc.yellow("✖")} ${r.blocked}\n`);
            process.exitCode = 2;
          } else
            process.stdout.write(
              `${pc.green("✔")} ${r.entry.collection}/${r.entry.slug} is now ${statusColor(r.entry.frontmatter.status)}\n`,
            );
        });
      }),
    );
}

// ---------------------------------------------------------------- metadata & audits

program
  .command("enrich [slug]")
  .description(
    "Generate or refresh metadata for one entry, a collection (--all -c) or everything (--all)",
  )
  .option("-c, --collection <name>", "collection")
  .option("--all", "every entry (in the collection if -c is given)")
  .option("--fields <list>", `comma-separated: ${METADATA_FIELDS.join(",")}`, parseFields)
  .option("--force", "overwrite human-written values")
  .option("--deterministic", "never call a model")
  .action(
    run(
      async (
        slug: string | undefined,
        opts: {
          collection?: string;
          all?: boolean;
          fields?: MetadataField[];
          force?: boolean;
          deterministic?: boolean;
        },
      ) => {
        const cms = await open();
        const o = { fields: opts.fields, force: opts.force, deterministicOnly: opts.deterministic };
        const results = slug
          ? [await cms.enrich(opts.collection ?? "posts", slug, o)]
          : opts.all
            ? await cms.enrichAll({ ...o, collection: opts.collection })
            : [];
        if (!slug && !opts.all) throw new CmsError("VALIDATION", "Pass a slug or --all");
        out(
          results.map((r) => ({ ...r, entry: summarizeEntry(r.entry) })),
          () => {
            for (const r of results) {
              process.stdout.write(
                `${pc.green("✔")} ${r.entry.collection}/${r.entry.slug}: ${r.generated.join(", ") || "nothing"} ${pc.dim(`via ${r.provider}`)}${r.review.length ? pc.yellow(` review: ${r.review.join(", ")}`) : ""}\n`,
              );
              for (const n of r.notes) process.stdout.write(`    ${pc.dim(n)}\n`);
              if (r.delegated)
                process.stdout.write(
                  pc.yellow("    no model available for the AI layer (see agentcms doctor)\n"),
                );
            }
          },
        );
      },
    ),
  );

program
  .command("audit [slug]")
  .description("SEO / AEO / readability / links / freshness audit for one entry or all")
  .option("-c, --collection <name>", "collection")
  .option("-s, --status <status>", "filter by status", parseStatus)
  .option("--pages", "audit every rendered page instead of entries")
  .action(
    run(
      async (
        slug: string | undefined,
        opts: { collection?: string; status?: Status; pages?: boolean },
      ) => {
        const cms = await open();
        if (opts.pages) {
          const results = await cms.auditPages();
          out(results, () => {
            for (const r of results)
              process.stdout.write(
                `${score(r.score).padEnd(13)} ${pc.bold(r.path)} ${pc.dim(r.failed.map((c) => c.id).join(", "))}\n`,
              );
          });
          return;
        }
        if (slug) {
          const a = await cms.audit(opts.collection ?? "posts", slug);
          out(a, () => {
            process.stdout.write(
              `${pc.bold(a.title)}  overall ${score(a.scores.overall)}  seo ${score(a.scores.seo)}  aeo ${score(a.scores.aeo)}  readability ${score(a.scores.readability)}  links ${score(a.scores.links)}  freshness ${score(a.scores.freshness)}\n${a.publishable ? pc.green("publishable") : pc.yellow("not publishable")}\n\n`,
            );
            for (const c of a.failed)
              process.stdout.write(
                `  ${c.severity === "error" ? pc.red("✖") : c.severity === "warning" ? pc.yellow("!") : pc.dim("·")} ${c.message}\n      ${pc.dim(c.fix ?? "")}\n`,
              );
          });
          return;
        }
        const results = await cms.auditAll({ collection: opts.collection, status: opts.status });
        out(results, () => {
          for (const a of results)
            process.stdout.write(
              `${score(a.scores.overall).padEnd(13)} ${pc.bold(`${a.collection}/${a.slug}`)} ${pc.dim(`seo ${a.scores.seo} aeo ${a.scores.aeo} read ${a.scores.readability} links ${a.scores.links}`)} ${a.publishable ? "" : pc.yellow("not publishable")}\n`,
            );
        });
      },
    ),
  );

program
  .command("validate")
  .description("Validate every content file")
  .action(
    run(async () => {
      const cms = await open();
      const issues = await cms.validate();
      out(issues, () => {
        for (const i of issues)
          process.stdout.write(
            `${i.severity === "error" ? pc.red("✖") : pc.yellow("!")} ${i.file}${i.path ? ` [${i.path}]` : ""}: ${i.message}\n`,
          );
        if (!issues.length) process.stdout.write(`${pc.green("✔")} all content valid\n`);
      });
      if (issues.some((i) => i.severity === "error")) process.exitCode = 1;
    }),
  );

program
  .command("search <query>")
  .description("Full-text search")
  .option("-c, --collection <name>")
  .action(
    run(async (query: string, opts: { collection?: string }) => {
      const cms = await open();
      const hits = await cms.search(query, { collection: opts.collection });
      out(hits, () => {
        for (const h of hits)
          process.stdout.write(
            `${String(h.score).padEnd(7)} ${pc.bold(`${h.collection}/${h.slug}`)} ${h.title}\n`,
          );
      });
    }),
  );

// ---------------------------------------------------------------- research

const research = program.command("research").description("Competitor research");

research
  .command("add <url>")
  .description("Track a competitor site (use their blog URL)")
  .option("--name <name>")
  .option("--notes <text>")
  .action(
    run(async (url: string, opts: { name?: string; notes?: string }) => {
      const cms = await open();
      const rec = await cms.addCompetitor(url, opts);
      out(rec, () =>
        process.stdout.write(
          `${pc.green("✔")} tracking ${rec.host}. Run: agentcms research refresh ${rec.host}\n`,
        ),
      );
    }),
  );

research
  .command("list")
  .description("Tracked competitors")
  .action(
    run(async () => {
      const cms = await open();
      const list = await cms.research.list();
      out(
        list.map((c) => ({
          ...c,
          latest: c.latest
            ? { fetchedAt: c.latest.fetchedAt, pages: c.latest.pages.length }
            : undefined,
        })),
        () => {
          for (const c of list)
            process.stdout.write(
              `${pc.bold(c.host)}  ${c.latest ? `${c.latest.pages.length} pages, fetched ${c.latest.fetchedAt.slice(0, 10)}` : pc.dim("not crawled yet")}${c.history.at(-1)?.newPages.length ? pc.cyan(`  ${c.history.at(-1)!.newPages.length} new last time`) : ""}\n`,
            );
          if (!list.length)
            process.stdout.write(
              "No competitors tracked. Add one with: agentcms research add <url>\n",
            );
        },
      );
    }),
  );

research
  .command("refresh [host]")
  .description("Crawl one competitor or all")
  .option("--max-pages <n>")
  .option("--only-stale", "skip recently refreshed competitors")
  .action(
    run(async (host: string | undefined, opts: { maxPages?: string; onlyStale?: boolean }) => {
      const cms = await open();
      const onProgress = (m: string) => {
        if (!globals().json) process.stderr.write(`${pc.dim(m)}\n`);
      };
      const maxPages = opts.maxPages ? Number(opts.maxPages) : undefined;
      if (host) {
        const { record, snapshot } = await cms.refreshCompetitor(host, { maxPages, onProgress });
        out(
          {
            host,
            pages: snapshot.pages.length,
            newPages: record.history.at(-1)?.newPages,
            errors: snapshot.errors,
          },
          () =>
            process.stdout.write(
              `${pc.green("✔")} ${host}: ${snapshot.pages.length} pages (${record.history.at(-1)?.newPages.length ?? 0} new)${snapshot.errors.length ? pc.yellow(` ${snapshot.errors.length} errors`) : ""}\n`,
            ),
        );
        return;
      }
      const results = await cms.refreshAllCompetitors({
        maxPages,
        onlyStale: opts.onlyStale,
        onProgress,
      });
      out(results, () => {
        for (const r of results)
          process.stdout.write(
            `${pc.green("✔")} ${r.host}: ${r.pages} pages (${r.newPages} new)${r.errors.length ? pc.yellow(` ${r.errors.length} errors`) : ""}\n`,
          );
      });
    }),
  );

research
  .command("compare")
  .description("Gap analysis against tracked competitors")
  .action(
    run(async () => {
      const cms = await open();
      const r = await cms.compare();
      out(r, () => {
        process.stdout.write(`${pc.bold(r.summary)}\n\n`);
        process.stdout.write(
          `${"site".padEnd(28)} pages  /month  words  faq   schema  q-headings\n`,
        );
        const row = (
          name: string,
          s: {
            pages: number;
            cadencePerMonth: number;
            avgWordCount: number;
            faqShare: number;
            schemaShare: number;
            questionHeadingShare: number;
          },
        ) =>
          process.stdout.write(
            `${name.padEnd(28)} ${String(s.pages).padEnd(6)} ${String(s.cadencePerMonth).padEnd(7)} ${String(s.avgWordCount).padEnd(6)} ${`${Math.round(s.faqShare * 100)}%`.padEnd(5)} ${`${Math.round(s.schemaShare * 100)}%`.padEnd(7)} ${Math.round(s.questionHeadingShare * 100)}%\n`,
          );
        row(pc.bold("us"), r.ours);
        for (const c of r.competitors) row(c.host, c);
        process.stdout.write(
          `\n${pc.bold("Strengths")}: ${r.strengths.join("; ") || "–"}\n${pc.bold("Weaknesses")}: ${r.weaknesses.join("; ") || "–"}\n\n${pc.bold("Opportunities")}\n`,
        );
        for (const o of r.opportunities)
          process.stdout.write(
            `  ${o.priority === 1 ? pc.red("!") : pc.yellow("•")} ${o.title} ${pc.dim(o.reason)}\n`,
          );
        process.stdout.write(`\n${pc.bold("Topic gaps")}\n`);
        for (const g of r.gaps.slice(0, 15))
          process.stdout.write(
            `  • ${g.topic} ${pc.dim(`(${g.competitorPages.length} competitor pages)`)}\n`,
          );
      });
    }),
  );

research
  .command("remove <host>")
  .description("Stop tracking a competitor")
  .action(
    run(async (host: string) => {
      const cms = await open();
      await cms.removeCompetitor(host);
      process.stdout.write(`${pc.green("✔")} removed ${host}\n`);
    }),
  );

// ---------------------------------------------------------------- templates / theme / preview

const templates = program
  .command("templates")
  .description("Manage the site's templates (Liquid) and theme assets");

templates
  .command("list")
  .description("List templates, where they live and which routes use them")
  .action(
    run(async () => {
      const cms = await open();
      const list = await cms.templates.list(await cms.siteModel(undefined, true));
      out(list, () => {
        for (const t of list)
          process.stdout.write(
            `${(t.origin === "project" ? pc.green("project") : pc.dim("default")).padEnd(18)} ${pc.bold(t.path)} ${pc.dim(t.routes.length ? `${t.routes.length} route(s)` : "")}${t.overridesDefault ? pc.yellow("  (overrides default)") : ""}\n`,
          );
      });
    }),
  );

templates
  .command("get <path>")
  .description("Print a template's source (use --vars for the variables it receives)")
  .option("--vars", "print the variable reference and sample context instead of the source")
  .action(
    run(async (rel: string, opts: { vars?: boolean }) => {
      const cms = await open();
      const d = await cms.templates.get(
        rel,
        opts.vars ? await cms.siteModel(undefined, true) : undefined,
      );
      out(d, () => {
        if (opts.vars)
          process.stdout.write(
            `${d.variables.join("\n")}\n\n${JSON.stringify(d.sampleContext, null, 2)}\n`,
          );
        else process.stdout.write(d.source);
      });
    }),
  );

templates
  .command("validate [path]")
  .description("Validate one project template or all of them")
  .action(
    run(async (rel: string | undefined) => {
      const cms = await open();
      const model = await cms.siteModel(undefined, true);
      const targets = rel
        ? [rel]
        : (await cms.templates.list())
            .filter((t) => t.origin === "project" && t.kind !== "asset")
            .map((t) => t.path);
      let failed = 0;
      for (const t of targets) {
        const d = await cms.templates.get(t);
        const v = await cms.templates.validate(t, d.source, model);
        if (!v.ok) failed++;
        process.stdout.write(
          `${v.ok ? pc.green("✔") : pc.red("✖")} ${t}${v.errors.map((e) => `\n    ${pc.red(e)}`).join("")}${v.warnings.map((w) => `\n    ${pc.yellow(w)}`).join("")}\n`,
        );
      }
      if (failed) process.exitCode = 1;
    }),
  );

templates
  .command("reset <path>")
  .description("Restore a template to the bundled default")
  .action(
    run(async (rel: string) => {
      const cms = await open();
      const r = await cms.templates.reset(rel);
      process.stdout.write(`${pc.green("✔")} reset ${r.path}\n${r.diff}\n`);
    }),
  );

templates
  .command("eject")
  .description("Copy every bundled theme file into templates/ (existing files are kept)")
  .action(
    run(async () => {
      const cms = await open();
      const written = await cms.templates.eject();
      process.stdout.write(
        written.length
          ? `${written.map((w) => `+ ${w}`).join("\n")}\n`
          : "Nothing to copy; all theme files already exist.\n",
      );
    }),
  );

const theme = program.command("theme").description("Design tokens in theme.json");
theme
  .command("get")
  .description("Print the resolved theme tokens")
  .action(
    run(async () => {
      const cms = await open();
      process.stdout.write(`${JSON.stringify(await cms.theme.resolve(), null, 2)}\n`);
    }),
  );
theme
  .command("set <key=value...>")
  .description("Set tokens, e.g. colors.accent=#ff0066 features.toc=false")
  .action(
    run(async (values: string[]) => {
      const cms = await open();
      const t = await cms.theme.update(parseSet(values));
      process.stdout.write(`${pc.green("✔")} theme updated (accent ${t.colors.accent})\n`);
    }),
  );
theme
  .command("reset")
  .description("Restore the default theme.json")
  .action(
    run(async () => {
      const cms = await open();
      await cms.theme.reset();
      process.stdout.write(`${pc.green("✔")} theme reset\n`);
    }),
  );

program
  .command("routes")
  .description("List every page the site renders")
  .option("--drafts", "include drafts")
  .action(
    run(async (opts: { drafts?: boolean }) => {
      const cms = await open();
      const routes = await cms.routes({ includeDrafts: opts.drafts });
      out(routes, () => {
        for (const r of routes)
          process.stdout.write(
            `${r.kind.padEnd(11)} ${pc.bold(r.path.padEnd(48))} ${pc.dim(r.template)}\n`,
          );
      });
    }),
  );

program
  .command("preview <target>")
  .description("Render one page: a route path (/, /blog/, /tags/x/) or a slug with -c")
  .option("-c, --collection <name>", "treat <target> as a slug in this collection")
  .option("-o, --out <file>", "write the self-contained HTML to a file")
  .option("--screenshot <file.png>", "write a screenshot (needs playwright-core and Chromium)")
  .option("--mobile", "mobile viewport for the screenshot")
  .action(
    run(
      async (
        target: string,
        opts: { collection?: string; out?: string; screenshot?: string; mobile?: boolean },
      ) => {
        const cms = await open();
        const viewport = opts.mobile ? "mobile" : "desktop";
        const p = await cms.preview(
          opts.collection ? { collection: opts.collection, slug: target } : { path: target },
          { screenshots: opts.screenshot ? [viewport] : [] },
        );
        if (opts.out) await writeText(opts.out, p.html);
        const shot = p.screenshots[0]?.result;
        if (opts.screenshot && shot) {
          if (shot.ok) await writeFile(opts.screenshot, shot.png);
          else
            process.stderr.write(
              `${pc.yellow("!")} screenshot unavailable: ${shot.reason}\n  ${shot.hint}\n`,
            );
        }
        out({ route: p.route, audit: p.audit, html: opts.out ? undefined : p.html }, () => {
          process.stdout.write(
            `${pc.bold(p.route.path)} ${pc.dim(p.route.template)}  page score ${score(p.audit.score)}\n`,
          );
          for (const c of p.audit.failed)
            process.stdout.write(
              `  ${c.severity === "error" ? pc.red("✖") : c.severity === "warning" ? pc.yellow("!") : pc.dim("·")} ${c.message}\n`,
            );
          if (opts.out) process.stdout.write(`${pc.green("✔")} wrote ${opts.out}\n`);
          else if (!opts.screenshot)
            process.stdout.write(
              pc.dim("(pass -o file.html to save the page, --screenshot file.png for an image)\n"),
            );
          if (opts.screenshot && shot?.ok)
            process.stdout.write(`${pc.green("✔")} wrote ${opts.screenshot}\n`);
        });
      },
    ),
  );

// ---------------------------------------------------------------- build / doctor / guide

program
  .command("build")
  .description("Write static output (JSON API, feeds, sitemap, llms.txt, search index)")
  .option("-o, --out <dir>", "output directory (relative to project root)")
  .option("--drafts", "include drafts")
  .action(
    run(async (opts: { out?: string; drafts?: boolean }) => {
      const cms = await open();
      const m = await cms.build({ outDir: opts.out, includeDrafts: opts.drafts });
      out(m, () => {
        process.stdout.write(
          `${pc.green("✔")} built ${m.entries} entries → ${m.outDir} (${m.files.length} files)\n`,
        );
        for (const w of m.warnings) process.stdout.write(`  ${pc.yellow("!")} ${w}\n`);
      });
    }),
  );

program
  .command("doctor")
  .description("Check the project, the content and the AI provider")
  .action(
    run(async () => {
      const cms = await open();
      const issues = await cms.validate();
      const entries = await cms.store.all();
      const competitors = await cms.research.list();
      const ai =
        cms.ai.mode === "provider"
          ? `${cms.ai.provider.name} (${cms.ai.provider.model})`
          : `${cms.ai.mode} – ${cms.ai.reason}`;
      const report = {
        root: cms.root,
        node: process.version,
        config: CONFIG_FILENAME,
        collections: cms.config.collections.map((c) => c.name),
        entries: entries.length,
        validationErrors: issues.filter((i) => i.severity === "error").length,
        ai,
        competitors: competitors.length,
        outDir: cms.config.build.outDir,
      };
      out(report, () => {
        process.stdout.write(
          `${pc.green("✔")} project: ${cms.root}\n${pc.green("✔")} node ${process.version}\n${pc.green("✔")} collections: ${report.collections.join(", ")} (${entries.length} entries)\n${report.validationErrors ? pc.red(`✖ ${report.validationErrors} validation errors (run agentcms validate)`) : pc.green("✔ content valid")}\n${cms.ai.mode === "provider" ? pc.green(`✔ AI: ${ai}`) : pc.yellow(`! AI: ${ai}`)}\n${competitors.length ? pc.green(`✔ ${competitors.length} competitor(s) tracked`) : pc.yellow("! no competitors tracked (agentcms research add <url>)")}\n`,
        );
        if (cms.ai.mode !== "provider")
          process.stdout.write(
            pc.dim(
              "  Set ANTHROPIC_API_KEY (or run `ant auth login`) for model-written metadata, or connect through an MCP client that supports sampling. Without either, agents generate metadata themselves via submit_metadata.\n",
            ),
          );
      });
    }),
  );

program
  .command("guide")
  .description("Print the agent guide (also served as the agentcms://guide MCP resource)")
  .action(async () => {
    process.stdout.write(AGENT_GUIDE);
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${pc.red("error")}: ${(err as Error).message}\n`);
  process.exit(1);
});
