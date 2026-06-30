import { DatabaseSync } from "node:sqlite";

import { ensureAppDirs, getAppPaths } from "../paths.js";
import type { PostContent, PostSummary, Publication } from "../types.js";

type DbValue = string | number | null;

export type CachedPost = PostSummary & {
  postKey: string;
  publicationName?: string;
  contentMarkdown?: string;
  contentHtml?: string;
  contentMarkdownLength?: number;
  accessState?: string;
  fetchedAt?: string;
  summarizedAt?: string;
  summaryDate?: string;
};

export type ListPostFilters = {
  since?: string;
  until?: string;
  summarized?: boolean;
  limit?: number;
};

export class SubstackCache {
  private constructor(private readonly db: DatabaseSync) {}

  static async open(): Promise<SubstackCache> {
    const paths = await ensureAppDirs(getAppPaths());
    const db = new DatabaseSync(paths.cacheDbPath);
    const cache = new SubstackCache(db);
    cache.migrate();
    return cache;
  }

  close(): void {
    this.db.close();
  }

  upsertPublication(publication: Publication): string {
    const key = publicationKey(publication);
    this.db
      .prepare(
        `
        INSERT INTO publications (
          publication_key, publication_id, name, url, subdomain, custom_domain,
          description, raw_source, discovered_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(url) DO UPDATE SET
          publication_key = excluded.publication_key,
          publication_id = excluded.publication_id,
          name = excluded.name,
          url = excluded.url,
          subdomain = excluded.subdomain,
          custom_domain = excluded.custom_domain,
          description = excluded.description,
          raw_source = excluded.raw_source,
          last_seen_at = CURRENT_TIMESTAMP
        `,
      )
      .run(
        key,
        publication.id == null ? null : String(publication.id),
        publication.name,
        publication.url,
        publication.subdomain ?? null,
        publication.customDomain ?? null,
        publication.description ?? null,
        publication.rawSource ?? null,
      );
    return key;
  }

  listPublications(): Publication[] {
    return this.db
      .prepare(
        `
        SELECT publication_id, name, url, subdomain, custom_domain, description, raw_source
        FROM publications
        ORDER BY name COLLATE NOCASE
        `,
      )
      .all()
      .map((row) => {
        const record = row as Record<string, DbValue>;
        return {
          id: record.publication_id ?? undefined,
          name: String(record.name),
          url: String(record.url),
          subdomain: stringOrUndefined(record.subdomain),
          customDomain: stringOrUndefined(record.custom_domain),
          description: stringOrUndefined(record.description),
          rawSource: stringOrUndefined(record.raw_source),
        };
      });
  }

  upsertPostSummary(post: PostSummary): string {
    const key = postKey(post);
    const publicationKeyValue = publicationKey({
      name: post.publicationUrl,
      url: post.publicationUrl,
    });

    this.db
      .prepare(
        `
        INSERT INTO posts (
          post_key, post_id, publication_key, title, subtitle, url, canonical_url,
          published_at, author, audience, is_paid, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(post_key) DO UPDATE SET
          post_id = excluded.post_id,
          publication_key = excluded.publication_key,
          title = excluded.title,
          subtitle = excluded.subtitle,
          url = excluded.url,
          canonical_url = excluded.canonical_url,
          published_at = excluded.published_at,
          author = excluded.author,
          audience = excluded.audience,
          is_paid = excluded.is_paid,
          updated_at = CURRENT_TIMESTAMP
        `,
      )
      .run(
        key,
        post.id == null ? null : String(post.id),
        publicationKeyValue,
        post.title,
        post.subtitle ?? null,
        post.url,
        post.canonicalUrl ?? null,
        post.publishedAt ?? null,
        post.author ?? null,
        post.audience ?? null,
        post.isPaid ? 1 : 0,
      );

    return key;
  }

