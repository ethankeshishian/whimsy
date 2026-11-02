/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// wave7/spaceanim: space switches play one at a time (Arc).
//
// In Arc a space-switch slide always finishes before the next one starts,
// so a fast trackpad swipe or a burst of Opt+Cmd+Right lands cleanly, one
// whole slide at a time. Zen instead snaps the slide in flight to its end
// (ZenSpaceManager#changeWorkspace calls complete() on its animations) and
// starts the next from there, and drops a trackpad swipe that begins while
// a slide is still playing (ZenSpacesSwipe returns early while
// isChangingWorkspace), which on a trackpad reads as stutter.
//
// This wraps gZenWorkspaces.changeWorkspace, the function every switch
// goes through (click, shortcut, swipe, wheel, command line), so a switch
// asked for while one is playing waits for it instead of cutting it short:
// - clicks and keyboard switches coalesce: a burst ends on the last space
//   asked for, in one slide from wherever the current slide lands;
// - trackpad swipes step: each swipe is one more space, one full slide each;
// - with reduced motion everything coalesces (no slides to step through).
// changeWorkspaceShortcut is wrapped so next/previous count from where the
// queue will land, not from the space the slide is still heading to. A
// swipe that starts during a slide is claimed (so it can't fall through to
// page back/forward) and queued as a step when the fingers lift.
//
// Durations and curves are Zen's own; nothing here animates.

const FEATURE_PREF = "whimsy.feature.space-switch-queue";
// W10-03 (Arc): Next Space past the last space makes a new space; Previous
// Space stops at the first. Zen's wrap-around setting went round to the
// other end instead.
const EDGES_PREF = "whimsy.feature.space-edges";
const EDGE_COMMANDS = { cmd_zenWorkspaceForward: 1, cmd_zenWorkspaceBackward: -1 };
const START_EVENT = "WhimsySpaceSwitchStart";
const END_EVENT = "WhimsySpaceSwitchEnd";
// The same thresholds ZenSpacesSwipe gives the swipe tracker for a space swipe.
const SWIPE_SUCCESS_THRESHOLD = 0.25;
const SWIPE_VELOCITY_CONTRIBUTION = 0.5;
const GESTURE_EVENTS = [
  "MozSwipeGestureMayStart",
  "MozSwipeGestureStart",
  "MozSwipeGestureUpdate",
  "MozSwipeGesture",
  "MozSwipeGestureEnd",
];

const states = new WeakMap();

function featureOn() {
  return Services.prefs.getBoolPref(FEATURE_PREF, true);
}

function reduceMotion(win) {
  try {
    // browser.js's gReduceMotion follows the OS setting and its test override.
    if (typeof win.gReduceMotion == "boolean") {
      return win.gReduceMotion;
    }
    return win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) {
    return false;
  }
}

// Only these options mean "just go there"; anything else (onInit,
// alwaysChange, ...) is an internal switch that must run as asked.
const PLAIN_KEYS = new Set(["whileScrolling", "whimsyStep"]);

function readOptions(args) {
  const opts = args[0] && typeof args[0] == "object" ? args[0] : null;
  const plain = !opts || Object.keys(opts).every(key => PLAIN_KEYS.has(key));
  return { opts, plain, step: !!opts?.whimsyStep };
}

