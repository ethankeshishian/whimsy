# W24 passkey account-tab routing

Firefox references below are to the read-only source in
`~/Repos/whimsy/engine`; this worktree has no engine directory.

## Root cause and complete routing chain

- `browser/components/extensions/parent/ext-tabs.js:711` handles both background
  and action-popup `tabs.create`. At :740 it supplies the extension principal;
  only `cookieStoreId` supplies `userContextId`. At :616/:758 extension URLs get
  their own extension principal. At :816 it calls `gBrowser.addTab`.
- `src/browser/components/tabbrowser/Tabbrowser-sys-mjs.patch:357` runs site
  routing before container assignment (:367–371). Zen's
  `src/zen/spaces/ZenSpaceManager.mjs:3383` previously returned undefined for
  addon principals without an explicit container. Gecko consequently created
  the tab in container 0 rather than the invoking space's profile.
- **The deterministic jump is WhimsyIsolation**, not extension visibility:
  `src/zen/whimsy/WhimsyIsolation.sys.mjs:192` observes workspace assignment;
  :222–235 defers fresh-tab repair; :302–310 moves the selected tab and follows
  its space. `homeFor` (:375–384) picks the active matching-profile space or
  **the first matching space**. Container-0 account tabs opened from another
  profile therefore repeatedly land in the same default-profile space.
- Explicit stores are validated in `toolkit/components/extensions/parent/ext-tabs-base.js:2564`.
  Zen's optional force-container-workspace branch (:3400 onward in
  ZenSpaceManager) additionally picks a uniquely matching space. Its shipped
  default is false (`prefs/zen/workspaces.yaml:11`); isolation still applies.
- `tabs.update` (`ext-tabs.js:879–929`) navigates the existing browser and only
  selects it for active:true (or implicit highlighted selection). Selection
  reaches `ZenSpaceManager.onBeforeTabSelect:2607`, revealing that tab's space.
  Reuse never creates a new container or migrates existing cookies.
- `windows.create` (`ext-windows.js:218,384–402,462`) passes a container through
  window arguments, then uses tabbrowser's initial-tab path. ZenSpaceManager
  places the initial tab at :1042 and routes it at :1051. It bypasses addTab
  for that first tab; the new window patch supplies the source profile/space.
- Site rules: `ZenSpaceRoutingManager.sys.mjs:455` matches all URLs, with the
  external fallback only for fromExternal; :409 moves/follows routed tabs.
  `ZenSpaceRoutingNavigation.sys.mjs:71–117` handles initial HTTP(S) redirects;
  :121–160 opens routed replacements for in-place navigations.
- Profiles are container IDs (`WhimsyProfiles.sys.mjs:123`).
  `WhimsySpaceExtensions.sys.mjs:219–275` restricts API/content-script access,
  never moves tabs. “Keep apps in their own space” is the separate MCP-agent
  path (`WhimsyOutsideAgents.sys.mjs:359`, `WhimsyClaude.sys.mjs:1200`), not WebExtensions.

## Behavior and evidence

Implicit extension tabs/windows inherit the invoking space/profile before
isolation runs. User site rules win. Explicit cookieStoreId remains explicit
and therefore opens in that profile's space; active reuse reveals the existing
space, while background reuse stays put. This preserves cookie isolation.

`browser_whimsy_passkey_extension.js:206` exercises both account URL types,
both profiles, force-routing off/on, explicit stores, reuse, content scripts,
normal/popup windows, and rule precedence. Without the fix, implicit-profile
and unchanged-space assertions fail by the source chain above. Static syntax
and isolated patch-application checks passed. No browser tests/builds ran.
The real 1Password account flow was not captured, so attribution to its exact
API call remains unconfirmed; the faulty browser mechanism is established.
