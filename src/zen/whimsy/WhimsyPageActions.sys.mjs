/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave6: Page actions, after Safari's Highlights: when a page describes one
// thing in schema.org data, a pill in the address bar does the obvious next
// step for it.
//   Event   -> Add to Calendar (an .ics file opened in the Calendar app)
//   Place   -> Maps, with "Open now" / "Closed" when it lists its hours
//   Recipe  -> Cook mode (ingredients to tick off and numbered steps, large,
//              with the screen kept awake while it's open)
//   Product -> Watch price (Watch a page, prefilled; only where it can run)
//   Parcel  -> Track (the carrier's tracking page)
// The page side (WhimsyPageActionsChild) parses the data; nothing here uses
// the network or a model, so it works with the AI kill switch on (except
// Watch price, which is an AI feature and is only offered when available).

const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  WhimsyPageWatch: "resource:///modules/whimsy/WhimsyPageWatch.sys.mjs",
});

const FEATURE_PREF = "whimsy.feature.page-actions";
const SHEET = "chrome://browser/content/whimsy/whimsy-navigation.css";
const PILL_ID = "whimsy-page-action";
const COOK_ID = "whimsy-cook-panel";
const ICONS = {
  event: "chrome://browser/content/whimsy/space-icons/calendar.svg",
  place: "chrome://browser/skin/zen-icons/selectable/map.svg",
  recipe: "chrome://browser/skin/zen-icons/selectable/egg.svg",
  product: "chrome://browser/skin/zen-icons/selectable/bell.svg",
  parcel: "chrome://browser/content/whimsy/space-icons/receipt.svg",
};
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_ABBR = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function isWebUrl(spec) {
  return /^https?:\/\//i.test(spec || "");
}

function sameDocument(a, b) {
  return (a || "").split("#")[0] == (b || "").split("#")[0];
}

function minutesOf(hhmm) {
  const match = /^(\d{1,2}):(\d{2})/.exec(hhmm || "");
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export class WhimsyPageActionsParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name != "WhimsyPageActions:Found") {
      return;
    }
    const browser = this.browsingContext.top?.embedderElement;
    if (browser) {
      WhimsyPageActions.onFound(browser, message.data);
    }
  }
}

