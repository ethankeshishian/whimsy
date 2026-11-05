/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W16-7: a stand-in captive-portal page. ?body=match answers what
// captivedetect.canonicalContent expects; anything else, another body.

function handleRequest(request, response) {
  response.setHeader("Content-Type", "text/html", false);
  response.setHeader("Cache-Control", "no-store", false);
  const match = /(?:^|&)body=match(?:&|$)/.test(request.queryString);
  response.write(match ? "<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>\n" : "<p>Sign in to the Wi-Fi</p>");
}
