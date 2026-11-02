/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// batch6: command bar extras (scout/batch6.md #13, #16).

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  UrlbarShared: "chrome://browser/content/urlbar/UrlbarShared.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
});

// #13: typing "/" (Linear, VS Code's ">") in the URL bar enters Zen's
// commands mode, the same mode Tab-in-an-empty-bar already opens. A pref,
// since "/path" is a (rare) valid query someone could type on purpose.
const SLASH_FEATURE_PREF = "whimsy.feature.command-bar-slash";

// wave6/parity: Arc's command bar shows one row per page title on these
// sites (its dedupByTitleAndHostList), where many URLs share one title
// (a Figma file's frames, a Notion page's blocks, a GitHub repo's tabs).
const DEDUP_FEATURE_PREF = "whimsy.feature.command-bar-dedup";
export const DEDUP_HOSTS = new Set([
  "figma.com",
  "maps.google.com",
  "notion.so",
  "app.notion.com",
  "zoom.us",
  "opentable.com",
  "zillow.com",
  "github.com",
  "app.mode.com",
  "console.cloud.google.com",
]);

// W10-37: Arc's command bar displays the search engine/site favicon on
// search results (e.g. YouTube, Google, DuckDuckGo) rather than a generic
// search glass.
export const SEARCH_FAVICONS_FEATURE_PREF = "whimsy.feature.command-bar-search-favicons";

export const KNOWN_ENGINE_FAVICONS = new Map([
  ["youtube", "chrome://activity-stream/content/data/content/tippytop/favicons/youtube-com.png"],
  ["google", "chrome://activity-stream/content/data/content/tippytop/favicons/google-com.ico"],
  ["duckduckgo", "chrome://activity-stream/content/data/content/tippytop/favicons/duckduckgo-com.ico"],
  ["ddg", "chrome://activity-stream/content/data/content/tippytop/favicons/duckduckgo-com.ico"],
  ["wikipedia", "chrome://activity-stream/content/data/content/tippytop/favicons/wikipedia-org.ico"],
  ["wikipedia (en)", "chrome://activity-stream/content/data/content/tippytop/favicons/wikipedia-org.ico"],
  ["bing", "chrome://activity-stream/content/data/content/tippytop/favicons/bing-com.ico"],
  ["reddit", "chrome://activity-stream/content/data/content/tippytop/favicons/reddit-com.png"],
  ["amazon", "chrome://activity-stream/content/data/content/tippytop/favicons/amazon.ico"],
  ["amazon.com", "chrome://activity-stream/content/data/content/tippytop/favicons/amazon.ico"],
  ["ebay", "chrome://activity-stream/content/data/content/tippytop/favicons/ebay.ico"],
  ["twitter", "chrome://activity-stream/content/data/content/tippytop/favicons/twitter-com.ico"],
  ["facebook", "chrome://activity-stream/content/data/content/tippytop/favicons/facebook-com.png"],
  ["baidu", "chrome://activity-stream/content/data/content/tippytop/favicons/baidu-com.png"],
  ["yandex", "chrome://activity-stream/content/data/content/tippytop/favicons/yandex-com.png"],
  ["yandex (ru)", "chrome://activity-stream/content/data/content/tippytop/favicons/yandex-ru.png"],
]);

export const KNOWN_DOMAIN_FAVICONS = new Map([
  ["youtube.com", "chrome://activity-stream/content/data/content/tippytop/favicons/youtube-com.png"],
  ["google.com", "chrome://activity-stream/content/data/content/tippytop/favicons/google-com.ico"],
  ["duckduckgo.com", "chrome://activity-stream/content/data/content/tippytop/favicons/duckduckgo-com.ico"],
  ["wikipedia.org", "chrome://activity-stream/content/data/content/tippytop/favicons/wikipedia-org.ico"],
  ["bing.com", "chrome://activity-stream/content/data/content/tippytop/favicons/bing-com.ico"],
  ["reddit.com", "chrome://activity-stream/content/data/content/tippytop/favicons/reddit-com.png"],
  ["amazon.com", "chrome://activity-stream/content/data/content/tippytop/favicons/amazon.ico"],
  ["ebay.com", "chrome://activity-stream/content/data/content/tippytop/favicons/ebay.ico"],
  ["twitter.com", "chrome://activity-stream/content/data/content/tippytop/favicons/twitter-com.ico"],
  ["x.com", "chrome://activity-stream/content/data/content/tippytop/favicons/twitter-com.ico"],
  ["facebook.com", "chrome://activity-stream/content/data/content/tippytop/favicons/facebook-com.png"],
  ["baidu.com", "chrome://activity-stream/content/data/content/tippytop/favicons/baidu-com.png"],
  ["yandex.ru", "chrome://activity-stream/content/data/content/tippytop/favicons/yandex-ru.png"],
  ["yandex.com", "chrome://activity-stream/content/data/content/tippytop/favicons/yandex-com.png"],
]);

