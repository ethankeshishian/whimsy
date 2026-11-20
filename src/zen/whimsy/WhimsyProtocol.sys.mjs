/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// whimsy:// URL schemes (Arc parity: arc://settings, arc://history, ...).
// Typing whimsy://<page> into the address bar jumps straight to the real
// page for it, the way Arc's internal pages map onto Chromium's chrome://
// pages. Links from other apps (Raycast, Alfred, Shortcuts, `open
// whimsy://...` in Terminal) reach Whimsy too: the scheme is registered in
// Info.plist (src/browser/app/macbuild/Contents/whimsy-Info-plist-in.patch),
// macOS hands it over as `-url whimsy://...`, and WhimsyCommandLine below
// (components.conf, ordered before Firefox's own handler) routes it:
//   whimsy://<page>                      that page, in a new tab
//   whimsy://open?url=<URL>              like any link from another app
//                                        (Mini Whimsy, Glance or a tab,
//                                        per whimsy.external-links.target)
//   whimsy://open?url=<URL>&space=<S>    a new tab in space S (name or id,
//                                        like Zen's --space)
//   whimsy://new-tab?url=<URL>           Mini Whimsy (Arc's Little Arc)
//   whimsy://space?name=<S>              switch to space S
//   whimsy://search?q=<text>             a new tab searching with the
//   whimsy://search?q=<text>&space=<S>   default engine (in space S)
//   whimsy://command?id=<id>             one of COMMANDS below
// Only http(s) targets; anything else is swallowed, never handed back to
// macOS (which would send it straight back here).
// whimsy.feature.url-schemes.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  WhimsyExternalLinks: "resource:///modules/whimsy/WhimsyExternalLinks.sys.mjs",
  WhimsyQuickWindow: "resource:///modules/whimsy/WhimsyQuickWindow.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.url-schemes";

// whimsy://<page> -> a real page or a Zen command to run instead.
const ROUTES = {
  settings: { url: "about:preferences" },
  downloads: { url: "about:downloads" },
  extensions: { url: "about:addons" },
  flags: { url: "about:config" },
  keyboard: { url: "about:keyboard" },
  history: { command: "cmd_zenToggleLibrary", fallbackUrl: "about:firefoxview" },
  // batch7b: offline game + year in tabs (about:whimsy, WhimsyAboutPage.sys.mjs).
  game: { url: "about:whimsy?game" },
  year: { url: "about:whimsy?year" },
  // home: the homepage and its Changelog tab (about:whimsy).
  home: { url: "about:whimsy" },
  changelog: { url: "about:whimsy?tab=changelog" },
  // wave5/safety: Claude runs (agent replay).
  replay: { url: "about:whimsy?replay" },
  // wave5: whimsy://easel makes a new easel (pinned, like Arc).
  easel: { command: "cmd_whimsyNewEasel", fallbackUrl: "about:whimsy?easel" },
  // W29/help: whimsy://help, the built-in manual.
  help: { url: "about:whimsy?help" },
};

// W29: whimsy://command?id=<id>. Any app can open a link, so only
// commands that are harmless from a hostile caller: nothing that closes,
// clears, sends, or signs out, and nothing that reads the page.
const COMMANDS = {
  "new-easel": "cmd_whimsyNewEasel",
  "new-note": "cmd_whimsyCreateNote",
  "toggle-sidebar": "cmd_zenToggleSidebar",
  "compact-mode": "cmd_zenCompactModeToggle",
  "next-space": "cmd_zenWorkspaceForward",
  "previous-space": "cmd_zenWorkspaceBackward",
  "do-not-disturb": "cmd_whimsyDoNotDisturb",
  "focus-session": "cmd_whimsyFocusSession",
};

// What each link action takes: [required, optional] query keys.
const LINK_PARAMS = {
  open: [["url"], ["space"]],
  "new-tab": [["url"], []],
  space: [["name"], []],
  search: [["q"], ["space"]],
  command: [["id"], []],
};

const MAX_QUERY = 2048;

const PATTERN = /^whimsy:\/\/([a-z-]+)\/?$/i;

