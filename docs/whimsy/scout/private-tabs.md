## Verdict

- **Real private browsing (`originAttributes.privateBrowsingId = 1`) from chrome JS without engine patches:** **Not feasible.** Gecko hard-inherits `usePrivateBrowsing` from the parent chrome window during `nsFrameLoader` attachment and crashes (`MOZ_CRASH()`) if mutated afterward.
- **Real `privateBrowsingId = 1` with a small engine patch:** **Feasible** (~50–70 lines across 4 engine files: [nsFrameLoader.cpp](engine/dom/base/nsFrameLoader.cpp), [ContentParent.cpp](engine/dom/ipc/ContentParent.cpp), [PrivateBrowsingUtils.sys.mjs](engine/toolkit/modules/PrivateBrowsingUtils.sys.mjs), plus [Tabbrowser.sys.mjs](engine/browser/components/tabbrowser/Tabbrowser.sys.mjs) / [SessionStore.sys.mjs](engine/browser/components/sessionstore/SessionStore.sys.mjs)).
- **Chrome-JS-only fallback (what modern Waterfox actually ships):** **Feasible only as a container approximation** (`userContextId` + `useGlobalHistory = false` + `ClearDataService` wipe), **not** `privateBrowsingId = 1`.

---

## How Waterfox Ships "Private Tabs"

- **Legacy (`privateTab@infocatcher` / old Waterfox Classic):** Flipped `docShell.QueryInterface(Ci.nsILoadContext).usePrivateBrowsing = true` in-process before e10s/Fission locked `BrowsingContext` origin attributes.
- **Modern Waterfox (6.6.0+, `BrowserWorks/waterfox` on ESR 140):** Does **not** set `privateBrowsingId = 1` and does **not** patch Gecko's `BrowsingContext` PB inheritance (documented in Waterfox's Private Tabs docs and issue `#3956`, *"Private Tab is not actually a private tab"*). Instead, `PrivateTab.sys.mjs` allocates a shared hidden **"Private container"** (`userContextId`) via `ContextualIdentityService`:
  - All open private tabs share that `userContextId` cookie/storage jar.
  - Suppresses Places/form/urlbar history (`useGlobalHistory = false`, suppresses search/form suggestions, routes searches to the private search engine).
  - Strips private-container tabs from `SessionStore` and wipes the container via `ClearDataService` when the last private tab closes (and on startup for crash leftovers).

---

## Gecko 159 (`engine/`) Checks

