# Whimsy Space Profiles Specification

## 1. Executive Summary & Architecture Model

Whimsy implements Arc-parity **Profiles** on top of Gecko **Contextual Identities (Containers)** inside **one Firefox Profile** and **one Firefox Account (FxA)**. Multiple processes and distinct toolkit profile directories (rejected Option B) are avoided: everything—Spaces, tabs, history, passwords, and containers—lives within a single Gecko instance and syncs seamlessly across devices.

In this model:
- A **Profile** is an abstracted Contextual Identity (`userContextId`) that provides data isolation.
- A **Space** belongs to exactly one Profile (`workspace.containerTabId`), but one Profile can host many Spaces.
- A new Profile starts clean (fresh container `userContextId`): zero shared cookies, storage, cache, or auto-inherited logins.
- Profiles sync via standard Firefox Sync engines (passwords, history, bookmarks, containers) and Zen Space sync.

---

## 2. Gecko/Zen Property Mapping & Single-Account Sync

### 2.1 Cookies, Cache & Site Storage
* **Gecko/Zen Mapping:** Direct 1:1 mapping to `userContextId` (`originAttributes.userContextId`). Tabs in a Space automatically execute under its Profile container.
* **Zen Hooks:**
  * `src/zen/spaces/ZenSpaceManager.mjs`: `getActiveWorkspace().containerTabId` supplies `userContextId`.
  * `src/zen/spaces/ZenSpaceCreation.mjs`: Assigns `workspace.containerTabId = profileId`.
  * `engine/toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs`: Manages identity allocation and metadata.
* **Sync Strategy:** Standard Firefox Sync `containers` engine syncs container IDs and names across devices. Zen's `src/zen/sync/ZenSpacesSyncApplier.sys.mjs` and `ZenSpacesSyncModel.sys.mjs` sync space-to-container bindings.

### 2.2 Saved Passwords & Form Autofill
* **Gecko Limitation:** Gecko's `LoginManager` (`logins.json`) keys credentials globally by origin, ignoring container identity.
* **Profile Scoping & Tagging:**
  * Tag every saved login with `whimsyProfileId` (the container `userContextId`).
  * In `engine/toolkit/components/passwordmgr/LoginInfo.sys.mjs`, assign `login.unknownFields = { whimsyProfileId }`. Because `unknownFields` is a standard property round-tripped by `engine/services/sync/modules/engines/passwords.sys.mjs` (`VALID_LOGIN_FIELDS`), profile tags sync natively across Whimsy instances without breaking stock Firefox Sync clients.
  * Supplement locally with a fallback sidecar map (`whimsy-login-profiles.json`) keyed by login `guid`.
* **Filtering & Prompt Hooks:**
  * `engine/toolkit/components/passwordmgr/LoginManagerParent.sys.mjs`:
    * Intercept `PasswordManager:findLogins` and `PasswordManager:autoCompleteLogins`. Filter returned logins matching `this.browsingContext.originAttributes.userContextId`.
    * In `#onShowDoorhanger`, stamp the active tab's `userContextId` onto the candidate `nsILoginInfo` before saving.
    * Legacy/unlabeled logins default to the "Default" profile (`userContextId: 0`).

### 2.3 Browsing History & URL Bar Filtering
* **Current Foundation:** Whimsy's `src/zen/whimsy/WhimsySpaceHistory.sys.mjs` already intercepts `page-visited` events from `PlacesUtils` and records `{ visitId, spaceId, timestamp }` in `whimsy-space-history.json`.
* **Profile Mapping:** Since each Space maps to a Profile (`containerTabId`), visit history is resolved to its originating Profile via `ZenSpaceManager.getWorkspaceById(spaceId).containerTabId`.
* **URL Bar & Library Scoping:**
  * `src/zen/whimsy/content/whimsy-library-space-history.mjs`: Filter history queries by active Profile or allow toggling "All Profiles".
  * `engine/browser/components/urlbar/UrlbarProviderPlaces.sys.mjs`: Add a query filter matching visits associated with the active window/space Profile.
* **Sync Strategy:** Global URLs/visits sync via standard Firefox Sync `history` engine. The lightweight sidecar mapping syncs via Whimsy's sidecar sync or derives Profile from synced space definitions.

