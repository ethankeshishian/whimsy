/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

requestLongerTimeout(3);

// W25 Granola meeting notes (intake-w25/mockups/granola.html). A local MCP
// server stands in for Granola (its real tool names and schema shapes:
// list_meetings, get_meeting_transcript, get_meetings), a calendar event
// for the meeting, a page with a call's <audio srcObject> for the call tab,
// and stand-ins for the speech recognizer and the AI provider. Nothing
// leaves the Mac. Each step waits on state, and the clock is the module's
// own (WhimsyMeetingNotes.now), so nothing sleeps.

const PAGE = getRootDirectory(gTestPath).replace("chrome://mochitests/content", "https://example.com") + "whimsy_call_captions.html";

const { WhimsyMeetingNotes, parseMeetingList, matchMeeting, argsFor, parsePoints } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyMeetingNotes.sys.mjs");
const { WhimsyConnectors } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyConnectors.sys.mjs");
const { WhimsyConnectorOAuth } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyConnectorOAuth.sys.mjs");
const { WhimsyNextMeeting } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyNextMeeting.sys.mjs");
const { WhimsyAIProviders } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyAIProviders.sys.mjs");
const { WhimsyChatPanel } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatPanel.sys.mjs");
const { WhimsyChatContextUI } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyChatContextUI.sys.mjs");
const { WhimsyLiveSpeech } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyLiveSpeech.sys.mjs");
const { HttpServer } = ChromeUtils.importESModule("resource://testing-common/httpd.sys.mjs");

const TOKEN = ["acc", "ess", "-", "gr4"].join("");
const MINUTE = 60000;
let server;
let base;
let clock = Date.now();
// What the stand-in Granola answers: "ok", "down" (HTTP 500), or "revoked" (401).
const granola = { mode: "ok", meetings: [], transcript: "", notes: "", calls: [] };
let aiCalls = [];
let aiReply = "- Onboarding v3 ships behind a flag on Dec 2.\n- Priya wants the empty state rewritten.";

const panel = () => WhimsyChatPanel.forWindow(window);
const card = () => panel().body?.querySelector(":scope > .whimsy-meeting-card");

function json(response, body, status = 200) {
  response.setStatusLine("1.1", status, "x");
  response.setHeader("Content-Type", "application/json");
  response.write(JSON.stringify(body));
}