### 1. `nsDocShell` & `BrowsingContext` Private Browsing Checks
- [`nsDocShell::SetUsePrivateBrowsing`](engine/docshell/base/nsDocShell.cpp#L1794-L1801) delegates to `mBrowsingContext`. `SetPrivateBrowsing` is `[noscript]` in [nsILoadContext.idl](engine/docshell/base/nsILoadContext.idl#L123); [`BrowsingContext.usePrivateBrowsing`](engine/dom/chrome-webidl/BrowsingContext.webidl#L23-L25) is `[ChromeOnly, SetterThrows]`.
- The old `"Can't change PB mode"` check is now [`BrowsingContext::CanSetOriginAttributes()`](engine/docshell/base/BrowsingContext.cpp#L1817-L1852), called by [`BrowsingContext::SetUsePrivateBrowsing()`](engine/docshell/base/BrowsingContext.cpp#L1923-L1958):
  1. **Before attach:** [`nsFrameLoader::GetExtantBrowsingContext()`](engine/dom/base/nsFrameLoader.cpp#L3437-L3452) returns `nullptr` until `EverAttached()` is true, so JS cannot touch `mPendingBrowsingContext` early.
  2. **During attach:** [`nsFrameLoader::EnsureBrowsingContextAttached()`](engine/dom/base/nsFrameLoader.cpp#L3772-L3844) sets `bool usePrivateBrowsing = parentContext->UsePrivateBrowsing();` from the chrome window (`false`), runs `attrs.SyncAttributesWithPrivateBrowsing(false)` (`mPrivateBrowsingId = 0`), overwrites `SetOriginAttributes(attrs)` + `SetUsePrivateBrowsing(false)`, and attaches.
  3. **After attach:** On an attached content BC, `CanSetOriginAttributes()` hits `if (NS_WARN_IF(IsContent())) { MOZ_CRASH(); }` ([BrowsingContext.cpp](engine/docshell/base/BrowsingContext.cpp#L1831-L1834)) — an unconditional release crash.
  4. **Workarounds blocked:** Flipping the chrome window's own `browsingContext.usePrivateBrowsing` fails once `browser.xhtml` has loaded or has children ([BrowsingContext.cpp](engine/docshell/base/BrowsingContext.cpp#L1837-L1850)). Swapping a browser from a hidden private window fails `ourOriginAttributes.EqualsIgnoringFPD(otherOriginAttributes)` in [`nsFrameLoader::SwapWithOtherRemoteLoader()`](engine/dom/base/nsFrameLoader.cpp#L1248-L1250) and [`Tabbrowser.swapBrowsersAndCloseOther()`](engine/browser/components/tabbrowser/Tabbrowser.sys.mjs#L7592-L7600).

### 2. `<browser>` Element Attributes
- [`nsFrameLoader::PopulateOriginContextIdsFromAttributes()`](engine/dom/base/nsFrameLoader.cpp#L3556-L3583) reads **only** `usercontextid` and `geckoViewSessionContextId`—no attribute exists for `privateBrowsingId`.
- Setting `remoteType="web=^privateBrowsingId=1"` ([nsFrameLoader.cpp](engine/dom/base/nsFrameLoader.cpp#L423-L436)) only picks the initial process; `mPendingBrowsingContext` still gets `mPrivateBrowsingId = 0`, and [`IsolationOptionsForNavigation()`](engine/dom/ipc/ProcessIsolation.cpp#L809) reads `aTopBC->OriginAttributesRef()` and switches back to a non-private process on navigation.
- `initialBrowsingContextGroupId` ([nsFrameLoader.cpp](engine/dom/base/nsFrameLoader.cpp#L351-L372)) only selects a `BrowsingContextGroup` (no `OriginAttributes`). `preloadedState` ([Tabbrowser.sys.mjs](engine/browser/components/tabbrowser/Tabbrowser.sys.mjs#L3338-L3340), [NewTabPagePreloading.sys.mjs](engine/browser/components/tabbrowser/NewTabPagePreloading.sys.mjs#L66-L73)) is matched per `isWindowPrivate(window)`.

### 3. `gBrowser.addTab` / `createBrowser` & `E10SUtils`
- [`Tabbrowser.addTab()`](engine/browser/components/tabbrowser/Tabbrowser.sys.mjs#L3948-L3989) and [`Tabbrowser.createBrowser()`](engine/browser/components/tabbrowser/Tabbrowser.sys.mjs#L3283-L3358) accept `userContextId`, `remoteType`, `initialBrowsingContextGroupId`, and C++-only `[builtinclass]` [`nsIOpenWindowInfo`](engine/toolkit/components/windowwatcher/nsIOpenWindowInfo.idl#L43-L44)—never `originAttributes` or `privateBrowsingId`.
- [`E10SUtils.sys.mjs`](engine/toolkit/modules/E10SUtils.sys.mjs#L25-L78) only holds constants/serializers; process prediction lives in [`ChromeUtils::PredictRemoteTypeForURI()`](engine/dom/base/ChromeUtils.cpp#L3047-L3055), which accepts `privateBrowsingId` in WebIDL options, but [`Tabbrowser._insertBrowser()`](engine/browser/components/tabbrowser/Tabbrowser.sys.mjs#L5021-L5028) only passes `{ window, userContextId }`, falling back to `aOptions.mWindow->IsPrivateBrowsing()`.

### 4. Window-Level Assumptions in Toolkit, Tabbrowser, SessionStore, and IPC
- **`PrivateBrowsingUtils` bottleneck:** [`PrivateBrowsingUtils.isBrowserPrivate(aBrowser)`](engine/toolkit/modules/PrivateBrowsingUtils.sys.mjs#L35-L47) ignores `aBrowser` whenever `chromeWin.gMultiProcessBrowser` is true (always in e10s) and returns `this.isWindowPrivate(chromeWin)`. ~40 callers (`PermissionUI`, `LoginManagerParent`, `RemoteWebNavigation`, `URILoadingWrapper`, `nsContextMenu`, `ContentSearchParent`, `PageThumbs`, WebExtensions `ext-tabs.js`) misclassify the tab as non-private unless patched.
- **IPC popup kill:** When a `privateBrowsingId=1` tab opens `<a target="_blank">` or `window.open()` into the same normal window, [`ContentParent::RecvCreateWindow()`](engine/dom/ipc/ContentParent.cpp#L5637-L5647) enforces `aOriginAttributes.EqualsIgnoringFPD(newBC->OriginAttributesRef())` and `thisTabBC->UsePrivateBrowsing() == newBC->UsePrivateBrowsing()`, firing `IPC_FAIL` (killing the child process) if the newly opened tab gets `privateBrowsingId = 0`.

---

## Minimal Patch Required for Real `privateBrowsingId = 1`

1. **[nsFrameLoader.cpp](engine/dom/base/nsFrameLoader.cpp#L3780-L3840) (~18 lines):** In `EnsureBrowsingContextAttached()` (and `PopulateOriginContextIdsFromAttributes`), set `usePrivateBrowsing = true` when `mOwnerContent->GetBoolAttr(nsGkAtoms::privatebrowsing)` or `mOpenWindowInfo->GetOriginAttributes().mPrivateBrowsingId > 0`, and relax the `EverAttached()` `MOZ_DIAGNOSTIC_ASSERT` accordingly.
2. **[ContentParent.cpp](engine/dom/ipc/ContentParent.cpp#L1364-L1366) (~2 lines):** Check `aBrowsingContext->UsePrivateBrowsing()` when setting `CHROME_PRIVATE_WINDOW` in `CreateBrowser()`.
3. **[PrivateBrowsingUtils.sys.mjs](engine/toolkit/modules/PrivateBrowsingUtils.sys.mjs#L35-L47) (~5 lines):** Make `isBrowserPrivate(b)` check `b.browsingContext?.usePrivateBrowsing || b.getAttribute("privatebrowsing") === "true" || this.isWindowPrivate(chromeWin)`.
4. **[Tabbrowser.sys.mjs](engine/browser/components/tabbrowser/Tabbrowser.sys.mjs#L5021-L5055) & [SessionStore.sys.mjs](engine/browser/components/sessionstore/SessionStore.sys.mjs#L6044-L6051) (~25 lines):** Accept `isPrivate` / propagate `openWindowInfo.originAttributes.privateBrowsingId`, pass `privateBrowsingId: 1` to `predictRemoteTypeForURI`, set `privatebrowsing="true"` on `<browser>`, and skip `tabData.isPrivate` tabs in `#collectWindowData`.

---

## Pitfalls

- **Session restore:** [`SessionStore.#collectWindowData()`](engine/browser/components/sessionstore/SessionStore.sys.mjs#L6026-L6051) saves **all** open tabs of a `!winData.isPrivate` window to `sessionstore.jsonlz4`—even when [`ContentSessionStore`](engine/toolkit/components/sessionstore/SessionStoreListener.cpp#L50-L54) sets `tabState.isPrivate = true` (only `#maybeSaveClosedTab` at [SessionStore.sys.mjs](engine/browser/components/sessionstore/SessionStore.sys.mjs#L3267-L3270) checks `tabState.isPrivate`, and [`undoCloseTab`](engine/browser/components/sessionstore/SessionStore.sys.mjs#L4585-L4591) checks window privateness). Open private tabs must be explicitly filtered from disk saves.
- **History:** [`nsDocShell`](engine/docshell/base/nsDocShell.cpp#L12850) skips Places visits when `UsePrivateBrowsing()` or `!GetUseGlobalHistory()`, **but** urlbar adaptive/form history, search suggestions, and [`URILoadingWrapper`](engine/browser/components/tabbrowser/Tabbrowser.sys.mjs#L11420-L11422) check `isWindowPrivate(window)` / `isBrowserPrivate(browser)` and will leak typed queries unless tab-aware.
- **Downloads:** Channel downloads read `NS_UsePrivateBrowsing(channel)` ([nsExternalHelperAppService.cpp](engine/uriloader/exthandler/nsExternalHelperAppService.cpp#L1487) → `gPrivateBatch` in [DownloadCore.sys.mjs](engine/toolkit/components/downloads/DownloadCore.sys.mjs#L416)), which works for `privateBrowsingId=1` (not containers!), whereas "Save Link/Image As" ([nsContextMenu.sys.mjs](engine/browser/base/content/nsContextMenu.sys.mjs#L1861)) uses `isBrowserPrivate` and [DownloadsTaskbar.sys.mjs](engine/browser/components/downloads/DownloadsTaskbar.sys.mjs#L315) checks `isWindowPrivate`.
- **Permissions:** [`PermissionManager`](engine/extensions/permissions/PermissionManager.cpp#L1997-L2007) forces `EXPIRE_SESSION` for `privateBrowsingId != 0`, while [`PermissionUI.sys.mjs`](engine/browser/modules/PermissionUI.sys.mjs#L1482-L1500) gates prompt scope/labels on `isBrowserPrivate`. **Critical container pitfall:** permissions strip `userContextId`, so grants in a Waterfox-style private container leak permanently into normal browsing!
- **Cache & PB teardown:** `privateBrowsingId=1` uses memory-only cache ([LoadContextInfo.cpp](engine/netwerk/base/LoadContextInfo.cpp#L62-L69)) and [`CanonicalBrowsingContext`](engine/docshell/base/CanonicalBrowsingContext.cpp#L93-L124) refcounts attached private content BCs to fire `"last-pb-context-exited"` (wiping the shared PB cookie jar, HSTS, auth/TLS caches). Container approximations write HTTP cache to disk under `userContextId` until [`ClearDataService`](engine/toolkit/components/cleardata/ClearDataService.sys.mjs#L2198-L2288) purges it.