export const WhimsySpaceSwitchQueue = {
  START_EVENT,
  END_EVENT,

  get enabled() {
    return featureOn();
  },

  initWindow(win) {
    const spaces = win.gZenWorkspaces;
    if (!spaces?.workspaceEnabled || states.has(win)) {
      return;
    }
    const state = {
      running: false,
      // uuid of the space the playing slide is heading to.
      target: null,
      // Callers waiting for the playing switch (a burst that came back to it).
      currentWaiters: [],
      // { workspace, args, plain, step, waiters: [{ resolve, reject }] }
      pending: [],
      deferredGesture: false,
      // Highest number of switches seen running at once (tests).
      maxConcurrent: 0,
      concurrent: 0,
    };
    states.set(win, state);
    this.wrapChangeWorkspace(win, state);
    this.wrapShortcut(win, state);
    this.initEdges(win, state);
    this.initSwitcherArrows(win, state);
    this.wrapEdgeSwipes(win);
    const onGesture = event => this.handleGesture(win, state, event);
    for (const type of GESTURE_EVENTS) {
      win.addEventListener(type, onGesture, true);
    }
    win.addEventListener(
      "unload",
      () => {
        for (const type of GESTURE_EVENTS) {
          win.removeEventListener(type, onGesture, true);
        }
      },
      { once: true }
    );
  },

  /** Whether a space switch is playing in this window. */
  isSwitching(win) {
    return !!states.get(win)?.running;
  },

  /** Test hooks: queue length, deferred gesture, overlap high-water mark. */
  debugState(win) {
    const state = states.get(win);
    return state
      ? {
          running: state.running,
          target: state.target,
          pending: state.pending.map(entry => entry.workspace.uuid),
          deferredGesture: state.deferredGesture,
          maxConcurrent: state.maxConcurrent,
        }
      : null;
  },

  /** Where the window will be once every queued switch has played. */
  projectedTarget(win) {
    const state = states.get(win);
    const last = state?.pending.at(-1);
    return last?.workspace.uuid ?? (state?.running ? state.target : null) ?? win.gZenWorkspaces.activeWorkspace;
  },

  wrapChangeWorkspace(win, state) {
    const spaces = win.gZenWorkspaces;
    const original = spaces.changeWorkspace;
    if (typeof original != "function" || original._whimsySwitchQueue) {
      return;
    }
    const self = this;
    const wrapped = function (workspace, ...args) {
      if (!featureOn() || !workspace) {
        return original.call(this, workspace, ...args);
      }
      if (!state.running) {
        return self.run(win, state, original, this, workspace, args);
      }
      return self.enqueue(win, state, workspace, args);
    };
    wrapped._whimsySwitchQueue = true;
    spaces.changeWorkspace = wrapped;
  },

  wrapShortcut(win, state) {
    const spaces = win.gZenWorkspaces;
    const original = spaces.changeWorkspaceShortcut;
    if (typeof original != "function" || original._whimsySwitchQueue) {
      return;
    }
    const self = this;
    const wrapped = function (offset = 1, whileScrolling = false, disableWrap = false) {
      return self.stepRelative(win, state, offset, { whileScrolling, disableWrap });
    };
    wrapped._whimsySwitchQueue = true;
    spaces.changeWorkspaceShortcut = wrapped;
  },

  get edgesEnabled() {
    return Services.prefs.getBoolPref(EDGES_PREF, true);
  },

  initEdges(win, state) {
    const { document } = win;
    document.addEventListener(
      "command",
      event => {
        state.edgeCommand = EDGE_COMMANDS[event.target.id] ?? 0;
      },
      true
    );
    document.addEventListener("command", () => {
      state.edgeCommand = 0;
    });
  },

  /**
   * One shared helper for relative space stepping across all paths:
   * - keyboard Next/Previous commands (cmd_zenWorkspaceForward/Backward)
   * - swipe and scroll gestures (ZenSpacesSwipe, trackpad bursts, sidebar wheel)
   * - space switcher arrows (ArrowLeft/Right/Up/Down on #zen-workspaces-button)
   *
   * Skips hidden spaces (W11-16) and enforces Arc edge behavior (W10-03):
   * - Left past the first visible space stops at the first (never wraps).
   * - Right past the last visible space opens New Space when settled, or
   *   stops at the last space in the middle of a burst (never wraps).
   * - When edgesEnabled is false, wraps across visible spaces.
   */
  stepRelative(win, state, offset = 1, options = {}) {
    const spaces = win.gZenWorkspaces;
    if (!spaces?.workspaceEnabled || spaces.privateWindowOrDisabled) {
      return null;
    }
    const workspaces = spaces.getWorkspaces?.() ?? [];
    if (!workspaces.length) {
      return null;
    }
    // Skip hidden spaces (W11-16).
    const visible = workspaces.filter(space => !space.whimsyHidden);
    if (!visible.length) {
      return null;
    }

    const fromId = this.projectedTarget(win);
    let from = visible.findIndex(space => space.uuid == fromId);
    if (from < 0) {
      from = Math.max(0, visible.findIndex(space => space.uuid == spaces.activeWorkspace));
    }

    // When the edges feature is disabled, wrap across visible spaces.
    if (!this.edgesEnabled) {
      let targetIndex = from + offset;
      if (spaces.shouldWrapAroundNavigation && !options.disableWrap) {
        targetIndex = ((targetIndex % visible.length) + visible.length) % visible.length;
      } else {
        targetIndex = Math.max(0, Math.min(visible.length - 1, targetIndex));
      }
      return spaces.changeWorkspace(visible[targetIndex], {
        whileScrolling: false,
        whimsyStep: !!options.whileScrolling,
      });
    }

    const to = from + offset;
    // Left edge rule: stops at the first visible space, never wraps.
    if (to < 0) {
      if (options.isSwitcherArrow) {
        const icons = win.document.getElementById("zen-workspaces-button");
        icons?.querySelector(`toolbarbutton[zen-workspace-id="${visible[0].uuid}"]`)?.focus();
      }
      return state?.running ? Promise.resolve(visible[0]) : null;
    }

    // Right edge rule: past the last space makes a new space if settled,
    // or stops at the last space in the middle of a burst. Never wraps.
    if (to >= visible.length) {
      const creating = win.document.documentElement.hasAttribute("zen-creating-workspace");
      if (state?.running || creating || spaces.creatingWorkspaceId || spaces.privateWindowOrDisabled) {
        return state?.running ? Promise.resolve(visible.at(-1)) : null;
      }
      return spaces.openWorkspaceCreation();
    }

    // Step between visible spaces. A step back to the slide that's playing
    // goes through the queue too, which then drops what was queued after it.
    const targetSpace = visible[to];
    if (to == from) {
      return Promise.resolve(targetSpace);
    }

    const promise = spaces.changeWorkspace(targetSpace, {
      whileScrolling: false,
      whimsyStep: !!options.whileScrolling,
    });
    if (options.isSwitcherArrow) {
      const icons = win.document.getElementById("zen-workspaces-button");
      icons?.querySelector(`toolbarbutton[zen-workspace-id="${targetSpace.uuid}"]`)?.focus();
    }
    return promise;
  },

  stepFromEdge(win, state, offset) {
    return this.stepRelative(win, state, offset);
  },

  initSwitcherArrows(win, state) {
    const icons = win.document.getElementById("zen-workspaces-button");
    if (!icons) {
      return;
    }
    const onKeyDown = event => {
      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) {
        return;
      }
      if (event.target.tagName == "input" || event.target.tagName == "textarea") {
        return;
      }
      const isRTL = win.document.documentElement.matches(":-moz-locale-dir(rtl)");
      let offset = 0;
      if (event.key == "ArrowRight" || event.key == "ArrowDown") {
        offset = isRTL && event.key == "ArrowRight" ? -1 : 1;
      } else if (event.key == "ArrowLeft" || event.key == "ArrowUp") {
        offset = isRTL && event.key == "ArrowLeft" ? 1 : -1;
      }
      if (!offset) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.stepRelative(win, state, offset, { isSwitcherArrow: true });
    };
    icons.addEventListener("keydown", onKeyDown);
    win.addEventListener(
      "unload",
      () => icons.removeEventListener("keydown", onKeyDown),
      { once: true }
    );
  },

  // W11-16: a swipe at the edge of the VISIBLE spaces offers what Zen
  // offers at the edge of all of them: New Space past the last, the Library
  // past the first (on the side it sits). Zen asks ZenSpaceAddSwipe and
  // ZenLibrary, which count every space, hidden ones included, so with a
  // hidden space at an end the edge action never came. Zen loads both per
  // window (ChromeUtils.importESModule with global "current"), so the
  // window's own instances are the ones wrapped: importing them from here
  // would give this module's separate copies.
  wrapEdgeSwipes(win) {
    const visibleIndex = ws => {
      const visible = ws.getWorkspaces().filter(space => !space.whimsyHidden);
      const current = ws.getActiveWorkspaceFromCache?.() ?? ws.getActiveWorkspace?.();
      return { visible, index: visible.findIndex(space => space.uuid == current?.uuid) };
    };
    const load = url => {
      try {
        return win.ChromeUtils.importESModule(url, { global: "current" });
      } catch (e) {
        console.error("Whimsy: space edges", url, e);
        return {};
      }
    };
    const { ZenLibrary } = load("moz-src:///zen/library/ZenLibrary.mjs");
    const { ZenSpaceAddSwipe } = load("resource:///modules/zen/ZenSpaceAddSwipe.mjs");
    const library = () => {
      try {
        return !!ZenLibrary?.libraryOnRight;
      } catch (e) {
        return false;
      }
    };
    const proto = ZenSpaceAddSwipe?.prototype;
    if (typeof proto?.readySwipeAddSpace == "function" && !proto.readySwipeAddSpace._whimsyVisible) {
      const original = proto.readySwipeAddSpace;
      proto.readySwipeAddSpace = function () {
        const ws = win.gZenWorkspaces;
        if (!ws || !featureOn()) {
          return original.apply(this, arguments);
        }
        const { visible, index } = visibleIndex(ws);
        return index == (library() ? 0 : visible.length - 1) &&
          Services.prefs.getBoolPref("zen.library.enabled", false) &&
          !!ws.shouldSwipeEdgeActions && !ws.creatingWorkspaceId;
      };
      proto.readySwipeAddSpace._whimsyVisible = true;
    }
    if (typeof ZenLibrary?.readySwipeOpenLibrary == "function" && !ZenLibrary.readySwipeOpenLibrary._whimsyVisible) {
      const original = ZenLibrary.readySwipeOpenLibrary;
      ZenLibrary.readySwipeOpenLibrary = function () {
        const ws = win.gZenWorkspaces;
        if (!ws || !featureOn()) {
          return original.apply(this, arguments);
        }
        const { visible, index } = visibleIndex(ws);
        return index == (library() ? visible.length - 1 : 0) &&
          Services.prefs.getBoolPref("zen.library.enabled", false) && !!ws.shouldSwipeEdgeActions;
      };
      ZenLibrary.readySwipeOpenLibrary._whimsyVisible = true;
    }
  },

  async run(win, state, original, context, workspace, args) {
    const { opts } = readOptions(args);
    if (opts && "whimsyStep" in opts) {
      const rest = { ...opts };
      delete rest.whimsyStep;
      args = [rest, ...args.slice(1)];
    }
    state.running = true;
    state.target = workspace.uuid;
    state.concurrent++;
    state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
    win.dispatchEvent(new win.CustomEvent(START_EVENT, { detail: { uuid: workspace.uuid } }));
    try {
      return await original.call(context, workspace, ...args);
    } finally {
      state.concurrent--;
      state.running = false;
      state.target = null;
      const waiters = state.currentWaiters.splice(0);
      waiters.forEach(waiter => waiter.resolve(workspace));
      win.dispatchEvent(new win.CustomEvent(END_EVENT, { detail: { uuid: workspace.uuid } }));
      this.drain(win, state, original, context);
    }
  },

  // Starts the next queued switch in the same tick the last one finished,
  // so nothing else can slip in between.
  drain(win, state, original, context) {
    const next = state.pending.shift();
    if (!next) {
      return;
    }
    this.run(win, state, original, context, next.workspace, next.args).then(
      result => next.waiters.forEach(waiter => waiter.resolve(result)),
      error => next.waiters.forEach(waiter => waiter.reject(error))
    );
  },

  enqueue(win, state, workspace, args) {
    const { opts, plain, step } = readOptions(args);
    // The strip is at rest by the time a queued switch plays.
    if (opts?.whileScrolling) {
      args = [{ ...opts, whileScrolling: false }, ...args.slice(1)];
    }
    const coalesce = plain && (!step || reduceMotion(win));
    const { promise, resolve, reject } = Promise.withResolvers();
    const last = state.pending.at(-1);
    if (coalesce && (!last || last.coalesce)) {
      if (last) {
        state.pending.pop();
      }
      const waiters = [...(last?.waiters ?? []), { resolve, reject }];
      const before = state.pending.at(-1);
      if (workspace.uuid == (before?.workspace.uuid ?? state.target)) {
        // Back to where the queue already lands: nothing more to play.
        (before?.waiters ?? state.currentWaiters).push(...waiters);
        return promise;
      }
      state.pending.push({ workspace, args, coalesce: true, waiters });
      return promise;
    }
    state.pending.push({ workspace, args, coalesce, waiters: [{ resolve, reject }] });
    return promise;
  },

  handleGesture(win, state, event) {
    if (!featureOn()) {
      return;
    }
    const spaces = win.gZenWorkspaces;
    if (event.type == "MozSwipeGestureMayStart") {
      state.deferredGesture = false;
      if (
        !state.running ||
        spaces.privateWindowOrDisabled ||
        !win.gNavToolbox?.contains(event.target) ||
        event.target.closest?.('#urlbar[zen-floating-urlbar="true"], #zen-workspaces-button, #zen-library-download-list') ||
        (event.direction != event.DIRECTION_LEFT && event.direction != event.DIRECTION_RIGHT)
      ) {
        return;
      }
      // Claim it, so it doesn't turn into page back/forward, and hold it
      // until the slide that's playing has finished.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      event.allowedDirections |= event.DIRECTION_LEFT | event.DIRECTION_RIGHT;
      state.deferredGesture = true;
      return;
    }
    if (!state.deferredGesture) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    switch (event.type) {
      case "MozSwipeGestureStart":
      case "MozSwipeGestureUpdate":
        if ("swipeSuccessThreshold" in event) {
          event.swipeSuccessThreshold = SWIPE_SUCCESS_THRESHOLD;
          event.swipeSuccessVelocityContribution = SWIPE_VELOCITY_CONTRIBUTION;
        }
        break;
      case "MozSwipeGesture": {
        // Same direction rules as ZenSpacesSwipe.
        const isRTL = win.document.documentElement.matches(":-moz-locale-dir(rtl)");
        const moveForward = (event.direction == event.DIRECTION_RIGHT) !== isRTL;
        const offset = (moveForward ? 1 : -1) * (spaces.naturalScroll ? -1 : 1);
        // A swipe begun mid-slide never wraps either (W10-03): at an edge
        // Zen gives the swipe to the Library or a new space, never the
        // space at the other end.
        spaces.changeWorkspaceShortcut(offset, true, true)?.catch?.(console.error);
        break;
      }
      case "MozSwipeGestureEnd":
        state.deferredGesture = false;
        break;
    }
  },
};
