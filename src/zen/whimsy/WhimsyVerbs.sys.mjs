/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave5/verbs: do-with-selection verbs (idea #20). Select text, press
// Cmd+K, and the command bar opens in its actions mode listing only what
// you can do with that text: Search <default engine> for it first (so
// Cmd+K still searches, as it always has), then Translate, Map, Email,
// Copy as Markdown, Add to Note, then the ones that depend on the text or
// setup (Add to Calendar when it holds a date, New Linear Issue / Search
// Linear when a Linear live folder exists) and your own skills. The page
// verbs (nothing selected) are reachable from the command bar ("Actions
// for Selection"), never from Cmd+K. The pattern is the "act on what's
// selected" menu of PopClip, Raycast and Alfred's Universal Actions, put
// where Whimsy's command bar already is.
//
// Cmd+K: Firefox binds it to web search (key_search -> Tools:Search), and
// people rely on it (Chesterton's fence). Whimsy's Cmd+K runs exactly that
// command whenever nothing is selected, and also when the switch is off,
// on a non-web tab, or when the person moved Focus Search elsewhere
// themselves (CustomKeys, then Cmd+K stays Firefox's own key).
//
// The registry: verbs and skills share one list (registerVerb). Built-ins
// are below; user skills come from whimsy.verbs.skills, one per line,
// "Label | https://example.com/?q=%s" (%s the selection, or the page
// address when nothing is selected; %t the page title; %u its address).
// A future Skills feature registers its own entries here too.

import { UrlbarProvider } from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { UrlbarShared } from "chrome://browser/content/urlbar/UrlbarShared.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ProvidersManager: "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
  WhimsyPage: "resource:///modules/whimsy/WhimsyPage.sys.mjs",
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
  gWhimsyNotesStore: "resource:///modules/whimsy/WhimsyNotesSection.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

const FEATURE_PREF = "whimsy.feature.selection-verbs";
const SKILLS_PREF = "whimsy.verbs.skills";
const NOTES_PREF = "whimsy.feature.notes";
const COMMAND_ID = "cmd_whimsySelectionVerbs";
const KEY_ID = "key_whimsySelectionVerbs";
// Cmd+K's own command: verbs only for a selection, else Firefox's search.
const KEY_COMMAND_ID = "cmd_whimsySelectionVerbsKey";
const DYNAMIC_TYPE = "whimsy-verb";
const ICONS = "chrome://browser/skin/zen-icons/";
const MAX_SNIPPET = 40;

// ---------------------------------------------------------------------------
// Dates: enough natural language for "Add to Calendar" on what people
// select (an invite line, a schedule row): ISO dates, "Nov 3", "3 November
// 2026", "11/3", today/tomorrow/weekday names, "3pm", "3:30 pm", "15:00",
// noon, and ranges ("3-4pm", "15:00–16:30").

const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY = String.raw`(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)`;
const MERIDIEM = String.raw`(a\.?m\.?|p\.?m\.?)`;

const monthIndex = name => ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(name.slice(0, 3).toLowerCase());

function hour24(hour, meridiem) {
  let h = Number(hour);
  if (!meridiem) {
    return h;
  }
  const pm = meridiem.toLowerCase().startsWith("p");
  if (h == 12) {
    h = 0;
  }
  return pm ? h + 12 : h;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// A date without a year that already passed this year means next year.
function withYear(month, day, year, now) {
  if (year) {
    year = Number(year);
    return new Date(year < 100 ? 2000 + year : year, month, day);
  }
  let date = new Date(now.getFullYear(), month, day);
  if (date < startOfDay(now)) {
    date = new Date(now.getFullYear() + 1, month, day);
  }
  return date;
}

function findDate(text, now) {
  let m = text.match(/\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (m) {
    const date = new Date(+m[1], +m[2] - 1, +m[3]);
    const time = m[4] ? { hour: +m[4], minute: +m[5] } : null;
    return { date, match: m[0], time };
  }
  m = text.match(new RegExp(String.raw`\b(?:${WEEKDAY},?\s+)?${MONTH}\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?`, "i"));
  if (m) {
    return { date: withYear(monthIndex(m[2]), +m[3], m[4], now), match: m[0] };
  }
  m = text.match(new RegExp(String.raw`\b(?:${WEEKDAY},?\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}(?:,?\s+(\d{4}))?\b`, "i"));
  if (m) {
    return { date: withYear(monthIndex(m[3]), +m[2], m[4], now), match: m[0] };
  }
  m = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    let [month, day] = [+m[1], +m[2]];
    if (month > 12 && day <= 12) {
      [month, day] = [day, month];
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { date: withYear(month - 1, day, m[3], now), match: m[0] };
    }
  }
  m = text.match(/\b(today|tonight|tomorrow)\b/i);
  if (m) {
    const date = startOfDay(now);
    if (m[1].toLowerCase() == "tomorrow") {
      date.setDate(date.getDate() + 1);
    }
    return { date, match: m[0] };
  }
  m = text.match(new RegExp(String.raw`\b(next\s+|this\s+|on\s+)?${WEEKDAY}\b`, "i"));
  if (m) {
    const target = WEEKDAYS.indexOf(m[2].slice(0, 3).toLowerCase());
    let ahead = (target - now.getDay() + 7) % 7;
    if (ahead == 0 && /next/i.test(m[1] ?? "")) {
      ahead = 7;
    }
    const date = startOfDay(now);
    date.setDate(date.getDate() + ahead);
    return { date, match: m[0] };
  }
  return null;
}

function findTime(text) {
  // A range: "3-4pm", "3pm – 4:30pm", "15:00-16:00", "10 to 11am".
  let m = text.match(
    new RegExp(String.raw`\b(?:from\s+|at\s+)?(\d{1,2})(?::(\d{2}))?\s*${MERIDIEM}?\s*(?:-|–|—|to|until)\s*(\d{1,2})(?::(\d{2}))?\s*${MERIDIEM}(?![a-z])`, "i")
  );
  if (m) {
    const endHour = hour24(m[4], m[6]);
    let startHour = hour24(m[1], m[3] ?? m[6]);
    if (!m[3] && startHour > endHour) {
      startHour = hour24(m[1], "am");
    }
    return {
      start: { hour: startHour, minute: +(m[2] ?? 0) },
      end: { hour: endHour, minute: +(m[5] ?? 0) },
      match: m[0],
    };
  }
  m = text.match(/\b(?:from\s+)?([01]?\d|2[0-3]):([0-5]\d)\s*(?:-|–|—|to|until)\s*([01]?\d|2[0-3]):([0-5]\d)\b/i);
  if (m) {
    return { start: { hour: +m[1], minute: +m[2] }, end: { hour: +m[3], minute: +m[4] }, match: m[0] };
  }
  m = text.match(new RegExp(String.raw`\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*${MERIDIEM}(?![a-z])`, "i"));
  if (m && +m[1] >= 1 && +m[1] <= 12) {
    return { start: { hour: hour24(m[1], m[3]), minute: +(m[2] ?? 0) }, match: m[0] };
  }
  m = text.match(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) {
    return { start: { hour: +m[1], minute: +m[2] }, match: m[0] };
  }
  m = text.match(/\b(?:at\s+)?(noon|midday|midnight)\b/i);
  if (m) {
    return { start: { hour: /mid(night)$/i.test(m[1]) ? 0 : 12, minute: 0 }, match: m[0] };
  }
  return null;
}

/**
 * An event from free text, or null when it names no date or time.
 *
 * @returns {{start: Date, end: Date, allDay: boolean, title: string}|null}
 */
export function parseEvent(input, now = new Date()) {
  let text = String(input ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 500) {
    return null;
  }
  const found = findDate(text, now);
  let rest = found ? text.replace(found.match, " ") : text;
  let time = found?.time ? { start: found.time } : findTime(rest);
  if (time?.match) {
    rest = rest.replace(time.match, " ");
  }
  if (!found && !time) {
    return null;
  }
  const start = new Date(found?.date ?? startOfDay(now));
  let end;
  let allDay = !time;
  if (time) {
    start.setHours(time.start.hour, time.start.minute);
    // A time with no date that already passed today means tomorrow.
    if (!found && start < now) {
      start.setDate(start.getDate() + 1);
    }
    end = new Date(start);
    if (time.end) {
      end.setHours(time.end.hour, time.end.minute);
      if (end <= start) {
        end.setDate(end.getDate() + 1);
      }
    } else {
      end.setHours(end.getHours() + 1);
    }
  } else {
    end = new Date(start);
    end.setDate(end.getDate() + 1);
  }
  const title = rest
    .replace(/\b(on|at|from|by|until|due)\s*([,.;:!?]|$)/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.;:–—-]+|[\s,;:–—-]+$/g, "")
    .replace(/\s+(on|at|from)$/i, "")
    .slice(0, 120)
    .trim();
  return { start, end, allDay, title };
}

const pad = n => String(n).padStart(2, "0");
const icsDate = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
// Floating local time: Calendar shows it at the time that was written.
const icsLocal = d => `${icsDate(d)}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
const icsUTC = d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsText = s => String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** An iCalendar file for one event (RFC 5545), with CRLF line ends. */
export function buildICS({ start, end, allDay, title, description = "", url = "" }, now = new Date()) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Whimsy//Selection verbs//EN",
    "BEGIN:VEVENT",
    `UID:${Services.uuid.generateUUID().toString().slice(1, -1)}@whimsy`,
    `DTSTAMP:${icsUTC(now)}`,
    allDay ? `DTSTART;VALUE=DATE:${icsDate(start)}` : `DTSTART:${icsLocal(start)}`,
    allDay ? `DTEND;VALUE=DATE:${icsDate(end)}` : `DTEND:${icsLocal(end)}`,
    `SUMMARY:${icsText(title)}`,
  ];
  if (description) {
    lines.push(`DESCRIPTION:${icsText(description)}`);
  }
  if (/^https?:/.test(url)) {
    lines.push(`URL:${url}`);
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// The registry.

const enc = encodeURIComponent;
const firstLine = (text, max = 80) => {
  const line = text.split("\n").find(l => l.trim())?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const escapeMarkdown = text => text.replace(/([\\[\]])/g, "\\$1");
const pageLink = s => `[${escapeMarkdown(s.title)}](${s.url})`;

// The default search engine's name (the private one in private windows).
function defaultEngineName(win) {
  try {
    const engine = lazy.PrivateBrowsingUtils.isWindowPrivate(win)
      ? Services.search.defaultPrivateEngine
      : Services.search.defaultEngine;
    return engine?.name ?? "";
  } catch (e) {
    // The search service isn't initialized yet.
    return "";
  }
}

function isWebPage(win) {
  const tab = win?.gBrowser?.selectedTab;
  const spec = tab?.linkedBrowser?.currentURI?.spec ?? "";
  return !!tab?.linkedPanel && !tab.hasAttribute("zen-empty-tab") && /^(https?|file):|^about:reader/.test(spec);
}

// The workspace slug of the person's Linear (from any open linear.app tab,
// which the Linear live folder's issues are), for its search page.
function linearWorkspace(win) {
  for (const tab of win.gBrowser.tabs) {
    const m = tab.linkedBrowser?.currentURI?.spec.match(/^https:\/\/linear\.app\/([\w-]+)\/(?:issue|project|team|view)\//);
    if (m) {
      return m[1];
    }
  }
  return null;
}

const BUILT_IN = [
  {
    id: "search",
    l10nId: "whimsy-verb-search",
    l10n(win, s) {
      const engine = s.engineName || defaultEngineName(win);
      const text = firstLine(s.text, MAX_SNIPPET);
      return engine ? { id: "whimsy-verb-search", args: { engine, text } } : { id: "whimsy-verb-search-web", args: { text } };
    },
    icon: `${ICONS}search-glass.svg`,
    scope: "selection",
    async run(win, s) {
      const engine = lazy.PrivateBrowsingUtils.isWindowPrivate(win)
        ? await Services.search.getDefaultPrivate()
        : await Services.search.getDefault();
      WhimsyVerbs.openTab(win, engine.getSubmission(s.text).uri.spec);
    },
  },
  {
    id: "translate",
    l10nId: "whimsy-verb-translate",
    pageL10nId: "whimsy-verb-translate-page",
    icon: `${ICONS}translations.svg`,
    scope: "both",
    isAvailable: (win, s) =>
      Services.prefs.getBoolPref("browser.translations.enable", true) &&
      !!(s.kind == "selection" ? win.SelectTranslationsPanel : win.FullPageTranslationsPanel),
    run(win, s) {
      if (s.kind == "selection") {
        // Firefox Translations' selection panel, languages auto-detected
        // from the text itself (WhimsyPage.langPair).
        return win.SelectTranslationsPanel.open(null, s.x, s.y, s.text, true, lazy.WhimsyPage.langPair(win, s.text));
      }
      return win.FullPageTranslationsPanel.open(new win.Event("command"));
    },
  },
  {
    id: "map",
    l10nId: "whimsy-verb-map",
    icon: `${ICONS}geo.svg`,
    scope: "selection",
    isAvailable: (win, s) => s.text.length <= 200,
    run: (win, s) => WhimsyVerbs.openTab(win, `https://maps.apple.com/?q=${enc(s.text.replace(/\s+/g, " "))}`),
  },
  {
    id: "email",
    l10nId: "whimsy-verb-email",
    icon: `${ICONS}mail.svg`,
    scope: "both",
    run(win, s) {
      const body = s.kind == "selection" ? `${s.text}\n\n${s.url}` : s.url;
      WhimsyVerbs.openExternal(`mailto:?subject=${enc(s.title)}&body=${enc(body)}`);
    },
  },
  {
    id: "copy-markdown",
    l10nId: "whimsy-verb-copy-markdown",
    icon: `${ICONS}edit-copy.svg`,
    scope: "both",
    run(win, s) {
      WhimsyVerbs.copy(s.markdown);
      win.gZenUIManager?.showToast?.("whimsy-verb-copied-toast");
    },
  },
  {
    id: "note",
    l10nId: "whimsy-verb-note",
    icon: `${ICONS}reader-mode.svg`,
    scope: "both",
    isAvailable: () => Services.prefs.getBoolPref(NOTES_PREF, true),
    async run(win, s) {
      const text = s.kind == "selection" ? `${s.markdown}\n\n${pageLink(s)}` : pageLink(s);
      const note = await lazy.gWhimsyNotesStore.create();
      await lazy.gWhimsyNotesStore.update(note.id, { title: s.title, text, url: s.url });
      win.gZenUIManager?.showToast?.("whimsy-verb-note-toast");
    },
  },
  // Optional ones from here on, so the fixed verbs above never move.
  {
    id: "calendar",
    l10nId: "whimsy-verb-calendar",
    icon: `${ICONS}history.svg`,
    scope: "selection",
    isAvailable: (win, s) => !!s.event,
    async run(win, s) {
      const event = { ...s.event, title: s.event.title || firstLine(s.title), description: `${s.text}\n\n${s.url}`, url: s.url };
      // An .ics opened with the system: Calendar on macOS shows its "add
      // event" sheet. (Whimsy's EventKit component only reads events.)
      const path = PathUtils.join(PathUtils.tempDir, `whimsy-event-${Date.now()}.ics`);
      await IOUtils.writeUTF8(path, buildICS(event));
      WhimsyVerbs.launchFile(path);
    },
  },
  {
    id: "linear-new",
    l10nId: "whimsy-verb-linear-new",
    icon: `${ICONS}plus.svg`,
    scope: "both",
    isAvailable: () => WhimsyVerbs.linearConfigured(),
    run(win, s) {
      const title = s.kind == "selection" ? firstLine(s.text) : s.title;
      const description = s.kind == "selection" ? `${s.markdown}\n\nFrom ${pageLink(s)}` : s.url;
      WhimsyVerbs.openTab(win, `https://linear.new?title=${enc(title)}&description=${enc(description)}`);
    },
  },
  {
    id: "linear-search",
    l10nId: "whimsy-verb-linear-search",
    icon: `${ICONS}search-page.svg`,
    scope: "selection",
    isAvailable: () => WhimsyVerbs.linearConfigured(),
    run(win, s) {
      const workspace = linearWorkspace(win);
      const base = workspace ? `https://linear.app/${workspace}/search` : "https://linear.app/search";
      WhimsyVerbs.openTab(win, `${base}?q=${enc(firstLine(s.text, 200))}`);
    },
  },
];

