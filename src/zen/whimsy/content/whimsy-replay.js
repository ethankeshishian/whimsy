/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Claude runs (whimsy://replay): the agent replay's timeline
// (WhimsyClaudeReplay.sys.mjs). Pick a run, scrub through its steps with
// the slider, the filmstrip or the arrow keys, open a step's page, copy
// the run's log. Loaded with the system principal (about:whimsy?replay).

"use strict";

(async () => {
  const { WhimsyClaudeReplay } = ChromeUtils.importESModule(
    "resource:///modules/whimsy/WhimsyClaudeReplay.sys.mjs"
  );
  const $ = id => document.getElementById(id);
  const locale = Services.locale.appLocaleAsBCP47;
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const clock = new Intl.DateTimeFormat(locale, { timeStyle: "medium" });
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  let runs = [];
  let run = null;
  let index = 0;

  const host = url => {
    try {
      return new URL(url).host;
    } catch (e) {
      return "";
    }
  };
  const isWeb = url => /^https?:\/\//i.test(url || "");

  function runName(r) {
    return r.steps.map(s => host(s.url)).find(Boolean) || when.format(r.start);
  }

  function setTool(el, tool) {
    document.l10n.setAttributes(el, "whimsy-replay-tool", { tool });
  }

  function renderRuns() {
    const nav = $("whimsy-replay-runs");
    nav.replaceChildren(
      ...runs.map(r => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.run = r.id;
        button.setAttribute("aria-current", r == run ? "true" : "false");
        const name = document.createElement("span");
        name.className = "whimsy-replay-run-name";
        name.textContent = runName(r);
        const info = document.createElement("span");
        info.className = "whimsy-replay-run-info";
        const time = document.createElement("span");
        time.textContent = when.format(r.start) + " · ";
        const count = document.createElement("span");
        document.l10n.setAttributes(count, "whimsy-replay-steps", { count: r.steps.length });
        info.append(time, count);
        const failed = r.steps.filter(s => !s.ok).length;
        if (failed) {
          const bad = document.createElement("span");
          bad.className = "whimsy-replay-failed";
          document.l10n.setAttributes(bad, "whimsy-replay-failed", { count: failed });
          info.append(" · ", bad);
        }
        button.append(name, info);
        button.addEventListener("click", () => select(r.id));
        return button;
      })
    );
  }

  function renderStrip() {
    $("whimsy-replay-strip").replaceChildren(
      ...run.steps.map((step, i) => {
        const li = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.step = i;
        button.classList.toggle("whimsy-replay-step-failed", !step.ok);
        let mini;
        if (step.thumb) {
          mini = document.createElement("img");
          mini.src = step.thumb;
          mini.alt = "";
        } else {
          mini = document.createElement("span");
        }
        mini.className = "whimsy-replay-mini";
        const label = document.createElement("span");
        label.className = "whimsy-replay-mini-label";
        setTool(label, step.tool);
        button.append(mini, label);
        button.addEventListener("click", () => show(i, true));
        li.append(button);
        return li;
      })
    );
  }

  function show(i, fromStrip = false) {
    if (!run) {
      return;
    }
    index = Math.max(0, Math.min(run.steps.length - 1, i));
    const step = run.steps[index];
    const thumb = $("whimsy-replay-thumb");
    if (step.thumb) {
      if (thumb.src != step.thumb) {
        thumb.src = step.thumb;
        if (!reduced.matches) {
          thumb.classList.remove("whimsy-replay-enter");
          void thumb.offsetWidth;
          thumb.classList.add("whimsy-replay-enter");
        }
      }
      thumb.hidden = false;
      $("whimsy-replay-no-thumb").hidden = true;
    } else {
      thumb.hidden = true;
      thumb.removeAttribute("src");
      $("whimsy-replay-no-thumb").hidden = false;
    }
    setTool($("whimsy-replay-tool"), step.tool);
    $("whimsy-replay-target").textContent = step.target || "";
    $("whimsy-replay-url").textContent = step.url ? `${clock.format(step.t)} · ${step.url}` : clock.format(step.t);
    $("whimsy-replay-url").title = step.url || "";
    const error = $("whimsy-replay-error");
    error.hidden = step.ok;
    if (!step.ok) {
      document.l10n.setAttributes(error, "whimsy-replay-step-failed", { error: step.error || "" });
    }
    $("whimsy-replay-open").disabled = !isWeb(step.url);
    const scrub = $("whimsy-replay-scrub");
    scrub.max = String(run.steps.length - 1);
    scrub.value = String(index);
    scrub.disabled = run.steps.length < 2;
    document.l10n.setAttributes($("whimsy-replay-position"), "whimsy-replay-step-of", {
      step: index + 1,
      count: run.steps.length,
    });
    for (const button of $("whimsy-replay-strip").querySelectorAll("button")) {
      const current = Number(button.dataset.step) == index;
      button.setAttribute("aria-current", current ? "true" : "false");
      if (current && !fromStrip) {
        button.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduced.matches ? "instant" : "smooth" });
      }
    }
  }

  function select(id) {
    run = runs.find(r => r.id == id) ?? runs[0] ?? null;
    renderRuns();
    if (!run) {
      return;
    }
    $("whimsy-replay-run-title").textContent = runName(run);
    $("whimsy-replay-run-meta").textContent =
      `${when.format(run.start)} – ${clock.format(run.end)}` + (run.client ? ` · ${run.client}` : "");
    $("whimsy-replay-trimmed").hidden = !run.trimmed;
    renderStrip();
    show(0);
  }

  async function load(keep) {
    const enabled = WhimsyClaudeReplay.enabled;
    runs = await WhimsyClaudeReplay.runs();
    $("whimsy-replay-off").hidden = enabled || runs.length > 0;
    $("whimsy-replay-empty").hidden = !enabled || runs.length > 0;
    $("whimsy-replay-layout").hidden = !runs.length;
    $("whimsy-replay-clear").hidden = !runs.length;
    if (runs.length) {
      select(keep && runs.some(r => r.id == keep) ? keep : runs[0].id);
    } else {
      run = null;
    }
    document.documentElement.toggleAttribute("data-ready", true);
  }

  $("whimsy-replay-scrub").addEventListener("input", event => show(Number(event.target.value), true));

  document.addEventListener("keydown", event => {
    if (!run || event.target.localName == "input" || event.altKey || event.metaKey || event.ctrlKey) {
      return;
    }
    const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
    if (event.key in moves) {
      event.preventDefault();
      const delta = moves[event.key];
      show(Number.isFinite(delta) ? index + delta : delta < 0 ? 0 : run.steps.length - 1);
    }
  });

  $("whimsy-replay-open").addEventListener("click", () => {
    const url = run?.steps[index]?.url;
    if (isWeb(url)) {
      window.browsingContext.topChromeWindow.openTrustedLinkIn(url, "tab");
    }
  });

  $("whimsy-replay-copy").addEventListener("click", async () => {
    if (!run) {
      return;
    }
    Cc["@mozilla.org/widget/clipboardhelper;1"]
      .getService(Ci.nsIClipboardHelper)
      .copyString(WhimsyClaudeReplay.logText(run));
    const status = $("whimsy-replay-status");
    document.l10n.setAttributes(status, "whimsy-replay-copied");
    window.browsingContext.topChromeWindow?.gZenUIManager?.showToast?.("whimsy-replay-copied");
  });

  $("whimsy-replay-delete").addEventListener("click", async () => {
    if (run) {
      await WhimsyClaudeReplay.deleteRun(run.id);
    }
  });

  $("whimsy-replay-clear").addEventListener("click", async () => {
    await WhimsyClaudeReplay.clear();
  });

  const observer = () => load(run?.id);
  Services.obs.addObserver(observer, "whimsy-claude-replay-changed");
  window.addEventListener("unload", () => Services.obs.removeObserver(observer, "whimsy-claude-replay-changed"));

  await load();
})();
