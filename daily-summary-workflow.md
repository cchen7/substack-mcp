# Daily Summary Workflow

Use this flow from Copilot or any MCP client.

## First-Time Setup

1. Run `substack_login` if `substack_sync_status` reports `loggedIn: false`.
2. Optionally run `substack_config_set_priority_publications` with the
   publication URLs you want in the daily summary.

## Daily Run

1. Run `substack_sync_recent`.

   Suggested arguments:

   ```json
   {
     "days": 3,
     "limitPerPublication": 5,
     "priorityOnly": true,
     "fetchContent": true
   }
   ```

2. Run `substack_list_posts`.

   Suggested arguments:

   ```json
   {
     "summarized": false,
     "limit": 20
   }
   ```

3. For each relevant post, run `substack_get_post_chunks`.

   Suggested arguments:

   ```json
   {
     "postKeyOrUrl": "<postKey from substack_list_posts>",
     "maxChars": 8000
   }
   ```

4. Generate the daily summary from the returned chunks.

5. Run `substack_mark_summarized` for included posts.

   Suggested arguments:

   ```json
   {
     "postKeyOrUrls": ["<postKey>", "<postKey>"],
     "summaryDate": "YYYY-MM-DD"
   }
   ```

## Notes

- `substack_list_posts` returns metadata and markdown length, not full article
  bodies.
- `substack_get_post_chunks` is the preferred path for long articles.
- Paid content remains local in
  `~/Library/Application Support/mcp-substack/substack.db`.