// whimsy.verbs.skills: "Label | URL template" per line; "#" starts a comment.
function userSkills() {
  const lines = Services.prefs.getStringPref(SKILLS_PREF, "").split(/\r?\n/);
  const skills = [];
  for (const line of lines) {
    const [label, template] = line.split("|").map(p => p?.trim());
    if (!label || label.startsWith("#") || !/^https?:\/\//i.test(template ?? "")) {
      continue;
    }
    skills.push({
      id: `skill:${label}`,
      label,
      icon: `${ICONS}sparkles.svg`,
      scope: "both",
      run(win, s) {
        const url = template
          .replace(/%s/g, enc(s.kind == "selection" ? s.text : s.url))
          .replace(/%t/g, enc(s.title))
          .replace(/%u/g, enc(s.url));
        WhimsyVerbs.openTab(win, url);
      },
    });
  }
  return skills;
}

// Matches the label's words from their start, then anywhere, then as a
// subsequence (like the command bar's own fuzzy match).
function score(label, query) {
  const l = label.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) {
    return 1;
  }
  if (l.startsWith(q)) {
    return 4;
  }
  if (l.split(/\s+/).some(w => w.startsWith(q))) {
    return 3;
  }
  if (l.includes(q)) {
    return 2;
  }
  let i = 0;
  for (const ch of l) {
    if (ch == q[i]) {
      i++;
    }
  }
  return i == q.length ? 1 : 0;
}

