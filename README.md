# mcp-substack

Local MCP server for giving Copilot access to Substack posts that your own
reader account is allowed to view, including paid posts from your subscriptions.

The main workflow is daily summary generation:

1. Sync recent posts from priority Substack publications.
2. Cache metadata and markdown locally.
3. Let Copilot list unsummarized posts.
4. Let Copilot fetch long posts in chunks.
5. Mark summarized posts so they do not repeat tomorrow.

## Safety Boundary

This server uses only your own authenticated Substack session.

It does not:

- read your normal Chrome profile
- read Chrome Keychain-backed cookie storage
- store your Substack password
- bypass paywalls
- share paid content outside your machine

Authentication is handled through a dedicated Playwright browser profile:

```text
~/Library/Application Support/mcp-substack/browser-profile/
```

Cached article data is stored locally:

```text
~/Library/Application Support/mcp-substack/substack.db
```

Local config is stored at:

```text
~/Library/Application Support/mcp-substack/config.json
```

## Requirements

- macOS
- Node.js 26 or newer recommended, because this project uses Node's built-in
  `node:sqlite`
- npm

## Install

```bash
cd ~/path/to/substack-mcp
npm install
npx playwright install chromium
npm run build
```

## First Login

Open the dedicated Substack browser profile and log in once:

```bash
npm run spike -- login 300
```

If you are already logged in, the browser may open briefly and close.

Check login status:

```bash
npm run spike -- status
```

Expected result:

```json
{
  "loggedIn": true
}
```

## Priority Publications

You can optionally configure a small set of priority publications for daily
summary runs. This is useful when you subscribe to many publications but only
want a subset in the default summary.

Set or reset priority publications with your own publication URLs:

```bash
npm run spike -- config-priority \
  https://example-newsletter.substack.com \
  https://example.com
```

Show current config:

```bash
npm run spike -- config-show
```

## Local Sync Commands

Sync only priority publications:

```bash
npm run spike -- sync-priority 3 5
```

This means:

- last 3 days
- up to 5 recent posts per priority publication
- fetch full article bodies into the local cache

List cached unsummarized posts:

```bash
npm run spike -- cache-list 20
```

Useful diagnostics:

```bash
npm run spike -- discover
npm run spike -- list-posts https://example-newsletter.substack.com 5
```

## MCP Server

Build and run the MCP server over stdio:

```bash
npm run build
npm start
```

Example MCP client config:

```json
{
  "servers": {
    "substack": {
      "command": "node",
      "args": [
        "/absolute/path/to/substack-mcp/dist/server.js"
      ]
    }
  }
}
```

## Daily Copilot Workflow

Recommended tool sequence:

1. `substack_sync_recent`

   ```json
   {
     "days": 3,
     "limitPerPublication": 5,
     "priorityOnly": true,
     "fetchContent": true
   }
   ```

2. `substack_list_posts`

   ```json
   {
     "summarized": false,
     "limit": 20
   }
   ```

3. For each post to summarize, call `substack_get_post_chunks`.

   ```json
   {
     "postKeyOrUrl": "<postKey from substack_list_posts>",
     "maxChars": 8000
   }
   ```

4. After generating the daily summary, call `substack_mark_summarized`.

   ```json
   {
     "postKeyOrUrls": ["<postKey>", "<postKey>"],
     "summaryDate": "2026-06-30"
   }
   ```

## MCP Tools

- `substack_login`
  - Opens the dedicated browser profile and waits for Substack login.

- `substack_sync_status`
  - Shows app paths, config, and login status.

- `substack_config_show`
  - Shows local config.

- `substack_config_set_priority_publications`
  - Sets priority publication URLs.

- `substack_config_set_defaults`
  - Sets default sync window and per-publication limit.

- `substack_discover_subscriptions`
  - Discovers publications from the authenticated reader account.

- `substack_sync_recent`
  - Syncs recent posts into SQLite.

- `substack_list_posts`
  - Lists cached post metadata. This does not return full bodies.

- `substack_get_cached_post`
  - Returns one cached post with markdown.

- `substack_get_post_chunks`
  - Returns one cached post split into bounded markdown chunks.

- `substack_mark_summarized`
  - Marks posts as included in a daily summary.

- `substack_list_recent_posts`
  - Diagnostic tool for listing recent posts from one publication.

- `substack_get_post`
  - Diagnostic tool for live-fetching one post as markdown.

## Verification Status

Current verified behavior:

- dedicated browser profile login works
- subscription discovery works
- paid full text works for authorized subscriptions
- priority-only sync works
- SQLite cache stores metadata and markdown
- chunking works for long articles
- `npm run typecheck` passes
- `npm run build` passes

## Troubleshooting

### Browser Opens and Closes Quickly

This usually means the dedicated profile is already logged in and the login
check succeeded.

Run:

```bash
npm run spike -- status
```

### Playwright Browser Missing

Run:

```bash
npx playwright install chromium
```

### Substack Returns 429

Substack may rate-limit repeated sync attempts. Wait a few minutes and retry
with a smaller window:

```bash
npm run spike -- sync-priority 3 2
```

### Paid Post Shows Preview Only

Check that the dedicated profile is logged into the account with the paid
subscription:

```bash
npm run spike -- status
```

Then test the publication directly:

```bash
npm run spike -- list-posts https://example-newsletter.substack.com 5
```

### Reset Local State

The local data lives outside the repository:

```text
~/Library/Application Support/mcp-substack/
```

Remove only the files you intend to reset. Deleting `browser-profile/` requires
logging into Substack again. Deleting `substack.db` removes cached articles and
summary state.
