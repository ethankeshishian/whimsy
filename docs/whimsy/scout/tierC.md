# Tier C scout: shared implementation batches

Read-only research, 2026-10-29. Paths are relative to the repository. Engine milestone is **159.0** (`engine/config/milestone.txt`). No edits, builds, tests, or commits performed. BUILD-PLAN user answers take precedence.

## 1. AI: one provider and capability layer

**(a) Exists.** `src/zen/whimsy/WhimsyAI.sys.mjs` implements `whimsy.ai.blocked`: snapshots/restores preferences, calls Firefox feature `block()` methods, disables ML and extension ML, and leaves translations available. It covers chatbot, link-preview key points, smart tab groups, PDF alt text, Smart Window, and speech recognition.

Firefox includes:

- `engine/browser/components/genai/GenAI.sys.mjs`: sidebar **website** providers, including Claude and localhost; this is not a Claude API adapter.
- `engine/toolkit/components/ml/content/EngineProcess.sys.mjs`: local inference infrastructure; there is no `browser/components/ml` directory.
- `engine/browser/components/tabbrowser/SmartTabGrouping.sys.mjs`: existing grouping.
- `engine/browser/components/aiwindow/`: conversations, memories, history/page/tab tools, and `models/openAIEngine.sys.mjs`.

Presence does not mean enabled: `prefs/firefox/ai.yaml` disables Zen’s chatbot/ML defaults; Firefox defaults Smart Window off.

**(b) Original flow.** Select text/page/tabs → request summary, comparison, grouping, or chat → review the result. Arc-style usefulness comes from working on existing browsing context without manual copying.

