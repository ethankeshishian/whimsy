"""Whimsy's overlay on top of Zen.

Whimsy keeps Zen's files exactly as upstream ships them. Everything Whimsy
adds lives in Whimsy-owned paths (src/zen/whimsy/, whimsy/, prefs/whimsy/,
locales/en-US/.../whimsy*.ftl, src/**/whimsy-*). The few changes Whimsy needs
inside Zen's files are listed here and applied by this script after every
upstream sync. Each one is idempotent and checked, so syncing never needs a
merge:

- HOOKS insert one line next to an anchor in a Zen file.
- OVERRIDES rewrite settings in surfer.json, mozconfig and package.json.
- PREF_OVERRIDES change the default of a pref Zen already declares.
- HOTFIXES patch Zen bugs, only while the buggy code is still there.
- FALLBACK_STRINGS supply strings Zen uses but no longer ships.
- FEATURES name Whimsy features and how to spot Zen shipping the same thing;
  a superseded feature is switched off so Zen's version wins.

  python3 whimsy/overlay.py apply   # after an upstream sync
  python3 whimsy/overlay.py check   # exit 1 if anything is missing
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (id, file, anchor regex, line to insert, "after" | "before")
HOOKS = [
    ("startup", "src/zen/common/modules/ZenStartup.mjs",
     r"^(\s*)gZenCompactModeManager\.init\(\);\s*$",
     '{indent}ChromeUtils.importESModule("resource:///modules/whimsy/Whimsy.sys.mjs").Whimsy.initWindow(window); // Whimsy hook',
     "after"),
    ("moz-build", "src/zen/moz.build",
     r'^(\s*)"common",\s*$',
     '{indent}"whimsy",  # Whimsy hook',
     "after"),
    ("jar", "src/browser/base/content/zen-assets.jar.inc.mn",
     r"^#include \.\./\.\./\.\./zen/common/jar\.inc\.mn\s*$",
     "#include ../../../zen/whimsy/jar.inc.mn",
     "after"),
    ("browser-strings", "src/browser/base/content/zen-locales.inc.xhtml",
     r"^(\s*)</linkset>\s*$",
     '{indent}<link rel="localization" href="browser/whimsy.ftl"/>',
     "before"),
    ("settings", "src/browser/components/preferences/zen-preferences-links.xhtml",
     r'^<link rel="localization" href="browser/preferences/zen-preferences\.ftl"/>',
     "#include whimsy-preferences-head.inc.xhtml",
     "after"),    # fixC: onboarding look pages (WhimsyWelcome.sys.mjs). ZenWelcome keeps
    # its page list in a closure; this hands it over with Zen's own helpers.
    ("welcome-pages", "src/zen/welcome/ZenWelcome.mjs",
     r"^(\s*)this\.#pages = pages;\s*$",
     '{indent}this.#pages = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyWelcome.sys.mjs").WhimsyWelcome.extendPages(window, pages, { createOption, kNextButton }); // Whimsy hook',
     "after"),
    # batch hover: History hover cards read the row's own visit.
    ("library-history-visit", "src/zen/library/sections/ZenLibraryHistorySection.mjs",
     r'^(\s*)@click=\$\{event => this\.#openVisit\(visit, event\)\}\s*$',
     '{indent}.whimsyVisit=${visit}',
     "before"),
    # batch hover: Quick Look in the Library reads the row's own Download.
    ("library-download-quicklook", "src/zen/library/sections/ZenLibraryDownloadsSection.mjs",
     r'^(\s*)\?pending=\$\{pending\}\s*$',
     '{indent}.whimsyDownload=${download}',
     "before"),
    # wave5: command registry. about:keyboard lists Whimsy's commands in a
    # "Whimsy" group (WhimsyCommands.sys.mjs), so every one can be bound.
    ("kbs-whimsy-commands", "src/zen/kbs/ZenKeyboardShortcuts.sys.mjs",
     r"^(\s*)return keys;\s*$",
     '{indent}keys = await ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCommands.sys.mjs").WhimsyCommands.addKeys(actor, keys); // Whimsy hook',
     "before"),
    # wave6/zap: the zap dust takes the space's gradient colors
    # (WhimsyZapTint tints the captured element before it turns to dust).
    ("zap-tint", "src/zen/boosts/ZenZapDissolve.sys.mjs",
     r"^(\s*)this\.#loadTexture\(captureCanvas\);\s*$",
     '{indent}ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyZapTint.sys.mjs").WhimsyZapTint.tint(ctx, captureCanvas.width, captureCanvas.height); // Whimsy hook',
     "before"),
]

HOTFIXES = [
    {
        "id": "spaces-recreate-missing-empty-tab",
        "file": "src/zen/spaces/ZenSpaceManager.mjs",
        "why": "A removed empty-tab sentinel leaves no close-selection fallback. "
               "In Scratch this selects an Essential and leaves/deletes the space.",
        "old": "      gZenUIManager.testingEnabled &&\n"
               "      this._emptyTab &&\n"
               "      (this._emptyTab.closing || !this._emptyTab.isConnected)\n"
               "    ) {\n"
               "      this._emptyTab = gBrowser.tabs.find(\n"
               '        tab => tab.hasAttribute("zen-empty-tab") && !tab.closing\n'
               "      );\n"
               "    }",
        "new": "      this.#hasFinishedInitialization &&\n"
               "      !this._whimsyRestoringEmptyTab &&\n"
               "      (!this._emptyTab || this._emptyTab.closing || !this._emptyTab.isConnected)\n"
               "    ) {\n"
               "      // Recover the sentinel before workspace selection or tab-close fallback.\n"
               "      this._whimsyRestoringEmptyTab = true;\n"
               "      try {\n"
               "        this.#initializeEmptyTab();\n"
               "      } finally {\n"
               "        this._whimsyRestoringEmptyTab = false;\n"
               "      }\n"
               "    }",
    },
    {
        "id": "spaces-reuse-only-live-empty-tab",
        "file": "src/zen/spaces/ZenSpaceManager.mjs",
        "why": "Empty-tab recovery must not reuse a sentinel still being removed.",
        "old": '      if (tab.hasAttribute("zen-empty-tab") && !tab.pinned) {',
        "new": '      if (tab.hasAttribute("zen-empty-tab") && !tab.pinned && !tab.closing && tab.isConnected) {',
    },
    {
        "id": "library-spaces-defer-resize-write",
        "file": "src/zen/library/sections/ZenLibrarySpacesSection.mjs",
        "why": "Writing an ancestor's width during resize delivery resizes "
               "the observed section again, leaving undelivered notifications.",
        "old": "  #resizeObserver = new ResizeObserver(() => this.#updateLibraryWidth());",
        "new": "  #resizeObserver = new ResizeObserver(() => {\n"
               "    // Change the ancestor's width after resize delivery has finished.\n"
               "    window.requestAnimationFrame(() => {\n"
               "      if (this.isConnected) {\n"
               "        this.#updateLibraryWidth();\n"
               "      }\n"
               "    });\n"
               "  });",
    },
    {
        "id": "library-spaces-copy-group-events",
        "file": "src/zen/library/sections/ZenLibrarySpacesSection.mjs",
        "why": "Connecting pinned tab copies dispatches group events on the real "
               "collapsed pins section, causing an endless card rebuild loop.",
        "old": "    if (this.contains(event.target) || lazy.isLibraryCopy(event.target)) {",
        "new": "    // Group events target the real group and carry the copied tab in detail.\n"
               "    if (\n"
               "      this.contains(event.target) ||\n"
               "      lazy.isLibraryCopy(event.target) ||\n"
               "      lazy.isLibraryCopy(event.detail)\n"
               "    ) {",
    },
    {
        "id": "library-spaces-pins-workspace",
        "file": "src/zen/library/sections/ZenLibrarySpacesSection.mjs",
        "why": "Real pins group events belong to the enclosing workspace; "
               "refresh only that card instead of every space.",
        "old": '    target?.closest?.("[zen-workspace-id]")?.getAttribute("zen-workspace-id") ??\n'
               "    null",
        "new": '    target?.closest?.("[zen-workspace-id]")?.getAttribute("zen-workspace-id") ??\n'
               '    target?.closest?.("zen-workspace")?.id ??\n'
               "    null",
    },
    {
        "id": "library-copy-event-detail-comment",
        "file": "src/zen/library/ZenLibraryUtils.sys.mjs",
        "why": "Group events identify the copied tab through detail, not their target.",
        "old": " * Every copy is marked as it is made, tabs and folders alike, and what has to\n"
               " * be held back are the events a tab or a folder raises about itself, so the\n"
               " * element in hand is the whole answer.",
        "new": " * Every copy is marked as it is made, tabs and folders alike. Check the\n"
               " * event target for events raised on the copy itself, and event.detail for\n"
               " * TabGrouped and TabUngrouped, which are dispatched on the real group.",
    },
    {
        "id": "pinned-tab-null-l10n-arg",
        "file": "src/zen/tabs/ZenPinnedTabManager.mjs",
        "why": "A null isEssential argument makes Fluent drop the whole tab "
               "context menu's labels.",
        "old": "          document.l10n.setArgs(element, { isEssential });",
        "new": "          document.l10n.setArgs(element, {\n"
               "            isEssential: isEssential ? \"true\" : \"false\", // Whimsy hotfix\n"
               "          });",
    },
    # home: Zen links the homepage task replaces (see docs/whimsy/BUILD-PLAN.md).
    {
        "id": "library-footer-donate-to-feedback",
        "file": "src/zen/library/ZenLibrary.mjs",
        "why": "The Library sidebar's footer button opens Zen's donate page; "
               "Whimsy doesn't take donations, so it opens Whimsy's GitHub "
               "issues instead.",
        "old": '        l10nId: "library-footer-donate-button",\n'
               "        command: () => {\n"
               '          window.openTrustedLinkIn("https://www.zen-browser.app/donate", "tab");',
        "new": '        l10nId: "whimsy-library-footer-feedback-button", // Whimsy hotfix\n'
               "        command: () => {\n"
               '          window.openTrustedLinkIn("https://github.com/ethankeshishian/whimsy/issues", "tab");',
    },
    {
        "id": "about-dialog-community-link",
        "file": "src/browser/base/content/aboutDialog-xhtml.patch",
        "why": "Zen's About dialog links to its own site; Whimsy's goes to "
               "its own homepage (about:whimsy) instead.",
        "old": '+              <label is="text-link" href="https://zen-browser.app/about" data-l10n-name="community-exp-mozillaLink"/>',
        "new": '+              <label is="text-link" useoriginprincipal="true" href="about:whimsy" data-l10n-name="community-exp-mozillaLink"/> <!-- Whimsy homepage -->',
    },
    {
        "id": "about-dialog-github-link",
        "file": "src/browser/base/content/aboutDialog-xhtml.patch",
        "why": "Zen's About dialog links to Zen's GitHub repo; Whimsy's "
               "links to Whimsy's issues (feedback).",
        "old": '+            <label is="text-link" href="https://github.com/zen-browser/desktop" data-l10n-name="community-mozillaLink"/>',
        "new": '+            <label is="text-link" href="https://github.com/ethankeshishian/whimsy/issues" data-l10n-name="community-mozillaLink"/>',
    },
    # legacy: the About dialog reads as Whimsy's (legacy audit U3). Mozilla's
    # donation ask and "designed by <vendor>, a global community" go; the
    # credits link to Zen (about:credits) stays. Whimsy's strings come from
    # whimsy.ftl, which the dialog doesn't load by itself. The new linkset
    # hunk adds a line, so later hunks' new-file starts move by one.
    {
        "id": "about-dialog-whimsy-strings",
        "file": "src/browser/base/content/aboutDialog-xhtml.patch",
        "why": "The About dialog only loads brand.ftl and aboutDialog.ftl; "
               "Whimsy's wording lives in whimsy.ftl.",
        "old": "+++ b/browser/base/content/aboutDialog.xhtml\n"
               "@@ -102,10 +102,6 @@\n",
        "new": "+++ b/browser/base/content/aboutDialog.xhtml\n"
               "@@ -34,7 +34,8 @@\n"
               "     />\n"
               " \n"
               '     <html:link rel="localization" href="branding/brand.ftl"/>\n'
               '     <html:link rel="localization" href="browser/aboutDialog.ftl"/>\n'
               '+    <html:link rel="localization" href="browser/whimsy.ftl"/> <!-- Whimsy strings -->\n'
               "   </linkset>\n"
               " \n"
               '   <html:div id="aboutDialogContainer">\n'
               "@@ -102,10 +103,6 @@\n",
    },
    {
        "id": "about-dialog-whimsy-wording",
        "file": "src/browser/base/content/aboutDialog-xhtml.patch",
        "why": "Mozilla's lines read \"Whimsy is designed by Whimsy, a global "
               "community working together to keep the Web open\" "
               "(-vendor-short-name = Whimsy) and \"Want to help? Make a "
               "donation or get involved\" (Mozilla's donation and "
               "contribute pages). The paragraphs keep their ids "
               "(aboutDialog.js unhides contributeDesc) with Whimsy's text; "
               "Fluent drops the links a message doesn't use. One hotfix for "
               "the whole hunk: its last line stops being context, so the "
               "hunk takes the next line as trailing context (git apply "
               "anchors a hunk without trailing context to the end of the "
               "file) and the header's sizes change with it.",
        "old": (
               '@@ -120,12 +116,12 @@\n'
               '           <vbox id="experimental" hidden="true">\n'
               '             <description class="text-blurb" id="warningDesc" data-l10n-id="warningDesc-version"></description>\n'
               '             <description class="text-blurb" id="communityExperimentalDesc" data-l10n-id="community-exp">\n'
               '-              <label is="text-link" href="https://www.mozilla.org/?utm_source=firefox-browser&#38;utm_medium=firefox-desktop&#38;utm_campaign=about-dialog" data-l10n-name="community-exp-mozillaLink"/>\n'
               '+              <label is="text-link" useoriginprincipal="true" href="about:whimsy" data-l10n-name="community-exp-mozillaLink"/> <!-- Whimsy homepage -->\n'
               '               <label is="text-link" useoriginprincipal="true" href="about:credits" data-l10n-name="community-exp-creditsLink"/>\n'
               '             </description>\n'
               '           </vbox>\n'
               '           <description class="text-blurb" id="communityDesc" data-l10n-id="community-2">\n'
               '-            <label is="text-link" href="https://www.mozilla.org/?utm_source=firefox-browser&#38;utm_medium=firefox-desktop&#38;utm_campaign=about-dialog" data-l10n-name="community-mozillaLink"/>\n'
               '+            <label is="text-link" href="https://github.com/ethankeshishian/whimsy/issues" data-l10n-name="community-mozillaLink"/>\n'
               '             <label is="text-link" useoriginprincipal="true" href="about:credits" data-l10n-name="community-creditsLink"/>\n'
               '           </description>\n'
               '           <description class="text-blurb" id="contributeDesc" data-l10n-id="helpus">\n'
               '@@ -144,8 +140,8 @@\n'
        ),
        "new": (
               '@@ -120,13 +117,13 @@\n'
               '           <vbox id="experimental" hidden="true">\n'
               '             <description class="text-blurb" id="warningDesc" data-l10n-id="warningDesc-version"></description>\n'
               '-            <description class="text-blurb" id="communityExperimentalDesc" data-l10n-id="community-exp">\n'
               '+            <description class="text-blurb" id="communityExperimentalDesc" data-l10n-id="whimsy-about-community-exp"> <!-- Whimsy -->\n'
               '-              <label is="text-link" href="https://www.mozilla.org/?utm_source=firefox-browser&#38;utm_medium=firefox-desktop&#38;utm_campaign=about-dialog" data-l10n-name="community-exp-mozillaLink"/>\n'
               '+              <label is="text-link" useoriginprincipal="true" href="about:whimsy" data-l10n-name="community-exp-mozillaLink"/> <!-- Whimsy homepage -->\n'
               '               <label is="text-link" useoriginprincipal="true" href="about:credits" data-l10n-name="community-exp-creditsLink"/>\n'
               '             </description>\n'
               '           </vbox>\n'
               '-          <description class="text-blurb" id="communityDesc" data-l10n-id="community-2">\n'
               '+          <description class="text-blurb" id="communityDesc" data-l10n-id="whimsy-about-community"> <!-- Whimsy -->\n'
               '-            <label is="text-link" href="https://www.mozilla.org/?utm_source=firefox-browser&#38;utm_medium=firefox-desktop&#38;utm_campaign=about-dialog" data-l10n-name="community-mozillaLink"/>\n'
               '+            <label is="text-link" href="https://github.com/ethankeshishian/whimsy/issues" data-l10n-name="community-mozillaLink"/>\n'
               '             <label is="text-link" useoriginprincipal="true" href="about:credits" data-l10n-name="community-creditsLink"/>\n'
               '           </description>\n'
               '-          <description class="text-blurb" id="contributeDesc" data-l10n-id="helpus">\n'
               '+          <description class="text-blurb" id="contributeDesc" data-l10n-id="whimsy-about-no-telemetry"> <!-- Whimsy -->\n'
               '             <label is="text-link" href="https://foundation.mozilla.org/?form=firefox-about" data-l10n-name="helpus-donateLink"/>\n'
               '@@ -144,8 +141,8 @@\n'
        ),
    },
    {
        "id": "about-dialog-privacy-link",
        "file": "src/browser/base/content/aboutDialog-xhtml.patch",
        "why": "Zen's About dialog links its own privacy policy; Whimsy's "
               "privacy note is about:whimsy's Privacy tab.",
        "old": '+        <label is="text-link" class="bottom-link" href="https://www.zen-browser.app/privacy-policy/" data-l10n-id="bottom-links-privacy"/>',
        "new": '+        <label is="text-link" class="bottom-link" useoriginprincipal="true" href="about:whimsy?tab=privacy" data-l10n-id="bottom-links-privacy"/> <!-- Whimsy privacy note -->',
    },
    # legacy: Zen's strings that say "Zen" where they mean this app (legacy
    # audit U5). Fluent rejects a second definition of an id, so whimsy.ftl
    # can't override them; these rewrite the line in Zen's en-US file. Kept
    # as "Zen" on purpose: Zen Mods (Zen's mod store), "Zen's share server",
    # and the about:credits/"built on Zen" credits.
    {
        "id": "zen-string-boost-receive",
        "file": "locales/en-US/browser/browser/zen-boosts.ftl",
        "why": "Says Zen where it means Whimsy.",
        "old": 'zen-boost-receive-title = Add this Boost to Zen?',
        "new": 'zen-boost-receive-title = Add this Boost to Whimsy?',
    },
    {
        "id": "zen-string-share-add-space",
        "file": "locales/en-US/browser/browser/zen-share.ftl",
        "why": "Says Zen where it means Whimsy.",
        "old": 'zen-share-overlay-add-space = Add Space to Zen',
        "new": 'zen-share-overlay-add-space = Add Space to Whimsy',
    },
    {
        "id": "zen-string-share-add-folder",
        "file": "locales/en-US/browser/browser/zen-share.ftl",
        "why": "Says Zen where it means Whimsy.",
        "old": 'zen-share-overlay-add-folder = Add Folder to Zen',
        "new": 'zen-share-overlay-add-folder = Add Folder to Whimsy',
    },
    {
        "id": "zen-string-share-confirm",
        "file": "locales/en-US/browser/browser/zen-share.ftl",
        "why": "Says Zen where it means Whimsy.",
        "old": 'zen-share-confirm-description = Zen uploads a copy of these tabs to the share server',
        "new": "zen-share-confirm-description = Whimsy uploads a copy of these tabs to Zen's share server",
    },
    {
        "id": "zen-string-window-sync",
        "file": "locales/en-US/browser/browser/zen-general.ftl",
        "why": "Says Zen where it means Whimsy.",
        "old": 'zen-window-sync-migration-dialog-message = Zen now syncs windows',
        "new": 'zen-window-sync-migration-dialog-message = Whimsy now syncs windows',
    },
    {
        "id": "zen-string-library-media",
        "file": "locales/en-US/browser/browser/zen-library.ftl",
        "why": "Says Zen where it means Whimsy.",
        "old": 'by showing them in the Zen Library.',
        "new": 'by showing them in the Library.',
    },
    {
        "id": "zen-string-downloads-hide",
        "file": "locales/en-US/browser/browser/zen-library.ftl",
        "why": "Says Zen where it means Whimsy.",
        "old": 'library-downloads-menu-hide =\n    .label = Hide from Zen\n',
        "new": 'library-downloads-menu-hide =\n    .label = Hide from Whimsy\n',
    },
    {
        "id": "zen-string-shortcuts-group",
        "file": "locales/en-US/browser/browser/preferences/zen-preferences.ftl",
        "why": "Says Zen where it means Whimsy.",
        "old": 'zenCKSOption-group-zen-other = Other Zen Features',
        "new": 'zenCKSOption-group-zen-other = Other Whimsy Features',
    },
    # batch3glance: Glance size. Zen hard-codes 80% in the arc animation and
    # in the final width; both read Whimsy's chosen width instead.
    {
        "id": "glance-size-arc",
        "file": "src/zen/glance/ZenGlanceManager.mjs",
        "why": "Glance size (whimsy.glance.size): the opening and closing arc "
               "must animate to the card's real width.",
        "old": "    const widthPercent = 0.8;\n",
        "new": "    const widthPercent = this.whimsyWidthPercent ?? 0.8; // Whimsy hotfix: Glance size\n",
    },
    {
        "id": "glance-size-final",
        "file": "src/zen/glance/ZenGlanceManager.mjs",
        "why": "Glance size (whimsy.glance.size): the card keeps that width "
               "once the opening animation ends.",
        "old": '    this.browserWrapper.style.width = "80%";\n',
        "new": "    this.browserWrapper.style.width = `${(this.whimsyWidthPercent ?? 0.8) * 100}%`; // Whimsy hotfix: Glance size\n",
    },
    {
        "id": "window-sync-restore-events",
        "file": "src/zen/sessionstore/ZenWindowSync.sys.mjs",
        "why": "SessionStore replacement is local to its window; observe its "
               "transaction boundaries before accepting sync events.",
        "old": "const EVENTS = [\n",
        "new": "const EVENTS = [\n"
               "  \"SSWindowStateBusy\", // Whimsy hotfix: local session restore transaction\n"
               "  \"SSWindowStateReady\",\n",
    },
    {
        "id": "window-sync-restore-state",
        "file": "src/zen/sessionstore/ZenWindowSync.sys.mjs",
        "why": "Track restore transactions per window without retaining closed windows.",
        "old": "class nsZenWindowSync {\n",
        "new": "class nsZenWindowSync {\n"
               "  #whimsyRestoringWindows = new WeakSet(); // Whimsy hotfix: local session restore\n",
    },
    {
        "id": "window-sync-local-restore",
        "file": "src/zen/sessionstore/ZenWindowSync.sys.mjs",
        "why": "Restoring a synced window removes cloned tabs and groups. Do not "
               "broadcast those local replacement events or enqueue them for "
               "later, when they would close or unsplit the source window.",
        "old": "    const window = aEvent.currentTarget.documentGlobal ?? aEvent.currentTarget;\n",
        "new": "    const window = aEvent.currentTarget.documentGlobal ?? aEvent.currentTarget;\n"
               "    // Whimsy hotfix: discard restore mutations at emission, before the async queue.\n"
               "    if (aEvent.type === \"SSWindowStateBusy\") {\n"
               "      this.#whimsyRestoringWindows.add(window);\n"
               "      return;\n"
               "    }\n"
               "    if (aEvent.type === \"SSWindowStateReady\") {\n"
               "      this.#whimsyRestoringWindows.delete(window);\n"
               "      return;\n"
               "    }\n"
               "    if (this.#whimsyRestoringWindows.has(window)) {\n"
               "      return;\n"
               "    }\n",
    },
    {
        "id": "glance-closed-window-message",
        "file": "src/zen/glance/actors/ZenGlanceParent.sys.mjs",
        "why": "An Escape key query can arrive after Mini closes its top-level window.",
        "old": "  async receiveMessage(message) {\n",
        "new": "  async receiveMessage(message) {\n"
               "    // Whimsy hotfix: the tab/window may close while an actor message is in flight.\n"
               "    if (!this.browsingContext.topChromeWindow?.gZenGlanceManager) {\n"
               "      return;\n"
               "    }\n",
    },
    # wave9/secfix (security-full-1 M5): Glance trusts only the URL from content.
    {
        "id": "glance-parent-principal",
        "file": "src/zen/glance/actors/ZenGlanceParent.sys.mjs",
        "why": "ZenGlance:OpenGlance forwarded the content-supplied principal, "
               "and the load check ran with it: a compromised renderer could "
               "send a system principal and open file:, about:config or "
               "chrome: URLs. Use the parent's own principal for the page.",
        "old": "        this.openGlance(this.browsingContext.topChromeWindow, message.data);\n",
        "new": "        // Whimsy hotfix: only the URL comes from content; the principal is the\n"
               "        // parent's own for the page (content or null, never system).\n"
               "        const url = message.data?.url;\n"
               "        const principal = this.manager?.documentPrincipal;\n"
               "        if (\n"
               "          typeof url !== \"string\" ||\n"
               "          !(principal?.isContentPrincipal || principal?.isNullPrincipal)\n"
               "        ) {\n"
               "          break;\n"
               "        }\n"
               "        this.openGlance(this.browsingContext.topChromeWindow, {\n"
               "          url,\n"
               "          triggeringPrincipal: principal,\n"
               "        });\n",
    },
    # batch3glance: splits restore whole (zen#12403), see WhimsySplitRestore.
    {
        "id": "split-restore-layout",
        "file": "src/zen/split-view/ZenViewSplitter.mjs",
        "why": "zen#12403: a restored split whose saved layout lost a pane "
               "(tab id not found, or a pinned tab copied) drew only some of "
               "its tabs. Rebuild the layout when it doesn't match the tabs.",
        "old": "        if (splitData) {\n"
               "          splitData.layoutTree = layout;\n",
        "new": "        if (splitData) {\n"
               "          splitData.layoutTree = ChromeUtils.importESModule(\"resource:///modules/whimsy/WhimsySplitRestore.sys.mjs\").WhimsySplitRestore.layoutFor(layout, splitData, this); // Whimsy hotfix: zen#12403\n",
    },
    {
        "id": "split-restore-legacy-continue",
        "file": "src/zen/split-view/ZenViewSplitter.mjs",
        "why": "A split saved without a layout tree (older sessions) ended the "
               "restore loop, so every split after it in the window stayed "
               "unsplit. Go on to the next split instead.",
        "old": "          this.splitTabs(group.tabs, group.gridType);\n"
               "          delete this._sessionRestoring;\n"
               "          return;\n",
        "new": "          this.splitTabs(group.tabs, group.gridType);\n"
               "          continue; // Whimsy hotfix: restore the remaining splits too\n",
    },
    # W16-17: a capture-only call (a camera page with no peer connection)
    {
        "id": "media-sharing-card-capture-only",
        "file": "src/zen/media/ZenMediaController.sys.mjs",
        "why": "Zen makes a sharing card only for a page with a peer "
               "connection. A page that only captures (a camera test page) "
               "got none, so Zen unmuted its devices on every sharing "
               "change (undoing Whimsy's device block) and it had no small "
               "player. Let the card through for a call Whimsy tracks.",
        "old": "    if (\n"
               "      !browser?.browsingContext.currentWindowGlobal.hasActivePeerConnections()\n"
               "    ) {\n"
               "      return;\n"
               "    }\n"
               "\n"
               "    this.#sharingCardForBrowser(browser)?.destroy();\n",
        "new": "    if (\n"
               "      !browser?.browsingContext.currentWindowGlobal.hasActivePeerConnections() &&\n"
               "      !ChromeUtils.importESModule(\"resource:///modules/whimsy/WhimsyCallPip.sys.mjs\").WhimsyCallPip.wantsSharingCard(browser) // Whimsy hotfix (W16 17)\n"
               "    ) {\n"
               "      return;\n"
               "    }\n"
               "\n"
               "    this.#sharingCardForBrowser(browser)?.destroy();\n",
    },
    # fixA: command bar related actions
    {
        "id": "command-bar-related-actions",
        "file": "src/zen/urlbar/ZenUBActionsProvider.sys.mjs",
        "why": "Command bar actions only match their own label, so \"dark\" "
               "finds Switch to Dark Mode but not Light or Automatic; an "
               "action's whimsyKeywords (WhimsyCommandBar) match too, ranked "
               "just below a direct match.",
        "old": "      const score = this.#calculateFuzzyScore(label, query);",
        "new": "      const score = Math.max(\n"
               "        this.#calculateFuzzyScore(label, query),\n"
               "        ...(action.whimsyKeywords ?? []).map(k => this.#calculateFuzzyScore(k, query) - 1)\n"
               "      ); // Whimsy hotfix: related actions",
    },
    # merge3: the first command bar action wasn't placed first
    {
        "id": "command-bar-top-action-first",
        "file": "src/zen/urlbar/ZenUBActionsProvider.sys.mjs",
        "why": "suggestedIndex is a getter/setter on UrlbarResult now, so "
               "`delete` left the best match with the same index as the next "
               "one and the view could show the weaker match first (\"dark\" "
               "listed Light Mode above Dark Mode).",
        "old": "          delete result.suggestedIndex;\n",
        "new": "          result.suggestedIndex = undefined; // Whimsy hotfix: delete is a no-op on the accessor\n",
    },
    # W14 18a: Copy URL and Share in Reader View
    {
        "id": "site-panel-copy-url-reader",
        "file": "src/zen/urlbar/ZenSiteDataPanel.sys.mjs",
        "why": "Copy URL and the panel's Share were disabled (and so hidden "
               "in the single toolbar) on about:reader, though copying there "
               "already gives the article's own address (WhimsyCopy).",
        "old": "    return uri.scheme.startsWith(\"http\");\n",
        "new": "    return uri.scheme.startsWith(\"http\") || uri.spec.startsWith(\"about:reader?\"); // Whimsy hotfix (W14 18a)\n",
    },
    # fixA: reused toast keeps stale args
    {
        "id": "toast-reuse-updates-args",
        "file": "src/zen/common/modules/ZenToasts.mjs",
        "why": "A toast shown again while still visible is reused with its "
               "first Fluent args, so Cmd+Opt+. pressed twice said the old "
               "playback speed (and copy toasts the old count).",
        "old": '      child.removeAttribute("button");\n',
        "new": '      child.removeAttribute("button");\n'
               '      document.l10n.setAttributes(child.querySelector("label"), messageId, options.l10nArgs); // Whimsy hotfix\n',
    },
    # wave13/toast: one toast, Zen's, extended (persistent toasts, buttons
    # that show their words, stacking, Reduce Motion, close; see
    # whimsy-handoff/wave13/toast-design.md). gZenUIManager builds the
    # extended manager, which keeps showToast()'s contract for Zen's callers,
    # and hands it out as gZenUIManager.toasts for Whimsy's.
    {
        "id": "zen-toasts-extended",
        "file": "src/zen/common/modules/ZenUIManager.mjs",
        "why": "Zen's toasts overlap when two show, ignore Reduce Motion, "
               "can't stay up or show a button's words; Whimsy's one toast "
               "is Zen's with those added.",
        "old": "  #toasts = new nsZenToastManager();\n",
        "new": "  // Whimsy hotfix: Zen's toast, extended (WhimsyZenToasts.sys.mjs).\n"
               "  #toasts = new (ChromeUtils.importESModule(\n"
               '    "resource:///modules/whimsy/WhimsyZenToasts.sys.mjs"\n'
               "  ).ZenToastManager)(window);\n"
               "  get toasts() {\n"
               "    return this.#toasts;\n"
               "  }\n",
    },
    # fixB: delete-space confirm
    {
        "id": "space-delete-confirm",
        "file": "src/zen/spaces/ZenSpaceManager.mjs",
        "why": "Deleting a space asks with a parentless prompt, which macOS "
               "shows as a separate system alert window; ask inside the "
               "window instead (Zen's own dialog style), with a Delete button.",
        "old": "    if (Services.prompt.confirm(null, title, body)) {",
        "new": "    if (\n"
               "      await ChromeUtils.importESModule(\"resource:///modules/whimsy/WhimsyPanels.sys.mjs\") // Whimsy hotfix\n"
               "        .WhimsyPanels.confirmDeleteSpace(window, title, body)\n"
               "    ) {",
    },
    # fixD: split-four-panes (see WhimsySplit.sys.mjs).
    {
        "id": "split-drop-onto-split-tab",
        "file": "src/zen/drag-and-drop/ZenDragAndDrop.js",
        "why": "Dropping a tab onto a tab in the sidebar only makes new 2-pane "
               "splits; a tab already in a split is refused, so a third or "
               "fourth pane can't be dragged in. Whimsy says when it can join.",
        "old": '        dropElement?.group?.hasAttribute("split-view-group") ||\n'
               "        movingTabsSet.size > 1\n",
        "new": '        (dropElement?.group?.hasAttribute("split-view-group") &&\n'
               "          !gZenViewSplitter.whimsyCanDropIntoSplit?.(dropElement, draggedTab)) || // Whimsy hotfix\n"
               "        movingTabsSet.size > 1\n",
    },
    {
        "id": "split-drop-into-split",
        "file": "src/zen/drag-and-drop/ZenDragAndDrop.js",
        "why": "The drop then joins the existing split beside the pane it was "
               "dropped on, instead of Zen's new-split path.",
        "old": "      // Clear any visuals and timer\n"
               "      this._clearDragOverSplit();\n"
               "\n"
               '      const isLeft = dropSide === "left";\n',
        "new": "      // Clear any visuals and timer\n"
               "      this._clearDragOverSplit();\n"
               "\n"
               "      if (\n"
               "        gZenViewSplitter.whimsyDropIntoSplit?.(draggedTab, droppedOnTab, dropSide, activate) // Whimsy hotfix\n"
               "      ) {\n"
               "        return true;\n"
               "      }\n"
               '      const isLeft = dropSide === "left";\n',
    },
    # wave6/parity: Arc's names for Zen's commands (command bar, about:keyboard,
    # the space's Clear button). Clear Today's tabs go to the Archive store.
    {
        "id": 'zen-string-arc-compact',
        "file": 'locales/en-US/browser/browser/zen-command-palette.ftl',
        "why": "Arc's name for this command.",
        "old": 'zen-action-toggle-compact-mode = Toggle Compact Mode',
        "new": 'zen-action-toggle-compact-mode = Hide or Show Sidebar',
    },
    {
        "id": 'zen-string-arc-library',
        "file": 'locales/en-US/browser/browser/zen-command-palette.ftl',
        "why": "Arc's name for this command.",
        "old": 'zen-action-open-library = Open Library\n',
        "new": 'zen-action-open-library = Open Library…\n',
    },
    {
        "id": 'zen-string-arc-new-space',
        "file": 'locales/en-US/browser/browser/zen-command-palette.ftl',
        "why": "Arc's name for this command.",
        "old": 'zen-action-new-space = New Space\n',
        "new": 'zen-action-new-space = New Space…\n',
    },
    {
        "id": 'zen-string-arc-restore-tab',
        "file": 'locales/en-US/browser/browser/zen-command-palette.ftl',
        "why": "Arc's name for this command.",
        "old": 'zen-action-reopen-closed-tab = Reopen Closed Tab',
        "new": 'zen-action-reopen-closed-tab = Restore Last Closed Tab',
    },
    {
        "id": 'zen-string-arc-blank-window',
        "file": 'locales/en-US/browser/browser/zen-command-palette.ftl',
        "why": "Arc's name for this command.",
        "old": 'zen-action-new-blank-window = New Blank Window',
        "new": 'zen-action-new-blank-window = Blank Window',
    },
    {
        "id": 'zen-string-arc-key-compact',
        "file": 'locales/en-US/browser/browser/preferences/zen-preferences.ftl',
        "why": "Arc's name for this command.",
        "old": 'zen-compact-mode-shortcut-toggle = Toggle Compact Mode',
        "new": 'zen-compact-mode-shortcut-toggle = Hide or Show Sidebar',
    },
    {
        "id": 'zen-string-arc-key-library',
        "file": 'locales/en-US/browser/browser/preferences/zen-preferences.ftl',
        "why": "Arc's name for this command.",
        "old": 'zen-library-shortcut-toggle = Toggle Library',
        "new": 'zen-library-shortcut-toggle = Open Library…',
    },
    {
        "id": 'zen-string-arc-key-clear-today',
        "file": 'locales/en-US/browser/browser/preferences/zen-preferences.ftl',
        "why": "Arc's name for this command.",
        "old": 'zen-close-all-unpinned-tabs-shortcut = Close All Unpinned Tabs',
        "new": 'zen-close-all-unpinned-tabs-shortcut = Clear Today',
    },
    {
        "id": 'zen-string-arc-clear-today-toast',
        "file": 'locales/en-US/browser/browser/zen-workspaces.ftl',
        "why": "Arc's name for this command.",
        "old": 'zen-workspaces-close-all-unpinned-tabs-toast = Tabs Closed! Use <span>{ $shortcut }</span> to undo.',
        "new": 'zen-workspaces-close-all-unpinned-tabs-toast = Today’s tabs are in the Archive. Use <span>{ $shortcut }</span> to undo.',
    },
    {
        "id": 'zen-string-arc-clear-today-tooltip',
        "file": 'locales/en-US/browser/browser/zen-workspaces.ftl',
        "why": "Arc's name for this command.",
        "old": '    .tooltiptext = Close all unpinned tabs',
        "new": '    .tooltiptext = Clear Today: archive every unpinned tab',
    },
    # fix7 settings: onboarding's last step grouped the open tab into a
    # "zen basics" folder. Zen did that to tidy its own welcome and privacy
    # pages (zen-browser.app); Whimsy's first run opens only its homepage,
    # so the folder just held about:whimsy under Zen's name.
    {
        "id": "welcome-no-zen-basics-folder",
        "file": "src/zen/welcome/ZenWelcome.mjs",
        "why": "Onboarding put the first tab in a folder named \"zen basics\"; "
               "Whimsy's first run has no Zen pages to group, and any left over "
               "from older builds close.",
        "old": "      await this.#pinEssentials();\n"
               "      let tabsToGroup = [];\n"
               '      if (!gBrowser.selectedTab.hasAttribute("zen-empty-tab")) {\n'
               "        tabsToGroup.push(gBrowser.selectedTab);\n"
               "      }\n"
               "      gZenFolders.createFolder(tabsToGroup, {\n"
               "        renameFolder: false,\n"
               '        label: "zen basics",\n'
               "      });\n",
        "new": "      await this.#pinEssentials(); // Whimsy hotfix: no \"zen basics\" folder\n"
               '      ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyWelcome.sys.mjs").WhimsyWelcome.finishOnboarding(window); // and no Zen first-run pages\n',
        # (the second line closes zen-browser.app/welcome and /privacy-policy
        # tabs that profiles made by pre-46fe4b3 builds still carry)
    },
    # wave7/keys: Arc's names for Zen's commands that Whimsy now gives a
    # bindable key (WhimsyAccessCommands), so the command bar and
    # about:keyboard agree.
    {
        "id": 'zen-string-arc-new-folder',
        "file": 'locales/en-US/browser/browser/zen-command-palette.ftl',
        "why": "Arc's name for this command.",
        "old": 'zen-action-new-folder = New Folder\n',
        "new": 'zen-action-new-folder = New Folder…\n',
    },
    {
        "id": 'zen-string-arc-atc',
        "file": 'locales/en-US/browser/browser/zen-command-palette.ftl',
        "why": "Arc's name for this command.",
        "old": 'zen-action-open-space-routing = Open Space Routing\n',
        "new": 'zen-action-open-space-routing = Air Traffic Control…\n',
    },
    # wave7/split: Arc's split view names. Zen's tab menu item said "Split
    # Out Tab" for the opposite of splitting, "Join N Tabs" for splitting,
    # and the unsplit command was "Expand current view" / "Close Split View".
    # Create = Add Split View / Open in Split View; undo = Separate Page from
    # Split View (one pane) and Separate All Tabs (the whole split).
    {
        "id": 'zen-string-arc-split-tabs',
        "file": 'locales/en-US/browser/browser/zen-split-view.ftl',
        "why": "Arc's name; no two different split actions share \"Split\" wording (wave7/split).",
        "old": '            [-1] Split Out Tab\n            [1] Add Split View...\n           *[other] Join { $tabCount } Tabs\n',
        "new": '            [-1] Separate Page from Split View\n            [1] Add Split View\n           *[other] Open { $tabCount } Tabs in Split View\n',
    },
    {
        "id": 'zen-string-arc-split-link',
        "file": 'locales/en-US/browser/browser/zen-split-view.ftl',
        "why": "Arc's name; no two different split actions share \"Split\" wording (wave7/split).",
        "old": 'zen-split-link =\n    .label = Split Link to New Tab\n',
        "new": 'zen-split-link =\n    .label = Open Link in Split View\n',
    },
    {
        "id": 'zen-string-arc-new-split',
        "file": 'locales/en-US/browser/browser/zen-command-palette.ftl',
        "why": "Arc's name; no two different split actions share \"Split\" wording (wave7/split).",
        "old": 'zen-action-new-split-view = New Split View\n',
        "new": 'zen-action-new-split-view = Add Split View\n',
    },
    {
        "id": 'zen-string-arc-unsplit',
        "file": 'locales/en-US/browser/browser/zen-command-palette.ftl',
        "why": "Arc's name; no two different split actions share \"Split\" wording (wave7/split).",
        "old": 'zen-action-unsplit-view = Expand current view\n',
        "new": 'zen-action-unsplit-view = Separate All Tabs\n',
    },
    {
        "id": 'zen-string-arc-key-unsplit',
        "file": 'locales/en-US/browser/browser/preferences/zen-preferences.ftl',
        "why": "Arc's name; no two different split actions share \"Split\" wording (wave7/split).",
        "old": 'zen-split-view-shortcut-unsplit = Close Split View\n',
        "new": 'zen-split-view-shortcut-unsplit = Separate All Tabs\n',
    },
    {
        "id": 'zen-string-arc-key-new-split',
        "file": 'locales/en-US/browser/browser/preferences/zen-preferences.ftl',
        "why": "Arc's name; no two different split actions share \"Split\" wording (wave7/split).",
        "old": 'zen-new-empty-split-view-shortcut = New Empty Split View\n',
        "new": 'zen-new-empty-split-view-shortcut = Add Split View\n',
    },
    {
        "id": 'zen-string-arc-panel-new-split',
        "file": 'locales/en-US/browser/browser/zen-workspaces.ftl',
        "why": "Arc's name; no two different split actions share \"Split\" wording (wave7/split).",
        "old": 'zen-panel-ui-new-empty-split =\n    .label = New Split\n',
        "new": 'zen-panel-ui-new-empty-split =\n    .label = Add Split View\n',
    },
    # wave7 lane: the space menu's rows have no access keys except Zen's
    # Delete Space; Gecko's access-key check rejects a menu mixing the two.
    {
        "id": 'zen-string-space-delete-accesskey',
        "file": 'locales/en-US/browser/browser/zen-workspaces.ftl',
        "why": "Only access key in the space menu; a mixed menu trips Gecko's AccessKeyConflictError.",
        "old": 'zen-workspaces-panel-context-delete =\n    .label = Delete Space\n    .accesskey = D\n',
        "new": '# Whimsy: no access key, like the rest of the space menu.\nzen-workspaces-panel-context-delete =\n    .label = Delete Space\n',
    },
    # Zen's tab tests assert Zen's tab order, where new tabs go to the end.
    # Whimsy's default puts them below the current tab
    # (browser.tabs.insertAfterCurrent, new-tab-position), so these tests pin
    # Zen's placement. browser_whimsy_new_tabs.js covers the same close and
    # drag behaviour under Whimsy's default.
    {
        "id": "zen-test-drag-drop-zen-tab-order",
        "file": "src/zen/tests/tabs/browser_drag_drop_vertical.js",
        "why": "Asserts Zen's new-tab order; Whimsy opens new tabs below the current one.",
        "old": '    set: [["zen.view.show-newtab-button-top", false]],\n  });\n\n  // Wait for sidebar',
        "new": '    set: [\n'
               '      ["zen.view.show-newtab-button-top", false],\n'
               '      // Whimsy: Zen\'s tab order (new tabs at the end); see browser_whimsy_new_tabs.js.\n'
               '      ["browser.tabs.insertAfterCurrent", false],\n'
               '    ],\n  });\n\n  // Wait for sidebar',
    },
    {
        "id": "zen-test-close-to-last-zen-tab-order",
        "file": "src/zen/tests/tabs/browser_tabs_close_recently.js",
        "why": "Asserts Zen's new-tab order; Whimsy opens new tabs below the current one.",
        "old": '      ["zen.tabs.select-recently-used-on-close", false],\n'
               '      ["zen.view.show-newtab-button-top", false],\n'
               '    ],\n  });\n\n  const [tab1, tab2, tab3]',
        "new": '      ["zen.tabs.select-recently-used-on-close", false],\n'
               '      ["zen.view.show-newtab-button-top", false],\n'
               '      // Whimsy: Zen\'s tab order (new tabs at the end); see browser_whimsy_new_tabs.js.\n'
               '      ["browser.tabs.insertAfterCurrent", false],\n'
               '    ],\n  });\n\n  const [tab1, tab2, tab3]',
    },
    # wave9/restore: Zen pinned restore, second half.
    {
        "id": "space-init-keeps-selected-tab",
        "file": "src/zen/spaces/ZenSpaceManager.mjs",
        "why": "On a window's first space change (onInit) Zen picks a tab to "
               "select but never selects it, yet still strips 'selected' from "
               "the tab that stays selected. Firefox moves the selection off a "
               "closing tab only when that attribute is set, so closing it (or "
               "restoring a session over the window, which keeps only the "
               "'selected' tab) leaves gBrowser.selectedTab on a removed tab. "
               "Unselect the old tab only when another one takes its place.",
        "old": "    if (currentSelectedTab && currentSelectedTab !== tabToSelect) {\n"
               "      currentSelectedTab._selected = false;\n",
        "new": "    // Whimsy hotfix: only when another tab really takes the selection;\n"
               "    // onInit never selects tabToSelect, and a selected tab without the\n"
               "    // attribute is closed without moving the selection off it.\n"
               "    if (\n"
               "      currentSelectedTab &&\n"
               "      tabToSelect &&\n"
               "      !onInit &&\n"
               "      currentSelectedTab !== tabToSelect\n"
               "    ) {\n"
               "      currentSelectedTab._selected = false;\n",
    },
    # B3: spaces slide as a line, not a ring (see
    # whimsy-handoff/wave13/b3-linear-design.md). The strip is a ring only
    # while navigation wraps; with Whimsy's edges feature on (stop-at-the-
    # ends) it's a line. #spaceDistance reads _whimsyLinearSpaces, a
    # gZenWorkspaces predicate WhimsySpaceSwitchQueue defines.
    {
        "id": "space-linear-helper",
        "file": "src/zen/spaces/ZenSpaceManager.mjs",
        "why": "Adds #spaceDistance, used by the three places below to "
               "stop wrapping the space-index distance the short way round "
               "once Whimsy's edges feature makes the strip a line.",
        "old": "  _organizeWorkspaceStripLocations(\n"
               "    workspace,\n"
               "    justMove = false,\n"
               "    offsetPixels = 0\n"
               "  ) {\n",
        "new": "  // Whimsy hotfix (B3): wraps only while navigation does; see\n"
               "  // _whimsyLinearSpaces (WhimsySpaceSwitchQueue.sys.mjs).\n"
               "  #spaceDistance(from, to, count) {\n"
               "    let diff = to - from;\n"
               "    if (this.shouldWrapAroundNavigation && !this._whimsyLinearSpaces) {\n"
               "      if (diff > Math.floor(count / 2)) {\n"
               "        diff -= count;\n"
               "      } else if (diff < -Math.floor(count / 2)) {\n"
               "        diff += count;\n"
               "      }\n"
               "    }\n"
               "    return diff;\n"
               "  }\n"
               "\n"
               "  _organizeWorkspaceStripLocations(\n"
               "    workspace,\n"
               "    justMove = false,\n"
               "    offsetPixels = 0\n"
               "  ) {\n",
    },
    {
        "id": "space-linear-next-idx",
        "file": "src/zen/spaces/ZenSpaceManager.mjs",
        "why": "Which neighbour a swipe reveals: clamp at the ends instead "
               "of wrapping to the far space once the strip is a line.",
        "old": "    let nextSpaceIdx;\n"
               "    const spaceLen = workspaces.length;\n"
               "    if (offsetPixels > 0) {\n"
               "      nextSpaceIdx = (workspaceIndex - 1 + spaceLen) % spaceLen;\n"
               "    } else if (offsetPixels < 0) {\n"
               "      nextSpaceIdx = (workspaceIndex + 1) % spaceLen;\n"
               "    } else {\n"
               "      nextSpaceIdx = workspaceIndex;\n"
               "    }\n",
        "new": "    let nextSpaceIdx;\n"
               "    const spaceLen = workspaces.length;\n"
               "    // Whimsy hotfix (B3): clamp, don't wrap, once the strip is a line.\n"
               "    const wrapSpaces =\n"
               "      this.shouldWrapAroundNavigation && !this._whimsyLinearSpaces;\n"
               "    if (offsetPixels > 0) {\n"
               "      nextSpaceIdx = wrapSpaces\n"
               "        ? (workspaceIndex - 1 + spaceLen) % spaceLen\n"
               "        : Math.max(workspaceIndex - 1, 0);\n"
               "    } else if (offsetPixels < 0) {\n"
               "      nextSpaceIdx = wrapSpaces\n"
               "        ? (workspaceIndex + 1) % spaceLen\n"
               "        : Math.min(workspaceIndex + 1, spaceLen - 1);\n"
               "    } else {\n"
               "      nextSpaceIdx = workspaceIndex;\n"
               "    }\n",
    },
    {
        "id": "space-linear-resting",
        "file": "src/zen/spaces/ZenSpaceManager.mjs",
        "why": "Resting strip layout: each strip at (index - active) x 100%, "
               "no wrap, once the strip is a line.",
        "old": "      let diff = workspaces.indexOf(otherWorkspace) - workspaceIndex;\n"
               "      if (diff > Math.floor(spaceLen / 2)) {\n"
               "        diff -= spaceLen;\n"
               "      } else if (diff < -Math.floor(spaceLen / 2)) {\n"
               "        diff += spaceLen;\n"
               "      }\n",
        "new": "      // Whimsy hotfix (B3): #spaceDistance keeps this linear once the\n"
               "      // strip is a line.\n"
               "      let diff = this.#spaceDistance(\n"
               "        workspaceIndex,\n"
               "        workspaces.indexOf(otherWorkspace),\n"
               "        spaceLen\n"
               "      );\n",
    },
    {
        "id": "space-linear-animate-direction",
        "file": "src/zen/spaces/ZenSpaceManager.mjs",
        "why": "isGoingLeft and the crossing count: the switch direction, "
               "no wrap, once the strip is a line.",
        "old": "    let diff = newWorkspaceIndex - previousWorkspaceIndex;\n"
               "    if (diff > Math.floor(spaceLen / 2)) {\n"
               "      diff -= spaceLen;\n"
               "    } else if (diff < -Math.floor(spaceLen / 2)) {\n"
               "      diff += spaceLen;\n"
               "    }\n",
        "new": "    // Whimsy hotfix (B3): #spaceDistance keeps this linear once the\n"
               "    // strip is a line.\n"
               "    let diff = this.#spaceDistance(\n"
               "      previousWorkspaceIndex,\n"
               "      newWorkspaceIndex,\n"
               "      spaceLen\n"
               "    );\n",
    },
    {
        "id": "space-linear-animate-offset",
        "file": "src/zen/spaces/ZenSpaceManager.mjs",
        "why": "Each strip's end position for this switch: no wrap once the "
               "strip is a line (this is the end position of every strip, "
               "so a ring offset put the last space left of the first even "
               "with the direction fixed).",
        "old": "      let offset = elementWorkspaceIndex - newWorkspaceIndex;\n"
               "      if (offset > Math.floor(spaceLen / 2)) {\n"
               "        offset -= spaceLen;\n"
               "      } else if (offset < -Math.floor(spaceLen / 2)) {\n"
               "        offset += spaceLen;\n"
               "      }\n",
        "new": "      // Whimsy hotfix (B3): #spaceDistance keeps this linear once the\n"
               "      // strip is a line.\n"
               "      let offset = this.#spaceDistance(\n"
               "        newWorkspaceIndex,\n"
               "        elementWorkspaceIndex,\n"
               "        spaceLen\n"
               "      );\n",
    },
    # W14-17: a hidden space takes no slot on the space strip: the drag
    # preview, the resting layout and the slides count only the spaces
    # gZenWorkspaces._whimsyNavigableSpaces returns (WhimsySpaceArchive:
    # the visible ones plus the showing one), and the rest stay parked.
    {
        "id": "space-hidden-strip-layout",
        "file": "src/zen/spaces/ZenSpaceManager.mjs",
        "why": "The resting strip and the swipe preview's neighbour skip "
               "hidden spaces, which are parked off the strip.",
        "old": "    this._organizingWorkspaceStrip = true;\n"
               "    const workspaces = this.getWorkspaces();\n",
        "new": "    this._organizingWorkspaceStrip = true;\n"
               "    // Whimsy hotfix (W14-17): hidden spaces take no slot.\n"
               "    const workspaces =\n"
               "      this._whimsyNavigableSpaces?.(this.getWorkspaces(), [workspace.uuid]) ??\n"
               "      this.getWorkspaces();\n"
               "    this._whimsyParkHiddenSpaces?.(workspaces);\n",
    },
    {
        "id": "space-hidden-strip-animate",
        "file": "src/zen/spaces/ZenSpaceManager.mjs",
        "why": "A slide counts only the spaces on the strip, the one it "
               "leaves included, so it never passes through hidden ones.",
        "old": "    const animations = [];\n"
               "    const workspaces = this.getWorkspaces();\n"
               "    const spaceLen = workspaces.length;\n",
        "new": "    const animations = [];\n"
               "    // Whimsy hotfix (W14-17): hidden spaces take no slot.\n"
               "    const allWorkspaces = this.getWorkspaces();\n"
               "    const workspaces =\n"
               "      this._whimsyNavigableSpaces?.(allWorkspaces, [\n"
               "        newWorkspace.uuid,\n"
               "        previousWorkspace?.uuid,\n"
               "      ]) ?? allWorkspaces;\n"
               "    if (previousWorkspace && workspaces !== allWorkspaces) {\n"
               "      previousWorkspaceIndex = workspaces.findIndex(\n"
               "        w => w.uuid === previousWorkspace.uuid\n"
               "      );\n"
               "    }\n"
               "    this._whimsyParkHiddenSpaces?.(workspaces);\n"
               "    const spaceLen = workspaces.length;\n",
    },
    {
        "id": "space-hidden-strip-skip",
        "file": "src/zen/spaces/ZenSpaceManager.mjs",
        "why": "A parked hidden space is left where it is during a slide.",
        "old": "      const elementWorkspaceIndex = workspaces.findIndex(\n"
               "        w => w.uuid === elementWorkspaceId\n"
               "      );\n",
        "new": "      const elementWorkspaceIndex = workspaces.findIndex(\n"
               "        w => w.uuid === elementWorkspaceId\n"
               "      );\n"
               "      // Whimsy hotfix (W14-17): a hidden space stays parked.\n"
               "      if (\n"
               "        elementWorkspaceIndex < 0 &&\n"
               "        allWorkspaces.some(w => w.uuid === elementWorkspaceId)\n"
               "      ) {\n"
               "        element.active = false;\n"
               "        continue;\n"
               "      }\n",
    },
    {
        "id": "space-hidden-focus-actions",
        "file": "src/zen/urlbar/ZenUBActionsProvider.sys.mjs",
        "why": "The command bar's Focus on <space> rows leave out hidden "
               "spaces; only Show Hidden Spaces lists them.",
        "old": "    const workspaces = window.gZenWorkspaces.getWorkspaces();\n"
               "    if (!workspaces?.length) {\n",
        "new": "    // Whimsy hotfix (W14-17): no hidden spaces.\n"
               "    const workspaces =\n"
               "      window.gZenWorkspaces._whimsyNavigableSpaces?.(\n"
               "        window.gZenWorkspaces.getWorkspaces()\n"
               "      ) ?? window.gZenWorkspaces.getWorkspaces();\n"
               "    if (!workspaces?.length) {\n",
    },
    # W10-39: Rename Space did nothing, and then neither did any rename.
    {
        "id": "tab-renamer-stale-edit",
        "file": "src/zen/tabs/ZenTabRenamer.mjs",
        "why": "A rename whose input went away without a blur (its tab or "
               "space was removed while editing) leaves #edited set, and "
               "start() refuses every later rename (tabs, folders, spaces) "
               "until restart. Drop the stale edit first.",
        "old": "  start(event) {\n"
               "    let target = event.target;\n",
        "new": "  start(event) {\n"
               "    // Whimsy hotfix: an edit whose input is gone can't finish; drop it\n"
               "    // so it doesn't block every later rename.\n"
               "    if (this.#edited && !this.#input) {\n"
               "      this.#cancel();\n"
               "    }\n"
               "    let target = event.target;\n",
    },
    {
        "id": "tab-renamer-focus",
        "file": "src/zen/tabs/ZenTabRenamer.mjs",
        "why": "When the label can't take focus (not drawn yet: compact mode's "
               "hidden sidebar, or focus taken back right away), input.focus() "
               "silently does nothing, no blur ever ends the rename, and "
               "#edited stays set: every later rename does nothing until "
               "restart (zen-browser/desktop#14876). Undo the rename instead.",
        "old": "    input.focus();\n"
               "    input.setSelectionRange(0, input.value.length, \"backward\");\n",
        "new": "    input.focus();\n"
               "    // Whimsy hotfix: no focus means no blur will ever end this rename.\n"
               "    if (document.activeElement !== input) {\n"
               "      this.#cancel();\n"
               "      return;\n"
               "    }\n"
               "    input.setSelectionRange(0, input.value.length, \"backward\");\n",
    },
    # F14: Tab rename takes one click on title text like Arc; click outside ends editing.
    {
        "id": "tab-renamer-one-click-init",
        "file": "src/zen/tabs/ZenTabRenamer.mjs",
        "why": "One click on the title text of the selected tab enters rename mode (F14).",
        "old": "  init() {\n"
               "    document\n"
               "      .getElementById(\"tabbrowser-tabs\")\n"
               "      .addEventListener(\"dblclick\", event => this.start(event));\n"
               "  }\n",
        "new": "  #selectedOnMouseDown = null;\n\n"
               "  #onOutsidePointer = event => {\n"
               "    if (\n"
               "      this.#input &&\n"
               "      (event.target === this.#input || this.#input.contains(event.target))\n"
               "    ) {\n"
               "      return;\n"
               "    }\n"
               "    this.#cancel();\n"
               "  };\n\n"
               "  init() {\n"
               "    const tabs = document.getElementById(\"tabbrowser-tabs\");\n"
               "    tabs.addEventListener(\n"
               "      \"mousedown\",\n"
               "      event => {\n"
               "        if (event.button !== 0) {\n"
               "          return;\n"
               "        }\n"
               "        const tab = event.target.closest(\".tabbrowser-tab\");\n"
               "        this.#selectedOnMouseDown = tab ? tab.selected : null;\n"
               "      },\n"
               "      true\n"
               "    );\n"
               "    tabs.addEventListener(\"click\", event => {\n"
               "      if (\n"
               "        event.button !== 0 ||\n"
               "        event.shiftKey ||\n"
               "        event.ctrlKey ||\n"
               "        event.metaKey ||\n"
               "        event.altKey\n"
               "      ) {\n"
               "        return;\n"
               "      }\n"
               "      const tab = event.target.closest(\".tabbrowser-tab\");\n"
               "      if (\n"
               "        tab &&\n"
               "        this.#selectedOnMouseDown &&\n"
               "        event.target.closest(\".tab-label-container\")\n"
               "      ) {\n"
               "        this.start(event);\n"
               "      }\n"
               "    });\n"
               "    tabs.addEventListener(\"dblclick\", event => this.start(event));\n"
               "  }\n",
    },
    {
        "id": "tab-renamer-click-target",
        "file": "src/zen/tabs/ZenTabRenamer.mjs",
        "why": "Single-click renames must target the title label container (F14).",
        "old": "    if (\n"
               "      isTab &&\n"
               "      !target.closest(\".tab-label-container\") &&\n"
               "      event.type === \"dblclick\"\n"
               "    ) {\n"
               "      return;\n"
               "    }\n",
        "new": "    if (\n"
               "      isTab &&\n"
               "      !target.closest(\".tab-label-container\") &&\n"
               "      (event.type === \"dblclick\" || event.type === \"click\")\n"
               "    ) {\n"
               "      return;\n"
               "    }\n",
    },
    {
        "id": "tab-renamer-outside-listener",
        "file": "src/zen/tabs/ZenTabRenamer.mjs",
        "why": "Clicking anywhere outside the field, including empty tab space, ends editing (F14).",
        "old": "    input.addEventListener(\"blur\", event => this.#halt(event));\n",
        "new": "    input.addEventListener(\"blur\", event => this.#halt(event));\n"
               "    window.addEventListener(\"mousedown\", this.#onOutsidePointer, true);\n",
    },
    {
        "id": "tab-renamer-outside-cancel",
        "file": "src/zen/tabs/ZenTabRenamer.mjs",
        "why": "Remove outside listener on cancel (F14).",
        "old": "  #cancel() {\n"
               "    if (!this.#edited) {\n"
               "      return;\n"
               "    }\n"
               "    document.documentElement.removeAttribute(\"zen-renaming-tab\");\n",
        "new": "  #cancel() {\n"
               "    if (!this.#edited) {\n"
               "      return;\n"
               "    }\n"
               "    window.removeEventListener(\"mousedown\", this.#onOutsidePointer, true);\n"
               "    document.documentElement.removeAttribute(\"zen-renaming-tab\");\n",
    },
    {
        "id": "tab-renamer-outside-save",
        "file": "src/zen/tabs/ZenTabRenamer.mjs",
        "why": "Remove outside listener on save (F14).",
        "old": "    const hasChanged = input.value !== input._originalValue && newName;\n\n"
               "    document.documentElement.removeAttribute(\"zen-renaming-tab\");\n",
        "new": "    const hasChanged = input.value !== input._originalValue && newName;\n\n"
               "    window.removeEventListener(\"mousedown\", this.#onOutsidePointer, true);\n"
               "    document.documentElement.removeAttribute(\"zen-renaming-tab\");\n",
    },
]

# Prefs Zen declares whose defaults Whimsy changes: {name: value}.
PREF_OVERRIDES = {
    "zen.ctrlTab.show-pending-tabs": True,       # Arc-style Ctrl+Tab
    "zen.urlbar.wait-to-clear": 0,               # C1: ⌘T always opens an empty bar (Zen keeps the last search 45 s)
    "zen.updates.show-update-notification": False,  # Whimsy shows its own
    "zen.folders.owned-tabs-in-folder": True,    # new tabs stay in the folder
    "zen.theme.gradient.show-custom-colors": True,  # theme picker's custom colors (hex field)
    # Automatic picture-in-picture when you leave a playing video (Arc);
    # Zen kept it off "until a settings page"; Firefox's Media settings has it.
    "media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled": True,
    # batch hover: Arc's tab hover card (title, address, page preview) is
    # Firefox's tab hover preview, which Zen ships off.
    "browser.tabs.hoverPreview.enabled": True,
    # W10-31: the theme keeps its colors when the window loses focus, like
    # Arc. Zen greys an inactive window out: #zen-main-app-wrapper turns
    # InactiveCaption (zen-browser-ui.css) and the macOS window material
    # follows the active state (nsCocoaWindow-mm.patch). Both read this pref,
    # so Zen's own switch turns it off everywhere and stays user-settable.
    "zen.view.grey-out-inactive-windows": False,
}

# Strings Zen's markup uses that its .ftl files no longer define.
FALLBACK_STRINGS = {
    "preferences-web-appearance-footer":
        'preferences-web-appearance-footer = Manage themes in '
        '<a data-l10n-name="themes-link">Extensions & Themes</a>',
}
FALLBACK_FILE = "locales/en-US/browser/browser/preferences/whimsy-fallbacks.ftl"

# Whimsy features, and signs that Zen now ships its own version.
FEATURES = [
    {"id": "ctrl-tab", "title": "Arc-style Ctrl+Tab: recently used order, one rounded card with rows of four, up to 12 tabs, other spaces' tabs badged",
     "detect": [("prefs", r"name:\s*browser\.ctrlTab\.sortByRecentlyUsed")]},
    {"id": "ui-zoom", "title": "Interface zoom",
     "detect": [("src", r"ui-zoom|uiZoom|interface-zoom")]},
    {"id": "app-icon", "title": "App icon picker",
     "detect": [("src", r"setApplicationIcon|applicationIconImage|zen\.app-icon|app-icon-picker")]},
    {"id": "copy", "title": "Copy & share: rich links, selected tabs, Copy Links menu item",
     "detect": [("src/zen", r"context_copyLinks|copySelectedTabsURL|copyTabsURLs|text/html.*copyCurrentURL")]},
    {"id": "cookie-banners", "title": "Reject cookie banners (built-in DuckDuckGo Autoconsent add-on + toggle)",
     "detect": [("src/zen", r"(?i)autoconsent|cookiebanners\.service\.mode"),
                ("prefs", r"name:\s*cookiebanners\.service\.mode")]},
    {"id": "private-indicator", "title": "Private window indicator (violet tint + Incognito badge)",
     "detect": [("src/zen", r"privatebrowsingmode[^\n]*(--zen-main-browser-background|accent)")]},
    {"id": "ai-kill-switch", "title": "AI kill switch (one toggle blocks every Firefox and Whimsy AI feature)",
     "detect": [("src/zen", r"browser\.ai\.control\.default"),
                ("prefs", r"name:\s*browser\.ai\.control\.default")]},
    {"id": "duplicate-shortcut", "title": "Duplicate tab on Cmd+Shift+D; Pin/Unpin on Cmd+D (Arc)",
     "detect": [("src/browser/base/content", r'id="zen-duplicate-tab"[^>]*\bkey=')]},
    {"id": "new-tab-position", "title": "New tabs open below the current tab and stay in its folder (toggles)",
     "detect": [("src/browser/components/preferences", r"browser\.tabs\.insertAfterCurrent|zen\.folders\.owned-tabs-in-folder")]},
    {"id": "dim-sleeping", "title": "Dim sleeping (unloaded) tabs (toggle, off by default)",
     "detect": [("src/zen", r"\[pending\][^{]*\{[^}]*opacity"),
                ("prefs", r"name:\s*zen\.[\w.-]*(dim|fade)[\w.-]*(unloaded|sleeping|pending)")]},
    {"id": "title-lines", "title": "Tab title lines: wrap titles onto 1, 2 or 3 lines (setting)",
     "detect": [("src/zen/tabs", r"tab-label[^{]*\{[^}]*line-clamp"),
                ("prefs", r"name:\s*zen\.[\w.-]*title-lines")]},
    {"id": "newtab-bottom", "title": "New tab button fixed at the bottom of the sidebar (toggle, off by default)",
     "detect": [("prefs", r"name:\s*zen\.[\w.-]*newtab-button-bottom")]},
    {"id": "folder-colors", "title": "Folder colors: pick a color per folder from its context menu",
     "detect": [("src/zen/folders", r"zenFolder\w*Color|folder-color-picker"),
                ("prefs", r"name:\s*zen\.folders\.[\w.-]*colou?r")]},
    {"id": "loading-line", "title": "Loading progress line: Zen's loading pill as a Safari-style progress line (toggle)",
     "detect": [("src/zen/common/sys/ui", r"onProgressChange"),
                ("prefs", r"name:\s*zen\.[\w.-]*loading-(line|progress)")]},
    {"id": "tab-badges", "title": "Notification badges (unread counts) and update dots on pinned tabs and Essentials",
     "detect": [("src/zen", r"unread-?count|zen-unread|notification-badge"),
                ("prefs", r"name:\s*zen\.[\w.-]*(badge|unread)")]},
    {"id": "group-domain", "title": "Group by domain: gather a site's tabs into a folder (tab context menu)",
     "detect": [("src/zen", r"(group|folder)[\w-]*by-?(domain|site)"),
                ("src/zen/folders", r"getBaseDomain")]},
    {"id": "space-icon-drop", "title": "Drop tabs on space icons to move them to that space (Arc)",
     "detect": [("src/zen/drag-and-drop", r"handle_spaceIconDrop\b|spaceIconDrop")]},
    {"id": "space-last-tab", "title": "Return to the most recently used tab in each space, also after a restart",
     "detect": [("src/zen/spaces", r"lastSelectedWorkspaceTabs\[[^\]]+\]\s*=\s*[^;]*lastAccessed")]},
    {"id": "emoji-search", "title": "Emoji search: every word must match, Enter picks the first result, empty state",
     "detect": [("src/zen/common/emojis", r"split\(/\\s\+/\)|no-results|emojis-picker-empty")]},
    {"id": "hide-switcher", "title": "Hide the space switcher (toggle, off by default)",
     "detect": [("prefs", r"name:\s*zen\.[\w.-]*(hide|show)[\w.-]*(workspace|space)[\w.-]*(switcher|icons|button)")]},
    {"id": "open-link-in-space", "title": "Open Link in Space (link context menu, Arc)",
     "detect": [("src/zen/spaces", r"openLinkIn(Workspace|Space)|open-link-in-(workspace|space)")]},
    {"id": "hex-colors", "title": "Hex colors in the theme picker (type or paste #RRGGBB)",
     "detect": [("src/zen/spaces", r"type=\"text\"[^>]*custom|custom-hex|hex-input")]},
    {"id": "transparency", "title": "Transparency slider for the sidebar and toolbars (macOS)",
     "detect": [("prefs", r"name:\s*zen\.(theme|view)\.[\w.-]*(transparency|translucency)")]},
    {"id": "menu-icons", "title": "Menu icons in context menus and the tab menu (macOS 26 style)",
     "detect": [("src/browser/themes/shared/zen-icons", r"#context-copylink|#context-openlinkintab|#context_duplicateTab")]},
    {"id": "ui-font", "title": "Interface font setting (the browser's own text, not web pages)",
     "detect": [("prefs", r"name:\s*zen\.[\w.-]*(ui|interface|chrome)-font")]},
    {"id": "strip-tracking", "title": "Strip tracking parameters from links (query stripping on by default + toggle)",
     "detect": [("prefs", r"name:\s*privacy\.query_stripping\.enabled\s*$")]},
    {"id": "background-mute", "title": "Mute background tabs (Vivaldi's Tab Muting: while the current tab plays, or always; setting)",
     "detect": [("src/zen", r"(?i)mute[_-]?background[_-]?tabs|backgroundTabMute"),
                ("prefs", r"name:\s*zen\.[\w.-]*(background|inactive)[\w.-]*mute")]},
    {"id": "mute-site", "title": "Remember muted sites: Mute Site in the tab menu (Chrome)",
     "detect": [("src/zen", r"(?i)context_\w*MuteSite|mute-?site\b")]},
    {"id": "tab-volume", "title": "Per-tab volume: a slider on the tab's speaker and in the tab menu",
     "detect": [("src/zen", r"(?i)tab-?volume-?(slider|panel)|setTabVolume")]},
    {"id": "pip-snap-back", "title": "PiP snaps back into the page when you return to its tab (Arc), automatic PiP setting",
     "detect": [("src/zen", r"(?i)pip-?snap|snapBackPip")]},
    {"id": "playback-speed", "title": "Playback speed shortcuts (Cmd+Opt+. and ,) and the PiP speed control",
     "detect": [("src/zen/media", r"(?i)zen-media-(speed|rate)|setPlaybackRate|playback-speed"),
                ("prefs", r"name:\s*media\.videocontrols\.picture-in-picture\.playback-speed\.enabled")]},
    {"id": "find-selection", "title": "Cmd+F opens Find with the selected text (Chrome, Safari)",
     "detect": [("prefs", r"name:\s*accessibility\.typeaheadfind\.prefillwithselection")]},
    {"id": "capture", "title": "Capture: Arc's Cmd+Shift+2 for Screenshots, and Copy Full-Page Screenshot in one step",
     "detect": [("src/zen", r"(?i)copy-?full-?page|fullPageScreenshot|capture-full-page")]},
    {"id": "edit-page", "title": "Edit text on page (designMode) from the page menu and command bar",
     "detect": [("src/zen/urlbar", r"(?i)designMode|edit-?page"),
                ("src/zen/boosts", r"designMode\s*=")]},
    {"id": "allow-copy", "title": "Allow copy and paste on sites that block it (per site, command bar)",
     "detect": [("src/zen", r"(?i)allow-?copy|copy-?unblock|enable-?right-?click")]},
    {"id": "wayback", "title": "Internet Archive for dead pages (bar on 404/5xx/DNS errors, command bar)",
     "detect": [("src/zen", r"(?i)wayback|archive\.org/wayback")]},
    {"id": "image-info", "title": "View Image Info on the image context menu",
     "detect": [("prefs", r"name:\s*browser\.menu\.showViewImageInfo")]},
    {"id": "translate-selection", "title": "Translate selection: a shortcut and command bar action for Firefox's panel",
     "detect": [("src/zen", r"SelectTranslationsPanel\.open"),
                ("src/browser/base/content", r"key[^>]*(translate-?selection|translateSelection)")]},
    {"id": "reader-fonts", "title": "Reader View typography: the macOS reading fonts (Charter, Iowan, Athelas...)",
     "detect": [("prefs", r"name:\s*reader\.font_type\.values"),
                ("src/zen", r"reader\.font_type\.values")]},
    {"id": "reading-time", "title": "Reading time next to the Reader View button (setting)",
     "detect": [("src/zen/urlbar", r"(?i)reading-?time"),
                ("src/browser/base/content", r"(?i)id=\"[\w-]*reading-?time")]},
    {"id": "dark-pdf", "title": "Dark PDFs: a Settings toggle for pdf.js page colours (off by default)",
     "detect": [("prefs", r"name:\s*pdfjs\.(forcePageColors|viewerCssTheme)"),
                ("src/browser/components/preferences", r"pdfjs\.forcePageColors")]},
    {"id": "github-reviews", "title": "My Review Requests (GitHub live folders, Zen PR #16183)",
     "detect": [("src/zen/live-folders", r"user-review-requested|myReviewRequests"),
                ("locales/en-US", r"(?i)my review requests")]},
    {"id": "peek-essential-links", "title": "Settings checkbox for Zen's open-essential-external-links Glance pref",
     "detect": [("src/browser/components/preferences", r'preference="zen\.glance\.open-essential-external-links"')]},
    {"id": "glance-split-action", "title": "\"Split Glance\" in the command bar",
     "detect": [("src/zen/urlbar", r"cmd_zenGlanceSplit")]},
    {"id": "external-link-target", "title": "External links (from other apps) open in Glance, a tab, or Mini Whimsy",
     # Looks for Zen's own quick-window feature as code (a pref, command or
     # class name), not prose about Arc's "Little Arc" (Zen's Arc-migration
     # tests mention it only to skip it, which isn't Zen shipping one).
     "detect": [("src/zen", r"(?i)zen[\w.-]*quick[\w.-]*window|cmd_zenQuickWindow")]},
    # batch8: tab lifecycle (archive, undo, snooze, tree tabs, fire button, heavy tabs)
    {"id": "auto-archive-tabs", "title": "Auto-archive idle unpinned tabs after a quiet period (Arc)",
     "detect": [("prefs", r"name:\s*zen\.tabs\.(auto-?archive|idle-?close)"),
                ("src/zen", r"(?i)auto-?archive-?tabs|archiveIdleTabs")]},
    {"id": "archive-view", "title": "Archive view: a searchable, by-day list of closed/archived tabs with restore",
     "detect": [("src/zen", r"(?i)zen-?archive-?view|ZenArchiveView")]},
    {"id": "undo-tab-actions", "title": "Cmd+Z undoes the last tab action (close, move, pin), not just closing one tab",
     "detect": [("src/zen", r"(?i)zen-?tab-?undo|ZenTabUndoManager")]},
    {"id": "snooze-tab", "title": "Snooze a tab: closes it now, reopens at a chosen time (SigmaOS, Edge)",
     "detect": [("src/zen", r"(?i)snooze-?tab|ZenSnoozeManager")]},
    {"id": "favicon-home", "title": "Favicon Goes Home",
     "detect": [("src/zen", r"(?i)favicon-?home|tab-icon.*(home|origin)")]},
    {"id": "tree-tabs", "title": "Tree-style tabs with an Islands mode: nest a tab under whichever tab opened it",
     "default": False,  # Build-plan answer: off by default.
     "detect": [("src/zen", r"(?i)zen-?tree-?tabs|ZenTreeTabs|zen-?tab-?islands")]},
    {"id": "fire-button", "title": "Fire button: a one-click data-clearing popover (DuckDuckGo), scoped to site/15 min/space/everything",
     "detect": [("src/zen", r"(?i)fire-?button|ZenFireButton")]},
    {"id": "heavy-tabs", "title": "Find heavy tabs: the tabs using the most memory/CPU, with a close button (Opera GX)",
     "detect": [("src/zen", r"(?i)heavy-?tabs|hot-?tabs-?killer|ZenHeavyTabs")]},
    # batch6: split view extras.
    {"id": "split-link-click", "title": "Shift+click a link opens it in a split (opt-in, Zen PR#15241)",
     "detect": [("src/zen/split-view", r"(?i)shift.*click.*split|modifier.*click.*split")]},
    {"id": "split-close-other-panes", "title": "\"Close Other Panes\" in the command bar",
     "detect": [("src/zen/split-view", r"cmd_zen[\w]*CloseOther")]},
    {"id": "split-swap-panes", "title": "\"Swap Panes\" in the command bar",
     "detect": [("src/zen/split-view", r"cmd_zen[\w]*SwapPanes|swapPanes\(")]},
    {"id": "split-command-bar", "title": "Split Vertically/Horizontally/Grid in the command bar",
     "detect": [("src/zen/urlbar", r"zen-action-split-(vertically|horizontally|grid)")]},
    {"id": "command-bar-slash", "title": "Typing \"/\" in the URL bar enters Zen's commands mode",
     "detect": [("src/zen/urlbar", r'ZEN_ACTIONS[\s\S]{0,400}["\']/["\']|["\']/["\'][\s\S]{0,200}enableCommandsMode')]},
    {"id": "command-bar-create", "title": "Arc-style \"New ...\" actions (docs.new etc.) in the command bar",
     "detect": [("src/zen/urlbar", r"docs\.new|zen-action-new-doc")]},
    # batch9: spaces
    {"id": "space-manager-settings", "title": "Settings entry point for Zen's existing per-space manager (Library \"Spaces\")",
     "detect": [("src/browser/components/preferences", r"(?i)space\s*manager")]},
    {"id": "atc-settings", "title": "Settings entry point renaming Zen's space-routing rules to Arc's Air Traffic Control",
     "detect": [("src/zen", r"(?i)air traffic control")]},
    {"id": "archive-space", "title": "Hide a space (Arc's archive/shelve): drops out of the switcher without closing its tabs; restore from Settings",
     "detect": [("src/zen/spaces", r"(?i)archiveWorkspace|hideWorkspace|workspace\.hidden\b")]},
    {"id": "space-lock", "title": "Lock a space behind Touch ID/password (OSKeyStore) before switching to it",
     "detect": [("src/zen/spaces", r"(?i)OSKeyStore|lockWorkspace|workspace\.locked\b")]},
    # batch9p: Scratch and private tabs
    {"id": "scratch", "title": "Private Space (temporary private space, Cmd+Shift+N) and private tabs (Cmd+Option+T)",
     "detect": [("src/zen", r"(?i)zen[\w.-]*private[\w.-]*tab|mozprivatebrowsing|zen[\w.-]*scratch")]},
    # batch10: Library sidebar panels.
    {"id": "notes", "title": "Notes: a markdown scratchpad in the Library sidebar, optionally attached to a page",
     "detect": [("src/zen/library", r"(?i)whimsy-library-notes|WhimsyNotesSection")]},
    {"id": "finder-folders", "title": "Finder folders in the sidebar: pin a folder, browse it without leaving the browser",
     "detect": [("src/zen/library", r"(?i)whimsy-library-finder-folders|WhimsyFinderFoldersSection")]},
    {"id": "screenshot-sidebar", "title": "Screenshot to sidebar: captures also land as files in the Library, not just the clipboard",
     "detect": [("src/zen/library", r"(?i)whimsy-library-files|WhimsyFilesSection")]},
    # batch12: links & media windows
    {"id": "quick-window", "title": "Mini Whimsy (Arc's Little Arc): a quick window (Cmd+Opt+N; links from other apps, per the setting above), floating above other windows, with Cmd+O/Cmd+Opt+O to move it into a space",
     "detect": [("src/zen", r"(?i)zen[\w.-]*quick[\w.-]*window|cmd_zenQuickWindow")]},
    {"id": "follower-tabs", "title": "Follower tabs: a 2-pane split where clicked links land in the other pane, the source pane never navigates (Vivaldi)",
     "detect": [("src/zen", r"(?i)follower-?tabs?|follower-?split")]},
    # batch13: page & reading (split favorites, bionic reading, print a clean page, menu bar extra)
    {"id": "split-favorites", "title": "Pin or favorite a split (reopen it with one click)",
     "detect": [("src/zen", r"(?i)favorite[\w.-]*split|split[\w.-]*favorite")]},
    {"id": "bionic-reading", "title": "Bionic (guided) reading in Reader View",
     "detect": [("src/zen", r"(?i)bionic[\w.-]*read")]},
    {"id": "print-clean", "title": "Print a clean page (Reader View, then print, leaving the tab alone)",
     "detect": [("src/zen", r"(?i)print[\w.-]*clean[\w.-]*page")]},
    {"id": "menu-bar-extra", "title": "Menu bar extra (macOS): quick window and recent tabs",
     "detect": [("src/zen", r"(?i)menu[\w.-]*bar[\w.-]*extra|systemstatusbar")]},
    # batch11: live folders (Jira + Push refresh + RSS autodiscovery).
    {"id": "live-folders-jira", "title": "Jira live folder: assigned, unresolved issues as a self-updating folder",
     "detect": [("src/zen/live-folders", r"(?i)jira")]},
    {"id": "live-folders-push", "title": "\"Push\" live-folder refresh option (1-minute conditional checks)",
     "detect": [("src/zen/live-folders", r"(?i)if-none-match|etag")]},
    {"id": "live-folders-rss-autodiscover", "title": "RSS: autodiscover a page's feed when the URL given isn't one",
     "detect": [("src/zen/live-folders", r"(?i)rel=.alternate.*(?:rss|atom)|autodiscover")]},

    # batch7: input, files, nav, dev, URL schemes, delight
    {"id": "seasonal-themes", "title": "Seasonal touches: loading colors, balloon costumes, command bar trim, Balloon Dash and changelog art",
     # Firefox's old Colorways never shipped in this engine; this never matches.
     "detect": [("prefs", r"name:\s*browser\.theme\.colorways\.enabled")]},
    {"id": "window-close", "title": "Cmd+W on a lone empty tab closes the window (Arc); Zen already keeps the window open otherwise",
     "detect": [("src/zen", r"(?i)zen-empty-tab[^\n]*cmd_close|cmd_close[^\n]*zen-empty-tab")]},
    {"id": "full-url-click", "title": "A single click on the address bar selects the whole untrimmed URL (Arc, Safari)",
     "detect": [("src/zen", r"(?i)always-full-url|full-?url-?click")]},
    {"id": "hardware-video-decoding", "title": "Settings checkbox for media.hardware-video-decoding.enabled, with a restart prompt",
     "detect": [("src/browser/components/preferences", r"media\.hardware-video-decoding\.enabled")]},
    {"id": "dock-badge", "title": "Dock icon badge (download count) and one bounce when a download finishes in the background",
     # Specifically the macOS Dock tile (not Zen's own unread-downloads
     # badge on the Library toolbar button, zen-library-badge).
     "detect": [("src/zen", r"(?i)dock[\w-]*badge|badge[\w-]*dock|macdocksupport[^\n]*badgeText")]},
    {"id": "quick-look", "title": "Quick Look (Space, or the context menu) on a finished download, via qlmanage",
     "detect": [("src/zen", r"(?i)qlmanage|QLPreviewPanel")]},
    {"id": "drag-downloads", "title": "A panel stays open while you drag a download out of it into a site",
     "detect": [("src/zen", r"(?i)noautohide[^\n]*drag|drag[^\n]*noautohide")]},
    {"id": "sidebar-nav", "title": "Cmd+Opt+Up/Down walks the sidebar's tabs; Focus Sidebar (a command; assign a shortcut in Settings) for arrow-key/Enter/Delete/Esc; Space opens a Glance",
     "detect": [("src/zen", r"(?i)focus-?sidebar|whimsy-tab-next")]},
    {"id": "cheatsheet", "title": "Shortcut cheat sheet (Cmd+/): a searchable, centred panel of Whimsy's own shortcuts, with a link to about:keyboard",
     "detect": [("src/zen", r"(?i)cheat-?sheet")]},
    {"id": "inbox-zero", "title": "Inbox-zero balloons: a small celebration when a mail tab's unread count hits 0",
     "detect": [("src/zen", r"(?i)inbox-?zero")]},
    {"id": "site-user-agent", "title": "Per-site user agent (\"Pretend to be...\"): Chrome, Safari (macOS/iPhone) or custom, per site",
     "detect": [("src/zen", r"(?i)pretend to be|site-?user-?agent|per-?site.*user.?agent")]},
    {"id": "cookie-editor", "title": "Cookie editor: list, edit, add, delete and copy-as-JSON a site's cookies",
     "detect": [("src/zen", r"(?i)cookie-?editor")]},
    {"id": "url-schemes", "title": "whimsy:// links: internal pages from the address bar, and open/new-tab links (optionally in a space) from other apps",
     "detect": [("src/zen", r"(?i)whimsy://|url-?schemes")]},
    {"id": "upload-clipboard", "title": "Opera's Easy Files: clicking an upload button offers the clipboard image, recent downloads, or the native picker",
     "detect": [("src/zen", r"(?i)mozSetFileArray|easy-?files|upload-?clipboard")]},
    {"id": "dev-mode", "title": "Developer mode tabs (Arc parity): localhost/port tabs get a striped outline and a top bar with Console/Network/Elements",
     "detect": [("src/zen", r"(?i)dev-?mode[\w-]*tab|whimsy-devmode")]},
    # linear: Linear live folder ("My Issues": assigned to you, open states).
    {"id": "live-folders-linear", "title": "Linear live folder: \"My Issues\" assigned to you, open states, over your linear.app sign-in (API key optional)",
     "detect": [("src/zen/live-folders", r"(?i)linear")]},

    # batch7b: offline game + year in tabs (about:whimsy)
    {"id": "game", "title": "A small original Balloon-Fight-style canvas game (Retro/Gradient style) at whimsy://game, linked from the offline/net-error page",
     # Never matches: Firefox has no offline game in this engine.
     "detect": [("prefs", r"name:\s*browser\.offline\.game\.enabled")]},
    {"id": "year-in-tabs", "title": "Year in tabs: a private, on-device recap (top sites, busiest day/hour, tabs opened, longest-open tab) at whimsy://year",
     # Never matches: nothing like this ships upstream.
     "detect": [("prefs", r"name:\s*browser\.year-in-review\.enabled")]},
    # wave1/fun: Whimsy network error branding
    {"id": "net-error-branding", "title": "Whimsy network error illustrations",
     "detect": [("prefs", r"name:\s*browser\.neterror\.whimsy-branding")]},
    # tierC-claude: the Claude space (Claude in Chrome parity via a local MCP server).
    {"id": "claude-space", "title": "Claude space: a local MCP server lets Claude Code read and use tabs in a dedicated Claude space (off until turned on in Settings)",
     "detect": [("src/zen", r"(?i)mcp-?server|claude-?space|modelcontextprotocol")]},
    # meeting: Next meeting in the sidebar.
    {"id": "next-meeting", "title": "Next meeting in the sidebar: Apple Calendar and Google Calendar accounts, a Join button for Meet/Zoom/Teams, and a card 15 min before",
     "detect": [("src/zen", r"(?i)EKEventStore|next-?meeting|meeting-?chip")]},
    # ext: per-space extensions (toolbar/panel visibility per space, plus
    # container-scoped tabs/webNavigation/webRequest/proxy isolation where a
    # space has its own container). Zen has nothing for this.
    {"id": "space-extensions", "title": "Extensions per profile: \"Run in Profiles\" on each extension's menu; outside them its tabs/webRequest/proxy APIs and content scripts are kept out (shared storage stays shared)",
     "detect": [("src/zen", r"(?i)per-?space[\w-]*extension|extension[\w-]*per-?space|space[\w-]*scoped[\w-]*extension")]},
    # batch hist: per-visit space metadata and Library filter.
    {"id": "space-history", "title": "Space-aware History: where was the tab, and filter by space",
     "detect": [("src/zen/library", r"(?i)history[^\n]*(?:workspaceId|spaceId)|(?:workspaceId|spaceId)[^\n]*history")]},
    # home: homepage + changelog.
    {"id": "home", "title": "Whimsy's homepage (about:whimsy) with a Changelog tab, replacing Zen's about:home",
     "detect": [("src/zen", r"(?i)about:whimsy")]},
    # tierC-vpn: VPN (Firefox's built-in IP Protection, on by default; command
    # bar "Turn VPN On/Off" and a Settings status card on top of Firefox's own
    # toolbar button/panel, sign-in and per-site rules).
    {"id": "vpn", "title": "VPN: command bar actions and a Settings status card for Firefox's own built-in IP Protection",
     "detect": [("src/zen", r"(?i)zen[\w.-]*vpn|ZenVPN|zen[\w.-]*ip-?protection")]},
    # vpnspace: container scope on Firefox's native VPN panel.
    {"id": "vpnspace", "title": "VPN scope: whole browser or the current space's container",
     "detect": [("src/zen", r"(?i)ZenVPN|zen[\w.-]*vpn[\w.-]*scope")]},
    # wave3/private: reading RSS live folders.
    {"id": "live-folders-unread", "title": "RSS live folders show an unread count; unopened items get a dot",
     "detect": [("src/zen/live-folders", r"(?i)unread")]},
    {"id": "live-folders-rss-reader", "title": "RSS live-folder items open in Reader View (per-folder option)",
     "detect": [("src/zen/live-folders", r"(?i)about:reader")]},
    # wave3/private: floating calls.
    {"id": "call-pip", "title": "Floating calls: a Meet/Zoom/Teams call's video goes picture-in-picture when you leave its tab (Arc)",
     "detect": [("src/zen", r"(?i)call-?pip|meet[^\n]*picture-?in-?picture")]},
    # batch3glance: Glance size (Compact / Standard / Wide).
    {"id": "glance-size", "title": "Glance size: Compact, Standard (Zen's 80%) or Wide",
     "detect": [("src/zen/glance", r"glance\.(?:size|width)")]},
    # batch3glance: Cmd+T in a split opens into the focused pane (Arc).
    {"id": "split-new-tab", "title": "Cmd+T in a split view opens the result in the focused pane (Arc)",
     "detect": [("src/zen/split-view", r"(?i)newTabInSplit|replaceFocusedPane")]},
    # batch3glance: Arc's Add Left/Right/Top/Bottom Split + Change Orientation.
    {"id": "split-layouts", "title": "Add Left/Right/Top/Bottom Split and Change Orientation in the command bar (Arc)",
     "detect": [("src/zen", r"(?i)(?:add-(?:left|top|bottom)-split|change-?orientation)")]},
    # batch3glance: restored splits keep every pane (zen#12403).
    {"id": "split-restore", "title": "Restored splits keep every pane even when the saved layout lost one (zen#12403)",
     "detect": [("src/zen/split-view", r"(?i)layoutMatches|validateLayout|12403")]},
    # wave3/cmdbar: recent tabs in the empty command bar (Arc).
    {"id": "command-bar-recent-tabs", "title": "Recent tabs when the command bar opens empty, like Arc",
     "detect": [("src/zen/urlbar", r"(?i)recent-?tabs|tabsByLastAccessed")]},
    # wave3/cmdbar: DuckDuckGo-style bangs resolved locally.
    {"id": "offline-bangs", "title": "Offline bang shortcuts (!w, !yt, !gh...) with any search engine, editable in Settings",
     "detect": [("src/zen", r"(?i)\bbangs?\b(?!-)|duckduckgo\.com/bang")]},
    # batch hover: History hover cards (saved thumbnail, else title + URL).
    {"id": "history-preview", "title": "Hover a History entry in the Library to see its saved preview, title and address",
     "detect": [("src/zen/library", r"PageThumbs")]},
    # batch hover: People cards (Arc parity) for GitHub, LinkedIn and X links.
    {"id": "people-cards", "title": "People cards: hover a GitHub, LinkedIn or X profile link to see who it is",
     "detect": [("src/zen", r"(?i)people.?cards?|profile.?(hover|card)")]},
    # fixC: transparency and interface font pages in Zen's onboarding.
    {"id": "welcome-look", "title": "Onboarding: transparency and interface font pages in Zen's first-run flow",
     "detect": [("src/zen/welcome", r"(?i)\b(transparency|translucency|interface[ -]?font|ui-font)\b")]},
    # fixD: splits + media.
    {"id": "split-four-panes", "title": "Splits up to four panes: Split Grid/Vertically/Horizontally re-lays out the current split; drop a 3rd/4th tab onto a split's tab in the sidebar",
     # Never matches until Zen lets its sidebar drop target a split's tab.
     "detect": [("src/zen/drag-and-drop", r"canDropIntoSplit|addTabToExistingSplit")]},
    {"id": "pip-auto-before-mute", "title": "Automatic picture-in-picture isn't blocked by background muting: the tab you leave gets a moment to pop out first (tabs and spaces)",
     "detect": [("src/zen", r"(?i)auto-?pip[\w-]*(?:mute|grace)|mute[\w-]*auto-?pip")]},
    # wave3/icons: Arc's space icon picker
    {"id": "space-icon-picker", "title": "Space icon picker as Arc's: Arc's 56 glyphs first (Zen's after), 8-across grid, current icon on a plate, closes on pick, emoji skin tones",
     "detect": [("src/zen/common/emojis", r"skin-?tone|skinTone|1f3fb|1F3FB|\\u\{1f3fb\}")]},
    # wave3/speed: speed control on videos (Video Speed Controller).
    {"id": "video-speed", "title": "Speed control on videos: point at a video to see its speed, type one or pick a quarter step (0.25–4×); remembered per site",
     "detect": [("src/zen/media", r"(?i)speed-?(overlay|controller)|video-?speed")]},

    # wave3/glass: native Liquid Glass behind the sidebar and toolbars (macOS 26+).
    {"id": "liquid-glass", "title": "Liquid Glass: the sidebar and toolbars on macOS 26's glass material (Settings, off by default)",
     "detect": [("src/widget/cocoa", r"NSGlassEffectView"), ("prefs", r"name:\s*zen\.[\w.-]*(liquid-glass|glass-effect)")]},

    # wave3: email-aliases. iCloud Hide My Email + Firefox Relay from a button in email fields.
    {"id": "email-aliases", "title": "Email aliases: iCloud Hide My Email or a Firefox Relay mask from a button in email fields",
     "detect": [("src/zen", r"(?i)hide.?my.?email|email.?alias")]},

    # wave3: handoff. Firefox's Handoff, minus private tabs and Scratch, URL only.
    {"id": "handoff", "title": "Handoff: continue pages on your other Apple devices, never private tabs or the Private Space",
     "detect": [("src/zen", r"(?i)zen\.handoff\.|handoff-(?:private|scratch)")]},

    # wave3: playlist. Brave Playlist v1: direct media files, saved for offline in Library.
    {"id": "playlist", "title": "Playlist: save videos and audio to Library -> Playlist and play them offline (direct files)",
     "detect": [("src/zen", r"(?i)\bplaylist\b")]},

    # wave3/ai: AI v1. The provider every Whimsy AI feature uses (Claude API
    # key, Apple on-device, local Ollama); no automatic cloud fallback.
    {"id": "ai-providers", "title": "AI provider picker: Claude API key, Apple on-device or local Ollama, with no automatic cloud fallback",
     "detect": [("src/zen", r"(?i)api\.anthropic\.com|FoundationModels|ollama")]},
    # W14 19: subscription sign-in for AI (Sign in with ChatGPT; the Claude
    # plan through the person's own Claude Code).
    {"id": "ai-openai-plan", "title": "Sign in with ChatGPT: use the ChatGPT plan for Whimsy AI",
     "detect": [("src/zen", r"(?i)dynamic_agent_client|chatgpt\.tokens\.use")]},
    {"id": "ai-claude-plan", "title": "Claude plan for Whimsy AI through the person's own Claude Code",
     "detect": [("src/zen", r"(?i)claude.{0,20}auth.{0,10}status")]},
    # wave3/ai: Arc Max's Tidy Tabs (broom on the Today line, sections with
    # headers) and tidy tab titles (a short name when a tab is pinned).
    {"id": "tidy-tabs", "title": "Tidy Tabs: the broom sorts a space's Today tabs into named sections (Arc Max)",
     "detect": [("src/zen", r"(?i)tidy-?tabs|smart-?tab-?group")]},
    {"id": "tidy-titles", "title": "Tidy tab titles: pinning a tab gives it a short AI name (Arc Max)",
     "detect": [("src/zen", r"(?i)tidy-?(tab-?)?titles|ai-?rename")]},
    # wave3/ai: Arc Max's Ask on Page (Cmd+F: "Find or Ask") and 5-second
    # previews (Shift-hover a link; plain hover on search results, X, HN).
    {"id": "ask-on-page", "title": "Ask on Page: when Cmd+F finds nothing, ask the AI about the page instead (Arc Max)",
     "detect": [("src/zen", r"(?i)ask-?on-?page|find-?or-?ask")]},
    {"id": "link-previews", "title": "5-second previews: Shift-hover a link for an AI summary of the page behind it (Arc Max)",
     "detect": [("src/zen", r"(?i)five-?second|5-?second-?preview|link-?preview[\w-]*summar")]},
    # wave3/ai: Watch a page (Safari's Notify Me): a plain-words condition,
    # checked on a schedule only while Whimsy runs, with the person's session.
    {"id": "page-watch", "title": "Watch a page: describe what to look for; Whimsy checks while open and alerts until dismissed (Safari Notify Me)",
     "detect": [("src/zen", r"(?i)page-?watch|notify-?me|watch-?(this-)?page")]},
    # wave5/lan: Local servers live folder: dev servers on localhost come and
    # go as tabs, polled only while the folder is visible.
    {"id": "live-folders-local-servers", "title": "Local servers live folder: running localhost dev servers as tabs that appear and disappear",
     "detect": [("src/zen/live-folders", r"(?i)local-?servers|localhost")]},
    # wave5: live blocks in Notes (Arc Easels' Live Captures).
    {"id": "note-blocks", "title": "Live blocks in Notes: /embed or drop a tab to keep a cropped, live region of a page in a note (Arc Live Captures)",
     "detect": [("src/zen", r"(?i)live-?capture|zen[\w-]*note[\w-]*block")]},
    # wave5/captions: live translated captions (CC in the speed control),
    # translated on-device by Firefox Translations.
    {"id": "video-captions", "title": "Translated captions: CC on a video's speed control shows its captions in your language, translated on your Mac",
     "detect": [("src/zen/media", r"(?i)(translated|live)-?captions|caption-?translat")]},
    # wave5/safety: the Claude space's prompt-injection shield.
    {"id": "claude-shield", "title": "Claude prompt-injection shield: hidden page text never reaches Claude, page content is marked untrusted, and pages that instruct Claude pause it (Continue / Stop)",
     "detect": [("src/zen", r"(?i)prompt-?injection")]},
    # wave5/safety: agent replay of Claude runs at whimsy://replay.
    {"id": "claude-replay", "title": "Claude replay: each Claude run is kept as a timeline of steps with page snapshots at whimsy://replay (never private tabs; Clear history clears it)",
     "detect": [("src/zen", r"(?i)agent-?replay|claude-?replay")]},
    # wave5/quick: QR code for any page. Firefox's QR dialog (SharingUtils),
    # exposed in the page menu and command bar; never for private tabs/Scratch.
    {"id": "qr-code", "title": "QR code for any page: the page menu and command bar open Firefox's QR dialog (not for private tabs or the Private Space)",
     "detect": [("src/zen", r"(?i)showQRCodePanel|qr-?code-?for-?page")]},
    # wave5/quick: Copy page as Markdown (MarkDownload/Obsidian clipper style;
    # Zen discussion #12557). Zen only copies [title](url).
    {"id": "copy-page-markdown", "title": "Copy Page as Markdown: the Reader View article (or a selection) as Markdown, from the page menu and command bar",
     "detect": [("src/zen", r"(?i)copy-?(page|selection)-?as-?markdown|pageToMarkdown|turndown")]},
    # wave5/quick: Markdown/CSV viewer (Typora/Marked/GitHub file view; built
    # like Firefox's JSON viewer: sniffer + stream converter, no page script).
    {"id": "doc-viewer", "title": "Markdown and CSV viewer: .md files read with reader typography and contents, CSV/TSV as a sortable table, Source toggle, live reload",
     "detect": [("src/zen", r"(?i)text/markdown|markdown-?viewer|csv-?viewer")]},
    # wave5/quick: link lasso (Linkclump/Snap Links): Option-drag over links
    # makes a folder of unloaded tabs named after the page.
    {"id": "link-lasso", "title": "Link lasso: Option-drag a rectangle over links, let go, and they become a folder of unloaded tabs",
     "detect": [("src/zen", r"(?i)link-?lasso|lasso-?links|linkclump|snap-?links")]},
    # wave5/quick: new season toast: the first window in a new season shows
    # one Zen toast with the costumed balloon (respects the seasonal switch).
    {"id": "season-toast", "title": "New season toast: the first window in a new season shows the balloon in its costume, once",
     "detect": [("src/zen", r"(?i)season-?toast|new-?season")]},
    # wave5/verbs: Cmd+K lists verbs for the selection (or page) in the
    # command bar: Translate, Search, Map, Email, Copy as Markdown, Add to
    # Note, Add to Calendar, Linear, and your own skills.
    {"id": "selection-verbs", "title": "Cmd+K: actions for the selected text or page (Translate, Map, Calendar, Linear, Markdown, Notes, your skills)",
     "detect": [("src/zen", r"(?i)selection-?verbs|do-?with-?selection|universal-?actions")]},
    # wave5: redact: a toggle in the Screenshots panel that blurs emails,
    # phones, keys/tokens and card numbers (click text to blur/unblur).
    {"id": "redact", "title": "Redact in screenshots: blur emails, phone numbers, keys and card numbers before capturing; click text to blur it",
     "detect": [("src/zen", r"(?i)redact")]},
    # W13 F04 / W15: one screenshot viewer (one Capture button after a drag) and its editor.
    {"id": "capture-card", "title": "Screenshots: one viewer for every capture (Add to Easel, Copy, Download, Edit, Save and Close; one Library file per save) and an editor with backdrop, shape, hiding private details and redacting by hand",
     "detect": [("src/zen", r"(?i)capture-?card|redact-?after")]},
    # wave5/look: a look per space (font, density, tab title lines, a Zen Mod).
    {"id": "space-look", "title": "A look per space: its own interface font, density, tab title lines and Zen Mod, switching with the space",
     "detect": [("src/zen/spaces", r"(?i)workspace\.(font|density|look)\b|space-?(font|density)")]},
    # wave5: Easel (Arc's Easels: canvas of text, drawings, shapes, images, links, captures).
    {"id": "easel", "title": "Easel: a canvas of text, drawings, shapes, images, links and live captures, pinned like a tab (Arc Easels)",
     "detect": [("src/zen", r"(?i)\beasels?\b")]},
    # wave5: command registry
    {"id": "command-registry", "title": "Every Whimsy action is a named command: in the command bar and under \"Whimsy\" in Settings → Keyboard Shortcuts, so any of them can take a shortcut",
     "detect": [("src/zen", r"(?i)WHIMSY_KEY_CATEGORIES|registerKeyCategor(y|ies)|extraKeyCategories")]},
    # wave5/audioicon: Arc's tab speaker: an outline speaker between favicon
    # and title on every tab with sound (muted included), one click mutes.
    {"id": "arc-audio-icon", "title": "Arc's tab speaker: outline speaker beside the title on every tab with sound, struck through when muted; click mutes",
     "detect": [("src/zen", r"(?i)tab-audio-(playing|muted)\.svg|arc-?audio-?icon")]},
    # wave5/profiles: Arc's profiles on containers (one Firefox profile/account).
    {"id": "space-profiles", "title": "Profiles: each space belongs to a profile (a container) with its own cookies, passwords, history, Essentials, search engine, downloads and extensions, like Arc",
     "detect": [("src/zen", r"(?i)zen[\w-]*space-?profiles|ZenProfiles\.sys|profile-?switcher")]},
    # wave6/zap: Zap as a command (Zen ships zap mode only inside the Boost
    # editor): Cmd+Shift+X, command bar, site panel, undo, space-colored dust.
    {"id": "zap", "title": "Zap: erase page elements with Cmd+Shift+X, the command bar or the site panel; undo, space-colored dust",
     "detect": [("src/zen", r"(?i)zen-action-zap|key_zenZap|cmd_zenZap|zen-zap-shortcut")]},
    # wave6/zap: Link hints (Vimium's f): letter badges on everything
    # clickable, type to click, Shift for a new tab.
    {"id": "link-hints", "title": "Link hints: Cmd+J puts letter badges on links and buttons; type one to click it, Shift for a new tab",
     "detect": [("src/zen", r"(?i)link-?hints|vimium|hint-?mode")]},
    # wave6/search: Instant result (Arc Max Instant Links) and the Search
    # Deck (flip through results in a Glance).
    {"id": "instant-result", "title": "Instant result: Shift+Enter on a search in the command bar opens the top result (Arc Max Instant Links)",
     "detect": [("src/zen", r"(?i)instant-?(result|link)s?")]},
    {"id": "search-deck", "title": "Search Deck: flip through search results one by one in a Glance; Cmd+Enter keeps one as a tab",
     "detect": [("src/zen", r"(?i)search-?deck|result-?deck")],
     "default": False},  # W10-52: opt-in; Shift+Enter goes straight to the top result (Arc).
    # wave6: Already open (Arc): Return on an address that's open in any
    # space goes to that tab instead of a duplicate. Zen already lists open
    # tabs as Switch to Tab results; this is only the typed-address case.
    {"id": "already-open", "title": "Already open: typing an address that's open in another tab or space takes you there instead of opening a copy (Arc)",
     "detect": [("src/zen", r"(?i)already-?open|dedupe-?tabs|prevent-?duplicate")]},
    # wave6: Trails (Horse, Nyxt): forward pages a new click would drop stay
    # as branches in the Back/Forward menu, plus where the tab came from.
    {"id": "trails", "title": "Trails: pages you went back from stay in the Back/Forward menu as branches, with where the tab came from",
     "detect": [("src/zen", r"(?i)OnHistoryTruncate\s*[(:]\s*\w|history-?tree|branch(ing)?-?history")]},
    # wave6: Page actions (Safari Highlights): schema.org JSON-LD/microdata
    # on the page -> one address bar pill (Calendar, Maps, Cook mode...).
    {"id": "page-actions", "title": "Page actions: add events to Calendar, open places in Maps, cook mode for recipes, from the page's own data (Safari Highlights)",
     "detect": [("src/zen", r"(?i)application/ld\+json|schema\.org/(Event|Recipe)|page-?actions?-?pill")]},
    # wave6/parity: Arc's Option+click a tab to split it with the current one.
    {"id": "split-alt-click", "title": "Option+click a tab in the sidebar to open it in a split with the current tab (Arc)",
     "detect": [("src/zen/split-view", r"(?i)alt-?click|altKey")]},
    {"id": "split-arc-keys", "title": "Arc's Split View commands: Add Split View (Ctrl+Shift+=), Close this Split Pane (Ctrl+Shift+-), Separate Page, Expand Current Split, Ctrl+Shift+1-4 and [ ] to move between panes",
     "detect": [("src/zen/split-view", r"(?i)separate-?page|focus-?pane|cmd_zenSplitView(Focus|Next|Prev)")]},
    # W10-27: the floating command bar's open/close motion.
    {"id": "command-bar-motion", "title": "Command bar: a quick, subtle open and close (160ms in, 110ms out; a plain fade with Reduce Motion)",
     "detect": [("src/zen/urlbar", r"(?i)(urlbar|command-?bar)-?(open|close)-?(animation|motion)")]},
    {"id": "command-bar-dedup", "title": "Command bar: one row per page title on Figma, Notion, GitHub and Arc's other 7 hosts (Arc's dedupByTitleAndHost)",
     "detect": [("src/zen/urlbar", r"(?i)dedup")]},
    {"id": "arc-menus", "title": "Arc's menu bar: a Tabs menu, Arc's names (Hide Sidebar, Blank Window, New Space..., Undo Archive Tab), Show Toolbar, Reveal Tab in Sidebar, Capture in Portrait Mode, Help > Essential Keyboard Shortcuts",
     "detect": [("src/zen/common", r"(?i)reveal-?tab|tabs-menubar|portrait")]},
    # wave7/menus2: archive-tab-menu
    {"id": "archive-tab-menu", "title": "Tab menu in Arc's words: Archive Tab, Archive Tabs Below, Restore Last Closed Tab (closed tabs go to the Archive)",
     "detect": [("src/zen/tabs", r"(?i)archive-?tabs?-?below")]},
    # wave7/ux: link cards. One hover host for page links: the People card
    # or a link card, and the AI summary stacked beneath when that's on.
    {"id": "link-cards", "title": "Link cards: Shift over a link (or rest on a result link) shows where it goes, with the AI summary beneath",
     "detect": [("src/zen", r"(?i)zen-?link-?(hover-?)?card|zenLinkPreview")]},
    # wave7/focus: Do Not Disturb: one command pauses site notifications
    # (Firefox's "pause until restart"; macOS Focus already silences them
    # through Notification Center) and holds Whimsy's unprompted toasts.
    {"id": "do-not-disturb", "title": "Do Not Disturb: one command pauses site notifications until you turn it off or quit, and holds Whimsy's unprompted toasts",
     "detect": [("src/zen", r"(?i)manualDoNotDisturb|suppressForScreenSharing|do-?not-?disturb")]},
    # wave7/focus: paste guard: asks before a secret-looking paste
    # (API key, private key, card number, JWT) reaches a web page.
    {"id": "paste-guard", "title": "Paste guard: asks before you paste something that looks like an API key, private key, card number or sign-in token into a web page",
     "detect": [("src/zen", r"(?i)paste-?guard|looks like an? (api key|secret)")]},
    # wave7/teach: Teach once: one small anchored hint the first time a
    # feature could help (its shortcut, or what just happened), then never
    # again; "Show tips" in Settings, "Reset Tips" in the command bar.
    {"id": "teach-once", "title": "Teach once: one small hint the first time a shortcut or feature could help, then never again",
     "detect": [("src/zen", r"(?i)teach-?once|first-?use-?hints?|zen\.tips\.")]},
    # wave7/spaceanim: space-switch slides play one at a time (Arc).
    {"id": "space-switch-queue", "title": "Space switches play one at a time (Arc): a switch asked for mid-slide waits for the slide to finish; swipes step, keys coalesce",
     "detect": [("src/zen/spaces", r"(?i)switchQueue|pendingSwitch|queueWorkspaceChange|whimsyStep")]},
    # wave7/split: a split pane's actions on the pane (hover header ⋯ menu).
    {"id": "split-pane-menu", "title": "Split pane menu: a ⋯ button on each pane's header holds Arc's per-pane actions (Separate from Split View, Share, Mute, Copy Link, Copy link as Markdown, Archive Item); optionally always-visible headers like Arc's",
     "detect": [("src/zen/split-view", r"(?i)pane-?menu|splitter-header[^\n]*menupopup|header-menu")]},
    # batch wave7/split2: Arc's right-click menu on a split's sidebar row.
    {"id": "split-row-menu", "title": "Split row menu: right-clicking a split in the sidebar opens Arc's split menu (Share Split View, Separate All Tabs, Add Tab, Convert to Vertical/Horizontal, a submenu per pane, Change Icon, Rename, Duplicate, Move to, Archive)",
     "detect": [("src/zen/split-view", r"(?i)convert-?to-?(vertical|horizontal)|split-?row-?menu")]},
    # wave7/menuprefs: menu-prefs
    {"id": "menu-prefs", "title": "Settings → Menus: turn any right-click menu item on or off (tab, link, page, selection, image, space, sidebar, folder and split menus)",
     "detect": [("src/zen", r"(?i)context-?menu-?(items?-?)?(visibility|customi[sz])|hidden-?menu-?items")]},
    # w7native: live captions from a video's speech when it has none (Apple's
    # on-device speech recognizer, then the translated-captions path).
    {"id": "video-speech-captions", "title": "Live captions for videos without any: CC turns the video's speech into captions on your Mac, then translates them",
     "detect": [("src/zen/media", r"(?i)speech-?to-?text|SFSpeechRecognizer|live-?transcri")]},
    # wave7/small: Cast to AirPlay (Arc's View > Cast...), a native AVPlayer
    # and AVKit route picker for the page's video; Screen Mirroring otherwise.
    {"id": "cast", "title": "Cast to AirPlay: send the page's video to an Apple TV or AirPlay screen (View > Cast...)",
     "detect": [("src/zen", r"(?i)airplay|AVRoutePicker|cast-?to-?tv")]},
    # wave7/small: Arc's Move to > New Space... (tab menu, split row menu,
    # command bar) moves the tab or its whole split into the new space.
    {"id": "move-to-new-space", "title": "Move to > New Space...: make a space and move the tab (or its whole split) into it (Arc)",
     "detect": [("src/zen", r"(?i)move-?to-?new-?(space|workspace)")]},
    # wave8/folders: Live folders: a Resync option that brings back tabs closed by hand (W8-26).
    {"id": "live-folders-resync", "title": "Resync live folder: bring back tabs closed by hand",
     "detect": [("src/zen/live-folders", r"(?i)resync")]},
    # wave9/menus: W9-09 right-click <-> command parity.
    {"id": "menu-parity", "title": "Right-click and command parity: every menu action is a command (no default shortcut), more commands as menu items (most off until turned on in Settings > Menus), Share submenu lists the share services",
     "detect": [("src/zen", r"(?i)sharingServicesForItems|menu-?command-?parity")]},
    # wave9: Battery saver (Arc parity: threshold <20%, banner, auto-off when charged, frame rate and background throttles)
    {"id": "battery-saver", "title": "Battery Saver: throttle frame rate (30fps) and background activity below 20% battery, with heads-up banner and auto-off when charged (Arc parity)",
     "detect": [("src/zen", r"(?i)battery-?saver")]},
    # batch wave9: form protection (W9-03)
    {"id": "form-protection", "title": "Form protection: tabs with half-filled forms are exempt from auto-archive and show a subtle indicator",
     "detect": [("src/zen", r"(?i)form-?protection|whimsy-?form-?protected")]},
    # batch9: W9-06 smart address bar buttons (Reader, Translate, media, Downloads in progress)
    {"id": "smart-buttons", "title": "Smart address bar buttons: Reader, Translate, media and Downloads in progress beside the address bar when relevant",
     "detect": [("src/zen", r"(?i)smart-?(address-?bar|buttons)")]},
    # wave9: Font Inspector (What Font Is This?)
    {"id": "font-inspector", "title": "Font Inspector: What Font Is This? Popover with rendered font, size, weight, line-height, spacing, and colour",
     "detect": [("src/zen", r"(?i)font-?inspector|what-?font-?is-?this")]},
    # wave9: Element inspector lite
    {"id": "element-inspector", "title": "Element Inspector lite: box model, colours, contrast ratio, gap measurement, and Open in DevTools",
     "detect": [("src/zen", r"(?i)element-?inspector-?lite|measure-?gap")]},
    # wave9/pagedev: page developer tools (Lens browser's developer menu)
    {"id": "page-dev", "title": "Page developer tools: Fonts on This Page, Page Colors (palette and contrast) and Built With (tech stack), in Tools > Browser Tools",
     "detect": [("src/zen", r"(?i)fonts-?on-?this-?page|built-?with-?(panel|detect)")]},
    # wave9/mini: W8-23 a site's popup window (a sign-in window) shows
    # Firefox's read-only address bar and identity in the top strip.
    {"id": "site-popup-chrome", "title": "Sign-in popups show their address: a site's popup window keeps Firefox's read-only address bar and identity",
     "detect": [("src/zen", r"(?i)popup-?window[^\n]{0,80}(nav-?bar|urlbar)[^\n]{0,40}visib")]},
    # wave9: W9-04 site settings (Lens's "Settings for each site"): a "This
    # Site" section in Zen's site panel for zoom, autoplay, always Reader,
    # full screen and the user agent, each forgettable, plus Forget All.
    {"id": "site-settings", "title": "Site settings: the site panel remembers a site's zoom, autoplay, Reader View, full screen and user agent, and forgets them one by one or all at once",
     "detect": [("src/zen", r"(?i)always-?open-?in-?reader|per-?site-?settings|site-?settings-?section")]},
    # batch10: view-source line wrap (W10-34)
    {"id": "view-source-wrap", "title": "View Page Source line wrap option and command",
     "detect": [("src/zen", r"(?i)view-?source.*(?:line-?wrap|wrap-?long-?lines)|wrap-?long-?lines.*view-?source")]},
    # wave10/mini: W10-13 Mini Whimsy's pages as pill tabs (popups as tabs,
    # links reuse the open Mini, Cmd+O moves them all).
    {"id": "mini-tabs", "title": "Mini Whimsy tabs: pill tabs from the second page, sign-in popups as tabs, links from other apps join the open Mini, Cmd+O moves every page",
     "detect": [("src/zen", r"(?i)zen[\w.-]*(quick|mini)[\w.-]*window[\w.-]*tabs")]},
    # wave10 (W10-12): every setting is a command (Turn ... On/Off, a choice,
    # Increase/Decrease) with an assignable shortcut, and Settings search
    # finds it by its short name and other words.
    {"id": "settings-commands", "title": "Every setting is a command: turn any Whimsy setting on or off (or pick its choice) from the command bar or a shortcut, and find it in Settings by its name",
     "detect": [("src/zen", r"(?i)settings?-?toggle-?commands?|pref-?toggle-?actions?")]},
    # wave10 (W10-61): Arc's "press again": a page that uses a browser key
    # gets the first press, the browser acts on the second one in a row.
    {"id": "press-again", "title": "Press again: when a page uses a browser shortcut (⌘S, ⇧⌘C, ...) the page gets the first press and a second press in a row runs the browser's command (Arc)",
     "detect": [("src/zen/kbs", r"(?i)press-?again|double-?press")]},
    # wave10 (W10-03): Next Space past the last space makes a new space;
    # Previous Space stops at the first (Arc).
    {"id": "space-edges", "title": "Space edges (Arc): Next Space past the last space opens New Space; Previous Space stops at the first",
     "detect": [("src/zen/spaces", r"(?i)past-?(the-?)?last-?space|create-?space-?at-?end")]},
    # wave11 (W11-13): Zen's Move To from a private window, done by reopening
    # each page in the space (never carrying private data), plus Move Out of
    # Private… for one tab.
    {"id": "private-move", "title": "Move out of private: Move To in a private window, and Move Out of Private… on a private tab, reopen the pages in a space you pick, after asking",
     "detect": [("src/zen", r"(?i)move-?(tabs?-?)?out-?of-?private")]},
    # wave11 (W11-14): lock private tabs, the Private Space and private
    # windows behind Touch ID or the Mac password.
    {"id": "private-lock", "title": "Private lock: private tabs, the Private Space and private windows hide behind Touch ID or your Mac password when you step away",
     "detect": [("src/zen", r"(?i)lock-?private-?(browsing|tabs|windows)")]},
    # wave13 (R3): a call's microphone and camera follow the page's own
    # toggles (Meet) in the small player and in picture-in-picture.
    {"id": "call-controls", "title": "Call controls: the small player and picture-in-picture toggle a Meet call's own microphone and camera, in sync with the page",
     "detect": [("src/zen/media", r"data-is-muted")]},
    # W23 (AI, owned by lane ai-base): every W23 feature's switch.
    {"id": "ai-chat", "title": "AI chat: ⌘E opens a chat about this tab beside the page, per tab, kept on this Mac",
     "detect": [("src/zen", r"(?i)zen[-_.]?ai[-_.]?chat|ZenChat|zen-?chat-?panel")]},
    {"id": "ai-ask", "title": "Ask AI in the command bar: type a question, press ⌘↩, the answer shows under the bar",
     "detect": [("src/zen", r"(?i)zen[-_.]?ai[-_.]?ask|urlbar[\w-]*ask[-_]?ai")]},
    {"id": "ai-updates", "title": "Updates in the command bar: routine, watch, research, and agent results at the top, with Remind me and Dismiss",
     "detect": [("src/zen", r"(?i)zen[-_.]?(ai[-_.]?)?updates[-_.]?feed|urlbar[\w-]*updates[-_]?section")]},
    {"id": "ai-context-commands", "title": "⌘K knows the page: AI commands for what's on screen (summarize, translate, ask)",
     "detect": [("src/zen", r"(?i)zen[-_.]?ai[-_.]?(context|page)[-_.]?(commands|actions)")]},
    {"id": "ai-selection-commands", "title": "AI on selected text: right-click rows and a result card",
     "detect": [("src/zen", r"(?i)zen[-_.]?ai[-_.]?selection|context_?ai[-_]?(selection|rewrite)")]},
    {"id": "ai-commands", "title": "Commands: saved prompts you run from ⌘K, right-click, and the command bar",
     "detect": [("src/zen", r"(?i)zen[-_.]?ai[-_.]?commands|ZenPromptCommands")]},
    {"id": "ai-related", "title": "Related results: the command bar finds pages by meaning from an on-device index",
     "detect": [("src/zen", r"(?i)zen[-_.]?(semantic|meaning)[-_.]?(index|search)|ZenEmbeddings")]},
    {"id": "ai-memory", "title": "Memory: stable facts about you, saved automatically with Undo, used in answers",
     "detect": [("src/zen", r"(?i)zen[-_.]?ai[-_.]?memory|ZenMemory")]},
    {"id": "ai-agent", "title": "Agent: Drive (every step in your tabs) or Background, with pauses before anything risky",
     "detect": [("src/zen", r"(?i)zen[-_.]?(ai[-_.]?)?agent\b|ZenAgent")]},
    {"id": "ai-task-folder", "title": "Task folders: an agent's tabs sit in their own unpinned folder that dissolves when done",
     "detect": [("src/zen", r"(?i)zen[-_.]?task[-_.]?folder|unpinned[-_.]?folder")]},
    {"id": "ai-outside-agents", "title": "Outside agents: Claude Code and other apps work in your tabs through Whimsy's connector, under the same rules",
     "detect": [("src/zen", r"(?i)zen[-_.]?(mcp|outside[-_.]?agents?)[-_.]?server")]},
    {"id": "ai-activity", "title": "Activity: a local record of what agents did, cleared by the Fire button",
     "detect": [("src/zen", r"(?i)zen[-_.]?(ai|agent)[-_.]?activity")]},
    {"id": "ai-connectors", "title": "Connectors: Google, Microsoft, Apple Calendar, Granola, Linear, Jira, and MCP servers as AI context",
     "detect": [("src/zen", r"(?i)zen[-_.]?(ai[-_.]?)?connectors?\b|ZenConnector")]},
    {"id": "ai-onboarding", "title": "AI onboarding: connect a model, then connectors, then a short celebration",
     "detect": [("src/zen", r"(?i)zen[-_.]?ai[-_.]?onboarding")]},
    {"id": "ai-hints", "title": "AI hints: one toast per surface, once ever, three a day, never a halo",
     "detect": [("src/zen", r"(?i)zen[-_.]?(ai[-_.]?)?(hints?|discovery)[-_.]?toast")]},
    {"id": "ai-summary", "title": "Page summary: a summary with passage chips, for long pages and PDFs too",
     "detect": [("src/zen", r"(?i)zen[-_.]?ai[-_.]?summar")]},
    {"id": "ai-draft-reply", "title": "Draft reply: AI drafts a reply in the field you're writing in",
     "detect": [("src/zen", r"(?i)zen[-_.]?(ai[-_.]?)?draft[-_.]?reply")]},
    {"id": "ai-form-fill", "title": "Form fill: AI fills a form from what you tell it, never card, password, or code fields",
     "detect": [("src/zen", r"(?i)zen[-_.]?ai[-_.]?(form[-_.]?)?fill")]},
    {"id": "ai-translate", "title": "Translate with AI: pick the page's language or yours, and translate a selection in place",
     "detect": [("src/zen", r"(?i)zen[-_.]?ai[-_.]?translat")]},
    {"id": "ai-page-edits", "title": "Page edits by description: change a page's look in words, kept as a Boost or a zap",
     "detect": [("src/zen", r"(?i)zen[-_.]?(ai[-_.]?)?page[-_.]?edits?")]},
    {"id": "ai-scam-warning", "title": "Scam warning: a calm bar when a page looks like a scam, with what looks off",
     "detect": [("src/zen", r"(?i)zen[-_.]?(ai[-_.]?)?scam")]},
    {"id": "ai-compare", "title": "Compare: true prices across stores, read in a hidden reader",
     "detect": [("src/zen", r"(?i)zen[-_.]?(ai[-_.]?)?(price[-_.]?)?compare")]},
    {"id": "ai-tab-requests", "title": "Tab requests: ask chat to open, close, group, or find tabs",
     "detect": [("src/zen", r"(?i)zen[-_.]?(ai[-_.]?)?tab[-_.]?requests?")]},
    {"id": "find-card", "title": "Find as a floating card at the top right, with Ask",
     "detect": [("src/zen", r"(?i)zen[-_.]?find[-_.]?(card|floating)")]},
    {"id": "ai-video-summary", "title": "Summarize a video: summary, chapters, and transcript in chat; timestamps jump the video",
     "detect": [("src/zen", r"(?i)zen[-_.]?(ai[-_.]?)?video[-_.]?summar")]},
    {"id": "video-speed-range", "title": "Video speed from 1/16× to 16×",
     "detect": [("src/zen", r"(?i)playbackRate[^\n]{0,40}\b16\b")]},
    {"id": "video-default-speed", "title": "Back to default speed: one press returns a video to your usual speed",
     "detect": [("src/zen", r"(?i)zen[-_.]?(video[-_.]?)?default[-_.]?speed")]},
    {"id": "image-text", "title": "Text in images: select, copy, and find text in images, recognized on this Mac",
     "detect": [("src/zen", r"(?i)zen[-_.]?image[-_.]?text|TextRecognition[^\n]{0,40}zen")]},
    {"id": "read-aloud", "title": "Read aloud: listen to a page with a mini player, on this Mac",
     "detect": [("src/zen", r"(?i)zen[-_.]?read[-_.]?aloud")]},
    {"id": "dictation", "title": "Dictation: hold Fn to dictate into the focused field, on this Mac",
     "detect": [("src/zen", r"(?i)zen[-_.]?dictation")]},
    {"id": "media-settings", "title": "Settings › Media: speed, captions, summaries, read aloud, and dictation in one page",
     "detect": [("src/zen", r"(?i)zen[-_.]?media[-_.]?settings|paneMedia")]},
    {"id": "routines", "title": "Routines: AI runs on a schedule or a trigger and leaves results in Updates and a thread",
     "detect": [("src/zen", r"(?i)zen[-_.]?routines?")]},
]


def path(rel):
    return os.path.join(ROOT, rel)


def read(rel):
    with open(path(rel), encoding="utf-8") as f:
        return f.read()


def write(rel, text):
    with open(path(rel), "w", encoding="utf-8") as f:
        f.write(text)


def is_whimsy_path(rel):
    parts = rel.split("/")
    return (rel.startswith(("whimsy/", "src/zen/whimsy/", "prefs/whimsy/", "configs/branding/"))
            or any(p.startswith("whimsy") for p in parts))


def upstream_files(under):
    out = []
    for base, dirs, files in os.walk(path(under)):
        dirs[:] = [d for d in dirs if d not in ("node_modules", "__pycache__")]
        for name in files:
            rel = os.path.relpath(os.path.join(base, name), ROOT)
            if not is_whimsy_path(rel):
                out.append(rel)
    return out


def detect_superseded():
    superseded = []
    for feature in FEATURES:
        for under, pattern in feature["detect"]:
            rx = re.compile(pattern)
            hit = None
            for rel in upstream_files(under):
                if not rel.endswith((".mjs", ".js", ".ftl", ".yaml", ".xhtml", ".css", ".patch", ".mm", ".idl")):
                    continue
                try:
                    text = read(rel)
                except (UnicodeDecodeError, OSError):
                    continue
                # Lines Whimsy itself put into Zen files don't count.
                text = "\n".join(l for l in text.splitlines() if "Whimsy" not in l)
                if rx.search(text):
                    hit = rel
                    break
            if hit:
                superseded.append({"id": feature["id"], "title": feature["title"], "found_in": hit})
                break
    return superseded


def apply_hooks(report, dry):
    for hook_id, rel, anchor, line, where in HOOKS:
        if not os.path.exists(path(rel)):
            report["problems"].append(f"hook {hook_id}: {rel} no longer exists")
            continue
        lines = read(rel).split("\n")
        wanted = line.replace("{indent}", "").strip()
        if any(l.strip() == wanted for l in lines):
            report["hooks"].append({"id": hook_id, "status": "present"})
            continue
        rx = re.compile(anchor)
        for i, l in enumerate(lines):
            m = rx.match(l)
            if m:
                indent = m.group(1) if m.groups() else ""
                text = line.replace("{indent}", indent)
                lines.insert(i + 1 if where == "after" else i, text)
                if not dry:
                    write(rel, "\n".join(lines))
                report["hooks"].append({"id": hook_id, "status": "applied" if not dry else "missing"})
                break
        else:
            report["problems"].append(f"hook {hook_id}: anchor not found in {rel}")


def apply_hotfixes(report, dry):
    for fix in HOTFIXES:
        text = read(fix["file"]) if os.path.exists(path(fix["file"])) else ""
        if fix["new"] in text:
            report["hotfixes"].append({"id": fix["id"], "status": "present"})
        elif fix["old"] in text:
            if not dry:
                write(fix["file"], text.replace(fix["old"], fix["new"], 1))
            report["hotfixes"].append({"id": fix["id"], "status": "applied" if not dry else "missing"})
        else:
            # Zen changed this code, so presumably fixed it its own way.
            report["hotfixes"].append({"id": fix["id"], "status": "obsolete (Zen changed the code)"})


def apply_json_overrides(report, dry):
    rel = "surfer.json"
    c = json.loads(read(rel))
    before = json.dumps(c, sort_keys=True)
    c["name"], c["vendor"], c["appId"] = "Whimsy", "Whimsy", "whimsy"
    c.pop("updateHostname", None)
    names = {"release": ("Whimsy", "Whimsy", "Whimsy"),
             "twilight": ("Whimsy", "Whimsy Twilight", "Whimsy Twilight")}
    for brand, (shorter, short, full) in names.items():
        b = c.get("brands", {}).get(brand)
        if b:
            b["brandShorterName"], b["brandShortName"], b["brandFullName"] = shorter, short, full
            b.get("release", {}).pop("github", None)
    if json.dumps(c, sort_keys=True) != before:
        if not dry:
            write(rel, json.dumps(c, indent=2) + "\n")
        report["overrides"].append({"file": rel, "status": "applied" if not dry else "missing"})

    rel = "package.json"
    c = json.loads(read(rel))
    s = c["scripts"]
    before = json.dumps(s)
    wanted = {
        "import:strings": "python3 scripts/copy_language_pack.py en-US",
        "postbuild": "sh whimsy/install_app.sh",
        "postbuild:ui": "sh whimsy/install_app.sh",
        "install:app": "sh whimsy/install_app.sh",
        "ship": "python3 whimsy/updater/updater.py ship",
        # wave9/release: move the release tag to a verified dev commit.
        "promote": "python3 whimsy/updater/updater.py promote",
        # Pin the brand like "ci" does (`surfer build` has no --brand), so a
        # fresh clone can't build Nightly.app from surfer's default brand.
        "build": "surfer set brand release && surfer build",
        "build:ui": "surfer set brand release && surfer build --ui",
    }
    if "import:strings" not in s.get("import", ""):
        s["import"] = s["import"] + " && npm run import:strings"
    if "whimsy/engine_prepare.py" not in s["import"]:
        s["import"] = s["import"].replace("surfer import", "python3 whimsy/engine_prepare.py && surfer import", 1)
    if "whimsy/engine_overrides.py" not in s["import"]:
        s["import"] = s["import"] + " && python3 whimsy/engine_overrides.py"
    items = list(s.items())
    for key, value in wanted.items():
        if s.get(key) != value:
            s[key] = value
            items = list(s.items())
    if json.dumps(s) != before:
        c["scripts"] = dict(items)
        if not dry:
            write(rel, json.dumps(c, indent=2) + "\n")
        report["overrides"].append({"file": rel, "status": "applied" if not dry else "missing"})


def apply_update_host(report, dry):
    """Zen's build patch hard-codes Zen's update server. Point it at Whimsy's,
    so Whimsy never offers Zen's own updates."""
    rel = "src/build/moz-build.patch"
    host = json.loads(read("whimsy/publish.json"))["update_host"]
    text = read(rel)
    new = re.sub(r'(\+\s*appini_defines\["MOZ_APPUPDATE_HOST"\] = ")[^"]+(")', r"\g<1>" + host + r"\g<2>", text)
    if host not in new:
        report["problems"].append("update host: Zen's build patch no longer sets MOZ_APPUPDATE_HOST")
        return
    if new != text:
        if not dry:
            write(rel, new)
        report["overrides"].append({"file": rel, "status": "applied" if not dry else "missing"})


