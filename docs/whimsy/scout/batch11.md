# Scout batch 11: live folders (Push refresh, Linear + Jira, smarter RSS)

Read-only research, 2026-10-29. Paths relative to ~/Repos/whimsy. "Overlay" = new code in
src/zen/whimsy/ (+ prefs/whimsy/whimsy.yaml, whimsy-settings.js), no Zen edits. gh search
issues --repo zen-browser/desktop found two directly relevant open bugs (cited in item 1);
nothing else on-topic.

## The extension point: `registry` is a public Map, built for exactly this

`src/zen/live-folders/ZenLiveFoldersManager.sys.mjs` keys every live-folder type in a plain
public `Map`: `this.registry.set(ProviderClass.type, ProviderClass)` (:62), populated in
`init()` from a hardcoded `providers` array (RSS, GitHub). `registry` itself is never made
private and is read elsewhere by type lookup (`this.registry.get(type)`, :235, :251, :691) —
there's no gate stopping more entries being added after `init()` runs. So Linear and Jira
don't need a patch to Zen's `providers` array at all: `WhimsyLiveFolders.init()` can wait for
`lazy.ZenLiveFoldersManager.init()` to resolve, then simply call
`lazy.ZenLiveFoldersManager.registry.set("linear", WhimsyLinearLiveFolderProvider)` and
`.set("jira", WhimsyJiraLiveFolderProvider)`. Each provider extends the same
`nsZenLiveFolderProvider` base class (`src/zen/live-folders/ZenLiveFolder.sys.mjs`) the
existing RSS and GitHub providers do — same `fetchItems()`/`getMetadata()`/`options` contract,
same `start()`/`stop()`/`DeferredTask` scheduling, same `fetch()` helper that already does the
hard part: it opens an `nsIHttpChannel` with `SEC_COOKIES_INCLUDE` scoped to the live folder's
own space's `userContextId` (ZenLiveFolder.sys.mjs:125-153) — i.e. **it already authenticates
as whatever account is logged into that space's container**, which is the "use the signed-in
session, no API keys" model the build-plan specifies for Linear/Jira, same as the existing
GitHub provider.

Build order: the `registry.set()` hook (and a generic "Create a live folder" UI entry for the
two new types, mirroring however GitHub/RSS are offered today) first, then Jira (same-origin
cookie auth is a known-working pattern — closest to GitHub), then Linear (cookie auth is a real
open question, see item 3), then Push refresh last since it benefits from having two more
providers to test conditional-fetch against, and because the UI piece needs a different,
trickier hook (below).

---

## 1. "Push" live-folder refresh (the user's renamed "Webhooks for live folders" ask)
Queue: `[auto|new|M]` "Webhooks for live folders" — NOTE (user): "YES! I want this to be in
the live folder refresh option, which currently has 15 minutes as the fastest option. It
should have one called 'Push' or something like the iOS Mail settings." BUILD-PLAN answer
(wins): smart checks every 1 minute using conditional requests (ETag/If-None-Match), shown as
"Push" alongside the interval choices; do NOT refresh on window focus.
- (a) Confirmed the "currently 15 minutes" claim: `ZenLiveFoldersUI.sys.mjs`'s private
  `#intervalOptions(liveFolder)` (:162) builds radios for 15/30 min and 1/2/4/8 hr only — no
  push option, no conditional-request support anywhere in the fetch path.
  `ZenLiveFolder.sys.mjs`'s shared `fetch()` (:125) resolves `{ text, status, contentType }`
  only — **no response headers are captured or exposed**, so there's no ETag to key a
  conditional request on today, and no way to send `If-None-Match` short of passing it in the
  existing `headers` option (which `fetch()` does support as a request header, :154).
- (b) **Issue #15848 "Live folder does not refresh"** and **#13383 "Erratic Live Folder
  behaviour, repo-specific or behaviour-based folders are flaky"** (both open) are exactly the
  kind of reliability complaint a naive "poll every minute" implementation would make worse,
  not better — worth building this with explicit backoff-on-repeated-failure and surfacing the
  existing `lastErrorId`/`zen-live-folder-last-fetched` state (ZenLiveFoldersUI.sys.mjs:202) so
  a flaky Push folder visibly says so instead of silently going stale.
