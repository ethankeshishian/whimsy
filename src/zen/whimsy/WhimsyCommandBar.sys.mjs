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
    if (!url || !title || (i == 0 && result.heuristic)) {
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
// opens with a short, subtle scale-and-fade, the way Arc's command bar does.
// Zen draws the bar centred with `translate: -50% 0`, so the motion animates
// the `translate` and `scale` properties around that base and never
// `transform`. Opening is noticed from the bar's own attributes; the
// animation only plays over a bar Zen has already opened.
//
// C1 (wave 13): closing is Zen's own, synchronous and unchanged. The
// earlier close motion deferred Zen's hide (a hotfix in the urlbar's
// #closePopover): the bar's state closed while it stayed on screen, which
// showed the sidebar bar behind it and let old text leak into the next
// session. Now the close motion is only a picture: when Zen stops floating
// the bar, an inert stand-in with the bar's last shape and colour (kept up
// to date while it floats) fades and lifts where the bar was, then goes
// away. The stand-in has no pointer events, can't take focus, isn't in the
// accessibility tree and never reads or changes the bar's state.
export const MOTION_FEATURE_PREF = "whimsy.feature.command-bar-motion";
export const COMMAND_BAR_MOTION = {
  open: { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)", scale: 0.97, rise: 6 },
  close: { duration: 110, easing: "cubic-bezier(0.4, 0, 1, 1)", scale: 0.98, rise: 4 },
  openReduced: { duration: 100, easing: "linear" },
  closeReduced: { duration: 80, easing: "linear" },
};

// How long past its duration a close stand-in may stay before it's removed
// anyway (an animation that never finishes: a throttled window).
const GHOST_GRACE_MS = 250;
const GHOST_CLASS = "whimsy-command-bar-ghost";

export class CommandBarMotion {
  #win;
  #shown = false;
  #animation = null;
  // The floating bar's last box and look, for the close stand-in, and a
  // picture of it taken when it last settled (results shown, typing paused).
  #last = null;
  #picture = null;
  #pictureTimer = null;

  constructor(win) {
    this.#win = win;
    const urlbar = win.gURLBar;
    this.#shown = this.#isFloatingOpen(urlbar);
    this.observer = new win.MutationObserver(records => this.#onAttributes(records));
    this.observer.observe(urlbar, {
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["open", "zen-floating-urlbar"],
    });
    // While the bar floats, its box changes as results come and go: keep
    // the last one (read here, where layout is up to date).
    this.resizer = new win.ResizeObserver(() => this.#remember());
    this.resizer.observe(urlbar);
    // What the bar shows changes without its size changing (typing, new
    // rows): re-take its picture once it settles.
    this.content = new win.MutationObserver(() => this.#queuePicture());
    this.content.observe(urlbar, { childList: true, subtree: true, characterData: true });
    urlbar.inputField?.addEventListener("input", () => this.#queuePicture());
    win.addEventListener(
      "unload",
      () => {
        this.observer.disconnect();
        this.resizer.disconnect();
        this.content.disconnect();
        win.clearTimeout(this.#pictureTimer);
      },
      { once: true }
    );
  }

  #remember() {
    const urlbar = this.#win.gURLBar;
    if (!this.#isFloatingOpen(urlbar)) {
      return;
    }
    const background = urlbar.querySelector(".urlbar-background") ?? urlbar;
    const rect = background.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    const style = this.#win.getComputedStyle(background);
    this.#queuePicture();
    this.#last = {
      rect,
      background: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      radius: style.borderRadius,
      shadow: style.boxShadow,
      border: style.border,
      outline: style.outline,
    };
  }

  // A picture of the floating bar, 80ms after it last changed. Taken by the
  // window's own compositor (drawSnapshot); never reads or changes the bar.
  #queuePicture() {
    const win = this.#win;
    if (!this.enabled || !this.#isFloatingOpen(win.gURLBar)) {
      return;
    }
    win.clearTimeout(this.#pictureTimer);
    this.#pictureTimer = win.setTimeout(() => this.#takePicture(), 80);
  }

  async #takePicture() {
    const win = this.#win;
    const urlbar = win.gURLBar;
    if (!this.#isFloatingOpen(urlbar) || this.#animation) {
      return;
    }
    const background = urlbar.querySelector(".urlbar-background") ?? urlbar;
    const rect = background.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    try {
      const bitmap = await win.browsingContext.currentWindowGlobal.drawSnapshot(
        new win.DOMRect(rect.x, rect.y, rect.width, rect.height), win.devicePixelRatio, "rgba(0,0,0,0)"
      );
      // Only if the bar is still the same (not closed or moved meanwhile).
      if (this.#isFloatingOpen(urlbar)) {
        this.#picture?.bitmap.close();
        this.#picture = { bitmap, rect };
      } else {
        bitmap.close();
      }
    } catch (e) {
      // No picture: the stand-in is the bar's plain shape.
    }
  }

  // C1: the close, as a picture only. Zen has already hidden the bar.
  #playCloseGhost() {
    const last = this.#last;
    this.#last = null;
    const picture = this.#picture;
    this.#picture = null;
    const win = this.#win;
    win.clearTimeout(this.#pictureTimer);
    if (!last || !this.enabled || win.document.hidden) {
      picture?.bitmap.close();
      return null;
    }
    const doc = win.document;
    const ghost = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    // The bar as it last looked, if that picture is of this box.
    if (picture && Math.abs(picture.rect.top - last.rect.top) < 2 && Math.abs(picture.rect.height - last.rect.height) < 2) {
      const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = picture.bitmap.width;
      canvas.height = picture.bitmap.height;
      canvas.getContext("2d").drawImage(picture.bitmap, 0, 0);
      Object.assign(canvas.style, { width: "100%", height: "100%", display: "block", borderRadius: "inherit" });
      ghost.append(canvas);
    }
    picture?.bitmap.close();
    ghost.className = GHOST_CLASS;
    ghost.inert = true;
    ghost.setAttribute("aria-hidden", "true");
    ghost.setAttribute("role", "presentation");
    Object.assign(ghost.style, {
      position: "fixed",
      left: `${last.rect.left}px`,
      top: `${last.rect.top}px`,
      width: `${last.rect.width}px`,
      height: `${last.rect.height}px`,
      backgroundColor: last.background,
      backgroundImage: last.backgroundImage,
      borderRadius: last.radius,
      boxShadow: last.shadow,
      border: last.border,
      outline: last.outline,
      boxSizing: "border-box",
      overflow: "hidden",
      pointerEvents: "none",
      zIndex: "2147483647",
      transformOrigin: "50% 0",
    });
    doc.documentElement.append(ghost);
    const spec = COMMAND_BAR_MOTION[this.reduced ? "closeReduced" : "close"];
    const frames = this.reduced
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [
          { opacity: 1, scale: "1", translate: "0 0" },
          { opacity: 0, scale: String(spec.scale), translate: `0 -${spec.rise}px` },
        ];
    const animation = ghost.animate(frames, { duration: spec.duration, easing: spec.easing, fill: "forwards" });
    const remove = () => {
      win.clearTimeout(timer);
      ghost.remove();
    };
    const timer = win.setTimeout(remove, spec.duration + GHOST_GRACE_MS);
    animation.finished.then(remove, remove);
    return ghost;
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

  #isFloatingOpen(urlbar) {
    return urlbar.getAttribute("zen-floating-urlbar") == "true" && urlbar.hasAttribute("open");
  }

  // Keyframes around the bar's own translate (Zen's -50% 0, or none in
  // Mini's bar-only panel), so the bar never jumps sideways.
  #frames(kind) {
    const urlbar = this.#win.gURLBar;
    const spec = COMMAND_BAR_MOTION[kind];
    if (this.reduced) {
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

  #onAttributes(records = []) {
    const urlbar = this.#win.gURLBar;
    if (urlbar.getAttribute("zen-floating-urlbar") != "true") {
      const wasFloating = records.some(r => r.attributeName == "zen-floating-urlbar" && r.oldValue == "true");
      this.#shown = false;
      this.#animation?.cancel();
      this.#animation = null;
      if (wasFloating) {
        this.#playCloseGhost();
      }
      return;
    }
    if (this.#shown || !urlbar.hasAttribute("open")) {
      return;
    }
    this.#shown = true;
    this.#remember();
    this.playOpen();
  }

  playOpen() {
    const urlbar = this.#win.gURLBar;
    if (!this.enabled || this.#win.document.hidden) {
      return null;
    }
    this.#animation?.cancel();
    // A close stand-in still fading goes at once: the bar is back.
    for (const ghost of this.#win.document.querySelectorAll(`.${GHOST_CLASS}`)) {
      ghost.remove();
    }
    const animation = urlbar.animate(this.#frames("open"), { ...this.#timing("open"), id: "whimsy-command-bar-open" });
    this.#animation = animation;
    animation.finished.then(
      () => {
        if (this.#animation == animation) {
          this.#animation = null;
        }
        // Its resting box (the open motion scales and lifts it).
        this.#remember();
      },
      () => {}
    );
    return animation;
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