def apply_mozconfig(report, dry):
    rel = "configs/common/mozconfig"
    text = read(rel)
    new = re.sub(r"--with-app-basename=\S+", "--with-app-basename=Whimsy", text)
    new = re.sub(r"^export MOZ_APP_BASENAME=\S+", "export MOZ_APP_BASENAME=Whimsy", new, flags=re.M)
    sccache = ('\n# Whimsy: cache compiles so weekly Firefox updates rebuild faster.\n'
               'if test -z "$SCCACHE_GHA_ENABLED" -a -x "$HOME/.mozbuild/sccache/sccache"; then\n'
               '  ac_add_options --with-ccache="$HOME/.mozbuild/sccache/sccache"\n'
               'fi\n')
    if "Whimsy: cache compiles" not in new:
        new = new.rstrip("\n") + "\n" + sccache
    # Whimsy: crash dumps stay on this Mac. Firefox's reporter would offer to
    # send them to Mozilla's server; a Whimsy-run server is a later decision.
    nocrash = ('\n# Whimsy: no crash reporter; crashes stay local (macOS crash logs).\n'
               'ac_add_options --disable-crashreporter\n')
    if "Whimsy: no crash reporter" not in new:
        new = new.rstrip("\n") + "\n" + nocrash
    if new != text:
        if not dry:
            write(rel, new)
        report["overrides"].append({"file": rel, "status": "applied" if not dry else "missing"})


