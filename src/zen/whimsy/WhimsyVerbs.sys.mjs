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
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  WhimsyCopy: "resource:///modules/whimsy/WhimsyCopy.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  // Gecko 159 has no Services.search; the service is this module.
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  ProvidersManager: "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  UrlbarResult: "chrome://browser/content/urlbar/UrlbarResult.mjs",
  WhimsyPage: "resource:///modules/whimsy/WhimsyPage.sys.mjs",
  WhimsyCommands: "resource:///modules/whimsy/WhimsyCommands.sys.mjs",
  WhimsyShortcuts: "resource:///modules/whimsy/WhimsyShortcuts.sys.mjs",
  WhimsyPrivate: "resource:///modules/whimsy/WhimsyPrivate.sys.mjs",
  WhimsyProfiles: "resource:///modules/whimsy/WhimsyProfiles.sys.mjs",
  gWhimsyNotesStore: "resource:///modules/whimsy/WhimsyNotesSection.sys.mjs",
  WhimsyNotes: "resource:///modules/whimsy/WhimsyNotesSection.sys.mjs",
  WhimsyMenuPrefs: "resource:///modules/whimsy/WhimsyMenuPrefs.sys.mjs",
  WhimsyAICommands: "resource:///modules/whimsy/WhimsyAICommands.sys.mjs",
  linkFor: "resource:///modules/whimsy/WhimsyAICommands.sys.mjs",
  WhimsyAI: "resource:///modules/whimsy/WhimsyAI.sys.mjs",
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
  WhimsyAIHints: "resource:///modules/whimsy/WhimsyAIHints.sys.mjs",
  WhimsyAIViewShare: "resource:///modules/whimsy/WhimsyAIViewShare.sys.mjs",
  WhimsyChat: "resource:///modules/whimsy/WhimsyChat.sys.mjs",
  WhimsyCommandBarAI: "resource:///modules/whimsy/WhimsyCommandBarAI.sys.mjs",
  WhimsyDictation: "resource:///modules/whimsy/WhimsyDictation.sys.mjs",
  WhimsyUndo: "resource:///modules/whimsy/WhimsyUndo.sys.mjs",
  LanguageDetector: "resource://gre/modules/translations/LanguageDetector.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "l10n", () => new Localization(["browser/whimsy.ftl"], true));

const FEATURE_PREF = "whimsy.feature.selection-verbs";
const NOTES_PREF = "whimsy.feature.notes";
const COMMAND_ID = "cmd_whimsySelectionVerbs";
const KEY_ID = "key_whimsySelectionVerbs";
// Cmd+K's own command: verbs only for a selection, else Firefox's search.
const KEY_COMMAND_ID = "cmd_whimsySelectionVerbsKey";
const DYNAMIC_TYPE = "whimsy-verb";
// A greyed row that can't be picked (fu-media 4.10).
const OFF_TYPE = "whimsy-verb-off";
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
// Any line break (a lone CR too) becomes "\n", and other control
// characters go, so page text can't start a property of its own.
const icsText = s =>
  String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

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

// A private window, or a private tab in a normal one.
function isPrivate(win) {
  return lazy.PrivateBrowsingUtils.isWindowPrivate(win) ||
    lazy.WhimsyPrivate.isPrivateTab(win?.gBrowser?.selectedTab);
}

