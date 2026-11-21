/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 secfix2 (REVIEW-W23-PASS2.md): the "Go to <site>?" pause can't be
// routed around. P2-H1: an address carrying data pauses even on a visited
// site unless a page the task read supplied it; a redirect or link to a
// new site can't be read or used until the person says Go there; domains
// in a long pasted request aren't pre-approved.

const { WhimsyAI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAI.sys.mjs");
const { WhimsyClaude } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyClaude.sys.mjs");
const { WhimsyAgentTasks } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentTasks.sys.mjs");
const { WhimsyAgentGuard } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAgentGuard.sys.mjs");
const { WhimsyChatAgent } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatAgent.sys.mjs");

const ROOT = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com");
const PAGE = ROOT + "whimsy_secfix_inject.html";
const LINKS = ROOT + "whimsy_secfix2_links.html";

const textOf = result => result.content.filter(c => c.type == "text").map(c => c.text).join("\n");
const own = (task, name, args = {}) => WhimsyClaude.callTool(name, args, { taskId: task.id });
const waitForPause = (task, kind) =>
  TestUtils.waitForCondition(() => task.pause && !task.pause.choice && task.pause.kind == kind && task.pause, `The task pauses (${kind})`);
const uri = spec => Services.io.newURI(spec);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [["whimsy.ai.enabled", true], ["whimsy.feature.ai-hints", false]] });
  WhimsyAgentGuard._setTrustedSitesForTesting(null);
  WhimsyAgentGuard._setSiteKnownForTesting(() => true);
  registerCleanupFunction(async () => {
    WhimsyAgentGuard._setSiteKnownForTesting(null);
    WhimsyAgentTasks._resetForTesting();
    WhimsyClaude.shutdown();
    await WhimsyAI.pending;
  });
});

add_task(function same_site_data_sink_pauses() {
  // A task that started in Gmail: google.com is visited.
  const sites = new Set(["google.com"]);
  const form = "https://docs.google.com/forms/d/e/1FAIpQ/formResponse?entry.1=Re%3A%20your%20invoice%20and%20the%20bank%20code";
  const pause = WhimsyAgentGuard.navigation(uri(form), sites);
  is(pause?.kind, "navigate", "A Google Form address carrying data pauses, though google.com is visited");
  ok(pause.data, "and says it carries data");
  ok(pause.preview.fields.some(f => f.strong && /character/.test(f.value)), "in a strong Carries row");
  ok(!pause.preview.fields.some(f => f.note), "A visited site isn't called new to you");
  is(WhimsyAgentGuard.navigation(uri("https://mail.google.com/mail/u/0/#inbox"), sites)?.kind, "navigate", "Any fragment counts as data");
  const origins = new Set(["https://docs.google.com"]);
  is(WhimsyAgentGuard.navigation(uri("https://docs.google.com/forms/d/e/1FAIpQ/viewform"), sites, { origins }), null, "A plain address on a visited origin goes ahead");
  const links = new Set([form]);
  is(WhimsyAgentGuard.navigation(uri(form + "#top"), sites, { links, origins }), null, "The exact address a page supplied goes ahead (fragment aside)");
  is(WhimsyAgentGuard.navigation(uri(form + "x"), sites, { links, origins })?.kind, "navigate", "One more character pauses");
  ok(WhimsyAgentGuard.navigation(uri("https://evil.example/"), sites, { links: new Set(["https://evil.example/"]) }), "A new site pauses even when a page linked it");
  is(WhimsyAgentGuard.navigation(uri("https://evil.example/"), sites, { knownSite: true }).preview.fields[0].note, undefined, "Not new to you when the person has been there before today");
  ok(WhimsyAgentGuard.navigation(uri("https://evil.example/"), sites, { knownSite: false }).preview.fields[0].note, "New to you otherwise");
});