def apply_pref_overrides(report, dry, superseded_ids):
    """Change Zen-declared pref defaults in place, so each pref is declared once."""
    for name, value in PREF_OVERRIDES.items():
        if name == "zen.ctrlTab.show-pending-tabs" and "ctrl-tab" in superseded_ids:
            continue
        if name == "zen.folders.owned-tabs-in-folder" and "new-tab-position" in superseded_ids:
            continue
        found = False
        for rel in upstream_files("prefs"):
            if not rel.endswith(".yaml"):
                continue
            text = read(rel)
            # value may follow other keys (cpptype: for a static pref).
            rx = re.compile(r"(- name: " + re.escape(name) +
                            r"\n(?:[ \t]+(?!value:)[^\n]*\n)*[ \t]*value: )([^\n#]*)(.*)")
            m = rx.search(text)
            if not m:
                continue
            found = True
            want = json.dumps(value) if not isinstance(value, bool) else ("true" if value else "false")
            if m.group(2).strip() != want:
                if not dry:
                    write(rel, text[:m.start()] + m.group(1) + want + " # Whimsy override" + text[m.end():])
                report["overrides"].append({"pref": name, "status": "applied" if not dry else "missing"})
        if not found:
            report["problems"].append(f"pref override {name}: Zen no longer declares it")


