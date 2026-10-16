import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CmsConfig, CollectionConfig } from "../config/schema.ts";
import { nowIso } from "../util/dates.ts";
import { CmsError } from "../util/errors.ts";
import { exists, listFiles, readText, remove, writeText } from "../util/fs.ts";
import { slugify } from "../util/text.ts";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter.ts";
import {
  type Entry,
  type EntryFrontmatter,
  EntryFrontmatterSchema,
  type EntryInput,
  type Status,
} from "./schema.ts";
import { absoluteUrl, entryPath } from "./url.ts";

export interface ListOptions {
  status?: Status | Status[];
  tag?: string;
  category?: string;
  author?: string;
  /** Case-insensitive substring match on title. */
  query?: string;
  limit?: number;
  offset?: number;
  sort?: "publishedAt" | "updatedAt" | "title" | "slug";
  order?: "asc" | "desc";
}

export interface ValidationIssue {
  collection: string;
  file: string;
  slug?: string;
  severity: "error" | "warning";
  message: string;
  path?: string;
}

/**
 * File-backed content repository. One Markdown file per entry, YAML frontmatter for metadata.
 * The store never caches across calls beyond a single list() to keep behaviour predictable
 * when files change underneath it (agents and humans edit the same files).
 */
export class ContentStore {
  readonly root: string;
  private config: CmsConfig;

  constructor(root: string, config: CmsConfig) {
    this.root = root;
    this.config = config;
  }

  setConfig(config: CmsConfig): void {
    this.config = config;
  }

  collection(name: string): CollectionConfig {
    const c = this.config.collections.find((c) => c.name === name);
    if (!c) {
      const names = this.config.collections.map((c) => c.name).join(", ");
      throw new CmsError("NOT_FOUND", `Unknown collection "${name}". Available: ${names}`);
    }
    return c;
  }

  collections(): CollectionConfig[] {
    return this.config.collections;
  }

  collectionDir(name: string): string {
    return path.join(this.root, this.collection(name).path);
  }

  async list(collectionName: string, opts: ListOptions = {}): Promise<Entry[]> {
    const collection = this.collection(collectionName);
    const files = await listFiles(path.join(this.root, collection.path), [".md", ".mdx"]);
    const entries: Entry[] = [];
    for (const file of files) {
      try {
        entries.push(await this.readFile(collection, file));
      } catch {
        // Invalid files are reported by validate(); listing stays resilient.
      }
    }
    return applyListOptions(entries, opts);
  }

  async all(opts: ListOptions = {}): Promise<Entry[]> {
    const out: Entry[] = [];
    for (const c of this.config.collections) out.push(...(await this.list(c.name, opts)));
    return out;
  }

  async get(collectionName: string, slug: string): Promise<Entry> {
    const entry = await this.find(collectionName, slug);
    if (!entry) {
      throw new CmsError("NOT_FOUND", `No entry "${slug}" in collection "${collectionName}"`);
    }
    return entry;
  }

  async find(collectionName: string, slug: string): Promise<Entry | undefined> {
    const collection = this.collection(collectionName);
    const direct = path.join(this.root, collection.path, `${slug}.md`);
    if (await exists(direct)) {
      const e = await this.readFile(collection, direct);
      if (e.slug === slug) return e;
    }
    const entries = await this.list(collectionName);
    return entries.find((e) => e.slug === slug || e.frontmatter.id === slug);
  }

  async create(collectionName: string, input: EntryInput & { title: string }): Promise<Entry> {
    const collection = this.collection(collectionName);
    const slug = slugify(input.slug ?? input.title);
    if (!slug) throw new CmsError("VALIDATION", "Could not derive a slug from the title");
    if (await this.find(collectionName, slug)) {
      throw new CmsError(
        "CONFLICT",
        `An entry with slug "${slug}" already exists in "${collectionName}". Pass a different slug or update the existing entry.`,
      );
    }
    const now = nowIso();
    const { body = "", ...fields } = input;
    const fm = EntryFrontmatterSchema.parse({
      ...fields,
      id: randomUUID(),
      title: input.title,
      slug,
      status: input.status ?? "draft",
      createdAt: now,
      updatedAt: now,
      publishedAt: input.publishedAt ?? (input.status === "published" ? now : undefined),
      author: input.author ?? this.config.site.defaultAuthor,
      language: input.language ?? this.config.site.language,
    });
    const file = path.join(this.root, collection.path, this.fileName(collection, fm));
    await writeText(file, stringifyFrontmatter(fm, body));
    return this.readFile(collection, file);
  }

