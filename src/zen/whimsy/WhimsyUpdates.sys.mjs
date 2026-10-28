/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The browser side of Whimsy's updater (whimsy/updater/updater.py). The
// updater runs as two launchd jobs and keeps its state in
// ~/Library/Application Support/Whimsy Updater:
//   state.json    written by the updater: what's installed, staged, previous
//   control.json  written here: paused, rollback requests
//   logs/update.log
// The browser never installs anything itself; it only reads state and asks.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
});

const SEEN_PREF = "whimsy.updates.seen-install";
const UPDATE_JOB = "app.whimsy.updater";
const APPLY_JOB = "app.whimsy.applier";

export const WhimsyUpdates = {
  // Overridable for tests.
  dataDir: null,

  get dir() {
    if (!this.dataDir) {
      const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
      this.dataDir = PathUtils.join(home, "Library", "Application Support", "Whimsy Updater");
    }
    return this.dataDir;
  },

  async readJSON(name, fallback) {
    try {
      return await IOUtils.readJSON(PathUtils.join(this.dir, name));
    } catch {
      return fallback;
    }
  },

  readState() {
    return this.readJSON("state.json", null);
  },

  readControl() {
    return this.readJSON("control.json", {});
  },

  async writeControl(changes) {
    const control = { ...(await this.readControl()), ...changes };
    await IOUtils.makeDirectory(this.dir, { ignoreExisting: true });
    const path = PathUtils.join(this.dir, "control.json");
    await IOUtils.writeJSON(path, control, { tmpPath: path + ".tmp" });
    return control;
  },

  async isInstalled() {
    const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
    return IOUtils.exists(
      PathUtils.join(home, "Library", "LaunchAgents", `${UPDATE_JOB}.plist`)
    );
  },

  async setPaused(paused) {
    await this.writeControl({ paused });
  },

  // Starts a launchd job now (it's a no-op if the job is already running).
  async kick(job) {
    try {
      const proc = await lazy.Subprocess.call({
        command: "/bin/sh",
        arguments: ["-c", `/bin/launchctl kickstart "gui/$(/usr/bin/id -u)/${job}"`],
      });
      const { exitCode } = await proc.wait();
      return exitCode == 0;
    } catch (e) {
      console.error("Whimsy: couldn't start", job, e);
      return false;
    }
  },

  async checkNow() {
    await this.writeControl({ check_requested: new Date().toISOString() });
    return this.kick(UPDATE_JOB);
  },

  // Rolling back swaps in the previous app, which needs Whimsy closed: the
  // applier job waits for this app to quit, swaps, and reopens it.
  async rollBack() {
    await this.writeControl({
      rollback: { requested_at: new Date().toISOString(), relaunch: true },
    });
    await this.kick(APPLY_JOB);
    Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
  },

  async readLog(maxLines = 400) {
    try {
      const text = await IOUtils.readUTF8(PathUtils.join(this.dir, "logs", "update.log"));
      return text.split("\n").slice(-maxLines).join("\n");
    } catch {
      return "";
    }
  },

  revealLog() {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(PathUtils.join(this.dir, "logs", "update.log"));
    if (file.exists()) {
      file.launch();
    }
  },

  // The notice to show once after an update or rollback was installed, or
  // null. The first run only records what's installed.
  async takeUpdatedNotice() {
    const state = await this.readState();
    // Installed from a published build (no local updater): the app's own
    // build ID changes with each update Firefox's updater installs.
    const installed = state?.installed?.id
      ? state.installed
      : { id: Services.appinfo.appBuildID, version: Services.appinfo.version };
    const seen = Services.prefs.getStringPref(SEEN_PREF, "");
    if (seen == installed.id) {
      return null;
    }
    Services.prefs.setStringPref(SEEN_PREF, installed.id);
    return seen ? installed : null;
  },

  showUpdatedNotice(win) {
    Services.scriptloader.loadSubScript("chrome://browser/content/whimsy/whimsy-window.js", win);
    win.WhimsyWindow.showUpdatedNotice();
  },
};
