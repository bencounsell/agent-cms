import * as cheerio from "cheerio";
import type { AuditCheck, AuditResult } from "./audit.ts";

export interface PageAuditInput {
  html: string;
  path: string;
  url: string;
  expected?: { title?: string; description?: string; canonical?: string; noindex?: boolean };
  /** Paths the build produces, used to verify internal links. */
  knownPaths?: Set<string>;
  assetPrefixes?: string[];
}

export interface PageAuditResult {
  path: string;
  url: string;
  score: number;
  checks: AuditCheck[];
  failed: AuditCheck[];
  summary: string;
}

function normalize(p: string): string {
  let out = p.split("#")[0]!.split("?")[0]!;
  if (out.endsWith("/index.html")) out = out.slice(0, -"index.html".length);
  if (!out.endsWith("/") && !/\.[a-z0-9]+$/i.test(out)) out = `${out}/`;
  return out || "/";
}

/** Checks the rendered HTML of one page: the things only the final document can prove. */
export function auditPage(input: PageAuditInput): PageAuditResult {
  const $ = cheerio.load(input.html);
  const checks: AuditCheck[] = [];
  const add = (c: Omit<AuditCheck, "area">) => checks.push({ ...c, area: "page" });
  const text = (sel: string) => $(sel).first().text().trim();
  const attr = (sel: string, a: string) => $(sel).first().attr(a)?.trim();

  const title = text("title");
  add({
    id: "page.title",
    severity: "error",
    weight: 8,
    passed: title.length > 0 && (!input.expected?.title || title.includes(input.expected.title)),
    message: title ? `<title> is "${title}".` : "No <title>.",
    fix: "The head block sets the title from the entry; make sure the layout places {{ head | raw }} inside <head>.",
  });
  const desc = attr("meta[name='description']", "content");
  add({
    id: "page.description",
    severity: "warning",
    weight: 6,
    passed: Boolean(desc) && (!input.expected?.description || desc === input.expected.description),
    message: desc ? "Meta description present." : "No meta description.",
    fix: "Set `description` on the entry; the head block emits it.",
  });
  const canonical = attr("link[rel='canonical']", "href");
  add({
    id: "page.canonical",
    severity: "warning",
    weight: 4,
    passed:
      Boolean(canonical) && (!input.expected?.canonical || canonical === input.expected.canonical),
    message: canonical ? `Canonical ${canonical}.` : "No canonical link.",
    fix: "Keep {{ head | raw }} in the layout.",
  });
  const robots = attr("meta[name='robots']", "content") ?? "";
  add({
    id: "page.robots",
    severity: "info",
    weight: 2,
    passed: Boolean(input.expected?.noindex) === /noindex/.test(robots),
    message: /noindex/.test(robots) ? "Page is noindex." : "Page is indexable.",
    fix: "noindex follows seo.noindex on the entry.",
  });
  const og = ["og:title", "og:type", "og:url"].filter(
    (p) => !$(`meta[property='${p}']`).attr("content"),
  );
  add({
    id: "page.opengraph",
    severity: "warning",
    weight: 5,
    passed: og.length === 0,
    message: og.length ? `Missing Open Graph: ${og.join(", ")}.` : "Open Graph tags present.",
    fix: "The head block emits them; restore {{ head | raw }}.",
  });
  add({
    id: "page.twitter-card",
    severity: "info",
    weight: 2,
    passed: Boolean($("meta[name='twitter:card']").attr("content")),
    message: $("meta[name='twitter:card']").attr("content")
      ? "Twitter card present."
      : "No Twitter card.",
    fix: "Restore {{ head | raw }}.",
  });
  let jsonldOk = false;
  let jsonldCount = 0;
  $("script[type='application/ld+json']").each((_, el) => {
    jsonldCount++;
    try {
      JSON.parse($(el).text());
      jsonldOk = true;
    } catch {
      jsonldOk = false;
    }
  });
  add({
    id: "page.jsonld",
    severity: "warning",
    weight: 5,
    passed: jsonldCount > 0 && jsonldOk,
    message:
      jsonldCount === 0
        ? "No JSON-LD structured data."
        : jsonldOk
          ? "JSON-LD parses."
          : "JSON-LD is malformed.",
    fix: "Structured data comes from the head block; do not hand-edit it in templates.",
  });
  const h1 = $("h1").length;
  add({
    id: "page.h1",
    severity: "warning",
    weight: 5,
    passed: h1 === 1,
    message: `${h1} <h1> element(s).`,
    fix: "Render exactly one H1 per page (the title) and keep body headings at H2+.",
  });
  add({
    id: "page.lang",
    severity: "info",
    weight: 2,
    passed: Boolean($("html").attr("lang")),
    message: $("html").attr("lang")
      ? `lang="${$("html").attr("lang")}".`
      : "No lang attribute on <html>.",
    fix: 'Add lang="{{ page.language | default: site.language }}" to <html>.',
  });
  add({
    id: "page.viewport",
    severity: "warning",
    weight: 3,
    passed: Boolean($("meta[name='viewport']").attr("content")),
    message: $("meta[name='viewport']").attr("content")
      ? "Viewport meta present."
      : "No viewport meta.",
    fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the layout.',
  });
  const imgs = $("img");
  const noAlt = imgs.filter((_, el) => $(el).attr("alt") === undefined).length;
  add({
    id: "page.img-alt",
    severity: "warning",
    weight: 3,
    passed: noAlt === 0,
    message: imgs.length
      ? `${noAlt} of ${imgs.length} images lack an alt attribute.`
      : "No images.",
    fix: "Every <img> needs an alt attribute (empty for decorative images).",
  });
  const landmarks = ["header", "main", "nav", "footer"].filter((t) => $(t).length === 0);
  add({
    id: "page.landmarks",
    severity: "info",
    weight: 3,
    passed: landmarks.length === 0,
    message: landmarks.length
      ? `Missing landmarks: ${landmarks.join(", ")}.`
      : "Header, nav, main and footer landmarks present.",
    fix: "Use semantic header/nav/main/footer elements in the layout.",
  });
  add({
    id: "page.skip-link",
    severity: "info",
    weight: 1,
    passed: $("a[href^='#']").first().text().toLowerCase().includes("skip"),
    message: $("a[href^='#']").first().text().toLowerCase().includes("skip")
      ? "Skip link present."
      : "No skip link.",
    fix: 'Add <a class="skip-link" href="#main">Skip to content</a> as the first element in <body>.',
  });
  if (input.knownPaths) {
    const prefixes = input.assetPrefixes ?? ["/assets/", "/cms/", "/feeds/"];
    const broken: string[] = [];
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") ?? "";
      if (!href.startsWith("/") || href.startsWith("//")) return;
      if (
        prefixes.some((p) => href.startsWith(p)) ||
        /\.(xml|txt|json|css|js|png|jpe?g|svg|webp|ico|pdf)$/i.test(href)
      )
        return;
      const n = normalize(href);
      if (!input.knownPaths!.has(n)) broken.push(href);
    });
    add({
      id: "page.links",
      severity: "error",
      weight: 6,
      passed: broken.length === 0,
      message: broken.length
        ? `${broken.length} internal link(s) point at pages that are not built: ${broken.slice(0, 5).join(", ")}.`
        : "All internal links resolve.",
      fix: "Fix the links or publish the target entries.",
      evidence: broken,
    });
  }
  const bytes = Buffer.byteLength(input.html);
  add({
    id: "page.weight",
    severity: "info",
    weight: 2,
    passed: bytes < 300_000,
    message: `HTML is ${Math.round(bytes / 1024)} KB.`,
    fix: "Keep pages under ~300 KB of HTML; move large content into linked resources.",
  });

  const total = checks.reduce((n, c) => n + c.weight, 0);
  const got = checks.filter((c) => c.passed).reduce((n, c) => n + c.weight, 0);
  const score = total ? Math.round((got / total) * 100) : 100;
  const failed = checks
    .filter((c) => !c.passed)
    .sort(
      (a, b) =>
        ({ error: 0, warning: 1, info: 2 })[a.severity] -
        { error: 0, warning: 1, info: 2 }[b.severity],
    );
  return {
    path: input.path,
    url: input.url,
    score,
    checks,
    failed,
    summary: `${input.path}: page score ${score}.${failed.length ? ` ${failed[0]!.message}` : ""}`,
  };
}

/** Merge rendered-page checks into an entry audit, recomputing the overall score and publishability. */
export function withPageChecks(audit: AuditResult, page: PageAuditResult): AuditResult {
  const checks = [...audit.checks.filter((c) => c.area !== "page"), ...page.checks];
  const total = checks.reduce((n, c) => n + c.weight, 0);
  const got = checks.filter((c) => c.passed).reduce((n, c) => n + c.weight, 0);
  const overall = total ? Math.round((got / total) * 100) : 100;
  const rank = { error: 0, warning: 1, info: 2 } as const;
  const failed = checks
    .filter((c) => !c.passed)
    .sort((a, b) => rank[a.severity] - rank[b.severity] || b.weight - a.weight);
  const publishable = audit.publishable && !page.failed.some((c) => c.severity === "error");
  return {
    ...audit,
    checks,
    failed,
    scores: { ...audit.scores, page: page.score, overall },
    publishable,
    summary: `${audit.summary} Page ${page.score}.`,
  };
}