function hostOf(url) {
  if (!url) {
    return "";
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch (e) {
    return "";
  }
}

export function getSearchFavicon(engineName, domain) {
  if (engineName) {
    const key = engineName.trim().toLowerCase();
    if (KNOWN_ENGINE_FAVICONS.has(key)) {
      return KNOWN_ENGINE_FAVICONS.get(key);
    }
    for (const [name, icon] of KNOWN_ENGINE_FAVICONS) {
      if (key === name || key.startsWith(`${name} `) || key.startsWith(`${name}-`)) {
        return icon;
      }
    }
  }
  if (domain) {
    const clean = domain.replace(/^www\./, "").toLowerCase();
    if (KNOWN_DOMAIN_FAVICONS.has(clean)) {
      return KNOWN_DOMAIN_FAVICONS.get(clean);
    }
    for (const [dom, icon] of KNOWN_DOMAIN_FAVICONS) {
      if (clean === dom || clean.endsWith(`.${dom}`)) {
        return icon;
      }
    }
    for (const [name, icon] of KNOWN_ENGINE_FAVICONS) {
      if (clean === `${name}.com` || clean.startsWith(`${name}.`)) {
        return icon;
      }
    }
  }
  return null;
}

const gDynamicFaviconCache = new Map();

// A known site icon, else the engine's own icon once it has loaded. Never a
// page-icon: guess: an engine without an icon keeps Firefox's search glass
// rather than a blank globe.
export function getEngineFavicon(engineName, domain) {
  const staticIcon = getSearchFavicon(engineName, domain);
  if (staticIcon) {
    return staticIcon;
  }
  const key = (engineName || "").trim().toLowerCase();
  if (!key) {
    return null;
  }
  if (gDynamicFaviconCache.has(key)) {
    return gDynamicFaviconCache.get(key);
  }
  gDynamicFaviconCache.set(key, null);
  try {
    const engine = lazy.SearchService?.getEngineByName(engineName);
    engine
      ?.getIconURL?.(16)
      .then(url => {
        if (url) {
          gDynamicFaviconCache.set(key, url);
        }
      })
      .catch(() => {});
  } catch (e) {}
  return null;
}

export function attachSearchFavicons(results, win = null) {
  if (!results?.length) {
    return results;
  }
  const searchGlass = lazy.UrlbarShared?.ICON?.SEARCH_GLASS || "chrome://global/skin/icons/search-glass.svg";
  const searchType = lazy.UrlbarShared?.RESULT_TYPE?.SEARCH ?? 1;
  const keywordType = lazy.UrlbarShared?.RESULT_TYPE?.KEYWORD ?? 6;
  const urlType = lazy.UrlbarShared?.RESULT_TYPE?.URL ?? 2;

  for (const result of results) {
    if (!result?.payload) {
      continue;
    }
    const isSearch = result.type === searchType || result.type === keywordType;
    const currentIcon = result.payload.icon;
    const isGenericIcon = !currentIcon || currentIcon === searchGlass;

    if (isSearch && isGenericIcon) {
      const engineName =
        result.payload.engine ||
        (win && lazy.PrivateBrowsingUtils?.isWindowPrivate(win)
          ? lazy.SearchService?.defaultPrivateEngine?.name
          : lazy.SearchService?.defaultEngine?.name);

      const domain =
        result.payload.searchUrlDomainWithoutSuffix ||
        (result.payload.url ? hostOf(result.payload.url) : null);

      const icon = getEngineFavicon(engineName, domain);
      if (icon) {
        result.payload.icon = icon;
      }
    } else if (result.type === urlType && !currentIcon && result.payload.url) {
      const host = hostOf(result.payload.url);
      const icon = getSearchFavicon(null, host);
      if (icon) {
        result.payload.icon = icon;
      }
    }
  }
  return results;
}

// Drops later results with the same title and host as an earlier one, on
// Arc's hosts only. The heuristic (first) result always stays.
export function dedupResults(results) {
  const seen = new Set();
  return results.filter((result, i) => {
    const url = result.payload?.url;
    const title = (result.payload?.title ?? "").trim();
    // W11-09: nor the typed address or search below an open tab ranked
    // first (WhimsyAlreadyOpen).
    if (!url || !title || (i == 0 && result.heuristic) || result.whimsyOwnHeuristic === true) {
      return true;
    }
    let host;
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch (e) {
      return true;
    }
    if (!DEDUP_HOSTS.has(host)) {
      return true;
    }
    const key = `${host}\n${title}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

// #16: Arc's Cmd+T "New ..." actions open a fresh doc/meeting/issue before
// you've finished thinking about it, using the ".new" shortcut domains
// (docs.new etc., already registered by their owners) rather than
// anything Whimsy has to keep up to date itself.
// wave9/designfix (L5): no separate "New Document" command (and its
// Settings target): each of its targets already had its own command. The
// three document commands also answer to "New Document", so typing
// "new doc" still lists Notion, Google Docs and Word.
const CREATE_FEATURE_PREF = "whimsy.feature.command-bar-create";
const DOCUMENT_THINGS = new Set(["doc", "notion", "word"]);

const NEW_THINGS = [
  { id: "doc", url: "https://docs.new", l10nId: "whimsy-action-new-doc" },
  { id: "sheet", url: "https://sheets.new", l10nId: "whimsy-action-new-sheet" },
  { id: "slides", url: "https://slides.new", l10nId: "whimsy-action-new-slides" },
  { id: "form", url: "https://forms.new", l10nId: "whimsy-action-new-form" },
  { id: "meet", url: "https://meet.new", l10nId: "whimsy-action-new-meet" },
  { id: "event", url: "https://cal.new", l10nId: "whimsy-action-new-event" },
  { id: "notion", url: "https://notion.new", l10nId: "whimsy-action-new-notion" },
  { id: "linear", url: "https://linear.new", l10nId: "whimsy-action-new-linear" },
  { id: "figma", url: "https://figma.new", l10nId: "whimsy-action-new-figma" },
  { id: "figjam", url: "https://figjam.new", l10nId: "whimsy-action-new-figjam" },
  { id: "repo", url: "https://repo.new", l10nId: "whimsy-action-new-repo" },
  { id: "gist", url: "https://gist.new", l10nId: "whimsy-action-new-gist" },
  { id: "word", url: "https://word.new", l10nId: "whimsy-action-new-word" },
  { id: "excel", url: "https://excel.new", l10nId: "whimsy-action-new-excel" },
  { id: "powerpoint", url: "https://powerpoint.new", l10nId: "whimsy-action-new-powerpoint" },
  { id: "miro", url: "https://miro.new", l10nId: "whimsy-action-new-miro" },
  { id: "loom", url: "https://loom.new", l10nId: "whimsy-action-new-loom" },
  { id: "canva", url: "https://canva.new", l10nId: "whimsy-action-new-canva" },
  { id: "playlist", url: "https://playlist.new", l10nId: "whimsy-action-new-playlist" },
];

// Zen's three appearance actions only match their own label, so searching
// "dark" found Switch to Dark Mode but hid Light and Automatic (and vice
// versa). Each now also matches its siblings' labels (the
// "command-bar-related-actions" hotfix in whimsy/overlay.py reads
// whimsyKeywords), ranked just below the direct match.
const APPEARANCE_ACTIONS = [
  "zen-action-switch-to-automatic-appearance",
  "zen-action-switch-to-light-mode",
  "zen-action-switch-to-dark-mode",
];

// fix7 settings: settings people looked for in the command bar and couldn't
// find there: History (Zen's palette only had Reopen Closed Tab), Liquid
// Glass and Glance size. Each follows its feature switch.
const GLANCE_SIZES = ["compact", "standard", "wide"];

function featureOn(id) {
  return Services.prefs.getBoolPref(`whimsy.feature.${id}`, true);
}

function liquidGlassSupported() {
  return (
    featureOn("liquid-glass") &&
    featureOn("transparency") &&
    lazy.AppConstants.isPlatformAndVersionAtLeast("macosx", "25")
  );
}

// W10-27: the floating command bar (⌘T, ⌘L, the private bar, Mini's ⌘T)
// opens with a short, subtle scale-and-fade and closes a little faster, the
// way Arc's command bar does. Zen draws the bar centred with
// `translate: -50% 0`, so the motion animates the `translate` and `scale`
// properties around that base and never `transform`. Opening is noticed
// from the bar's own attributes; closing goes through a one-line hotfix in
// the urlbar's #closePopover (overlay.py "command-bar-motion-close"), which
// lets the bar finish its close animation before Zen hides it. Zen's state
// (focus, the new-tab session, the page's URL) changes at once as before:
// only the hiding waits, and a reopen during it finishes the hide first.
export const MOTION_FEATURE_PREF = "whimsy.feature.command-bar-motion";
export const COMMAND_BAR_MOTION = {
  open: { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)", scale: 0.97, rise: 6 },
  close: { duration: 110, easing: "cubic-bezier(0.4, 0, 1, 1)", scale: 0.98, rise: 4 },
  openReduced: { duration: 100, easing: "linear" },
  closeReduced: { duration: 80, easing: "linear" },
};
// How long past its duration a close animation may run before the hide is
// finished anyway.
const CLOSE_GRACE_MS = 250;

export class CommandBarMotion {
  #win;
  #shown = false;
  #animation = null;
  #closing = null;
  // The visible amount (0-1) a hide was interrupted at, so the next open
  // starts from there instead of from nothing.
  #resumeFrom = 0;

  constructor(win) {
    this.#win = win;
    const urlbar = win.gURLBar;
    this.#shown = this.#isFloatingOpen(urlbar);
    this.observer = new win.MutationObserver(() => this.#onAttributes());
    this.observer.observe(urlbar, { attributes: true, attributeFilter: ["open", "zen-floating-urlbar"] });
    win.addEventListener("unload", () => this.observer.disconnect(), { once: true });
    // A new session started while the last one animates out (Cmd+T,
    // Cmd+Option+T, a click that focuses the field) first finishes that
    // hide, so it opens from a closed bar as Zen expects. Without this the
    // hide ran a moment later and took the new session's focus with it.
    const motion = this;
    const flushFirst = original =>
      function (...args) {
        if (motion.#closing) {
          motion.flushClose(win.gURLBar);
        }
        return original.apply(this, args);
      };
    if (typeof urlbar.focus == "function") {
      urlbar.focus = flushFirst(urlbar.focus);
    }
    const ui = win.gZenUIManager;
    if (typeof ui?.handleNewTab == "function") {
      ui.handleNewTab = flushFirst(ui.handleNewTab);
    }
  }

  get enabled() {
    return Services.prefs.getBoolPref(MOTION_FEATURE_PREF, true);
  }

  get reduced() {
    const win = this.#win;
    if (typeof win.gReduceMotion == "boolean") {
      return win.gReduceMotion;
    }
    return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  get animation() {
    return this.#animation;
  }

  get closing() {
    return !!this.#closing;
  }

  #isFloatingOpen(urlbar) {
    return urlbar.getAttribute("zen-floating-urlbar") == "true" && urlbar.hasAttribute("open");
  }

  // Keyframes around the bar's own translate (Zen's -50% 0, or none in
  // Mini's bar-only panel), so the bar never jumps sideways.
  #frames(kind) {
    const urlbar = this.#win.gURLBar;
    const reduced = this.reduced;
    const spec = COMMAND_BAR_MOTION[kind];
    if (reduced) {
      return kind == "open"
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ opacity: 1 }, { opacity: 0 }];
    }
    const isMini = this.#win.document.documentElement.getAttribute("whimsy-mini") == "bar";
    const defaultX = isMini ? "0px" : "-50%";
    const base = this.#win.getComputedStyle(urlbar).translate;
    const [x = defaultX, y = "0px"] = !base || base == "none" ? [defaultX, "0px"] : base.split(/\s+/);
    const rest = { opacity: 1, scale: "1", translate: `${x} ${y}` };
    const away = { opacity: 0, scale: String(spec.scale), translate: `${x} calc(${y} - ${spec.rise}px)` };
    return kind == "open" ? [away, rest] : [rest, away];
  }

  #timing(kind) {
    const spec = COMMAND_BAR_MOTION[this.reduced ? `${kind}Reduced` : kind];
    return { duration: spec.duration, easing: spec.easing };
  }

  #onAttributes() {
    const urlbar = this.#win.gURLBar;
    if (urlbar.getAttribute("zen-floating-urlbar") != "true") {
      this.#shown = false;
      return;
    }
    if (this.#shown || !urlbar.hasAttribute("open")) {
      return;
    }
    this.#shown = true;
    this.playOpen();
  }

  playOpen() {
    const urlbar = this.#win.gURLBar;
    const resume = this.#resumeFrom;
    this.#resumeFrom = 0;
    if (!this.enabled || this.#win.document.hidden) {
      return null;
    }
    // A reopen supersedes a hide still running (Zen's open is already
    // under way): drop it without hiding the bar again.
    if (this.#closing) {
      this.#win.clearTimeout(this.#closing.timer);
      this.#closing = null;
      urlbar.removeAttribute("whimsy-closing");
    }
    this.#animation?.cancel();
    const timing = this.#timing("open");
    const animation = urlbar.animate(this.#frames("open"), { ...timing, id: "whimsy-command-bar-open" });
    if (resume > 0) {
      // A reopen during the hide: carry on from what is on screen.
      animation.currentTime = timing.duration * Math.min(resume, 1);
    }
    this.#animation = animation;
    animation.finished.then(
      () => {
        if (this.#animation == animation) {
          this.#animation = null;
        }
      },
      () => {}
    );
    return animation;
  }

  // Called by the urlbar's #closePopover with the part of Zen's close that
  // hides the bar. Returns true when it will run `finish` itself, after the
  // close animation; false means the caller runs it now.
  deferClose(urlbar, finish) {
    if (this.#closing) {
      return true;
    }
    if (
      !this.enabled ||
      urlbar != this.#win.gURLBar ||
      urlbar.getAttribute("zen-floating-urlbar") != "true" ||
      !urlbar.matches(":popover-open") ||
      this.#win.document.hidden ||
      this.#win.windowState == this.#win.STATE_MINIMIZED
    ) {
      return false;
    }
    // What is visible now: an open still running starts the hide from there.
    let shownAmount = 1;
    const running = this.#animation;
    if (running?.id == "whimsy-command-bar-open" && running.playState == "running") {
      shownAmount = Math.min(1, (running.currentTime ?? 0) / running.effect.getTiming().duration);
    }
    running?.cancel();
    urlbar.setAttribute("whimsy-closing", "true");
    const timing = this.#timing("close");
    const animation = urlbar.animate(this.#frames("close"), {
      ...timing,
      id: "whimsy-command-bar-close",
      fill: "forwards",
    });
    if (shownAmount < 1) {
      animation.currentTime = timing.duration * (1 - shownAmount);
    }
    this.#animation = animation;
    // The hide always ends: when the animation finishes, when it's cancelled
    // (a reopen, or Gecko dropping it), or, if its timeline never gets there
    // (a throttled or occluded window), shortly after it should have.
    // Without that, #closing stayed set, every later close was "deferred"
    // to it, and the view never closed again (a 20s hang in tests).
    const timer = this.#win.setTimeout(() => this.#finishClose(animation), timing.duration + CLOSE_GRACE_MS);
    this.#closing = { finish, animation, timer };
    animation.finished.then(
      () => this.#finishClose(animation),
      () => this.#finishClose(animation)
    );
    return true;
  }

  #finishClose(animation) {
    const closing = this.#closing;
    if (!closing || closing.animation != animation) {
      return;
    }
    this.#closing = null;
    this.#win.clearTimeout(closing.timer);
    // The hide below and a reopen right after it reach the observer as one
    // batch; the next open must still animate.
    this.#shown = false;
    try {
      closing.finish();
    } catch (e) {
      console.error("Whimsy: command bar close", e);
    } finally {
      this.#win.gURLBar.removeAttribute("whimsy-closing");
      animation.cancel();
      if (this.#animation == animation) {
        this.#animation = null;
      }
    }
  }

  // Called by the urlbar's #openPopover before it opens: a hide still
  // running ends now, so Zen opens from a closed bar as it expects, and the
  // open animation picks up from what was on screen.
  flushClose(urlbar) {
    const closing = this.#closing;
    if (!closing || urlbar != this.#win.gURLBar) {
      return;
    }
    const { animation } = closing;
    const duration = animation.effect.getTiming().duration;
    const progress = Math.min(1, (animation.currentTime ?? 0) / duration);
    this.#resumeFrom = 1 - progress;
    this.#finishClose(animation);
  }
}

export const WhimsyCommandBar = {
  NEW_THINGS,
  GLANCE_SIZES,
  APPEARANCE_ACTIONS,

  get l10n() {
    const l10n = new Localization(["browser/whimsy.ftl"], true);
    Object.defineProperty(this, "l10n", { value: l10n });
    return l10n;
  },

  linkAppearanceActions() {
    const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
    const group = globalActions.filter(a => APPEARANCE_ACTIONS.includes(a.l10nId));
    for (const action of group) {
      if (Object.hasOwn(action, "whimsyKeywords")) {
        continue;
      }
      Object.defineProperty(action, "whimsyKeywords", {
        configurable: true,
        get: () => group.filter(a => a != action).map(a => a.label),
      });
    }
  },

  // W8-17: from the private command bar (or a private tab) it opens private.
  openNewThing(win, url) {
    lazy.WhimsyPrivate.openTabFor(win, url);
  },

  initWindow(win) {
    // W10-27: a quick, subtle open/close for the floating command bar.
    if (win.gURLBar && !win.WhimsyCommandBarMotion) {
      win.WhimsyCommandBarMotion = new CommandBarMotion(win);
    }
    this.initSlashFilter(win);
    this.initDedup(win);
    this.linkAppearanceActions();
    const documentKeywords = [this.l10n.formatValueSync("whimsy-action-new-document-keyword")];
    for (const thing of NEW_THINGS) {
      lazy.WhimsyCommands.register(win, {
        id: `whimsy-cmd-new-${thing.id}`,
        l10nId: thing.l10nId,
        run: w => this.openNewThing(w, thing.url),
        icon: "chrome://browser/skin/zen-icons/plus.svg",
        isAvailable: () => Services.prefs.getBoolPref(CREATE_FEATURE_PREF, true),
        ...(DOCUMENT_THINGS.has(thing.id) ? { whimsyKeywords: documentKeywords } : {}),
      });
    }
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyLiquidGlassToggle",
      l10nId: "whimsy-action-liquid-glass",
      run: () => {
        const current = Services.prefs.getBoolPref("whimsy.look.liquid-glass", false);
        Services.prefs.setBoolPref("whimsy.look.liquid-glass", !current);
      },
      icon: "chrome://browser/skin/zen-icons/sparkles.svg",
      variants: [
        {
          l10nId: "whimsy-action-liquid-glass-on",
          run: () => Services.prefs.setBoolPref("whimsy.look.liquid-glass", true),
          isAvailable: () => liquidGlassSupported() && !Services.prefs.getBoolPref("whimsy.look.liquid-glass", false),
        },
        {
          l10nId: "whimsy-action-liquid-glass-off",
          run: () => Services.prefs.setBoolPref("whimsy.look.liquid-glass", false),
          isAvailable: () => liquidGlassSupported() && Services.prefs.getBoolPref("whimsy.look.liquid-glass", false),
        },
      ],
    });
    // State-dependent settings toggles (function commands, no shortcut).
    // wave9/menus (design-full-4 M12): real commands, so each can be given
    // a shortcut in about:keyboard. Glance size is one command that cycles
    // (Compact → Standard → Wide), offered in the command bar as one row per
    // size.
    for (const spec of this.settingsCommands()) {
      lazy.WhimsyCommands.register(win, spec);
    }
  },

  // History: Zen's Library on its History section (left open if it's
  // already there), or Firefox's Library window when Zen's is off.
  viewHistory(win) {
    const Library = win.customElements.get("zen-library");
    if (Library && Services.prefs.getBoolPref("zen.library.enabled", false)) {
      if (!(Library.isLibraryOpen && Library.getInstance().activeTab == "history")) {
        Library.toggle("history");
      }
      return;
    }
    win.PlacesCommandHook.showPlacesOrganizer("History");
  },

  settingsCommands() {
    const glanceOn = () => featureOn("glance-size");
    const currentSize = () => Services.prefs.getStringPref("whimsy.glance.size", "standard");
    return [
      {
        id: "cmd_whimsyViewHistory",
        l10nId: "whimsy-action-view-history",
        run: w => this.viewHistory(w),
        icon: "chrome://browser/skin/zen-icons/history.svg",
        isAvailable: () => true,
      },
      {
        id: "cmd_whimsyGlanceSize",
        l10nId: "whimsy-action-glance-size-cycle",
        run: () => {
          if (glanceOn()) {
            const next = GLANCE_SIZES[(GLANCE_SIZES.indexOf(currentSize()) + 1) % GLANCE_SIZES.length];
            Services.prefs.setStringPref("whimsy.glance.size", next);
          }
        },
        icon: "chrome://browser/skin/zen-icons/window.svg",
        variants: GLANCE_SIZES.map(size => ({
          l10nId: `whimsy-action-glance-size-${size}`,
          run: () => Services.prefs.setStringPref("whimsy.glance.size", size),
          isAvailable: () => glanceOn() && currentSize() != size,
        })),
      },
    ];
  },

  attachSearchFavicons(results, win) {
    return attachSearchFavicons(results, win);
  },

  initResultsHook(win) {
    const controller = win.gURLBar?.controller;
    if (!controller || controller._whimsyResultsHooked) {
      return;
    }
    controller._whimsyResultsHooked = true;
    controller._whimsyDedup = true;
    const receiveResults = controller.receiveResults;
    const self = this;
    controller.receiveResults = function (queryContext) {
      try {
        if (queryContext?.results?.length) {
          if (Services.prefs.getBoolPref(DEDUP_FEATURE_PREF, true) && queryContext.results.length > 1) {
            queryContext.results = dedupResults(queryContext.results);
          }
          if (Services.prefs.getBoolPref(SEARCH_FAVICONS_FEATURE_PREF, true)) {
            self.attachSearchFavicons(queryContext.results, win);
          }
        }
      } catch (e) {
        console.error("Whimsy: command bar results hook", e);
      }
      return receiveResults.call(this, queryContext);
    };
  },

  initDedup(win) {
    this.initResultsHook(win);
  },

  initSlashFilter(win) {
    const urlbar = win.gURLBar;
    if (!urlbar?.inputField) {
      return;
    }
    urlbar.inputField.addEventListener("input", event => {
      if (!Services.prefs.getBoolPref(SLASH_FEATURE_PREF, true)) {
        return;
      }
      // wave9/menus (design-full-4 M7): only "/" typed as the first key into
      // an empty bar. A pasted or typed path (/Users/me/report.pdf, /r/…)
      // stays an address, as in Firefox.
      const value = urlbar.value;
      if (value != "/" || event.inputType != "insertText") {
        return;
      }
      const { UrlbarShared } = ChromeUtils.importESModule(
        "chrome://browser/content/urlbar/UrlbarShared.mjs"
      );
      // Enter directly: Zen's toggle can be locked by its preceding mode
      // animation, or toggle an existing commands mode back off.
      urlbar.value = value.slice(1);
      urlbar.searchMode = { source: UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS, isPreview: false };
      urlbar.startQuery({ allowAutofill: false, event });
    });
  },
};
