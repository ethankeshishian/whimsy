/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W26 (owner: "a lot of 'Couldn't describe this page'"): every way a hover
// card's description can fail, one fixture each. A passing failure is tried
// once more; a page that can't be read is described from its address,
// title, link text, and summary; an answer in any shape models really send
// is read; a hover that was let go isn't a failure. "Couldn't describe this
// page" shows only at a real dead end. No real network or AI: the page
// fetch, the reader, and the provider are stand-ins.

const { WhimsyHoverCards } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyHoverCards.sys.mjs");
const { WhimsyAIProviders, WhimsyAIError } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyAIReader } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIReader.sys.mjs");
const { WhimsyAIPage, parseDescriptionReply } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIPage.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_ai_page.html";
const DESCRIPTION = "Planning notes for the Lisbon offsite on March 14.";
const POINTS = ["The offsite is in Lisbon.", "The espresso machine costs $129.", "The budget is still open."];
const PAGE_TEXT = "The offsite is on March 14 in Lisbon. ".repeat(12);
const META_SUMMARY = "Notes from the planning meeting, kept by the team.";

let asked = [];
let answer;
let readText;
let tagsHtml;
let n = 0;

const good = () => JSON.stringify({ title: "Planning notes", description: DESCRIPTION, points: POINTS });
const fail = code => {
  throw new WhimsyAIError(code);
};

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.hover-cards", true],
      ["whimsy.ai.enabled", true],
    ],
  });
  Services.obs.notifyObservers(null, "whimsy-ai-store-cleared");
  WhimsyAIProviders.setTestProvider(request => {
    asked.push(request);
    return answer(request, asked.length);
  });
  WhimsyAIReader.setTestReader(() => readText());
  WhimsyHoverCards.setTestFetcher(async (_url, { kind }) => {
    if (kind == "image") {
      throw new Error("No image");
    }
    return { text: tagsHtml };
  });
  registerCleanupFunction(() => {
    WhimsyAIProviders.setTestProvider(null);
    WhimsyAIReader.setTestReader(null);
    WhimsyHoverCards.setTestFetcher(null);
    WhimsyAIProviders.clearResting("test");
  });
});

function reset() {
  asked = [];
  answer = good;
  readText = () => PAGE_TEXT;
  tagsHtml = `<html><head><title>Quarterly planning</title><meta name="description" content="${META_SUMMARY}"></head></html>`;
  WhimsyAIProviders.clearResting("test");
}

// A link's card for a page not described before, built as WhimsyLinkHover
// builds it.
function linkCard(title = "Planning link") {
  const controller = new AbortController();
  const url = `${PAGE}?w26-${++n}`;
  const card = WhimsyHoverCards.linkCard(window, {
    url,
    title,
    browser: gBrowser.selectedBrowser,
    controller,
    ai: true,
  });
  return { card, controller, url };
}

// Waits for the description's place to settle: text or a note.
async function settled(card) {
  await TestUtils.waitForCondition(
    () => card.querySelector(".whimsy-hc-desc.is-text, .whimsy-hc-desc.is-note"),
    "The description's place settled"
  );
  const text = card.querySelector(".whimsy-hc-desc.is-text");
  return {
    text: text?.textContent ?? null,
    note: card.querySelector(".whimsy-hc-desc.is-note")?.dataset.note ?? null,
    points: [...card.querySelectorAll("ul.whimsy-hc-points > li")].map(li => li.textContent),
  };
}

const described = request => /hover card/.test(request.system);

