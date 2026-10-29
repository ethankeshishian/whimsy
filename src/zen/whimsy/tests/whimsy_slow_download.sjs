/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// batch7: a download that stays "in progress" for a bit, for the Dock
// badge test (WhimsyDownloads).

const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

function handleRequest(request, response) {
  response.processAsync();
  response.setHeader("Content-Type", "application/octet-stream", false);
  response.setHeader("Content-Disposition", "attachment; filename=whimsy-slow.bin", false);
  response.setHeader("Cache-Control", "no-cache", false);
  response.write("whimsy");
  setTimeout(() => response.finish(), 1200);
}
