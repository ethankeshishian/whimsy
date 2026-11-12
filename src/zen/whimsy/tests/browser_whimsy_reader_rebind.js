/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Anonymous reads (previews nobody asked for) check the address each
// request actually connects to, not just the name: a public name that
// resolves to a private address (DNS rebinding) is refused for the page,
// its redirects, and its subresources. The test server sits behind a
// proxy, so a stand-in decides which requests "connected privately".

const { WhimsyAIReader } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIReader.sys.mjs");

const BASE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = BASE + "whimsy_reader_rebind.sjs?page";
const SUB = BASE + "whimsy_reader_rebind.sjs?sub";
const REDIRECT = BASE + "whimsy_reader_rebind.sjs?redirect";

// Every request the stand-in sees; those matching `isPrivate` are treated
// as having connected to a private address.
function standIn(isPrivate) {
  const seen = [];
  const original = WhimsyAIReader.connectedPublicly;
  WhimsyAIReader.connectedPublicly = function (request) {
    const spec = request.QueryInterface(Ci.nsIChannel).URI.spec;
    seen.push(spec);
    return !isPrivate(spec);
  };
  registerCleanupFunction(() => (WhimsyAIReader.connectedPublicly = original));
  return {
    seen,
    restore() {
      WhimsyAIReader.connectedPublicly = original;
    },
  };
}

add_task(async function addresses() {
  for (const ip of ["127.0.0.1", "10.0.0.2", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", ""]) {
    ok(!WhimsyAIReader.isPublicAddress(ip), `${ip || "(none)"} is not public`);
  }
  for (const ip of ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"]) {
    ok(WhimsyAIReader.isPublicAddress(ip), `${ip} is public`);
  }
});

add_task(async function public_connections_read() {
  const stand = standIn(() => false);
  const result = await WhimsyAIReader.readUrl(PAGE, { anonymous: true });
  stand.restore();
  ok(result.text.includes("Readable text"), "The page is read");
  ok(stand.seen.includes(PAGE), "The page's connection is checked");
  ok(stand.seen.includes(SUB), "Its subresource's connection is checked");
});

add_task(async function private_page_is_refused() {
  const stand = standIn(spec => spec == PAGE);
  await Assert.rejects(WhimsyAIReader.readUrl(PAGE, { anonymous: true }), /didn't load/, "A page that connected privately isn't read");
  stand.restore();
});

add_task(async function private_redirect_target_is_refused() {
  const stand = standIn(spec => spec == PAGE);
  await Assert.rejects(WhimsyAIReader.readUrl(REDIRECT, { anonymous: true }), /didn't load/, "A redirect to a private connection isn't read");
  stand.restore();
  ok(stand.seen.includes(REDIRECT) && stand.seen.includes(PAGE), "Both the redirect and its target are checked");
});

add_task(async function private_subresource_is_refused() {
  const stand = standIn(spec => spec == SUB);
  const result = await WhimsyAIReader.readUrl(PAGE, { anonymous: true });
  stand.restore();
  ok(result.text.includes("Readable text"), "The page itself still reads");
  ok(stand.seen.includes(SUB), "The subresource was stopped at its connection");
});

// Reads the person asked for (Watch a page) may be on their own network.
add_task(async function asked_for_reads_are_not_guarded() {
  const stand = standIn(() => true);
  const result = await WhimsyAIReader.readUrl(PAGE, {});
  stand.restore();
  ok(result.text.includes("Readable text"), "The page is read");
  is(stand.seen.length, 0, "No connection is checked");
});
