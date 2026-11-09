/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23 routines-ui: the routine form. It reads as a sentence: When
// [trigger][detail] do this (text) show it in [menu] using [provider]. The
// Library opens it in place ("library" layout, Routing's chips and pickers);
// chat's "make a routine" opens it in a sheet ("sheet" layout, tokens), with
// the fields chat filled outlined until they're touched. Nothing is saved
// until the person presses Turn on (new) or Save (edit). Plain DOM, so both
// a window module and a system module can build it.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyAIProviders: "resource:///modules/whimsy/WhimsyAIProviders.sys.mjs",
  WhimsyAIRouter: "resource:///modules/whimsy/WhimsyAIRouter.sys.mjs",
  WhimsyAIContext: "resource:///modules/whimsy/WhimsyAIContext.sys.mjs",
  WhimsyAIReader: "resource:///modules/whimsy/WhimsyAIReader.sys.mjs",
  WhimsyConnectors: "resource:///modules/whimsy/WhimsyConnectors.sys.mjs",
  INTERVALS: "resource:///modules/whimsy/WhimsyPageWatch.sys.mjs",
  MAX_WATCHES: "resource:///modules/whimsy/WhimsyPageWatch.sys.mjs",
  WhimsyRoutines: "resource:///modules/whimsy/WhimsyRoutines.sys.mjs",
  WhimsySurface: "resource:///modules/whimsy/WhimsySurface.sys.mjs",
});

const HTML_NS = "http://www.w3.org/1999/xhtml";
const ZEN = "chrome://browser/skin/zen-icons/";
const OWN = "chrome://browser/content/whimsy/icons/";

export const TRIGGERS = [
  { kind: "schedule", icon: `${OWN}clock.svg` },
  { kind: "page", icon: `${ZEN}page-portrait.svg` },
  { kind: "return", icon: `${OWN}uturn-backward.svg` },
  { kind: "meeting", icon: `${ZEN}selectable/people.svg` },
  { kind: "email", icon: `${ZEN}selectable/mail.svg` },
  { kind: "open-site", icon: `${ZEN}selectable/globe.svg` },
  { kind: "download", icon: `${ZEN}downloads.svg` },
];

const DEFAULTS = {
  schedule: { days: [1, 2, 3, 4, 5], hour: 8, minute: 0 },
  page: { interval: 60 },
  return: { awayMinutes: 120 },
  meeting: { leadMinutes: 10 },
  email: { match: "anyone" },
  "open-site": { host: "" },
  download: { match: "any" },
};

const DAY_SETS = {
  daily: [0, 1, 2, 3, 4, 5, 6],
  weekdays: [1, 2, 3, 4, 5],
  weekends: [0, 6],
};

// What a routine reads through, by trigger or built-in: the first group
// with nothing connected is offered inline.
const NEEDS = {
  mail: { ids: ["google", "microsoft"], buttons: [["google", "gmail", "gmail"], ["microsoft", "outlook", "outlook"]] },
  calendar: {
    ids: ["google", "microsoft", "apple-calendar"],
    buttons: [["google", "google-calendar", "google-calendar"], ["microsoft", "outlook", "outlook"], ["apple-calendar", "apple-calendar", "apple"]],
  },
  issues: { ids: ["linear", "jira"], buttons: [["linear", "linear", "linear"], ["jira", "jira", "jira"]] },
  drive: { ids: ["google"], buttons: [["google", "drive", "google-drive"]] },
};
const BUILT_IN_NEEDS = {
  "daily-brief": ["mail", "calendar"],
  "weekly-recap": ["calendar"],
  "meeting-prep": ["calendar"],
  "catch-up": ["mail"],
  "doc-changes": ["drive"],
  standup: ["issues"],
  "meeting-follow-up": ["calendar"],
};

