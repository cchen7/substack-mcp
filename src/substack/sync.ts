import { SubstackCache } from "../storage/cache.js";
import type { Publication } from "../types.js";
import { normalizePublicationUrl, readConfig } from "../config.js";
import { checkLoginStatus, withSubstackPage } from "./browser.js";
import { discoverSubscriptions } from "./discovery.js";
import { fetchPostContent, listPublicationPosts } from "./posts.js";

export type SyncRecentOptions = {
  days: number;
  limitPerPublication: number;
  maxPublications?: number;
  fetchContent: boolean;
  publicationUrls?: string[];
  priorityOnly?: boolean;
  useConfigPriority?: boolean;
};

export type SyncRecentResult = {
  loggedIn: boolean;
  discoveredPublications: number;
  checkedPublications: number;
  discoveredPosts: number;
  savedPosts: number;
  fetchedBodies: number;
  skippedOldPosts: number;
  checkedPublicationUrls: string[];
  errors: string[];
};

export async function syncRecent(
  options: SyncRecentOptions,
): Promise<SyncRecentResult> {
  const cache = await SubstackCache.open();
  const config = await readConfig();
  const since = Date.now() - options.days * 24 * 60 * 60 * 1000;

  try {
    return await withSubstackPage({ headless: true }, async (page) => {
      const status = await checkLoginStatus(page);
      if (!status.loggedIn) {
        return emptyResult(false, ["not logged in"]);
      }

      const discovery = await discoverSubscriptions(page);
      for (const publication of discovery.publications) {
        cache.upsertPublication(publication);
      }

      const discoveredPublications = mergePublications(
        discovery.publications,
        cache.listPublications(),
      );

      const selectedPublications = selectPublications(
        discoveredPublications,
        options,
        options.publicationUrls ??
          (options.useConfigPriority === false
            ? []
            : config.priorityPublicationUrls),
      );

      const publications = selectedPublications.slice(
        0,
        options.maxPublications ?? selectedPublications.length,
      );

      const result: SyncRecentResult = {
        loggedIn: true,
        discoveredPublications: discoveredPublications.length,
        checkedPublications: 0,
        discoveredPosts: 0,
        savedPosts: 0,
        fetchedBodies: 0,
        skippedOldPosts: 0,
        checkedPublicationUrls: [],
        errors: [...discovery.errors],
      };

      for (const publication of publications) {
        result.checkedPublications += 1;
        result.checkedPublicationUrls.push(publication.url);
        await syncPublication(page, cache, publication, since, options, result);
      }

      return result;
    });
  } finally {
    cache.close();
  }
}

async function syncPublication(
  page: Parameters<typeof listPublicationPosts>[0],
  cache: SubstackCache,
  publication: Publication,
  since: number,
  options: SyncRecentOptions,
  result: SyncRecentResult,
): Promise<void> {
  try {
    const posts = await listPublicationPosts(
      page,
      publication,
      options.limitPerPublication,
    );
    result.discoveredPosts += posts.length;

    for (const post of posts) {
      const publishedAt = post.publishedAt
        ? Date.parse(post.publishedAt)
        : Number.NaN;
      if (Number.isFinite(publishedAt) && publishedAt < since) {
        result.skippedOldPosts += 1;
        continue;
      }

      cache.upsertPostSummary(post);
      result.savedPosts += 1;

      if (!options.fetchContent) {
        continue;
      }

      try {
        const content = await fetchPostContent(page, post.url);
        cache.savePostContent(post.url, content);
        result.fetchedBodies += 1;
      } catch (error) {
        result.errors.push(`${post.url}: ${formatError(error)}`);
      }
    }
  } catch (error) {
    result.errors.push(`${publication.url}: ${formatError(error)}`);
  }
}

function emptyResult(loggedIn: boolean, errors: string[]): SyncRecentResult {
  return {
    loggedIn,
    discoveredPublications: 0,
    checkedPublications: 0,
    discoveredPosts: 0,
    savedPosts: 0,
    fetchedBodies: 0,
    skippedOldPosts: 0,
    checkedPublicationUrls: [],
    errors,
  };
}

function mergePublications(
  first: Publication[],
  second: Publication[],
): Publication[] {
  const byUrl = new Map<string, Publication>();
  for (const publication of [...second, ...first]) {
    byUrl.set(normalizePublicationUrl(publication.url), publication);
  }
  return Array.from(byUrl.values());
}

function selectPublications(
  publications: Publication[],
  options: SyncRecentOptions,
  priorityUrls: string[],
): Publication[] {
  const prioritySet = new Set(priorityUrls.map(normalizePublicationUrl));
  const requestedSet =
    options.publicationUrls && options.publicationUrls.length > 0
      ? new Set(options.publicationUrls.map(normalizePublicationUrl))
      : undefined;

  const filtered = publications.filter((publication) => {
    const url = normalizePublicationUrl(publication.url);
    if (requestedSet) {
      return requestedSet.has(url);
    }
    if (options.priorityOnly) {
      return prioritySet.has(url);
    }
    return true;
  });

  return filtered.sort((a, b) => {
    const aPriority = priorityUrls.indexOf(normalizePublicationUrl(a.url));
    const bPriority = priorityUrls.indexOf(normalizePublicationUrl(b.url));
    const aRank = aPriority === -1 ? Number.MAX_SAFE_INTEGER : aPriority;
    const bRank = bPriority === -1 ? Number.MAX_SAFE_INTEGER : bPriority;
    if (aRank !== bRank) {
      return aRank - bRank;
    }
    return a.name.localeCompare(b.name);
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
