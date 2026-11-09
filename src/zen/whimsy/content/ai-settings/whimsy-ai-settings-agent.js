/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// W23 agent-chat: Settings › AI › Agent (the mode new chats start in, and
// the pauses that can't be turned off), Outside agents (apps on this Mac that
// use your tabs through Whimsy's MCP server), and Activity (every run, by day).

/* globals WhimsyAISettings */

(() => {
  const S = WhimsyAISettings;
  const MODE_PREF = "whimsy.ai.agent.mode";
  const OUTSIDE_PREF = "whimsy.ai.outside-agents";
  const OWN_SPACE_PREF = "whimsy.ai.outside-agents.own-space";
  const KEEP_PREF = "whimsy.claude.replay";
  const DAYS_PREF = "whimsy.ai.activity.days";
  const ICONS = "chrome://browser/content/whimsy/icons/";
  const ZEN = "chrome://browser/skin/zen-icons/";
  const PAUSES = ["money", "send", "delete", "settings", "submit", "new-site", "download", "sign-in"];

  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    WhimsyClaude: "resource:///modules/whimsy/WhimsyClaude.sys.mjs",
    WhimsyClaudeReplay: "resource:///modules/whimsy/WhimsyClaudeReplay.sys.mjs",
    WhimsyOutsideAgents: "resource:///modules/whimsy/WhimsyOutsideAgents.sys.mjs",
  });

  const item = (parent, { icon, name, nameArgs, detail, detailArgs, tone } = {}) => {
    const row = S.el("div", "whimsy-ai-item", parent);
    if (icon) {
      S.tile(row, icon, { tone });
    }
    const text = S.el("span", "whimsy-ai-item-text", row);
    if (name) {
      S.el("span", "whimsy-ai-item-name", text, name, nameArgs);
    }
    if (detail) {
      S.el("span", "whimsy-ai-item-detail", text, detail, detailArgs);
    }
    return row;
  };

  const prefToggle = (row, id, pref, fallback) => {
    const toggle = S.el("moz-toggle", "", row);
    toggle.id = id;
    toggle.setAttribute("aria-labelledby", row.querySelector(".whimsy-ai-item-name").id = `${id}Label`);
    const update = () => (toggle.pressed = Services.prefs.getBoolPref(pref, fallback));
    toggle.addEventListener("toggle", () => Services.prefs.setBoolPref(pref, toggle.pressed));
    Services.prefs.addObserver(pref, update);
    update();
    return () => Services.prefs.removeObserver(pref, update);
  };

  // A segmented choice: click, or ← → while it has focus.
  const segment = (parent, id, choices, current, onPick) => {
    const seg = S.el("div", "whimsy-ai-seg whimsy-ai-agent-seg", parent);
    seg.id = id;
    seg.setAttribute("role", "radiogroup");
    seg.style.setProperty("--count", String(choices.length));
    S.el("span", "whimsy-ai-seg-thumb", seg);
    const buttons = choices.map(([value, l10nId]) => {
      const b = S.el("button", "", seg, l10nId);
      b.type = "button";
      b.dataset.value = value;
      b.setAttribute("role", "radio");
      b.addEventListener("click", () => onPick(value));
      return b;
    });
    const sync = value => {
      const index = Math.max(0, choices.findIndex(([v]) => v == value));
      seg.style.setProperty("--index", String(index));
      buttons.forEach((b, i) => {
        b.setAttribute("aria-checked", String(i == index));
        b.tabIndex = i == index ? 0 : -1;
      });
    };
    seg.addEventListener("keydown", event => {
      if (event.key != "ArrowLeft" && event.key != "ArrowRight") {
        return;
      }
      event.preventDefault();
      const index = buttons.findIndex(b => b.getAttribute("aria-checked") == "true");
      const rtl = getComputedStyle(seg).direction == "rtl";
      const step = (event.key == "ArrowRight") != rtl ? 1 : -1;
      const next = buttons[(index + step + buttons.length) % buttons.length];
      onPick(next.dataset.value);
      next.focus();
    });
    sync(current);
    return { seg, sync };
  };

  // ---- Agent (set-8.3) ----

  S.register({
    id: "agent",
    order: 550,
    jumpL10nId: "whimsy-ai-jump-agent",
    headingL10nId: "whimsy-ai-agent-heading",
    descL10nId: "whimsy-ai-agent-desc",
    build(container) {
      const list = S.el("div", "whimsy-ai-list", container);
      const row = item(list, { icon: `${ZEN}sparkles.svg`, name: "whimsy-ai-agent-mode", detail: "whimsy-ai-agent-mode-detail" });
      const mode = () => (Services.prefs.getStringPref(MODE_PREF, "drive") == "background" ? "background" : "drive");
      const { seg, sync } = segment(row, "whimsyAIAgentMode", [["drive", "whimsy-ai-agent-mode-drive"], ["background", "whimsy-ai-agent-mode-background"]], mode(), value =>
        Services.prefs.setStringPref(MODE_PREF, value)
      );
      seg.setAttribute("aria-labelledby", (row.querySelector(".whimsy-ai-item-name").id = "whimsyAIAgentModeLabel"));
      const onMode = () => sync(mode());
      Services.prefs.addObserver(MODE_PREF, onMode);

      S.el("h3", "whimsy-ai-agent-sublabel", container, "whimsy-ai-agent-pauses-label");
      const guard = S.el("div", "whimsy-ai-list", container);
      guard.id = "whimsyAIAgentPauses";
      const head = item(guard, { icon: `${ZEN}tracking-protection.svg`, name: "whimsy-ai-agent-pauses-title", detail: "whimsy-ai-agent-pauses-detail", tone: "warn" });
      head.classList.add("whimsy-ai-agent-guard");
      S.el("span", "whimsy-ai-pill", head, "whimsy-ai-agent-always-on");
      const bullets = S.el("ul", "whimsy-ai-agent-bullets", head.querySelector(".whimsy-ai-item-text"));
      for (const id of PAUSES) {
        S.el("li", "", bullets, `whimsy-ai-agent-pause-${id}`);
      }
      item(guard, { icon: `${ZEN}help.svg`, name: "whimsy-ai-agent-unsure", detail: "whimsy-ai-agent-unsure-detail" });
      return () => Services.prefs.removeObserver(MODE_PREF, onMode);
    },
  });

  // ---- Outside agents (fu-settings 8.2) ----

  const ago = t => {
    const minutes = Math.round((Date.now() - t) / 60000);
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    if (minutes < 60) {
      return rtf.format(-minutes, "minute");
    }
    if (minutes < 60 * 24) {
      return rtf.format(-Math.round(minutes / 60), "hour");
    }
    return rtf.format(-Math.round(minutes / 1440), "day");
  };

  S.register({
    id: "outside-agents",
    order: 600,
    jumpL10nId: "whimsy-ai-jump-outside-agents",
    headingL10nId: "whimsy-ai-outside-heading",
    descL10nId: "whimsy-ai-outside-desc",
    build(container, ctx) {
      const cleanups = [];
      const list = S.el("div", "whimsy-ai-list", container);
      list.id = "whimsyAIOutsideList";
      const on = item(list, { icon: `${ICONS}agent.svg`, name: "whimsy-ai-outside-enable", detail: "whimsy-ai-outside-enable-detail" });
      cleanups.push(prefToggle(on, "whimsyAIOutsideEnable", OUTSIDE_PREF, false));
      const apps = S.el("div", "whimsy-ai-agent-apps", list);
      apps.id = "whimsyAIOutsideApps";
      const connected = new Set();

      // Another app…: the command and JSON to add Whimsy by hand.
      const another = item(list, { icon: `${ZEN}plus.svg`, name: "whimsy-ai-outside-another", detail: "whimsy-ai-outside-another-detail" });
      another.id = "whimsyAIOutsideAnother";
      another.classList.add("is-button");
      another.tabIndex = 0;
      another.setAttribute("role", "button");
      another.setAttribute("aria-expanded", "false");
      S.el("span", "whimsy-ai-agent-chevron", another).setAttribute("aria-hidden", "true");
      const body = S.el("div", "whimsy-ai-agent-another", list);
      body.id = "whimsyAIOutsideAnotherBody";
      body.hidden = true;
      S.el("p", "whimsy-ai-item-detail", body, "whimsy-ai-outside-another-intro");
      const command = S.el("pre", "whimsy-ai-code", body);
      command.id = "whimsyAIOutsideCommand";
      command.tabIndex = 0;
      S.el("p", "whimsy-ai-item-detail", body, "whimsy-ai-outside-json-intro");
      const json = S.el("pre", "whimsy-ai-code", body);
      json.id = "whimsyAIOutsideJSON";
      json.tabIndex = 0;
      const buttons = S.el("div", "whimsy-ai-agent-buttons", body);
      const copy = text => {
        if (text) {
          Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(text);
          ctx.toast("whimsy-ai-outside-copied");
        }
      };
      S.button(buttons, "whimsy-ai-outside-copy-command", { small: true, id: "whimsyAIOutsideCopyCommand", onClick: () => copy(lazy.WhimsyOutsideAgents.connectInfo()?.command) });
      S.button(buttons, "whimsy-ai-outside-copy-json", { small: true, id: "whimsyAIOutsideCopyJSON", onClick: () => copy(lazy.WhimsyOutsideAgents.connectInfo()?.json) });
      const status = S.el("span", "whimsy-ai-item-detail whimsy-ai-agent-status", buttons);
      status.id = "whimsyAIOutsideStatus";
      status.setAttribute("role", "status");
      const newKey = S.button(buttons, "whimsy-ai-outside-new-key", { small: true, kind: "text", id: "whimsyAIOutsideNewKey" });
      S.el("p", "whimsy-ai-item-detail", body, "whimsy-ai-outside-new-key-note");
      newKey.addEventListener("click", () =>
        ctx.confirmStrip(newKey.parentElement, {
          titleL10nId: "whimsy-ai-outside-new-key-confirm",
          textL10nId: "whimsy-ai-outside-new-key-note",
          okL10nId: "whimsy-ai-outside-new-key",
          restoreFocus: newKey,
          onConfirm: async () => {
            try {
              await lazy.WhimsyClaude.regenerateToken();
              document.l10n.setAttributes(status, "whimsy-claude-new-token-note");
            } catch (e) {
              console.error("Whimsy: new key", e);
              document.l10n.setAttributes(status, "whimsy-claude-token-error");
            }
            fill();
          },
        })
      );
      const fill = () => {
        const info = lazy.WhimsyOutsideAgents.connectInfo();
        command.textContent = info?.command ?? "";
        json.textContent = info?.json ?? "";
      };
      const toggleAnother = () => {
        const open = another.getAttribute("aria-expanded") != "true";
        another.setAttribute("aria-expanded", String(open));
        body.hidden = !open;
        if (open) {
          fill();
          S.unfold(body);
        }
      };
      another.addEventListener("click", toggleAnother);
      another.addEventListener("keydown", event => {
        if (event.key == "Enter" || event.key == " ") {
          event.preventDefault();
          toggleAnother();
        }
      });

      const own = item(list, { icon: `${ICONS}task-folder.svg`, name: "whimsy-ai-outside-own-space", detail: "whimsy-ai-outside-own-space-detail" });
      cleanups.push(prefToggle(own, "whimsyAIOutsideOwnSpace", OWN_SPACE_PREF, false));

      // Apps that connected, then apps found here that can.
      let token = 0;
      const render = async () => {
        const mine = ++token;
        const enabled = Services.prefs.getBoolPref(OUTSIDE_PREF, false);
        for (const node of [apps, another, own]) {
          node.hidden = !enabled;
        }
        body.hidden ||= !enabled;
        if (!enabled) {
          another.setAttribute("aria-expanded", "false");
          body.hidden = true;
          return;
        }
        const [known, found] = await Promise.all([lazy.WhimsyOutsideAgents.apps(), lazy.WhimsyOutsideAgents.detect().catch(() => [])]);
        if (mine != token) {
          return;
        }
        const rows = known.map(a => ({ id: a.id, name: a.name, lastUsed: a.lastUsed, listed: true }));
        for (const f of found) {
          if (!rows.some(r => r.id == f.id || r.name == f.name)) {
            rows.push({ id: f.id, name: f.name, found: true });
          }
        }
        apps.replaceChildren();
        for (const app of rows) {
          const isConnected = app.listed || connected.has(app.id);
          const row = item(apps, {
            icon: S.logo(app.id == "claude-code" || app.id == "claude-desktop" ? "claude" : app.id),
            detail: app.lastUsed ? "whimsy-ai-outside-last-used" : isConnected ? "whimsy-ai-outside-connected" : "whimsy-ai-outside-found",
            detailArgs: app.lastUsed ? { when: ago(app.lastUsed) } : undefined,
          });
          row.dataset.app = app.id;
          const name = S.el("span", "whimsy-ai-item-name", null);
          name.textContent = app.name;
          row.querySelector(".whimsy-ai-item-text").prepend(name);
          if (isConnected) {
            S.button(row, "whimsy-ai-outside-remove", {
              small: true,
              kind: "text",
              onClick: () => lazy.WhimsyOutsideAgents.remove(app.id).then(() => connected.delete(app.id) && render()),
            }).dataset.action = "remove";
          } else {
            const connect = S.button(row, "whimsy-ai-outside-connect", { small: true });
            connect.dataset.action = "connect";
            connect.addEventListener("click", async () => {
              connect.disabled = true;
              try {
                await lazy.WhimsyOutsideAgents.connect(app.id);
                connected.add(app.id);
                ctx.toast("whimsy-ai-outside-connected-toast", { args: { app: app.name } });
              } catch (e) {
                console.error("Whimsy: connect", e);
                ctx.toast("whimsy-ai-outside-connect-failed", { args: { app: app.name } });
              }
              render();
            });
          }
        }
      };
      const changed = () => render();
      // The server starts after the pref flips; refill the command when it's up.
      const serverChanged = () => {
        if (!body.hidden) {
          fill();
        }
      };
      Services.prefs.addObserver(OUTSIDE_PREF, changed);
      Services.obs.addObserver(changed, "whimsy-outside-agents-changed");
      Services.obs.addObserver(serverChanged, "whimsy-claude-changed");
      cleanups.push(() => {
        Services.prefs.removeObserver(OUTSIDE_PREF, changed);
        Services.obs.removeObserver(changed, "whimsy-outside-agents-changed");
        Services.obs.removeObserver(serverChanged, "whimsy-claude-changed");
      });
      // Settings may open before any browser window started the module.
      lazy.WhimsyClaude.init();
      render();
      return () => cleanups.forEach(fn => fn());
    },
  });

  // ---- Activity (set-9.1, set-9.3, fu-settings 9.5) ----

  S.register({
    id: "activity",
    order: 700,
    jumpL10nId: "whimsy-ai-jump-activity",
    headingL10nId: "whimsy-ai-activity-heading",
    descL10nId: "whimsy-ai-activity-desc",
    build(container, ctx) {
      let filter = "all";
      const bar = S.el("div", "whimsy-ai-agent-bar", container);
      const { sync: syncFilter } = segment(bar, "whimsyAIActivityFilter", [["all", "whimsy-ai-activity-all"], ["whimsy", "whimsy-ai-activity-whimsy"], ["outside", "whimsy-ai-activity-outside"]], filter, value => {
        filter = value;
        syncFilter(value);
        render();
      });
      // Delete all…: asks in place, below the bar. Off (not gone) with no runs.
      const deleteAll = S.button(bar, "whimsy-ai-activity-delete-all", { small: true, kind: "text", id: "whimsyAIActivityDeleteAll" });
      deleteAll.addEventListener("click", () =>
        ctx.confirmStrip(bar, {
          titleL10nId: "whimsy-ai-activity-delete-all-title",
          textL10nId: "whimsy-ai-activity-delete-all-text",
          okL10nId: "whimsy-ai-activity-delete-all-ok",
          restoreFocus: deleteAll,
          onConfirm: () => lazy.WhimsyClaudeReplay.clear(),
        })
      );
      const days = S.el("div", "whimsy-ai-list", container);
      days.id = "whimsyAIActivityRuns";
      const settings = S.el("div", "whimsy-ai-list", container);
      const keep = item(settings, { icon: `${ICONS}mask.svg`, name: "whimsy-ai-activity-keep", detail: "whimsy-ai-activity-keep-detail" });
      const offKeep = prefToggle(keep, "whimsyAIActivityKeep", KEEP_PREF, true);
      const howLong = item(settings, { icon: `${ICONS}clock.svg`, name: "whimsy-ai-activity-days" });
      const current = () => String(lazy.WhimsyClaudeReplay.retentionDays);
      const { seg: daysSeg, sync: syncDays } = segment(
        howLong,
        "whimsyAIActivityDays",
        lazy.WhimsyClaudeReplay.RETENTION_CHOICES.map(d => [String(d), `whimsy-ai-activity-days-${d || "forever"}`]),
        current(),
        value => (lazy.WhimsyClaudeReplay.retentionDays = Number(value))
      );
      daysSeg.setAttribute("aria-labelledby", (howLong.querySelector(".whimsy-ai-item-name").id = "whimsyAIActivityDaysLabel"));
      const onDays = () => syncDays(current());
      Services.prefs.addObserver(DAYS_PREF, onDays);

      const dayName = t => {
        const start = new Date(t).setHours(0, 0, 0, 0);
        const today = new Date().setHours(0, 0, 0, 0);
        const diff = Math.round((today - start) / 86400000);
        return diff < 2
          ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-diff, "day").replace(/^./, c => c.toUpperCase())
          : new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" }).format(t);
      };
      let token = 0;
      const render = async () => {
        const mine = ++token;
        const every = await lazy.WhimsyClaudeReplay.runs();
        const runs = every.filter(r => filter == "all" || (r.client ?? "outside") == filter).sort((a, b) => b.start - a.start);
        if (mine != token) {
          return;
        }
        days.replaceChildren();
        days.classList.toggle("is-grouped", !!runs.length);
        deleteAll.disabled = !every.length;
        if (!runs.length) {
          item(days, { icon: `${ZEN}sparkles.svg`, name: "whimsy-ai-activity-empty", detail: "whimsy-ai-activity-empty-detail" }).id = "whimsyAIActivityEmpty";
          return;
        }
        let group = null;
        let label = "";
        for (const run of runs) {
          if (dayName(run.start) != label) {
            label = dayName(run.start);
            S.el("h3", "whimsy-ai-agent-sublabel", days).textContent = label;
            group = S.el("div", "whimsy-ai-list", days);
          }
          const outside = (run.client ?? "outside") != "whimsy";
          const row = item(group, {
            icon: outside ? S.logo("claude") : `${ZEN}sparkles.svg`,
            detail: outside ? "whimsy-ai-activity-run-outside" : "whimsy-ai-activity-run-whimsy",
            detailArgs: { app: run.clientName || "", count: run.steps.length },
          });
          row.dataset.run = run.id;
          row.classList.add("is-button");
          const name = S.el("span", "whimsy-ai-item-name", null);
          name.textContent = run.title || run.steps.at(-1)?.title || run.clientName || "";
          row.querySelector(".whimsy-ai-item-text").prepend(name);
          const del = S.el("button", "whimsy-ai-agent-icon-btn", row, "whimsy-ai-activity-delete");
          del.type = "button";
          del.dataset.action = "delete";
          del.style.setProperty("--icon", `url("${ZEN}trash.svg")`);
          del.addEventListener("click", event => {
            event.stopPropagation();
            ctx.confirmStrip(row, {
              titleL10nId: "whimsy-ai-activity-delete-title",
              textL10nId: "whimsy-ai-activity-delete-text",
              okL10nId: "whimsy-ai-activity-delete-ok",
              restoreFocus: del,
              onConfirm: () => lazy.WhimsyClaudeReplay.deleteRun(run.id),
            });
          });
          S.el("span", "whimsy-ai-agent-chevron is-end", row).setAttribute("aria-hidden", "true");
          row.tabIndex = 0;
          row.setAttribute("role", "link");
          const open = () => S.browserWindow()?.openTrustedLinkIn(`about:whimsy?replay&run=${encodeURIComponent(run.id)}`, "tab");
          row.addEventListener("click", open);
          row.addEventListener("keydown", event => event.key == "Enter" && event.target == row && open());
        }
      };
      const changed = () => render();
      Services.obs.addObserver(changed, "whimsy-claude-replay-changed");
      render();
      return () => {
        offKeep();
        Services.prefs.removeObserver(DAYS_PREF, onDays);
        Services.obs.removeObserver(changed, "whimsy-claude-replay-changed");
      };
    },
  });
})();
