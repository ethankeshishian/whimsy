/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The browser side of Whimsy's updater (whimsy/updater/updater.py). The
// updater runs as two launchd jobs and keeps its state in
// ~/Library/Application Support/Whimsy Updater:
//   state.json    written by the updater: what's installed, staged, previous
//   control.json  written here: paused, rollback requests
//   logs/update.log
// Each Whimsy.app also carries Contents/Resources/whimsy-version.json
// (whimsy/version.py): its Whimsy version, Zen base and version history.
// The browser never installs anything itself; it only reads state and asks.

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
});

const SEEN_PREF = "whimsy.updates.seen-install";
const CHANNEL_PREF = "whimsy.update-channel";
const UPDATE_JOB = "app.whimsy.updater";
const APPLY_JOB = "app.whimsy.applier";

export const WhimsyUpdates = {
  // Overridable for tests.
  dataDir: null,
  versionFile: null,

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

  // This app's Whimsy version, like { version: "1.24b-w3", zen: "1.24b",
  // history: [...] }. A build that never went through staging or publishing
  // (running from the build folder) has no file: it's a dev build of Zen's version.
  async readVersion() {
    const file =
      this.versionFile ??
      PathUtils.join(Services.dirsvc.get("GreD", Ci.nsIFile).path, "whimsy-version.json");
    try {
      const info = await IOUtils.readJSON(file);
      if (info?.version) {
        return { history: [], ...info };
      }
    } catch {}
    return {
      version: `${Services.appinfo.version}-dev`,
      zen: Services.appinfo.version,
      firefox: Services.appinfo.platformVersion,
      released: false,
      history: [],
    };
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

  // Whether this Mac runs the local updater (whimsy/updater/install.sh).
  // Synchronous: the update channel is applied at profile-after-change.
  isInstalled() {
    const plist = Services.dirsvc.get("Home", Ci.nsIFile);
    for (const part of ["Library", "LaunchAgents", `${UPDATE_JOB}.plist`]) {
      plist.append(part);
    }
    return plist.exists();
  },

  get channel() {
    return Services.prefs.getStringPref(CHANNEL_PREF, "release") == "dev" ? "dev" : "release";
  },

  // Points Firefox's updater at the chosen channel's update.xml
  // (.../updates/browser/<target>/<channel>/update.xml, from %CHANNEL% in the
  // update URL). Both channels use the same signing key and MAR channel. A
  // Mac that builds Whimsy installs its own builds (whimsy/updater), so
  // Firefox's updater gets a channel with no updates there; the local
  // updater reads the choice from control.json.
  //
  // Runs from WhimsyStartup at profile-after-change, before
  // UpdateServiceStub's entry (category entries start in name order). Firefox
  // stamps each downloaded update with app.update.channel and, at startup,
  // marks it failed if the channel differs ("Install Failed" plus a
  // re-download), so the Dev choice must be in place before that check.
  initChannel() {
    if (this._channelInit) {
      return;
    }
    this._channelInit = true;
    Services.prefs.addObserver(CHANNEL_PREF, () => this.applyChannel());
    this.applyChannel();
  },

  applyChannel() {
    const local = this.isInstalled();
    // macOS locks the channel at startup (from ChannelPrefs.framework).
    Services.prefs.unlockPref("app.update.channel");
    Services.prefs.getDefaultBranch("").setCharPref("app.update.channel", local ? "local" : this.channel);
    Services.prefs.lockPref("app.update.channel");
    if (local) {
      this.writeControl({ channel: this.channel }).catch(e =>
        console.error("Whimsy: update channel", e)
      );
    }
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
    if (!seen) {
      return null;
    }
    const { version, zen, notes_url } = await this.readVersion();
    return { ...installed, version, zen, notes_url };
  },

  showUpdatedNotice(win) {
    Services.scriptloader.loadSubScript("chrome://browser/content/whimsy/whimsy-window.js", win);
    win.WhimsyWindow.showUpdatedNotice();
  },
};