// W30 S2: the path and the host labels of an origin the task hasn't been to
// are places to smuggle what it read ("https://evil.example/<the secret>",
// "https://<the secret>.evil.example/"), so they count as data there.
add_task(function path_and_subdomain_of_a_new_origin_are_data() {
  const sites = new Set(["google.com"]);
  const origins = new Set(["https://mail.google.com"]);
  const secret = "Re-your-invoice-and-the-bank-code-4921";
  const carries = pause => pause?.preview.fields.find(f => f.strong)?.value ?? "";

  let pause = WhimsyAgentGuard.navigation(uri(`https://evil.example/${secret}`), sites, { origins });
  is(pause?.kind, "navigate", "A new site with a path pauses");
  ok(pause.data, "and the path counts as data");
  ok(carries(pause).startsWith(String(secret.length)), `${secret.length} characters of it`);

  pause = WhimsyAgentGuard.navigation(uri(`https://${secret}.evil.example/`), sites, { origins });
  ok(pause.data, "A host label in front of a new site counts as data");
  ok(carries(pause).startsWith(String(secret.length)), "all of it");
  ok(!WhimsyAgentGuard.navigation(uri("https://www.evil.example/"), sites, { origins }).data, "www isn't data");
  ok(!WhimsyAgentGuard.navigation(uri("https://evil.example/"), sites, { origins }).data, "nor is the root of a new site: that pause is only about the site");

  pause = WhimsyAgentGuard.navigation(uri(`https://docs.google.com/forms/d/e/${secret}/viewform`), sites, { origins });
  is(pause?.kind, "navigate", "A visited site, but an origin the task hasn't been to: a path pauses");
  ok(pause.data, "as data");
  ok(!pause.preview.fields.some(f => f.note), "without calling the site new");
  ok(WhimsyAgentGuard.navigation(uri("https://docs.google.com/"), sites, { origins }).data,
    "The root of that origin still carries its host label: a visited site's unvisited subdomain is the same channel as <secret>.evil.example");
  is(WhimsyAgentGuard.navigation(uri("https://www.google.com/"), sites, { origins }), null, "www at the root of a visited site goes ahead");
  is(WhimsyAgentGuard.navigation(uri(`https://mail.google.com/mail/u/0/${secret}`), sites, { origins }), null, "A path on an origin the task has been to goes ahead");
  const links = new Set([`https://docs.google.com/forms/d/e/${secret}/viewform`]);
  is(WhimsyAgentGuard.navigation(uri(`https://docs.google.com/forms/d/e/${secret}/viewform`), sites, { origins, links }), null, "A path a page the task read linked goes ahead");
  is(WhimsyAgentGuard.navigation(uri(`https://docs.google.com/forms/d/e/${secret}/viewform`), sites, { origins: new Set(["http://docs.google.com"]) })?.kind, "navigate", "Origins are exact: another scheme is another origin");
});

// The task's origins fill in as it goes: the start page, an approved
// address, and the person's own tabs; a landed page's path isn't data.
add_task(async function task_origins_follow_the_person() {
  const started = WhimsyAgentTasks.start({ client: "whimsy", mode: "background", sites: ["example.com"], origins: ["https://example.com"] });
  Assert.deepEqual([...started.origins], ["https://example.com"], "A task starts with its start origin");
  WhimsyAgentTasks.finish(started.id);

  const task = WhimsyAgentTasks.start({ client: "whimsy", mode: "background", sites: ["example.com"] });
  const pending = own(task, "tabs_create", { url: LINKS });
  const pause = await waitForPause(task, "navigate");
  ok(pause.data, "On a site visited by name only, the start page's path pauses as data");
  WhimsyAgentTasks.decide(task.id, "do");
  const created = await pending;
  ok(!created.isError, "Go there creates the tab");
  ok(task.origins.has("https://example.com"), "and the address's origin is now visited");
  const { tabId } = JSON.parse(textOf(created));
  const again = await own(task, "navigate", { tabId, url: PAGE });
  ok(!again.isError && !task.pause, "so another path there goes ahead");
  WhimsyAgentTasks.finish(task.id);
  BrowserTestUtils.removeTab(WhimsyClaude.tabById(tabId));
});

add_task(function long_pasted_requests_approve_nothing() {
  const start = uri("https://mail.google.com/mail/u/0/");
  Assert.deepEqual(WhimsyChatAgent.startSites("Book a table on opentable.com for Friday", start), ["google.com", "opentable.com"],
    "The start site and a site the person typed count as visited");
  const pasted = "Summarize this and check the links:\n" + "Dear customer, your parcel is waiting. ".repeat(12) + "Confirm at https://parcel-verify.example/now";
  Assert.ok(pasted.length >= 500, "The request is a long pasted block");
  Assert.deepEqual(WhimsyChatAgent.startSites(pasted, start), ["google.com"], "Domains inside a long paste aren't pre-approved");
});

add_task(async function visited_site_with_data_pauses_unless_supplied() {
  const task = WhimsyAgentTasks.start({ client: "whimsy", mode: "background", sites: ["example.com"], origins: ["https://example.com"] });
  const created = await own(task, "tabs_create", { url: LINKS });
  ok(!created.isError && !task.pause, "A plain address on the start site goes ahead");
  const { tabId } = JSON.parse(textOf(created));

  let pending = own(task, "navigate", { tabId, url: PAGE + "?q=the-persons-mail" });
  const pause = await waitForPause(task, "navigate");
  is(pause.preview.title, "Go to example.com?", "Data on a visited site asks");
  WhimsyAgentTasks.decide(task.id, "skip");
  ok(textOf(await pending).includes("chose not to go"), "Skip tells the agent");

  ok(!(await own(task, "read_page", { tabId })).isError, "The agent reads the page");
  for (const url of [PAGE + "?page=2", PAGE + "?page=2#other", PAGE + "?from=form"]) {
    const result = await own(task, "navigate", { tabId, url });
    ok(!result.isError && !task.pause, `${url.split("/").pop()}: an address the page supplied goes ahead`);
    await own(task, "navigate", { tabId, url: LINKS });
    await own(task, "read_page", { tabId });
  }
  WhimsyAgentTasks.finish(task.id);
  BrowserTestUtils.removeTab(WhimsyClaude.tabById(tabId));
});

