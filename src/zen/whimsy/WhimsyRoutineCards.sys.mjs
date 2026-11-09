/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23: how routine and watch threads look in chat. Each run is a dated
// entry (the newest open, older ones one line; steps fold into "took
// 40 s"), a failure is chat's one error block with its next step, skipped
// meeting prep is a neutral card, and a watch's checks without a hit fold
// into one line. A line for each day sits between runs ("Today",
// "Yesterday", "Tuesday"). The bar on top says what the thread is (Routine
// or Page watch) with Run now (Stop while it runs) or Check now, and Edit.
// An open thread follows its runs as they change.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyAIStore: "resource:///modules/whimsy/WhimsyAIStore.sys.mjs",
  WhimsyChat: "resource:///modules/whimsy/WhimsyChat.sys.mjs",
  WhimsyPageWatch: "resource:///modules/whimsy/WhimsyPageWatch.sys.mjs",
  WhimsyRoutines: "resource:///modules/whimsy/WhimsyRoutines.sys.mjs",
  errorBlock: "resource:///modules/whimsy/WhimsyChatAnswer.sys.mjs",
  renderMarkdown: "resource:///modules/whimsy/WhimsyChatAnswer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const DAY = 24 * 60 * 60 * 1000;

function h(doc, tag, attrs = {}, ...children) {
  const el = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) {
      continue;
    }
    if (k == "l10n") {
      const [id, args] = Array.isArray(v) ? v : [v];
      doc.l10n.setAttributes(el, id, args);
    } else if (k.startsWith("on")) {
      el.addEventListener(k.slice(2), v);
    } else if (k == "text") {
      el.textContent = v;
    } else {
      el.setAttribute(k, v === true ? "" : v);
    }
  }
  el.append(...children.flat().filter(c => c != null && c !== false));
  return el;
}

function icon(doc, name) {
  return h(doc, "span", { class: "whimsy-chat-icon", "data-icon": name, "aria-hidden": "true" });
}

// "8:02 AM"; the day line above the run says which day.
function when(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// "Today", "Yesterday", "Tuesday" this week, else "Oct 30" (and the year when it isn't this one).
function dayLine(doc, ms) {
  const today = startOfDay(Date.now());
  const day = startOfDay(ms);
  const node = h(doc, "div", { class: "whimsy-routine-day", role: "separator" });
  if (day >= today) {
    doc.l10n.setAttributes(node, "whimsy-routine-day-today");
  } else if (day >= startOfDay(today - DAY / 2)) {
    doc.l10n.setAttributes(node, "whimsy-routine-day-yesterday");
  } else if (day > today - 7 * DAY) {
    node.textContent = new Date(ms).toLocaleDateString([], { weekday: "long" });
  } else {
    const year = new Date(ms).getFullYear() == new Date().getFullYear() ? undefined : "numeric";
    node.textContent = new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year });
  }
  return node;
}

// The day lines: before the first run, failure, or skip of each day.
function withDays(doc, messages, nodes) {
  const byId = new Map(messages.map(m => [m.id, m]));
  const out = [];
  let last = null;
  for (const node of nodes) {
    const m = byId.get(node.getAttribute?.("data-msg-id"));
    const at = m?.role == "card" ? (m.at ?? m.since) : null;
    if (at) {
      const day = startOfDay(at);
      if (day != last) {
        out.push(dayLine(doc, at));
        last = day;
      }
    }
    out.push(node);
  }
  return out;
}