let nextSubjectId = 0;

export const WhimsyVerbs = {
  provider: null,
  // Verbs other modules (Skills) add: { id, label or l10nId, icon, scope
  // ("selection", "page" or "both"), isAvailable(win, subject), run(win,
  // subject) }.
  registered: [],
  // window → the subject of its open verb session.
  sessions: new WeakMap(),
  // subject id → subject, for the rows' engagement (a few, newest last).
  subjects: new Map(),

  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, true);
  },

  registerVerb(verb) {
    this.registered = this.registered.filter(v => v.id != verb.id).concat(verb);
  },

  unregisterVerb(id) {
    this.registered = this.registered.filter(v => v.id != id);
  },

  /** The verbs for a subject in a window, in their stable order. */
  verbsFor(win, subject) {
    return [...BUILT_IN, ...this.registered, ...userSkills()].filter(verb => {
      if (verb.scope != "both" && verb.scope != subject.kind) {
        return false;
      }
      try {
        return verb.isAvailable ? verb.isAvailable(win, subject) : true;
      } catch (e) {
        console.error(`Whimsy: verb ${verb.id}`, e);
        return false;
      }
    });
  },

  labelFor(verb, subject, win = null) {
    if (verb.label) {
      return verb.label;
    }
    if (verb.l10n) {
      const { id, args } = verb.l10n(win, subject);
      return lazy.l10n.formatValueSync(id, args);
    }
    const id = subject.kind == "page" && verb.pageL10nId ? verb.pageL10nId : verb.l10nId;
    return lazy.l10n.formatValueSync(id);
  },

  // ---- Side effects, one place each so tests can stub them.
  openTab(win, url) {
    win.openTrustedLinkIn(url, "tab");
  },
  openExternal(spec) {
    Cc["@mozilla.org/uriloader/external-protocol-service;1"]
      .getService(Ci.nsIExternalProtocolService)
      .loadURI(Services.io.newURI(spec), Services.scriptSecurityManager.getSystemPrincipal());
  },
  copy(text) {
    Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(text);
  },
  launchFile(path) {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    file.launch();
  },
  linearConfigured() {
    try {
      const { ZenLiveFoldersManager } = ChromeUtils.importESModule(
        "resource:///modules/zen/ZenLiveFoldersManager.sys.mjs"
      );
      return [...ZenLiveFoldersManager.liveFolders.values()].some(f => f.constructor?.type == "linear");
    } catch (e) {
      return false;
    }
  },

  /** What the verbs act on: the selection (any frame), else the page. */
  async subjectFor(win) {
    if (!isWebPage(win)) {
      return null;
    }
    const browser = win.gBrowser.selectedBrowser;
    const url = browser.currentURI.spec;
    const title = win.gBrowser.selectedTab.label || browser.contentTitle || url;
    const contexts = browser.browsingContext?.getAllBrowsingContextsInSubtree() ?? [];
    for (const context of contexts) {
      try {
        const actor = context.currentWindowGlobal?.getActor("WhimsyPage");
        const found = await actor?.sendQuery("Whimsy:Selection");
        if (!found?.text) {
          continue;
        }
        let markdown = "";
        try {
          markdown = await actor.sendQuery("Whimsy:SelectionMarkdown");
        } catch (e) {
          // Text fields have no rich selection; the text is the Markdown.
        }
        return {
          kind: "selection",
          text: found.text,
          markdown: markdown || found.text,
          x: found.x,
          y: found.y,
          url,
          title,
          event: parseEvent(found.text),
        };
      } catch (e) {
        // A frame that went away.
      }
    }
    return { kind: "page", text: "", markdown: pageLink({ title, url }), url, title, event: null };
  },

  /** Command bar: the verbs for the selection, else for the page. */
  async open(win) {
    const subject = this.enabled ? await this.subjectFor(win) : null;
    if (!subject) {
      this.search(win);
      return null;
    }
    await this.start(win, subject);
    return subject;
  },

  /**
   * Cmd+K: with text selected, its verbs (Search first); otherwise exactly
   * Firefox's Cmd+K, the web search.
   */
  async openFromKey(win) {
    const subject = this.enabled ? await this.subjectFor(win) : null;
    if (subject?.kind != "selection") {
      this.search(win);
      return null;
    }
    await this.start(win, subject);
    return subject;
  },

  // Firefox's own Cmd+K (key_search): focus the web search.
  search(win) {
    win.document.getElementById("Tools:Search")?.doCommand();
  },

  async start(win, subject) {
    if (subject.kind == "selection" && !subject.engineName) {
      // For the Search verb's label ("Search Google for ...").
      try {
        await Services.search.init();
      } catch (e) {
        // No engines: the label falls back to its plain form.
      }
      subject.engineName = defaultEngineName(win);
    }
    subject.id = ++nextSubjectId;
    this.subjects.set(subject.id, subject);
    for (const id of this.subjects.keys()) {
      if (this.subjects.size <= 5) {
        break;
      }
      this.subjects.delete(id);
    }
    this.sessions.set(win, subject);
    const urlbar = win.gURLBar;
    urlbar.select();
    urlbar.value = "";
    urlbar.searchMode = { source: UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS, isPreview: false };
    urlbar.startQuery({ allowAutofill: false });
    // The session ends when the bar closes; plain "/" commands come back.
    urlbar.inputField.addEventListener(
      "blur",
      () => {
        if (this.sessions.get(win) == subject) {
          this.sessions.delete(win);
        }
      },
      { once: true }
    );
  },

  async runVerb(win, verbId, subject) {
    const verb = this.verbsFor(win, subject).find(v => v.id == verbId);
    if (!verb) {
      return false;
    }
    try {
      await verb.run(win, subject);
      return true;
    } catch (e) {
      console.error(`Whimsy: verb ${verbId} failed`, e);
      return false;
    }
  },

  // ---- Wiring.
  init() {
    if (this.provider) {
      return;
    }
    const manager = lazy.ProvidersManager.getInstanceForSap("urlbar");
    this.provider = manager.getProvider("WhimsyVerbs");
    if (!this.provider) {
      this.provider = new WhimsyVerbsProvider();
      manager.registerProvider(this.provider);
    }
  },

  initWindow(win) {
    this.init();
    const shortcuts = lazy.WhimsyShortcuts;
    shortcuts.addCommand(win, { id: COMMAND_ID, run: w => this.open(w).catch(console.error) });
    shortcuts.addCommand(win, { id: KEY_COMMAND_ID, run: w => this.openFromKey(w).catch(console.error) });
    shortcuts.addActions([
      {
        l10nId: "whimsy-action-selection-verbs",
        command: COMMAND_ID,
        icon: `${ICONS}bolt.svg`,
        isAvailable: w => this.enabled && isWebPage(w),
      },
    ]);
    if (!this.enabled || shortcuts.isCustomized("key_search")) {
      return;
    }
    // Take Cmd+K from Focus Search (see the top of this file).
    const search = win.document.getElementById("key_search");
    if (search) {
      for (const attr of ["data-l10n-id", "key", "keycode", "modifiers"]) {
        search.removeAttribute(attr);
      }
      // Gecko reads <key>s only when their keyset is (re)bound.
      const keyset = search.parentElement;
      const parent = keyset.parentElement;
      keyset.remove();
      parent.append(keyset);
    }
    shortcuts.addKey(win, { id: KEY_ID, command: KEY_COMMAND_ID, key: "K", modifiers: "accel" });
  },
};