  async update(
    collectionName: string,
    slug: string,
    patch: EntryInput,
    opts: { touch?: boolean } = {},
  ): Promise<Entry> {
    const collection = this.collection(collectionName);
    const existing = await this.get(collectionName, slug);
    const { body, ...fields } = patch;
    const nextFm = EntryFrontmatterSchema.parse({
      ...existing.frontmatter,
      ...stripUndefined(fields),
      id: existing.frontmatter.id,
      slug: fields.slug ? slugify(fields.slug) : existing.slug,
      updatedAt: opts.touch === false ? existing.frontmatter.updatedAt : nowIso(),
    });
    if (nextFm.status === "published" && !nextFm.publishedAt) nextFm.publishedAt = nowIso();
    const nextBody = body ?? existing.body;
    let file = existing.file;
    if (nextFm.slug !== existing.slug) {
      const target = path.join(this.root, collection.path, this.fileName(collection, nextFm));
      if (await exists(target)) {
        throw new CmsError("CONFLICT", `Cannot rename: "${nextFm.slug}" already exists`);
      }
      await remove(existing.file);
      file = target;
    }
    await writeText(file, stringifyFrontmatter(nextFm, nextBody));
    return this.readFile(collection, file);
  }

  async delete(collectionName: string, slug: string): Promise<{ deleted: string }> {
    const entry = await this.get(collectionName, slug);
    await remove(entry.file);
    return { deleted: entry.relativePath };
  }

  /** Write an entry object back verbatim (used by enrichment which edits frontmatter in place). */
  async save(entry: Entry): Promise<Entry> {
    const collection = this.collection(entry.collection);
    const fm = EntryFrontmatterSchema.parse(entry.frontmatter);
    await writeText(entry.file, stringifyFrontmatter(fm, entry.body));
    return this.readFile(collection, entry.file);
  }

