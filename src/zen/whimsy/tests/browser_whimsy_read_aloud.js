/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// W23 voice-image: read aloud (media-4.1–4.11, fu-media 4.5, 4.10, dec-12).
// A stand-in synthesizer replaces macOS's voices: the tests drive its
// start, word boundaries, and ends. Everything here runs with AI off.

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_read_aloud.js", this);

add_setup(async function () {
  await readAloudSetup();
});

add_task(async function listen_page_and_from_here() {
  await withArticle(async browser => {
    const tab = gBrowser.selectedTab;
    ok(!tab.hasAttribute("soundplaying"), "The tab starts quiet");
    document.getElementById("cmd_whimsyListenPage").doCommand();
    await waitForSpeech("The night train was supposed to be dead.");
    const s = WhimsyReadAloud.session;
    is(s.kind, "page", "Reads the article");
    is(s.sentences.length, 12, "Every article sentence");
    ok(!s.sentences.some(t => /Lena Hart|^Travel/.test(t.text)), "and nothing from around the article");
    const { holder, card } = await cardShown();
    ok(card.hasAttribute("busy"), "Starting: the card shows it's busy (media-4.2)");
    ok(tab.hasAttribute("soundplaying"), "The tab gets its speaker");
    is(holder.previousElementSibling?.id, "zen-media-controls-toolbar", "The card sits in Zen's media-card spot");
    is(await highlighted(browser), "The night train was supposed to be dead.", "The sentence is tinted in the page");

    synth.start();
    ok(card.classList.contains("playing") && !card.hasAttribute("busy"), "Playing once the voice starts");
    synth.end();
    is(synth.current.text, sentenceOf(1), "The next sentence follows");
    is(await highlighted(browser), sentenceOf(1), "and the tint moves with it");

    // Previous and next skip sentences (media-4.3).
    await click(card.querySelector(".zen-media-nexttrack-button"));
    is(synth.current.text, sentenceOf(2), "Next skips to the next sentence");
    await click(card.querySelector(".zen-media-previoustrack-button"));
    is(synth.current.text, sentenceOf(1), "Previous goes back one");

    // Clicking a sentence in the page jumps there.
    await BrowserTestUtils.synthesizeMouse("#p5", 6, 6, {}, browser);
    await TestUtils.waitForCondition(() => synth.current?.text.startsWith("Not everything is smooth."), "A click on a sentence jumps there");

    // Close stops, clears the tint, and gives the speaker back.
    InspectorUtils.addPseudoClassLock(holder, ":hover");
    try {
      await whimsySettled();
      await click(card.querySelector(".zen-media-close-button"));
    } finally {
      InspectorUtils.removePseudoClassLock(holder, ":hover");
    }
    ok(!WhimsyReadAloud.session, "Close stops reading");
    ok(!tab.hasAttribute("soundplaying"), "The speaker goes");
    is(await highlighted(browser), "", "The tint clears");
    await TestUtils.waitForCondition(() => holder.hidden, "The card leaves");

    // Listen from here: the paragraph in view.
    await SpecialPowers.spawn(browser, [], () => {
      content.document.getElementById("p4").scrollIntoView({ block: "start", behavior: "instant" });
    });
    document.getElementById("cmd_whimsyListenFromHere").doCommand();
    await waitForSpeech(/^The appeal is simple arithmetic/);
    ok(true, "Listen from here starts at the paragraph in view");

    // To the end: Finished, replay, and the card leaves after its delay.
    WhimsyReadAloud.leaveDelay = 300;
    WhimsyReadAloud.goTo(WhimsyReadAloud.session.sentences.length - 1);
    synth.end();
    const done = WhimsyReadAloud.session.card;
    ok(done.hasAttribute("finished"), "Finished (media-4.9)");
    is(done.querySelector(".zen-media-artist").getAttribute("data-l10n-id"), "whimsy-read-aloud-finished", "says Finished");
    is(done.querySelector(".zen-media-playpause-button").getAttribute("data-l10n-id"), "whimsy-read-aloud-replay", "and offers replay");
    is(await highlighted(browser), "", "The tint clears at the end");
    ok(!tab.hasAttribute("soundplaying"), "and the speaker goes");
    await TestUtils.waitForCondition(() => !WhimsyReadAloud.session && holder.hidden, "The finished card leaves by itself");
  });
});

