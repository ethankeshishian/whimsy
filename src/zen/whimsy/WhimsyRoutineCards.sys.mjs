/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// W23: how routine and watch threads look in chat. Each run is a dated
// entry (the newest open, older ones one line; steps fold into "took
// 40 s"), a failure is chat's one error block with its next step, skipped
// meeting prep is a neutral card, and a watch's checks without a hit fold
// into one line. The bar on top says what the thread is (Routine or Page
// watch) with Run now or Check now, and Edit.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  WhimsyChat: "resource:///modules/whimsy/WhimsyChat.sys.mjs",
  WhimsyPageWatch: "resource:///modules/whimsy/WhimsyPageWatch.sys.mjs",
  WhimsyRoutines: "resource:///modules/whimsy/WhimsyRoutines.sys.mjs",
  errorBlock: "resource:///modules/whimsy/WhimsyChatAnswer.sys.mjs",
  renderMarkdown: "resource:///modules/whimsy/WhimsyChatAnswer.sys.mjs",
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

// "8:02 AM" today, "Tue 9:14 AM" this week, else "Oct 30, 9:14 AM".
function when(ms) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (ms >= today.getTime()) {
    return time;
  }
  if (ms >= today.getTime() - 6 * DAY) {
    return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  }
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

function dateOf(ms) {
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

// The one line after the time: running, found, caught up, took N s, or the headline when folded.
function runMeta(msg) {
  if (msg.running) {
    return ["whimsy-routine-run-running"];
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
      node.append(body(doc, msg, ctx));
      doc.l10n.translateFragment(node);
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

function renderFail(doc, msg, ctx) {
  const step = msg.step;
  const buttons = [];
  if (step) {
    buttons.push({ l10n: [step.l10nId, step.args], primary: true, run: () => lazy.WhimsyRoutines.act(ctx.win, msg.routineId, step) });
    if (step.action == "reconnect" || step.action == "sign-in") {
      buttons.push({ l10n: "whimsy-routine-step-skip-today", run: () => lazy.WhimsyRoutines.act(ctx.win, msg.routineId, { action: "skip-today" }) });
    }
  }
  const node = lazy.errorBlock(doc, {
    tone: msg.tone == "grey" ? "grey" : "fail",
    l10n: [msg.tone == "grey" ? "whimsy-routine-fail-waiting" : "whimsy-routine-fail-title", { time: when(msg.at) }],
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
  const run = watch
    ? h(doc, "button", { class: "whimsy-chat-link", l10n: "whimsy-routine-check-now", onclick: () => lazy.WhimsyPageWatch.checkNow(r.id) })
    : h(doc, "button", { class: "whimsy-chat-link", l10n: "whimsy-routine-run-now", disabled: running, onclick: () => lazy.WhimsyRoutines.runNow(r.id) });
  const edit = h(doc, "button", {
    class: "whimsy-chat-link",
    l10n: "whimsy-routine-edit",
    onclick: () => lazy.WhimsyRoutines.openForm(ctx.win, { routineId: r.id }),
  });
  bar.replaceChildren(pill, h(doc, "span", { class: "whimsy-routine-bar-when", l10n: label }), h(doc, "span", { class: "whimsy-routine-bar-buttons" }, run, edit));
  await doc.l10n.translateFragment(bar);
}

function renderBar(doc, thread, ctx) {
  const bar = h(doc, "div", { class: "whimsy-routine-bar", "data-kind": thread.kind });
  fillBar(doc, bar, thread, ctx).catch(e => console.error("Whimsy routines: thread bar", e));
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
  },
};
