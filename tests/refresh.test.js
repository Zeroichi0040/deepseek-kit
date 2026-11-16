const { JSDOM } = require('jsdom');
const fs = require('fs');
const assert = require('assert');
const ROOT = require('path').join(__dirname, '..');
const read = (f) => fs.readFileSync(require('path').join(ROOT, f), 'utf8');
const src = read('content.js');
const site = read('site.js');
const visSrc = read('visuals.js');
const lib = read('lib.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Boots the extension on a given URL with a given "disk" (so we can simulate a page refresh by booting again with the same disk).
async function boot(url, disk) {
  const dom = new JSDOM('<!doctype html><body><div id="chat"></div><textarea></textarea><div role="button" id="send"><svg></svg></div></body>',
    { url: url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.chrome = { storage: { local: { get: (k, cb) => cb(JSON.parse(JSON.stringify(disk))), set: (o) => Object.assign(disk, JSON.parse(JSON.stringify(o))) } } };
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
    a.type('m'); a.enter(); // count 1 -> 2
    assert.strictEqual(disk.dck_counts['/a/chat/s/xyz'], 2, 'count saved');
    a = await boot('https://chat.deepseek.com/a/chat/s/xyz', disk); // refresh
    a.type('m'); a.enter(); // count 2 -> 3
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

  console.log('\nall refresh/count tests passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