// The default search engine's name (the private one in private browsing).
function defaultEngineName(win) {
  try {
    const engine = isPrivate(win)
      ? lazy.SearchService.defaultPrivateEngine
      : lazy.SearchService.defaultEngine;
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

// The workspace slug of the person's Linear, for its search page: from any
// tab on a workspace page (the Linear live folder's issues are such tabs),
// else the last one seen. wave7/small: Linear doesn't document a search
// URL; its app routes everything under linear.app/<workspace>/, and its
// search page is linear.app/<workspace>/search?q=<terms> (what the app
// itself shows after a search). Without a workspace, linear.app/search
// would be read as a workspace named "search", so there's no fallback URL.
const LINEAR_WORKSPACE_PREF = "whimsy.verbs.linear-workspace";
const LINEAR_PAGE =
  /^https:\/\/linear\.app\/([\w-]+)\/(?:issue|issues|project|projects|team|view|views|my-issues|inbox|search|initiative|initiatives|document|cycle|settings)(?:[/?#]|$)/;

// linear.app's own site pages, never a workspace (linear.app/docs/search
// is the docs' Search page).
const LINEAR_SITE_ROOTS = new Set([
  "docs", "changelog", "pricing", "features", "about", "blog", "careers", "customers",
  "method", "contact", "login", "signup", "join", "integrations", "developers", "now", "homepage",
]);

export function linearWorkspace(win) {
  for (const tab of win.gBrowser.tabs) {
    const m = tab.linkedBrowser?.currentURI?.spec.match(LINEAR_PAGE);
    if (m && !LINEAR_SITE_ROOTS.has(m[1].toLowerCase())) {
      Services.prefs.setStringPref(LINEAR_WORKSPACE_PREF, m[1]);
      return m[1];
    }
  }
  return Services.prefs.getStringPref(LINEAR_WORKSPACE_PREF, "") || null;
}

export function linearSearchUrl(workspace, terms) {
  return workspace ? `https://linear.app/${enc(workspace)}/search?q=${enc(terms)}` : null;
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
      const engine = isPrivate(win)
        ? await lazy.SearchService.getDefaultPrivate()
        : await lazy.SearchService.getDefault();
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
      WhimsyVerbs.copy(s.markdown, win);
      win.gZenUIManager?.showToast?.("whimsy-verb-copied-toast");
    },
  },
  {
    id: "note",
    l10nId: "whimsy-verb-note",
    icon: `${ICONS}reader-mode.svg`,
    scope: "both",
    // wave8/isolation & W8-49: a private page's text and address never go to notes.
    isAvailable: win => Services.prefs.getBoolPref(NOTES_PREF, true) && !isPrivate(win),
    async run(win, s) {
      if (isPrivate(win)) {
        return;
      }
      const text = s.kind == "selection" ? `${s.markdown}\n\n${pageLink(s)}` : pageLink(s);
      const userContextId = win.gBrowser?.selectedTab?.userContextId ?? 0;
      const profileKey = lazy.WhimsyProfiles.keyFor(userContextId);
      const note = await lazy.gWhimsyNotesStore.create({ profileKey });
      const saved = await lazy.gWhimsyNotesStore.update(note.id, { title: s.title, text, url: s.url });
      // W10-26: "Note saved", with Open, like the Quick Note card.
      lazy.WhimsyNotes.showSavedToast(win, saved ?? note);
    },
  },
  // Optional ones from here on, so the fixed verbs above never move.
  {
    id: "calendar",
    l10nId: "whimsy-verb-calendar",
    icon: `${ICONS}history.svg`,
    scope: "selection",
    // Not from private browsing (wave9/secfix, security-full-2 L4): the
    // event carries the selection and the page's URL into Calendar, which
    // syncs.
    isAvailable: (win, s) => !!s.event && !isPrivate(win),
    async run(win, s) {
      const event = { ...s.event, title: s.event.title || firstLine(s.title), description: `${s.text}\n\n${s.url}`, url: s.url };
      // wave7/native1: straight into macOS Calendar through EventKit
      // (asks for write-only access the first time). Without it (denied,
      // another platform, an error) an .ics opened with the system:
      // Calendar on macOS shows its "add event" sheet.
      if (await WhimsyVerbs.addToSystemCalendar(event)) {
        win.gZenUIManager?.showToast?.("whimsy-verb-calendar-added-toast");
        return;
      }
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
      const terms = firstLine(s.text, 200);
      const url = linearSearchUrl(linearWorkspace(win), terms);
      if (url) {
        WhimsyVerbs.openTab(win, url);
        return;
      }
      // No workspace known yet: Linear opens the person's own workspace;
      // the terms are on the clipboard for its search (/).
      WhimsyVerbs.copy(terms, win);
      WhimsyVerbs.openTab(win, "https://linear.app/");
      win.gZenUIManager?.showToast?.("whimsy-verb-linear-copied-toast");
    },
  },
];

// Your Link commands (W23: Settings › AI › Commands, where the old
// whimsy.verbs.skills lines moved), "%s" the selection or the page address.
function userSkills() {
  return lazy.WhimsyAICommands.links().map(link => ({
    id: `skill:${link.id}`,
    label: link.name,
    icon: `${ICONS}link.svg`,
    scope: "both",
    run(win, s) {
      WhimsyVerbs.openTab(win, lazy.linkFor(link.url, s));
    },
  }));
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

// ---------------------------------------------------------------------------
// W23 ⌘K: context-aware AI commands (spec "⌘K"; cmd-3.x, cmd dec-11–15).
// With AI on in a normal tab, ⌘K measures the view once as it opens and
// groups commands: the selection's (AI text commands, then today's verbs
// with Search first, then yours), or with nothing selected the kinds of
// content by how much of the view each takes (ties article > video >
// image, three rows each), a product page's commands on top. The order is
// frozen while the bar is open. Typing flattens everything into one ranked
// list; with no match, an Ask row scoped to the screen, then web search.
// AI off or private: exactly the verbs above, unchanged.

const CONTEXT_FEATURE = "whimsy.feature.ai-context-commands";
const SPARKLE = `${ICONS}sparkles.svg`;
const WICONS = "chrome://browser/content/whimsy/icons/";
const VIEW_KINDS = ["article", "video", "image"];
const HOLD_TO_SPEAK_MS = 300;
// K's auto-repeat (see initHoldToSpeak): the longest macOS initial delay,
// the wait for the second repeat, the shortest allowed gap, and the check.
const REPEAT_FIRST_MS = 2000;
const REPEAT_NEXT_MS = 500;
const REPEAT_MIN_MS = 150;
const TICK_MS = 16;
const TOP_ROWS = 3;
const MIN_SHARE = 0.04;
// "This page": optional rows other lanes register keep this order, with
// "Change this page…" right above Zap Elements.
const IMAGE_ORDER = ["ai:ask-image", "image-text:translate", "image-text:copy", "image:copy", "image:save"];
const PAGE_ORDER = ["pip", "change-page", "zap", "translate", "copy-markdown", "note", "email", "linear-new"];

function contextOn(win) {
  const tab = win?.gBrowser?.selectedTab;
  return Services.prefs.getBoolPref(CONTEXT_FEATURE, true) && lazy.WhimsyAI.enabled && !!tab && !lazy.WhimsyAIContext.isPrivate(tab);
}

function chat(win, opts) {
  win.gURLBar.view.close();
  return lazy.WhimsyChat.open(win, { focus: "composer", ...opts });
}

function languageName(tag) {
  try {
    return new Intl.DisplayNames([Services.locale.appLocaleAsBCP47], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

// S3: a language as people say it, "English" rather than "American
// English", unless the other side shares its base language (en-GB → en-US).
function shownLanguage(tag, other = null) {
  const baseOf = t => String(t ?? "").split("-")[0].toLowerCase();
  return languageName(other && baseOf(other) == baseOf(tag) ? tag : baseOf(tag) || tag);
}

const base = tag => String(tag ?? "").split("-")[0].toLowerCase();

// The AI rows each kind of content offers. `text` rows answer in the bar's
// card on read-only text and replace in place in a field.
const AI_ROWS = {
  selection: [
    { id: "ai:explain", l10nId: "whimsy-cmdk-explain", icon: SPARKLE, prompt: "Explain the text below simply and briefly, in the language I use. Say what it means and why it matters.\n\n{selection}" },
    { id: "ai:translate", command: "translate", translate: true },
    { id: "ai:ask-selection", l10nId: "whimsy-cmdk-ask-selection", icon: `${WICONS}chat.svg`, run: (win, s) => chat(win, { prompt: `“${firstLine(s.text, 200)}” ` }) },
  ],
  field: [
    { id: "ai:improve", command: "improve" },
    { id: "ai:fix", command: "fix" },
    { id: "ai:translate", command: "translate", translate: true },
  ],
  article: [
    {
      id: "ai:summarize-page",
      l10nId: "whimsy-cmdk-summarize-page",
      icon: `${WICONS}summarize.svg`,
      unavailable: (win, s, view) => ((view?.textChars ?? 0) < 200 ? "whimsy-cmdk-unavailable-no-text" : null),
      run: win => chat(win, { prompt: lazy.l10n.formatValueSync("whimsy-cmdk-summarize-prompt"), send: true }),
    },
    { id: "ai:ask-page", l10nId: "whimsy-cmdk-ask-page", icon: `${WICONS}chat.svg`, run: win => chat(win) },
  ],
  video: [{ id: "ai:ask-video", l10nId: "whimsy-cmdk-ask-video", icon: `${WICONS}chat.svg`, run: win => chat(win) }],
  image: [
    {
      id: "ai:ask-image",
      l10nId: "whimsy-cmdk-ask-image",
      l10nArgs: (s, view) => ({ count: lazy.WhimsyAIViewShare.pickImages(view).length }),
      icon: `${WICONS}chat.svg`,
      run: win => chat(win),
    },
  ],
  product: [{ id: "ai:ask-product", l10nId: "whimsy-cmdk-ask-product", icon: `${WICONS}chat.svg`, run: win => chat(win) }],
};

export const WhimsyContextCommands = {
  // Tests stand in for language detection: text -> BCP 47 tag or null.
  detectLanguage: null,

  async languageOf(text) {
    if (this.detectLanguage) {
      return this.detectLanguage(text);
    }
    try {
      const { language, languages } = await lazy.LanguageDetector.detectLanguage(text);
      const tag = languages?.[0]?.languageCode || language || null;
      return tag == "un" || tag == "und" ? null : tag;
    } catch {
      return null;
    }
  },

  /** Fills in what ⌘K needs to rank: the view, the selection's field and language. */
  async prepare(win, subject) {
    subject.view = await lazy.WhimsyAIViewShare.measure(win);
    if (subject.kind == "selection") {
      const info = subject.context ? await lazy.WhimsyAIViewShare.selectionInfo(subject.context) : null;
      subject.editable = !!info?.editable;
      subject.sensitive = info?.sensitive ?? null;
      const lang = await this.languageOf(subject.text);
      const mine = Services.locale.appLocaleAsBCP47;
      subject.foreign = lang && base(lang) != base(mine) ? { from: lang, to: mine } : null;
    }
    return subject;
  },

  // A row as the bar shows it.
  aiRow(def, subject, view) {
    const cmd = def.command ? lazy.WhimsyAICommands.get(def.command) : null;
    if (def.command && (!cmd || cmd.hidden)) {
      return null;
    }
    const row = {
      id: def.id,
      icon: def.icon ?? cmd?.icon,
      label: cmd?.name || lazy.l10n.formatValueSync(def.l10nId, def.l10nArgs?.(subject, view)),
      run: def.run ?? ((win, s) => this.runText(win, s, cmd ?? { name: lazy.l10n.formatValueSync(def.l10nId), prompt: def.prompt, result: "copy" })),
    };
    if (def.translate && subject.foreign) {
      row.tag = lazy.l10n.formatValueSync("whimsy-cmdk-translate-pair", { from: shownLanguage(subject.foreign.from, subject.foreign.to), to: shownLanguage(subject.foreign.to, subject.foreign.from) });
    } else if (subject.editable && subject.kind == "selection") {
      row.tag = lazy.l10n.formatValueSync("whimsy-commands-result-replace");
    }
    const reason = def.unavailable?.(null, subject, view);
    if (reason) {
      row.unavailable = lazy.l10n.formatValueSync(reason);
    }
    return row;
  },

  verbRow(win, verb, subject, view) {
    const row = { id: verb.id, icon: verb.icon, label: WhimsyVerbs.labelFor(verb, subject, win), run: (w, s) => verb.run(w, s) };
    if (verb.tag) {
      row.tag = typeof verb.tag == "function" ? verb.tag(win, subject, view) : verb.tag;
    }
    if (verb.detail) {
      row.detail = lazy.l10n.formatValueSync(verb.detail);
    }
    const reason = verb.unavailable?.(win, subject, view);
    if (reason) {
      row.unavailable = typeof reason == "string" ? lazy.l10n.formatValueSync(reason) : reason.text;
    }
    return row;
  },

  // Your commands, tagged with their output; "Edit commands…" last.
  yours(win, subject) {
    const rows = [];
    for (const cmd of lazy.WhimsyAICommands.list().filter(c => !c.builtIn)) {
      rows.push({
        id: `cmd:${cmd.id}`,
        icon: cmd.icon,
        label: cmd.name,
        tag: lazy.l10n.formatValueSync(`whimsy-commands-result-${cmd.result}`),
        link: cmd.result == "link",
        run: (w, s) => (cmd.result == "link" ? lazy.WhimsyAICommands.run(w, cmd.id, s) : this.runText(w, s, cmd)),
      });
    }
    rows.push({
      id: "edit-commands",
      icon: `${ICONS}edit-theme.svg`,
      label: lazy.l10n.formatValueSync("whimsy-action-edit-commands"),
      tag: lazy.l10n.formatValueSync("whimsy-cmdk-tag-settings"),
      run: w => lazy.WhimsyAICommands.openSettings(w),
    });
    return rows;
  },

  /**
   * The groups ⌘K shows for a subject and the view (cmd dec-11), each
   * {kind, label, rows, all}: `rows` what shows before typing, `all`
   * what typing searches.
   */
  rank(win, subject, view = subject.view) {
    const groups = [];
    const registered = kind => WhimsyVerbs.registered.filter(v => v.group == kind && (!v.isAvailable || v.isAvailable(win, subject, view)));
    const make = (kind, label, rows, { top = Infinity } = {}) => {
      const all = rows.filter(Boolean);
      if (all.length) {
        groups.push({ kind, label, all, rows: all.filter(r => !r.unavailable).slice(0, top) });
      }
    };
    const verbs = WhimsyVerbs.verbsFor(win, subject).filter(v => !v.group && !String(v.id).startsWith("skill:"));
    const title = firstLine(subject.title ?? "", MAX_SNIPPET);
    if (subject.kind == "selection") {
      const kind = subject.editable ? "field" : "selection";
      let ai = AI_ROWS[kind].map(def => this.aiRow(def, subject, view));
      if (subject.foreign) {
        ai = [...ai.filter(r => r?.id == "ai:translate"), ...ai.filter(r => r?.id != "ai:translate")];
      }
      if (!subject.sensitive) {
        make(kind, { id: subject.editable ? "whimsy-cmdk-group-field" : "whimsy-cmdk-group-selection", args: { text: firstLine(subject.text, MAX_SNIPPET) } }, ai);
      }
      const today = verbs.filter(v => v.id != "translate" || subject.sensitive);
      make("verbs", { id: "whimsy-cmdk-group-verbs" }, today.map(v => this.verbRow(win, v, subject, view)));
      make("yours", { id: "whimsy-cmdk-group-yours" }, this.yours(win, subject));
      return groups;
    }
    const shares = view?.shares ?? {};
    const kinds = VIEW_KINDS.filter(k => (shares[k] ?? 0) >= MIN_SHARE || (k == "article" && !view))
      .sort((a, b) => Math.round((shares[b] ?? 0) * 50) - Math.round((shares[a] ?? 0) * 50) || VIEW_KINDS.indexOf(a) - VIEW_KINDS.indexOf(b));
    if (view?.product) {
      kinds.unshift("product");
    }
    for (const [i, kind] of kinds.entries()) {
      const rows = [...registered(kind).map(v => this.verbRow(win, v, subject, view)), ...AI_ROWS[kind].map(def => this.aiRow(def, subject, view))];
      if (kind == "image") {
        // media 3.5: Ask, the image's text, then Firefox's own rows.
        const at = row => (IMAGE_ORDER.includes(row?.id) ? IMAGE_ORDER.indexOf(row.id) : IMAGE_ORDER.length);
        rows.sort((a, b) => at(a) - at(b));
      }
      if (kind == "product") {
        // Compare and Watch price (the page's chips) lead.
        rows.sort((a, b) => (/compare|watch-price/.test(b.id) ? 1 : 0) - (/compare|watch-price/.test(a.id) ? 1 : 0));
      }
      make(kind, this.groupLabel(kind, i == 0, title, view), rows, { top: kind == "product" ? 4 : kind == "image" ? IMAGE_ORDER.length : TOP_ROWS });
    }
    if (!kinds.includes("article")) {
      // Not in view, but typing still finds the page's commands (greyed when they can't run).
      make("article", { id: "whimsy-cmdk-group-article" }, AI_ROWS.article.map(def => this.aiRow(def, subject, view)), { top: 0 });
    }
    const page = [...registered("page"), ...verbs].sort((a, b) => {
      const at = id => (PAGE_ORDER.includes(id) ? PAGE_ORDER.indexOf(id) : PAGE_ORDER.length);
      return at(a.id) - at(b.id);
    });
    make("page", kinds.length ? { id: "whimsy-cmdk-group-page" } : { id: "whimsy-verbs-row-page", args: { text: title } }, page.map(v => this.verbRow(win, v, subject, view)));
    make("yours", { id: "whimsy-cmdk-group-yours" }, this.yours(win, subject));
    return groups;
  },

  groupLabel(kind, first, title, view) {
    if (kind == "image") {
      const count = lazy.WhimsyAIViewShare.pickImages(view).length;
      return { id: "whimsy-cmdk-group-image", args: { count } };
    }
    return first ? { id: `whimsy-cmdk-group-${kind}-top`, args: { title } } : { id: `whimsy-cmdk-group-${kind}` };
  },

  /** Typing: every row, by match (word starts first), unavailable ones greyed. */
  filter(groups, query) {
    const seen = new Set();
    const rows = [];
    for (const group of groups) {
      for (const row of group.all) {
        if (seen.has(row.id)) {
          continue;
        }
        seen.add(row.id);
        const value = score(row.label, query);
        if (value > 0) {
          rows.push({ row, value, index: rows.length });
        }
      }
    }
    return rows.sort((a, b) => b.value - a.value || a.index - b.index).map(r => r.row);
  },

  // A text command: in a field it replaces the selection in place; on
  // read-only text it answers in the bar's card.
  async runText(win, subject, cmd) {
    const { WhimsyAICommands: commands } = lazy;
    const prompt = commands.promptFor(cmd, subject);
    if (subject.editable && (cmd.result == "replace" || cmd.builtIn)) {
      win.gURLBar.view.close();
      try {
        const { text } = cmd.id && commands.get(cmd.id) ? await commands.run(win, cmd.id, subject) : { text: "" };
        if (text && (await this.replace(subject, text))) {
          lazy.WhimsyUndo.showToast(win, "whimsy-cmdk-replaced-toast", { undo: () => this.undoReplace(subject) }, { name: cmd.name });
        }
      } catch (e) {
        console.error("Whimsy: ⌘K command", e);
        win.gZenUIManager?.showToast?.("whimsy-cmdk-failed-toast", { l10nArgs: { name: cmd.name } });
      }
      return;
    }
    const question = subject.kind == "selection" ? `${cmd.name}: “${firstLine(subject.text, MAX_SNIPPET)}”` : cmd.name;
    win.setTimeout(() => lazy.WhimsyCommandBarAI.ask(win, question, { prompt, provider: cmd.model && cmd.model != "auto" ? cmd.model : null }), 0);
  },

  async replace(subject, text) {
    try {
      return !!(await subject.context?.currentWindowGlobal?.getActor("WhimsyAIViewShare").sendQuery("Whimsy:ReplaceSelection", { text }));
    } catch (e) {
      console.error("Whimsy: replace in place", e);
      return false;
    }
  },

  async undoReplace(subject) {
    try {
      await subject.context?.currentWindowGlobal?.getActor("WhimsyAIViewShare").sendQuery("Whimsy:UndoReplace");
    } catch (e) {
      console.error("Whimsy: undo replace", e);
    }
  },
};

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

  // W23 page-act: {id, rows(win, text) -> row[]}, asked as ⌘K is typed in.
  typedRows: new Map(),
  registerTypedRow(provider) {
    this.typedRows.set(provider.id, provider);
  },

  typedRowsFor(win, text) {
    if (!text || !win) {
      return [];
    }
    const out = [];
    for (const provider of this.typedRows.values()) {
      try {
        out.push(...(provider.rows(win, text) ?? []));
      } catch (e) {
        console.error(`Whimsy: typed row ${provider.id}`, e);
      }
    }
    return out;
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
    // From a private tab, the result opens private too.
    lazy.WhimsyPrivate.openTabFor(win, url);
  },
  openExternal(spec) {
    Cc["@mozilla.org/uriloader/external-protocol-service;1"]
      .getService(Ci.nsIExternalProtocolService)
      .loadURI(Services.io.newURI(spec), Services.scriptSecurityManager.getSystemPrincipal());
  },
  copy(text, win = null) {
    lazy.WhimsyCopy.copyText(text, !!win && lazy.WhimsyCopy.browserIsPrivate(win));
  },
  launchFile(path) {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    file.launch();
  },
  // wave7/native1: macOS Calendar's EventKit component (calendar/), or
  // null where it isn't built. Tests replace this with a mock.
  calendarService() {
    try {
      return Cc["@whimsy/calendar;1"]?.getService(Ci.nsIWhimsyCalendar) ?? null;
    } catch (e) {
      return null;
    }
  },

  /**
   * Adds the event to macOS Calendar. Resolves true once it's saved; false
   * when the person said no (now or before), there's no calendar component,
   * or saving failed, so the caller falls back to an .ics file.
   *
   * @param {{start: Date, end: Date, allDay: boolean, title: string, description?: string, url?: string}} event
   */
  async addToSystemCalendar(event) {
    const service = this.calendarService();
    if (!service) {
      return false;
    }
    const call = (method, ...args) =>
      new Promise(resolve => service[method](...args, (ok, result) => resolve({ ok, result })));
    try {
      let status = service.authorizationStatus;
      if (status == "notDetermined") {
        // The person picked "Add to Calendar": this is when to ask.
        const answer = await call("requestWriteAccess");
        if (!answer.ok) {
          return false;
        }
        status = answer.result;
      }
      if (status != "fullAccess" && status != "writeOnly") {
        return false;
      }
      const saved = await call(
        "addEvent",
        JSON.stringify({
          title: event.title || "",
          start: event.start.getTime(),
          end: event.end.getTime(),
          allDay: !!event.allDay,
          notes: event.description || "",
          url: /^https?:/.test(event.url ?? "") ? event.url : "",
        })
      );
      if (!saved.ok) {
        console.warn("Whimsy: Add to Calendar fell back to a file:", saved.result);
      }
      return saved.ok;
    } catch (e) {
      console.error("Whimsy: Add to Calendar", e);
      return false;
    }
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
          context,
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
   * Firefox's Cmd+K, the web search. With AI on in a normal tab, the
   * context-aware menu (WhimsyContextCommands), selection or not.
   */
  async openFromKey(win, { textOnly = false } = {}) {
    const subject = this.enabled ? await this.subjectFor(win) : null;
    const aware = !!subject && contextOn(win);
    if (subject?.kind != "selection" && !aware) {
      this.search(win);
      return null;
    }
    if (aware) {
      await WhimsyContextCommands.prepare(win, subject);
      subject.groups = WhimsyContextCommands.rank(win, subject);
      if (textOnly) {
        // Right-click's More Commands…: the selection's text commands only.
        subject.groups = subject.groups.filter(g => g.kind != "verbs").map(g => (g.kind == "yours" ? { ...g, rows: g.rows.filter(r => !r.link), all: g.all.filter(r => !r.link) } : g));
      }
    }
    await this.start(win, subject);
    if (aware) {
      lazy.WhimsyCommandBarAI.askHintWhenDrawn(win, "context-commands");
    }
    return subject;
  },

  /** The ⌘K groups for a subject and the view's share (cmd dec-11). */
  rank(subject, viewShare, win = lazy.BrowserWindowTracker.getTopWindow()) {
    return WhimsyContextCommands.rank(win, subject, viewShare);
  },

  /**
   * ⌘K in a mode of its own (page 6.2, "Change this page"): `rows` before
   * typing under `label`, `typed(text)` the one row typing makes, and
   * `placeholder` the field's words.
   */
  async openMode(win, { mode, label, rows, typed, placeholder, title = "", value = "" }) {
    const subject = { kind: "page", title, mode, groups: [{ kind: mode, label, rows, all: rows }], modeTyped: typed };
    await this.start(win, subject);
    if (placeholder) {
      win.document.l10n.setAttributes(win.gURLBar.inputField, placeholder);
    }
    if (value) {
      win.gURLBar.inputField.setUserInput(value);
    }
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
        await lazy.SearchService.init();
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
    // With an event, so the urlbar starts an engagement session: without
    // one, picking a verb is never reported to the provider (onEngagement).
    urlbar.startQuery({ allowAutofill: false, event: new win.Event("command") });
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
    subject ??= await this.subjectFor(win);
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
    win.windowUtils.loadSheetUsingURIString("chrome://browser/content/whimsy/whimsy-cmdk.css", win.windowUtils.AUTHOR_SHEET);
    lazy.WhimsyAIHints.register({
      id: "context-commands",
      isVisible: w => !!this.sessions.get(w)?.groups && !!w.gURLBar?.view.isOpen,
    });
    const shortcuts = lazy.WhimsyShortcuts;
    // The command bar's "Actions for Selection" (selection or page verbs)
    // is a registered command; Cmd+K is its own command (verbs only for a
    // selection, else Firefox's web search), bound below.
    lazy.WhimsyCommands.register(win, {
      id: COMMAND_ID,
      l10nId: "whimsy-action-selection-verbs",
      run: w => this.open(w).catch(console.error),
      icon: `${ICONS}bolt.svg`,
      isAvailable: w => this.enabled && isWebPage(w),
    });
    shortcuts.addCommand(win, { id: KEY_COMMAND_ID, run: w => this.openFromKey(w).catch(console.error) });
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
    this.initHoldToSpeak(win);
    this.initCommands(win);
    this.initContextMenu(win);
  },

  // W23 voice-image (fu-media dec-15): ⌘K opens on key down as before; with
  // both keys still down after 300ms the open menu listens (WhimsyDictation),
  // and letting go of either key stops, leaving the top match selected. Key
  // repeat never reopens the menu.
  //
  // W25: macOS sends no keyup for a key let go while ⌘ is down, so K's keyup
  // can't be trusted. K counts as down only while its auto-repeat keeps
  // arriving: listening starts on a repeat once 300ms have passed, and ends
  // on K's keyup, ⌘'s keyup, any other key, blur, or when the repeats stop.
  initHoldToSpeak(win) {
    const accel = event => (Services.appinfo.OS == "Darwin" ? event.metaKey : event.ctrlKey);
    let held = false;
    let timer = 0;
    let downAt = 0;
    let lastSeen = 0;
    let interval = 0;
    const now = () => win.performance.now();
    const release = () => {
      if (timer) {
        win.clearTimeout(timer);
        timer = 0;
      }
      if (held) {
        held = false;
        win.gURLBar?.removeAttribute("whimsy-holding-k");
        if (lazy.WhimsyDictation.active?.trigger == "cmdk") {
          lazy.WhimsyDictation.stop();
        }
      }
    };
    // How long K may go without a repeat before it must have been let go:
    // the system's initial repeat delay first, then a few repeat intervals.
    const gap = () => (!interval ? REPEAT_FIRST_MS : interval < 0 ? REPEAT_NEXT_MS : Math.max(REPEAT_MIN_MS, interval * 3));
    const listen = () => {
      if (!held || lazy.WhimsyDictation.active?.trigger == "cmdk" || !interval) {
        return;
      }
      if (now() - downAt >= HOLD_TO_SPEAK_MS && (win.gURLBar?.view.isOpen || win.gURLBar?.focused)) {
        lazy.WhimsyDictation.startFromCmdK(win);
      }
    };
    const tick = () => {
      timer = 0;
      if (!held) {
        return;
      }
      if (now() - lastSeen > gap()) {
        release();
        return;
      }
      listen();
      timer = win.setTimeout(tick, TICK_MS);
    };
    win.addEventListener(
      "keydown",
      event => {
        if (event.code == "KeyK" && accel(event) && !event.altKey && !event.shiftKey) {
          // Web content's copy of a key event arrives late; it is no
          // evidence that K is still down.
          if (event.isReplyEventFromRemoteContent) {
            if (event.repeat || held) {
              event.preventDefault();
              event.stopImmediatePropagation();
            }
            return;
          }
          if (event.repeat || held) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (held && event.repeat) {
              const t = now();
              // -1: one repeat seen, its interval not yet known.
              interval = interval ? t - lastSeen : -1;
              lastSeen = t;
              listen();
            }
            return;
          }
          held = true;
          downAt = lastSeen = now();
          interval = 0;
          win.gURLBar?.setAttribute("whimsy-holding-k", "");
          // Row numbers stay hidden while K is held.
          lazy.WhimsyCommandBarAI.stopNumbers?.(win);
          timer = win.setTimeout(tick, TICK_MS);
        } else if (held && event.key != "Meta" && event.key != "Control" && !event.isReplyEventFromRemoteContent) {
          release();
        }
      },
      true
    );
    win.addEventListener(
      "keyup",
      event => {
        if (held && (event.code == "KeyK" || event.key == "Meta" || event.key == "Control" || !accel(event))) {
          release();
        }
      },
      true
    );
    win.addEventListener("blur", release);
  },

  initCommands(win) {
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyVerbMap",
      // The command bar already offers it as a verb (WhimsyVerbsProvider);
      // registered for its assignable shortcut only.
      commandBar: false,
      l10nId: "whimsy-verb-map",
      run: w => this.runVerb(w, "map"),
      icon: `${ICONS}geo.svg`,
      isAvailable: w => this.enabled && isWebPage(w),
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyVerbEmail",
      commandBar: false,
      l10nId: "whimsy-verb-email",
      run: w => this.runVerb(w, "email"),
      icon: `${ICONS}mail.svg`,
      isAvailable: w => this.enabled && isWebPage(w),
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyVerbNote",
      commandBar: false,
      l10nId: "whimsy-verb-note",
      run: w => this.runVerb(w, "note"),
      icon: `${ICONS}reader-mode.svg`,
      isAvailable: w => this.enabled && Services.prefs.getBoolPref(NOTES_PREF, true) && isWebPage(w),
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyVerbCalendar",
      commandBar: false,
      l10nId: "whimsy-verb-calendar",
      run: w => this.runVerb(w, "calendar"),
      icon: `${ICONS}history.svg`,
      isAvailable: w => this.enabled && isWebPage(w),
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyVerbLinearNew",
      commandBar: false,
      l10nId: "whimsy-verb-linear-new",
      run: w => this.runVerb(w, "linear-new"),
      icon: `${ICONS}plus.svg`,
      isAvailable: w => this.enabled && this.linearConfigured() && isWebPage(w),
    });
    lazy.WhimsyCommands.register(win, {
      id: "cmd_whimsyVerbLinearSearch",
      commandBar: false,
      l10nId: "whimsy-verb-linear-search",
      run: w => this.runVerb(w, "linear-search"),
      icon: `${ICONS}search-page.svg`,
      isAvailable: w => this.enabled && this.linearConfigured() && isWebPage(w),
    });
  },

  initContextMenu(win) {
    const menu = win.document.getElementById("contentAreaContextMenu");
    if (!menu) {
      return;
    }
    menu.addEventListener("popupshowing", event => {
      if (event.target == menu) {
        this.updateContextMenu(win);
      }
    });
  },

  // W10-20: the name of the app a mailto: link opens (Mail, unless another
  // app or a web mail site is the default), for "Email with Mail".
  mailAppName() {
    try {
      const info = Cc["@mozilla.org/uriloader/external-protocol-service;1"]
        .getService(Ci.nsIExternalProtocolService)
        .getProtocolHandlerInfo("mailto");
      const chosen =
        info.preferredAction == Ci.nsIHandlerInfo.useHelperApp ? info.preferredApplicationHandler?.name : "";
      return chosen || info.defaultDescription || "Mail";
    } catch (e) {
      return "Mail";
    }
  },

  // W10-20: the selection menu's actions. Add to Note stays a row of its
  // own; the actions that hand the text to another app sit in one Quick
  // Actions ▸ submenu, each naming its app. With only one available it
  // shows as that row, never a one-row submenu; with none the submenu
  // hides. WhimsyMenuPrefs puts the rows in the menu's order.
  updateContextMenu(win) {
    const { document } = win;
    const context = win.gContextMenu;
    const isSelection = this.enabled && !!context?.isContentSelected && !context.onTextInput && !context.onEditable;
    const selectedText = (context?.selectionInfo?.fullText || context?.selectedText || "").trim();
    const has = selectedText.length > 0;
    const prefs = lazy.WhimsyMenuPrefs;
    const off = id => prefs.enabled && prefs.isHidden("selection", id);
    const linear = has && this.linearConfigured();
    const mailArgs = { app: this.mailAppName() };

    const anchor = document.getElementById("context-whimsy-copy-markdown") || document.getElementById("context-copy");
    // Add to Note, after Copy as Markdown.
    let note = document.getElementById("context-whimsy-verb-note");
    if (!note) {
      note = this._menuRow(win, "context-whimsy-verb-note", "whimsy-context-verb-note", "note");
    }
    note.hidden = !isSelection || !has || !Services.prefs.getBoolPref(NOTES_PREF, true) || isPrivate(win);
    if (anchor && anchor.nextElementSibling != note) {
      anchor.after(note);
    }

    const { menu, popup, solo, divider } = this._quickActionsMenu(win);
    if (note.nextElementSibling != menu) {
      note.after(menu);
    }
    if (menu.nextElementSibling != solo) {
      menu.after(solo);
    }
    const actions = [
      { verb: "calendar", domId: "context-whimsy-verb-calendar", l10nId: "whimsy-context-verb-calendar", available: has && !!parseEvent(selectedText) && !isPrivate(win) },
      { verb: "map", domId: "context-whimsy-verb-map", l10nId: "whimsy-context-verb-map", available: has && selectedText.length <= 200 },
      { verb: "email", domId: "context-whimsy-verb-email", l10nId: "whimsy-context-verb-email", args: mailArgs, available: has },
      { verb: "linear-new", domId: "context-whimsy-verb-linear-new", l10nId: "whimsy-context-verb-linear-new", available: linear, after: divider },
      { verb: "linear-search", domId: "context-whimsy-verb-linear-search", l10nId: "whimsy-context-verb-linear-search", available: linear, after: divider },
    ];
    const shown = [];
    for (const action of actions) {
      let row = document.getElementById(action.domId);
      if (!row) {
        row = this._menuRow(win, action.domId, action.l10nId, action.verb);
      }
      if (action.args) {
        document.l10n.setAttributes(row, action.l10nId, action.args);
      }
      const before = action.after ? null : divider;
      if (row.parentNode != popup) {
        popup.insertBefore(row, before);
      }
      row.hidden = !isSelection || !action.available || off(action.verb);
      if (!row.hidden) {
        shown.push(action);
      }
    }
    // The divider only between the system apps and Linear.
    divider.hidden = !(shown.some(a => !a.after) && shown.some(a => a.after));
    menu.hidden = shown.length < 2;
    solo.hidden = shown.length != 1;
    if (shown.length == 1) {
      const [only] = shown;
      document.l10n.setAttributes(solo, only.l10nId, only.args);
      solo.dataset.verb = only.verb;
    }
  },

  _menuRow(win, id, l10nId, verb) {
    const row = win.document.createXULElement("menuitem");
    row.id = id;
    row.setAttribute("data-l10n-id", l10nId);
    row.addEventListener("command", () => {
      this.runVerb(win, verb).catch(console.error);
    });
    return row;
  },

  _quickActionsMenu(win) {
    const { document } = win;
    let menu = document.getElementById("context-whimsy-quick-actions");
    if (!menu) {
      menu = document.createXULElement("menu");
      menu.id = "context-whimsy-quick-actions";
      document.l10n.setAttributes(menu, "whimsy-context-quick-actions");
      const popup = document.createXULElement("menupopup");
      popup.id = "context-whimsy-quick-actions-popup";
      const divider = document.createXULElement("menuseparator");
      divider.id = "context-whimsy-quick-actions-divider";
      popup.append(divider);
      menu.append(popup);
    }
    let solo = document.getElementById("context-whimsy-quick-action-solo");
    if (!solo) {
      solo = document.createXULElement("menuitem");
      solo.id = "context-whimsy-quick-action-solo";
      solo.hidden = true;
      solo.addEventListener("command", () => {
        if (solo.dataset.verb) {
          this.runVerb(win, solo.dataset.verb).catch(console.error);
        }
      });
    }
    return {
      menu,
      popup: menu.menupopup ?? menu.querySelector("menupopup"),
      solo,
      divider: document.getElementById("context-whimsy-quick-actions-divider") ?? menu.querySelector("menuseparator"),
    };
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
    if (subject.groups) {
      this.#contextRows(subject, query, addCallback);
      return;
    }
    const snippet = subject.kind == "selection" ? firstLine(subject.text, MAX_SNIPPET) : subject.title;
    const rows = WhimsyVerbs.verbsFor(win, subject)
      .map((verb, index) => ({ verb, index, label: WhimsyVerbs.labelFor(verb, subject, win) }))
      // Match the verb's name, not the selected text quoted in its label
      // ("Search Google for “…”").
      .map(row => ({ ...row, score: score(snippet ? row.label.replace(snippet, "") : row.label, query) }))
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

  #result(subject, row, rowLabel, heuristic = false, extra = {}) {
    return new lazy.UrlbarResult({
      type: UrlbarShared.RESULT_TYPE.DYNAMIC,
      source: UrlbarShared.RESULT_SOURCE.ZEN_ACTIONS,
      heuristic,
      rowLabel,
      payload: {
        dynamicType: row.unavailable ? OFF_TYPE : DYNAMIC_TYPE,
        zenAction: true,
        whimsyVerb: row.id,
        subjectId: subject.id,
        title: row.label,
        icon: row.icon ?? "",
        tag: row.tag ?? "",
        detail: row.unavailable ?? row.detail ?? "",
        ...extra,
      },
    });
  }

  // ⌘K's groups in their frozen order; typing flattens them (cmd-3.9),
  // and with nothing to pick, Ask about what's on screen, then search.
  #contextRows(subject, query, addCallback) {
    if (subject.modeTyped && query.trim()) {
      // A mode (openMode): typing makes its one row, nothing else.
      const row = subject.modeTyped(query.trim());
      subject.typed = new Map([[row.id, row]]);
      addCallback(this, this.#result(subject, row, subject.groups[0].label, true));
      return;
    }
    if (!query.trim()) {
      let first = true;
      for (const group of subject.groups) {
        for (const row of group.rows) {
          addCallback(this, this.#result(subject, row, group.label, first));
          first = false;
        }
      }
      return;
    }
    // W23 page-act: rows built from the typed words ("Change this page:
    // …", "Close 3 YouTube tabs") lead.
    const typed = WhimsyVerbs.typedRowsFor(lazy.BrowserWindowTracker.getTopWindow(), query.trim());
    subject.typed = new Map(typed.map(row => [row.id, row]));
    let first = true;
    for (const row of typed) {
      addCallback(this, this.#result(subject, row, { id: "whimsy-cmdk-group-commands" }, first));
      first = false;
    }
    const rows = WhimsyContextCommands.filter(subject.groups, query);
    for (const row of rows) {
      addCallback(this, this.#result(subject, row, { id: "whimsy-cmdk-group-commands" }, first && !row.unavailable));
      first &&= !!row.unavailable;
    }
    if (!first && !typed.length) {
      return;
    }
    const text = query.trim();
    const search = { id: "web-search", icon: `${ICONS}search-glass.svg`, label: text, tag: lazy.l10n.formatValueSync("whimsy-cmdk-search-with", { engine: subject.engineName || defaultEngineName(lazy.BrowserWindowTracker.getTopWindow()) }) };
    if (!rows.length) {
      const scope = subject.groups[0]?.kind == "video" ? "video" : "page";
      const ask = { id: "ask", icon: SPARKLE, label: text, tag: lazy.l10n.formatValueSync(scope == "video" ? "whimsy-cmdbar-ask-video" : "whimsy-cmdk-ask-page") };
      addCallback(this, this.#result(subject, ask, { id: "whimsy-cmdk-no-match" }, first, { query: text, scope }));
      addCallback(this, this.#result(subject, search, { id: "whimsy-cmdk-no-match" }, false, { query: text }));
      return;
    }
    addCallback(this, this.#result(subject, search, { id: "whimsy-cmdk-group-search" }, false, { query: text }));
  }

  getViewTemplate(result) {
    const off = result.payload.dynamicType == OFF_TYPE;
    return {
      attributes: off ? { "aria-disabled": "true" } : { selectable: true },
      children: [
        { name: "icon", tag: "img", classList: ["urlbarView-favicon"] },
        { name: "title", tag: "span", classList: ["urlbarView-title"] },
        { name: "detail", tag: "span", classList: ["whimsy-cmdk-detail"] },
        { name: "tag", tag: "span", classList: ["whimsy-cmdk-tag"] },
      ],
    };
  }

  getViewUpdate(result) {
    const { icon, title, tag, detail } = result.payload;
    return {
      icon: { attributes: { src: icon || null, hidden: !icon || null } },
      title: { textContent: title },
      detail: { textContent: detail ?? "", attributes: { hidden: !detail || null } },
      tag: { textContent: tag ?? "", attributes: { hidden: !tag || null } },
    };
  }

  #runContext(win, subject, payload) {
    const { whimsyVerb: id, query, scope } = payload;
    const row = subject.groups.flatMap(g => g.all).find(r => r.id == id) ?? subject.typed?.get(id);
    if ((!row && id != "ask" && id != "web-search") || row?.unavailable) {
      return;
    }
    WhimsyVerbs.sessions.delete(win);
    win.gURLBar.searchMode = null;
    lazy.WhimsyAIHints.used("context-commands");
    if (id == "ask") {
      win.setTimeout(() => lazy.WhimsyCommandBarAI.ask(win, query, { scope }), 0);
      return;
    }
    win.gBrowser.selectedBrowser.focus();
    const run = id == "web-search" ? () => BUILT_IN[0].run(win, { ...subject, text: query }) : () => row.run(win, subject);
    Promise.resolve()
      .then(run)
      .catch(e => console.error(`Whimsy: ⌘K ${id}`, e));
  }

  onEngagement(_context, _controller, details) {
    const { whimsyVerb, subjectId } = details.result?.payload ?? {};
    const subject = WhimsyVerbs.subjects.get(subjectId);
    const win = details.element?.documentGlobal ?? lazy.BrowserWindowTracker.getTopWindow();
    if (!subject || !win || !WhimsyVerbs.enabled) {
      return;
    }
    if (subject.groups) {
      this.#runContext(win, subject, details.result.payload);
      return;
    }
    WhimsyVerbs.sessions.delete(win);
    win.gURLBar.searchMode = null;
    win.gBrowser.selectedBrowser.focus();
    WhimsyVerbs.runVerb(win, whimsyVerb, subject);
  }
}

// ⌘K on an image: Firefox's Copy Image and Save Image As… (media 3.5), with
// AI on or off. They act on the image ⌘K picked (the one under the pointer,
// or the biggest in view).
function pickedImage(view) {
  const src = lazy.WhimsyAIViewShare.pickImages(view)[0]?.src ?? "";
  return /^(?:https?|data|blob):/i.test(src) ? src : "";
}

WhimsyVerbs.registerVerb({
  id: "image:copy",
  group: "image",
  l10nId: "whimsy-cmdk-copy-image",
  icon: `${ICONS}edit-copy.svg`,
  isAvailable: (win, subject, view) => lazy.WhimsyAIViewShare.pickImages(view).length == 1 && !!pickedImage(view),
  run: async (win, subject) => {
    win.gURLBar.view.close();
    const src = pickedImage(subject?.view);
    try {
      const response = await win.fetch(src, { credentials: "omit" });
      lazy.BrowserUtils.copyImageToClipboard(await response.arrayBuffer());
      win.gZenUIManager?.toasts?.open("whimsy-cmdk-copied-image", { key: "whimsy-cmdk-copied-image", icon: "chrome://browser/skin/zen-icons/check.svg" });
    } catch (e) {
      console.error("Whimsy: copy image", e);
    }
  },
});

WhimsyVerbs.registerVerb({
  id: "image:save",
  group: "image",
  l10nId: "whimsy-cmdk-save-image",
  icon: `${ICONS}downloads.svg`,
  isAvailable: (win, subject, view) => lazy.WhimsyAIViewShare.pickImages(view).length == 1 && !!pickedImage(view),
  run: (win, subject) => {
    win.gURLBar.view.close();
    const src = pickedImage(subject?.view);
    const browser = win.gBrowser.selectedBrowser;
    const principal = browser.contentPrincipal;
    win.urlSecurityCheck(src, principal);
    win.internalSave(src, null, null, null, null, null, false, "SaveImageTitle", null, null, browser.cookieJarSettings ?? null, null, false, null,
      lazy.PrivateBrowsingUtils.isBrowserPrivate(browser), principal);
  },
});
