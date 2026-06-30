import type { Page } from "playwright";

import type { PostContent, PostSummary, Publication } from "../types.js";
import { htmlToMarkdown } from "./readability.js";

export async function listPublicationPosts(
  page: Page,
  publication: Publication,
  limit: number,
): Promise<PostSummary[]> {
  const endpoint = new URL("/api/v1/archive", publication.url);
  endpoint.searchParams.set("sort", "new");
  endpoint.searchParams.set("offset", "0");
  endpoint.searchParams.set("limit", String(limit));

  const payload = await gotoJson(page, endpoint.toString());

  if (!Array.isArray(payload)) {
    return [];
  }

  return payload.flatMap((item) => {
    const summary = normalizePostSummary(item, publication);
    return summary ? [summary] : [];
  });
}

export async function fetchPostContent(
  page: Page,
  postUrl: string,
): Promise<PostContent> {
  const slug = extractSlug(postUrl);
  const baseUrl = new URL(postUrl).origin;
  const apiUrl = new URL(`/api/v1/posts/${slug}`, baseUrl);

  const apiPayload = await gotoJson(page, apiUrl.toString())
    .catch((error: unknown) => ({ __error: formatError(error) }));

  const apiRecord =
    apiPayload && typeof apiPayload === "object"
      ? (apiPayload as Record<string, unknown>)
      : undefined;
  const apiHtml = readString(apiRecord, ["body_html", "body"]);
  const evidence: string[] = [];

  if (apiHtml) {
    evidence.push("post-api-body-html");
    return {
      title: readString(apiRecord, ["title"]),
      subtitle: readString(apiRecord, ["subtitle"]),
      url: postUrl,
      canonicalUrl: readString(apiRecord, ["canonical_url", "canonicalUrl"]),
      markdown: htmlToMarkdown(apiHtml, postUrl),
      html: apiHtml,
      accessState: detectAccessState(apiHtml, apiRecord),
      evidence,
    };
  }

  if (apiRecord?.__error) {
    evidence.push(`post-api-error:${apiRecord.__error}`);
  } else {
    evidence.push("post-api-no-body");
  }

  await page.goto(postUrl, { waitUntil: "networkidle", timeout: 60_000 });
  const rendered = await page.evaluate(() => {
    const title =
      document.querySelector("h1")?.textContent?.trim() ??
      document.title.replace(/\s+-\s+.*$/, "").trim();
    const subtitle =
      document
        .querySelector(".subtitle, .post-subtitle, h3")
        ?.textContent?.trim() ?? undefined;
    const article =
      document.querySelector("article") ??
      document.querySelector(".body") ??
      document.querySelector(".available-content");
    return {
      title,
      subtitle,
      html: article?.innerHTML,
      text: article?.textContent,
      url: location.href,
    };
  });

  const html = rendered.html;
  if (!html || (rendered.text?.trim().length ?? 0) < 200) {
    evidence.push("rendered-body-missing-or-short");
    return {
      title: rendered.title,
      subtitle: rendered.subtitle,
      url: rendered.url,
      markdown: html ? htmlToMarkdown(html, rendered.url) : "",
      html,
      accessState: "preview_only",
      evidence,
    };
  }

  evidence.push("rendered-article-html");
  return {
    title: rendered.title,
    subtitle: rendered.subtitle,
    url: rendered.url,
    markdown: htmlToMarkdown(html, rendered.url),
    html,
    accessState: detectAccessState(html, undefined),
    evidence,
  };
}

function normalizePostSummary(
  value: unknown,
  publication: Publication,
): PostSummary | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const title = readString(record, ["title"]);
  const canonicalUrl = readString(record, ["canonical_url", "canonicalUrl"]);
  const url = canonicalUrl ?? readString(record, ["url", "post_url"]);

  if (!title || !url) {
    return undefined;
  }

  const audience = readString(record, ["audience"]);

  return {
    id: readStringOrNumber(record, ["id", "post_id"]),
    title,
    subtitle: readString(record, ["subtitle"]),
    url,
    canonicalUrl,
    publicationUrl: publication.url,
    publishedAt: readString(record, ["post_date", "published_at", "date"]),
    author: readAuthor(record),
    audience,
    isPaid:
      audience === "only_paid" ||
      readBoolean(record, ["is_paid", "paywalled", "subscriber_only"]),
  };
}

async function gotoJson(page: Page, url: string): Promise<unknown> {
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  if (!response?.ok()) {
    throw new Error(`${response?.status() ?? "no-status"} ${response?.statusText() ?? ""}`.trim());
  }

  const text = await page.locator("body").innerText({ timeout: 10_000 });
  return JSON.parse(text);
}

function extractSlug(postUrl: string): string {
  const url = new URL(postUrl);
  const parts = url.pathname.split("/").filter(Boolean);
  const slug = parts.at(-1);
  if (!slug) {
    throw new Error(`Cannot extract post slug from ${postUrl}`);
  }
  return slug;
}

function detectAccessState(
  html: string,
  record: Record<string, unknown> | undefined,
): PostContent["accessState"] {
  const audience = readString(record, ["audience"]);
  const lowerHtml = html.toLowerCase();

  if (
    lowerHtml.includes("subscribe to continue reading") ||
    lowerHtml.includes("this post is for paid subscribers") ||
    lowerHtml.includes("upgrade to paid")
  ) {
    return "preview_only";
  }

  if (audience === "only_paid" || audience === "paid") {
    return html.length > 500 ? "full" : "preview_only";
  }

  return html.length > 0 ? "full" : "unknown";
}

function readAuthor(record: Record<string, unknown>): string | undefined {
  const direct = readString(record, ["author", "author_name"]);
  if (direct) {
    return direct;
  }

  const author = record.author;
  if (author && typeof author === "object") {
    return readString(author as Record<string, unknown>, ["name", "handle"]);
  }

  return undefined;
}

function readString(
  record: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readStringOrNumber(
  record: Record<string, unknown>,
  keys: string[],
): string | number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readBoolean(
  record: Record<string, unknown>,
  keys: string[],
): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
