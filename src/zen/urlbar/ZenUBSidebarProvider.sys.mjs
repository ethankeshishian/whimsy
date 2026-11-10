/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  UrlbarProvider,
  UrlbarUtils,
} from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { UrlbarShared } from "chrome://browser/content/urlbar/UrlbarShared.mjs";
import { formatValueSync } from "resource:///modules/ZenUBGlobalActions.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  UrlbarPrefs: "moz-src:///browser/components/urlbar/UrlbarPrefs.sys.mjs",
  UrlbarProviderOpenTabs:
    "moz-src:///browser/components/urlbar/UrlbarProviderOpenTabs.sys.mjs",
  ZenSessionStore: "resource:///modules/zen/ZenSessionManager.sys.mjs",
});

const DYNAMIC_TYPE_NAME = "zen-folders";

export class ZenUrlbarProviderSidebar extends UrlbarProvider {
  get name() {
    return "ZenUrlbarProviderSidebar";
  }

  /**
   * @returns {Values<typeof UrlbarShared.PROVIDER_TYPE>}
   */
  get type() {
    return UrlbarShared.PROVIDER_TYPE.PROFILE;
  }

  async isActive(queryContext) {
    return (
      !queryContext.isPrivate &&
      !!queryContext.tokens.length &&
      queryContext.sources.includes(UrlbarShared.RESULT_SOURCE.TABS) &&
      lazy.UrlbarPrefs.get("suggest.openpage")
    );
  }

  async startQuery(queryContext, addCallback) {
    const sidebar = lazy.ZenSessionStore.getSidebarData();
    if (!sidebar) {
      return;
    }
    const tokens = queryContext.tokens.map(t => t.lowerCaseValue);
    const score = text => {
      text = text.toLowerCase();
      if (!tokens.every(token => text.includes(token))) {
        return 0;
      }
      return tokens.reduce((sum, token) => sum + token.length, 0) / text.length;
    };
    this.#addFolders(sidebar, score, queryContext, addCallback);
    this.#addTabs(sidebar, score, queryContext, addCallback);
  }

