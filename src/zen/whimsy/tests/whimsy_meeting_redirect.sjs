/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

// W26: a call site's join link that redirects to its web client (as
// zoom.us/j/… goes on to app.zoom.us/wc/…/join).
function handleRequest(request, response) {
  response.setStatusLine(request.httpVersion, 302, "Found");
  response.setHeader("Location", "whimsy_call_captions.html?client", false);
  response.setHeader("Cache-Control", "no-store", false);
}
