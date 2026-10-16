import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Cms } from "../core/cms.ts";

const text = (t: string) => ({
  messages: [{ role: "user" as const, content: { type: "text" as const, text: t } }],
});

export function registerPrompts(server: McpServer, cms: Cms): void {
  const postCollection = () =>
    cms.config.collections.find((c) => c.kind === "post")?.name ?? cms.config.collections[0]!.name;

  server.registerPrompt(
    "write_post",
    {
      title: "Write a post",
      description: "Research, draft and audit a new post on a topic, ready for the user's review.",
      argsSchema: {
        topic: z.string().describe("Working title or topic"),
        audience: z.string().optional().describe("Who it is for"),
        keywords: z.string().optional().describe("Comma-separated target phrases"),
        collection: z.string().optional(),
      },
    },
    ({ topic, audience, keywords, collection }) =>
      text(`Write a new entry in the "${collection ?? postCollection()}" collection about: ${topic}.
${audience ? `Audience: ${audience}.` : ""}${keywords ? ` Target keywords: ${keywords}.` : ""}

Steps:
1. get_config for the site description, tone and taxonomy; search_content "${topic}" to avoid duplicating existing entries and to find entries to link to.
2. compare_competitors (if research exists) to see how competitors cover this and which questions they answer.
3. Draft Markdown that is answer-engine ready: 40-70 word direct answer first, H2 headings phrased as questions, a "Key takeaways" list, an FAQ with 3-5 real questions, internal links by path to at least two related entries, at least one cited external source, no H1 in the body, around ${cms.config.seo.targetWordCount} words of genuinely useful content. Do not invent facts.
4. create_content. Read the audit and nextActions; fix what is flagged with update_content until publishable.
5. Summarise for the user: title, slug, audit scores, fields flagged for review. Do NOT publish; ask whether they want to.`),
  );

  server.registerPrompt(
    "improve_post",
    {
      title: "Improve an entry",
      description: "Apply the improvement plan to an existing entry.",
      argsSchema: { collection: z.string(), slug: z.string() },
    },
    ({ collection, slug }) =>
      text(`Improve the entry ${collection}/${slug}.
1. get_content and improve_content.
2. Apply the plan with update_content: fix the audit findings, add the suggested internal links naturally in the body, add or extend the FAQ with the candidate questions you can answer from the content, strengthen the answer-first opening, expand thin sections where you have real substance.
3. Keep the author's voice. Do not invent facts.
4. audit_content again and report before/after scores and what changed. Ask before changing status.`),
  );

  server.registerPrompt(
    "seo_audit",
    {
      title: "SEO audit",
      description: "Audit one entry or the whole site and report what to fix first.",
      argsSchema: { collection: z.string().optional(), slug: z.string().optional() },
    },
    ({ collection, slug }) =>
      text(
        slug
          ? `Run audit_content for ${collection}/${slug} and explain each failed check in plain language with the exact change you propose. Offer to apply the fixes.`
          : `Run audit_content${collection ? ` for collection ${collection}` : ""}. Rank entries by overall score, group the most common failed checks, and propose a prioritised fix list. Offer to fix the top three entries.`,
      ),
  );

  server.registerPrompt(
    "aeo_optimize",
    {
      title: "Optimise for answer engines",
      description:
        "Make an entry quotable by AI answer engines: direct answer, FAQ, takeaways, structured data.",
      argsSchema: { collection: z.string(), slug: z.string() },
    },
    ({ collection, slug }) =>
      text(`Optimise ${collection}/${slug} for answer engines (ChatGPT, Perplexity, Google AI Overviews, Claude).
1. get_content and improve_content; note the AEO checks and the question/FAQ candidates.
2. Rewrite the opening as a 40-70 word self-contained answer to the main question and set aeo.answer to it.
3. Turn section headings into the questions people ask where natural; answer each in its first sentence.
4. Add a "Key takeaways" list (3-5 bullets) and an FAQ section with 3-5 questions answered from the content; set aeo.keyTakeaways, aeo.faq and aeo.questions.
5. Define the focus keyword explicitly early on, cite sources, keep paragraphs short.
6. update_content, audit_content, and report the AEO score before and after.`),
  );

  server.registerPrompt(
    "competitor_brief",
    {
      title: "Competitor brief",
      description:
        "Refresh research if needed and summarise what competitors are doing well and where the gaps are.",
      argsSchema: {},
    },
    () =>
      text(`Produce a competitor brief.
1. list_competitors. If none are tracked, ask the user for 2-3 competitor blog URLs and add_competitor them.
2. research_competitors (onlyStale: true) then compare_competitors.
3. Report: what each competitor does well (cadence, depth, structure, topics), what they published recently, the top topic gaps with evidence, and five concrete content opportunities ranked by impact. Offer to draft the first one.`),
  );

  server.registerPrompt(
    "content_calendar",
    {
      title: "Content calendar",
      description: "Plan the next weeks of content from suggestions, gaps and refresh needs.",
      argsSchema: {
        weeks: z.string().optional().describe("Number of weeks to plan, default 4"),
        perWeek: z.string().optional().describe("Pieces per week, default 1"),
      },
    },
    ({ weeks, perWeek }) =>
      text(`Plan a content calendar for the next ${weeks ?? "4"} weeks at ${perWeek ?? "1"} piece(s) per week.
1. get_briefing, suggest_content (limit 30) and compare_competitors if research exists.
2. Mix new topics (gaps, questions competitors answer), refreshes of stale high-value entries, and series that strengthen thin clusters.
3. For each slot give: working title, type (new/refresh/expand), target keywords, the evidence, effort, and the first H2 outline.
4. Present it as a table and ask which items to start drafting.`),
  );
}