**(c) Design.** One Whimsy provider service with cancellation, streaming, structured output, capability discovery, and explicit context selection. Settings offers Claude API key, Apple on-device, and Ollama. Store secrets through the password manager, never plaintext prefs. Claude uses its [Messages API](https://platform.claude.com/docs/en/api/overview); Ollama uses the [local API](https://github.com/ollama/ollama/blob/main/docs/api/introduction.mdx). Apple requires a native helper/bridge to [Foundation Models](https://developer.apple.com/foundation-models-framework/), with runtime availability checks.

Prefer Apple for summaries/grouping when available; never silently send local-only work to Claude. Reuse Firefox grouping and context extraction where suitable. Defer individual AI experiences until this foundation exists.

**Risks.** Provider capabilities differ; Firefox ML is not Apple’s model bridge. Prompt injection, token costs, model downloads, and private/other-space context leakage need explicit handling. Current kill switch does not itself cancel future Whimsy provider requests.

**Tests.** Mock all adapters; cover unavailable Apple/Ollama, invalid keys, streaming cancellation, malformed structured output, context limits, private/space boundaries, and kill-switch activation during requests. Assert blocking prevents new requests and cancels active work.

## 2. Claude space: one authorization broker, MCP plus CLI

**(a) Exists.** `src/zen/spaces/ZenSpaceManager.mjs` manages spaces. Automation infrastructure lives in `engine/remote/components/{RemoteAgent,Marionette}.sys.mjs` and `engine/remote/webdriver-bidi/modules/`. BiDi provides browsing-context operations; Remote Agent defaults to localhost and validates Host/Origin during WebSocket setup.

**(b) Original flow.** Claude’s side panel acts across visibly grouped tabs; users can add tabs and grant site permissions. See [Claude’s flow](https://claude.com/claude-in-chrome) and [permissions](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide).

**(c) Design.** Default dedicated **Claude** space; explicit whole-browser setting; persistent activity indicator and Stop button. Build one browser-side broker for tab listing, navigation, page extraction, screenshots, and constrained interaction.

| Interface | Assessment |
|---|---|
| Local MCP server | Best agent discovery and structured tools; requires a securely authenticated browser connection. Prefer stdio-facing MCP. |
| CLI | Useful for scripts and debugging; structured JSON output and identical authorization rules. |
| Both | Recommended: thin clients over the same broker, avoiding divergent permissions. |

BiDi is the preferred automation backend where useful. Marionette’s privileged browser control is broader than required. Neither protocol supplies Zen-space authorization. Do not expose raw automation endpoints as the public agent API: every operation/event must pass browser-side scope checks, including after tabs move spaces. Exclude Scratch/private tabs and privileged URLs by default. Pair clients, revoke capabilities on Stop, and require deliberate approval for consequential actions.

**Risks.** Loopback alone is not authentication. Raw endpoints, arbitrary script execution, stale tab IDs, and unrestricted event streams can bypass space isolation. This delivers behavioral parity, not guaranteed compatibility with Anthropic’s Chrome extension.

**Tests.** Foreign-tab enumeration/access denied; moved-tab handles revoked; private/privileged contexts denied; hostile origins and unpaired clients rejected; Stop cancels queued work; whole-browser permission can be revoked immediately.

## 3. VPN: expose existing IP Protection only after service validation

**(a) Exists.** UI: `engine/browser/components/ipprotection/`. Backend: `engine/toolkit/components/ipprotection/`, notably `IPProtectionService`, `IPPProxyManager`, `IPPAuthProvider`, and `fxa/GuardianClient`. Firefox defaults `browser.ipProtection.enabled=false`, Guardian endpoint `https://vpn.mozilla.org/`, and bandwidth maximum **50 GB** in `engine/browser/app/profile/firefox.js`.

**(b) Original flow.** Sign in → enable browser VPN → inspect quota/location → exclude sites. Mozilla describes it as [free browser protection with a monthly cap](https://support.mozilla.org/en-US/kb/built-in-vpn), distinct from paid, device-wide Mozilla VPN.

**(c) Design.** Reuse the existing panel, account flow, quota, and site exceptions. First establish that Whimsy can obtain entitlement, proxy credentials, and successful protected traffic. Source availability does **not** establish permission or backend acceptance for forks. No live account/service validation was performed.

**Risks.** Guardian rejects invalid tokens or missing entitlements; rollout/account eligibility remains relevant. Per-space VPN is additional channel-level policy work, not a toolbar toggle: global activation, site rules, workers, and shared containers complicate isolation.

**Tests.** Mock auth/quota/proxy failures using existing IP Protection suites; later validate real egress, quota exhaustion, exceptions, private browsing, DNS/WebRTC behavior, and recovery. Report fork eligibility unresolved until demonstrated.

## 4. Email aliases: reuse Relay, offer manual iCloud assistance

**(a) Exists.** Actual integration is `engine/toolkit/components/satchel/integrations/{FirefoxRelay,FirefoxRelayUtils}.sys.mjs`; preferences remain `signon.firefoxRelay.*`. It already obtains Mozilla-account OAuth tokens, creates/reuses masks, accepts terms, and fills fields. Browser tests exist under `engine/toolkit/components/passwordmgr/test/browser/browser_relay_*`.

**(b) Original flow.** Focus signup email field → choose a mask → generate/reuse → fill; later manage forwarding. This avoids exposing the primary address. [Mozilla documents the integrated flow](https://blog.mozilla.org/en/mozilla/protect-your-information-with-email-masks-now-available-in-firefox/).

**(c) Design.** Expose existing Relay controls and verify Whimsy OAuth/service access before claiming support. Handle account-specific quotas from service responses.

For iCloud, no supported general-purpose alias-creation API was identified. Offer “Manage Hide My Email” and deliberate paste/fill of an address created through Apple’s [supported interfaces](https://support.apple.com/en-gb/guide/icloud/mm9d9012c9e8/icloud).

**Risks/tests.** Avoid private iCloud APIs or session scraping. Test expired OAuth, quota exhaustion, disabled masks, field targeting, cancellation, duplicate submissions, and private-mode behavior. Relay fork access remains unverified.

## 5. Per-space extensions: toolbar parity, explicit isolation gap

**(a) Exists.** Space state: `src/zen/spaces/ZenSpaceManager.mjs`; extension UI: `engine/browser/base/content/browser-unified-extensions.js`; toolbar placement: `engine/browser/components/customizableui/CustomizableUI.sys.mjs`.

**(b) Original flow.** Arc associates spaces with profiles; profiles separate browsing state and settings ([Arc documentation](https://resources.arc.net/hc/en-us/articles/19227964556183-Profiles-Separate-Work-Personal-Browsing)). Follow the user’s profile-based parity requirement.

**(c) Design.** Persist extension-button visibility by stable space ID; apply on space switches and refresh the extensions menu consistently. Keep global enablement controls clearly separate.

**Gap/risks.** Hiding buttons does not stop content scripts, background execution, permissions, or shared storage. Actual separation requires distinct Firefox profiles/processes; mapping those into one Zen window is a separate architectural project.

**Tests.** Space switches, multiple windows, extension install/remove, customization mode, restart persistence, and feature-off restoration; explicitly verify hidden extensions still execute.

## 6. Remaining feasibility: separate focused batches

- **Handoff:** Already in `engine/browser/base/content/browser.js` and `engine/widget/cocoa/nsMacUserActivityUpdater.mm`; preserve Apple’s continue-on-device flow, verify Whimsy bundle support and private-tab suppression with two-device tests.
- **Cast:** No complete desktop casting flow identified; `engine/dom/media/` supplies playback, not Chromecast/AirPlay transport—scope receiver discovery and explicit connection separately; test disconnects, DRM, and network permissions.
- **Playlist:** Existing playback/PiP can underpin save → queue → resume; add a URL-based queue, not promised offline downloads; test ordering, expired media URLs, DRM failures, and restart recovery.
- **Speed items:** Downloads (`engine/toolkit/components/downloads/DownloadCore.sys.mjs`), DevTools (`engine/devtools/`), startup (`engine/toolkit/components/startup/`) need separate measured bottlenecks and before/after benchmarks; avoid speculative “faster” switches.
- **iOS:** No iOS app identified here; propose a separate share/send-tab companion first, preserving explicit device selection; risks are signing, account/sync infrastructure, and platform constraints; test pairing, offline delivery, and duplicate suppression.