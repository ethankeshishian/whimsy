/* Any copyright is dedicated to the Public Domain. */
// W13-R1: a service worker that controls the page. It passes the page's own
// requests through (sw-fetch) and saves for the page when asked (sw-message).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
// ?queue: an offline-first save, answered here and sent later (never now):
// only the page's own request shows the site saved.
self.addEventListener("fetch", event =>
  event.respondWith(event.request.url.includes("?queue") ? new Response("queued") : fetch(event.request))
);
self.addEventListener("message", event => {
  event.waitUntil(
    fetch("whimsy_form_save.sjs?save", { method: "POST", body: event.data.save }).then(() => event.source.postMessage("saved"))
  );
});
