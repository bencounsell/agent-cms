import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { countWords, isQuestion, normalizeWhitespace, slugify } from "../util/text.ts";

// Minimal structural typing for mdast / hast nodes so we avoid extra type packages.
export interface MdNode {
  type: string;
  depth?: number;
  url?: string;
  alt?: string | null;
  title?: string | null;
  value?: string;
  lang?: string | null;
  ordered?: boolean;
  children?: MdNode[];
  position?: { start: { line: number; column: number; offset?: number } };
}

export interface Heading {
  depth: number;
  text: string;
  id: string;
  line?: number;
  isQuestion: boolean;
}

export interface LinkRef {
  url: string;
  text: string;
  /** true when the link points at the same site (relative or matching site URL). */
  internal: boolean;
}

export interface ImageRef {
  url: string;
  alt: string;
}

export interface MarkdownAnalysis {
  /** Plain text with markdown stripped. */
  text: string;
  headings: Heading[];
  links: LinkRef[];
  images: ImageRef[];
  paragraphs: string[];
  firstParagraph: string;
  wordCount: number;
  codeBlocks: number;
  lists: number;
  tables: number;
  blockquotes: number;
  sections: Section[];
  hasFaqSection: boolean;
  hasTakeawaysSection: boolean;
  hasConclusion: boolean;
}

export interface Section {
  heading?: Heading;
  text: string;
  wordCount: number;
}

const FAQ_RE =
  /\b(faq|faqs|frequently asked questions|common questions|questions and answers|q&a)\b/i;
const TAKEAWAYS_RE =
  /\b(key takeaways|takeaways|tl;?dr|summary|in short|at a glance|quick answer)\b/i;
const CONCLUSION_RE = /\b(conclusion|wrapping up|final thoughts|next steps|summary)\b/i;

const parser = unified().use(remarkParse).use(remarkGfm);

export function parseMarkdown(body: string): MdNode {
  return parser.parse(body) as unknown as MdNode;
}

export function nodeText(node: MdNode): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value ?? "";
  if (node.type === "code" || node.type === "html" || node.type === "yaml") return "";
  if (node.type === "image") return node.alt ?? "";
  if (node.type === "break") return " ";
  if (!node.children) return "";
  const sep = node.type === "paragraph" || node.type === "heading" ? "" : " ";
  return node.children.map(nodeText).join(sep);
}

export function walk(
  node: MdNode,
  visit: (n: MdNode, parents: MdNode[]) => void,
  parents: MdNode[] = [],
): void {
  visit(node, parents);
  if (node.children) for (const c of node.children) walk(c, visit, [...parents, node]);
}

export function isInternalLink(url: string, siteUrl?: string): boolean {
  if (!url) return false;
  if (url.startsWith("#")) return false;
  if (url.startsWith("/") || url.startsWith("./") || url.startsWith("../")) return true;
  if (!/^[a-z]+:/i.test(url)) return true;
  if (siteUrl) {
    try {
      return new URL(url).host === new URL(siteUrl).host;
    } catch {
      return false;
    }
  }
  return false;
}

export function analyzeMarkdown(body: string, opts: { siteUrl?: string } = {}): MarkdownAnalysis {
  const tree = parseMarkdown(body);
  const headings: Heading[] = [];
  const links: LinkRef[] = [];
  const images: ImageRef[] = [];
  const paragraphs: string[] = [];
  const sections: Section[] = [];
  let codeBlocks = 0;
  let lists = 0;
  let tables = 0;
  let blockquotes = 0;
  const usedIds = new Map<string, number>();
  let current: Section = { text: "", wordCount: 0 };

  const pushSection = () => {
    current.text = normalizeWhitespace(current.text);
    current.wordCount = countWords(current.text);
    if (current.heading || current.text) sections.push(current);
  };

  for (const node of tree.children ?? []) {
    if (node.type === "heading") {
      pushSection();
      const text = normalizeWhitespace(nodeText(node));
      let id = slugify(text) || "section";
      const n = usedIds.get(id) ?? 0;
      usedIds.set(id, n + 1);
      if (n > 0) id = `${id}-${n}`;
      const heading: Heading = {
        depth: node.depth ?? 1,
        text,
        id,
        line: node.position?.start.line,
        isQuestion: isQuestion(text),
      };
      headings.push(heading);
      current = { heading, text: "", wordCount: 0 };
      continue;
    }
    if (node.type === "paragraph") {
      const t = normalizeWhitespace(nodeText(node));
      if (t) paragraphs.push(t);
    }
    if (node.type === "code") codeBlocks++;
    if (node.type === "list") lists++;
    if (node.type === "table") tables++;
    if (node.type === "blockquote") blockquotes++;
    current.text += ` ${nodeText(node)}`;
  }
  pushSection();

  walk(tree, (n) => {
    if (n.type === "link" && n.url) {
      links.push({
        url: n.url,
        text: normalizeWhitespace(nodeText(n)),
        internal: isInternalLink(n.url, opts.siteUrl),
      });
    }
    if (n.type === "image" && n.url) images.push({ url: n.url, alt: (n.alt ?? "").trim() });
  });

  const text = normalizeWhitespace(sections.map((s) => s.text).join(" "));
  const headingTexts = headings.map((h) => h.text);
  return {
    text,
    headings,
    links,
    images,
    paragraphs,
    firstParagraph: paragraphs[0] ?? "",
    wordCount: countWords(text),
    codeBlocks,
    lists,
    tables,
    blockquotes,
    sections,
    hasFaqSection: headingTexts.some((h) => FAQ_RE.test(h)),
    hasTakeawaysSection: headingTexts.some((h) => TAKEAWAYS_RE.test(h)),
    hasConclusion: headingTexts.some((h) => CONCLUSION_RE.test(h)),
  };
}

const renderer = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeHeadingIds)
  .use(rehypeStringify);

/** Adds stable `id` attributes to headings so TOC anchors and speakable selectors work. */
function rehypeHeadingIds() {
  return (tree: MdNode) => {
    const used = new Map<string, number>();
    walk(tree, (n) => {
      if (n.type === "element" && /^h[1-6]$/.test((n as { tagName?: string }).tagName ?? "")) {
        const el = n as MdNode & { properties?: Record<string, unknown> };
        const text = normalizeWhitespace(hastText(n));
        let id = slugify(text) || "section";
        const c = used.get(id) ?? 0;
        used.set(id, c + 1);
        if (c > 0) id = `${id}-${c}`;
        el.properties = { ...(el.properties ?? {}), id };
      }
    });
  };
}

function hastText(n: MdNode): string {
  if (n.type === "text") return n.value ?? "";
  return (n.children ?? []).map(hastText).join("");
}

export async function renderHtml(body: string): Promise<string> {
  const file = await renderer.process(body);
  return String(file);
}

export interface TocItem {
  depth: number;
  text: string;
  id: string;
}

export function tableOfContents(headings: Heading[], maxDepth = 3): TocItem[] {
  return headings
    .filter((h) => h.depth <= maxDepth)
    .map(({ depth, text, id }) => ({ depth, text, id }));
}
