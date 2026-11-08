/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23: a stand-in for downloads.claude.ai/claude-code-releases. The test
// stores files with ?put=<path>&b64=<base64>; ?path=<path> serves them.

function param(query, name) {
  for (const part of query.split("&")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at) == name) {
      return decodeURIComponent(part.slice(at + 1));
    }
  }
  return null;
}

function handleRequest(request, response) {
  response.setHeader("Cache-Control", "no-store", false);
  const query = request.queryString;
  const put = param(query, "put");
  if (put) {
    setState("whimsy-cc:" + put, param(query, "b64") || "");
    response.setHeader("Content-Type", "text/plain", false);
    response.write("ok");
    return;
  }
  const stored = getState("whimsy-cc:" + (param(query, "path") || ""));
  if (!stored) {
    response.setStatusLine(request.httpVersion, 404, "Not Found");
    return;
  }
  response.setHeader("Content-Type", "application/octet-stream", false);
  response.write(atob(stored));
}
