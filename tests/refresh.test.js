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
  const dom = new JSDOM('<!doctype html><body>' + ((opts && opts.body) || '<div id="chat"></div><textarea></textarea><div role="button" id="send" aria-label="Send"><svg></svg></div>') + '</body>',
    { url: url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  if (!buses.has(disk)) buses.set(disk, []);
  const bus = buses.get(disk);
  // opts.delay: storage calls answer after that many ms (a read sees the disk as it was when it was asked, a write
  // lands when it finishes), which is what makes two tabs race. opts.locks: Web Locks shared by every tab on the disk.
  const delay = (opts && opts.delay) || 0;
  const later = (f) => (delay ? setTimeout(f, delay) : f());
  const local = {
    get: (k, cb) => { const snap = JSON.parse(JSON.stringify(disk)); later(() => cb(snap)); },
    set: (o, cb) => {
      const clean = JSON.parse(JSON.stringify(o));
      later(() => {
        const changes = {};
        Object.keys(clean).forEach((k) => { changes[k] = { oldValue: disk[k], newValue: clean[k] }; });
        Object.assign(disk, clean);
        bus.slice().forEach((f) => f(changes, 'local'));
        if (cb) cb();
      });
    },
  };
  if (opts && opts.locks) {
    const tail = buses.get(disk).lockTail || (buses.get(disk).lockTail = { p: Promise.resolve() });
    Object.defineProperty(w.navigator, 'locks', { value: { request: (name, fn) => { const r = tail.p.then(() => fn()); tail.p = r.catch(() => {}); return r; } } });
  }
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
    // what you do with the keyboard: the browser announces the edit (box still holds the old value), then changes it
    edit: (v) => {
      ta.dispatchEvent(new w.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: v ? 'insertText' : 'deleteContentBackward' }));
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
    await sleep(30);
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

  // 10. A message that really left from the new-chat screen is carried to its chat; one that did not is not
  {
    const disk = { dck_settings: { enabled: true, defaultEnabled: false, memoryEnabled: false, visualsPrompt: false, askPrompt: false, prompts: [] } };
    const a = await boot('https://chat.deepseek.com/', disk);
    a.type('hello'); a.enter(); a.type(''); await sleep(250); // the site takes it and clears the box
    a.w.history.pushState({}, '', '/a/chat/s/nav'); // and then moves to the chat's own address
    await sleep(650);
    assert.strictEqual(disk.dck_counts['/a/chat/s/nav'], 1, 'counted for the new chat: ' + JSON.stringify(disk.dck_counts));
    assert.ok(!('/' in disk.dck_counts), 'the new-chat screen kept nothing');
    console.log('ok  a message that left the new-chat screen is counted for its chat');
  }

  const hiddenSettings = () => ({ enabled: true, defaultEnabled: false, memoryEnabled: false, visualsPrompt: false, askPrompt: false, showInjected: false, prompts: [{ id: 'f', name: 'First only', text: 'Rule F', enabled: true, schedule: 'first' }] });
  const NEXT = 'https://chat.deepseek.com/';

  // 11. Two tabs on two chats write at the same moment (slow storage): both counters are kept
  {
    const disk = { dck_settings: settings() };
    const opts = { sync: true, delay: 40, locks: true };
    const a = await boot('https://chat.deepseek.com/a/chat/s/cA', disk, opts);
    const b = await boot('https://chat.deepseek.com/a/chat/s/cB', disk, opts);
    a.type('m'); a.enter(); b.type('m'); b.enter();
    a.type(''); b.type('');
    await sleep(600);
    assert.strictEqual(disk.dck_counts['/a/chat/s/cA'], 2, 'tab A kept: ' + JSON.stringify(disk.dck_counts));
    assert.strictEqual(disk.dck_counts['/a/chat/s/cB'], 2, 'tab B kept: ' + JSON.stringify(disk.dck_counts));
    console.log('ok  concurrent writes from two tabs on different chats keep both counters');
  }

  // 12. Two tabs send in the same chat at the same moment: both messages count
  {
    const disk = { dck_settings: settings(), dck_counts: { '/a/chat/s/same': 2 } };
    const opts = { sync: true, delay: 40, locks: true };
    const a = await boot('https://chat.deepseek.com/a/chat/s/same', disk, opts);
    const b = await boot('https://chat.deepseek.com/a/chat/s/same', disk, opts);
    a.type('m'); a.enter(); b.type('m'); b.enter();
    a.type(''); b.type('');
    await sleep(600);
    assert.strictEqual(disk.dck_counts['/a/chat/s/same'], 4, 'both messages counted: ' + JSON.stringify(disk.dck_counts));
    // and a chat neither tab has a record of: each adds 1 to the "already started" 1, nothing is counted twice
    const d2 = { dck_settings: settings() };
    const c = await boot('https://chat.deepseek.com/a/chat/s/new2', d2, opts);
    const d = await boot('https://chat.deepseek.com/a/chat/s/new2', d2, opts);
    c.type('m'); c.enter(); d.type('m'); d.enter();
    c.type(''); d.type('');
    await sleep(600);
    assert.strictEqual(d2.dck_counts['/a/chat/s/new2'], 3, 'unknown chat: 1 + 2 sends: ' + JSON.stringify(d2.dck_counts));
    console.log('ok  concurrent sends from two tabs in one chat count both');
  }

  // 13. Reset all while a save is still being written is not undone by that save
  {
    const disk = { dck_settings: settings(), dck_counts: { '/a/chat/s/rs': 4 } };
    const a = await boot('https://chat.deepseek.com/a/chat/s/rs', disk, { sync: true, delay: 80, locks: true });
    a.type('m'); a.enter(); a.type('');
    await sleep(140); // counted, and its save is waiting on the storage
    a.w.confirm = () => true;
    a.w.document.getElementById('dck-fab').click();
    Array.from(a.w.document.querySelectorAll('[role=tab]')).find((t) => t.textContent.startsWith('Settings')).click();
    Array.from(a.w.document.querySelectorAll('button')).find((t) => t.textContent.trim() === 'Reset all').click();
    await sleep(700);
    assert.strictEqual(JSON.stringify(disk.dck_counts), '{}', 'Reset still holds: ' + JSON.stringify(disk.dck_counts));
    console.log('ok  Reset all wins over an outstanding save');
  }

  // 14. You clear the draft yourself after an Enter the site ignored: that is not a message
  {
    const disk = { dck_settings: settings(), dck_counts: { '/a/chat/s/mc': 2 } };
    const a = await boot('https://chat.deepseek.com/a/chat/s/mc', disk);
    a.type('x'); a.enter(); // ignored by the site
    await sleep(300);
    a.edit(''); // select all + delete
    await sleep(400);
    assert.strictEqual(disk.dck_counts['/a/chat/s/mc'], 2, 'a manual clear is not a send: ' + JSON.stringify(disk.dck_counts));
    console.log('ok  clearing the draft by hand after an ignored Enter is not counted');
  }

  // 15. Two messages in quick succession are two messages
  {
    const disk = { dck_settings: settings(), dck_counts: { '/a/chat/s/rp': 2 } };
    const a = await boot('https://chat.deepseek.com/a/chat/s/rp', disk);
    a.type('one'); a.enter(); a.type(''); // the site takes it and clears the box ...
    a.edit('two'); a.enter(); a.type(''); // ... and you send the next one before the Kit looked
    await sleep(400);
    assert.strictEqual(disk.dck_counts['/a/chat/s/rp'], 4, 'both counted: ' + JSON.stringify(disk.dck_counts));
    // the same, when the box is refilled by the page instead of typed
    a.type('three'); a.enter(); a.type(''); a.type('four'); a.enter(); a.type('');
    await sleep(400);
    assert.strictEqual(disk.dck_counts['/a/chat/s/rp'], 6, 'both counted again: ' + JSON.stringify(disk.dck_counts));
    // pressing Enter twice on a message that has not left yet is still one message
    a.type('five'); a.enter(); a.enter(); a.type('');
    await sleep(400);
    assert.strictEqual(disk.dck_counts['/a/chat/s/rp'], 7, 'one message: ' + JSON.stringify(disk.dck_counts));
    console.log('ok  rapid consecutive sends are counted independently');
  }

  // 16. Automatic (hidden) send: the fallback click is dropped when you change the draft or move to another chat
  {
    const disk = { dck_settings: hiddenSettings() };
    const a = await boot(NEXT, disk);
    let clicks = 0;
    a.w.document.getElementById('send').addEventListener('click', () => clicks++);
    a.type('hello'); a.enter(); // hidden mode: context attached, Enter pressed for you, the site ignores it
    assert.ok(a.ta.value.includes('Rule F'), 'context attached');
    await sleep(500);
    a.edit(a.ta.value + ' and more');
    await sleep(2200);
    assert.strictEqual(clicks, 0, 'changing the draft cancels the automatic send');

    const b = await boot(NEXT, { dck_settings: hiddenSettings() });
    let clicks2 = 0;
    b.w.document.getElementById('send').addEventListener('click', () => clicks2++);
    b.type('hello'); b.enter();
    await sleep(500);
    b.w.history.pushState({}, '', '/a/chat/s/elsewhere');
    await sleep(2200);
    assert.strictEqual(clicks2, 0, 'moving to another chat cancels the automatic send');

    const c = await boot(NEXT, { dck_settings: hiddenSettings() });
    let clicks3 = 0;
    c.w.document.getElementById('send').addEventListener('click', () => clicks3++);
    c.type('hello'); c.enter();
    await sleep(2200);
    assert.strictEqual(clicks3, 1, 'left alone, the fallback still fires once');
    console.log('ok  an edited draft or a changed chat cancels the automatic send');
  }

  // 17. First-message context also applies to a send made with the mouse
  {
    const disk = { dck_settings: settings() };
    const a = await boot(NEXT, disk); // visible mode (default): context goes into the box for review
    a.type('hello');
    const send = a.w.document.getElementById('send');
    const first = new a.w.MouseEvent('click', { bubbles: true, cancelable: true });
    send.dispatchEvent(first);
    assert.ok(first.defaultPrevented, 'the first click only adds the context');
    assert.ok(a.ta.value.includes('Rule F'), 'context is in the box: ' + a.ta.value);
    const second = new a.w.MouseEvent('click', { bubbles: true, cancelable: true });
    send.dispatchEvent(second);
    assert.ok(!second.defaultPrevented, 'the second click sends');

    const h = await boot(NEXT, { dck_settings: hiddenSettings() }); // hidden mode: attached and sent in one step
    let enters = 0, clicked = 0;
    h.ta.addEventListener('keydown', (e) => { if (e.key === 'Enter') enters++; });
    h.w.document.getElementById('send').addEventListener('click', (e) => { clicked++; if (!e.defaultPrevented) { /* the site would send */ } });
    h.type('hello');
    const hc = new h.w.MouseEvent('click', { bubbles: true, cancelable: true });
    h.w.document.getElementById('send').dispatchEvent(hc);
    assert.ok(h.ta.value.includes('Rule F'), 'hidden mode attached the context on a click');
    await sleep(200);
    assert.strictEqual(enters, 1, 'and sent it');
    console.log('ok  a mouse send gets the first-message context like Enter');
  }

  // 18. Opening an existing chat from the new-chat screen after an Enter the site ignored makes no phantom message
  {
    const disk = { dck_settings: settings(), dck_counts: { '/a/chat/s/old': 2 } };
    const a = await boot(NEXT, disk);
    a.type('draft'); a.enter(); // ignored
    await sleep(200);
    a.w.history.pushState({}, '', '/a/chat/s/old'); // you click an old chat
    a.type(''); // and the page drops the draft
    await sleep(900);
    assert.strictEqual(disk.dck_counts['/a/chat/s/old'], 2, 'no phantom increment: ' + JSON.stringify(disk.dck_counts));
    console.log('ok  opening an old chat after an ignored Enter on the new-chat screen counts nothing');
  }

  // 19. Navigating from one chat to another after an ignored Enter does not count in either
  {
    const disk = { dck_settings: settings(), dck_counts: { '/a/chat/s/one': 2, '/a/chat/s/two': 2 } };
    const a = await boot('https://chat.deepseek.com/a/chat/s/one', disk);
    a.type('draft'); a.enter(); // ignored
    await sleep(200);
    a.w.history.pushState({}, '', '/a/chat/s/two');
    a.type('');
    await sleep(900);
    assert.deepStrictEqual(disk.dck_counts, { '/a/chat/s/one': 2, '/a/chat/s/two': 2 }, JSON.stringify(disk.dck_counts));
    console.log('ok  navigating away after an ignored Enter does not increment the count');
  }

  // 20. A click on an unrelated toolbar button is not a send: no context, no Enter (the site's send button has no name here,
  // so the right-most button is only a guess, which is fine for a fallback click but not for deciding a click was a send)
  {
    const body = '<div id="chat"></div><textarea></textarea><div role="button" id="go"><svg></svg></div><div role="button" id="toolbar" aria-label="Expert mode"><svg></svg></div>';
    const a = await boot(NEXT, { dck_settings: hiddenSettings() }, { body });
    let enters = 0;
    a.ta.addEventListener('keydown', (e) => { if (e.key === 'Enter') enters++; });
    a.type('hello');
    const tb = new a.w.MouseEvent('click', { bubbles: true, cancelable: true });
    a.w.document.getElementById('toolbar').dispatchEvent(tb);
    await sleep(300);
    assert.ok(!tb.defaultPrevented, 'the click is left alone');
    assert.strictEqual(a.ta.value, 'hello', 'no context inserted');
    assert.strictEqual(enters, 0, 'no synthetic Enter');
    const v = await boot(NEXT, { dck_settings: settings() }, { body }); // visible mode, same
    v.type('hello');
    v.w.document.getElementById('toolbar').dispatchEvent(new v.w.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.strictEqual(v.ta.value, 'hello', 'visible mode: nothing inserted either');
    console.log('ok  unrelated toolbar clicks never insert context or press Enter');
  }

  // 21. Reset all in one tab cancels increments another tab has counted but not saved yet
  {
    const disk = { dck_settings: settings(), dck_counts: { '/a/chat/s/x': 5 } };
    const a = await boot('https://chat.deepseek.com/a/chat/s/x', disk, { sync: true, delay: 10, locks: true });
    const b = await boot('https://chat.deepseek.com/a/chat/s/y', disk, { sync: true, delay: 60, locks: true });
    b.type('1'); b.enter(); b.type(''); // counted at ~100 ms, its save runs 100-220 ms
    await sleep(130);
    b.type('2'); b.enter(); b.type(''); // counted at ~230 ms - waits behind the first save
    await sleep(90);
    a.w.confirm = () => true; // Reset all in tab A at ~220 ms, before B's second save asks for the lock
    a.w.document.getElementById('dck-fab').click();
    Array.from(a.w.document.querySelectorAll('[role=tab]')).find((t) => t.textContent.startsWith('Settings')).click();
    Array.from(a.w.document.querySelectorAll('button')).find((t) => t.textContent.trim() === 'Reset all').click();
    await sleep(900);
    assert.strictEqual(JSON.stringify(disk.dck_counts), '{}', 'nothing from before the reset survives: ' + JSON.stringify(disk.dck_counts));
    console.log('ok  Reset all invalidates unsaved increments in other tabs');
  }

  console.log('\nall refresh/count tests passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