// JSON's quotes as curly ones, opening and closing in turn.
function curly(text) {
  let open = true;
  return text.replace(/"/g, () => ((open = !open) ? "\u201d" : "\u201c"));
}

// ---- The answer's shape ----

add_task(function parser_reads_what_models_send() {
  const want = { title: "Planning notes", description: DESCRIPTION, points: POINTS };
  const json = good();
  const cases = [
    ["bare JSON", json, want],
    // What Apple's on-device model sends (seen on the owner's Mac).
    ["a code fence", "```json\n" + JSON.stringify(want, null, 2) + "\n```", want],
    ["prose around it", `Here is the JSON [as asked]:\n${json}\nHope that helps!`, want],
    ["trailing commas", json.replace(/\]\}$/, ",],}"), want],
    ["curly quotes", curly(json), want],
    ["missing bullets", JSON.stringify({ title: "Planning notes", description: DESCRIPTION }), { ...want, points: [] }],
    ["bullets as one string", JSON.stringify({ title: "Planning notes", description: DESCRIPTION, bullets: POINTS.map(p => `- ${p}`).join("\n") }), want],
    ["other field names", JSON.stringify({ Title: "Planning notes", summary: DESCRIPTION, key_points: POINTS.map(text => ({ text })) }), want],
    ["more than three bullets", JSON.stringify({ ...want, points: [...POINTS, "A fourth."] }), want],
    ["cut short", `\`\`\`json\n{"title": "Planning notes", "description": "${DESCRIPTION}", "points": ["${POINTS[0]}", "${POINTS[1]}", "The bud`, { ...want, points: POINTS.slice(0, 2) }],
    ["plain prose", `Title: Planning notes\nDescription: ${DESCRIPTION}\n- ${POINTS[0]}\n- ${POINTS[1]}\n- ${POINTS[2]}`, want],
    ["sentences and a numbered list", `${DESCRIPTION}\n\n1. ${POINTS[0]}\n2. ${POINTS[1]}\n3. ${POINTS[2]}`, { ...want, title: "" }],
  ];
  for (const [what, reply, expected] of cases) {
    Assert.deepEqual(parseDescriptionReply(reply), expected, what);
  }
  for (const [what, reply] of [
    ["empty", ""],
    ["an empty object", "{}"],
    ["no description", '{"title": "Planning notes", "points": ["a"]}'],
    ["a refusal", "I'm sorry, but I can't help with that."],
  ]) {
    is(parseDescriptionReply(reply), null, `${what}: nothing to show`);
  }
});

add_task(async function fenced_answer_shows_on_the_card() {
  reset();
  answer = () => "Sure! Here it is:\n```json\n" + good() + "\n```";
  const { card } = linkCard();
  const result = await settled(card);
  is(result.text, DESCRIPTION, "The description from a fenced answer");
  Assert.deepEqual(result.points, POINTS, "...with its bullets");
  is(asked.filter(described).length, 1, "One request");
});

add_task(async function missing_bullets_still_describe() {
  reset();
  answer = () => JSON.stringify({ description: DESCRIPTION });
  const { card } = linkCard();
  const result = await settled(card);
  is(result.text, DESCRIPTION, "Described");
  Assert.deepEqual(result.points, [], "...with no bullets rather than a failure");
});

// ---- Passing failures: tried once more ----

add_task(async function transient_errors_are_retried_once() {
  for (const code of ["network", "timeout", "unavailable", "failed", "bad-response"]) {
    reset();
    answer = (_request, count) => (count == 1 ? (code == "bad-response" ? "" : fail(code)) : good());
    const { card } = linkCard();
    const result = await settled(card);
    is(result.text, DESCRIPTION, `${code}: described on the second try`);
    is(asked.filter(described).length, 2, `${code}: two requests`);
    ok(!result.note, `${code}: no failure shown`);
  }
});

add_task(async function setup_errors_are_not_retried() {
  for (const code of ["no-key", "refused", "none-capable"]) {
    reset();
    answer = () => fail(code);
    const { card } = linkCard();
    const result = await settled(card);
    is(asked.filter(described).length, 1, `${code}: asked once`);
    is(result.text, META_SUMMARY, `${code}: the page's own summary stands in`);
  }
});

add_task(async function rate_limited_uses_the_page_summary() {
  reset();
  answer = () => fail("rate-limited");
  try {
    const { card } = linkCard();
    const result = await settled(card);
    is(result.text, META_SUMMARY, "Rate limited: the page's own summary");
    Assert.deepEqual(result.points, [], "...with no bullets");
    is(asked.filter(described).length, 1, "The provider is resting: not asked again");
    // Hovers while the provider rests ask nothing and still say something.
    const next = linkCard();
    is((await settled(next.card)).text, META_SUMMARY, "The next hover too");
    is(asked.filter(described).length, 1, "...without asking");
  } finally {
    WhimsyAIProviders.clearResting("test");
  }
});

