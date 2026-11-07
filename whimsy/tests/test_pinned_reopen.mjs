// Run with: node --test whimsy/tests/test_pinned_reopen.mjs
// Exercise the real command wrapper with SessionStore completion held back.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

function fixture() {
  const source = readFileSync(new URL('../../src/zen/whimsy/WhimsyUndo.sys.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;$/m, '')
    .replace('export const WhimsyUndo', 'const WhimsyUndo');
  const context = vm.createContext({ console, Services: {}, ChromeUtils: {
    importESModule: () => ({ SessionStore: { setTabState() {} } }),
  } });
  vm.runInContext(source + '\nglobalThis.api = { WhimsyUndo, setPinnedTabState, pinnedRestores };', context);
  const tab = new EventTarget();
  Object.assign(tab, { pinned: true, selected: true, isConnected: true });
  let closes = 0;
  let resets = 0;
  const manager = {
    async onCloseTabShortcut() { closes++; tab.selected = false; },
    resetPinnedTab() { resets++; },
  };
  const win = { gZenPinnedTabManager: manager, gBrowser: { selectedTab: tab }, addEventListener() {} };
  context.api.WhimsyUndo.reopenPinnedCloses(win);
  return { ...context.api, tab, manager, win, closes: () => closes, resets: () => resets };
}

for (const completion of ['SSTabRestored', 'TabClose']) {
  test(`a second close waits for ${completion}, even with URI/history already visible`, async () => {
    const f = fixture();
    f.setPinnedTabState(f.tab, '{}');
    const closing = f.manager.onCloseTabShortcut({});
    await Promise.resolve();
    assert.equal(f.closes(), 0, 'must not enter Zen unload/flush during restoration');
    f.tab.dispatchEvent(new Event(completion));
    await closing;
    assert.equal(f.closes(), 1);
    assert.equal(f.pinnedRestores.has(f.tab), false);
    f.tab.dispatchEvent(new Event(completion));
    assert.equal(f.closes(), 1, 'completion is consumed only once');
  });
}

test('ordinary closes still start synchronously', async () => {
  const f = fixture();
  const closing = f.manager.onCloseTabShortcut({});
  assert.equal(f.closes(), 1);
  await closing;
});

test('Back to Pinned Page also waits for restoration', async () => {
  const f = fixture();
  f.WhimsyUndo.untilLoaded = async () => {};
  f.setPinnedTabState(f.tab, '{}');
  const resetting = f.WhimsyUndo.backToPinnedPage(f.win, f.tab);
  await Promise.resolve();
  assert.equal(f.resets(), 0);
  f.tab.dispatchEvent(new Event('SSTabRestored'));
  await resetting;
  assert.equal(f.resets(), 1);
});