add_task(async function keyboard_order_and_keys() {
  await withArticle(async () => {
    document.getElementById("cmd_whimsyListenPage").doCommand();
    await waitForSpeech("The night train was supposed to be dead.");
    synth.start();
    const { card } = await cardShown();
    const order = [".zen-media-previoustrack-button", ".zen-media-playpause-button", ".zen-media-nexttrack-button", ".zen-media-mute-button", ".whimsy-read-aloud-speed"];
    card.querySelector(order[0]).focus();
    for (const sel of order.slice(1)) {
      EventUtils.synthesizeKey("KEY_Tab");
      is(document.activeElement, card.querySelector(sel), `Tab reaches ${sel}`);
    }
    card.querySelector(order[0]).focus();
    EventUtils.synthesizeKey(" ");
    is(WhimsyReadAloud.session.state, "paused", "Space pauses");
    EventUtils.synthesizeKey(" ");
    is(WhimsyReadAloud.session.state, "playing", "Space plays");
    EventUtils.synthesizeKey("KEY_ArrowRight");
    is(synth.current.text, sentenceOf(1), "→ steps to the next sentence");
    EventUtils.synthesizeKey("KEY_ArrowLeft");
    is(synth.current.text, sentenceOf(0), "← steps back");
    WhimsyReadAloud.stop({ animate: false });
  });
});

add_task(async function unavailable_without_article_text() {
  await BrowserTestUtils.withNewTab(`${ROOT}whimsy_read_aloud_app.html`, async browser => {
    // Reader View decides on load; give it the time it takes.
    await new Promise(r => setTimeout(r, 500));
    ok(!browser.isArticle, "Not an article");
    const { globalActions } = ChromeUtils.importESModule("resource:///modules/ZenUBGlobalActions.sys.mjs");
    const action = globalActions.find(a => a.commandId == "cmd_whimsyListenPage");
    ok(action, "Listen to this page is a plain command-bar command");
    ok(!action.isAvailable(window), "The command bar doesn't offer it with nothing to read");
    ok(!globalActions.find(a => a.commandId == "cmd_whimsyListenFromHere").isAvailable(window), "nor Listen from here");

    // ⌘K (fu-media 4.10): greyed, with the reason, only when typed for.
    const groups = WhimsyContextCommands.rank(window, { kind: "page", title: "Q4 roadmap" }, { textChars: 60, shares: {} });
    const all = groups.flatMap(g => g.all);
    const row = all.find(r => r.id == "listen-page");
    is(row?.label, "Listen to this page", "The row names the command");
    is(row.unavailable, "Nothing to read here. Select some text to hear it.", "greyed with the reason");
    ok(!groups.some(g => g.rows.some(r => r.id == "listen-page")), "and not ranked before typing");
    ok(!all.some(r => r.id == "listen-here"), "Listen from here isn't offered");
    is(WhimsyContextCommands.filter(groups, "listen")[0]?.id, "listen-page", "Typing finds it");

    // Running it anyway says why, and nothing starts.
    document.getElementById("cmd_whimsyListenPage").doCommand();
    await TestUtils.waitForCondition(() => toastFor("whimsy-read-aloud-nothing"), "A toast says why");
    ok(!WhimsyReadAloud.session, "Nothing reads");
    closeToasts();

    // With text selected: Listen to selection reads just that.
    await SpecialPowers.spawn(browser, [], () => {
      const range = content.document.createRange();
      range.selectNodeContents(content.document.getElementById("note"));
      content.getSelection().removeAllRanges();
      content.getSelection().addRange(range);
    });
    const verb = WhimsyVerbs.verbsFor(window, { kind: "selection", text: "Ship" }).find(v => v.id == "listen-selection");
    is(WhimsyVerbs.labelFor(verb, { kind: "selection" }, window), "Listen to selection", "The selection's verbs offer Listen to selection");
    await WhimsyVerbs.runVerb(window, "listen-selection", { kind: "selection", text: "Ship" });
    await waitForSpeech("Ship the new onboarding before the holidays.");
    is(WhimsyReadAloud.session.kind, "selection", "It reads the selection");
    is(WhimsyReadAloud.session.sentences.length, 2, "and only the selection");
    WhimsyReadAloud.stop({ animate: false });
  });

  // On an article, ⌘K offers both with the time and the hint (media-4.1).
  await withArticle(async () => {
    const groups = WhimsyContextCommands.rank(window, { kind: "page", title: "Night trains" }, { textChars: 9450, shares: {} });
    const rows = groups.flatMap(g => g.rows);
    const page = rows.find(r => r.id == "listen-page");
    is(page?.tag, "9 min", "Listen to this page says how long");
    ok(!page.unavailable, "and isn't greyed");
    is(rows.find(r => r.id == "listen-here")?.detail, "Starts at the paragraph in view", "Listen from here says where it starts");
    ok(!groups.some(g => g.kind == "article" && g.all.some(r => r.id.startsWith("listen"))), "Not grouped with the AI rows");
  });
});