export function needsOf(draft) {
  const kind = draft.trigger?.kind;
  const groups = [...(BUILT_IN_NEEDS[draft.builtIn] ?? [])];
  if (kind == "email" && !groups.includes("mail")) {
    groups.unshift("mail");
  }
  if (kind == "meeting" && !groups.includes("calendar")) {
    groups.unshift("calendar");
  }
  return groups;
}

function el(doc, tag, cls, l10nId, l10nArgs) {
  const node = doc.createElementNS(HTML_NS, tag);
  if (cls) {
    node.className = cls;
  }
  if (l10nId) {
    doc.l10n.setAttributes(node, l10nId, l10nArgs);
  }
  return node;
}

function img(doc, src, cls = "") {
  const node = el(doc, "img", cls);
  node.src = src;
  node.alt = "";
  return node;
}

function timeText(hour, minute) {
  const d = new Date(2026, 0, 5, hour, minute);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function daysKey(trigger) {
  if (trigger.every == "hour") {
    return "hourly";
  }
  const days = [...(trigger.days ?? [])].sort().join(",");
  for (const [key, set] of Object.entries(DAY_SETS)) {
    if (set.join(",") == days) {
      return key;
    }
  }
  return `d${trigger.days?.[0] ?? 1}`;
}

/** The tabs a page trigger can watch: readable, never private. */
function watchableTabs(win) {
  return win.gBrowser.tabs.filter(
    tab => !lazy.WhimsyAIContext.isPrivate(tab) && lazy.WhimsyAIReader.isReadableUrl(tab.linkedBrowser?.currentURI?.spec)
  );
}

function connectedIds(list) {
  return new Set(list.filter(c => c.connected && !["expired", "denied", "unavailable"].includes(c.status)).map(c => c.id));
}

/**
 * Builds the form.
 *
 * @param {Window} win
 * @param {object} o
 * @param {object} o.draft - {id?, kind?, builtIn?, title?, trigger, prompt, showIn, using}
 * @param {"library"|"sheet"} [o.layout]
 * @param {boolean} [o.outlined] - the fields chat filled stay outlined until touched
 * @param {Function} [o.onDone] - (saved) after Turn on or Save
 * @param {Function} [o.onCancel]
 * @param {Function} [o.onResize] - the form's height may have changed
 * @returns {{root: Element, buttons: Element, focusFirst: Function, draft: object}}
 */
export function buildRoutineForm(win, o) {
  const doc = win.document;
  const layout = o.layout ?? "library";
  const editing = !!o.draft.id;
  const draft = {
    showIn: "bar",
    using: "auto",
    prompt: "",
    ...o.draft,
    trigger: { ...DEFAULTS[o.draft.trigger?.kind ?? "schedule"], ...(o.draft.trigger ?? { kind: "schedule" }) },
  };
  if (draft.trigger.kind == "page" && !draft.trigger.url) {
    const tab = watchableTabs(win).find(t => t == win.gBrowser.selectedTab) ?? watchableTabs(win)[0];
    if (tab) {
      draft.trigger.url = tab.linkedBrowser.currentURI.spec;
      draft.title ??= tab.label;
      draft.trigger.userContextId = tab.getAttribute("usercontextid") | 0;
    }
  }
  let connected = new Set();
  let connecting = null;
  let busy = false;
  const state = { draft };

  const root = el(doc, "div", `whimsy-routine-form is-${layout}`);
  root.setAttribute("role", "group");
  root.setAttribute("data-layout", layout);
  const changed = () => {
    sync();
    o.onResize?.();
  };
  const touched = node => {
    if (node?.classList.contains("is-filled")) {
      node.classList.remove("is-filled");
      node.classList.add("was-filled");
    }
  };
  const filled = node => {
    if (o.outlined) {
      node.classList.add("is-filled");
    }
    return node;
  };

  // ---- When ----
  const whenGroup = el(doc, "div", "whimsy-routine-form-group whimsy-routine-form-when");
  const whenLabel = el(doc, layout == "sheet" ? "span" : "h3", layout == "sheet" ? "whimsy-routine-form-kw" : "", layout == "sheet" ? "whimsy-routine-form-kw-when" : "whimsy-routine-form-when");
  whenGroup.append(whenLabel);
  let kindControl;
  if (layout == "sheet") {
    const dd = lazy.WhimsySurface.dropdown(doc, {
      id: `${o.idPrefix ?? "whimsy-routine-form"}-trigger`,
      options: TRIGGERS.map(t => ({ value: t.kind, l10nId: `whimsy-routine-form-trigger-${t.kind}` })),
      value: draft.trigger.kind,
      width: 220,
      onPick: kind => {
        touched(dd.button);
        setKind(kind);
      },
    });
    dd.button.classList.add("whimsy-routine-token", "is-trigger");
    dd.button.dataset.field = "trigger";
    kindControl = filled(dd.button);
  } else {
    kindControl = el(doc, "div", "whimsy-routine-form-chips");
    kindControl.setAttribute("role", "radiogroup");
    for (const t of TRIGGERS) {
      const chip = el(doc, "button", "zen-library-filter-chip whimsy-routine-chip");
      chip.type = "button";
      chip.dataset.kind = t.kind;
      chip.setAttribute("role", "radio");
      chip.append(img(doc, t.icon), el(doc, "span", "", `whimsy-routine-form-trigger-${t.kind}`));
      chip.addEventListener("click", () => {
        touched(kindControl);
        setKind(t.kind);
      });
      kindControl.append(chip);
    }
    kindControl.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      const chips = [...kindControl.children];
      const i = chips.findIndex(c => c.hasAttribute("active"));
      const step = event.key == "ArrowLeft" || event.key == "ArrowUp" ? -1 : 1;
      const next = chips[(i + step + chips.length) % chips.length];
      setKind(next.dataset.kind);
      next.focus();
    });
    filled(kindControl);
  }
  const detail = el(doc, "div", "whimsy-routine-form-detail");
  if (layout == "sheet") {
    whenGroup.append(kindControl, detail);
  } else {
    whenGroup.append(kindControl, detail);
  }

  // ---- Connect row ----
  const connect = el(doc, "div", "whimsy-routine-form-connect");
  connect.hidden = true;

  // ---- Do this ----
  const doGroup = el(doc, "div", "whimsy-routine-form-group whimsy-routine-form-do");
  doGroup.append(el(doc, layout == "sheet" ? "span" : "h3", layout == "sheet" ? "whimsy-routine-form-kw" : "", layout == "sheet" ? "whimsy-routine-form-kw-do" : "whimsy-routine-form-do"));
  const prompt = el(doc, "textarea", "whimsy-routine-form-prompt", "whimsy-routine-form-prompt");
  prompt.rows = 3;
  prompt.value = draft.prompt ?? "";
  prompt.setAttribute("aria-label", "");
  doc.l10n.formatValue("whimsy-routine-form-do").then(label => prompt.setAttribute("aria-label", label), () => {});
  filled(prompt);
  prompt.addEventListener("input", () => {
    touched(prompt);
    draft.prompt = prompt.value;
    changed();
  });
  const ideas = el(doc, "div", "whimsy-routine-form-ideas");
  for (const n of [1, 2, 3]) {
    const idea = el(doc, "button", "whimsy-routine-idea", `whimsy-routine-form-idea-${n}`);
    idea.type = "button";
    idea.addEventListener("click", async () => {
      prompt.value = await doc.l10n.formatValue(`whimsy-routine-form-idea-${n}`);
      draft.prompt = prompt.value;
      changed();
      prompt.focus();
    });
    ideas.append(idea);
  }
  doGroup.append(prompt, ideas);

  // ---- Show it in, Using ----
  const pair = el(doc, "div", "whimsy-routine-form-pair whimsy-routine-form-outputs");
  const showGroup = el(doc, "div", "whimsy-routine-form-group");
  showGroup.append(el(doc, layout == "sheet" ? "span" : "h3", layout == "sheet" ? "whimsy-routine-form-kw" : "", layout == "sheet" ? "whimsy-routine-form-kw-show" : "whimsy-routine-form-show"));
  const show = lazy.WhimsySurface.dropdown(doc, {
    id: `${o.idPrefix ?? "whimsy-routine-form"}-show`,
    options: [
      { value: "bar", l10nId: "whimsy-routine-form-show-bar", detailL10nId: "whimsy-routine-form-show-default" },
      { value: "bar+notify", l10nId: "whimsy-routine-form-show-bar-notify" },
      { value: "thread", l10nId: "whimsy-routine-form-show-thread" },
    ],
    value: draft.showIn,
    width: 300,
    onPick: v => {
      touched(show.button);
      draft.showIn = v;
      changed();
    },
  });
  show.button.dataset.field = "show";
  filled(show.button);
  showGroup.append(show.button);
  const usingGroup = el(doc, "div", "whimsy-routine-form-group");
  usingGroup.append(el(doc, layout == "sheet" ? "span" : "h3", layout == "sheet" ? "whimsy-routine-form-kw" : "", layout == "sheet" ? "whimsy-routine-form-kw-using" : "whimsy-routine-form-using"));
  const usingHost = el(doc, "span", "whimsy-routine-form-using-host");
  usingGroup.append(usingHost);
  pair.append(showGroup, usingGroup);

  const note = el(doc, "p", "whimsy-routine-form-note", "whimsy-routine-form-note");
  const error = el(doc, "p", "whimsy-routine-form-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const tried = el(doc, "div", "whimsy-routine-form-tried");
  tried.hidden = true;
  tried.setAttribute("aria-live", "polite");

  // ---- Buttons ----
  const buttons = el(doc, "div", "whimsy-routine-form-buttons");
  const tryButton = el(doc, "button", "whimsy-routine-form-try", "whimsy-routine-form-try");
  tryButton.type = "button";
  const spacer = el(doc, "span", "whimsy-routine-form-spacer");
  const cancel = el(doc, "button", "whimsy-routine-form-cancel", "whimsy-routine-form-cancel");
  cancel.type = "button";
  const primary = el(doc, "button", "whimsy-routine-form-primary", editing ? "whimsy-routine-form-save" : "whimsy-routine-form-turn-on");
  primary.type = "button";
  buttons.append(tryButton, spacer, cancel, primary);
  cancel.addEventListener("click", () => o.onCancel?.());
  prompt.addEventListener("keydown", event => {
    if (event.key == "Enter" && event.metaKey && !primary.disabled) {
      event.preventDefault();
      primary.click();
    }
  });

  if (layout == "sheet") {
    root.append(whenGroup, connect, doGroup, pair, note, error, tried);
  } else {
    root.append(whenGroup, connect, doGroup, pair, note, error, tried, buttons);
  }

  // ---- Behaviour ----
  function setKind(kind) {
    if (draft.trigger.kind == kind) {
      return;
    }
    draft.trigger = { kind, ...DEFAULTS[kind] };
    if (kind == "page") {
      const tab = watchableTabs(win).find(t => t == win.gBrowser.selectedTab) ?? watchableTabs(win)[0];
      if (tab) {
        draft.trigger.url = tab.linkedBrowser.currentURI.spec;
        draft.trigger.userContextId = tab.getAttribute("usercontextid") | 0;
        draft.pageTitle = tab.label;
      }
    }
    renderDetail();
    renderUsing();
    renderConnect();
    changed();
  }

  function dropdown(field, opts) {
    const dd = lazy.WhimsySurface.dropdown(doc, {
      id: `${o.idPrefix ?? "whimsy-routine-form"}-${field}`,
      width: 220,
      ...opts,
      onPick: v => {
        touched(dd.button);
        opts.onPick(v);
        changed();
      },
    });
    dd.button.dataset.field = field;
    dd.button.classList.add("whimsy-routine-token");
    return filled(dd.button);
  }

  function renderDetail() {
    const t = draft.trigger;
    const parts = [];
    switch (t.kind) {
      case "schedule": {
        const days = [
          { value: "weekdays", l10nId: "whimsy-routine-form-days-weekdays" },
          { value: "daily", l10nId: "whimsy-routine-form-days-daily" },
          { value: "weekends", l10nId: "whimsy-routine-form-days-weekends" },
          ...[1, 2, 3, 4, 5, 6, 0].map(day => ({ value: `d${day}`, l10nId: "whimsy-routine-form-days-one", l10nArgs: { day } })),
          { value: "hourly", l10nId: "whimsy-routine-form-days-hourly", rule: true },
        ];
        parts.push(
          dropdown("days", {
            options: days,
            value: daysKey(t),
            onPick: v => {
              if (v == "hourly") {
                draft.trigger = { kind: "schedule", every: "hour", minute: 0 };
              } else {
                const set = DAY_SETS[v] ?? [Number(v.slice(1))];
                draft.trigger = { kind: "schedule", days: set, hour: t.hour ?? 8, minute: t.minute ?? 0 };
              }
              renderDetail();
            },
          })
        );
        if (t.every != "hour") {
          const slots = [];
          for (let h = 5; h < 24; h++) {
            slots.push([h, 0], [h, 30]);
          }
          if (!slots.some(([h, m]) => h == t.hour && m == t.minute)) {
            slots.push([t.hour, t.minute]);
            slots.sort((a, b) => a[0] * 60 + a[1] - (b[0] * 60 + b[1]));
          }
          parts.push(
            dropdown("time", {
              options: slots.map(([h, m]) => ({ value: `${h}:${m}`, text: timeText(h, m) })),
              value: `${t.hour}:${t.minute}`,
              onPick: v => {
                const [h, m] = v.split(":").map(Number);
                draft.trigger = { ...draft.trigger, hour: h, minute: m };
              },
            })
          );
        }
        break;
      }
      case "page": {
        const tabs = watchableTabs(win);
        const options = tabs.map(tab => ({ value: tab.linkedBrowser.currentURI.spec, text: tab.label }));
        if (t.url && !options.some(x => x.value == t.url)) {
          options.unshift({ value: t.url, text: draft.title || t.url });
        }
        if (options.length) {
          parts.push(
            dropdown("page", {
              options,
              value: t.url,
              width: 300,
              onPick: url => {
                const tab = tabs.find(x => x.linkedBrowser.currentURI.spec == url);
                draft.trigger = { ...draft.trigger, url, userContextId: tab ? tab.getAttribute("usercontextid") | 0 : draft.trigger.userContextId };
                if (tab && !editing) {
                  draft.title = tab.label;
                }
              },
            })
          );
        } else {
          parts.push(el(doc, "span", "whimsy-routine-form-missing", "whimsy-routine-form-no-page"));
        }
        parts.push(
          dropdown("interval", {
            options: lazy.INTERVALS.map(minutes => ({ value: String(minutes), l10nId: "whimsy-watch-interval", l10nArgs: { minutes } })),
            value: String(t.interval ?? 60),
            onPick: v => (draft.trigger = { ...draft.trigger, interval: Number(v) }),
          })
        );
        break;
      }
      case "return":
        parts.push(
          dropdown("away", {
            options: [30, 60, 120, 240, 480].map(minutes => ({ value: String(minutes), l10nId: "whimsy-routine-form-away", l10nArgs: { minutes, hours: minutes / 60 } })),
            value: String(t.awayMinutes ?? 120),
            onPick: v => (draft.trigger = { kind: "return", awayMinutes: Number(v) }),
          })
        );
        break;
      case "meeting":
        parts.push(
          dropdown("lead", {
            options: [
              ...[5, 10, 15, 30].map(minutes => ({ value: String(minutes), l10nId: "whimsy-routine-form-lead", l10nArgs: { minutes } })),
              { value: "after", l10nId: "whimsy-routine-form-lead-after", rule: true },
            ],
            value: t.after ? "after" : String(t.leadMinutes ?? 10),
            onPick: v => (draft.trigger = v == "after" ? { kind: "meeting", after: true, leadMinutes: 5 } : { kind: "meeting", leadMinutes: Number(v) }),
          })
        );
        break;
      case "email":
        parts.push(
          dropdown("from", {
            options: [
              { value: "anyone", l10nId: "whimsy-routine-form-email-anyone" },
              { value: "known", l10nId: "whimsy-routine-form-email-known" },
            ],
            value: t.match == "known" ? "known" : "anyone",
            onPick: v => (draft.trigger = { kind: "email", match: v }),
          })
        );
        break;
      case "open-site": {
        const input = el(doc, "input", "zen-library-routing-reference whimsy-routine-form-site", "whimsy-routine-form-site");
        input.type = "text";
        input.value = t.host ?? "";
        input.dataset.field = "site";
        input.addEventListener("input", () => {
          touched(input);
          draft.trigger = { kind: "open-site", host: input.value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "") };
          sync();
        });
        parts.push(filled(input));
        break;
      }
      case "download":
        parts.push(
          dropdown("download", {
            options: ["any", "pdf", "image"].map(v => ({ value: v, l10nId: `whimsy-routine-form-download-${v}` })),
            value: ["pdf", "image"].includes(t.match) ? t.match : "any",
            onPick: v => (draft.trigger = { kind: "download", match: v }),
          })
        );
        break;
    }
    detail.replaceChildren(...parts);
    if (layout != "sheet") {
      for (const chip of kindControl.children) {
        const on = chip.dataset.kind == t.kind;
        chip.toggleAttribute("active", on);
        chip.setAttribute("aria-checked", on ? "true" : "false");
        chip.tabIndex = on ? 0 : -1;
      }
    }
  }

  function unmetNeed() {
    for (const group of needsOf(draft)) {
      if (!NEEDS[group].ids.some(id => connected.has(id))) {
        return group;
      }
    }
    return null;
  }

  function renderConnect() {
    const group = unmetNeed();
    if (!group && !connect.dataset.justConnected) {
      connect.hidden = true;
      connect.replaceChildren();
      return;
    }
    connect.hidden = false;
    if (!group) {
      const done = el(doc, "div", "whimsy-routine-form-connected");
      done.append(el(doc, "span", "whimsy-routine-form-check"), el(doc, "span", "", "whimsy-routine-form-connected"));
      connect.replaceChildren(done);
      return;
    }
    connect.dataset.group = group;
    const head = el(doc, "div", "whimsy-routine-form-connect-head");
    head.append(img(doc, `${ZEN}extension.svg`, "whimsy-routine-form-connect-icon"), el(doc, "span", "", `whimsy-routine-form-needs-${group}`));
    const why = el(doc, "div", "whimsy-routine-form-connect-detail", `whimsy-routine-form-needs-${group}-detail`);
    const row = el(doc, "div", "whimsy-routine-form-connect-buttons");
    for (const [id, label, logo] of NEEDS[group].buttons) {
      const button = el(doc, "button", "whimsy-routine-form-connect-button");
      button.type = "button";
      button.dataset.connector = id;
      const text = el(doc, "span", "whimsy-routine-form-connect-label", `whimsy-routine-form-connect-${label}`);
      button.append(img(doc, `${OWN}${logo}.svg`, "whimsy-routine-form-logo"), text);
      if (connecting == id) {
        button.setAttribute("busy", "");
        button.prepend(el(doc, "span", "whimsy-routine-form-spinner"));
      }
      button.addEventListener("click", () => connectTo(id));
      row.append(button);
    }
    connect.replaceChildren(head, why, row);
  }

  async function connectTo(id) {
    if (connecting) {
      return;
    }
    connecting = id;
    renderConnect();
    sync();
    try {
      await lazy.WhimsyConnectors.connect(win, id);
    } catch (e) {
      console.warn("Whimsy routines: connect", e);
    }
    connecting = null;
    await refreshConnected();
    if (!unmetNeed()) {
      connect.dataset.justConnected = "1";
    }
    renderConnect();
    changed();
  }

  async function refreshConnected() {
    try {
      connected = connectedIds(await lazy.WhimsyConnectors.list());
    } catch {
      connected = new Set();
    }
  }

  function needsTools() {
    return needsOf(draft).length > 0;
  }

  function renderUsing() {
    const P = lazy.WhimsyAIProviders;
    const ids = lazy.WhimsyAIRouter._enabled();
    const needs = needsTools() ? { tools: true } : {};
    const kind = draft.trigger.kind;
    const reason = kind == "email" || needsOf(draft)[0] == "mail" ? "whimsy-routine-form-cant-mail" : kind == "meeting" || needsOf(draft)[0] == "calendar" ? "whimsy-routine-form-cant-calendar" : "whimsy-routine-form-cant-tools";
    const fits = ids.filter(id => lazy.WhimsyAIRouter._fits(id, needs));
    const first = fits[0] ?? ids[0];
    const name = id => P.providerName(id) || id;
    const options = [
      {
        value: "auto",
        l10nId: "whimsy-routine-form-using-auto",
        shortL10nId: first ? "whimsy-routine-form-using-auto-short" : "whimsy-routine-form-using-auto",
        l10nArgs: { provider: first ? name(first) : "" },
        detailL10nId: first ? "whimsy-routine-form-using-first" : null,
        detailL10nArgs: { provider: first ? name(first) : "" },
      },
      ...ids.map((id, i) => ({
        value: id,
        text: name(id),
        rule: i == 0,
        disabled: !fits.includes(id),
        detailL10nId: fits.includes(id) ? null : reason,
      })),
    ];
    if (draft.using != "auto" && !fits.includes(draft.using)) {
      draft.using = "auto";
    }
    const dd = lazy.WhimsySurface.dropdown(doc, {
      id: `${o.idPrefix ?? "whimsy-routine-form"}-using`,
      options,
      value: draft.using,
      width: 280,
      onPick: v => {
        touched(dd.button);
        draft.using = v;
        changed();
      },
    });
    dd.button.dataset.field = "using";
    dd.button.classList.add("whimsy-routine-token");
    filled(dd.button);
    usingHost.replaceChildren(dd.button);
  }

  function valid() {
    const t = draft.trigger;
    if (!String(draft.prompt ?? "").trim()) {
      return false;
    }
    if (t.kind == "page" && !t.url) {
      return false;
    }
    if (t.kind == "open-site" && !t.host) {
      return false;
    }
    return !unmetNeed();
  }

  function sync() {
    const empty = !String(draft.prompt ?? "").trim();
    ideas.hidden = !empty;
    primary.disabled = busy || !valid();
    tryButton.disabled = busy || empty || !!unmetNeed();
    if (layout != "sheet" && draft.trigger.kind == "page") {
      note.hidden = true;
    } else {
      note.hidden = false;
    }
  }

  function toRoutine() {
    const r = {
      id: draft.id,
      builtIn: draft.builtIn,
      title: draft.trigger.kind == "page" ? draft.title || draft.pageTitle : draft.title,
      trigger: { ...draft.trigger },
      prompt: String(draft.prompt).trim(),
      showIn: draft.showIn,
      using: draft.using,
      paused: draft.paused,
    };
    if (r.trigger.kind == "page") {
      r.trigger.title = r.title;
    }
    return r;
  }

  primary.addEventListener("click", async () => {
    if (!valid() || busy) {
      return;
    }
    busy = true;
    sync();
    error.hidden = true;
    try {
      const saved = await lazy.WhimsyRoutines.save(toRoutine(), { confirmed: true });
      busy = false;
      o.onDone?.(saved);
    } catch (e) {
      busy = false;
      error.hidden = false;
      if (e?.code == "too-many" && draft.trigger.kind == "page") {
        doc.l10n.setAttributes(error, "whimsy-routine-form-watch-cap", { count: lazy.MAX_WATCHES });
      } else {
        doc.l10n.setAttributes(error, e?.code == "too-many" ? "whimsy-routine-form-too-many" : "whimsy-routine-form-failed");
      }
      changed();
    }
  });

  tryButton.addEventListener("click", async () => {
    if (busy) {
      return;
    }
    busy = true;
    doc.l10n.setAttributes(tryButton, "whimsy-routine-form-trying");
    sync();
    tried.hidden = true;
    try {
      const result = await lazy.WhimsyRoutines.tryOnce(toRoutine());
      const head = el(doc, "div", "whimsy-routine-form-tried-head");
      head.textContent = result?.headline ?? "";
      const body = el(doc, "div", "whimsy-routine-form-tried-body");
      body.textContent = String(result?.text ?? "").split("\n").slice(1).join("\n").trim();
      tried.replaceChildren(head, body);
      tried.hidden = false;
    } catch {
      const failed = el(doc, "div", "whimsy-routine-form-tried-head", "whimsy-routine-form-try-failed");
      tried.replaceChildren(failed);
      tried.hidden = false;
    }
    busy = false;
    doc.l10n.setAttributes(tryButton, "whimsy-routine-form-try");
    changed();
  });

  renderDetail();
  renderUsing();
  sync();
  refreshConnected().then(() => {
    renderConnect();
    changed();
  });

  return {
    root,
    buttons,
    primary,
    state,
    focusFirst() {
      const first = layout == "sheet" ? kindControl : kindControl.querySelector("[active]");
      first?.focus();
    },
  };
}