const TOOLS = [
  { name: "list_meetings", inputSchema: { type: "object", properties: { time_range: { type: "string", enum: ["today", "this_week", "last_week"] } } } },
  { name: "get_meetings", inputSchema: { type: "object", properties: { meeting_ids: { type: "array", items: { type: "string" } } }, required: ["meeting_ids"] } },
  { name: "get_meeting_transcript", inputSchema: { type: "object", properties: { meeting_id: { type: "string" } }, required: ["meeting_id"] } },
  { name: "query_granola_meetings", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
];

function granolaReply(name, args) {
  if (name == "list_meetings") {
    return `<meetings>${granola.meetings.map(m => `<meeting id="${m.id}" title="${m.title}" date="${new Date(m.date).toISOString()}"><attendees/></meeting>`).join("")}</meetings>`;
  }
  if (name == "get_meeting_transcript") {
    return granola.meetings.some(m => m.id == args.meeting_id) ? granola.transcript : "";
  }
  if (name == "get_meetings") {
    return granola.notes;
  }
  return "";
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["whimsy.feature.ai-hints", false],
      ["whimsy.feature.meeting-notes", true],
      ["whimsy.ai.enabled", true],
      ["media.autoplay.default", 0],
      ["media.autoplay.blocking_policy", 0],
    ],
  });
  server = new HttpServer();
  server.start(-1);
  base = `http://127.0.0.1:${server.identity.primaryPort}`;
  server.identity.add("http", "127.0.0.1", server.identity.primaryPort);
  server.registerPathHandler("/token", (request, response) => json(response, { access_token: TOKEN, refresh_token: "r", expires_in: 3600 }));
  server.registerPathHandler("/.well-known/oauth-protected-resource", (request, response) => json(response, { authorization_servers: [base] }));
  server.registerPathHandler("/.well-known/oauth-authorization-server", (request, response) =>
    json(response, { authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` }));
  server.registerPathHandler("/register", (request, response) => json(response, { client_id: "whimsy-dyn" }, 201));
  server.registerPathHandler("/granola", (request, response) => {
    const signedIn = request.hasHeader("Authorization") && request.getHeader("Authorization") == `Bearer ${TOKEN}`;
    if (!signedIn || granola.mode == "revoked") {
      response.setStatusLine("1.1", 401, "Unauthorized");
      response.setHeader("WWW-Authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
      return;
    }
    if (granola.mode == "down") {
      response.setStatusLine("1.1", 500, "Down");
      return;
    }
    const stream = request.bodyInputStream;
    const message = JSON.parse(NetUtil.readInputStreamToString(stream, stream.available()));
    if (message.id === undefined) {
      response.setStatusLine("1.1", 202, "Accepted");
      return;
    }
    if (message.method == "tools/call") {
      granola.calls.push({ name: message.params.name, args: message.params.arguments });
    }
    const result = {
      initialize: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Granola" } },
      "tools/list": { tools: TOOLS },
      "tools/call": { content: [{ type: "text", text: granolaReply(message.params?.name, message.params?.arguments ?? {}) }] },
    }[message.method];
    json(response, { jsonrpc: "2.0", id: message.id, result });
  });
  const realOpen = WhimsyConnectorOAuth.openSignIn;
  // Granola's sign-in page: it comes straight back signed in.
  WhimsyConnectorOAuth.openSignIn = async (win, url) => {
    const params = new URL(url).searchParams;
    if (params.get("redirect_uri")) {
      fetch(`${params.get("redirect_uri")}?code=c0de&state=${params.get("state")}`).catch(() => {});
    }
    return { close() {} };
  };
  Services.prefs.setStringPref("whimsy.connectors.granola.url", `${base}/granola`);
  await WhimsyConnectors._resetForTest();
  WhimsyAIProviders.setTestProvider(async request => {
    aiCalls.push(request);
    return aiReply;
  });
  const realNow = WhimsyMeetingNotes.now;
  const realPoll = WhimsyMeetingNotes.pollMs;
  WhimsyMeetingNotes.now = () => clock;
  WhimsyMeetingNotes.initWindow(window);
  registerCleanupFunction(async () => {
    WhimsyConnectorOAuth.openSignIn = realOpen;
    WhimsyMeetingNotes._resetForTest();
    WhimsyMeetingNotes.now = realNow;
    WhimsyMeetingNotes.pollMs = realPoll;
    WhimsyMeetingNotes.testSpeech = null;
    WhimsyMeetingNotes.graceMs = 2 * MINUTE;
    WhimsyLiveSpeech.testSpeech = null;
    WhimsyAIProviders.setTestProvider(null);
    WhimsyNextMeeting.setConnectorEvents("test", null);
    WhimsyChatContextUI.setLiveChip(window, null);
    await WhimsyConnectors._resetForTest();
    WhimsyConnectors._bridge?.server.stop(() => {});
    WhimsyConnectors._bridge = null;
    Services.prefs.clearUserPref("whimsy.connectors.granola.url");
    closeToasts();
    if (panel().isOpen) {
      panel().close({ reason: "key" });
    }
    await new Promise(resolve => server.stop(resolve));
  });
});

// A calendar meeting on now, whose URL is the call tab's page.
async function startMeeting({ title = "Design review", connected = true } = {}) {
  WhimsyMeetingNotes._resetForTest();
  closeToasts();
  clock = Date.now();
  aiCalls = [];
  granola.mode = "ok";
  granola.calls = [];
  granola.meetings = [{ title, id: "m-1", date: clock - 60000 }];
  granola.transcript = "";
  granola.notes = "";
  if (connected && !(await WhimsyConnectors.list()).find(c => c.id == "granola").connected) {
    await WhimsyConnectors.connect(window, "granola");
  } else if (!connected) {
    await WhimsyConnectors.disconnect("granola");
  }
  WhimsyNextMeeting.setConnectorEvents("test", [{ title, start: clock - MINUTE, end: clock + 45 * MINUTE, url: PAGE }]);
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
  await panel().open();
  await TestUtils.waitForCondition(() => panel().ready, "Chat shows the call tab's thread");
  await WhimsyMeetingNotes.tick();
  return tab;
}

async function endMeeting(tab) {
  WhimsyMeetingNotes._resetForTest();
  closeToasts();
  WhimsyNextMeeting.setConnectorEvents("test", null);
  BrowserTestUtils.removeTab(tab);
}

add_task(function granola_replies_are_read() {
  const list = parseMeetingList('<meetings><meeting id="a1" title="Design &amp; review" date="2026-11-12T23:00:00Z"/><meeting title="x" id="b2" date="nope"></meeting></meetings>');
  Assert.deepEqual(list.map(m => m.id), ["a1", "b2"], "Both meetings, attributes in any order");
  is(list[0].title, "Design & review", "Entities decoded");
  is(parseMeetingList(JSON.stringify({ meetings: [{ id: "j", title: "T", date: "2026-11-12T23:00:00Z" }] }))[0].id, "j", "JSON too");
  const start = Date.parse("2026-11-12T23:00:00Z");
  is(matchMeeting(list, { title: "Design & review", start, end: start + 45 * MINUTE })?.id, "a1", "Matched by title, near the start");
  Assert.deepEqual(argsFor("get_meetings", TOOLS[1].inputSchema, { meetingId: "a1" }), { meeting_ids: ["a1"] }, "Ids from the schema");
  Assert.deepEqual(argsFor("list_meetings", TOOLS[0].inputSchema, {}), { time_range: "today" }, "Today's range");
  Assert.deepEqual(argsFor("get_meeting_transcript", null, { meetingId: "a1" }), { meeting_id: "a1" }, "Granola's names without a schema");
  Assert.deepEqual(parsePoints("Points:\n- One\n* Two\n3. Three"), ["One", "Two", "Three"], "Points from a list");
});

add_task(async function connect_from_the_chat_card() {
  const tab = await startMeeting({ connected: false });
  const button = await TestUtils.waitForCondition(() => card()?.querySelector("#whimsy-meeting-connect"), "Not connected: the card's one button (G.1)");
  is(card().dataset.kind, "off", "One line and one button");
  ok(!tab.hasAttribute("whimsy-meeting-following"), "No red dot until Granola follows");
  const settingsOpened = BrowserTestUtils.waitForNewTab(gBrowser, url => url.startsWith("about:preferences"), true);
  EventUtils.synthesizeMouseAtCenter(button, {});
  const settings = await settingsOpened;
  const doc = settings.linkedBrowser.contentDocument;
  // Granola's own row runs its sign-in: Signing in…, then connected.
  await TestUtils.waitForCondition(() => doc.querySelector('#whimsyConnectorsList .whimsy-ai-item[data-connector="granola"]')?.dataset.status == "ok", "Granola's row connects");
  await TestUtils.waitForCondition(() => toastFor("whimsy-connectors-connected-toast"), "The usual connected toast");
  // Connected mid-meeting: following starts at once (G.4, G.5).
  await TestUtils.waitForCondition(() => WhimsyMeetingNotes.state?.connector == "on" && tab.hasAttribute("whimsy-meeting-following"), "Following starts, with the red dot");
  BrowserTestUtils.removeTab(settings);
  gBrowser.selectedTab = tab;
  await TestUtils.waitForCondition(() => card()?.dataset.kind == "live" && card().querySelector(".whimsy-meeting-skel"), "The card waits for Granola's first notes");
  await endMeeting(tab);
});

add_task(async function follows_a_meeting_with_live_points() {
  const tab = await startMeeting();
  granola.transcript = "Ana: Onboarding v3 ships behind a flag on December second. Priya: the empty state needs rewriting before beta.";
  await WhimsyMeetingNotes.tick();
  await TestUtils.waitForCondition(() => card()?.querySelectorAll(".whimsy-meeting-points li").length == 2, "Two key points show");
  Assert.deepEqual(granola.calls.slice(0, 2).map(c => c.name), ["list_meetings", "get_meeting_transcript"], "Granola's own tools, in order");
  Assert.deepEqual(granola.calls[0].args, { time_range: "today" }, "list_meetings covers today");
  Assert.deepEqual(granola.calls[1].args, { meeting_id: "m-1" }, "The transcript of the matched meeting");
  ok(JSON.stringify(aiCalls[0].messages).includes("December second"), "Points come from Granola's notes");
  is(card().querySelector(".whimsy-meeting-meta").dataset.l10nId, "whimsy-meeting-from-granola", "From Granola's notes");
  ok(card().querySelector('[data-suggest="missed"]') && card().querySelector('[data-suggest="actions"]'), "What did I miss? and Action items so far");
  const chip = await TestUtils.waitForCondition(() => panel().chips?.querySelector('[data-chip="granola:live"]'), "The meeting's chip");
  ok(chip.hasAttribute("live"), "with a live dot");

  // Refresh each minute, only when the notes have grown.
  const asked = aiCalls.length;
  clock += MINUTE;
  await WhimsyMeetingNotes.tick();
  is(aiCalls.length, asked, "Nothing new, no refresh");
  granola.transcript += " Jonas: who signs off on copy? Ana: I'll draft the empty-state copy by Friday, and Priya reviews it.";
  aiReply += "\n- Ana drafts the empty-state copy by Friday.";
  clock += MINUTE;
  await WhimsyMeetingNotes.tick();
  const fresh = await TestUtils.waitForCondition(() => card()?.querySelector(".whimsy-meeting-points li.is-new"), "The new point is marked New");
  ok(fresh.textContent.includes("Ana drafts"), "The newest point");
  is(card().querySelectorAll(".whimsy-meeting-points li").length, 3, "Earlier points stay");
  is(card().querySelector(".whimsy-meeting-time").dataset.l10nId, "whimsy-meeting-time-updated", "The time says when it updated");

  // The meeting ends: following stops, the card freezes (G.13).
  clock += 45 * MINUTE;
  await WhimsyMeetingNotes.tick();
  await TestUtils.waitForCondition(() => card()?.dataset.kind == "ended", "Notes from the meeting");
  ok(!tab.hasAttribute("whimsy-meeting-following"), "The red dot goes");
  ok(card().querySelector("#whimsy-meeting-download"), "Download transcript");
  const dir = await useTempDownloadDir();
  granola.transcript = "Ana: the whole transcript.";
  EventUtils.synthesizeMouseAtCenter(card().querySelector("#whimsy-meeting-download"), {});
  await TestUtils.waitForCondition(() => toastFor("whimsy-meeting-downloaded"), "Downloaded, with Show in Finder");
  const [file] = await IOUtils.getChildren(dir);
  ok(file.endsWith(".md") && PathUtils.filename(file).startsWith("Design review"), "A Markdown file named after the meeting");
  ok((await IOUtils.readUTF8(file)).includes("Ana: the whole transcript."), "Granola's transcript");
  await endMeeting(tab);
});

add_task(async function granola_unreachable_retries_then_offers() {
  const tab = await startMeeting();
  granola.transcript = "Ana: first notes.";
  await WhimsyMeetingNotes.tick();
  await TestUtils.waitForCondition(() => card()?.querySelectorAll(".whimsy-meeting-points li").length, "Points first");
  granola.mode = "down";
  clock += MINUTE;
  await WhimsyMeetingNotes.tick();
  const note = await TestUtils.waitForCondition(() => card()?.querySelector('.whimsy-meeting-note[data-tone="err"]'), "Couldn't reach Granola (G.8)");
  is(note.querySelector("[data-l10n-id]").dataset.l10nId, "whimsy-meeting-unreachable", "It says so, and retries");
  ok(card().querySelectorAll(".whimsy-meeting-points li").length, "Points so far stay");
  ok(!toastFor("whimsy-meeting-offer-title"), "No offer yet");
  clock += 2 * MINUTE;
  await WhimsyMeetingNotes.tick();
  await TestUtils.waitForCondition(() => toastFor("whimsy-meeting-offer-title"), "Still unreachable after 2 minutes: the offer (G.10)");
  granola.mode = "ok";
  await endMeeting(tab);
});

add_task(async function signed_out_by_granola() {
  const tab = await startMeeting();
  granola.mode = "revoked";
  WhimsyMeetingNotes._schemas = null;
  clock += MINUTE;
  await WhimsyMeetingNotes.tick();
  const note = await TestUtils.waitForCondition(() => card()?.querySelector('.whimsy-meeting-note[data-tone="err"]'), "Signed out (G.9)");
  is(note.querySelector("[data-l10n-id]").dataset.l10nId, "whimsy-meeting-signed-out", "Granola signed you out");
  ok(note.querySelector("#whimsy-meeting-sign-in"), "Sign in again");
  is((await WhimsyConnectors.list()).find(c => c.id == "granola").status, "expired", "Settings' row says the sign-in expired too (G.18)");
  await TestUtils.waitForCondition(() => toastFor("whimsy-meeting-offer-title"), "For the rest of the meeting, the offer");
  granola.mode = "ok";
  await endMeeting(tab);
  await WhimsyConnectors.disconnect("granola");
});

function speechStandIns() {
  const mic = { sessions: [] };
  WhimsyMeetingNotes.testSpeech = {
    authorizationStatus: "authorized",
    microphoneStatus: "authorized",
    onDeviceLocales: ["en-US"],
    requestAccess(cb) { cb(true, "authorized"); },
    requestMicrophoneAccess(cb) { cb(true, "authorized"); },
    listen(locale, listener) {
      const session = { listener, stopped: false, stop() { this.stopped = true; }, finish() {} };
      mic.sessions.push(session);
      return session;
    },
    openSystemSettings() {},
  };
  const call = { sessions: [] };
  WhimsyLiveSpeech.testSpeech = {
    authorizationStatus: "authorized",
    onDeviceLocales: ["en-US"],
    requestAccess(cb) { cb(true, "authorized"); },
    start(locale, listener) {
      const session = { listener, audio: 0, stopped: false, appendAudio() { this.audio++; }, stop() { this.stopped = true; } };
      call.sessions.push(session);
      return session;
    },
  };
  return { mic, call };
}

async function tapCallAudio(browser) {
  await SpecialPowers.spawn(browser, [], async () => {
    const voice = content.document.getElementById("voice");
    await ContentTaskUtils.waitForCondition(() => !voice.paused && voice.srcObject.getAudioTracks().length, "The call's voice plays");
    const { SpeechTesting } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCaptionsChild.sys.mjs");
    SpeechTesting.tap = () => ({ sampleRate: 16000, start() {}, stop() {}, take: () => [0.1, -0.1] });
  });
}

add_task(async function fallback_offer_take_notes_and_stop() {
  const { mic, call } = speechStandIns();
  WhimsyMeetingNotes.graceMs = 0;
  const tab = await startMeeting();
  granola.meetings = [];
  await tapCallAudio(tab.linkedBrowser);
  clock += MINUTE;
  await WhimsyMeetingNotes.tick();
  // Granola has nothing for this meeting: one prompt offers Take notes.
  const offer = await TestUtils.waitForCondition(() => toastFor("whimsy-meeting-offer-title"), "The offer (G.10)");
  ok(offer.persistent, "It stays until pressed or the meeting ends");
  ok(!mic.sessions.length && !call.sessions.length, "Nothing listens before Take notes");
  EventUtils.synthesizeMouseAtCenter(offer.element.querySelector("#whimsy-meeting-take-notes"), {}, window);
  await TestUtils.waitForCondition(() => mic.sessions.length == 1, "The microphone listens");
  await TestUtils.waitForCondition(() => call.sessions.length == 1 && call.sessions[0].audio > 0, "The call's sound reaches the recognizer");
  await TestUtils.waitForCondition(() => !toastFor("whimsy-meeting-offer-title"), "The offer goes");
  const line = await TestUtils.waitForCondition(() => card()?.querySelector('.whimsy-meeting-note[data-tone="mic"] [data-l10n-id]'), "One plain line (G.11)");
  is(line.dataset.l10nId, "whimsy-meeting-own-on", "From the call and your microphone");

  // Words from both, then points from Whimsy's own notes.
  call.sessions[0].listener.onText("Priya: the empty state needs rewriting before beta.", true);
  mic.sessions[0].listener.onText("I'll draft the copy by Friday.", true);
  await TestUtils.waitForCondition(() => WhimsyMeetingNotes.state.transcript.length == 2, "Both are heard");
  await TestUtils.waitForCondition(() => mic.sessions.length == 2, "The microphone listens on after a pause");
  clock += MINUTE;
  await WhimsyMeetingNotes.tick();
  await TestUtils.waitForCondition(() => card()?.querySelector(".whimsy-meeting-points li"), "Points from Whimsy's own notes");
  is(card().querySelector(".whimsy-meeting-meta").dataset.l10nId, "whimsy-meeting-from-own", "It says they're Whimsy's own");

  // Stop: the microphone and the call's sound go off.
  EventUtils.synthesizeMouseAtCenter(card().querySelector("#whimsy-meeting-stop"), {});
  await TestUtils.waitForCondition(() => mic.sessions.at(-1).stopped, "The microphone stops");
  await TestUtils.waitForCondition(() => call.sessions[0].stopped, "The call's sound stops");
  await TestUtils.waitForCondition(() => !card()?.querySelector("#whimsy-meeting-stop"), "Stop goes");
  ok(card().querySelector(".whimsy-meeting-points li"), "The points stay");
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const { SpeechTesting } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCaptionsChild.sys.mjs");
    SpeechTesting.tap = null;
  });
  WhimsyMeetingNotes.graceMs = 2 * MINUTE;
  await endMeeting(tab);
});

add_task(async function no_microphone_notes_from_the_call() {
  const { mic } = speechStandIns();
  WhimsyMeetingNotes.testSpeech.microphoneStatus = "denied";
  WhimsyMeetingNotes.graceMs = 0;
  const tab = await startMeeting();
  granola.meetings = [];
  await tapCallAudio(tab.linkedBrowser);
  await WhimsyMeetingNotes.tick();
  await TestUtils.waitForCondition(() => toastFor("whimsy-meeting-offer-title"), "The offer");
  await WhimsyMeetingNotes.takeNotes();
  const note = await TestUtils.waitForCondition(() => card()?.querySelector('.whimsy-meeting-note[data-tone="warn"]'), "The microphone isn't allowed (G.12)");
  is(note.querySelector("span[data-l10n-id]").dataset.l10nId, "whimsy-meeting-own-no-mic", "The notes have the call but not your words");
  ok(note.querySelector("button"), "Open System Settings");
  is(mic.sessions.length, 0, "No microphone");
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const { SpeechTesting } = ChromeUtils.importESModule("resource:///modules/whimsy/WhimsyCaptionsChild.sys.mjs");
    SpeechTesting.tap = null;
  });
  WhimsyMeetingNotes.graceMs = 2 * MINUTE;
  await endMeeting(tab);
});
