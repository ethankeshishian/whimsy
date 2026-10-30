# Extension isolation: decision needed

Gecko can fully separate extensions in **separate Firefox profiles**, each
with its own browser process and profile directory: independent extension
installs, storage.local/IndexedDB, cookies/site data, background pages/workers,
content-script registration and webRequest listeners. Extensions can still
communicate through external services or native messaging. Sync can copy
settings between profiles when deliberately enabled.

A Zen space is not a Firefox profile. Containers partition website cookies,
logins and site storage; they do not instantiate separate copies of an
extension. Extension storage and background execution remain shared within
the profile. Content scripts can still run wherever host permissions allow.

Current Whimsy hides extension buttons/rows by space. Its existing
userContextIsolation preferences restrict tabs/webNavigation/webRequest/proxy
access for excluded, nonzero containers. They do not isolate extension
storage, cookies API access, background execution or content scripts. Shared
containers cannot distinguish spaces; default-container spaces have no such
restriction. This patch adds no isolation mechanism.

Options (planning estimates, not commitments):

1. **Keep visibility controls:** small maintenance cost; current behavior,
   no Arc-style profile isolation. Finish runtime testing before release.
2. **Map spaces to separate profile windows:** medium cost (weeks plus QA).
   Real isolation using existing Gecko profiles; route links and switch/focus
   the appropriate window. Costs more memory and loses single-window space
   switching. Extension installs/settings become independent.
3. **One window spanning isolated profiles:** very high cost (months+).
   Requires substantial Gecko/process, extension API, storage and session
   architecture work; compatibility/security review and ongoing fork upkeep.
   Not an overlay-sized change.

Sources: [Firefox profiles](https://support.mozilla.org/en-US/kb/profile-management),
[containers](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/contextualIdentities).
Engine audit: Extension.sys.mjs (canAccessContainer), ExtensionStorageIDB.sys.mjs,
WebRequest.sys.mjs and ProxyChannelFilter.sys.mjs.