  // The icon+name text for a tab's space, the way ZenSpaceManager shows an
  // emoji space in a plain-text label (an svg space icon has no text form,
  // so the name alone is shown). null when the space can't be found (a
  // stale sidebar entry) or has no name.
  #spaceBadge(sidebar, tabData) {
    const space = (sidebar.spaces || []).find(
      s => s.uuid == tabData.zenWorkspace
    );
    if (!space?.name) {
      return null;
    }
    return space.icon && !space.icon.endsWith(".svg")
      ? `${space.icon}  ${space.name}`
      : space.name;
  }

  #addTabs(sidebar, score, queryContext, addCallback) {
    const openTabUrls = lazy.UrlbarProviderOpenTabs.getOpenTabUrls();
    const activeSpace =
      lazy.BrowserWindowTracker.getTopWindow().gZenWorkspaces.activeWorkspace;
    let resultsAdded = 0;
    // Every space, every Whimsy profile (profiles are containers; spaces
    // carry containerTabId, so dropping the space check here already
    // reaches every profile too). Current-space tabs (and essentials, part
    // of every space) come first, so an equally good match from elsewhere
    // never outranks the tab you're already next to.
    for (const sameSpace of [true, false]) {
      for (const tabData of sidebar.tabs || []) {
        const essential = !!tabData.zenEssential;
        const inSameSpace = essential || tabData.zenWorkspace == activeSpace;
        if (inSameSpace != sameSpace) {
          continue;
        }
        const entries = tabData.entries || [];
        const entry = entries[(tabData.index || entries.length) - 1];
        const label = tabData.zenStaticLabel || entry?.title;
        if (typeof label !== "string" || !label || !score(label)) {
          continue;
        }
        const url = entry?.url;
        if (!url || url == queryContext.currentPage) {
          // Don't suggest switching to the current tab.
          continue;
        }
        const userContextId = tabData.userContextId || 0;
        // The sidebar data can lag behind a navigation, only offer tabs that
        // are still registered as open with this url.
        const openTab = [...(openTabUrls.get(url) || [])].find(
          ([contextId]) => contextId == userContextId
        );
        if (!openTab) {
          continue;
        }
        // Current-space rows show no label; an essential has no space of
        // its own either way.
        const badge = sameSpace ? null : this.#spaceBadge(sidebar, tabData);
        addCallback(
          this,
          new lazy.UrlbarResult({
            type: UrlbarShared.RESULT_TYPE.TAB_SWITCH,
            source: UrlbarShared.RESULT_SOURCE.TABS,
            payload: {
              url,
              title: label,
              icon: UrlbarShared.getIconForUrl(url),
              userContext: UrlbarUtils.getUserContextData(userContextId),
              tabGroup: openTab[1],
              action: lazy.UrlbarPrefs.get("secondaryActions.switchToTab")
                ? UrlbarUtils.createTabSwitchSecondaryAction(userContextId)
                : undefined,
              ...(badge ? { zenSpaceBadge: badge } : {}),
            },
            highlights: {
              url: UrlbarShared.HIGHLIGHT.TYPED,
              title: UrlbarShared.HIGHLIGHT.TYPED,
            },
          })
        );
        if (++resultsAdded == queryContext.maxResults) {
          return;
        }
      }
    }
  }

  #addFolders(sidebar, score, queryContext, addCallback) {
    const folders = new Map(
      (sidebar.folders || []).map(folder => [folder.id, folder])
    );
    const matched = [...folders.values()]
      .filter(folder => !folder.splitViewGroup && folder.name)
      .map(folder => ({ folder, score: score(folder.name) }))
      .filter(match => match.score)
      .sort((a, b) => b.score - a.score);
    for (const match of matched) {
      const { folder } = match;
      const space = sidebar.spaces?.find(s => s.uuid == folder.workspaceId);
      const path = [folder.name];
      for (
        let parent = folders.get(folder.parentId);
        parent;
        parent = folders.get(parent.parentId)
      ) {
        path.unshift(parent.name);
      }
      if (space?.name) {
        path.unshift(space.name);
      }
      addCallback(
        this,
        new lazy.UrlbarResult({
          type: UrlbarShared.RESULT_TYPE.DYNAMIC,
          source: UrlbarShared.RESULT_SOURCE.TABS,
          payload: {
            dynamicType: DYNAMIC_TYPE_NAME,
            zenFolderId: folder.id,
            titleL10n: "zen-action-open",
            userIcon: folder.userIcon,
            icon: "chrome://browser/skin/zen-icons/folder.svg",
            path: path.join(" / "),
          },
          suggestedIndex:
            1 +
            Math.round(
              (1 - Math.min(match.score, 1)) * (queryContext.maxResults - 2)
            ),
        })
      );
    }
  }

  getViewUpdate(result) {
    return {
      icon: { attributes: { src: result.payload.icon } },
      titleStrong: {
        textContent: formatValueSync(result.payload.titleL10n),
        attributes: { dir: "ltr" },
      },
      path: {
        textContent: result.payload.path,
        attributes: { dir: "ltr", hidden: !result.payload.path },
      },
      userIcon: {
        attributes: {
          src: result.payload.userIcon,
          hidden: !result.payload.userIcon,
        },
      },
    };
  }

  getViewTemplate() {
    return {
      attributes: {
        selectable: true,
      },
      children: [
        {
          name: "icon",
          tag: "img",
          classList: ["urlbarView-favicon", "urlbarView-action-favicon"],
        },
        {
          name: "title",
          tag: "span",
          classList: ["urlbarView-title"],
          children: [
            {
              name: "titleStrong",
              tag: "strong",
            },
          ],
        },
        {
          tag: "span",
          classList: ["urlbarView-prettyName"],
          children: [
            {
              name: "userIcon",
              tag: "img",
              attributes: { hidden: true },
            },
            {
              name: "path",
              tag: "span",
            },
          ],
        },
      ],
    };
  }

  onEngagement(queryContext, controller, details) {
    const { zenFolderId } = details.result.payload;
    if (!zenFolderId) {
      return;
    }
    const ownerGlobal = details.element.documentGlobal;
    ownerGlobal.gBrowser.selectedBrowser.focus();
    const folder = ownerGlobal.document.getElementById(zenFolderId);
    if (folder?.isZenFolder) {
      ownerGlobal.gZenFolders.revealFolder(folder);
    }
  }
}
