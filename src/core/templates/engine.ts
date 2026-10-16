import { Liquid } from "liquidjs";
import { renderHtml } from "../markdown/analyze.ts";
import { slugify, truncateAtWord } from "../util/text.ts";

export interface EngineOptions {
  /** Lookup roots in priority order: the project's templates dir, then the bundled theme. */
  roots: string[];
  siteUrl: string;
  strictVariables?: boolean;
}

/**
 * LiquidJS configured for agent-authored templates: every output is HTML-escaped unless piped
 * through `raw`, filters must exist, and files resolve from the project first, then the theme.
 */
export function createEngine(opts: EngineOptions): Liquid {
  const engine = new Liquid({
    root: opts.roots,
    layouts: opts.roots,
    partials: opts.roots,
    extname: ".liquid",
    cache: false,
    outputEscape: "escape",
    jsTruthy: true,
    strictFilters: true,
    strictVariables: opts.strictVariables ?? false,
    relativeReference: false,
    ownPropertyOnly: false,
  });
  const base = opts.siteUrl.replace(/\/+$/, "");
  engine.registerFilter("absolute_url", (v: unknown) => {
    const s = String(v ?? "");
    if (!s) return base;
    if (/^[a-z]+:/i.test(s)) return s;
    return `${base}${s.startsWith("/") ? "" : "/"}${s}`;
  });
  engine.registerFilter("json", (v: unknown) => JSON.stringify(v));
  engine.registerFilter("excerpt", (v: unknown, n = 160) =>
    truncateAtWord(String(v ?? "").replace(/<[^>]+>/g, ""), Number(n)),
  );
  engine.registerFilter("slugify", (v: unknown) => slugify(String(v ?? "")));
  engine.registerFilter("markdown", async (v: unknown) => renderHtml(String(v ?? "")));
  return engine;
}
