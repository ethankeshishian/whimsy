/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

const DEFAULT_DELAY_MS = 1500;

function handleRequest(request, response) {
  let delay = DEFAULT_DELAY_MS;
  const match = /(?:^|&)delay=(\d+)/.exec(request.queryString);
  if (match) {
    delay = parseInt(match[1], 10);
  }
  const replace = /(?:^|&)replace=([^&]+)/.exec(request.queryString);
  response.processAsync();
  response.setHeader("Content-Type", "text/html", false);
  response.setHeader("Cache-Control", "no-cache", false);
  response.write("<!DOCTYPE html><title>slow load</title><p>loading</p>");
  if (replace) {
    response.write(
      `<script>addEventListener("load", () => location.replace(decodeURIComponent("${replace[1]}")));</script>`
    );
  }
  setTimeout(() => {
    response.write("<p>done</p>");
    response.finish();
  }, delay);
}
