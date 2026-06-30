import { readConfig, setPriorityPublicationUrls, writeConfig } from "./config.js";
import { checkLoginStatus, openLoginFlow, withSubstackPage } from "./substack/browser.js";
import { discoverSubscriptions } from "./substack/discovery.js";
import { fetchPostContent, listPublicationPosts } from "./substack/posts.js";
import { syncRecent } from "./substack/sync.js";
import { SubstackCache } from "./storage/cache.js";
import type { Publication } from "./types.js";

type Command =
  | "login"
  | "status"
  | "discover"
  | "list-posts"
  | "get-post"
  | "sync"
  | "sync-priority"
  | "cache-list"
  | "config-show"
  | "config-priority"
  | "config-defaults";

async function main(): Promise<void> {
  const command = process.argv[2] as Command | undefined;

  switch (command) {
    case "login": {
      const timeoutSeconds = Number(process.argv[3] ?? "300");
      console.log(JSON.stringify(await openLoginFlow(timeoutSeconds), null, 2));
      return;
    }

    case "status": {
      const status = await withSubstackPage({ headless: true }, (page) =>
        checkLoginStatus(page),
      );
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    case "discover": {
      const result = await withSubstackPage({ headless: true }, async (page) => {
        const status = await checkLoginStatus(page);
        if (!status.loggedIn) {
          return { status, publications: [], sources: [], errors: [] };
        }

        const discovery = await discoverSubscriptions(page);
        return { status, ...discovery };
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    case "list-posts": {
      const publicationUrl = process.argv[3];
      if (!publicationUrl) {
        throw new Error("Usage: npm run spike -- list-posts <publication-url> [limit]");
      }

      const publication: Publication = {
        name: new URL(publicationUrl).hostname,
        url: publicationUrl,
      };
      const limit = Number(process.argv[4] ?? "10");

      const posts = await withSubstackPage({ headless: true }, (page) =>
        listPublicationPosts(page, publication, limit),
      );
      console.log(JSON.stringify(posts, null, 2));
      return;
    }

    case "get-post": {
      const postUrl = process.argv[3];
      if (!postUrl) {
        throw new Error("Usage: npm run spike -- get-post <post-url>");
      }

      const post = await withSubstackPage({ headless: true }, (page) =>
        fetchPostContent(page, postUrl),
      );
      console.log(JSON.stringify(post, null, 2));
      return;
    }

    case "sync": {
      const days = Number(process.argv[3] ?? "3");
      const limitPerPublication = Number(process.argv[4] ?? "5");
      const maxPublications = process.argv[5]
        ? Number(process.argv[5])
        : undefined;
      const result = await syncRecent({
        days,
        limitPerPublication,
        maxPublications,
        fetchContent: true,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    case "sync-priority": {
      const days = Number(process.argv[3] ?? "3");
      const limitPerPublication = Number(process.argv[4] ?? "5");
      const result = await syncRecent({
        days,
        limitPerPublication,
        fetchContent: true,
        priorityOnly: true,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    case "cache-list": {
      const cache = await SubstackCache.open();
      try {
        console.log(
          JSON.stringify(
            {
              counts: cache.counts(),
              posts: cache.listPosts({
                summarized: false,
                limit: Number(process.argv[3] ?? "20"),
              }),
            },
            null,
            2,
          ),
        );
      } finally {
        cache.close();
      }
      return;
    }

    case "config-show": {
      console.log(JSON.stringify(await readConfig(), null, 2));
      return;
    }

    case "config-priority": {
      const urls = process.argv.slice(3);
      if (urls.length === 0) {
        throw new Error("Usage: npm run spike -- config-priority <publication-url...>");
      }
      console.log(
        JSON.stringify(await setPriorityPublicationUrls(urls), null, 2),
      );
      return;
    }

    case "config-defaults": {
      const current = await readConfig();
      const defaultSyncDays = Number(process.argv[3] ?? current.defaultSyncDays);
      const defaultLimitPerPublication = Number(
        process.argv[4] ?? current.defaultLimitPerPublication,
      );
      console.log(
        JSON.stringify(
          await writeConfig({
            ...current,
            defaultSyncDays,
            defaultLimitPerPublication,
          }),
          null,
          2,
        ),
      );
      return;
    }

    default:
      console.error(`Usage:
  npm run spike -- login [timeoutSeconds]
  npm run spike -- status
  npm run spike -- discover
  npm run spike -- list-posts <publication-url> [limit]
  npm run spike -- get-post <post-url>
  npm run spike -- sync [days] [limitPerPublication] [maxPublications]
  npm run spike -- sync-priority [days] [limitPerPublication]
  npm run spike -- cache-list [limit]
  npm run spike -- config-show
  npm run spike -- config-priority <publication-url...>
  npm run spike -- config-defaults [days] [limitPerPublication]`);
      process.exitCode = 2;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