### 2.4 Favorites / Essentials
* **Gecko/Zen Mapping:** In Arc, Favorites are pinned tabs shared across all Spaces assigned to that Profile. Zen already implements container-scoped essentials.
* **Zen Hooks:**
  * `src/zen/spaces/ZenSpaceManager.mjs`: `getEssentialsSection(workspace.containerTabId)` and line 2152 already toggle essential tab strips matching `containerTabId`.
  * `src/zen/spaces/ZenSpaceBookmarksStorage.js`: Persists essentials per `userContextId`.
* **Behavior:** All Spaces linked to Profile X automatically display Profile X's Essentials strip. Changing a Space's Profile immediately updates the displayed Essentials.

### 2.5 Per-Profile Settings (Search Engine & Auto-Archive)
* **Search Engine:**
  * Pref: `whimsy.profile.<id>.search-engine`.
  * Hook: `engine/toolkit/components/search/SearchService.sys.mjs` and `engine/browser/components/search/BrowserSearch.sys.mjs`. When `SearchService.defaultEngine` is queried for a tab, resolve the active tab's `userContextId` and return the profile-specific engine; fall back to global default.
* **Auto-Archive / Tab Lifespan:**
  * Pref: `whimsy.profile.<id>.tab-archive-duration`.
  * Hook: `src/zen/whimsy/WhimsySpaceArchive.sys.mjs` checks the profile duration when archiving stale tabs in that space.

### 2.6 Extensions Isolation & Scope
* **Honest Limitation:** Because all extensions run in a single Gecko process, background scripts and `browser.storage.local` are physically shared across the install. True separate storage partitions do not exist without multi-process BrowserContext refactoring.
* **Profile-Scoped Execution:**
  1. **UI Visibility:** `src/zen/whimsy/WhimsySpaceExtensions.sys.mjs` shows/hides toolbar buttons and panel menu entries based on the active Space's Profile.
  2. **API Isolation:** Configure `extensions.userContextIsolation.<id>.restricted` (`engine/toolkit/components/extensions/Extension.sys.mjs:canAccessContainer`). Prevents `tabs`, `webRequest`, `webNavigation`, and `proxy` APIs from seeing or intercepting tabs in non-assigned profiles.
  3. **Content Script Blocking:** Hook `engine/toolkit/components/extensions/ExtensionContent.sys.mjs#injectInto` (and `ExtensionProcessScript.sys.mjs#loadContentScript`) to check `extension.canAccessContainer(window.docShell.getOriginAttributes().userContextId)`. Content scripts are blocked from injecting into documents outside assigned profiles.
  4. **Settings UI:** Label honestly: "Run extension in this Profile" (never falsely claiming isolated extension storage).

### 2.7 Downloads
* **Gecko Hook:** `engine/toolkit/components/downloads/DownloadIntegration.sys.mjs#getPreferredDownloadsDirectory`.
* **Behavior:** Check active tab's `userContextId`. If `whimsy.profile.<id>.download-dir` is defined, return that directory instead of global `browser.download.dir`.
* **Downloads Panel:** Download items tag `userContextId` to enable filtering by active Profile.

---

## 3. Cross-Profile Lifecycle & Little Arc

### 3.1 Moving Spaces Across Profiles
* Triggered in Space Settings / context menu ("Edit Space profile").
* **Confirmation Warning (Arc parity):**
  > *"Each Profile has different browser data, so you might get logged out of some websites, see different Favorites up top, or need to re-install extensions."*
* **Action:** Upon confirmation, update `workspace.containerTabId` in `ZenSpaceManager`. Unpinned and pinned tabs update their `userContextId` and reload. No cookies or storage migrate.

### 3.2 Moving Tabs Across Profiles
* Triggered by dragging a tab to a Space in another Profile or selecting "Move to Space".
* **Confirmation Warning (Arc parity):**
  > *"...this webpage might look a little different."*
* **Action:** The tab is recreated with the target Profile's `userContextId` (`gBrowser.changeTabContextId(tab, targetUserContextId)`) and reloaded.