/**
 * Chat's "make a routine": the same form in a sheet, the fields chat filled
 * outlined, beside the chat. Never saves by itself.
 */
export function openRoutineSheet(win, { draft, outlined = true, anchor = null, onDone = null } = {}) {
  const S = lazy.WhimsySurface;
  const doc = win.document;
  const editing = !!draft.id;
  const parts = S.create(win, {
    id: "whimsy-routine-sheet",
    width: 480,
    close: true,
    footer: true,
    title: draft.title || undefined,
    titleL10nId: draft.title ? undefined : editing ? "whimsy-routine-form-edit" : "whimsy-routine-form-new",
    className: "whimsy-routine-sheet",
    closeOnOutsideClick: false,
    initialFocus: () => form.primary.disabled ? form.root.querySelector("textarea") : form.primary,
  });
  const form = buildRoutineForm(win, {
    draft,
    layout: "sheet",
    outlined,
    idPrefix: "whimsy-routine-sheet",
    onCancel: () => S.close(parts.panel),
    onDone: saved => {
      S.close(parts.panel);
      onDone?.(saved);
    },
  });
  parts.view.append(form.root);
  form.buttons.classList.add("whimsy-routine-sheet-buttons");
  parts.footer.append(form.buttons);
  S.finish(parts);
  const chat = doc.getElementById("whimsy-chat");
  const beside = anchor ?? (chat && !chat.hidden && chat.checkVisibility?.() ? chat : null);
  if (beside) {
    S.open(win, parts.panel, { anchor: beside, position: "start_before", x: -8, y: 140 });
  } else {
    S.open(win, parts.panel, { at: "page-top-center" });
  }
  return { ...parts, form };
}
