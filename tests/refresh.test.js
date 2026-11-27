const { JSDOM } = require('jsdom');
const fs = require('fs');
const assert = require('assert');
const ROOT = require('path').join(__dirname, '..');
const read = (f) => fs.readFileSync(require('path').join(ROOT, f), 'utf8');
const src = read('content.js');
const site = read('site.js');
const visSrc = read('visuals.js') + '\n' + read('markdown.js') + '\n' + read('ask.js');
const lib = read('lib.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Boots the extension on a given URL with a given "disk" (so we can simulate a page refresh by booting again with the same disk).
// With { sync: true } the instance also gets chrome.storage.onChanged, fed by every write to the same disk (its own
// included, like the real thing), so several instances on one disk behave like several open tabs.
const buses = new WeakMap();
async function boot(url, disk, opts) {
  const dom = new JSDOM('<!doctype html><body><div id="chat"></div><textarea></textarea><div role="button" id="send"><svg></svg></div></body>',
    { url: url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  if (!buses.has(disk)) buses.set(disk, []);
  const bus = buses.get(disk);
  const local = {
    get: (k, cb) => cb(JSON.parse(JSON.stringify(disk))),
    set: (o) => {
      const clean = JSON.parse(JSON.stringify(o));
      const changes = {};
      Object.keys(clean).forEach((k) => { changes[k] = { oldValue: disk[k], newValue: clean[k] }; });
      Object.assign(disk, clean);
      bus.slice().forEach((f) => f(changes, 'local'));
    },
  };
  w.chrome = { storage: { local } };
  if (opts && opts.sync) w.chrome.storage.onChanged = { addListener: (f) => bus.push(f) };
  w.eval(lib);
  w.eval(site);
  w.eval(visSrc);
  w.eval(src);
  await sleep(60);
  const ta = w.document.querySelector('textarea');
  return {
    w, ta, disk,
    type: (v) => {
      Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set.call(ta, v);
      ta.dispatchEvent(new w.Event('input', { bubbles: true }));
    },
    enter: () => {
      const ev = new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      ta.dispatchEvent(ev);
      return ev;
    },
    strip: () => w.document.getElementById('dck-strip').textContent,
  };
}

const settings = () => ({
  enabled: true, defaultEnabled: false, memoryEnabled: false,
  prompts: [
    { id: 'f', name: 'First only', text: 'Rule F', enabled: true, schedule: 'first' },
    { id: 'e', name: 'Every 3', text: 'Rule E', enabled: true, schedule: 'every', everyN: 3 },
  ],
});

(async () => {
  // 1. The reported bug: refresh in an existing chat must not re-attach "first message" prompts
  {
    const disk = { dck_settings: settings() };
    const a = await boot('https://chat.deepseek.com/a/chat/s/abc', disk);
    // chat has history but the extension has no record of it (e.g. page refreshed): treated as already started
    assert.ok(!a.strip().includes('First only'), 'strip must not offer the first-message prompt: ' + a.strip());
    a.type('hello again');
    const ev = a.enter();
    assert.ok(!ev.defaultPrevented, 'Enter is not intercepted for a first-message-only prompt');
    assert.ok(a.ta.value === 'hello again', 'nothing was attached');
    console.log('ok  refresh in an existing chat does not re-attach first-message prompts');
  }

  // 2. Counts are saved and survive a refresh (every-N keeps counting correctly)
  {
    const disk = { dck_settings: settings() };
    let a = await boot('https://chat.deepseek.com/a/chat/s/xyz', disk);
    // unknown chat starts at 1; "every 3" is not due (1 % 3 != 0)
    // a message counts when the site takes it and the box clears; the tests clear it by hand to play the site
    a.type('m'); a.enter(); a.type(''); await sleep(250); // count 1 -> 2
    assert.strictEqual(disk.dck_counts['/a/chat/s/xyz'], 2, 'count saved');
    a = await boot('https://chat.deepseek.com/a/chat/s/xyz', disk); // refresh
    a.type('m'); a.enter(); a.type(''); await sleep(250); // count 2 -> 3
    assert.strictEqual(disk.dck_counts['/a/chat/s/xyz'], 3, 'count restored after refresh and incremented');
    a = await boot('https://chat.deepseek.com/a/chat/s/xyz', disk); // refresh again
    assert.ok(a.strip().includes('Every 3'), 'every-3 is due at count 3 after a refresh: ' + a.strip());
    console.log('ok  counts persist across refreshes');
  }

  // 3. Brand-new chat: gets the first-message prompt, then the count is carried to the chat's own URL
  {
    const disk = { dck_settings: settings() };
    const a = await boot('https://chat.deepseek.com/', disk);
    assert.ok(a.strip().includes('First only'), 'new chat offers first-message prompt');
    a.type('hello');
    assert.ok(a.enter().defaultPrevented, 'first Enter inserts context');
    assert.ok(a.ta.value.includes('Rule F'));
    assert.ok(!a.enter().defaultPrevented, 'second Enter sends');
    a.type(''); await sleep(250); // the site takes the message and clears the box
    assert.ok(!('/' in (disk.dck_counts || {})), 'the new-chat screen is never persisted');
    a.w.history.pushState({}, '', '/a/chat/s/fresh'); // the site moves to the new chat's URL
    await sleep(650);
    assert.strictEqual(disk.dck_counts['/a/chat/s/fresh'], 1, 'count carried to the new chat: ' + JSON.stringify(disk.dck_counts));
    // refresh on that new chat: still counted, first-message prompt does not come back
    const b = await boot('https://chat.deepseek.com/a/chat/s/fresh', disk);
    assert.ok(!b.strip().includes('First only'));
    console.log('ok  new chat -> count carried over -> refresh is safe');
  }

  // 4. Opening an existing chat from the new-chat screen must not reset it to "first message"
  {
    const disk = { dck_settings: settings() };
    const a = await boot('https://chat.deepseek.com/', disk);
    a.w.history.pushState({}, '', '/a/chat/s/old'); // user clicks an old chat in the sidebar, nothing sent from "/"
    await sleep(650);
    assert.ok(!('/a/chat/s/old' in (disk.dck_counts || {})), 'nothing was written for the old chat');
    assert.ok(!a.strip().includes('First only'), 'old chat is not treated as a first message: ' + a.strip());
    // and the new-chat screen is fresh again afterwards
    a.w.history.pushState({}, '', '/');
    await sleep(650);
    assert.ok(a.strip().includes('First only'), 'back on the new-chat screen the prompt is due again');
    console.log('ok  opening an old chat from the new-chat screen is safe');
  }

  // 5. Reset all forgets the counts
  {
    const disk = { dck_settings: settings(), dck_counts: { '/a/chat/s/q': 5 } };
    const a = await boot('https://chat.deepseek.com/a/chat/s/q', disk);
    a.w.document.getElementById('dck-fab').click();
    a.w.confirm = () => true;
    Array.from(a.w.document.querySelectorAll('[role=tab]')).find((b) => b.textContent.startsWith('Settings')).click();
    Array.from(a.w.document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Reset all').click();
    assert.strictEqual(JSON.stringify(disk.dck_counts), '{}', 'counts cleared');
    console.log('ok  Reset all clears counts');
  }

  // 6. Two tabs on two chats: each tab's count is kept, whichever tab writes last
  {
    const disk = { dck_settings: settings() };
    const a = await boot('https://chat.deepseek.com/a/chat/s/tabA', disk, { sync: true });
    const b = await boot('https://chat.deepseek.com/a/chat/s/tabB', disk, { sync: true }); // booted before A wrote anything
    a.type('m'); a.enter(); a.type(''); await sleep(250); // tabA 1 -> 2
    b.type('m'); b.enter(); b.type(''); await sleep(250); // tabB 1 -> 2, from a copy that never saw tabA
    assert.strictEqual(disk.dck_counts['/a/chat/s/tabA'], 2, 'tab A kept: ' + JSON.stringify(disk.dck_counts));
    assert.strictEqual(disk.dck_counts['/a/chat/s/tabB'], 2, 'tab B kept: ' + JSON.stringify(disk.dck_counts));
    a.type('m'); a.enter(); a.type(''); await sleep(250); // tabA 2 -> 3, and B's entry must survive this write too
    assert.strictEqual(disk.dck_counts['/a/chat/s/tabA'], 3);
    assert.strictEqual(disk.dck_counts['/a/chat/s/tabB'], 2, 'tab B still kept');
    console.log('ok  two tabs on two chats keep each other\'s counts');
  }

  // 7. Reset in one tab is not undone by another tab that still holds old counts
  {
    const disk = { dck_settings: settings(), dck_counts: { '/a/chat/s/old': 4 } };
    const a = await boot('https://chat.deepseek.com/a/chat/s/old', disk, { sync: true });
    const b = await boot('https://chat.deepseek.com/a/chat/s/other', disk, { sync: true }); // holds old: 4 too
    a.w.chrome.storage.local.set({ dck_counts: {} }); // what "Reset all" writes
    b.type('m'); b.enter(); b.type(''); await sleep(250);
    assert.ok(!('/a/chat/s/old' in disk.dck_counts), 'forgotten chat did not come back: ' + JSON.stringify(disk.dck_counts));
    assert.strictEqual(disk.dck_counts['/a/chat/s/other'], 2);
    console.log('ok  Reset all reaches other tabs');
  }

  // 8. An Enter the site ignores (a reply is still being written) is not a message: it must not move the count
  {
    const disk = { dck_settings: settings(), dck_counts: { '/a/chat/s/ig': 2 } };
    const a = await boot('https://chat.deepseek.com/a/chat/s/ig', disk);
    assert.ok(!a.strip().includes('Every 3'), 'count 2: every-3 is not due yet');
    a.type('x'); a.enter(); // the site does nothing: the text stays in the box
    await sleep(5400);
    assert.strictEqual(disk.dck_counts['/a/chat/s/ig'], 2, 'ignored Enter did not count: ' + JSON.stringify(disk.dck_counts));
    assert.ok(!a.strip().includes('Every 3'), 'so every-3 is still not due');
    a.type('y'); a.enter(); a.type(''); await sleep(250); // this one goes out
    assert.strictEqual(disk.dck_counts['/a/chat/s/ig'], 3, 'a real send counts');
    await sleep(650);
    assert.ok(a.strip().includes('Every 3'), 'every-3 is due now: ' + a.strip());
    console.log('ok  an Enter the site ignores is not counted');
  }

  // 9. A send made with the mouse counts too; a click elsewhere does not
  {
    const disk = { dck_settings: settings(), dck_counts: { '/a/chat/s/ms': 2 } };
    const a = await boot('https://chat.deepseek.com/a/chat/s/ms', disk);
    a.type('x');
    a.w.document.getElementById('chat').click(); // not the send button
    a.type(''); await sleep(250);
    assert.strictEqual(disk.dck_counts['/a/chat/s/ms'], 2, 'clearing the box after a click elsewhere is not a send');
    a.type('x');
    a.w.document.getElementById('send').click();
    a.type(''); await sleep(250);
    assert.strictEqual(disk.dck_counts['/a/chat/s/ms'], 3, 'send button click counted once the box cleared');
    console.log('ok  a send with the mouse is counted');
  }

  // 10. The page moves to the chat's own address before the box clears: the message still belongs to that chat
  {
    const disk = { dck_settings: { enabled: true, defaultEnabled: false, memoryEnabled: false, visualsPrompt: false, askPrompt: false, prompts: [] } };
    const a = await boot('https://chat.deepseek.com/', disk);
    a.type('hello'); a.enter(); // nothing is due: a plain send from the new-chat screen
    a.w.history.pushState({}, '', '/a/chat/s/nav'); // the site moves on, the path check notices
    await sleep(650);
    a.type(''); await sleep(250); // and only then the box clears
    assert.strictEqual(disk.dck_counts['/a/chat/s/nav'], 1, 'counted for the new chat: ' + JSON.stringify(disk.dck_counts));
    assert.ok(!('/' in disk.dck_counts), 'the new-chat screen kept nothing');
    console.log('ok  a message that clears after the page moved is counted for its chat');
  }

  console.log('\nall refresh/count tests passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