// ---- Pages that can't be read ----

add_task(async function unreadable_link_is_described_from_what_is_known() {
  for (const [what, read] of [
    ["the load failed (blocked, redirected away, or timed out)", () => {
      throw new Error("The page didn't load (2152398878)");
    }],
    ["a sign-in wall with almost no text", () => "Sign in to continue"],
    ["no text at all", () => ""],
  ]) {
    reset();
    readText = read;
    const { card, url } = linkCard("Team planning notes");
    const result = await settled(card);
    is(result.text, DESCRIPTION, `${what}: still described`);
    const prompt = asked.find(described)?.prompt ?? "";
    ok(prompt.includes("couldn't be read"), `${what}: the model is told the page couldn't be read`);
    ok(prompt.includes(`Address: ${url}`), "...given the address");
    ok(prompt.includes("Page title: Quarterly planning"), "...the title from the page's tags");
    ok(prompt.includes("Link text: Team planning notes"), "...the link's text");
    ok(prompt.includes(META_SUMMARY), "...and the page's own summary");
  }
});

add_task(async function unreadable_tab_is_described_from_its_title() {
  reset();
  const { readTab } = WhimsyAIReader;
  WhimsyAIReader.readTab = async () => {
    throw new Error("No PageExtractor");
  };
  try {
    await BrowserTestUtils.withNewTab(PAGE + "?w26-tab", async () => {
      const found = await WhimsyAIPage.describeTab(gBrowser.selectedTab);
      is(found.description, DESCRIPTION, "A tab whose text can't be read is still described");
      const prompt = asked.find(described).prompt;
      ok(prompt.includes("couldn't be read") && prompt.includes("Page title:"), "...from its title and address");
    });
  } finally {
    WhimsyAIReader.readTab = readTab;
  }
});

// ---- Real dead ends ----

add_task(async function nothing_to_say_shows_the_failure() {
  reset();
  answer = () => fail("unavailable");
  tagsHtml = "<html><head><title>Quarterly planning</title></head></html>";
  const { card } = linkCard();
  const result = await settled(card);
  is(result.note, "failed", "No answer and no summary of its own: it couldn't be described");
  Assert.deepEqual(result.points, [], "...and no bullets");
  is(asked.filter(described).length, 2, "...after trying once more");
});

add_task(async function a_page_that_blocks_its_tags_too() {
  reset();
  answer = () => "{}";
  readText = () => {
    throw new Error("The page took too long to load");
  };
  WhimsyHoverCards.setTestFetcher(async () => {
    throw new Error("Not available");
  });
  try {
    const { card } = linkCard();
    const result = await settled(card);
    is(result.note, "failed", "No page, no tags, no answer: it couldn't be described");
  } finally {
    WhimsyHoverCards.setTestFetcher(async (_url, { kind }) => {
      if (kind == "image") {
        throw new Error("No image");
      }
      return { text: tagsHtml };
    });
  }
});

// ---- Hovers that were let go ----

add_task(async function a_cancelled_hover_is_not_a_failure() {
  reset();
  let release;
  const gate = new Promise(r => (release = r));
  answer = async () => {
    await gate;
    return fail("unavailable");
  };
  const { card, controller } = linkCard();
  await TestUtils.waitForCondition(() => asked.length == 1, "Asked");
  ok(card.querySelector(".whimsy-hc-desc.is-loading"), "Loading");
  controller.abort();
  release();
  // The card was let go: the request fails on, tried once more, and the
  // card says nothing about it.
  await TestUtils.waitForCondition(() => asked.length == 2, "The request went on to its retry");
  await TestUtils.waitForTick();
  ok(!card.querySelector(".whimsy-hc-desc.is-note"), "No failure note on a hover that was let go");

  // Directly: a caller that stops listening gets "aborted", never a failure.
  answer = () => new Promise(() => {});
  const stop = new AbortController();
  const pending = WhimsyAIPage.describe(`${PAGE}?w26-abort`, { anonymous: true, signal: stop.signal });
  await TestUtils.waitForCondition(() => asked.length == 3, "Asked again");
  stop.abort();
  await Assert.rejects(pending, error => error.code == "aborted", "Stopping is an abort");
  WhimsyHoverCards.describeFailed(window, card, new WhimsyAIError("aborted"), null);
  ok(!card.querySelector(".whimsy-hc-desc.is-note"), "An abort never shows the failure");
});

