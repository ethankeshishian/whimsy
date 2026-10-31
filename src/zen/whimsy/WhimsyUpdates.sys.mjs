/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The browser side of Whimsy's updater (whimsy/updater/updater.py). The
// updater runs as two launchd jobs and keeps its state in
// ~/Library/Application Support/Whimsy Updater:
//   state.json    written by the updater: what's installed, staged, previous
//   control.json  written here: auto_install, rollback requests (never hold)
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
// Firefox's "Automatically install updates" (a plain pref on macOS).
const AUTO_PREF = "app.update.auto";
const UPDATE_JOB = "app.whimsy.updater";
const APPLY_JOB = "app.whimsy.applier";
// security-full-3 M3: the MAR channel check (acceptsMar).
const LEGACY_MAR_PREF = "whimsy.update.accept-legacy-mar-channel";
const LEGACY_MAR_CHANNEL = "release";
// Enough for the header, up to 8 signatures and the product information.
const MAR_HEADER_READ = 64 * 1024;

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
  // update URL). Both channels use the same signing key; each signs its MARs
  // with its own MAR channel ID (whimsy-release, whimsy-dev; publish.json),
  // and the signed product version is the build date, so Firefox's updater
  // never installs an older build than the one running. A
  // Mac that builds Whimsy installs its own builds (whimsy/updater), so
  // Firefox's updater gets a channel with no updates there; the local
  // updater reads the choice (and Firefox's install-automatically choice,
  // as auto_install) from control.json. `hold` there is the nightly
  // build-and-publish pause; it's set by hand and the browser never writes it.
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
    Services.prefs.addObserver(AUTO_PREF, () => this.applyChannel());
    this.applyChannel();
  },

  applyChannel() {
    const local = this.isInstalled();
    // macOS locks the channel at startup (from ChannelPrefs.framework).
    Services.prefs.unlockPref("app.update.channel");
    Services.prefs.getDefaultBranch("").setCharPref("app.update.channel", local ? "local" : this.channel);
    Services.prefs.lockPref("app.update.channel");
    if (local) {
      // Firefox's install-automatically choice only decides whether a staged
      // build installs by itself; it never pauses the nightly build/publish.
      const auto_install = Services.prefs.getBoolPref(AUTO_PREF, true);
      this.writeControl({ channel: this.channel, auto_install }).catch(e =>
        console.error("Whimsy: update channel", e)
      );
    }
  },

  // Which of Firefox's active updates to drop at startup
  // (whimsy-UpdateService-sys-mjs.patch, in UpdateService's #asyncInit):
  // any ready or downloading update for the running build or an older one
  // (`isOld`, Firefox's updateIsAtLeastAsOldAs with Whimsy's build-ID order),
  // whatever the update state. Otherwise an update carried over from an
  // earlier session is staged again over the build that's already running.
  // A "succeeded" ready update is the build that was just installed: Firefox's
  // post-update handling still needs it.
  staleActiveUpdates(status, { ready, downloading }, isOld) {
    const stale = [];
    if (ready && status != "succeeded" && isOld(ready)) {
      stale.push(ready);
    }
    if (downloading && isOld(downloading)) {
      stale.push(downloading);
    }
    return stale;
  },

  // An install only takes updates from its own channel (security-full-3 M3).
  // The compiled updater can't tell: both channels' IDs are compiled in, so
  // switching channel in Settings keeps working, and it only refuses older
  // builds. So Firefox's download check (whimsy-UpdateService-sys-mjs.patch,
  // Downloader._verifyDownload) asks here before a downloaded MAR is kept:
  // its signed channel ID must be whimsy-<the channel chosen in Settings>.
  // The pre-wave-9 shared ID "release" stays accepted while
  // whimsy.update.accept-legacy-mar-channel is on: publish.py signs every
  // MAR with it while mar_channel_bridge is on (older installs accept only
  // it), and those bridge builds are newer than any MAR signed before.
  // The updater binary checks the same signed header against the signature,
  // so this reads only what it will verify. Synchronous: _verifyDownload is.
  acceptsMar(path, channel = this.channel) {
    let info;
    try {
      info = this.readMarProductInfo(path);
    } catch (e) {
      console.warn("Whimsy: unreadable update MAR, refused", e);
      return false;
    }
    const accepted = [`whimsy-${channel}`];
    if (Services.prefs.getBoolPref(LEGACY_MAR_PREF, true)) {
      accepted.push(LEGACY_MAR_CHANNEL);
    }
    if (!info || !accepted.includes(info.channel)) {
      console.warn(`Whimsy: refused an update for MAR channel ${info?.channel} on the ${channel} channel`);
      return false;
    }
    return true;
  },

  // The product information block of a MAR (modules/libmar mar_read.c): the
  // signed channel ID and product version, or null if it has none.
  readMarProductInfo(path) {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    const size = Math.min(file.fileSize, MAR_HEADER_READ);
    const stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
    stream.init(file, -1, -1, 0);
    let bytes;
    try {
      const binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
      binary.setInputStream(stream);
      bytes = new Uint8Array(binary.readByteArray(size));
    } finally {
      stream.close();
    }
    return this.parseMarProductInfo(bytes);
  },

  parseMarProductInfo(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const need = (at, n) => {
      if (at + n > bytes.byteLength) {
        throw new Error("truncated MAR header");
      }
    };
    need(0, 4);
    if (String.fromCharCode(...bytes.subarray(0, 4)) != "MAR1") {
      throw new Error("not a MAR");
    }
    // MAR1, offset to index (u32), file size (u64), then the signatures.
    let at = 16;
    need(at, 4);
    const signatures = view.getUint32(at);
    at += 4;
    if (signatures > 8) {
      throw new Error("too many signatures");
    }
    for (let i = 0; i < signatures; i++) {
      need(at, 8);
      at += 8 + view.getUint32(at + 4); // algorithm id, length, signature
    }
    need(at, 4);
    const blocks = view.getUint32(at);
    at += 4;
    for (let i = 0; i < blocks && i < 16; i++) {
      need(at, 8);
      const blockSize = view.getUint32(at);
      const id = view.getUint32(at + 4);
      if (blockSize < 8 || blockSize - 8 > 96) {
        throw new Error("bad additional block");
      }
      if (id == 1) {
        need(at + 8, blockSize - 8);
        const data = bytes.subarray(at + 8, at + blockSize);
        const end = data.indexOf(0);
        const end2 = end < 0 ? -1 : data.indexOf(0, end + 1);
        if (end < 0 || end2 < 0) {
          throw new Error("bad product information block");
        }
        const text = b => String.fromCharCode(...b);
        return { channel: text(data.subarray(0, end)), version: text(data.subarray(end + 1, end2)) };
      }
      at += blockSize;
    }
    return null;
  },

  async setAutoInstall(auto_install) {
    await this.writeControl({ auto_install });
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

  // The browser is only a client: a check never builds or publishes. On a
  // Mac that builds Whimsy it installs an already-published build that the
  // local updater staged (when Whimsy is closed), nothing more.
  async checkNow() {
    await this.writeControl({ install_requested: new Date().toISOString() });
    return this.kick(APPLY_JOB);
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
