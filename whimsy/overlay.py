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
]

HOTFIXES = [
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
]

# Prefs Zen declares whose defaults Whimsy changes: {name: value}.
PREF_OVERRIDES = {
    "zen.ctrlTab.show-pending-tabs": True,       # Arc-style Ctrl+Tab
    "zen.updates.show-update-notification": False,  # Whimsy shows its own
    "zen.folders.owned-tabs-in-folder": True,    # new tabs stay in the folder
    "zen.theme.gradient.show-custom-colors": True,  # theme picker's custom colors (hex field)
    # Automatic picture-in-picture when you leave a playing video (Arc);
    # Zen kept it off "until a settings page"; Firefox's Media settings has it.
    "media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled": True,
    # batch hover: Arc's tab hover card (title, address, page preview) is
    # Firefox's tab hover preview, which Zen ships off.
    "browser.tabs.hoverPreview.enabled": True,
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
    {"id": "ctrl-tab", "title": "Arc-style Ctrl+Tab",
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
    {"id": "tree-tabs", "title": "Tree-style tabs with an Islands mode: nest a tab under whichever tab opened it",
     "default": False,  # Build-plan answer: off by default.
     "detect": [("src/zen", r"(?i)zen-?tree-?tabs|ZenTreeTabs|zen-?tab-?islands")]},
    {"id": "fire-button", "title": "Fire button: a one-click data-clearing popover (DuckDuckGo), scoped to site/15 min/space/everything",
     "detect": [("src/zen", r"(?i)fire-?button|ZenFireButton")]},
    {"id": "heavy-tabs", "title": "Find heavy tabs: the tabs using the most memory/CPU, with a close button (Opera GX)",
     "detect": [("src/zen", r"(?i)heavy-?tabs|hot-?tabs-?killer|ZenHeavyTabs")]},
    # batch6: split view extras.
    {"id": "split-link-click", "title": "Shift+click a link opens it in a split (Arc parity, PR#15241)",
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
    {"id": "scratch", "title": "Scratch (temporary private space, Cmd+Shift+N) and private tabs (Cmd+Option+T)",
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
    {"id": "seasonal-themes", "title": "Seasonal themes: seasonal gradients on loading indicators and balloon costumes",
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
    {"id": "sidebar-nav", "title": "Cmd+Opt+Up/Down walks the sidebar's tabs; Focus Sidebar (Cmd+Opt+S) for arrow-key/Enter/Delete/Esc; Space opens a Glance",
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
    {"id": "live-folders-linear", "title": "Linear live folder: \"My Issues\" assigned to you, open states, with an API-key fallback when there's no signed-in session",
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
    {"id": "space-extensions", "title": "Per-space extensions: \"Show in Spaces…\" on each extension's gear menu, plus per-container API isolation where a space has its own container",
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
    {"id": "handoff", "title": "Handoff: continue pages on your other Apple devices, never private tabs or Scratch",
     "detect": [("src/zen", r"(?i)zen\.handoff\.|handoff-(?:private|scratch)")]},

    # wave3: playlist. Brave Playlist v1: direct media files, saved for offline in Library.
    {"id": "playlist", "title": "Playlist: save videos and audio to Library -> Playlist and play them offline (direct files)",
     "detect": [("src/zen", r"(?i)\bplaylist\b")]},

    # wave3/ai: AI v1. The provider every Whimsy AI feature uses (Claude API
    # key, Apple on-device, local Ollama); no automatic cloud fallback.
    {"id": "ai-providers", "title": "AI provider picker: Claude API key, Apple on-device or local Ollama, with no automatic cloud fallback",
     "detect": [("src/zen", r"(?i)api\.anthropic\.com|FoundationModels|ollama")]},
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
    # wave5/quick: QR code for any page. Firefox's QR dialog (SharingUtils),
    # exposed in the page menu and command bar; never for private tabs/Scratch.
    {"id": "qr-code", "title": "QR code for any page: the page menu and command bar open Firefox's QR dialog (not for private tabs or Scratch)",
     "detect": [("src/zen", r"(?i)showQRCodePanel|qr-?code-?for-?page")]},
    # wave5/quick: Copy page as Markdown (MarkDownload/Obsidian clipper style;
    # Zen discussion #12557). Zen only copies [title](url).
    {"id": "copy-page-markdown", "title": "Copy Page as Markdown: the Reader View article (or a selection) as Markdown, from the page menu and command bar",
     "detect": [("src/zen", r"(?i)copy-?(page|selection)-?as-?markdown|pageToMarkdown|turndown")]},
    # wave5/quick: Markdown/CSV viewer (Typora/Marked/GitHub file view; built
    # like Firefox's JSON viewer: sniffer + stream converter, no page script).
    {"id": "doc-viewer", "title": "Markdown and CSV viewer: .md files read with reader typography and contents, CSV/TSV as a sortable table, Source toggle, live reload",
     "detect": [("src/zen", r"(?i)text/markdown|markdown-?viewer|csv-?viewer")]},
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
            rx = re.compile(r"(- name: " + re.escape(name) + r"\n\s*value: )([^\n#]*)(.*)")
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