def write_generated(report, dry, superseded):
    # Fallback strings Zen doesn't define (any more).
    defined = set()
    for rel in upstream_files("locales/en-US"):
        if rel.endswith(".ftl"):
            defined.update(re.findall(r"^([a-zA-Z][\w-]*)\s*=", read(rel), re.M))
    fallbacks = [text for key, text in FALLBACK_STRINGS.items() if key not in defined]
    content = ("# Generated by whimsy/overlay.py: strings Zen uses but doesn't define.\n\n"
               + "\n".join(fallbacks) + ("\n" if fallbacks else ""))
    gen = {FALLBACK_FILE: content}

    # Feature switches: off for features Zen now ships itself. Prefs that only
    # exist for a feature are declared here too, so a superseded feature
    # leaves Zen's own defaults alone.
    gone = {s["id"]: s for s in superseded}
    prefs = "# Generated by whimsy/overlay.py. Don't edit.\n"
    for feature in FEATURES:
        s = gone.get(feature["id"])
        note = f"  # Zen ships this itself: {s['found_in']}" if s else ""
        # batch8: a FEATURES entry can opt into shipping off by default
        # ("default": False, e.g. tree-tabs) without that meaning "superseded
        # by Zen" (which also writes false, but with a different note).
        on = not s and feature.get("default", True)
        prefs += f"\n- name: whimsy.feature.{feature['id']}\n  value: {'true' if on else 'false'}{note}\n"
    if "ctrl-tab" not in gone:
        prefs += "\n# Arc-style Ctrl+Tab: recently used order.\n- name: browser.ctrlTab.sortByRecentlyUsed\n  value: true\n"
        # W13 ctrltab: 12 previews (three rows of four). Firefox's 7 left the
        # 8th tab unreachable, since Zen hides the List All Tabs button.
        prefs += ("\n# Ctrl+Tab shows up to 12 tabs (three rows of four); with Firefox's 7\n"
                  "# the 8th tab couldn't be reached (Zen hides List All Tabs).\n"
                  "- name: browser.ctrlTab.maxPreviews\n  value: 12\n")
    if "new-tab-position" not in gone:
        prefs += ("\n# New tabs (Cmd+T) open right below the current tab, not at the end of\n"
                  "# the list. Settings → Tab Management → Tabs.\n"
                  "- name: browser.tabs.insertAfterCurrent\n  value: true\n")
    if "strip-tracking" not in gone:
        prefs += ("\n# Strip tracking parameters (utm_*, fbclid...) from links you open, in\n"
                  "# normal and private windows. Copy Clean Link's list already applies to\n"
                  "# copies (privacy.query_stripping.strip_on_share.enabled).\n"
                  "- name: privacy.query_stripping.enabled\n  value: true\n"
                  "\n- name: privacy.query_stripping.enabled.pbmode\n  value: true\n")
    gen["prefs/whimsy/features.yaml"] = prefs

    for rel, text in gen.items():
        current = read(rel) if os.path.exists(path(rel)) else None
        if current != text:
            if not dry:
                os.makedirs(os.path.dirname(path(rel)), exist_ok=True)
                write(rel, text)
            report["generated"].append({"file": rel, "status": "written" if not dry else "stale"})


def run(dry):
    report = {"hooks": [], "hotfixes": [], "overrides": [], "generated": [], "problems": []}
    superseded = detect_superseded()
    report["superseded"] = superseded
    ids = {s["id"] for s in superseded}
    apply_hooks(report, dry)
    apply_hotfixes(report, dry)
    apply_json_overrides(report, dry)
    apply_mozconfig(report, dry)
    apply_update_host(report, dry)
    apply_pref_overrides(report, dry, ids)
    write_generated(report, dry, superseded)
    return report


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "check"
    report = run(dry=(mode != "apply"))
    pending = [x for k in ("hooks", "hotfixes", "overrides", "generated") for x in report[k]
               if x["status"] in ("missing", "stale")]
    for s in report["superseded"]:
        print(f"superseded: {s['title']} (Zen has it: {s['found_in']})")
    for p in report["problems"]:
        print("PROBLEM:", p)
    for p in pending:
        print("NOT APPLIED:", p)
    print(f"overlay {mode}: {len(report['problems'])} problems, {len(pending)} not applied")
    sys.exit(1 if report["problems"] or (mode == "check" and pending) else 0)


if __name__ == "__main__":
    main()
