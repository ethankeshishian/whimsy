/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// W30 AppleScript, for real: osascript talks to this very app (by its
// path, never an installed Whimsy) through Whimsy.sdef and the Cocoa
// classes in applescript/. Needs a real window and, the first time, the
// Automation permission for whatever runs the tests (System Settings →
// Privacy & Security → Automation); without it macOS answers -1743.

const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

const PAGE = "https://example.com/document-builder.sjs?html=" + encodeURIComponent("<title>Scripted C</title>C");

function appPath() {
  // .../Whimsy.app/Contents/MacOS/<binary>
  let file = Services.dirsvc.get("XREExeF", Ci.nsIFile);
  for (let i = 0; i < 3; i++) {
    file = file.parent;
  }
  return file.path;
}

async function osascript(lines) {
  const app = appPath().replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const script = [`with timeout of 30 seconds`, `tell application "${app}"`, ...lines, `end tell`, `end timeout`];
  const process = await Subprocess.call({
    command: "/usr/bin/osascript",
    arguments: script.flatMap(line => ["-e", line]),
    stderr: "pipe",
  });
  let stdout = "";
  let stderr = "";
  let chunk;
  while ((chunk = await process.stdout.readString())) {
    stdout += chunk;
  }
  while ((chunk = await process.stderr.readString())) {
    stderr += chunk;
  }
  const { exitCode } = await process.wait();
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

add_task(async function test_osascript_drives_whimsy() {
  const count = gBrowser.tabs.length;
  const made = await osascript([
    `set w to window 1`,
    `set t to make new tab at end of tabs of w with properties {URL:"${PAGE}"}`,
    `return (id of t) & "|" & (mode of w) & "|" & ((count of tabs of w) as text)`,
  ]);
  if (made.stderr.includes("-1743")) {
    ok(false, "Allow Automation for the test runner in System Settings → Privacy & Security → Automation");
    return;
  }
  is(made.exitCode, 0, `make new tab ran: ${made.stderr}`);
  const [id, mode] = made.stdout.split("|");
  ok(id, "It answered with the tab's id");
  is(mode, "normal", "mode");
  is(gBrowser.tabs.length, count + 1, "A tab was made");
  const tab = gBrowser.selectedTab;
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, PAGE);

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
});