  savePostContent(postUrl: string, content: PostContent): void {
    const key = postKey({ url: postUrl });
    this.db
      .prepare(
        `
        UPDATE posts SET
          title = COALESCE(NULLIF(?, ''), title),
          subtitle = COALESCE(NULLIF(?, ''), subtitle),
          url = ?,
          canonical_url = COALESCE(NULLIF(?, ''), canonical_url),
          content_markdown = ?,
          content_html = ?,
          access_state = ?,
          fetched_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE post_key = ? OR url = ? OR canonical_url = ?
        `,
      )
      .run(
        content.title ?? "",
        content.subtitle ?? "",
        content.url,
        content.canonicalUrl ?? "",
        content.markdown,
        content.html ?? null,
        content.accessState,
        key,
        postUrl,
        content.canonicalUrl ?? postUrl,
      );
  }

  listPosts(filters: ListPostFilters = {}): CachedPost[] {
    const where: string[] = [];
    const params: DbValue[] = [];

    if (filters.since) {
      where.push("p.published_at >= ?");
      params.push(filters.since);
    }

    if (filters.until) {
      where.push("p.published_at <= ?");
      params.push(filters.until);
    }

    if (filters.summarized === true) {
      where.push("s.post_key IS NOT NULL");
    } else if (filters.summarized === false) {
      where.push("s.post_key IS NULL");
    }

    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500);
    const sql = `
      SELECT
        p.post_key, p.post_id, p.title, p.subtitle, p.url, p.canonical_url,
        p.publication_key, pub.name AS publication_name, pub.url AS publication_url,
        p.published_at, p.author, p.audience, p.is_paid,
        length(p.content_markdown) AS content_markdown_length,
        NULL AS content_markdown, NULL AS content_html, p.access_state,
        p.fetched_at, s.marked_at AS summarized_at, s.summary_date
      FROM posts p
      LEFT JOIN publications pub ON pub.publication_key = p.publication_key
      LEFT JOIN summary_state s ON s.post_key = p.post_key
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY p.published_at DESC, p.created_at DESC
      LIMIT ?
    `;

