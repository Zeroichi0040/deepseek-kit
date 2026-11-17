// Behaviour under bad conditions: slow sends, failing storage, corrupt stored data. Boots the real scripts in jsdom.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const scripts = ['lib.js', 'site.js', 'visuals.js', 'markdown.js', 'content.js'].map(read);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log('ok  ' + m);

// opts.get(cb) / opts.set(obj, cb, chrome) replace the storage mock; opts.html is the page body.
async function boot(stored, memories, opts) {
  opts = opts || {};
  const dom = new JSDOM('<!doctype html><body>' + (opts.html || '<div id="composer"><textarea></textarea><div role="button" id="attach"><svg></svg></div><div role="button" id="send"><svg></svg></div></div>') + '</body>', { url: 'https://chat.deepseek.com/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const saved = {};
  w.chrome = { runtime: {}, storage: { local: {
    get: (keys, cb) => (opts.get ? opts.get(cb, w.chrome) : cb({ dck_settings: stored, dck_memories: memories || [] })),
    set: (o, cb) => (opts.set ? opts.set(o, cb, w.chrome) : (Object.assign(saved, o), cb && cb())),
  } } };
  scripts.forEach((s) => w.eval(s));
  await sleep(80);
  const doc = w.document;
  return {
    w, doc, saved, drawer: doc.getElementById('dck-drawer'), ta: doc.querySelector('textarea'),
    type: (el, v) => { Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new w.Event('input', { bubbles: true })); },
    key: (el, k) => { const e = new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); el.dispatchEvent(e); return e; },
    toastText: () => (doc.getElementById('dck-toast') || {}).textContent || '',
  };
}
const hidden = { showInjected: false, defaultEnabled: false, visualsPrompt: false, prompts: [{ id: 'p', name: 'C', text: 'Be brief', enabled: true, schedule: 'first' }] };

(async () => {
  // a send the site accepts, but whose box empties slowly: the send button must NOT be pressed too
  {
    const a = await boot(hidden);
    let clicks = 0;
    a.doc.getElementById('send').addEventListener('click', () => clicks++);
    a.ta.addEventListener('keydown', () => { setTimeout(() => a.type(a.ta, ''), 900); });
    a.type(a.ta, 'hello');
    a.key(a.ta, 'Enter');
    await sleep(2200);
    assert.strictEqual(clicks, 0, 'no second send when the box cleared within the wait');
    ok('slow-clearing box: Enter is trusted, no double send');
  }
  // a send that never happens: one fallback click only, then a clear message to the user
  {
    const a = await boot(hidden);
    let clicks = 0;
    a.doc.getElementById('send').addEventListener('click', () => clicks++);
    a.type(a.ta, 'hello');
    a.key(a.ta, 'Enter');
    await sleep(3500);
    assert.strictEqual(clicks, 1, 'exactly one fallback click');
    assert.ok(/Could not confirm/.test(a.toastText()), a.toastText());
    ok('unconfirmed send: one fallback, then tells you');
  }
  // the fallback works and the box clears after it
  {
    const a = await boot(hidden);
    a.doc.getElementById('send').addEventListener('click', () => a.type(a.ta, ''));
    a.type(a.ta, 'hello');
    a.key(a.ta, 'Enter');
    await sleep(2200);
    assert.ok(!/Could not/.test(a.toastText()), 'no complaint when the fallback worked');
    ok('fallback send confirmed');
  }
  // storage write failure is reported, once, and shows in Diagnostics
  {
    const a = await boot({}, [], { set: (o, cb, c) => { c.runtime.lastError = { message: 'QUOTA_BYTES quota exceeded' }; cb && cb(); c.runtime.lastError = undefined; } });
    a.doc.getElementById('dck-fab').click();
    a.drawer.querySelector('[role=tab]:nth-child(4)').click();
    const accs = Array.from(a.drawer.querySelectorAll('.dck-acchead'));
    a.type(a.ta, 'x'); // any change that saves
    a.w.eval('document.getElementById("dck-fab").click()'); // close
    // toggling a setting saves
    a.w.eval('document.getElementById("dck-fab").click()');
    Array.from(a.drawer.querySelectorAll('[role=tab]')).find((t) => t.textContent.startsWith('Settings')).click();
    Array.from(a.drawer.querySelectorAll('.dck-acchead')).find((h) => h.textContent.startsWith('Messages')).click();
    a.drawer.querySelector('input[type=checkbox]').click();
    await sleep(100);
    assert.ok(/Could not save/.test(a.toastText()), 'toast: ' + a.toastText());
    Array.from(a.drawer.querySelectorAll('.dck-acchead')).find((h) => h.textContent.startsWith('Diagnostics')).click();
    assert.ok(/last write failed: QUOTA_BYTES/.test(a.drawer.textContent), 'Diagnostics shows the error');
    ok('failed storage write: toast and Diagnostics row');
  }
  // storage that errors on load, or hands back nothing, still boots
  {
    const a = await boot({}, [], { get: (cb, c) => { c.runtime.lastError = { message: 'Extension context invalidated' }; cb(undefined); c.runtime.lastError = undefined; } });
    assert.ok(a.doc.getElementById('dck-fab'), 'the Kit still mounts with defaults');
    const b = await boot({}, [], { get: () => { throw new Error('Extension context invalidated.'); } });
    assert.ok(b.doc.getElementById('dck-fab'), 'and when the call throws');
    assert.strictEqual(Object.keys(a.saved).length + Object.keys(b.saved).length, 0, 'a failed read seeds nothing and saves nothing, so real data is never overwritten');
    ok('load failures fall back to defaults');
  }
  // corrupt stored lists do not break the drawer
  {
    const a = await boot({ prompts: [null, 5, { name: 3 }], snippets: [null, 'x', { name: 'ok', text: 't' }] }, [null, 'junk', { key: 5 }, { key: 'AI', value: 'v' }]);
    a.doc.getElementById('dck-fab').click();
    const tabs = Array.from(a.drawer.querySelectorAll('[role=tab]'));
    for (const t of tabs) { t.click(); assert.ok(a.drawer.textContent.length > 50, 'tab renders: ' + t.textContent); }
    assert.ok(Array.from(a.drawer.querySelectorAll('[role=tab]')).length >= 4);
    ok('corrupt stored prompts, snippets and notes: every tab still renders');
  }
  // two textareas (edit-message + composer): the Kit works on the composer
  {
    const html = '<div id="chat"><textarea id="editbox"></textarea></div><div id="composer"><textarea id="comp"></textarea><div role="button" id="send"><svg></svg></div></div>';
    const a = await boot({ ...hidden, showInjected: true }, [], { html });
    const w = a.w;
    const rect = (id) => (id === 'comp' ? { top: 600, bottom: 640, left: 0, right: 300, width: 300, height: 40 } : { top: 50, bottom: 90, left: 0, right: 300, width: 300, height: 40 });
    w.HTMLElement.prototype.getBoundingClientRect = function () { return this.id ? rect(this.id) : { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; };
    w.HTMLElement.prototype.getClientRects = function () { return [rect(this.id)]; };
    const comp = a.doc.getElementById('comp');
    a.type(comp, 'hello');
    a.key(comp, 'Enter'); // visible mode: first Enter inserts context into the composer
    assert.ok(comp.value.includes('Be brief'), 'context went into the composer: ' + comp.value.slice(0, 40));
    assert.strictEqual(a.doc.getElementById('editbox').value, '', 'the edit box is untouched');
    ok('with an edit-message textarea open, context still goes to the composer');
  }
  console.log('\nall hardening tests passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
