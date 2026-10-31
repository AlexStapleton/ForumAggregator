# Updates to followed thread posts

Followed threads compare the sanitized content of posts already collected. Meaningful changes to text, quotes, code, tables and attachment URLs update the stored body and display **Update detected** with the detection time in UTC. This is when ForumAggregator noticed the change, not the author's edit time.

Edits do not count as new replies or change a follower's saved status, reading position, unread state or the card's date. Author and original-post date corrections remain separate metadata repairs. Existing installations establish a comparison baseline on the first encounter after upgrading, without labeling every old post as edited.

Normal checks notice edits on pages they already fetch. In addition, every six successful checks, one page is audited in a rotation through the newest three pages (or all pages of a shorter thread). Already fetched pages are reused. Catch-up takes priority; audits wait while a known gap remains. Audit requests fit within the configured pages-per-check limit. With a one-page budget, an older-page audit can delay discovery of new replies by one polling interval. Failed or incomplete pages do not commit content or advance the audit rotation. Rotation survives restarts.

Reopening the reader or requesting a page uses the latest detected revision, even when the card's date and summary are unchanged. The open reader is not replaced in the background, so edits do not shift the current scroll position. Existing image-load and post-end checks still govern reading progress. The update label is shown both on stored replies and on whole-thread pages for retained posts.

This is a bounded recent-post check, not a historical archive: only the normal retained post history is compared (currently 300 posts), older pages are not swept, deleted posts are not synchronized, and previous versions are not retained. Forum access restrictions and FlareSolverr settings continue to apply to every request.