- (c) iOS Mail's "Push" vs. a fixed fetch interval: push mode means "tell me the instant
  something changes," without the user having to guess how aggressive a poll interval should
  be. The honest implementation on a provider that has no real server push (no webhook
  endpoint Whimsy can register as a push browser doesn't normally receive) is what the
  build-plan already specifies: poll often (1 min) but cheaply (conditional GET returns 304
  with no body when nothing changed, so it's not actually fetching full content every minute —
  "push-like," not literal push).
- (d) Two separate, overlay-only pieces:
  1. **Conditional fetch, per-provider, not a patch to the shared base class.** Rather than
     edit `ZenLiveFolder.sys.mjs`'s `fetch()` (a Zen file) to add header capture, each Whimsy
     provider that wants Push (Linear, Jira, and a wrapped version of the existing GitHub/RSS
     providers) does its own lightweight conditional check using the same
     `NetUtil.newChannel`/`asyncOpen` primitives the base class already demonstrates, storing
     the last `ETag` (or `Last-Modified`) per folder in `WhimsyLiveFolders`' own JSONFile. On a
     304, treat it as "no new items" and skip the expensive parse. For the two *existing*
     providers (GitHub, RSS), wrap their public `fetchItems` the same way
     `WhimsyGithubReviews.wrap()` already wraps `GithubLiveFolder`'s `fetchItems`
     (src/zen/whimsy/WhimsyGithubReviews.sys.mjs:86): run the conditional probe first, and only
     call through to the real (Zen-owned) `fetchItems` on a 200.
  2. **Surfacing "Push" in the menu.** `#intervalOptions` is a true ES private method
     (`#`-prefixed) — it cannot be reached or overridden from outside the class the way a
     public property like `fetchItems` or `options` can be (there is no
     `proto.#intervalOptions = ...` from another module; private fields/methods are lexically
     scoped to the class body). The surgical option: wrap the *public* method that calls it,
     `buildContextMenu(folder)` (:189), the same prototype-wrapping technique
     `WhimsyGithubReviews` already uses — call the original to build the popup, then splice one
     more radio `menuitem` for "Push" into the already-built `menupopup` before it's shown,
     wired to set `liveFolder.state.interval = 60 * 1000` plus a `state.pushMode = true` flag
     the conditional-fetch wrapper checks. Zen's own interval radios stay untouched; "Push" is
     additive DOM, not a modification of Zen's menu-building logic.
     Per the build-plan: never refresh on window focus — don't add a `focus`/`visibilitychange`
     listener; the 1-minute `DeferredTask` from the base class's existing `start()` is the only
     trigger, which also means Push "ticks" even while the window isn't focused, matching mail
     client expectations.
  Test: a folder in Push mode whose server returns 304 on the second check doesn't re-render
  its items (assert the Lit/DOM render count, not just that items are equal); a 200 with
  changed content updates items and the stored ETag; switching away from Push back to a fixed
  interval stops the 1-minute ticks; a provider that errors repeatedly in Push mode shows the
  existing error state (don't suppress `lastErrorId`) rather than retrying silently forever.

## 2. Jira live folder
Queue: `[apps|new|M]` "Linear and Jira live folders" (no note, grouped as one atlas item;
splitting the research since the two services differ a lot in auth feasibility).
- (a) No existing provider. Jira Cloud's REST API (`https://<site>.atlassian.net/rest/api/2/search?jql=assignee=currentUser()+AND+resolution=Unresolved`)
  is same-origin with the web app a signed-in user already has a session for, and Jira Cloud's
  REST endpoints do accept the browser's session cookie for GET requests from first-party
  contexts (this is how Jira's own web UI calls its REST API) — closely matching how the
  existing GitHub provider's `fetch()` call already works (cookie-included channel, scoped to
  the folder's container). Some Jira Cloud tenants require an `X-Atlassian-Token: no-check`
  header for non-GET verbs, irrelevant here since this is read-only GET.
- (b) No open issue/discussion.
- (c) "Your assigned issues as a self-updating folder" (the atlas's own description) — the
  model is identical to the existing GitHub review-requests live folder, just a different
  tracker. Teams that live in Jira want the same "tabs that refresh themselves" convenience
  GitHub already has.
- (d) `WhimsyJiraLiveFolderProvider extends nsZenLiveFolderProvider`, `static type = "jira"`.
  `fetchItems()` calls `this.fetch(`${this.state.site}/rest/api/2/search?jql=...`, { headers:
  { Accept: "application/json" } })` and maps `issues[]` to `{ id: key, url:
  `${site}/browse/${key}`, title: fields.summary }`. `options` exposes the Jira site URL
  (`your-domain.atlassian.net`, since Jira Cloud has no single global API host the way GitHub
  does) and a JQL override (default "assignee = currentUser() AND resolution = Unresolved").
  Icon/metadata: Jira's favicon via the existing `PlacesUtils.favicons` pattern
  `RssLiveFolder.getMetadata` already uses, or a static Jira logo.
  Edge cases: a user with multiple Jira sites needs one live folder per site (the site URL is
  per-folder state, same as the RSS provider's per-folder feed URL); a 401/403 (not logged in
  to that Jira site in the folder's container) should surface the existing
  `"zen-live-folder-no-auth"`-style error id, matching the GitHub provider's handling.
  Test: a folder pointed at a test `.sjs` returning a fixed JQL search payload lists the right
  issues; a 401 response shows the no-auth error state, not a generic failed-fetch; two folders
  for two different Jira sites don't cross-contaminate state.

## 3. Linear live folder
Queue: same atlas line as Jira, "Linear and Jira live folders."
- (a) No existing provider, and **auth feasibility here is a real open question, not a
  known-working pattern like Jira or GitHub.** Linear's web app (linear.app) is a single-page
  app whose data comes from `api.linear.app/graphql`; unlike GitHub and Jira, Linear's web
  client is known to authenticate GraphQL calls with a bearer token it holds in its own client
  state (derived at login) rather than relying purely on a forwarded session cookie for
  cross-subdomain (`linear.app` → `api.linear.app`) requests — cookie-only auth to the GraphQL
  endpoint may simply fail. This needs verification against the real API (not something this
  read-only pass can confirm without hitting Linear's servers), and should be the first thing
  checked before writing the provider, not assumed.
- (b) No open issue/discussion.
- (c) Same model as Jira/GitHub: your assigned Linear issues as a folder of tabs that stay
  current without a manual refresh.
- (d) Two fallback plans depending on what verification finds: **Plan A** (if cookie auth to
  `api.linear.app/graphql` does work from a same-site-cookie-scoped channel): a
  `WhimsyLinearLiveFolderProvider` POSTing a small GraphQL query (`{ viewer { assignedIssues {
  nodes { id title url } } } }`) via `fetch()` with `Content-Type: application/json` in the
  `headers` option and the query as a POST body — note `ZenLiveFolder.fetch()` as read today
  only supports GET-style `asyncOpen` with no body parameter (:125-153 take `url` and
  `headers` only), so this plan also needs a Whimsy-side GraphQL POST helper rather than
  reusing the base `fetch()` unmodified. **Plan B** (if GraphQL needs a bearer token the
  cookie jar doesn't carry): scrape Linear's own "My Issues" view the way the GitHub provider
  scrapes github.com's HTML for the non-JSON path (`parseIssues`, GithubLiveFolder.sys.mjs
  around :205) — fetch `linear.app/<workspace>/my-issues` HTML with cookies included and parse
  whatever embedded JSON/DOM structure the page ships (Linear, like most modern SPAs, likely
  embeds its initial data as a `<script>` JSON blob rather than server-rendering a list, so
  this needs inspecting the actual page source before committing to a selector strategy).
  Flag this up front in the morning report if Plan A doesn't pan out quickly tonight — Jira
  ships either way; Linear may need to defer to Maybe if verification eats the time budget.
  Test (once a plan is chosen): mirrors Jira's test shape — fixed fixture response maps to the
  right issues; an auth failure surfaces distinctly from a parse failure (so Plan B's
  HTML-shape brittleness is diagnosable, not silently "failed-fetch" for every future Linear
  redesign).

## 4. Smarter RSS
Queue: `[apps|partial|M]` "Smarter RSS" (no note). Atlas: 19 votes ("RSS reader"), Vivaldi Feed
Reader inspiration, "Read feeds in a reader view with unread counts, and make a feed from any
page."
- (a) **A working RSS live-folder provider already exists** — `nsRssLiveFolderProvider`
  (src/zen/live-folders/providers/RssLiveFolder.sys.mjs) parses RSS/Atom/RDF feeds (`doc.querySelector("feed
  > entry")` vs `item` detection, :43), has item-limit and time-range filter options (:166-184),
  and derives folder metadata (title, favicon) from the feed itself (`getMetadata`, a static
  method, :186+). What's missing against "smarter": no reader-view rendering of an item
  (opening one just opens its URL as a normal tab), no unread count/badge, and no
  "make a feed from any page" for sites without a discoverable `<link rel="alternate"
  type="application/rss+xml">` (the provider only ever fetches a feed URL you already have —
  there's no feed-autodiscovery step scanning a page's `<head>` for that `<link>` either, which
  is itself a small, separate, easy win worth doing before the "no RSS at all" harder case).
- (b) No open issue/discussion.
- (c) Vivaldi's Feed Reader panel shows unread counts per feed and opens articles in a clean
  reading view rather than a bare tab; people use RSS specifically to scan headlines fast
  without each one costing a full page load, so a reader view and unread state are the point,
  not polish.
- (d) Layered on the existing provider, no new provider needed:
  1. **Autodiscovery** (cheap, do first): when adding a feed, if the given URL isn't already a
     feed, fetch it as HTML and look for `<link rel="alternate" type="application/rss+xml"
     href>`/`type="application/atom+xml"`, same DOMParser approach `RssLiveFolder.getMetadata`
     already uses to pull a feed's own title/favicon.
  2. **Unread counts**: track `{ folderId, seenGuids: Set }` in Whimsy's own JSONFile, updated
     whenever the folder's tabs (its items) are opened (reuse the manager's `onLiveFolderFetch`
     event hook, wrapping it the way `WhimsyGithubReviews` wraps `fetchItems`) — unread = items
     not in `seenGuids`; render a count badge on the folder, same badge mechanics Zen already
     uses elsewhere (downloads badge, `zen-library-download-badge` pattern in
     `ZenLibraryWidget.sys.mjs`).
  3. **Reader view on open**: intercept opening an RSS folder's item tab and navigate it to
     `about:reader?url=<item.url>` instead of the raw URL directly — Firefox's reader mode
     already handles the fetch/Readability pass; this just skips the "is this an article"
     detection for feed items, since a feed item is already known to be read-oriented content.
  4. **"Make a feed from any page" without RSS**: queue's own item `[ai|new|M]` "Feed from any
     page" (tagged `ai`, not `apps`) is the AI-powered version of this and belongs to the AI
     batch, not here — don't build it as part of Smarter RSS; the two are related asks the
     atlas separated for a reason (one needs a model, one doesn't).
  Test: autodiscovery on a page with a `<link rel="alternate">` finds the right feed URL;
  opening a new item marks it seen and the badge count drops by one; a feed with no unseen
  items shows no badge; an item opens into `about:reader`, not a raw tab.

---

## Native-code flags
None. Every provider here (Jira confidently, Linear pending the auth-method check) runs on the
existing `nsZenLiveFolderProvider`/`fetch()`/`registry` JS infrastructure. Push refresh's
conditional-GET and the "Push" menu entry are both pure JS wraps over public methods — the only
genuine constraint found is that `#intervalOptions` being a true private method rules out
patching it directly, not a native-code gap.
