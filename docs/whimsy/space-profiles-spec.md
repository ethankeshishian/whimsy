# Whimsy Space Profiles Specification

> Approved model, unchanged: Zen containers act as Arc profiles inside ONE
> Firefox profile and ONE Firefox Account; everything syncs; a new profile
> starts fresh like Arc. Section 0 lists what the first draft got wrong about
> the code (verified 2026-10-30 against Firefox 159 / Zen); the sections
> below are already corrected.

## 0. Corrections to the first draft (verified against the code)

| Draft claim | What the code actually does | Consequence |
| --- | --- | --- |
| A Firefox Sync `containers` engine syncs containers | No such engine (`services/sync/modules/engines/`: addons, bookmarks, clients, extension-storage, forms, history, passwords, prefs, tabs). Zen's own Spaces sync (`ZenSpacesSyncModel`) carries `container` records keyed by a synced guid (`builtin-1..4` for Firefox's four, a generated uuid otherwise) and maps them to each device's local `userContextId` | `userContextId`s differ between devices. Anything synced is keyed by the **profile key**: `"default"` for 0, otherwise `ZenSpacesSyncModel.guidForContextId(id, {create: true})` |
| `login.unknownFields = { whimsyProfileId }` in `LoginInfo.sys.mjs` | `unknownFields` is a JSON **string** of extra top-level record fields. The JSON store (`storage-json`) keeps it encrypted; the sync engine spreads its keys into the uploaded record and folds unknown incoming keys back in. Changing only `unknownFields` does **not** bump `syncCounter` (not in `SYNCABLE_LOGIN_FIELDS`). The Rust store (`signon.storage.rust.active`, off on Whimsy's `release` channel) does not expose `unknownFields` to JS at all | Tag = top-level field `whimsyProfile` (a profile key), merged into the existing JSON. Tag new logins right after `addLogin` (still unsynced, so the first upload carries it). Re-tagging an already-synced login only uploads with its next syncable change. A local sidecar `whimsy-login-profiles.json` (guid → key) backs the tag on either store; with the Rust store the tag is local-only |
| Hook `LoginManagerParent#onShowDoorhanger` / patch `LoginInfo.sys.mjs` | Private `#` methods can't be wrapped. Every lookup goes through the static `LoginManagerParent.searchAndDedupeLogins(formOrigin, …)`, called by the public instance methods `sendLoginDataToChild`, `doAutocompleteSearch`, `showDoorhanger`, `_onPasswordEditedOrGenerated` with the same `formOrigin` | No engine patch: wrap those four to register `formOrigin → profile` for the call's duration, and filter in a wrapped `searchAndDedupeLogins`. Two different profiles on the same origin at the same instant fall back to showing nothing (never the other profile's login) |
| `WhimsySpaceHistory` stores `{ visitId, spaceId, timestamp }` | Stores `{ id, time, guid, spaceId, spaceName }` keyed by visit id, only when the navigation snapshots agree on one space; Places owns the visits; the sidecar is local (not synced) | Records also get `profile` (the tab's own container, as a key) and `url`. History filtering is a view filter, never isolation. Visits synced from other devices or from before profiles carry no profile and belong to Default |
| Zen essentials per container via `ZenSpaceBookmarksStorage.js` | Separate essentials are Zen's `zen.workspaces.separate-essentials` pref (Zen's yaml default is **on**; the code's `false` is only a fallback; read once per window). Essentials are pinned tabs whose `usercontextid` decides the strip; `ZenSpaceBookmarksStorage` has nothing to do with it | Nothing to change: Essentials are already per container, i.e. per profile. Existing essentials live in container 0, i.e. Default |
| `SearchService` / `DownloadIntegration` can return per-tab values | Both are global and get no tab/window context | Per-profile values are applied to the global pref/engine while that profile's space is in the front window, and the user's own choice is restored for Default |
| Content-script blocking needs `ExtensionContent.sys.mjs` patched | C++ (`ExtensionPolicyService::ProcessScript()`) calls `ExtensionProcessScript.loadContentScript` on the exported JS object through XPConnect, which looks the method up on each call | A Whimsy process script wraps `loadContentScript` in every content process to skip scripts of extensions restricted from the page's container. Also: `Extension.userContextIsolation` is snapshotted at extension start, so Whimsy sets `extensions.userContextIsolation.enabled` as a default and refreshes running extensions |
| Zen's space editor needs "renaming container references" | Zen already shows **Profile** in the new-space form and **Set Profile** in the space menu (`context_zenWorkspacesOpenInContainerTab`), backed by containers. Changing it only updates `containerTabId`; open tabs keep their old container | Reuse both. Whimsy adds "Create a New Profile…" to both lists, Arc's warning, and reopens the space's tabs in the new container so the move really happens |
| `gBrowser.changeTabContextId` | Doesn't exist. Firefox's "Reopen in Container" adds a new tab with the target `userContextId` and a principal re-keyed to it | Same technique, keeping space, pinned/essential state and position |

## 1. Architecture

- A **Profile** is a public Contextual Identity plus the implicit **Default** (`userContextId` 0). `WhimsyProfiles.sys.mjs` is the facade.
- A **Space** belongs to one profile (`workspace.containerTabId`); a profile has many spaces.
- A new profile is a new container: no cookies, storage, cache, passwords, history or essentials.
- Profiles and space assignments sync via Zen's Spaces sync; passwords via Firefox's passwords engine (with the tag); Whimsy's per-profile settings sync as prefs keyed by profile key (except download folders, which are per Mac).

## 2. Per-property behaviour

### 2.1 Cookies, cache, site storage — real isolation
Gecko partitions all of it by `userContextId`. Tabs opened in a space use its container (Zen).

### 2.2 Passwords — scoped autofill and save prompts
- Profile of a login = `whimsyProfile` in `unknownFields`, else the sidecar, else `"default"` (legacy logins stay in Default).
- Autofill, autocomplete and the "update password?" match only see logins of the page's profile; a save prompt in profile B never offers to update A's login.
- New logins saved from a page get that page's profile.
- Honest limit: the logins still sit in one store; about:logins shows all of them.

### 2.3 History — filtered per profile (a view, not isolation)
- Address bar: history results (Places, input history, autofill, history heuristic) for URLs never visited in the current profile are hidden; Default also shows unattributed history.
- Library → History: "This Profile" filter next to the space filter.

### 2.4 Essentials — per profile
`zen.workspaces.separate-essentials` (on by default in Zen): spaces in one profile share its Essentials strip; moving a space changes which strip it shows.

### 2.5 Per-profile search engine and download folder
- `whimsy.profiles.search-engines` (JSON, key → engine id, synced) and `whimsy.profiles.download-dirs` (JSON, key → path, not synced).
- Applied while that profile's space is frontmost; leaving restores the user's own default. Honest limit: a download started from a background window's tab follows the front window's profile.

### 2.6 Extensions — run in chosen profiles
- `whimsy.profiles.extensions` (JSON, extension id → list of profile keys; missing = all profiles). Replaces "Show in Spaces" (old space lists migrate to the profiles of those spaces).
- Enforced: `extensions.userContextIsolation.<id>.restricted` (tabs, webNavigation, webRequest, proxy) and content scripts (process script). Toolbar button and panel row hidden in other profiles' spaces.
- Honest limit: one install, one background page, one `storage.local` shared by every profile. The UI says "Run in Profiles", never "separate extension data".

### 2.7 Downloads
See 2.5.

## 3. Cross-profile moves and Mini Whimsy

- **Space to another profile** (Set Profile): Arc's warning — *"Each Profile has different browser data, so you might get logged out of some websites, see different Favorites up top, or need to re-install extensions."* — then its tabs reopen in the new container. Nothing migrates.
- **Tab to a space in another profile** (Move to Space, drag): *"This tab will reopen in the “B” profile, so this webpage might look a little different."* — then it reopens in the target container.
- **Mini Whimsy**: the profile pill in the bar shows the page's profile; clicking it lists profiles; picking one reopens the page in that profile. "Open in <Space>" lists spaces of the page's profile first; adopting into another profile's space reopens it there.

## 4. UI (Arc terms)

- Space menu **Set Profile** (Zen) and the new-space **Profile** list end with **Create a New Profile…**.
- Creating asks for a **Profile Name** inline; duplicates: *"A Profile with that name already exists."*
- Settings → Tab Management → **Profiles**: one row per profile (name, spaces count, Rename, Search Engine, Default Download Location, Delete this Profile); **Create a New Profile…**, **Delete Unused Profiles**. Default can't be renamed away or deleted; a profile with spaces can't be deleted (*"Only Profiles not assigned to any Spaces can be deleted."*, shown as text). Deleting asks first and removes its site data and saved passwords.

## 5. Migration

- Container 0 is **Default** and keeps everything: cookies, logins (untagged → Default), history, essentials, extensions (allowed everywhere).
- Existing containers (Personal, Work, Banking, Shopping, and any made by the user) are profiles; spaces keep their `containerTabId`.
- "Show in Spaces" lists become profile lists. One-time, recorded in `whimsy.profiles.migrated`.
- A space whose container vanished falls back to Default (Zen already resets it) with a toast naming the space.

## 6. Phases (each shippable)

1. Profile model + UI: `WhimsyProfiles`, Create/Rename/Delete, Set Profile + new-space list, Settings → Profiles, migration. Essentials are already per container in Zen. Cookies/storage already isolated by containers.
2. Passwords scoped per profile (+ sync tag, sidecar).
3. History filtered per profile (address bar + Library).
4. Per-profile search engine and download folder.
5. Extensions per profile (replaces "Show in Spaces"), content-script blocking.
6. Move warnings (space, tab) with real re-containering.
7. Mini Whimsy profile switcher.

## 7. Tests
A mochitest per phase in `src/zen/whimsy/tests/` (`browser_whimsy_profiles*.js`), including a Sync round-trip of the password tag through `PasswordEngine`'s store, and light/dark screenshot cases for the profile UI in `browser_whimsy_screens.js`.
