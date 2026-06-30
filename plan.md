# mcp-substack Plan

## Goal

Build a local MCP server that lets Copilot discover and read Substack posts
available to the user's own reader account, including free posts and paid posts
that the account is authorized to access. The primary workflow is daily summary
generation, not one-off archival export.

The server must not bypass paywalls, share credentials, or scrape content the
account cannot legitimately view.

## Product Workflow

1. User logs into Substack once through a dedicated local browser profile.
2. MCP server reuses that dedicated profile for future syncs.
3. Server automatically discovers subscribed publications.
4. Server syncs recent posts from all discovered subscriptions.
5. Server stores article metadata, markdown content, sync status, and summary
   state in a local private cache.
6. Copilot uses MCP tools to list unsummarized posts, fetch post content or
   chunks, produce a daily summary, and mark posts as summarized.

## Key Decisions

### Do Not Read Daily Chrome Cookies

The local DLP program may block reading Chrome Keychain-backed cookie storage.
Avoid this path entirely.

Instead, use a dedicated browser profile owned by this MCP server:

```text
~/Library/Application Support/mcp-substack/browser-profile/
```

This keeps the flow automated after first login while avoiding direct reads of
the user's normal Chrome cookie database or Keychain secrets.

### Keep a Local Cache

Daily summary generation should not depend on live Substack fetches every time.
The server should keep a private local SQLite cache:

```text
~/Library/Application Support/mcp-substack/substack.db
```

Cache contents:

- subscribed publications
- post metadata
- normalized markdown body
- original URL
- paid/free/preview/access state
- content hash
- sync timestamps and errors
- summarized/not-summarized state

This makes daily summary workflows stable, incremental, and auditable.

### Markdown Extraction

Use local extraction as the primary path:

- browser fetches the authenticated page/API
- parser extracts structured post data when available
- fallback to DOM/HTML parsing
- Readability-like cleanup
- Turndown-style HTML-to-Markdown conversion
- chunk by headings and paragraph boundaries

Firecrawl can be considered later as an optional fallback for public pages, but
it should not be the main path for paid/authenticated content.

Fiddler can be useful as a manual development/debugging tool for understanding
Substack requests, but it should not be part of the production MCP workflow.

## Proposed Tech Stack

- TypeScript
- Node.js
- MCP TypeScript SDK
- stdio transport
- Playwright for the dedicated browser profile and authenticated fetches
- SQLite for local cache
- zod for MCP input validation
- cheerio/readability/turndown or equivalent libraries for extraction

## MCP Tools

### `substack_login`

Open or reuse the dedicated browser profile and let the user log into Substack.
Return current login status.

### `substack_discover_subscriptions`

Use the authenticated session to discover subscribed publications. Store the
result in SQLite.

### `substack_sync_recent`

Sync recent posts across discovered subscriptions.

Inputs:

- `days`: default 2 or 3
- `limitPerPublication`: optional
- `forceRefresh`: optional

Outputs:

- publications checked
- posts discovered
- posts created/updated/skipped
- preview/access-denied counts
- errors

### `substack_list_posts`

List cached posts for Copilot.

Filters:

- date range
- publication
- paid/free/all
- access state
- summarized state

### `substack_get_post`

Return a cached post as markdown plus metadata.

### `substack_get_post_chunks`

Return a long post in bounded markdown chunks suitable for LLM context windows.

### `substack_mark_summarized`

Mark one or more posts as included in a daily summary.

### `substack_sync_status`

Return current state:

- login status
- last subscription discovery
- last sync time
- publication count
- post count
- recent errors

## Data Model Draft

### `publications`

- `id`
- `name`
- `url`
- `subdomain`
- `discovered_at`
- `last_seen_at`
- `last_sync_at`

### `posts`

- `id`
- `publication_id`
- `title`
- `subtitle`
- `author`
- `url`
- `canonical_url`
- `published_at`
- `is_paid`
- `access_state`: `full`, `preview_only`, `access_denied`, `unknown`
- `content_markdown`
- `content_html`
- `content_hash`
- `fetched_at`
- `created_at`
- `updated_at`

### `summary_state`

- `post_id`
- `summary_date`
- `marked_at`
- `notes`

### `sync_errors`

- `id`
- `scope`
- `target_url`
- `message`
- `created_at`

## Implementation Phases

### Phase 1: Spike

Prove the risky pieces before building the full server:

1. Launch dedicated Playwright browser profile.
2. Let the user log into Substack once.
3. Verify login state can be reused in a later process.
4. Discover subscriptions automatically.
5. Fetch one free post and one paid post available to the account.
6. Extract markdown locally.

Success criteria:

- no reads from normal Chrome profile or Keychain cookie store
- at least one subscribed publication discovered automatically
- authenticated paid article body can be retrieved when the account has access
- preview/paywall pages are clearly detected as incomplete

### Phase 2: MCP Skeleton

1. Initialize TypeScript project.
2. Add MCP stdio server.
3. Register initial tools:
   - `substack_login`
   - `substack_sync_status`
   - `substack_discover_subscriptions`
4. Add local config and logging.

### Phase 3: Cache and Sync

1. Add SQLite schema and migrations.
2. Implement publication persistence.
3. Implement post list sync.
4. Implement post body sync.
5. Add access-state detection.

### Phase 4: Copilot Daily Summary Tools

1. Add `substack_list_posts`.
2. Add `substack_get_post`.
3. Add `substack_get_post_chunks`.
4. Add `substack_mark_summarized`.
5. Validate the daily summary workflow end to end from Copilot.

### Phase 5: Hardening

1. Add retry/backoff.
2. Add better error reporting.
3. Add parser fixtures without real paid content.
4. Add documentation for MCP client configuration.
5. Add optional export to Markdown/JSONL.

## Open Risks

### Subscription Discovery Stability

Substack may change internal reader/feed endpoints. The spike should identify
the most stable source for subscription discovery and isolate it behind one
module.

### DLP and Dedicated Browser Profile

The plan avoids reading normal Chrome cookies, but the dedicated browser profile
must still be tested under the local DLP environment.

### Paid Content Rendering

Some posts may load content through client-side JSON or delayed requests. The
fetcher should support both raw response extraction and rendered DOM extraction.

### Rate Limits and Anti-Automation

Sync should be conservative:

- recent windows by default
- low concurrency
- retry with backoff
- cache first

## Non-Goals

- bypassing paywalls
- sharing paid content outside the local machine
- using the user's normal Chrome cookie database
- requiring manual configuration for each subscribed publication
- making Fiddler or hosted crawlers part of the daily production path