  async validate(): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    const seenSlugs = new Map<string, string>();
    const seenIds = new Map<string, string>();
    for (const collection of this.config.collections) {
      const dir = path.join(this.root, collection.path);
      if (!(await exists(dir))) {
        issues.push({
          collection: collection.name,
          file: collection.path,
          severity: "warning",
          message: `Collection directory ${collection.path} does not exist yet`,
        });
        continue;
      }
      for (const file of await listFiles(dir, [".md", ".mdx"])) {
        const rel = path.relative(this.root, file);
        let parsed: ReturnType<typeof parseFrontmatter>;
        try {
          parsed = parseFrontmatter(await readText(file));
        } catch (err) {
          issues.push({
            collection: collection.name,
            file: rel,
            severity: "error",
            message: (err as Error).message,
          });
          continue;
        }
        const result = EntryFrontmatterSchema.safeParse(parsed.data);
        if (!result.success) {
          for (const issue of result.error.issues) {
            issues.push({
              collection: collection.name,
              file: rel,
              severity: "error",
              path: issue.path.join("."),
              message: issue.message,
            });
          }
          continue;
        }
        const fm = result.data;
        const slugKey = `${collection.name}/${fm.slug}`;
        if (seenSlugs.has(slugKey)) {
          issues.push({
            collection: collection.name,
            file: rel,
            slug: fm.slug,
            severity: "error",
            message: `Duplicate slug "${fm.slug}" (also in ${seenSlugs.get(slugKey)})`,
          });
        }
        seenSlugs.set(slugKey, rel);
        if (seenIds.has(fm.id)) {
          issues.push({
            collection: collection.name,
            file: rel,
            slug: fm.slug,
            severity: "error",
            message: `Duplicate id "${fm.id}" (also in ${seenIds.get(fm.id)})`,
          });
        }
        seenIds.set(fm.id, rel);
        for (const field of collection.fields) {
          const value = (fm as Record<string, unknown>)[field.name];
          if (field.required && (value === undefined || value === null || value === "")) {
            issues.push({
              collection: collection.name,
              file: rel,
              slug: fm.slug,
              severity: "error",
              path: field.name,
              message: `Required field "${field.name}" is missing`,
            });
          }
          if (field.type === "enum" && value !== undefined && !field.values?.includes(String(value))) {
            issues.push({
              collection: collection.name,
              file: rel,
              slug: fm.slug,
              severity: "error",
              path: field.name,
              message: `"${field.name}" must be one of ${field.values?.join(", ")}`,
            });
          }
        }
        if (
          this.config.taxonomy.categoryPolicy === "closed" &&
          fm.category &&
          !this.config.taxonomy.categories.some((c) => c.name === fm.category)
        ) {
          issues.push({
            collection: collection.name,
            file: rel,
            slug: fm.slug,
            severity: "warning",
            path: "category",
            message: `Category "${fm.category}" is not in the taxonomy`,
          });
        }
        if (fm.status === "published" && !fm.publishedAt) {
          issues.push({
            collection: collection.name,
            file: rel,
            slug: fm.slug,
            severity: "warning",
            path: "publishedAt",
            message: "Published entry has no publishedAt date",
          });
        }
      }
    }
    return issues;
  }

  private fileName(collection: CollectionConfig, fm: EntryFrontmatter): string {
    if (collection.filePattern === "{date}-{slug}") {
      const date = (fm.publishedAt ?? fm.createdAt ?? nowIso()).slice(0, 10);
      return `${date}-${fm.slug}.md`;
    }
    return `${fm.slug}.md`;
  }

  private async readFile(collection: CollectionConfig, file: string): Promise<Entry> {
    const { data, body } = parseFrontmatter(await readText(file));
    const base = path.basename(file).replace(/\.mdx?$/, "");
    const inferredSlug = base.replace(/^\d{4}-\d{2}-\d{2}-/, "");
    const result = EntryFrontmatterSchema.safeParse({
      id: data.id ?? `file:${collection.name}/${base}`,
      slug: data.slug ?? inferredSlug,
      title: data.title ?? inferredSlug,
      ...data,
    });
    if (!result.success) {
      throw new CmsError("VALIDATION", `Invalid frontmatter in ${file}`, result.error.issues);
    }
    const fm = result.data;
    const p = entryPath(collection, fm);
    return {
      collection: collection.name,
      slug: fm.slug,
      file,
      relativePath: path.relative(this.root, file),
      frontmatter: fm,
      body,
      path: p,
      url: absoluteUrl(this.config.site.url, p),
    };
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

export function applyListOptions(entries: Entry[], opts: ListOptions): Entry[] {
  let out = entries;
  if (opts.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
    out = out.filter((e) => statuses.includes(e.frontmatter.status));
  }
  if (opts.tag) {
    const t = opts.tag.toLowerCase();
    out = out.filter((e) => e.frontmatter.tags.some((x) => x.toLowerCase() === t));
  }
  if (opts.category) {
    const c = opts.category.toLowerCase();
    out = out.filter((e) => e.frontmatter.category?.toLowerCase() === c);
  }
  if (opts.author) out = out.filter((e) => e.frontmatter.author === opts.author);
  if (opts.query) {
    const q = opts.query.toLowerCase();
    out = out.filter(
      (e) =>
        e.frontmatter.title.toLowerCase().includes(q) ||
        e.slug.includes(q) ||
        (e.frontmatter.description ?? "").toLowerCase().includes(q),
    );
  }
  const sort = opts.sort ?? "publishedAt";
  const dir = opts.order ?? (sort === "title" || sort === "slug" ? "asc" : "desc");
  out = [...out].sort((a, b) => {
    const av = sortValue(a, sort);
    const bv = sortValue(b, sort);
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return dir === "asc" ? cmp : -cmp;
  });
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? out.length;
  return out.slice(offset, offset + limit);
}

function sortValue(e: Entry, key: NonNullable<ListOptions["sort"]>): string {
  switch (key) {
    case "title":
      return e.frontmatter.title.toLowerCase();
    case "slug":
      return e.slug;
    case "updatedAt":
      return e.frontmatter.updatedAt ?? e.frontmatter.createdAt ?? "";
    default:
      return e.frontmatter.publishedAt ?? e.frontmatter.updatedAt ?? e.frontmatter.createdAt ?? "";
  }
}
