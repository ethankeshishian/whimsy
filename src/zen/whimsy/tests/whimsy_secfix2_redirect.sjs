/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 secfix2 P2-H1: an open redirect to another site (example.org).
function handleRequest(request, response) {
  const dir = request.path.replace(/[^/]*$/, "");
  response.setStatusLine(request.httpVersion, 302, "Found");
  response.setHeader("Location", `https://example.org${dir}whimsy_secfix_inject.html`, false);
}
