import type { Page } from "playwright";

import type { Publication } from "../types.js";

const DISCOVERY_PAGES = [
  "https://substack.com/home",
  "https://substack.com/inbox",
  "https://substack.com/reader",
];

const JSON_ENDPOINT_CANDIDATES = [
  "https://substack.com/api/v1/reader/feed?limit=50",
];

export type DiscoveryResult = {
  publications: Publication[];
  sources: string[];
  errors: string[];
};

export async function discoverSubscriptions(page: Page): Promise<DiscoveryResult> {
  const sources: string[] = [];
  const errors: string[] = [];
  const publications = new Map<string, Publication>();

  for (const endpoint of JSON_ENDPOINT_CANDIDATES) {
    const json = await fetchJson(page, endpoint).catch((error: unknown) => {
      errors.push(`${endpoint}: ${formatError(error)}`);
      return undefined;
    });

    if (!json) {
      continue;
    }

    sources.push(endpoint);
    for (const publication of extractPublications(json, endpoint)) {
      publications.set(publicationKey(publication), publication);
    }
  }

  for (const url of DISCOVERY_PAGES) {
    const responsePayloads: unknown[] = [];

    const onResponse = async (response: Awaited<ReturnType<Page["waitForResponse"]>>) => {
      const responseUrl = response.url();
      if (!looksLikeUsefulJson(responseUrl)) {
        return;
      }

      const json = await response.json().catch(() => undefined);
      if (json) {
        responsePayloads.push(json);
        sources.push(responseUrl);
      }
    };

    page.on("response", onResponse);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(5_000);
    } catch (error) {
      errors.push(`${url}: ${formatError(error)}`);
    } finally {
      page.off("response", onResponse);
    }

    const statePayloads = await extractPageStatePayloads(page).catch(
      (error: unknown) => {
        errors.push(`${url}: state extraction failed: ${formatError(error)}`);
        return [];
      },
    );

    for (const payload of [...responsePayloads, ...statePayloads]) {
      for (const publication of extractPublications(payload, url)) {
        publications.set(publicationKey(publication), publication);
      }
    }
  }

  return {
    publications: Array.from(publications.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    sources: Array.from(new Set(sources)),
    errors,
  };
}

async function fetchJson(page: Page, endpoint: string): Promise<unknown> {
  return page.evaluate(async (url) => {
    const response = await fetch(url, {
      credentials: "include",
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return response.json();
  }, endpoint);
}

async function extractPageStatePayloads(page: Page): Promise<unknown[]> {
  return page.evaluate(() => {
    const payloads: unknown[] = [];

    const nextData = document.querySelector<HTMLScriptElement>(
      "script#__NEXT_DATA__",
    )?.textContent;
    if (nextData) {
      try {
        payloads.push(JSON.parse(nextData));
      } catch {
        // Ignore malformed script state.
      }
    }

    for (const script of Array.from(document.scripts)) {
      const text = script.textContent ?? "";
      if (!text.includes("publication") && !text.includes("subscriptions")) {
        continue;
      }

      const matches = text.matchAll(/JSON\.parse\("(.+?)"\)/g);
      for (const match of matches) {
        try {
          payloads.push(JSON.parse(JSON.parse(`"${match[1]}"`)));
        } catch {
          // Ignore non-state JSON.parse calls.
        }
      }
    }

    return payloads;
  });
}

function extractPublications(value: unknown, source: string): Publication[] {
  const result: Publication[] = [];
  const seenObjects = new WeakSet<object>();

  function visit(node: unknown): void {
    if (!node || typeof node !== "object") {
      return;
    }

    if (seenObjects.has(node)) {
      return;
    }
    seenObjects.add(node);

    const record = node as Record<string, unknown>;

    const nestedPublication = asRecord(record.publication);
    if (nestedPublication) {
      const publication = normalizePublication(nestedPublication, source);
      if (publication) {
        result.push(publication);
      }
    }

    const directPublication = normalizePublication(record, source);
    if (directPublication) {
      result.push(directPublication);
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }

    for (const child of Object.values(record)) {
      visit(child);
    }
  }

  visit(value);

  const byKey = new Map<string, Publication>();
  for (const publication of result) {
    byKey.set(publicationKey(publication), publication);
  }
  return Array.from(byKey.values());
}

function normalizePublication(
  record: Record<string, unknown>,
  source: string,
): Publication | undefined {
  const name = readString(record, ["name", "publication_name", "title"]);
  const subdomain = readString(record, ["subdomain"]);
  const customDomain = readString(record, ["custom_domain", "customDomain"]);
  const explicitUrl = readString(record, ["url", "publication_url", "homepage_url"]);
  const id = readStringOrNumber(record, ["id", "publication_id", "pub_id"]);

  const url = normalizePublicationUrl(explicitUrl, customDomain, subdomain);
  if (!name || !url) {
    return undefined;
  }

  const host = new URL(url).hostname;
  if (host === "substack.com" || host === "www.substack.com") {
    return undefined;
  }

  return {
    id,
    name,
    url,
    subdomain,
    customDomain,
    description: readString(record, ["description", "byline"]),
    rawSource: source,
  };
}

function normalizePublicationUrl(
  explicitUrl?: string,
  customDomain?: string,
  subdomain?: string,
): string | undefined {
  const value = explicitUrl ?? customDomain;
  if (value) {
    const withProtocol = value.startsWith("http") ? value : `https://${value}`;
    try {
      const url = new URL(withProtocol);
      return `${url.protocol}//${url.hostname}`;
    } catch {
      return undefined;
    }
  }

  if (subdomain) {
    return `https://${subdomain}.substack.com`;
  }

  return undefined;
}

function publicationKey(publication: Publication): string {
  return publication.id ? `id:${publication.id}` : `url:${publication.url}`;
}

function looksLikeUsefulJson(url: string): boolean {
  return (
    url.includes("/api/") &&
    /(subscription|publication|reader|feed|inbox|home)/i.test(url)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
