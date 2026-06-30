import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { readConfig, setPriorityPublicationUrls, writeConfig } from "./config.js";
import { getAppPaths } from "./paths.js";
import {
  checkLoginStatus,
  openLoginFlow,
  withSubstackPage,
} from "./substack/browser.js";
import { discoverSubscriptions } from "./substack/discovery.js";
import { fetchPostContent, listPublicationPosts } from "./substack/posts.js";
import { syncRecent } from "./substack/sync.js";
import { chunkMarkdown, SubstackCache } from "./storage/cache.js";
import type { Publication } from "./types.js";

const server = new McpServer({
  name: "mcp-substack",
  version: "0.1.0",
});

server.registerTool(
  "substack_sync_status",
  {
    title: "Substack Sync Status",
    description:
      "Check the dedicated Substack browser profile path and current login status.",
  },
  async () => {
    const paths = getAppPaths();
    const status = await withSubstackPage({ headless: true }, (page) =>
      checkLoginStatus(page),
    );

    return asJsonContent({
      appHome: paths.appHome,
      browserProfileDir: paths.browserProfileDir,
      cacheDbPath: paths.cacheDbPath,
      configPath: paths.configPath,
      config: await readConfig(),
      status,
    });
  },
);

server.registerTool(
  "substack_login",
  {
    title: "Substack Login",
    description:
      "Open a dedicated local browser profile and wait for the user to log into Substack.",
    inputSchema: z.object({
      timeoutSeconds: z.number().int().min(30).max(1800).default(300),
    }),
  },
  async ({ timeoutSeconds }) => {
    const status = await openLoginFlow(timeoutSeconds);
    return asJsonContent(status);
  },
);

server.registerTool(
  "substack_config_show",
  {
    title: "Show Substack MCP Config",
    description: "Show local mcp-substack configuration.",
  },
  async () => asJsonContent(await readConfig()),
);

server.registerTool(
  "substack_config_set_priority_publications",
  {
    title: "Set Priority Substack Publications",
    description:
      "Set publication URLs that should be synced first or exclusively for daily summaries.",
    inputSchema: z.object({
      publicationUrls: z.array(z.string().url()).min(1),
    }),
  },
  async ({ publicationUrls }) =>
    asJsonContent(await setPriorityPublicationUrls(publicationUrls)),
);

server.registerTool(
  "substack_config_set_defaults",
  {
    title: "Set Substack Sync Defaults",
    description: "Set default sync window and per-publication post limit.",
    inputSchema: z.object({
      defaultSyncDays: z.number().int().min(1).max(30),
      defaultLimitPerPublication: z.number().int().min(1).max(20),
      defaultFetchContent: z.boolean().default(true),
    }),
  },
  async (updates) => {
    const current = await readConfig();
    return asJsonContent(await writeConfig({ ...current, ...updates }));
  },
);

server.registerTool(
  "substack_discover_subscriptions",
  {
    title: "Discover Substack Subscriptions",
    description:
      "Use the authenticated dedicated browser profile to discover subscribed publications.",
  },
  async () => {
    const result = await withSubstackPage({ headless: true }, async (page) => {
      const status = await checkLoginStatus(page);
      if (!status.loggedIn) {
        return { status, publications: [], sources: [], errors: [] };
      }

      const discovery = await discoverSubscriptions(page);
      return { status, ...discovery };
    });

    return asJsonContent(result);
  },
);

server.registerTool(
  "substack_list_recent_posts",
  {
    title: "List Recent Substack Posts",
    description:
      "List recent posts for a publication URL. This is the spike path before cache-backed sync.",
    inputSchema: z.object({
      publication: z.object({
        name: z.string().default("Publication"),
        url: z.string().url(),
        id: z.union([z.string(), z.number()]).optional(),
        subdomain: z.string().optional(),
        customDomain: z.string().optional(),
      }),
      limit: z.number().int().min(1).max(50).default(10),
    }),
  },
  async ({ publication, limit }) => {
    const posts = await withSubstackPage({ headless: true }, (page) =>
      listPublicationPosts(page, publication as Publication, limit),
    );

    return asJsonContent({ publication, posts });
  },
);