add_task(async function coming_back_picks_up_the_same_request() {
  reset();
  let release;
  const gate = new Promise(r => (release = r));
  answer = async () => {
    await gate;
    return good();
  };
  const url = `${PAGE}?w26-shared`;
  const first = new AbortController();
  const left = WhimsyAIPage.describe(url, { anonymous: true, signal: first.signal });
  await TestUtils.waitForCondition(() => asked.length == 1, "Asked");
  // The pointer leaves, then comes back to the same link.
  first.abort();
  await Assert.rejects(left, error => error.code == "aborted", "The first hover let go");
  const back = WhimsyAIPage.describe(url, { anonymous: true });
  release();
  is((await back).description, DESCRIPTION, "Coming back gets the answer");
  is(asked.filter(described).length, 1, "...from the one request");
});

// ---- Apple's on-device model ----

// Seen on the owner's Mac: after a burst of requests macOS refuses every
// one for several minutes (ModelManagerError 1013), and its guardrail
// refuses some pages outright. The first is a rate limit (the provider
// rests instead of being asked on every hover); the second isn't worth a
// second try.
add_task(async function apple_helper_failures() {
  if (Services.appinfo.OS != "Darwin") {
    ok(true, "macOS only");
    return;
  }
  const root = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "whimsy-fm-w26");
  const helper = PathUtils.join(root, "whimsy-fm-test");
  const descriptor = Object.getOwnPropertyDescriptor(WhimsyAIProviders, "_helperPath");
  Object.defineProperty(WhimsyAIProviders, "_helperPath", { get: () => helper, configurable: true });
  const run = async stderr => {
    await IOUtils.writeUTF8(helper, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${stderr}' >&2\nexit 1\n`);
    await IOUtils.setPermissions(helper, 0o755);
    try {
      await WhimsyAIProviders._apple({ prompt: "x", system: "", signal: new AbortController().signal });
    } catch (error) {
      return error;
    }
    return null;
  };
  try {
    WhimsyAIProviders._helperPromise = null;
    const throttled = await run(
      'Error Domain=FoundationModels.LanguageModelError Code=-1 "(com.apple.SensitiveContentAnalysisML error 15.)" "Error Domain=ModelManagerServices.ModelManagerError Code=1013"'
    );
    is(throttled?.code, "rate-limited", "macOS refusing after a burst is a rate limit");
    is(throttled?.detail, "", "...without the helper's raw error as the rest message");
    const unsafe = await run("May contain unsafe content");
    is(unsafe?.code, "failed", "The guardrail is a failure");
    is(unsafe?.transient, false, "...that isn't tried again");
    const other = await run("Something else went wrong");
    is(other?.code, "failed", "Anything else is a failure");
    isnot(other?.transient, false, "...worth one more try");
  } finally {
    Object.defineProperty(WhimsyAIProviders, "_helperPath", descriptor);
    WhimsyAIProviders._helperPromise = null;
    await IOUtils.remove(root, { recursive: true });
  }
});

add_task(async function a_guardrail_refusal_is_asked_once() {
  reset();
  answer = () => {
    throw Object.assign(new WhimsyAIError("failed", "May contain unsafe content"), { transient: false });
  };
  const { card } = linkCard();
  const result = await settled(card);
  is(asked.filter(described).length, 1, "Asked once");
  is(result.text, META_SUMMARY, "The page's own summary stands in");
});
