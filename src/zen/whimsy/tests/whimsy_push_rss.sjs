/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

// A tiny feed server for testing "Push" refresh's conditional GET. Content
// has a version; the ETag is derived from it, and a real conditional GET
// (If-None-Match matching the current ETag) gets a 304 with no body.
// `?count` reports how many times the real (non-304) body was served, so
// a test can tell a cheap conditional hit apart from a real re-fetch.
// `?bump` changes the content so the next conditional GET sees a change.

function handleRequest(request, response) {
  const state = JSON.parse(getState("push") || '{"version":1,"fullFetches":0}');
  const save = () => setState("push", JSON.stringify(state));
  response.setHeader("Cache-Control", "no-store", false);
  const query = request.queryString;

  if (query === "count") {
    response.setHeader("Content-Type", "text/plain", false);
    response.write(String(state.fullFetches));
    return;
  }

  if (query === "bump") {
    state.version++;
    save();
    response.setStatusLine(request.httpVersion, 204, "No Content");
    return;
  }

  const etag = `"v${state.version}"`;
  let ifNoneMatch = null;
  try {
    ifNoneMatch = request.getHeader("If-None-Match");
  } catch {
    ifNoneMatch = null;
  }

  response.setHeader("ETag", etag, false);

  if (ifNoneMatch === etag) {
    response.setStatusLine(request.httpVersion, 304, "Not Modified");
    return;
  }

  if (request.method !== "HEAD") {
    state.fullFetches++;
    save();
  }
  response.setHeader("Content-Type", "application/rss+xml", false);
  response.write(
    `<?xml version="1.0"?><rss version="2.0"><channel><title>Push test feed</title>` +
      `<item><title>Item v${state.version}</title>` +
      `<link>https://example.com/item-${state.version}</link>` +
      `<guid>item-${state.version}</guid>` +
      `<pubDate>${new Date().toUTCString()}</pubDate></item>` +
      `</channel></rss>`
  );
}