add_task(async function redirect_to_a_new_site_pauses_before_reading() {
  const task = WhimsyAgentTasks.start({ client: "whimsy", mode: "background", sites: ["example.com"], origins: ["https://example.com"] });
  const { tabId } = JSON.parse(textOf(await own(task, "tabs_create", { url: LINKS })));
  await own(task, "read_page", { tabId });
  // The page linked its redirector, so the address itself goes ahead...
  const moved = await own(task, "navigate", { tabId, url: ROOT + "whimsy_secfix2_redirect.sjs?next=1" });
  ok(!moved.isError, "The linked address loads");
  const tab = WhimsyClaude.tabById(tabId);
  is(tab.linkedBrowser.currentURI.host, "example.org", "and redirects to another site");
  ok(!task.sites.has("example.org"), "A redirect never marks a site visited");

  // ...but the agent can't read or use where it landed until the person says so.
  let pending = own(task, "get_page_text", { tabId });
  let pause = await waitForPause(task, "navigate");
  is(pause.preview.title, "Go to example.org?", "Reading the redirected tab asks first");
  WhimsyAgentTasks.decide(task.id, "skip");
  let result = await pending;
  ok(!textOf(result).includes("Cheap flights"), "Skip: nothing is read");
  pending = own(task, "click", { tabId, coordinate: [5, 5] });
  pause = await waitForPause(task, "navigate");
  WhimsyAgentTasks.decide(task.id, "do");
  await pending;
  ok(task.sites.has("example.org"), "Go there marks it visited");
  result = await own(task, "get_page_text", { tabId });
  ok(textOf(result).includes("Cheap flights") && !task.pause, "and the agent may read it");
  WhimsyAgentTasks.finish(task.id);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function persons_own_tab_counts_as_visited() {
  // Drive: a tab the person attached is on a site they chose.
  const mine = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE.replace("example.com", "example.net"));
  const drive = WhimsyAgentTasks.start({ client: "whimsy", mode: "drive", sites: ["example.com"], origins: ["https://example.com"] });
  drive.attached.add(mine);
  const read = await own(drive, "get_page_text", { tabId: WhimsyClaude.tabId(mine) });
  ok(!read.isError && !drive.pause && textOf(read).includes("Cheap flights"), "An attached tab reads without a pause");
  WhimsyAgentTasks.finish(drive.id);
  BrowserTestUtils.removeTab(mine);
});

// P2-M3: after "Go there", every submit or send on that site pauses with
// what was filled in, with no "don't ask again"; typing doesn't.
add_task(function approved_site_submits_pause_every_time() {
  const search = {
    role: "button", text: "Look up", submits: true, url: "https://verify.example/check",
    form: { fields: [{ label: "Reference", name: "q", type: "search", value: "Re: invoice 4417, bank code 0099" }] },
  };
  is(WhimsyAgentGuard.classify("click", search), null, "Elsewhere, a one-box search form submits freely");
  const verdict = WhimsyAgentGuard.classify("click", { ...search, approvedSite: true });
  is(verdict?.kind, "submit", "On a site approved mid-task it pauses");
  ok(verdict.everyTime, "every time");
  ok(verdict.preview.fields.some(f => f.value.includes("invoice 4417")), "showing the filled value");
  is(WhimsyAgentGuard.classify("key", { ...search, keys: "Enter", approvedSite: true })?.kind, "submit", "Return in the form pauses too");
  const jsButton = { role: "button", text: "Continue", form: { fields: [{ label: "Notes", name: "notes", value: "the mail" }] }, url: "https://verify.example/", approvedSite: true };
  is(WhimsyAgentGuard.classify("click", jsButton)?.kind, "submit", "So does a script button inside a form");
  is(WhimsyAgentGuard.classify("type", { role: "textbox", label: "Notes", value: "the mail", url: "https://verify.example/", approvedSite: true }), null, "Typing itself doesn't pause");
  is(WhimsyAgentGuard.classify("click", { role: "link", text: "Help", href: "https://verify.example/help", url: "https://verify.example/", approvedSite: true }), null, "Nor does a plain link");

  const task = WhimsyAgentTasks.start({ client: "whimsy", mode: "background" });
  const pause = WhimsyAgentTasks.pause(task.id, { ...verdict, sig: "x" });
  ok(!pause.allowForTask, "No don't-ask-again for these");
  WhimsyAgentTasks.finish(task.id);
});