export class WhimsyVerbsProvider extends UrlbarProvider {
  get name() {
    return "WhimsyVerbs";
  }

  get type() {
    return UrlbarShared.PROVIDER_TYPE.HEURISTIC;
  }

  // Above Zen's actions (0) and recent tabs (2): while a verb session is
  // on, the bar lists only the verbs.
  getPriority() {
    return 10;
  }

  #session() {
    const win = lazy.BrowserWindowTracker.getTopWindow();
    const subject = win && WhimsyVerbs.sessions.get(win);
    return subject ? { win, subject } : null;
  }

  async isActive(context) {
    return (
      WhimsyVerbs.enabled &&
      context.searchMode?.source == UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS &&
      !!this.#session()
    );
  }

  async startQuery(context, addCallback) {
    const session = this.#session();
    if (!session) {
      return;
    }
    const { win, subject } = session;
    const query = context.searchString ?? "";
    const snippet = subject.kind == "selection" ? firstLine(subject.text, MAX_SNIPPET) : subject.title;
    const rows = WhimsyVerbs.verbsFor(win, subject)
      .map((verb, index) => ({ verb, index, label: WhimsyVerbs.labelFor(verb, subject, win) }))
      .map(row => ({ ...row, score: score(row.label, query) }))
      .filter(row => row.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);
    for (const [i, { verb, label }] of rows.entries()) {
      addCallback(
        this,
        new lazy.UrlbarResult({
          type: UrlbarShared.RESULT_TYPE.DYNAMIC,
          source: UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS,
          heuristic: i == 0 && !!query.trim(),
          rowLabel: {
            id: subject.kind == "selection" ? "whimsy-verbs-row-selection" : "whimsy-verbs-row-page",
            args: { text: snippet },
          },
          payload: {
            dynamicType: DYNAMIC_TYPE,
            zenAction: true,
            whimsyVerb: verb.id,
            subjectId: subject.id,
            title: label,
            icon: verb.icon,
          },
        })
      );
    }
  }

  getViewTemplate() {
    return {
      attributes: { selectable: true },
      children: [
        { name: "icon", tag: "img", classList: ["urlbarView-favicon"] },
        { name: "title", tag: "span", classList: ["urlbarView-title"] },
      ],
    };
  }

  getViewUpdate(result) {
    return {
      icon: { attributes: { src: result.payload.icon } },
      title: { textContent: result.payload.title },
    };
  }

  onEngagement(_context, _controller, details) {
    const { whimsyVerb, subjectId } = details.result?.payload ?? {};
    const subject = WhimsyVerbs.subjects.get(subjectId);
    const win = details.element?.documentGlobal ?? lazy.BrowserWindowTracker.getTopWindow();
    if (!subject || !win || !WhimsyVerbs.enabled) {
      return;
    }
    WhimsyVerbs.sessions.delete(win);
    win.gURLBar.searchMode = null;
    win.gBrowser.selectedBrowser.focus();
    WhimsyVerbs.runVerb(win, whimsyVerb, subject);
  }
}