add_task(async function mute_pauses() {
  await withArticle(async () => {
    const tab = gBrowser.selectedTab;
    document.getElementById("cmd_whimsyListenPage").doCommand();
    await waitForSpeech("The night train was supposed to be dead.");
    synth.start();
    synth.boundary(4);
    const { card } = await cardShown();
    const audio = tab.querySelector(".tab-audio-button");
    await TestUtils.waitForCondition(() => audio && audio.getBoundingClientRect().width > 0, "The tab's speaker shows");
    await click(audio);
    ok(tab.hasAttribute("muted"), "The tab's speaker mutes");
    is(WhimsyReadAloud.session.state, "paused", "Muting the tab pauses reading (media-4.8)");
    ok(!synth.current, "The voice stops");
    ok(card.hasAttribute("muted") && !card.classList.contains("playing"), "The card shows muted and paused");
    is(await highlighted(gBrowser.selectedBrowser, "whimsy-read-aloud-paused"), "The night train was supposed to be dead.", "The sentence keeps a lighter tint");
    await click(audio);
    ok(!tab.hasAttribute("muted"), "Unmuted");
    is(WhimsyReadAloud.session.state, "playing", "Unmuting carries on");
    is(synth.current.text, "night train was supposed to be dead.", "from the word it stopped at");

    // The card's mute is the tab's.
    await click(card.querySelector(".zen-media-mute-button"));
    ok(tab.hasAttribute("muted") && WhimsyReadAloud.session.state == "paused", "The card's mute mutes the tab and pauses");
    await click(card.querySelector(".zen-media-mute-button"));
    ok(!tab.hasAttribute("muted") && WhimsyReadAloud.session.state == "playing", "and unmutes it");

    // A plain pause takes the speaker away (media-4.7).
    await click(card.querySelector(".zen-media-playpause-button"));
    ok(!tab.hasAttribute("soundplaying") && !tab.hasAttribute("muted"), "Paused: no speaker");
    WhimsyReadAloud.stop({ animate: false });
  });
});

