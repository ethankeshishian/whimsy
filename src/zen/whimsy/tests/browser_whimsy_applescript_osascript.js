/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// W30 AppleScript, for real: osascript talks to this very app (by its
// path, never an installed Whimsy) through Whimsy.sdef and the Cocoa
// classes in applescript/. osascript runs as a separate process
// (Subprocess), so this process keeps answering Apple events while the
// test waits for it.
//
// macOS asks the app that ran the tests (its terminal, say) for the
// Automation permission to control Whimsy. Until someone answers that
// prompt, the event is held and osascript gives up with -1712; once
// it's refused, -1743. Neither reaches Whimsy, so the test checks, with
// a first event, that Whimsy itself was asked: if it wasn't and macOS
// held the event, there's nothing to test and it says how to allow it.
// Allow it in System Settings → Privacy & Security → Automation.

const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
const { WhimsyScripting } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyScripting.sys.mjs");

const PAGE = "https://example.com/document-builder.sjs?html=" + encodeURIComponent("<title>Scripted C</title>C");

// macOS errors for an event it held back: timed out (the consent prompt
// is still up), not permitted, would need consent.
const HELD = ["(-1712)", "(-1743)", "(-1744)"];

function appPath() {
  // .../Whimsy.app/Contents/MacOS/<binary>
  let file = Services.dirsvc.get("XREExeF", Ci.nsIFile);
  for (let i = 0; i < 3; i++) {
    file = file.parent;
  }
  return file.path;
}

async function osascript(lines, seconds = 30) {
  const app = appPath().replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const script = [`with timeout of ${seconds} seconds`, `tell application "${app}"`, ...lines, `end tell`, `end timeout`];
  const process = await Subprocess.call({
    command: "/usr/bin/osascript",
    arguments: script.flatMap(line => ["-e", line]),
    stderr: "pipe",
  });
  const read = async pipe => {
    let text = "";
    let chunk;
    while ((chunk = await pipe.readString())) {
      text += chunk;
    }
    return text;
  };
  // Both pipes at once, so a full one never stalls the other.
  const [stdout, stderr] = await Promise.all([read(process.stdout), read(process.stderr)]);
  const { exitCode } = await process.wait();
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

// Runs `fn` and says whether any script call reached this process's
// WhimsyScripting (every call goes through check()).
async function reachesWhimsy(fn) {
  let calls = 0;
  const real = WhimsyScripting.check;
  WhimsyScripting.check = function () {
    calls++;
    return real.call(this);
  };
  try {
    const result = await fn();
    return { result, reached: calls > 0 };
  } finally {
    WhimsyScripting.check = real;
  }
}

add_task(async function test_osascript_drives_whimsy() {
  requestLongerTimeout(2);

  const { result: probe, reached } = await reachesWhimsy(() => osascript([`return count of windows`], 15));
  if (!reached && probe.exitCode != 0 && HELD.some(code => probe.stderr.includes(code))) {
    todo(
      false,
      `macOS held the Apple event before it reached Whimsy (${probe.stderr}): the app running the tests ` +
        "needs Automation permission for Whimsy (System Settings → Privacy & Security → Automation)"
    );
    return;
  }
  ok(reached, `The script reached this Whimsy: ${probe.stderr}`);
  is(probe.exitCode, 0, `count of windows ran: ${probe.stderr}`);
  is(Number(probe.stdout), WhimsyScripting.windows().length, "It counts the windows a script can see");

  // The tabs a script sees: Zen's empty tab isn't one of them.
  const count = WhimsyScripting.tabsOf(window).length;
  let tab = null;
  try {
    const made = await osascript([
      `set w to window 1`,
      `set t to make new tab at end of tabs of w with properties {URL:"${PAGE}"}`,
      `return (id of t) & "|" & (mode of w) & "|" & ((count of tabs of w) as text)`,
    ]);
    is(made.exitCode, 0, `make new tab ran: ${made.stderr}`);
    const [id, mode] = made.stdout.split("|");
    ok(id, "It answered with the tab's id");
    is(mode, "normal", "mode");
    is(WhimsyScripting.tabsOf(window).length, count + 1, "A tab was made");
    tab = id ? WhimsyScripting.findTab(id) : null;
    is(tab, gBrowser.selectedTab, "And selected");
    // The page may have finished loading while osascript was answering.
    await TestUtils.waitForCondition(
      () => tab.linkedBrowser.currentURI.spec == PAGE && !tab.hasAttribute("busy"),
      "It loads the URL"
    );

    const read = await osascript([`set t to tab id "${id}" of window 1`, `return (URL of t) & "|" & (title of t)`]);
    is(read.stdout, `${PAGE}|Scripted C`, "URL and title read back");

    const refused = await osascript([`set URL of tab id "${id}" of window 1 to "file:///etc/passwd"`]);
    isnot(refused.exitCode, 0, "set URL to a file: address fails");
    ok(/http, https, and about:blank/.test(refused.stderr), `With the reason: ${refused.stderr}`);
    is(tab.linkedBrowser.currentURI.spec, PAGE, "And the tab stayed put");

    const noScript = await osascript([`execute tab id "${id}" of window 1 javascript "1"`]);
    isnot(noScript.exitCode, 0, "There's no execute javascript");

    const closed = await osascript([`close tab id "${id}" of window 1`]);
    is(closed.exitCode, 0, `close ran: ${closed.stderr}`);
    await TestUtils.waitForCondition(() => !tab.isConnected, "The tab closed");

    await SpecialPowers.pushPrefEnv({ set: [["whimsy.feature.applescript", false]] });
    try {
      const off = await osascript([`return count of windows`]);
      isnot(off.exitCode, 0, "With the switch off, scripting fails");
      ok(/turned off/.test(off.stderr), `Saying so: ${off.stderr}`);
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  } finally {
    if (tab?.isConnected) {
      BrowserTestUtils.removeTab(tab);
    }
  }
});