server.registerTool(
  "substack_sync_recent",
  {
    title: "Sync Recent Substack Posts",
    description:
      "Discover subscriptions, sync recent posts, fetch bodies, and save them in the local cache.",
    inputSchema: z.object({
      days: z.number().int().min(1).max(30).optional(),
      limitPerPublication: z.number().int().min(1).max(20).optional(),
      maxPublications: z.number().int().min(1).max(200).optional(),
      fetchContent: z.boolean().optional(),
      publicationUrls: z.array(z.string().url()).optional(),
      priorityOnly: z.boolean().default(false),
      useConfigPriority: z.boolean().default(true),
    }),
  },
  async ({
    days,
    limitPerPublication,
    maxPublications,
    fetchContent,
    publicationUrls,
    priorityOnly,
    useConfigPriority,
  }) => {
    const config = await readConfig();
    const result = await syncRecent({
      days: days ?? config.defaultSyncDays,
      limitPerPublication:
        limitPerPublication ?? config.defaultLimitPerPublication,
      maxPublications,
      fetchContent: fetchContent ?? config.defaultFetchContent,
      publicationUrls,
      priorityOnly,
      useConfigPriority,
    });

    return asJsonContent(result);
  },
);

server.registerTool(
  "substack_list_posts",
  {
    title: "List Cached Substack Posts",
    description:
      "List cached posts, optionally filtered to unsummarized posts and a date range.",
    inputSchema: z.object({
      since: z.string().optional(),
      until: z.string().optional(),
      summarized: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).default(50),
    }),
  },
  async (filters) => {
    const cache = await SubstackCache.open();
    try {
      return asJsonContent(cache.listPosts(filters));
    } finally {
      cache.close();
    }
  },
);

server.registerTool(
  "substack_get_cached_post",
  {
    title: "Get Cached Substack Post",
    description: "Return one cached post with markdown content.",
    inputSchema: z.object({
      postKeyOrUrl: z.string(),
    }),
  },
  async ({ postKeyOrUrl }) => {
    const cache = await SubstackCache.open();
    try {
      const post = cache.getPost(postKeyOrUrl);
      return asJsonContent(post ?? { error: "post not found", postKeyOrUrl });
    } finally {
      cache.close();
    }
  },
);

server.registerTool(
  "substack_get_post_chunks",
  {
    title: "Get Cached Substack Post Chunks",
    description: "Return bounded markdown chunks for one cached post.",
    inputSchema: z.object({
      postKeyOrUrl: z.string(),
      maxChars: z.number().int().min(1000).max(20000).default(8000),
    }),
  },
  async ({ postKeyOrUrl, maxChars }) => {
    const cache = await SubstackCache.open();
    try {
      const post = cache.getPost(postKeyOrUrl);
      if (!post?.contentMarkdown) {
        return asJsonContent({ error: "cached markdown not found", postKeyOrUrl });
      }

      const chunks = chunkMarkdown(post.contentMarkdown, maxChars);
      return asJsonContent({
        post: {
          postKey: post.postKey,
          title: post.title,
          url: post.url,
          publicationName: post.publicationName,
          publishedAt: post.publishedAt,
        },
        chunkCount: chunks.length,
        chunks: chunks.map((text, index) => ({
          index,
          text,
        })),
      });
    } finally {
      cache.close();
    }
  },
);

server.registerTool(
  "substack_mark_summarized",
  {
    title: "Mark Substack Posts Summarized",
    description: "Mark cached posts as included in a daily summary.",
    inputSchema: z.object({
      postKeyOrUrls: z.array(z.string()).min(1),
      summaryDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .default(new Date().toISOString().slice(0, 10)),
    }),
  },
  async ({ postKeyOrUrls, summaryDate }) => {
    const cache = await SubstackCache.open();
    try {
      const marked = cache.markSummarized(postKeyOrUrls, summaryDate);
      return asJsonContent({ marked, summaryDate });
    } finally {
      cache.close();
    }
  },
);

server.registerTool(
  "substack_get_post",
  {
    title: "Get Substack Post",
    description:
      "Fetch one Substack post through the authenticated browser profile and return markdown.",
    inputSchema: z.object({
      url: z.string().url(),
    }),
  },
  async ({ url }) => {
    const content = await withSubstackPage({ headless: true }, (page) =>
      fetchPostContent(page, url),
    );

    return asJsonContent(content);
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function asJsonContent(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}
