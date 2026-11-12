/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

// browser_whimsy_reader_rebind.js: a page with one subresource, and a
// redirect to it.
function handleRequest(request, response) {
  const query = request.queryString;
  if (query == "redirect") {
    response.setStatusLine(request.httpVersion, 302, "Found");
    response.setHeader("Location", "whimsy_reader_rebind.sjs?page", false);
    return;
  }
  response.setHeader("Cache-Control", "no-store", false);
  if (query == "sub") {
    response.setHeader("Content-Type", "text/css", false);
    response.write("p { color: green; }");
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8", false);
  response.write(
    `<!doctype html><title>Rebind</title><link rel="stylesheet" href="whimsy_reader_rebind.sjs?sub"><p>Readable text for the reader.</p>`
  );
}