export const WhimsyProtocol = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  route(value) {
    const match = PATTERN.exec(value.trim());
    return match ? ROUTES[match[1].toLowerCase()] ?? null : null;
  },

  // whimsy://open, new-tab, space, search and command links from other
  // apps: { action, url, space, query, command } or null. Strict: each
  // key the action takes at most once, the required ones present and
  // non-empty, and nothing else.
  linkRoute(value) {
    if (typeof value != "string" || value.length > 8192) {
      return null;
    }
    let link;
    try {
      link = new URL(value.trim());
    } catch {
      return null;
    }
    const action = link.hostname.toLowerCase();
    if (
      link.protocol != "whimsy:" ||
      !Object.hasOwn(LINK_PARAMS, action) ||
      link.username ||
      link.password ||
      link.port ||
      link.hash ||
      !["", "/"].includes(link.pathname)
    ) {
      return null;
    }
    const params = link.searchParams;
    const [required, optional] = LINK_PARAMS[action];
    if (
      [...params.keys()].some(key => !required.includes(key) && !optional.includes(key)) ||
      required.some(key => params.getAll(key).length != 1 || !params.get(key).trim()) ||
      optional.some(key => params.getAll(key).length > 1)
    ) {
      return null;
    }
    const space = params.get("space") || null;
    if (action == "space") {
      return { action, space: params.get("name") };
    }
    if (action == "search") {
      const query = params.get("q").trim();
      return query.length > MAX_QUERY ? null : { action, query, space };
    }
    if (action == "command") {
      const id = params.get("id");
      return Object.hasOwn(COMMANDS, id) ? { action, command: COMMANDS[id] } : null;
    }
    let target;
    try {
      target = new URL(params.get("url"));
    } catch {
      return null;
    }
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
      return null;
    }
    return { action, url: target.href, space };
  },

  initWindow(win) {
    const { gURLBar } = win;
    if (!gURLBar) {
      return;
    }
    gURLBar.inputField.addEventListener(
      "keydown",
      event => {
        if (event.key != "Enter" || !this.enabled) {
          return;
        }
        const route = this.route(gURLBar.value);
        if (!route) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.go(win, route);
      },
      true
    );
  },

  go(win, route, where = "current") {
    win.gURLBar.blur();
    if (route.command) {
      const command = win.document.getElementById(route.command);
      if (command) {
        command.doCommand();
        return;
      }
      win.openTrustedLinkIn(route.fallbackUrl, where);
      return;
    }
    win.openTrustedLinkIn(route.url, where);
  },

  // A whimsy:// link from another app. Returns true when it opened something.
  async openExternal(value) {
    if (!this.enabled) {
      return false;
    }
    const page = this.route(value);
    const link = page ? null : this.linkRoute(value);
    if (!page && !link) {
      return false;
    }
    const principal = Services.scriptSecurityManager.createNullPrincipal({});
    if (link && ["open", "new-tab"].includes(link.action) && !link.space) {
      const uri = Services.io.newURI(link.url);
      if (link.action == "new-tab" && lazy.WhimsyQuickWindow.enabled) {
        return !!lazy.WhimsyQuickWindow.open(link.url, { triggeringPrincipal: principal });
      }
      if (
        link.action == "open" &&
        lazy.WhimsyExternalLinks.enabled &&
        (lazy.WhimsyExternalLinks.openInGlance(uri, principal) ||
          lazy.WhimsyExternalLinks.openInQuickWindow(uri, principal))
      ) {
        return true;
      }
    }
    const win = await this.mainWindow();
    if (!win || win.closed || !this.enabled) {
      return false;
    }
    if (page) {
      this.go(win, page, "tab");
      win.focus();
      return true;
    }
    if (link.action == "command") {
      const command = win.document.getElementById(link.command);
      if (!command || command.getAttribute("disabled") == "true") {
        return false;
      }
      win.focus();
      command.doCommand();
      return true;
    }
    let userContextId = 0;
    let zenWorkspaceId;
    if (link.space) {
      const spaces = win.gZenWorkspaces;
      await spaces?.promiseInitialized;
      const space = spaces?.resolveWorkspaceFromCLIString(link.space);
      if (!space) {
        // Never drop a link meant for one space into another.
        console.warn(`Whimsy: no space named "${link.space}" for a whimsy:// link`);
        return false;
      }
      if (space.uuid != spaces.activeWorkspace) {
        await spaces.changeWorkspaceWithID(space.uuid);
      }
      if (link.action == "space") {
        win.focus();
        return true;
      }
      userContextId = space.containerTabId || 0;
      zenWorkspaceId = space.uuid;
    }
    let url = link.url;
    if (link.action == "search") {
      await lazy.SearchService.init();
      url = lazy.SearchService.defaultEngine?.getSubmission(link.query)?.uri.spec;
      if (!url) {
        return false;
      }
    }
    if (win.closed) {
      return false;
    }
    win.gBrowser.selectedTab = win.gBrowser.addTab(url, {
      triggeringPrincipal: principal,
      userContextId,
      zenWorkspaceId,
    });
    win.focus();
    return true;
  },

  // The newest normal browser window (not Mini Whimsy, not private), once
  // it has finished starting up; opens one when there is none.
  async mainWindow() {
    const isMain = candidate =>
      !candidate.closed &&
      !candidate._whimsyQuickWindow &&
      !lazy.PrivateBrowsingUtils.isWindowPrivate(candidate) &&
      candidate.toolbar.visible;
    let win = [...Services.wm.getEnumerator("navigator:browser")].reverse().find(isMain);
    if (!win) {
      win = await lazy.BrowserWindowTracker.promiseOpenWindow({ private: false });
    }
    if (!win.gBrowserInit?.delayedStartupFinished) {
      await new Promise(resolve => {
        const observer = subject => {
          if (subject == win) {
            Services.obs.removeObserver(observer, "browser-delayed-startup-finished");
            resolve();
          }
        };
        Services.obs.addObserver(observer, "browser-delayed-startup-finished");
      });
    }
    return win;
  },
};