export const WhimsyPageActions = {
  // browser -> { spec, action }
  _actions: new WeakMap(),

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    ChromeUtils.registerWindowActor("WhimsyPageActions", {
      parent: { esModuleURI: "resource:///modules/whimsy/WhimsyPageActions.sys.mjs" },
      child: {
        esModuleURI: "resource:///modules/whimsy/WhimsyPageActionsChild.sys.mjs",
        events: { pageshow: { mozSystemGroup: true } },
      },
      matches: ["https://*/*", "http://*/*"],
      messageManagerGroups: ["browsers"],
      // The child only reads its own page; the parent checks what it sends.
      safeForUntrustedWebProcess: true,
    });
    Services.prefs.addObserver(FEATURE_PREF, () => {
      for (const win of Services.wm.getEnumerator("navigator:browser")) {
        this.update(win);
      }
    });
  },

  initWindow(win) {
    this.init();
    if (!win.gBrowser || win._whimsyPageActions) {
      return;
    }
    win._whimsyPageActions = true;
    if (!win._whimsyNavigationSheet) {
      win._whimsyNavigationSheet = true;
      win.windowUtils.loadSheetUsingURIString(SHEET, win.windowUtils.AUTHOR_SHEET);
    }
    win.gBrowser.addTabsProgressListener({
      onLocationChange: (browser, webProgress, request, location, flags) => {
        if (!webProgress?.isTopLevel || flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) {
          return;
        }
        this._actions.delete(browser);
        if (browser == win.gBrowser.selectedBrowser) {
          this.update(win);
        }
      },
    });
    win.gBrowser.tabContainer.addEventListener("TabSelect", () => this.update(win));
  },

  // --- What the page said ---

  // Checks the child's summary (it comes from a web process) and keeps only
  // the fields each action uses, as capped strings.
  validate(action) {
    if (!action || typeof action != "object") {
      return null;
    }
    const str = (v, max = 500) => (typeof v == "string" ? v.slice(0, max) : "");
    const strs = v => (Array.isArray(v) ? v.slice(0, 60).map(x => str(x)).filter(Boolean) : []);
    const name = str(action.name, 200);
    switch (action.kind) {
      case "event":
        return name && this.parseDate(action.startDate)
          ? {
              kind: "event",
              name,
              startDate: str(action.startDate, 40),
              endDate: str(action.endDate, 40),
              location: str(action.location),
              description: str(action.description),
            }
          : null;
      case "place": {
        const hours = action.hours || {};
        return name
          ? {
              kind: "place",
              name,
              address: str(action.address),
              latitude: Number.isFinite(action.latitude) ? action.latitude : null,
              longitude: Number.isFinite(action.longitude) ? action.longitude : null,
              hours: {
                specs: (Array.isArray(hours.specs) ? hours.specs : []).slice(0, 30).map(s => ({
                  days: strs(s?.days),
                  opens: str(s?.opens, 8),
                  closes: str(s?.closes, 8),
                })),
                strings: strs(hours.strings),
              },
            }
          : null;
      }
      case "recipe": {
        const ingredients = strs(action.ingredients);
        const steps = strs(action.steps);
        return name && (ingredients.length || steps.length)
          ? { kind: "recipe", name, ingredients, steps, yield: str(action.yield, 80), totalTime: str(action.totalTime, 40) }
          : null;
      }
      case "product":
        return name ? { kind: "product", name, price: str(action.offer?.price, 30), currency: str(action.offer?.currency, 8) } : null;
      case "parcel": {
        const trackingUrl = str(action.trackingUrl, 2000);
        return isWebUrl(trackingUrl) ? { kind: "parcel", name, trackingUrl, carrier: str(action.carrier, 80) } : null;
      }
    }
    return null;
  },

  onFound(browser, data) {
    const action = this.validate(data?.action);
    if (!action || !sameDocument(data.spec, browser.currentURI?.spec)) {
      return;
    }
    this._actions.set(browser, { spec: browser.currentURI.spec, action });
    const win = browser.documentGlobal;
    if (win?.gBrowser?.selectedBrowser == browser) {
      this.update(win);
    }
  },

  actionFor(browser) {
    const entry = this._actions.get(browser);
    return entry && sameDocument(entry.spec, browser.currentURI?.spec) ? entry.action : null;
  },

  // Whether this action can run here (Watch price needs Watch a page).
  available(win, action) {
    if (action?.kind == "product") {
      try {
        return lazy.WhimsyPageWatch.canWatch(win, win.gBrowser.selectedTab);
      } catch {
        return false;
      }
    }
    return !!action;
  },

  // --- Opening hours ---

  // true / false when the place lists hours for now, else null. Uses this
  // Mac's clock (schema.org hours rarely say their time zone).
  openNow(hours, now = new Date()) {
    const intervals = [];
    for (const spec of hours?.specs ?? []) {
      const open = minutesOf(spec.opens);
      let close = minutesOf(spec.closes);
      if (open == null || close == null) {
        continue;
      }
      for (const day of spec.days) {
        const index = DAYS.indexOf(day);
        if (index >= 0) {
          intervals.push({ day: index, open, close });
        }
      }
    }
    for (const line of hours?.strings ?? []) {
      for (const part of line.split(/\s*;\s*/)) {
        const match = /^([A-Za-z,\- ]+?)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(part.trim());
        if (!match) {
          continue;
        }
        for (const day of this.expandDays(match[1])) {
          intervals.push({ day, open: minutesOf(match[2]), close: minutesOf(match[3]) });
        }
      }
    }
    if (!intervals.length) {
      return null;
    }
    const today = now.getDay();
    const yesterday = (today + 6) % 7;
    const minute = now.getHours() * 60 + now.getMinutes();
    return intervals.some(({ day, open, close }) => {
      if (close <= open) {
        // Past midnight (or round the clock when equal).
        return (day == today && minute >= open) || (day == yesterday && minute < close);
      }
      return day == today && minute >= open && minute < close;
    });
  },

  expandDays(text) {
    const days = new Set();
    for (const piece of text.replace(/\s+/g, "").split(",")) {
      const [from, to] = piece.split("-").map(d => DAY_ABBR.indexOf(d.slice(0, 2)));
      if (from < 0) {
        continue;
      }
      if (to == undefined || to < 0) {
        days.add(from);
        continue;
      }
      for (let d = from; ; d = (d + 1) % 7) {
        days.add(d);
        if (d == to) {
          break;
        }
      }
    }
    return days;
  },

  // --- The pill ---

  pill(win) {
    const doc = win.document;
    let pill = doc.getElementById(PILL_ID);
    if (pill) {
      return pill;
    }
    pill = doc.createXULElement("hbox");
    pill.id = PILL_ID;
    pill.className = "urlbar-page-action";
    pill.setAttribute("align", "center");
    pill.setAttribute("role", "button");
    pill.setAttribute("tabindex", "0");
    pill.hidden = true;
    const icon = doc.createXULElement("image");
    icon.className = "whimsy-page-action-icon";
    const label = doc.createXULElement("label");
    label.className = "whimsy-page-action-label";
    pill.append(icon, label);
    pill.addEventListener("click", event => {
      if (event.button == 0) {
        this.run(win);
      }
    });
    pill.addEventListener("keydown", event => {
      if (event.key == "Enter" || event.key == " ") {
        event.preventDefault();
        this.run(win);
      }
    });
    const buttons = doc.getElementById("page-action-buttons");
    if (buttons) {
      buttons.prepend(pill);
    } else {
      doc.getElementById("urlbar-container")?.append(pill);
    }
    return pill;
  },

  // The pill's words, and its tooltip (which names the thing).
  l10nFor(action) {
    const args = { name: action.name || "" };
    if (action.kind == "place") {
      const open = this.openNow(action.hours);
      args.state = open == null ? "unknown" : open ? "open" : "closed";
    }
    return [`whimsy-page-action-${action.kind}`, args];
  },

  update(win) {
    const browser = win.gBrowser?.selectedBrowser;
    const action = this.enabled && browser ? this.actionFor(browser) : null;
    const show = !!action && this.available(win, action);
    let pill = win.document.getElementById(PILL_ID);
    if (!show) {
      if (pill) {
        pill.hidden = true;
      }
      return;
    }
    pill ??= this.pill(win);
    const [id, args] = this.l10nFor(action);
    win.document.l10n.setAttributes(pill.querySelector(".whimsy-page-action-label"), id, args);
    win.document.l10n.setAttributes(pill, `${id}-tooltip`, args);
    pill.querySelector(".whimsy-page-action-icon").setAttribute("src", ICONS[action.kind]);
    pill.setAttribute("kind", action.kind);
    pill.hidden = false;
  },

  run(win) {
    const browser = win.gBrowser.selectedBrowser;
    const action = this.actionFor(browser);
    if (!action || !this.enabled) {
      return;
    }
    const run = {
      event: () => this.addToCalendar(win, action, browser.currentURI.spec),
      place: () => this.openInMaps(win, action),
      recipe: () => this.openCookMode(win, action),
      product: () => this.watchPrice(win, action),
      parcel: () => win.openTrustedLinkIn(action.trackingUrl, "tab", { userContextId: win.gBrowser.selectedTab.userContextId }),
    }[action.kind];
    Promise.resolve()
      .then(run)
      .catch(e => console.error("Whimsy: page actions", e));
  },

  // --- Event: Add to Calendar ---

  // { date: "YYYYMMDD", time: "HHMMSS" | null, utc: bool } or null.
  parseDate(text) {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      (text || "").trim()
    );
    if (!match) {
      return null;
    }
    const [, y, mo, d, h, mi, s, zone] = match;
    if (h == null) {
      return { date: `${y}${mo}${d}`, time: null, utc: false };
    }
    if (zone) {
      const when = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s || "00"}${zone == "Z" ? "Z" : zone.replace(/(\d{2})(\d{2})$/, "$1:$2")}`);
      if (isNaN(when)) {
        return null;
      }
      const iso = when.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
      return { date: iso.slice(0, 8), time: iso.slice(9, 15), utc: true };
    }
    return { date: `${y}${mo}${d}`, time: `${h}${mi}${s || "00"}`, utc: false };
  },

  icsEscape(text) {
    return (text || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  },

  // One VEVENT. An event without an end lasts an hour (a day when it has no
  // time), like Calendar's own default.
  buildIcs(action, pageUrl, now = new Date()) {
    const start = this.parseDate(action.startDate);
    let end = this.parseDate(action.endDate);
    const value = d => (d.time ? `${d.date}T${d.time}${d.utc ? "Z" : ""}` : d.date);
    const prop = (name, d) => (d.time ? `${name}:${value(d)}` : `${name};VALUE=DATE:${value(d)}`);
    const addDays = (date, n) => {
      const t = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8) + n));
      return t.toISOString().slice(0, 10).replace(/-/g, "");
    };
    if (end && !end.time && !start.time) {
      // schema.org's last day is inclusive; iCalendar's DTEND is not.
      end = { ...end, date: addDays(end.date, 1) };
    } else if (!end || !!end.time != !!start.time) {
      if (start.time) {
        const [h, m, s] = [start.time.slice(0, 2), start.time.slice(2, 4), start.time.slice(4, 6)];
        const t = new Date(Date.UTC(+start.date.slice(0, 4), +start.date.slice(4, 6) - 1, +start.date.slice(6, 8), +h + 1, +m, +s));
        const iso = t.toISOString().replace(/[-:]/g, "");
        end = { date: iso.slice(0, 8), time: iso.slice(9, 15), utc: start.utc };
      } else {
        end = { date: addDays(start.date, 1), time: null, utc: false };
      }
    }
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Whimsy//Page actions//EN",
      "BEGIN:VEVENT",
      `UID:${Services.uuid.generateUUID().toString().slice(1, -1)}@whimsy`,
      `DTSTAMP:${stamp}`,
      prop("DTSTART", start),
      prop("DTEND", end),
      `SUMMARY:${this.icsEscape(action.name)}`,
    ];
    if (action.location) {
      lines.push(`LOCATION:${this.icsEscape(action.location)}`);
    }
    if (isWebUrl(pageUrl)) {
      lines.push(`URL:${pageUrl.replace(/[\r\n]/g, "")}`);
    }
    if (action.description) {
      lines.push(`DESCRIPTION:${this.icsEscape(action.description)}`);
    }
    lines.push("END:VEVENT", "END:VCALENDAR");
    return lines.join("\r\n") + "\r\n";
  },

  async addToCalendar(win, action, pageUrl) {
    const ics = this.buildIcs(action, pageUrl);
    const slug = (action.name || "event").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "event";
    const path = PathUtils.join(PathUtils.tempDir, `Whimsy-${slug}-${Date.now()}.ics`);
    await IOUtils.writeUTF8(path, ics);
    if (!this._testing) {
      new lazy.FileUtils.File(path).launch();
    }
    win.gZenUIManager?.showToast?.("whimsy-page-action-calendar-toast");
    return path;
  },

  // --- Place: Maps ---

  mapsUrl(action) {
    const params = new URLSearchParams();
    params.set("q", action.name);
    if (action.address) {
      params.set("address", action.address);
    }
    if (action.latitude != null && action.longitude != null) {
      params.set("ll", `${action.latitude},${action.longitude}`);
    }
    return params.toString();
  },

  openInMaps(win, action) {
    const query = this.mapsUrl(action);
    if (AppConstants.platform == "macosx" && !this._testing) {
      const service = Cc["@mozilla.org/uriloader/external-protocol-service;1"].getService(
        Ci.nsIExternalProtocolService
      );
      service.loadURI(Services.io.newURI(`maps://?${query}`), Services.scriptSecurityManager.getSystemPrincipal());
      return;
    }
    win.openTrustedLinkIn(`https://maps.apple.com/?${query}`, "tab", {
      userContextId: win.gBrowser.selectedTab.userContextId,
    });
  },

  // --- Recipe: Cook mode ---

  openCookMode(win, action) {
    const doc = win.document;
    doc.getElementById(COOK_ID)?.remove();
    const HTML = "http://www.w3.org/1999/xhtml";
    const el = (tag, cls, text) => {
      const node = doc.createElementNS(HTML, tag);
      if (cls) {
        node.className = cls;
      }
      if (text != null) {
        node.textContent = text;
      }
      return node;
    };
    const panel = doc.createXULElement("panel");
    panel.id = COOK_ID;
    panel.setAttribute("type", "arrow");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-labelledby", "whimsy-cook-title");
    const body = el("div", "whimsy-cook-body");
    const title = el("h2", "whimsy-cook-title", action.name);
    title.id = "whimsy-cook-title";
    body.append(title);
    const facts = [action.yield, this.duration(action.totalTime)].filter(Boolean).join(" · ");
    if (facts) {
      body.append(el("p", "whimsy-cook-facts", facts));
    }
    if (action.ingredients.length) {
      const heading = el("h3", "whimsy-cook-heading");
      doc.l10n.setAttributes(heading, "whimsy-cook-ingredients");
      const list = el("ul", "whimsy-cook-ingredients");
      action.ingredients.forEach((text, i) => {
        const item = el("li");
        const box = el("input");
        box.type = "checkbox";
        box.id = `whimsy-cook-ingredient-${i}`;
        const label = el("label", "", text);
        label.htmlFor = box.id;
        item.append(box, label);
        list.append(item);
      });
      body.append(heading, list);
    }
    if (action.steps.length) {
      const heading = el("h3", "whimsy-cook-heading");
      doc.l10n.setAttributes(heading, "whimsy-cook-steps");
      const list = el("ol", "whimsy-cook-steps");
      for (const text of action.steps) {
        list.append(el("li", "", text));
      }
      body.append(heading, list);
    }
    const note = el("p", "whimsy-cook-note");
    doc.l10n.setAttributes(note, "whimsy-cook-awake");
    body.append(note);
    panel.append(body);
    doc.getElementById("mainPopupSet").append(panel);
    // Kitchen hands: the screen stays on while the recipe is open.
    let lock = null;
    try {
      lock = Cc["@mozilla.org/power/powermanagerservice;1"]
        .getService(Ci.nsIPowerManagerService)
        .newWakeLock("screen");
    } catch (e) {
      console.error("Whimsy: cook mode wake lock", e);
    }
    panel.addEventListener(
      "popuphidden",
      () => {
        try {
          lock?.unlock();
        } catch {}
        panel.remove();
      },
      { once: true }
    );
    const anchor = doc.getElementById(PILL_ID);
    panel.openPopup(anchor?.checkVisibility?.() ? anchor : doc.getElementById("urlbar-input-container"), "bottomright topright");
    return panel;
  },

  // "PT1H30M" -> "1 h 30 min".
  duration(iso) {
    const match = /^P(?:T)?(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso || "");
    if (!match || (!match[1] && !match[2])) {
      return "";
    }
    return [match[1] && `${match[1]} h`, match[2] && `${match[2]} min`].filter(Boolean).join(" ");
  },

  // --- Product: Watch price ---

  async watchPrice(win, action) {
    const tab = win.gBrowser.selectedTab;
    if (!lazy.WhimsyPageWatch.canWatch(win, tab)) {
      return;
    }
    lazy.WhimsyPageWatch.openDialog(win, tab);
    let price = action.price;
    if (price && /^\d+(\.\d+)?$/.test(price) && /^[A-Z]{3}$/.test(action.currency)) {
      try {
        price = new Intl.NumberFormat(undefined, { style: "currency", currency: action.currency }).format(Number(price));
      } catch {}
    }
    const condition = await win.document.l10n.formatValue(
      price ? "whimsy-page-action-price-condition" : "whimsy-page-action-price-condition-any",
      { price: price || "" }
    );
    const input = win.document.querySelector(".whimsy-watch-condition");
    if (input && !input.value) {
      input.value = condition;
    }
  },
};