add_task(async function speed_voice_persist() {
  await withArticle(async () => {
    document.getElementById("cmd_whimsyListenPage").doCommand();
    await waitForSpeech("The night train was supposed to be dead.");
    synth.start();
    const { card } = await cardShown();
    const speed = card.querySelector(".whimsy-read-aloud-speed");
    is(speed.textContent, "1×", "Speed sits at the end of the row");
    is(synth.current.rate, 1, "Normal speed");
    is(synth.current.voice.name, "Ava (Premium)", "The system's voice");

    let panel = await openSpeedMenu(speed);
    const options = [...panel.querySelectorAll("[role=option]")];
    Assert.deepEqual(options.map(o => o.querySelector(".whimsy-surface-option-label").textContent), ["0.75×", "1×", "1.25×", "1.5×", "2×", "Voice"], "Five speeds, then Voice");
    is(options[1].querySelector(".whimsy-surface-option-detail")?.textContent, "Normal", "1× is Normal");
    is(options[5].querySelector(".whimsy-surface-option-detail")?.textContent, "Ava ›", "Voice names the one in use");
    let hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    await click(options[3]);
    await hidden;
    is(Services.prefs.getStringPref("whimsy.read-aloud.rate"), "1.5", "The speed is saved");
    is(synth.current.rate, 1.5, "and applies from the word being read");
    is(speed.textContent, "1.5×", "The button shows it");

    panel = await openSpeedMenu(speed);
    await click([...panel.querySelectorAll("[role=option]")].at(-1));
    const samantha = await TestUtils.waitForCondition(
      () => [...panel.querySelectorAll("[role=option]")].find(o => o.textContent.includes("Samantha")),
      "Voice › lists the voices"
    );
    ok(![...panel.querySelectorAll("[role=option]")].some(o => o.textContent.includes("Thomas")), "in your language");
    hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    await click(samantha);
    await hidden;
    is(Services.prefs.getStringPref("whimsy.read-aloud.voice"), "com.apple.voice.compact.en-US.Samantha", "The voice is saved");
    is(synth.current.voice.name, "Samantha", "and speaks from the next word");
    WhimsyReadAloud.stop({ animate: false });

    // Every site, every time: a new reading starts with both.
    document.getElementById("cmd_whimsyListenPage").doCommand();
    await waitForSpeech("The night train was supposed to be dead.");
    ok(synth.current.rate == 1.5 && synth.current.voice.name == "Samantha", "A new reading uses the saved speed and voice");
    WhimsyReadAloud.stop({ animate: false });
  });

  // Settings › Media shows them.
  await BrowserTestUtils.withNewTab("about:preferences#whimsyMedia", async browser => {
    const doc = browser.contentDocument;
    const voice = await TestUtils.waitForCondition(() => doc.getElementById("whimsyReadAloudVoiceMenu"), "Settings › Media has the voice");
    const rate = doc.getElementById("whimsyReadAloudSpeedMenu");
    await TestUtils.waitForCondition(() => voice.textContent.includes("Samantha") && rate.textContent.includes("1.5×"), "Voice and speed show what's saved");
    ok(BrowserTestUtils.isVisible(voice) && BrowserTestUtils.isVisible(rate), "both in view on the Media page");
    ok(BrowserTestUtils.isVisible(doc.getElementById("whimsyMediaVoiceGroup")), "under Read aloud and dictation");
  });
  Services.prefs.clearUserPref("whimsy.read-aloud.rate");
  Services.prefs.clearUserPref("whimsy.read-aloud.voice");
});

add_task(async function private_window_ok() {
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  try {
    ok(!Services.prefs.getBoolPref("whimsy.ai.enabled"), "AI is off");
    const browser = win.gBrowser.selectedBrowser;
    BrowserTestUtils.startLoadingURIString(browser, `${ROOT}whimsy_read_aloud.html`);
    await BrowserTestUtils.browserLoaded(browser);
    await TestUtils.waitForCondition(() => browser.isArticle, "Reader View finds the article");
    win.document.getElementById("cmd_whimsyListenPage").doCommand();
    await waitForSpeech("The night train was supposed to be dead.");
    is(WhimsyReadAloud.session.win, win, "Reads in the private window");
    const holder = win.document.getElementById("whimsy-read-aloud-player");
    await TestUtils.waitForCondition(() => holder && !holder.hidden, "with its card");
    ok(win.gBrowser.selectedTab.hasAttribute("soundplaying"), "and the tab's speaker");
    WhimsyReadAloud.stop({ animate: false });
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
});