// Handles whimsy:// arguments before Firefox's own command-line handler
// (category "a-whimsy" sorts before "m-browser"). macOS passes a link from
// another app as `-url whimsy://...`; a shell can pass it bare. Every
// whimsy:// argument is removed (Firefox would otherwise hand it back to
// macOS, which sends it here again), and the rest are left alone.
export class WhimsyCommandLine {
  QueryInterface = ChromeUtils.generateQI(["nsICommandLineHandler"]);

  get helpInfo() {
    return "  whimsy://open?url=<url>&space=<name> Open a link in Whimsy (in a space).\n";
  }

  handle(commandLine) {
    const links = [];
    for (let i = commandLine.length - 1; i >= 0; i--) {
      const arg = commandLine.getArgument(i);
      if (!/^whimsy:/i.test(arg)) {
        continue;
      }
      const flag = i > 0 ? commandLine.getArgument(i - 1) : "";
      if (/^--?(url|new-tab|new-window)$/i.test(flag)) {
        commandLine.removeArguments(i - 1, i);
        i--;
      } else {
        commandLine.removeArguments(i, i);
      }
      links.unshift(arg);
    }
    if (!links.length) {
      return;
    }
    // On a cold start Firefox still opens (and restores) its first window;
    // the links then open in it. Later, they replace Firefox's default
    // "open a window" so nothing extra appears.
    if (commandLine.state == Ci.nsICommandLine.STATE_INITIAL_LAUNCH) {
      this._pending ??= new Promise(resolve => {
        const observer = () => {
          Services.obs.removeObserver(observer, "browser-delayed-startup-finished");
          resolve();
        };
        Services.obs.addObserver(observer, "browser-delayed-startup-finished");
      });
    } else {
      commandLine.preventDefault = true;
    }
    for (const link of links) {
      // In order, one after another, so each space switch completes.
      this._pending = (this._pending ?? Promise.resolve())
        .then(() => WhimsyProtocol.openExternal(link))
        .catch(console.error);
    }
  }
}