### 3.3 Little Arc / Mini Whimsy Profile Switcher
* **UI:** A profile pill in the window header displaying the active Profile name and icon.
* **Interaction:** Clicking opens a dropdown menu to change Profile on the fly. Changing Profile switches the container for the link.
* **Routing Hook:** `src/zen/space-routing/ZenSpaceRoutingManager.sys.mjs` respects the selected profile when opening external links. "Open in [Space]" targets a Space inside that Profile.

---

## 4. UI & Management (Arc Terminology Parity)

Verified via Arc help documentation (`resources.arc.net`):

* **Space Editor & Context Menu:**
  * Space menu item: **"Edit Space profile"**.
  * Dropdown lists all existing Profiles, terminated by **"Create a New Profile"**.
  * Creating a profile prompts:
    * Step 1: **"Profile Name"** (validates: *"A Profile with that name already exists."*).
    * Step 2: Space assignment.
* **Settings → Profiles Pane:**
  * Embedded in `src/browser/components/preferences/whimsy-preferences-head.inc.xhtml`.
  * Lists each Profile with assigned Spaces count.
  * Actions per Profile:
    * **"Profile Name"** (Rename field).
    * **"Search Engine"** (Dropdown).
    * **"Default Download Location"** (Folder picker).
    * **"Delete this Profile"** (Disabled if assigned to any Space; tooltip: *"Only Profiles not assigned to any Spaces can be deleted."*).
    * **"Delete unused Profiles"** (Cleans up unassigned profiles).
    * Default profile rules: *"Default profile cannot be deleted"*.

---

## 5. Migration Strategy

1. **Bootstrap Migration:**
   * Container 0 is automatically labeled **"Default"**.
   * Existing Zen containers (`Personal`, `Work`, `Banking`, `Shopping`) become named Whimsy Profiles.
   * Workspaces keep their existing `containerTabId`.
2. **Backwards Compatibility:**
   * ContextualIdentity DB remains the underlying source of truth.
   * If an assigned profile is ever missing, fallback to Default with the Arc notice:
     *"Arc has reverted to using your Default profile for space(s): <Space Name>"*.

---

## 6. Phased Implementation Roadmap

* **Phase 1: Profile Abstraction & Data Foundation (Shippable)**
  * Implement `WhimsyProfiles.sys.mjs` facade over `ContextualIdentityService`.
  * Rename container references to "Profiles" in Space Editor (`ZenSpaceCreation.mjs`).
  * Enforce Arc deletion rules and "Default" baseline.
* **Phase 2: Password & Settings Partitioning (Shippable)**
  * Add `whimsyProfileId` tagging in `LoginInfo.sys.mjs` and sync via `unknownFields`.
  * Filter autofill and save doorhangers in `LoginManagerParent.sys.mjs`.
  * Implement per-profile search engine and download directory overrides.
* **Phase 3: Extension Scoping & Content Script Isolation (Shippable)**
  * Apply `extensions.userContextIsolation.<id>.restricted` per profile.
  * Intercept `ExtensionContent.sys.mjs` to block content scripts in unauthorized containers.
  * Add extension management per profile in Settings → Profiles.
* **Phase 4: Cross-Profile Interactions & Little Arc (Shippable)**
  * Add Arc confirmation modal when moving spaces or tabs across profiles.
  * Implement Little Arc profile pill and switcher.
  * Finalize history scoping in Library and URL bar.

---

## 7. Test Plan

1. **Isolation Verification:**
   * Log into Google on Profile A ("Work"); navigate to Google on Profile B ("Personal"). Verify Profile B displays clean login page.
2. **Password Manager Scoping:**
   * Save credentials on `example.com` in Profile A. Open `example.com` in Profile B. Verify autocomplete suggestions are empty. Submit form in Profile B with different credentials; verify both persist separately.
3. **Sync Integrity:**
   * Trigger Firefox Sync across two instances. Verify profiles, space bindings, and tagged passwords sync without duplicate or corrupt records.
4. **Extension Boundary:**
   * Enable an extension restricted to Profile A. Verify content scripts do not execute and `tabs` API cannot query tabs in Profile B.
5. **UI & Move Safety:**
   * Reassign a Space to another Profile. Verify Arc warning appears and page reloads with clean state upon confirmation. Verify Default profile cannot be deleted.