    return this.db
      .prepare(sql)
      .all(...params, limit)
      .map(rowToCachedPost);
  }

  getPost(postKeyOrUrl: string): CachedPost | undefined {
    const row = this.db
      .prepare(
        `
        SELECT
          p.post_key, p.post_id, p.title, p.subtitle, p.url, p.canonical_url,
          p.publication_key, pub.name AS publication_name, pub.url AS publication_url,
          p.published_at, p.author, p.audience, p.is_paid, p.content_markdown,
          p.content_html, p.access_state, p.fetched_at, s.marked_at AS summarized_at,
          s.summary_date
        FROM posts p
        LEFT JOIN publications pub ON pub.publication_key = p.publication_key
        LEFT JOIN summary_state s ON s.post_key = p.post_key
        WHERE p.post_key = ? OR p.url = ? OR p.canonical_url = ?
        LIMIT 1
        `,
      )
      .get(postKeyOrUrl, postKeyOrUrl, postKeyOrUrl);

    return row ? rowToCachedPost(row) : undefined;
  }

  markSummarized(postKeyOrUrls: string[], summaryDate: string): number {
    let count = 0;
    const find = this.db.prepare(
      "SELECT post_key FROM posts WHERE post_key = ? OR url = ? OR canonical_url = ? LIMIT 1",
    );
    const upsert = this.db.prepare(
      `
      INSERT INTO summary_state (post_key, summary_date, marked_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(post_key) DO UPDATE SET
        summary_date = excluded.summary_date,
        marked_at = CURRENT_TIMESTAMP
      `,
    );

    this.db.exec("BEGIN");
    try {
      for (const value of postKeyOrUrls) {
        const row = find.get(value, value, value) as
          | Record<string, DbValue>
          | undefined;
        if (!row) {
          continue;
        }
        upsert.run(String(row.post_key), summaryDate);
        count += 1;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return count;
  }

  counts(): Record<string, number> {
    const publications = this.db
      .prepare("SELECT COUNT(*) AS count FROM publications")
      .get() as Record<string, number>;
    const posts = this.db
      .prepare("SELECT COUNT(*) AS count FROM posts")
      .get() as Record<string, number>;
    const fetched = this.db
      .prepare("SELECT COUNT(*) AS count FROM posts WHERE content_markdown IS NOT NULL")
      .get() as Record<string, number>;

    return {
      publications: publications.count,
      posts: posts.count,
      fetchedPosts: fetched.count,
    };
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS publications (
        publication_key TEXT PRIMARY KEY,
        publication_id TEXT,
        name TEXT NOT NULL,
        url TEXT NOT NULL UNIQUE,
        subdomain TEXT,
        custom_domain TEXT,
        description TEXT,
        raw_source TEXT,
        discovered_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_sync_at TEXT
      );

      CREATE TABLE IF NOT EXISTS posts (
        post_key TEXT PRIMARY KEY,
        post_id TEXT,
        publication_key TEXT NOT NULL,
        title TEXT NOT NULL,
        subtitle TEXT,
        url TEXT NOT NULL,
        canonical_url TEXT,
        published_at TEXT,
        author TEXT,
        audience TEXT,
        is_paid INTEGER NOT NULL DEFAULT 0,
        content_markdown TEXT,
        content_html TEXT,
        access_state TEXT NOT NULL DEFAULT 'unknown',
        fetched_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(publication_key) REFERENCES publications(publication_key)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_url ON posts(url);
      CREATE INDEX IF NOT EXISTS idx_posts_published_at ON posts(published_at);
      CREATE INDEX IF NOT EXISTS idx_posts_publication ON posts(publication_key);

      CREATE TABLE IF NOT EXISTS summary_state (
        post_key TEXT PRIMARY KEY,
        summary_date TEXT NOT NULL,
        marked_at TEXT NOT NULL,
        notes TEXT,
        FOREIGN KEY(post_key) REFERENCES posts(post_key)
      );
    `);
  }
}

export function chunkMarkdown(markdown: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const block of markdown.split(/\n{2,}/)) {
    const next = current ? `${current}\n\n${block}` : block;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (block.length <= maxChars) {
      current = block;
    } else {
      for (let i = 0; i < block.length; i += maxChars) {
        chunks.push(block.slice(i, i + maxChars));
      }
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function rowToCachedPost(row: unknown): CachedPost {
  const record = row as Record<string, DbValue>;
  return {
    postKey: String(record.post_key),
    id: stringOrUndefined(record.post_id),
    title: String(record.title),
    subtitle: stringOrUndefined(record.subtitle),
    url: String(record.url),
    canonicalUrl: stringOrUndefined(record.canonical_url),
    publicationUrl: String(record.publication_url ?? ""),
    publicationName: stringOrUndefined(record.publication_name),
    publishedAt: stringOrUndefined(record.published_at),
    author: stringOrUndefined(record.author),
    audience: stringOrUndefined(record.audience),
    isPaid: Boolean(record.is_paid),
    contentMarkdown: stringOrUndefined(record.content_markdown),
    contentHtml: stringOrUndefined(record.content_html),
    contentMarkdownLength:
      typeof record.content_markdown_length === "number"
        ? record.content_markdown_length
        : undefined,
    accessState: stringOrUndefined(record.access_state),
    fetchedAt: stringOrUndefined(record.fetched_at),
    summarizedAt: stringOrUndefined(record.summarized_at),
    summaryDate: stringOrUndefined(record.summary_date),
  };
}

function publicationKey(publication: Publication): string {
  return `url:${publication.url}`;
}

function postKey(post: Pick<PostSummary, "id" | "url">): string {
  return post.id ? `id:${post.id}` : `url:${post.url}`;
}

function stringOrUndefined(value: DbValue | undefined): string | undefined {
  return value == null ? undefined : String(value);
}