function dateOf(ms) {
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

// The one line after the time: running, found, caught up, took N s, or the headline when folded.
function runMeta(msg) {
  if (msg.running) {
    return ["whimsy-routine-run-running"];
  }
  if (msg.stopped) {
    return ["whimsy-routine-run-stopped"];
  }
  if (msg.failed) {
    return ["whimsy-routine-run-failed"];
  }
  if (msg.folded) {
    return null;
  }
  if (msg.found) {
    return ["whimsy-routine-run-found"];
  }
  if (msg.whileClosed) {
    return ["whimsy-routine-run-caught-up", { count: msg.misses || 1, seconds: Math.max(1, Math.round((msg.tookMs ?? 0) / 1000)) }];
  }
  return ["whimsy-routine-run-took", { seconds: Math.max(1, Math.round((msg.tookMs ?? 0) / 1000)) }];
}

function renderRun(doc, msg, ctx) {
  const meta = runMeta(msg);
  const head = h(
    doc,
    "div",
    { class: "whimsy-routine-run-head" },
    h(doc, "b", { text: when(msg.at) }),
    meta ? h(doc, "span", { l10n: meta }) : h(doc, "span", { class: "whimsy-routine-run-headline", text: msg.headline ?? "" })
  );
  const node = h(doc, "div", { class: "whimsy-routine-run", "data-msg-id": msg.id, folded: !!msg.folded, running: !!msg.running }, head);
  if (msg.folded) {
    head.setAttribute("role", "button");
    head.setAttribute("tabindex", "0");
    head.setAttribute("aria-expanded", "false");
    const open = () => {
      node.removeAttribute("folded");
      head.removeAttribute("role");
      head.removeAttribute("tabindex");
      head.removeAttribute("aria-expanded");
      head.lastChild.replaceWith(h(doc, "span", { l10n: runMeta({ ...msg, folded: false }) }));
      const opened = body(doc, msg, ctx);
      node.append(opened);
      doc.l10n.translateFragment(node);
      // Zen's expand: the run opens downward; reduced motion fades only.
      const still = doc.defaultView.matchMedia("(prefers-reduced-motion: reduce)").matches;
      opened.animate(
        still ? { opacity: [0, 1] } : { opacity: [0, 1], transform: ["translateY(-4px)", "none"] },
        { duration: 200, easing: "cubic-bezier(0.34, 1.2, 0.64, 1)" }
      );
    };
    head.addEventListener("click", open, { once: true });
    head.addEventListener("keydown", e => (e.key == "Enter" || e.key == " ") && (e.preventDefault(), open()));
    return node;
  }
  if (msg.running) {
    const steps = h(doc, "div", { class: "whimsy-routine-steps" });
    for (const step of msg.steps ?? []) {
      steps.append(h(doc, "span", { class: "whimsy-routine-step" }, icon(doc, "check"), h(doc, "span", { text: step })));
    }
    steps.append(h(doc, "span", { class: "whimsy-routine-step", current: true }, h(doc, "span", { class: "whimsy-chat-spinner" }), h(doc, "span", { l10n: "whimsy-routine-run-working" })));
    node.append(steps);
    return node;
  }
  if (msg.text) {
    node.append(body(doc, msg, ctx));
  }
  return node;
}

function body(doc, msg, ctx) {
  const text = h(doc, "div", { class: "whimsy-chat-text whimsy-chat-md" });
  try {
    text.append(...[lazy.renderMarkdown(doc, msg.text ?? "", ctx)].flat().filter(Boolean));
  } catch {
    text.textContent = msg.text ?? "";
  }
  return h(doc, "div", { class: "whimsy-chat-msg", "data-role": "ai" }, text);
}

async function openWatchPage(win, watchId) {
  const watch = (await lazy.WhimsyPageWatch.list()).find(w => w.id == watchId);
  if (watch) {
    lazy.WhimsyPageWatch.openWatch(win, watch);
  }
}

function renderFail(doc, msg, ctx) {
  const step = msg.step;
  const buttons = [];
  if (step?.action == "open-page") {
    buttons.push({ l10n: [step.l10nId, step.args], primary: true, run: () => openWatchPage(ctx.win, msg.watchId) });
  } else if (step) {
    buttons.push({ l10n: [step.l10nId, step.args], primary: true, run: () => lazy.WhimsyRoutines.act(ctx.win, msg.routineId, step) });
    if (step.action == "reconnect" || step.action == "sign-in") {
      buttons.push({ l10n: "whimsy-routine-step-skip-today", run: () => lazy.WhimsyRoutines.act(ctx.win, msg.routineId, { action: "skip-today" }) });
    }
  }
  const node = lazy.errorBlock(doc, {
    tone: msg.tone == "grey" ? "grey" : "fail",
    l10n: [msg.titleL10n ?? (msg.tone == "grey" ? "whimsy-routine-fail-waiting" : "whimsy-routine-fail-title"), { time: when(msg.at) }],
    detail: msg.reason,
    buttons,
    code: msg.code,
  });
  node.classList.add("whimsy-routine-fail");
  node.setAttribute("data-msg-id", msg.id);
  return node;
}

function renderSkip(doc, msg, ctx) {
  const m = msg.meeting ?? {};
  const late = Math.max(0, Math.round(((msg.openedAt ?? msg.at) - (m.start ?? msg.at)) / 60000));
  return h(
    doc,
    "div",
    { class: "whimsy-routine-skip", "data-msg-id": msg.id },
    h(doc, "b", {}, icon(doc, "clock"), h(doc, "span", { l10n: ["whimsy-routine-skip-title", { meeting: m.title ?? "" }] })),
    h(doc, "span", { class: "whimsy-routine-skip-text", l10n: ["whimsy-routine-skip-body", { opened: when(msg.openedAt ?? msg.at), minutes: late }] }),
    h(
      doc,
      "span",
      { class: "whimsy-routine-skip-buttons" },
      h(doc, "button", {
        class: "whimsy-chat-pill-btn",
        l10n: "whimsy-routine-skip-prep",
        onclick: () => lazy.WhimsyRoutines.act(ctx.win, msg.routineId, { action: "prep-anyway", meeting: m }),
      })
    )
  );
}

function renderQuiet(doc, msg) {
  return h(
    doc,
    "div",
    { class: "whimsy-routine-run", folded: true, "data-msg-id": msg.id, "data-kind": "quiet" },
    h(
      doc,
      "div",
      { class: "whimsy-routine-run-head" },
      h(doc, "b", { l10n: ["whimsy-routine-watch-since", { date: dateOf(msg.since ?? msg.time) }] }),
      h(doc, "span", { l10n: ["whimsy-routine-watch-quiet", { count: msg.count ?? 1 }] })
    )
  );
}

function scheduleLabel(trigger) {
  if (trigger.every == "hour") {
    return ["whimsy-routine-when-hourly"];
  }
  const d = new Date();
  d.setHours(Number(trigger.hour) || 0, Number(trigger.minute) || 0, 0, 0);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = [...(trigger.days ?? [0, 1, 2, 3, 4, 5, 6])].sort().join("");
  if (days == "0123456") {
    return ["whimsy-routine-when-daily", { time }];
  }
  if (days == "12345") {
    return ["whimsy-routine-when-weekdays", { time }];
  }
  const names = trigger.days.map(i => new Date(2026, 10, 1 + i).toLocaleDateString([], { weekday: "long" }));
  return ["whimsy-routine-when-days", { days: new Intl.ListFormat(undefined, { type: "conjunction" }).format(names), time }];
}

/** What a trigger reads as in the thread bar ("Weekdays at 8:00 AM"). */
export function triggerLabel(trigger = {}) {
  switch (trigger.kind) {
    case "schedule":
      return scheduleLabel(trigger);
    case "return":
      return ["whimsy-routine-when-return", { hours: Math.round(((Number(trigger.awayMinutes) || 60) / 60) * 10) / 10 }];
    case "meeting":
      return trigger.after ? ["whimsy-routine-when-meeting-after"] : ["whimsy-routine-when-meeting", { minutes: Number(trigger.leadMinutes) || 10 }];
    case "email":
      return ["whimsy-routine-when-email"];
    case "open-site":
      return ["whimsy-routine-when-site", { site: trigger.host ?? "" }];
    case "download":
      return ["whimsy-routine-when-download"];
    case "page":
      return ["whimsy-routine-when-page", { minutes: Number(trigger.interval) || 60 }];
  }
  return ["whimsy-routine-when-schedule"];
}

async function fillBar(doc, bar, thread, ctx) {
  const id = thread.routineId ?? thread.watchId;
  const r = id ? await lazy.WhimsyRoutines.get(id) : null;
  const watch = thread.kind == "watch";
  const pill = h(doc, "span", { class: "whimsy-routine-pill", l10n: watch ? "whimsy-routine-bar-watch" : "whimsy-routine-bar-routine" });
  if (!r) {
    bar.replaceChildren(pill, h(doc, "span", { l10n: "whimsy-routine-deleted" }));
    return;
  }
  const running = r.status == "running";
  if (running) {
    pill.replaceChildren(h(doc, "span", { class: "whimsy-chat-spinner" }));
    pill.setAttribute("running", "");
    doc.l10n.setAttributes(pill, "whimsy-routine-bar-running");
  }
  const label = watch ? ["whimsy-routine-bar-watch-detail", { condition: r.prompt, minutes: r.trigger.interval }] : triggerLabel(r.trigger);
  // Stop sits in Run now's place while it runs.
  const run = watch
    ? h(doc, "button", { class: "whimsy-chat-link", l10n: "whimsy-routine-check-now", onclick: () => lazy.WhimsyPageWatch.checkNow(r.id) })
    : running
      ? h(doc, "button", { class: "whimsy-chat-link", "data-action": "stop", l10n: "whimsy-routine-stop", onclick: () => lazy.WhimsyRoutines.stop(r.id) })
      : h(doc, "button", { class: "whimsy-chat-link", "data-action": "run", l10n: "whimsy-routine-run-now", onclick: () => lazy.WhimsyRoutines.runNow(r.id) });
  const edit = h(doc, "button", {
    class: "whimsy-chat-link",
    l10n: "whimsy-routine-edit",
    onclick: () => lazy.WhimsyRoutines.openForm(ctx.win, { routineId: r.id }),
  });
  bar.replaceChildren(pill, h(doc, "span", { class: "whimsy-routine-bar-when", l10n: label }), h(doc, "span", { class: "whimsy-routine-bar-buttons" }, run, edit));
  await doc.l10n.translateFragment(bar);
}

// What an open thread shows: its run cards and the routine's state.
async function signature(thread) {
  const id = thread.routineId ?? thread.watchId;
  const r = id ? await lazy.WhimsyRoutines.get(id) : null;
  const cards = (await lazy.WhimsyAIStore.messages(thread.id)).filter(m => m.role == "card");
  return JSON.stringify([!!r, r?.status ?? null, cards.map(m => [m.id, !!m.running, !!m.folded, !!m.failed, !!m.stopped, m.steps?.length ?? 0, m.count ?? 0, !!m.text])]);
}

// Open threads follow their runs: when what they show changes, chat redraws them.
const live = new Set();
let liveTimer = null;
let observing = false;
const TOPICS = ["whimsy-ai-store-changed", "whimsy-routines-changed"];
const liveObserver = {
  observe() {
    liveTimer ??= lazy.setTimeout(() => refreshLive().catch(e => console.error("Whimsy routines: thread", e)), 100);
  },
};

function follow(entry) {
  live.add(entry);
  if (!observing) {
    observing = true;
    TOPICS.forEach(t => Services.obs.addObserver(liveObserver, t));
  }
}

async function refreshLive() {
  liveTimer = null;
  for (const entry of [...live]) {
    if (entry.sig == null) {
      continue;
    }
    const { bar, thread, ctx } = entry;
    if (!bar.isConnected || ctx.panel?.thread?.id != thread.id) {
      live.delete(entry);
      continue;
    }
    if ((await signature(thread)) != entry.sig) {
      live.delete(entry);
      ctx.panel.showThread(thread.id);
    }
  }
  if (!live.size && observing) {
    observing = false;
    TOPICS.forEach(t => Services.obs.removeObserver(liveObserver, t));
  }
}

function renderBar(doc, thread, ctx) {
  const bar = h(doc, "div", { class: "whimsy-routine-bar", "data-kind": thread.kind });
  const entry = { bar, thread, ctx, sig: null };
  if (ctx.panel?.showThread) {
    follow(entry);
  }
  signature(thread)
    .then(sig => (entry.sig = sig))
    .then(() => fillBar(doc, bar, thread, ctx))
    .catch(e => console.error("Whimsy routines: thread bar", e));
  return bar;
}

export const WhimsyRoutineCards = {
  triggerLabel,
  _registered: false,

  register() {
    if (this._registered) {
      return;
    }
    this._registered = true;
    const C = lazy.WhimsyChat;
    C.registerCard("routine-run", renderRun);
    C.registerCard("routine-fail", renderFail);
    C.registerCard("routine-skip", renderSkip);
    C.registerCard("watch-quiet", renderQuiet);
    C.registerCard("threadbar:routine", renderBar);
    C.registerCard("threadbar:watch", renderBar);
    C.registerCard("threaddays:routine", withDays);
    C.registerCard("threaddays:watch", withDays);
  },
};
