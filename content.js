/* DeepSeek Kit - local-only, no network calls, no request patching.
 * It edits the text in your message box (and optionally hides its own inserted block in the chat view).
 * Pure logic lives in lib.js and everything that knows DeepSeek's markup lives in site.js; both load first. */
(function () {
  'use strict';

  const {
    BUILTIN_DEFAULT_PROMPT, VISUALS_PROMPT, ASK_PROMPT, askPromptText, cleanMemories, visualsPromptText, VARIABLES, migrateSettings, hasLegacyKeys, tokens, applyVariables, shouldInject,
    buildPrefix, summarize, describeSummary, memoryLabel, alreadyHasContext, stripContext, slashQuery, continueList,
    cleanSnippetName, filterSnippets, searchSnippets, describeSchedule, insertAt, defaultPromptText, newId,
    langFromClass, detectBlock, suggestFilename, uniqueName, makeZip, MEMORY_GENERAL, memoryStatuses,
    memoryTokens, groupMemories, cleanCategory, resolveCount, pruneCounts, MARKER_START,
  } = globalThis.DCK_LIB;
  const SITE = globalThis.DCK_SITE;
  const VIS = globalThis.DCK_VIS;
  const MD = globalThis.DCK_MD;
  const ASK = globalThis.DCK_ASK;

  // ---------- Extension runtime ----------
  const store = chrome.storage.local;
  // Every write goes through here so a failure (full storage, extension reloaded under an open tab) is told to you.
  const storage = { error: '', lastToast: 0 };
  function storageFailed(msg) {
    storage.error = String(msg || 'unknown error');
    if (Date.now() - storage.lastToast > 10000) {
      storage.lastToast = Date.now();
      toast('Could not save your changes (' + storage.error + '). If you reloaded the extension, reload this page.');
    }
    logEvent('Storage error: ' + storage.error);
  }
  function storeSet(obj) {
    try {
      store.set(obj, () => {
        const e = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError;
        if (e) storageFailed(e.message); else storage.error = '';
      });
    } catch (e) { storageFailed(e && e.message); }
  }
  // Where the Kit button lives: docked on one side edge, at a fraction of the window height.
  const FAB_DEFAULT = { side: 'right', y: 0.62 };
  let fabPos = { side: FAB_DEFAULT.side, y: FAB_DEFAULT.y };
  function cleanFab(v) {
    if (!v || typeof v !== 'object') return { side: FAB_DEFAULT.side, y: FAB_DEFAULT.y };
    const y = Number(v.y);
    return { side: v.side === 'left' ? 'left' : 'right', y: isFinite(y) ? Math.min(0.97, Math.max(0.03, y)) : FAB_DEFAULT.y };
  }
  const diag = { events: [], stripped: 0, started: Date.now() };
  function logEvent(msg) {
    diag.events.push({ t: new Date(), msg: msg });
    if (diag.events.length > 30) diag.events.shift();
  }
  let settings = migrateSettings({});
  let memories = [];
  const ui = { drawer: null, strip: null, tab: 'prompts', editingId: null, editingSnippetId: null, editingMemory: null, settingsOpen: null, search: '', showAllVars: false, preview: null, diagAll: false, diagEvents: false };
  let bypass = false; // true while we dispatch our own Enter
  let counts = {}; // messages sent per chat path, saved so a page refresh does not forget them
  let newChatCount = 0; // messages sent from the new-chat screen ("/") before the page moves to the chat's own URL
  let lastPath = location.pathname;

  function getCount(path) {
    return path === '/' ? newChatCount : resolveCount(counts, path);
  }
  function setCount(path, n) {
    if (path === '/') { newChatCount = n; return; }
    delete counts[path]; // re-insert so the most recent chats stay at the end
    counts[path] = n;
    counts = pruneCounts(counts, 300);
    storeSet({ dck_counts: counts });
  }

  function kitVersion() {
    try { return chrome.runtime.getManifest().version; } catch (e) { return '0.4.1'; }
  }

  function load() {
    return new Promise((resolve) => {
      const done = (r) => {
        r = r && typeof r === 'object' ? r : {};
        fabPos = cleanFab(r.dck_fab);
        settings = migrateSettings(r.dck_settings);
        memories = cleanMemories(r.dck_memories);
        let dirty = hasLegacyKeys(r.dck_settings) || (r.dck_settings && 'starterSeeded' in r.dck_settings);
        counts = r.dck_counts && typeof r.dck_counts === 'object' && !Array.isArray(r.dck_counts) ? r.dck_counts : {};
        if (dirty) save(); // write the migrated shape back once
        resolve();
      };
      try {
        store.get(['dck_settings', 'dck_memories', 'dck_counts', 'dck_fab'], (r) => {
          const e = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError;
          if (e) storage.error = e.message;
          done(r);
        });
      } catch (e) { storage.error = String((e && e.message) || e); done({}); }
    });
  }
  // Every save carries a fresh tag. Other tabs see the tag change and reload; this tab recognises its own tags and ignores them.
  const myRevs = [];
  function save() {
    const rev = newId();
    myRevs.push(rev);
    if (myRevs.length > 20) myRevs.shift();
    storeSet({ dck_settings: settings, dck_memories: memories, dck_rev: rev });
  }
  // Without this, a tab opened earlier keeps its old copy of your notes and overwrites newer ones on its next save.
  function listenForOtherTabs() {
    try {
      if (!chrome.storage.onChanged) return;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.dck_rev || myRevs.indexOf(changes.dck_rev.newValue) >= 0) return;
        const s = changes.dck_settings;
        const m = changes.dck_memories;
        if (s && s.newValue) settings = migrateSettings(s.newValue);
        if (m && Array.isArray(m.newValue)) memories = cleanMemories(m.newValue);
        const editing = ui.editingId !== null || ui.editingSnippetId !== null || ui.editingMemory !== null;
        ui.editingId = null; ui.editingSnippetId = null; ui.editingMemory = null;
        applyFold();
        render();
        syncAll();
        if (settings.showInjected === false) scheduleStrip([document.body]);
        logEvent('Updated from another tab');
        if (editing) toast('Updated from another tab - your open edit was closed');
      });
    } catch (e) { logEvent('Could not watch for changes from other tabs'); }
  }
  function commit() {
    save();
    applyFold(); // keeps the reasoning fold in step with the On switch and the Collapse reasoning setting
    refreshAll(true);
  }

  // A new chat lives at "/" until the first message creates /a/chat/s/<id>. Carry the count over only if a message
  // was really sent from "/"; opening an existing chat from there must not reset that chat's count.
  setInterval(() => {
    const p = location.pathname;
    if (p !== lastPath) {
      if (lastPath === '/' && p !== '/') {
        if (newChatCount > 0) setCount(p, newChatCount);
        newChatCount = 0;
      }
      lastPath = p;
    }
    if (!document.hidden) refreshAll(false); // nothing to lay out in a background tab
  }, 500);

  const getComposer = () => SITE.composer();

  function setNativeValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function selectionText() {
    try { return String(window.getSelection() || '').slice(0, 4000); } catch (e) { return ''; }
  }

  function chatCount() {
    return getCount(location.pathname);
  }

  function ctxFor(count) {
    return { now: new Date(), messageNumber: count + 1, selection: selectionText() };
  }

  function toast(msg) {
    let t = document.getElementById('dck-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'dck-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(toast._h);
    toast._h = setTimeout(() => (t.style.display = 'none'), 2800);
  }

  function insertContext(force) {
    const el = getComposer();
    if (!el) { logEvent('Message box not found'); toast('Message box not found'); return false; }
    const text = el.value;
    if (!text.trim()) { if (force) toast('Type a message first'); return false; }
    if (alreadyHasContext(text)) { if (force) toast('Context is already in the message'); return false; }
    const count = chatCount();
    if (!force && !shouldInject(settings, count)) return false;
    const prefix = buildPrefix(settings, memories, text, count, force, ctxFor(count));
    if (!prefix) { if (force) toast('Nothing to insert - switch on a prompt or add a memory note'); return false; }
    setNativeValue(el, prefix + text);
    logEvent('Context inserted (' + prefix.length + ' chars, message #' + count + ')');
    return true;
  }

  // ---------- Sending (used only by "hide inserted context" mode) ----------
  function clickSend(el) {
    const b = SITE.sendButton(el);
    if (!b) return false;
    b.click();
    return true;
  }

  // One Enter press from you -> context attached and the message sent. The send is confirmed by the box emptying
  // (we wait up to 1.5 s for the site to take the Enter); only if it did not, the send button is pressed once, and
  // then we wait again. If neither worked we ask you to press Enter. A second send is never attempted.
  const SEND_WAIT = 1500;
  function waitForSent(el, ms, done) {
    const t0 = Date.now();
    const tick = () => {
      if (!el.isConnected || !alreadyHasContext(el.value)) { done(true); return; }
      if (Date.now() - t0 >= ms) { done(false); return; }
      setTimeout(tick, 100);
    };
    setTimeout(tick, 100);
  }
  function triggerSend(el) {
    bypass = true;
    try {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    } finally {
      bypass = false;
    }
    waitForSent(el, SEND_WAIT, (sent) => {
      if (sent) { delete el.dataset.dckCounted; logEvent('Hidden send: message went out on Enter'); return; }
      if (!clickSend(el)) { logEvent('Hidden send failed: no send button found'); toast('Could not send automatically - press Enter to send'); return; }
      logEvent('Hidden send: used the send button');
      waitForSent(el, SEND_WAIT, (sent2) => {
        if (sent2) delete el.dataset.dckCounted;
        else { logEvent('Hidden send not confirmed'); toast('Could not confirm the message was sent - check it, then press Enter if needed'); }
      });
    });
  }

  // ---------- Chips above the message box + the strip in the drawer ----------
  const chips = { el: null, inline: false };
  let liveSig = '';

  function currentSummary() {
    const el = getComposer();
    const text = el ? stripContext(el.value) : '';
    return summarize(settings, memories, text, chatCount());
  }

  function renderStrip(sum) {
    if (!ui.strip) return;
    ui.strip.textContent = '';
    if (!settings.showSummary) { ui.strip.style.display = 'none'; return; }
    ui.strip.style.display = '';
    if (sum.state !== 'ready') {
      ui.strip.append(h('span', { class: 'dck-dot off' }), h('span', {}, describeSummary(sum)));
      return;
    }
    const text = h('span', { class: 'dck-grow' }, 'Next message includes ');
    sum.names.forEach((n, i) => { if (i) text.append(', '); text.append(h('b', {}, n)); });
    if (sum.memories) text.append(' + ' + memoryLabel(sum.memories));
    if (sum.skipped) text.append(' (' + sum.skipped + ' over budget)');
    ui.strip.append(h('span', { class: 'dck-dot' }), text, h('span', { class: 'dck-faint' }, '~' + sum.tokens + ' tokens'));
  }

  function renderChips(sum) {
    if (!settings.showChips) { if (chips.el) chips.el.style.display = 'none'; return; }
    if (!chips.el) {
      chips.el = h('div', { id: 'dck-chips' });
      document.body.append(chips.el);
    }
    chips.el.textContent = '';
    chips.el.append(h('span', { class: 'dck-chip kit' }, h('span', { class: 'dck-dot' }), 'Kit'));
    const note = (settings.showInjected !== false ? 'Visible' : 'Hidden') + (sum.state === 'ready' ? ' - ~' + sum.tokens + ' tokens' : '');
    chips.el.title = note;
    if (chips.inline) {
      // In the toolbar there is little room: one summary chip (cut with an ellipsis), the full detail in the tooltip.
      const parts = sum.state === 'ready' ? sum.names.slice() : [sum.state === 'off' ? 'Off' : 'Nothing due'];
      if (sum.state === 'ready' && sum.memories) parts.push(memoryLabel(sum.memories));
      if (sum.state === 'ready' && sum.skipped) parts.push(sum.skipped + ' over budget');
      chips.el.append(h('span', { class: 'dck-chip summary' + (sum.skipped ? ' warn' : '') }, parts.join(', ')));
      chips.el.append(h('span', { class: 'dck-chip mode' }, settings.showInjected !== false ? 'Visible' : 'Hidden'));
      return;
    }
    if (sum.state === 'ready') {
      sum.names.slice(0, 3).forEach((n) => chips.el.append(h('span', { class: 'dck-chip' }, n)));
      if (sum.names.length > 3) chips.el.append(h('span', { class: 'dck-chip' }, '+' + (sum.names.length - 3)));
      if (sum.memories) chips.el.append(h('span', { class: 'dck-chip' }, memoryLabel(sum.memories)));
      if (sum.skipped) chips.el.append(h('span', { class: 'dck-chip warn' }, sum.skipped + ' over budget'));
    } else {
      chips.el.append(h('span', { class: 'dck-chip' }, sum.state === 'off' ? 'Off' : 'Nothing due'));
    }
    chips.el.append(h('span', { class: 'dck-chips-note' }, note));
  }

  function composerRect(el) {
    const box = SITE.composerBox(el);
    return (box || el).getBoundingClientRect();
  }

  const CHIP_GAP = 12; // space between the chip row and the message box

  function positionChips() {
    if (!chips.el) return;
    const el = getComposer();
    const r = el ? composerRect(el) : null;
    const show = settings.enabled && settings.showChips && r && r.width > 0;
    if (!show) { chips.el.style.display = 'none'; return; }
    // Prefer the message box toolbar (no vertical space needed, so it can never touch the reply above or the heading).
    const pills = r.width >= 560 ? SITE.toolbarPills(SITE.composerBox(el)) : [];
    const pill = pills.length ? pills[pills.length - 1] : null; // the chip row goes after the last pill
    const wantInline = !!pill;
    if (wantInline !== chips.inline) { chips.inline = wantInline; liveSig = ''; refreshAll(true); return; }
    if (wantInline) {
      if (chips.el.previousElementSibling !== pill) pill.after(chips.el);
      chips.el.classList.add('inline');
      chips.el.style.cssText = '';
      return;
    }
    if (chips.el.parentElement !== document.body) document.body.append(chips.el);
    chips.el.classList.remove('inline');
    chips.el.style.display = 'flex';
    chips.el.style.left = Math.max(8, r.left + 4) + 'px';
    chips.el.style.width = Math.max(260, Math.min(r.width - 8, 760)) + 'px';
    chips.el.style.bottom = Math.max(8, window.innerHeight - r.top + CHIP_GAP) + 'px';
  }

  // The ZIP pill sits just above the message box, at its right end, so it never covers the toolbar or the chips.
  function placeZip() {
    const z = tools.zip;
    if (!z || z.style.display === 'none') return;
    const el = getComposer();
    const r = el ? composerRect(el) : null;
    if (!r || r.width <= 0) { z.style.right = '24px'; z.style.bottom = '24px'; return; }
    z.style.right = Math.max(8, window.innerWidth - r.right + 4) + 'px';
    z.style.bottom = Math.max(8, window.innerHeight - r.top + CHIP_GAP) + 'px';
  }

  function refreshAll(force) {
    applyFold(); // cheap and idempotent: puts the attribute back if the site ever removes it
    const sum = currentSummary();
    const sig = [settings.showInjected, settings.showSummary, settings.showChips, sum.state, sum.names.join('|'), sum.memories, sum.skipped, sum.tokens].join('~');
    if (force || sig !== liveSig) {
      liveSig = sig;
      renderStrip(sum);
      renderChips(sum);
    }
    positionChips();
    placeZip();
    if (visOn() || vis.list.length) syncVisuals(); // also ends the wait on a block that stopped changing
    updateMemoryStatus();
  }

  // ---------- Slash picker ----------
  const picker = { el: null, items: [], index: 0 };

  function pickerOpen() {
    return !!picker.el && picker.el.style.display !== 'none' && picker.items.length > 0;
  }
  function closePicker() {
    if (picker.el) picker.el.style.display = 'none';
    picker.items = [];
    picker.index = 0;
  }

  function renderPicker() {
    picker.el.textContent = '';
    picker.items.forEach((s, i) => {
      const preview = s.text.replace(/\s+/g, ' ').slice(0, 70);
      const row = h('div', { class: 'dck-pick' + (i === picker.index ? ' sel' : '') },
        h('span', { class: 'pn' }, '/' + s.name), h('span', { class: 'pp' }, preview));
      row.addEventListener('mousedown', (e) => { e.preventDefault(); chooseSnippet(s); });
      picker.el.append(row);
    });
    picker.el.append(h('div', { class: 'dck-pick-foot' }, h('span', {}, 'Up/Down to move'), h('span', {}, 'Enter to insert')));
  }

  function updatePicker() {
    const el = getComposer();
    if (!el || !settings.enabled) { closePicker(); return; }
    const q = slashQuery(el.value);
    if (q === null) { closePicker(); return; }
    const items = filterSnippets(settings.snippets, q, 8).filter((s) => (s.text || '').trim()); // skip blank snippets
    if (!items.length) { closePicker(); return; }
    picker.items = items;
    if (picker.index >= items.length) picker.index = 0;
    if (!picker.el) {
      picker.el = h('div', { id: 'dck-picker' });
      document.body.append(picker.el);
    }
    renderPicker();
    const r = composerRect(el);
    const lift = chips.el && chips.el.style.display !== 'none' ? CHIP_GAP + 34 : 10;
    picker.el.style.left = Math.max(8, r.left) + 'px';
    picker.el.style.width = Math.max(260, Math.min(r.width, 560)) + 'px';
    picker.el.style.bottom = Math.max(8, window.innerHeight - r.top + lift) + 'px';
    picker.el.style.display = 'block';
  }

  function chooseSnippet(s) {
    const el = getComposer();
    if (!el || !s) return;
    const text = applyVariables(s.text, ctxFor(chatCount()));
    closePicker();
    setNativeValue(el, text);
    el.focus();
    try { el.setSelectionRange(text.length, text.length); } catch (e) { /* ignore */ }
  }

  // Registered before the main Enter handler so the picker gets first pick of the keys.
  document.addEventListener(
    'keydown',
    (e) => {
      if (!pickerOpen() || !(e.target instanceof HTMLTextAreaElement)) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const n = picker.items.length;
        picker.index = (picker.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        renderPicker();
      } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing) {
        e.preventDefault();
        e.stopImmediatePropagation();
        chooseSnippet(picker.items[picker.index]);
      } else if (e.key === 'Escape') {
        closePicker();
      }
    },
    true
  );
  document.addEventListener('input', (e) => {
    if (e.target instanceof HTMLTextAreaElement && !e.target.closest('#dck-drawer, .dck-vis')) { updatePicker(); refreshAll(false); }
  }, true);

  // ---------- Lists in the message box: Shift+Enter continues a "1." / "-" / ">" list, on an empty item it leaves it ----------
  // The edit goes in through the browser's own text insertion, so Ctrl+Z still undoes it and the site sees normal input.
  function applyListEdit(el, edit) {
    const before = el.value;
    const want = before.slice(0, edit.from) + edit.insert + before.slice(edit.to);
    el.focus();
    el.setSelectionRange(edit.from, edit.to);
    let ok = false;
    try { ok = edit.insert ? document.execCommand('insertText', false, edit.insert) : document.execCommand('delete'); } catch (e) { ok = false; }
    if (!ok || el.value !== want) setNativeValue(el, want); // the browser would not do it: set the same result directly
    const caret = edit.from + edit.insert.length;
    try { el.setSelectionRange(caret, caret); } catch (e) { /* ignore */ }
  }
  document.addEventListener(
    'keydown',
    (e) => {
      if (bypass || e.key !== 'Enter' || !e.shiftKey || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!settings.enabled || !settings.listContinue) return;
      const el = e.target;
      if (!(el instanceof HTMLTextAreaElement) || el.closest('#dck-drawer, .dck-vis') || pickerOpen()) return;
      const edit = continueList(el.value, el.selectionStart, el.selectionEnd);
      if (!edit) return; // not in a list: Shift+Enter keeps its normal newline
      e.preventDefault();
      e.stopImmediatePropagation();
      applyListEdit(el, edit);
    },
    true
  );

  // ---------- Enter handling ----------
  document.addEventListener(
    'keydown',
    (e) => {
      if (bypass) return; // our own synthetic Enter
      const el = e.target;
      if (!(el instanceof HTMLTextAreaElement)) return;
      if (el.closest('#dck-drawer, .dck-vis')) return; // typing in the drawer or in a question form never triggers sends
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      if (!settings.enabled || !settings.autoInsertOnEnter) return;
      if (!el.value.trim()) return;
      const p = location.pathname;

      if (alreadyHasContext(el.value)) {
        // Context is already in the box: this Enter sends.
        if (el.dataset.dckCounted) delete el.dataset.dckCounted;
        else setCount(p, getCount(p) + 1);
        return;
      }
      const count = getCount(p);
      if (!shouldInject(settings, count)) {
        setCount(p, count + 1);
        return;
      }

      if (settings.showInjected !== false) {
        // Visible mode: put the context in the box, you review it and press Enter again.
        if (insertContext(false)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          toast('Context added - review it, then press Enter to send');
        } else {
          setCount(p, count + 1);
        }
        return;
      }

      // Hidden mode: attach the context and send in one step; the inserted block is hidden in the chat view.
      const prefix = buildPrefix(settings, memories, el.value, count, false, ctxFor(count));
      if (!prefix) { setCount(p, count + 1); return; }
      e.preventDefault();
      e.stopImmediatePropagation();
      setCount(p, count + 1);
      el.dataset.dckCounted = '1';
      setNativeValue(el, prefix + el.value);
      triggerSend(el);
    },
    true
  );

  // ---------- Hide the inserted block in the chat view (hidden mode only) ----------
  function stripNode(node) {
    if (node.nodeType === 3) {
      const par = node.parentElement;
      if (!par || par.closest('textarea, #dck-drawer, #dck-picker, #dck-chips, #dck-toast, .md-code-block, [class*="textarea__mirror"]')) return;
      // the site's hidden measuring copy of a box sits right next to its textarea (its class name varies): leave it alone
      if (par.parentElement && par.parentElement.querySelector(':scope > textarea')) return;
      if (node.nodeValue && node.nodeValue.indexOf(MARKER_START) !== -1) {
        const v = stripContext(node.nodeValue);
        if (v !== node.nodeValue) { node.nodeValue = v; diag.stripped += 1; }
      }
    } else if (node.nodeType === 1) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const hits = [];
      let n;
      while ((n = walker.nextNode())) hits.push(n);
      hits.forEach(stripNode);
    }
  }

  let stripPending = new Set();
  let stripQueued = false;
  function scheduleStrip(nodes) {
    nodes.forEach((n) => stripPending.add(n));
    if (stripQueued) return;
    stripQueued = true;
    requestAnimationFrame(() => {
      stripQueued = false;
      const batch = Array.from(stripPending);
      stripPending = new Set();
      batch.forEach((n) => { if (n.isConnected) stripNode(n); });
    });
  }

  function startObserver() {
    new MutationObserver((records) => {
      if (settings.codeTools !== false || settings.lineNumbers) scheduleCodeScan();
      if (settings.collapseThinking) scheduleThinkScan();
      if (settings.collapseLong) scheduleCollapseScan();
      if (visOn() || vis.list.length) scheduleVisScan();
      if (settings.showInjected !== false) return;
      const nodes = [];
      records.forEach((r) => {
        if (r.type === 'attributes') return;
        if (r.type === 'characterData') nodes.push(r.target);
        else r.addedNodes.forEach((n) => nodes.push(n));
      });
      if (nodes.length) scheduleStrip(nodes);
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'aria-disabled', 'disabled'] });
  }

  // ---------- UI helpers ----------
  const SVGNS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    close: 'M18 6 6 18|M6 6l12 12',
    chev: 'M6 9l6 6 6-6',
    eye: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z|M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    code: 'M16 18l6-6-6-6|M8 6l-6 6 6 6',
    expand: 'M15 3h6v6|M9 21H3v-6|M21 3l-7 7|M3 21l7-7',
    check: 'M20 6 9 17l-5-5',
    archive: 'M21 8v13H3V8|M1 3h22v5H1z|M10 12h4',
    shrink: 'M4 14h6v6|M20 10h-6V4|M14 10l7-7|M3 21l7-7',
    edit: 'M12 20h9|M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
    trash: 'M3 6h18|M8 6V4h8v2|M7 6l1 14h8l1-14',
    plus: 'M12 5v14|M5 12h14',
    search: 'M21 21l-4.3-4.3|M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z',
    down: 'M12 3v12|M12 15l-4-4|M12 15l4-4|M4 21h16',
    up: 'M12 15V3|M12 3L8 7|M12 3l4 4|M4 21h16',
  };

  function icon(name, size) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('width', size || 16);
    s.setAttribute('height', size || 16);
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    ICONS[name].split('|').forEach((d) => {
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', d);
      s.append(p);
    });
    return s;
  }

  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k === 'style' || k === 'role' || k === 'list' || k.indexOf('aria-') === 0 || k.indexOf('data-') === 0) n.setAttribute(k, v);
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), v);
      else n[k] = v;
    }
    for (const c of kids.flat()) {
      if (c === null || c === undefined || c === false) continue;
      n.append(c && c.nodeType ? c : document.createTextNode(String(c)));
    }
    return n;
  }

  function sw(checked, onchange, label) {
    return h('label', { class: 'dck-switch' },
      h('input', { type: 'checkbox', checked: !!checked, 'aria-label': label, onchange: (e) => onchange(e.target.checked) }),
      h('span', { class: 'dck-slider' }));
  }

  function iconBtn(name, label, onclick) {
    return h('button', { type: 'button', class: 'dck-iconbtn', 'aria-label': label, onclick: onclick }, icon(name));
  }

  function group(text) {
    return h('div', { class: 'dck-group' }, text);
  }

  function toggleCard(title, sub, checked, onchange) {
    return h('div', { class: 'dck-card dck-rowcard' },
      h('div', { class: 'dck-grow' }, h('div', { class: 'dck-name' }, title), h('div', { class: 'dck-sub' }, sub)),
      sw(checked, onchange, title));
  }

  function scheduleSelect(value, onchange, label) {
    return h('select', { 'aria-label': label || 'Schedule', onchange: (e) => onchange(e.target.value) },
      h('option', { value: 'first', selected: value === 'first' }, 'First message'),
      h('option', { value: 'every', selected: value === 'every' }, 'Every N messages'),
      h('option', { value: 'always', selected: value === 'always' }, 'Every message'));
  }

  // Inserts {{name}} at the caret of a textarea. Expanding the list redraws only this row, so unsaved typing survives.
  function varChips(target) {
    const wrap = h('div', { class: 'dck-chiprow' });
    const fill = () => {
      wrap.textContent = '';
      wrap.append(h('span', { class: 'dck-faint' }, 'Insert'));
      const list = ui.showAllVars ? VARIABLES : VARIABLES.slice(0, 4);
      list.forEach((v) => {
        wrap.append(h('button', {
          type: 'button',
          class: 'dck-vchip',
          onclick: () => {
            const r = insertAt(target.value, target.selectionStart, target.selectionEnd, '{{' + v.name + '}}');
            target.value = r.value;
            target.focus();
            try { target.setSelectionRange(r.caret, r.caret); } catch (e) { /* ignore */ }
          },
        }, '{{' + v.name + '}}'));
      });
      if (VARIABLES.length > 4) {
        wrap.append(h('button', { type: 'button', class: 'dck-vchip plain', onclick: () => { ui.showAllVars = !ui.showAllVars; fill(); } },
          ui.showAllVars ? 'Less' : '+' + (VARIABLES.length - 4)));
      }
    };
    fill();
    return wrap;
  }

  // ---------- Prompts tab ----------
  // The two prompts that ship with the Kit. Each keeps its switch, text override and schedule in its own settings keys.
  const BUILTINS = {
    default: { name: 'Default', on: 'defaultEnabled', text: 'defaultText', sched: 'defaultSchedule', every: 'defaultEveryN', base: () => BUILTIN_DEFAULT_PROMPT, current: () => defaultPromptText(settings) },
    ask: { name: 'Questions', on: 'askPrompt', text: 'askText', sched: 'askSchedule', every: 'askEveryN', base: () => ASK_PROMPT, current: () => askPromptText(settings) },
    visuals: { name: 'Visuals', on: 'visualsPrompt', text: 'visualsText', sched: 'visualsSchedule', every: 'visualsEveryN', base: () => VISUALS_PROMPT, current: () => visualsPromptText(settings) },
  };

  function promptRow(p, builtin) {
    const b = builtin ? BUILTINS[builtin] : null;
    const name = b ? b.name : (p.name || 'Untitled');
    const customized = b && (settings[b.text] || '').trim();
    return h('div', { class: 'dck-card dck-rowcard' },
      sw(b ? settings[b.on] !== false : p.enabled, (v) => {
        if (b) settings[b.on] = v; else p.enabled = v;
        commit();
      }, 'Enable ' + name + ' prompt'),
      h('div', { class: 'dck-grow' },
        h('div', { class: 'dck-name' }, name,
          b ? h('span', { class: 'dck-badge' }, customized ? 'Customized' : 'Built-in') : null),
        h('div', { class: 'dck-sub' }, b ? describeSchedule(settings[b.sched], settings[b.every]) : describeSchedule(p.schedule, p.everyN))),
      iconBtn('edit', 'Edit ' + name + ' prompt', () => { ui.editingId = b ? builtin : p.id; render(); }));
  }

  function promptEditor(p, builtin) {
    const b = builtin ? BUILTINS[builtin] : null;
    const name = h('input', { value: b ? '' : (p.name || ''), placeholder: 'Name', 'aria-label': 'Prompt name', style: b ? 'display:none' : '' });
    const text = h('textarea', { value: b ? b.current() : p.text, placeholder: 'Prompt text', 'aria-label': 'Prompt text' });
    let sched = b ? (settings[b.sched] || 'first') : (p.schedule || 'first');
    const everyN = h('input', { type: 'number', min: 1, value: b ? (settings[b.every] || 5) : (p.everyN || 5), 'aria-label': 'Every N messages', style: sched === 'every' ? '' : 'display:none' });
    const sel = scheduleSelect(sched, (v) => { sched = v; everyN.style.display = v === 'every' ? '' : 'none'; });
    return h('div', { class: 'dck-card dck-editor' },
      name, text, varChips(text), sel, everyN,
      h('div', { class: 'dck-actions' },
        h('button', {
          type: 'button', class: 'dck-btn primary',
          onclick: () => {
            const n = Math.max(1, parseInt(everyN.value, 10) || 5);
            if (b) {
              settings[b.text] = text.value.trim() === b.base().trim() ? '' : text.value;
              settings[b.sched] = sched;
              settings[b.every] = n;
            } else {
              p.name = name.value.trim() || 'Untitled';
              p.text = text.value;
              p.schedule = sched;
              p.everyN = n;
            }
            ui.editingId = null; commit(); render();
          },
        }, 'Save'),
        h('button', { type: 'button', class: 'dck-btn', onclick: () => { ui.editingId = null; render(); } }, 'Cancel'),
        b
          ? h('button', { type: 'button', class: 'dck-btn danger push', onclick: () => { settings[b.text] = ''; ui.editingId = null; commit(); render(); } }, 'Reset to built-in')
          : h('button', { type: 'button', class: 'dck-btn danger push', onclick: () => { settings.prompts = settings.prompts.filter((x) => x.id !== p.id); ui.editingId = null; commit(); render(); } }, 'Delete')));
  }

  function renderPrompts(body) {
    body.append(group('Built-in'));
    Object.keys(BUILTINS).forEach((id) => body.append(ui.editingId === id ? promptEditor(null, id) : promptRow(null, id)));
    body.append(group('Yours'));
    settings.prompts.forEach((p) => body.append(ui.editingId === p.id ? promptEditor(p, false) : promptRow(p, false)));
    body.append(h('button', {
      type: 'button', class: 'dck-btn dashed',
      onclick: () => {
        const p = { id: newId(), name: 'New prompt', text: '', enabled: true, schedule: 'first', everyN: 5 };
        settings.prompts.push(p); ui.editingId = p.id; commit(); render();
      },
    }, icon('plus'), 'New prompt'));
  }

  // ---------- Memory tab ----------
  const STATUS_INFO = {
    included: { label: 'In next message', cls: 'on' },
    idle: { label: 'Not mentioned', cls: '' },
    budget: { label: 'Over budget', cls: 'warn' },
    off: { label: 'Off', cls: '' },
    paused: { label: 'Paused', cls: '' },
  };

  function memoryTexts() {
    const el = getComposer();
    return el ? stripContext(el.value) : '';
  }

  // Refreshes the per-note status badges and the budget line without redrawing the tab.
  function updateMemoryStatus() {
    if (!ui.drawer || ui.tab !== 'memory') return;
    const text = memoryTexts();
    const st = memoryStatuses(settings, memories, text);
    ui.drawer.querySelectorAll('.dck-status').forEach((n) => {
      const info = STATUS_INFO[st[Number(n.getAttribute('data-mi'))]] || STATUS_INFO.idle;
      n.className = 'dck-status ' + info.cls;
      n.textContent = info.label;
    });
    const line = ui.drawer.querySelector('#dck-membudget');
    if (line) {
      const used = memoryTokens(settings, memories, text);
      line.textContent = settings.memoryBudget > 0 ? '~' + used + ' of ' + settings.memoryBudget + ' tokens in the next message' : '~' + used + ' tokens in the next message';
    }
  }

  function memoryRow(m, index) {
    const info = STATUS_INFO.idle;
    return h('div', { class: 'dck-card dck-rowcard' },
      sw(m.enabled !== false, (v) => { m.enabled = v; commit(); }, 'Enable ' + m.key),
      h('div', { class: 'dck-grow' },
        h('div', { class: 'dck-name' }, m.key, h('span', { class: 'dck-status ' + info.cls, 'data-mi': String(index) }, info.label)),
        h('div', { class: 'dck-sub clip' }, m.value),
        h('div', { class: 'dck-sub' }, m.importance === 'always' ? 'Always included' : 'Included when mentioned')),
      iconBtn('edit', 'Edit ' + m.key, () => { ui.editingMemory = index; render(); }));
  }

  function memoryEditor(m, index) {
    const key = h('input', { value: m.key, placeholder: 'Key', 'aria-label': 'Key' });
    const val = h('textarea', { value: m.value, placeholder: 'Value', 'aria-label': 'Value', rows: 3 });
    const cat = h('input', { value: String(m.category || ''), placeholder: 'Category (optional)', 'aria-label': 'Category', list: 'dck-cats' });
    const imp = h('select', { 'aria-label': 'When to include' },
      h('option', { value: 'always', selected: m.importance === 'always' }, 'Always'),
      h('option', { value: 'called', selected: m.importance !== 'always' }, 'When mentioned'));
    return h('div', { class: 'dck-card dck-editor active' },
      key, val, cat, imp,
      h('div', { class: 'dck-actions' },
        h('button', {
          type: 'button', class: 'dck-btn primary',
          onclick: () => {
            if (!key.value.trim() || !val.value.trim()) { toast('A note needs a key and a value'); return; }
            m.key = key.value.trim();
            m.value = val.value.trim();
            m.category = cleanCategory(cat.value, memories.filter((x) => x !== m));
            m.importance = imp.value;
            ui.editingMemory = null; commit(); render();
          },
        }, 'Save'),
        h('button', { type: 'button', class: 'dck-btn', onclick: () => { ui.editingMemory = null; render(); } }, 'Cancel'),
        h('button', { type: 'button', class: 'dck-btn danger push', onclick: () => { memories.splice(index, 1); ui.editingMemory = null; commit(); render(); } }, 'Delete')));
  }

  function renderMemory(body) {
    body.append(toggleCard('Use memory', 'Notes are added whenever context is inserted', settings.memoryEnabled, (v) => { settings.memoryEnabled = v; commit(); }));

    const budget = h('input', { type: 'number', min: 0, step: 50, value: settings.memoryBudget || 0, 'aria-label': 'Memory token budget', class: 'dck-budgetin' });
    budget.addEventListener('change', () => {
      settings.memoryBudget = Math.max(0, parseInt(budget.value, 10) || 0);
      budget.value = settings.memoryBudget;
      commit();
    });
    body.append(h('div', { class: 'dck-card' },
      h('div', { class: 'dck-rowcard' },
        h('div', { class: 'dck-grow' }, h('div', { class: 'dck-name' }, 'Token budget'), h('div', { class: 'dck-sub' }, 'Most memory added to one message. 0 = no limit')),
        budget),
      h('div', { class: 'dck-sub', id: 'dck-membudget' }, '')));

    const cats = Array.from(new Set(memories.map((m) => String((m && m.category) || '').trim()).filter(Boolean)));
    body.append(h('datalist', { id: 'dck-cats' }, cats.map((c) => h('option', { value: c }))));

    if (!memories.length) body.append(group('Notes'), h('div', { class: 'dck-hint' }, 'No notes yet. Add one below.'));
    const groups = groupMemories(memories);
    const labelled = groups.length > 1 || (groups[0] && groups[0].category !== MEMORY_GENERAL);
    groups.forEach((g) => {
      body.append(group(labelled ? g.category : 'Notes'));
      g.items.forEach((it) => body.append(ui.editingMemory === it.index ? memoryEditor(it.m, it.index) : memoryRow(it.m, it.index)));
    });

    const key = h('input', { placeholder: 'Key, e.g. my city', 'aria-label': 'New note key' });
    const val = h('input', { placeholder: 'Value', 'aria-label': 'New note value' });
    const cat = h('input', { placeholder: 'Category (optional)', 'aria-label': 'New note category', list: 'dck-cats' });
    const imp = h('select', { 'aria-label': 'New note: when to include' },
      h('option', { value: 'always' }, 'Always'),
      h('option', { value: 'called' }, 'When mentioned'));
    body.append(h('div', { class: 'dck-card dashed-card' },
      h('div', { class: 'dck-two' }, key, val),
      cat,
      h('div', { class: 'dck-two' }, imp, h('button', {
        type: 'button', class: 'dck-btn primary',
        onclick: () => {
          if (!key.value.trim() || !val.value.trim()) { toast('Add a key and a value'); return; }
          memories.push({ key: key.value.trim(), value: val.value.trim(), importance: imp.value, category: cleanCategory(cat.value, memories), enabled: true });
          commit(); render();
        },
      }, icon('plus', 14), 'Add'))));
    updateMemoryStatus();
  }

  // ---------- Snippets tab ----------
  function snippetEditor(s) {
    const name = h('input', { value: s.name, placeholder: 'name (used after the /)', 'aria-label': 'Snippet name' });
    const text = h('textarea', { value: s.text, placeholder: 'Snippet text', 'aria-label': 'Snippet text' });
    return h('div', { class: 'dck-card dck-editor active' },
      h('div', { class: 'dck-slashname' }, h('span', {}, '/'), name),
      text, varChips(text),
      h('div', { class: 'dck-actions' },
        h('button', {
          type: 'button', class: 'dck-btn primary',
          onclick: () => {
            const nm = cleanSnippetName(name.value);
            if (!nm) { toast('Give the snippet a name'); return; }
            s.name = nm; s.text = text.value; ui.editingSnippetId = null; commit(); render();
          },
        }, 'Save'),
        h('button', { type: 'button', class: 'dck-btn', onclick: () => { ui.editingSnippetId = null; render(); } }, 'Cancel'),
        h('button', { type: 'button', class: 'dck-btn danger push', onclick: () => { settings.snippets = settings.snippets.filter((x) => x.id !== s.id); ui.editingSnippetId = null; commit(); render(); } }, 'Delete')));
  }

  function renderSnippets(body) {
    const search = h('input', { class: 'dck-search', value: ui.search, placeholder: 'Search snippets, or type / in chat', 'aria-label': 'Search snippets' });
    search.addEventListener('input', () => {
      ui.search = search.value;
      render();
      const again = ui.drawer.querySelector('.dck-search');
      if (again) { again.focus(); try { again.setSelectionRange(again.value.length, again.value.length); } catch (e) { /* ignore */ } }
    });
    body.append(h('div', { class: 'dck-searchwrap' }, h('span', { class: 'dck-searchicon' }, icon('search')), search));

    const editing = settings.snippets.find((s) => s.id === ui.editingSnippetId);
    if (editing) body.append(snippetEditor(editing));

    const list = searchSnippets(settings.snippets, ui.search).filter((s) => s.id !== ui.editingSnippetId);
    list.forEach((s) => {
      body.append(h('div', { class: 'dck-card dck-rowcard' },
        h('div', { class: 'dck-grow' },
          h('div', { class: 'dck-name' }, '/' + s.name),
          h('div', { class: 'dck-sub clip' }, s.text.replace(/\s+/g, ' ').slice(0, 90))),
        iconBtn('edit', 'Edit /' + s.name, () => { ui.editingSnippetId = s.id; render(); })));
    });
    if (!list.length && !editing) {
      body.append(h('div', { class: 'dck-hint' }, settings.snippets.length ? 'No snippets match your search.' : 'No snippets yet. Type / in the message box to pick one once you add some.'));
    }
  }

  // ---------- Settings tab ----------
  // ---------- Diagnostics ----------
  function diagnostics() {
    const p = SITE.probe();
    const rows = [];
    const add = (label, ok, detail) => rows.push({ label: label, ok: ok, detail: detail });
    const hidden = settings.showInjected === false;
    add('Message box', p.composer, p.composer ? '<' + p.composerTag + '>' + (p.box ? ', rounded box found (' + p.boxWidth + 'px wide)' : ', rounded box not found') : 'not found - the site may have changed');
    add('Send button', p.send ? true : (hidden ? false : null), p.send ? 'found' : (hidden ? 'not found - Hidden mode cannot press send' : 'not found (only needed in Hidden mode)'));
    add('Toolbar pills', settings.showChips === false ? null : (p.pills > 0 ? true : null), p.pills + ' found (DeepThink, Search)' + (p.pills || settings.showChips === false ? '' : ' - chips will sit above the box'));
    add('Chip row', settings.showChips === false ? null : !!document.getElementById('dck-chips'), settings.showChips === false ? 'turned off' : (chips.inline ? 'in the message box toolbar' : 'above the message box (toolbar not found or box too narrow)'));
    const vOn = chartsOn();
    add('Widget sandbox', !vOn ? null : (vis.sandbox === 'ok' ? true : vis.sandbox === 'blocked' ? false : null), !vOn ? 'visuals are off' : vis.sandbox === 'ok' ? 'isolated frames run scripts here' : vis.sandbox === 'blocked' ? 'blocked on this page - charts still work, widgets will not' : 'checking...');
    add('Visuals on page', null, vOn ? vis.list.filter((x) => x.kind !== 'ask').length + ' chart/viz block(s), ' + vis.list.filter((x) => x.kind !== 'ask' && x.rendered).length + ' drawn, ' + vis.list.filter((x) => x.kind !== 'ask' && x.error).length + ' with an error' : 'off');
    add('Question forms', null, settings.askEnabled === false ? 'off' : vis.list.filter((x) => x.kind === 'ask').length + ' on this page, ' + vis.list.filter((x) => x.kind === 'ask' && x.error).length + ' with an error');
    add('Storage', storage.error ? false : null, storage.error ? 'last write failed: ' + storage.error : 'writes OK');
    add('Hidden-mode cleanup', null, hidden ? 'on, ' + diag.stripped + ' block(s) hidden this session' : 'off (context is Visible)');
    const toolsState = settings.codeTools === false ? 'tools off' : 'tools on';
    add('Code block headers', settings.codeTools === false || !p.codeBlocks ? null : p.codeHeaders === p.codeBlocks, p.codeBlocks + ' code block(s), ' + p.codeHeaders + ' with a Copy button found, ' + toolsState);
    add('Reasoning blocks', null, p.reasoning + ' found (' + p.reasoningOpen + ' open), fold ' + (document.documentElement.hasAttribute('data-dck-fold') ? 'on' : 'off'));
    add('Chat', null, chatPathLabel() + ', message count ' + chatCount());
    let bytes = 0;
    try { bytes = JSON.stringify({ settings, memories, counts }).length; } catch (e) { bytes = 0; }
    add('Stored data', null, memories.length + ' notes, ' + (settings.snippets || []).length + ' snippets, ' + Object.keys(counts || {}).length + ' chats counted, ~' + (bytes / 1024).toFixed(1) + ' KB');
    return rows;
  }

  function chatPathLabel() { return location.pathname === '/' ? 'new chat' : 'existing chat'; }

  function diagnosticsText() {
    const manifest = chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest() : { version: '?' };
    const lines = ['DeepSeek Kit ' + manifest.version, 'Page: ' + location.pathname.replace(/[^/]+$/, '<id>'), 'Browser: ' + navigator.userAgent, ''];
    diagnostics().forEach((r) => lines.push((r.ok === true ? '[ok]   ' : r.ok === false ? '[FAIL] ' : '[info] ') + r.label + ': ' + r.detail));
    lines.push('', 'Recent events:');
    diag.events.forEach((e) => lines.push('  ' + e.t.toTimeString().slice(0, 8) + ' ' + e.msg));
    if (!diag.events.length) lines.push('  (none)');
    return lines.join('\n');
  }

  function renderDiagnostics(body) {
    const rows = diagnostics();
    const bad = rows.filter((r) => r.ok === false);
    const rest = rows.filter((r) => r.ok !== false);
    const dot = (r) => h('span', { class: 'dck-diagdot ' + (r.ok === true ? 'ok' : r.ok === false ? 'bad' : 'info') });
    const line = (r, compact) => h('div', { class: 'dck-diagrow' + (compact ? ' compact' : '') }, dot(r), h('div', { class: 'dck-grow' }, h('div', { class: 'dck-name' }, r.label), h('div', { class: 'dck-sub' }, r.detail)));
    const toggle = (label, open, flip) => h('button', { type: 'button', class: 'dck-diagtoggle' + (open ? ' open' : ''), 'aria-expanded': open ? 'true' : 'false', onclick: () => { flip(); render(); } }, icon('chev', 14), label);
    const card = h('div', { class: 'dck-diag' });
    if (!bad.length) card.append(h('div', { class: 'dck-diagsum ok' }, dot({ ok: true }), 'Everything found')); // with problems, the section header already says how many
    bad.forEach((r) => card.append(line(r, false)));
    card.append(toggle((bad.length ? 'Other checks (' : 'All checks (') + rest.length + ')', ui.diagAll, () => { ui.diagAll = !ui.diagAll; }));
    if (ui.diagAll) rest.forEach((r) => card.append(line(r, true)));
    card.append(toggle('Recent events (' + diag.events.length + ')', ui.diagEvents, () => { ui.diagEvents = !ui.diagEvents; }));
    if (ui.diagEvents) {
      if (!diag.events.length) card.append(h('div', { class: 'dck-sub' }, 'Nothing yet this session.'));
      diag.events.slice(-8).reverse().forEach((e) => card.append(h('div', { class: 'dck-sub dck-diagevent' }, e.t.toTimeString().slice(0, 8) + '  ' + e.msg)));
    }
    body.append(card);
    body.append(h('div', { class: 'dck-two' },
      h('button', { type: 'button', class: 'dck-btn', onclick: () => { render(); if (chartsOn()) runSandboxProbe().then(() => render()); } }, 'Refresh'),
      h('button', {
        type: 'button', class: 'dck-btn',
        onclick: () => {
          const text = diagnosticsText();
          const done = () => toast('Report copied (no message text included)');
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => toast('Could not copy'));
          else toast('Could not copy');
        },
      }, 'Copy report')));
  }

  function settingRow(title, sub, checked, onchange) {
    return h('div', { class: 'dck-setrow' },
      h('div', { class: 'dck-grow' }, h('div', { class: 'dck-name' }, title), h('div', { class: 'dck-sub' }, sub)),
      sw(checked, onchange, title));
  }

  function accordion(id, title, sub, buildBody) {
    const open = ui.settingsOpen === id;
    const wrap = h('div', { class: 'dck-acc' + (open ? ' open' : '') },
      h('button', {
        type: 'button', class: 'dck-acchead', 'aria-expanded': open ? 'true' : 'false',
        onclick: () => { ui.settingsOpen = open ? null : id; render(); },
      },
        h('div', { class: 'dck-grow' }, h('div', { class: 'dck-name' }, title), h('div', { class: 'dck-sub' }, sub)),
        icon('chev')));
    if (open) { const box = h('div', { class: 'dck-accbody' }); buildBody(box); wrap.append(box); }
    return wrap;
  }

  function renderSettings(body) {
    const onCount = (list) => list.filter(Boolean).length + ' of ' + list.length + ' on';
    body.append(accordion('messages', 'Messages', onCount([settings.autoInsertOnEnter, settings.showSummary, settings.showChips, !!settings.collapseThinking, !!settings.listContinue]), (box) => {
      box.append(settingRow('Continue lists with Shift+Enter', 'In the message box, Shift+Enter on a "1.", "-" or ">" line starts the next item; on an empty item it ends the list', !!settings.listContinue, (v) => { settings.listContinue = v; commit(); }));
      box.append(settingRow('Insert context on Enter', 'Off: use the Insert now button only', settings.autoInsertOnEnter, (v) => { settings.autoInsertOnEnter = v; commit(); }));
      box.append(settingRow('Next-message summary', 'The strip under the header', settings.showSummary, (v) => { settings.showSummary = v; commit(); }));
      box.append(settingRow('Collapse reasoning', 'Folds DeepThink blocks to their header while thinking and when finished, also after a refresh. Click a header to open it', !!settings.collapseThinking, (v) => { settings.collapseThinking = v; commit(); }));
      box.append(settingRow('Chips in the toolbar', 'Shows what will be attached, next to DeepThink and Search', settings.showChips !== false, (v) => { settings.showChips = v; commit(); liveSig = ''; refreshAll(true); }));
      box.append(h('div', { class: 'dck-setrow' },
        h('div', { class: 'dck-grow' }, h('div', { class: 'dck-name' }, 'Kit button position'), h('div', { class: 'dck-sub' }, 'Drag the button to move it; it docks to the nearest side')),
        h('button', { type: 'button', class: 'dck-btn', onclick: () => { resetFab(); toast('Button position reset'); } }, 'Reset')));
    }));

    body.append(accordion('code', 'Code blocks', settings.codeTools === false ? 'Off' : 'Collapse, ZIP, preview and line numbers', (box) => {
      box.append(settingRow('Code block tools', 'Adds Collapse and + ZIP next to Copy and Download', settings.codeTools !== false, (v) => {
        settings.codeTools = v;
        commit(); syncAll();
      }));
      box.append(settingRow('Line numbers', 'Number the lines of code blocks. Copying and downloading are unaffected', !!settings.lineNumbers, (v) => { settings.lineNumbers = v; commit(); syncAll(); }));
      box.append(settingRow('Markdown preview', 'Adds a Preview button to markdown code blocks, to see them rendered', settings.mdPreview !== false, (v) => { settings.mdPreview = v; commit(); syncAll(); }));
      box.append(settingRow('Collapse long blocks', 'Blocks over ' + (settings.collapseLines || 20) + ' lines start collapsed', !!settings.collapseLong, (v) => {
        settings.collapseLong = v;
        if (v) scheduleCollapseScan(); else { document.querySelectorAll('pre[data-dck-collapsed]').forEach((p) => setCollapsed(p, false)); syncAll(); }
        commit();
      }));
    }));

    body.append(accordion('ask', 'Questions', settings.askEnabled === false ? 'Off' : (settings.askAutoSend ? 'Clickable questions, sent straight away' : 'Clickable questions, added to your message'), (box) => {
      box.append(settingRow('Draw question forms', 'Turns ask code blocks into forms you can click. Nothing leaves the page', settings.askEnabled !== false, (v) => {
        settings.askEnabled = v; commit(); syncVisuals(); liveSig = ''; refreshAll(true);
      }));
      box.append(settingRow('Ask the model for them', 'Adds the short built-in Questions prompt (edit it in the Prompts tab)', settings.askPrompt !== false, (v) => {
        settings.askPrompt = v; commit(); liveSig = ''; refreshAll(true);
      }));
      box.append(settingRow('Send answers straight away', 'Off: your answers go into the message box and you press Enter. On: they are sent right when you submit', !!settings.askAutoSend, (v) => {
        settings.askAutoSend = v; commit();
        vis.list.forEach((st) => { if (st.ask) st.ask.setSubmitLabel(askLabel()); });
      }));
    }));

    body.append(accordion('visuals', 'Visuals', settings.visualsEnabled === false ? 'Off' : 'Charts and widgets drawn in the chat', (box) => {
      box.append(settingRow('Draw charts and widgets', 'Turns chart and viz code blocks into inline cards. Nothing leaves the page', settings.visualsEnabled !== false, (v) => {
        settings.visualsEnabled = v; commit(); syncVisuals(); liveSig = ''; refreshAll(true);
      }));
      box.append(settingRow('Ask the model for visuals', 'Adds the short built-in Visuals prompt (edit it in the Prompts tab)', settings.visualsPrompt !== false, (v) => {
        settings.visualsPrompt = v; commit(); liveSig = ''; refreshAll(true);
      }));
    }));

    body.append(accordion('vars', 'Variables', VARIABLES.length + ' available in prompts, notes and snippets', (box) => {
      const grid = h('div', { class: 'dck-vargrid' });
      VARIABLES.forEach((v) => grid.append(h('div', {}, h('span', { class: 'dck-vchip static' }, '{{' + v.name + '}}'), h('div', { class: 'dck-faint' }, v.desc))));
      box.append(grid);
    }));

    const problems = diagnostics().filter((r) => r.ok === false).length;
    body.append(accordion('diag', 'Diagnostics', problems ? problems + (problems === 1 ? ' problem found' : ' problems found') : 'Everything found', (box) => renderDiagnostics(box)));

    const importInput = h('input', { type: 'file', accept: 'application/json', style: 'display:none', 'aria-label': 'Import file' });
    importInput.addEventListener('change', async () => {
      try {
        const file = importInput.files[0];
        if (file.size > 5 * 1024 * 1024) throw new Error('too large');
        const data = JSON.parse(await file.text());
        if (!data || typeof data !== 'object') throw new Error('not a backup');
        if (data.settings) settings = migrateSettings(data.settings);
        if (Array.isArray(data.memories)) memories = cleanMemories(data.memories);
        commit(); render(); toast('Imported');
      } catch (err) { toast('Invalid file'); }
      importInput.value = ''; // so choosing the same file again still counts as a change
    });
    body.append(accordion('data', 'Backup', 'Export or import your prompts, notes and snippets', (box) => {
      box.append(h('div', { class: 'dck-two' },
        h('button', {
          type: 'button', class: 'dck-btn',
          onclick: () => {
            const blob = new Blob([JSON.stringify({ settings, memories }, null, 2)], { type: 'application/json' });
            const a = h('a', { href: URL.createObjectURL(blob), download: 'deepseek-kit.json' });
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000); // not at once: some browsers cancel the download
          },
        }, icon('down'), 'Export'),
        h('button', { type: 'button', class: 'dck-btn', onclick: () => importInput.click() }, icon('up'), 'Import')),
        importInput);
    }));
  }

  // ---------- Drawer ----------
  function previewData() {
    const el = getComposer();
    const text = el ? stripContext(el.value) : '';
    const count = chatCount();
    const due = shouldInject(settings, count);
    return { due: due, text: buildPrefix(settings, memories, text, count, !due, ctxFor(count)) };
  }

  function renderPreview(drawer) {
    const d = previewData();
    drawer.append(h('div', { class: 'dck-preview', role: 'dialog', 'aria-label': 'Preview' },
      h('div', { class: 'dck-head' }, h('span', { class: 'dck-title' }, 'Preview'),
        iconBtn('close', 'Close preview', () => { ui.preview = null; render(); })),
      h('div', { class: 'dck-previewbody' },
        h('div', { class: 'dck-hint' }, d.due ? 'This is added to your next message.' : 'Nothing is due for the next message. Insert now would add:'),
        h('pre', { class: 'dck-pre' }, d.text || 'Nothing to add yet. Switch on a prompt or add a memory note.'))));
  }

  function render() {
    const drawer = ui.drawer;
    if (!drawer) return;
    const oldBody = drawer.querySelector('.dck-body');
    const scroll = oldBody ? oldBody.scrollTop : 0;
    drawer.textContent = '';

    drawer.append(h('div', { class: 'dck-head' },
      h('div', { class: 'dck-titlewrap' }, h('span', { class: 'dck-title' }, 'DeepSeek Kit'), h('span', { class: 'dck-faint' }, 'v' + kitVersion())),
      h('div', { class: 'dck-headright' },
        h('label', { class: 'dck-onlabel' }, h('span', {}, 'On'), sw(settings.enabled, (v) => { settings.enabled = v; commit(); }, 'Enable DeepSeek Kit')),
        iconBtn('close', 'Close panel', () => drawer.classList.remove('open')))));

    const segBtns = [];
    const vis = (label, value) => {
      const b = h('button', {
        type: 'button', class: 'dck-seg', 'aria-pressed': 'false',
        onclick: () => {
          settings.showInjected = value;
          segBtns.forEach((x) => { x.el.className = 'dck-seg' + (x.value === value ? ' on' : ''); x.el.setAttribute('aria-pressed', String(x.value === value)); });
          commit();
          if (!value) scheduleStrip([document.body]);
        },
      }, label);
      const on = (settings.showInjected !== false) === value;
      b.className = 'dck-seg' + (on ? ' on' : '');
      b.setAttribute('aria-pressed', String(on));
      segBtns.push({ el: b, value: value });
      return b;
    };
    ui.strip = h('div', { class: 'dck-strip', id: 'dck-strip' });
    drawer.append(h('div', { class: 'dck-ctx' },
      h('div', { class: 'dck-ctxrow' },
        h('span', { class: 'dck-ctxlabel' }, 'Context in chat'),
        h('div', { class: 'dck-segs', role: 'group', 'aria-label': 'Context visibility' }, vis('Visible', true), vis('Hidden', false))),
      ui.strip));

    const tabs = [
      { id: 'prompts', label: 'Prompts', count: 0 },
      { id: 'memory', label: 'Memory', count: memories.length },
      { id: 'snippets', label: 'Snippets', count: settings.snippets.length },
      { id: 'settings', label: 'Settings', count: 0 },
    ];
    drawer.append(h('div', { class: 'dck-tabs', role: 'tablist', 'aria-label': 'Sections' },
      tabs.map((t) => h('button', {
        type: 'button', role: 'tab', class: 'dck-tab' + (ui.tab === t.id ? ' on' : ''), 'aria-selected': String(ui.tab === t.id),
        onclick: () => { ui.tab = t.id; ui.editingId = null; ui.editingSnippetId = null; ui.editingMemory = null; render(); },
      }, t.label, t.count ? h('span', { class: 'dck-badge' }, String(t.count)) : null))));

    const body = h('div', { class: 'dck-body', role: 'tabpanel' });
    if (ui.tab === 'prompts') renderPrompts(body);
    else if (ui.tab === 'memory') renderMemory(body);
    else if (ui.tab === 'snippets') renderSnippets(body);
    else renderSettings(body);
    drawer.append(body);
    body.scrollTop = scroll;

    let foot;
    if (ui.tab === 'snippets') {
      foot = h('div', { class: 'dck-foot' }, h('button', {
        type: 'button', class: 'dck-btn primary grow',
        onclick: () => {
          const s = { id: newId(), name: 'snippet' + (settings.snippets.length + 1), text: '' };
          settings.snippets.unshift(s); ui.search = ''; ui.editingSnippetId = s.id; commit(); render();
        },
      }, icon('plus'), 'New snippet'));
    } else if (ui.tab === 'settings') {
      foot = h('div', { class: 'dck-foot between' },
        h('span', { class: 'dck-faint' }, 'v' + kitVersion() + ' - your data stays on this device'),
        h('button', {
          type: 'button', class: 'dck-btn danger',
          onclick: () => {
            if (!window.confirm('Reset all Kit settings, prompts, memory and snippets?')) return;
            settings = migrateSettings({}); memories = []; ui.editingMemory = null; counts = {}; storeSet({ dck_counts: counts }); resetFab(); ui.editingId = null; ui.editingSnippetId = null; commit(); render();
          },
        }, 'Reset all'));
    } else {
      foot = h('div', { class: 'dck-foot' },
        h('button', { type: 'button', class: 'dck-btn primary grow', onclick: () => { if (insertContext(true)) toast('Context inserted'); } }, 'Insert now'),
        h('button', { type: 'button', class: 'dck-btn', onclick: () => { ui.preview = true; render(); } }, 'Preview'));
    }
    drawer.append(foot);

    if (ui.preview) renderPreview(drawer);
    refreshAll(true);
  }

  // ---------- DeepThink reasoning: fold ----------
  // The site draws a reasoning block as one container (it carries an inline `--collapsible-area-title-height`) whose
  // first child is the header ("Thought for N seconds") and whose other children are the steps: `.ds-think-content`
  // text plus the "Found N web pages" and "Read N pages" rows. A block the site has closed is just the header plus
  // two empty spacer divs.
  // With collapseThinking on, <html> gets the attribute `data-dck-fold` and a rule in content.css hides every non-empty child
  // after the header, so the block looks exactly like a closed one, while streaming and after a refresh alike.
  // Nothing is clicked and no site state changes. That is the point: the site's virtual list measures a folded block
  // from the start, so it never sees a block shrink after it has been measured (closing blocks by clicking their
  // header did exactly that, and made the page jump when scrolling up after a refresh).
  // The site still thinks a folded block is open, so a click on its header is handled here (initThinkTracker): it
  // unfolds the block by adding `dck-open`. The key of that message is remembered for this page session, so a block
  // you opened stays open when the site rebuilds that message as you scroll.
  const think = { opened: new Set() };
  const scheduleThinkScan = SITE.oncePerFrame(() => scanThinking());

  function applyFold() {
    const on = !!(settings.enabled && settings.collapseThinking);
    const root = document.documentElement;
    if (on !== root.hasAttribute('data-dck-fold')) { if (on) root.setAttribute('data-dck-fold', ''); else root.removeAttribute('data-dck-fold'); }
  }

  // Marks the blocks you opened again when the site has rebuilt their message.
  function scanThinking() {
    if (!think.opened.size || !settings.enabled || !settings.collapseThinking) return;
    SITE.reasoningBlocks().forEach((block) => {
      if (block.classList.contains('dck-open')) return;
      const key = SITE.blockKey(block);
      if (key && think.opened.has(key)) block.classList.add('dck-open');
    });
  }

  // A real click on a reasoning block's header. Capture phase, so it runs before the site's own handler.
  function initThinkTracker() {
    document.addEventListener('click', (e) => {
      if (!e.isTrusted || !settings.enabled || !settings.collapseThinking || !(e.target instanceof Element)) return;
      let el = e.target;
      for (let i = 0; i < 6 && el.parentElement; i++, el = el.parentElement) {
        const block = SITE.blockOfHeader(el);
        if (!block) continue; // not the header of a block
        if (block.classList.contains('dck-open')) return; // you already opened it: the site handles this click
        const key = SITE.blockKey(block);
        if (key) think.opened.add(key);
        block.classList.add('dck-open');
        if (SITE.blockIsOpen(block)) {
          // Folded by us, open as far as the site knows: unfold only. Letting the click through would close it.
          e.preventDefault();
          e.stopPropagation();
          logEvent('Reasoning block opened');
        } // else the site had it closed: let this click open it, and it will not be folded
        return;
      }
    }, true);
  }

  // ---------- Code block tools (buttons in the code block header: collapse, ZIP basket) ----------
  const tools = { basket: [], zip: null };
  const collapse = { touched: new WeakSet() };

  function lineCount(pre) { return (pre.textContent || '').replace(/\n$/, '').split('\n').length; }

  function setCollapsed(pre, on) {
    if (on) pre.setAttribute('data-dck-collapsed', ''); else pre.removeAttribute('data-dck-collapsed');
  }

  function blockInfo(pre) {
    const codeEl = pre.querySelector('code');
    const text = (codeEl || pre).textContent.replace(/\n$/, '');
    const hints = [langFromClass((codeEl && codeEl.className) || ''), langFromClass(pre.className)];
    // The header label comes from SITE.blockLang (first text node of the header). Reading the header's textContent
    // ran the label into the Copy/Download buttons ("pythonCopyDownload"), so every block fell back to .txt.
    const label = SITE.blockLang(pre);
    if (label) hints.push(label);
    const info = detectBlock(hints, text);
    const all = SITE.codeBlocks();
    return { text, lang: info.lang, kind: info.kind, name: suggestFilename(info.lang, text, all.indexOf(pre) + 1) };
  }

  function saveFile(name, data, type) {
    const blob = new Blob([data], { type: type || 'application/octet-stream' });
    const a = h('a', { href: URL.createObjectURL(blob), download: name, style: 'display:none' });
    document.body.append(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 1000);
  }

  // ----- ZIP basket (a small pill at the bottom of the page)
  function updateZipChip() {
    if (!tools.zip) { tools.zip = h('div', { id: 'dck-zipchip', style: 'display:none' }); document.body.append(tools.zip); }
    const n = tools.basket.length;
    tools.zip.style.display = n ? 'flex' : 'none';
    tools.zip.textContent = '';
    if (!n) return;
    tools.zip.append(
      h('button', { type: 'button', class: 'dck-cbtn primary', onclick: basketZip }, 'Download ZIP (' + n + ')'),
      h('button', { type: 'button', class: 'dck-cbtn', 'aria-label': 'Clear collected blocks', onclick: () => { tools.basket = []; updateZipChip(); syncAll(); } }, 'Clear'));
    placeZip();
  }

  function toggleBasket(pre) {
    const at = tools.basket.findIndex((b) => b.el === pre);
    if (at >= 0) tools.basket.splice(at, 1);
    else { const info = blockInfo(pre); tools.basket.push({ el: pre, name: info.name, text: info.text }); }
    updateZipChip();
    syncAll();
  }

  function basketZip() {
    const used = new Set();
    const files = tools.basket.map((b) => ({ name: uniqueName(b.name, used), data: b.text }));
    saveFile('code-blocks.zip', makeZip(files, new Date()), 'application/zip');
    logEvent('ZIP downloaded (' + files.length + ' files)');
    toast(files.length + (files.length === 1 ? ' file' : ' files') + ' zipped');
    tools.basket = [];
    updateZipChip();
    syncAll();
  }

  // ----- Markdown preview: a "Preview" button on markdown code blocks swaps the source for a rendered view.
  // The source block stays in the page (only hidden by CSS), so Copy, Download and ZIP still use the original text.
  const previewText = new WeakMap(); // preview element -> the source it was drawn from
  function mdSource(pre) { return (pre.querySelector('code') || pre).textContent.replace(/\n$/, ''); }
  function previewEl(pre) {
    const box = SITE.blockBox(pre);
    return box ? box.querySelector(':scope > .dck-mdprev') : null;
  }
  function hasPreview(pre) { return !!previewEl(pre); }
  function mdOffered(pre) {
    if (!MD || settings.mdPreview === false) return false;
    const lang = SITE.blockLang(pre);
    if (lang !== 'markdown' && lang !== 'md') return false;
    return hasPreview(pre) || !SITE.blockBusy(pre); // not while the site is still writing the block
  }
  function drawPreview(wrap, text) {
    const node = MD.render(document, text);
    if (!node) return false;
    wrap.textContent = '';
    wrap.appendChild(node);
    previewText.set(wrap, text);
    return true;
  }
  function closePreview(pre) {
    const wrap = previewEl(pre);
    if (wrap) wrap.remove();
    const box = SITE.blockBox(pre);
    if (box) box.removeAttribute('data-dck-prev');
  }
  function togglePreview(pre) {
    if (hasPreview(pre)) { closePreview(pre); return; }
    const wrap = h('div', { class: 'dck-mdprev' });
    if (!drawPreview(wrap, mdSource(pre))) { toast('Too long to preview - use the source'); return; }
    pre.insertAdjacentElement('afterend', wrap);
    SITE.blockBox(pre).setAttribute('data-dck-prev', '');
  }
  // Keeps an open preview true to its block: redrawn if the text changed, closed if the feature was turned off.
  function syncPreview(pre) {
    const box = SITE.blockBox(pre);
    if (!box) return;
    const wrap = previewEl(pre);
    if (!wrap) { if (box.hasAttribute('data-dck-prev')) box.removeAttribute('data-dck-prev'); return; }
    if (!MD || settings.mdPreview === false || settings.codeTools === false) { closePreview(pre); return; }
    if (!box.hasAttribute('data-dck-prev')) box.setAttribute('data-dck-prev', '');
    const text = mdSource(pre);
    if (previewText.get(wrap) !== text && !drawPreview(wrap, text)) closePreview(pre);
  }

  // ----- the buttons themselves
  // What a block offers: [id, label, handler]
  function actionsFor(pre) {
    const folded = pre.hasAttribute('data-dck-collapsed');
    const inBasket = tools.basket.some((b) => b.el === pre);
    const list = [];
    const previewing = hasPreview(pre);
    if (mdOffered(pre)) list.push(['preview', previewing ? 'Source' : 'Preview', previewing ? 'code' : 'eye', () => { togglePreview(pre); syncAll(); }]);
    if (!previewing && (folded || lineCount(pre) > 3)) list.push(['collapse', folded ? 'Expand (' + lineCount(pre) + ' lines)' : 'Collapse', folded ? 'expand' : 'shrink', () => { collapse.touched.add(pre); setCollapsed(pre, !pre.hasAttribute('data-dck-collapsed')); syncAll(); }]);
    list.push(['zip', inBasket ? 'Added' : '+ ZIP', inBasket ? 'check' : 'archive', () => toggleBasket(pre)]);
    return list;
  }

  // Sets the visible text of a cloned button without flattening its inner markup.
  function setLabel(btn, label) {
    const first = SITE.firstText(btn);
    if (!first) { btn.textContent = label; return; }
    if (first.nodeValue !== label) first.nodeValue = label;
    // any further text (e.g. a second span) is cleared so only the label remains
    SITE.textNodes(btn, (n) => n !== first && !!n.nodeValue.trim()).forEach((n) => { n.nodeValue = ''; });
  }

  // What the site's Copy button looks like right now (its markup without the text). Ours are copies of it, so when it
  // changes (e.g. it is dimmed while a reply streams, then switches to normal) the copies are rebuilt to match.
  function look(btn) { return btn.outerHTML.replace(/>[^<]*</g, '><'); }

  // Swaps the site's icon in our copy of the button for our own, at the same size, so the row stays evenly spaced.
  function setHeaderIcon(btn, name, src) {
    if (btn.getAttribute('data-dck-ic') === name) return;
    const theirs = src.querySelector('svg');
    const mine = btn.querySelector('svg');
    const size = theirs ? (parseFloat(theirs.getAttribute('width')) || theirs.getBoundingClientRect().width || 14) : 14;
    const ic = icon(name, Math.round(size) || 14);
    if (theirs && theirs.getAttribute('class')) ic.setAttribute('class', theirs.getAttribute('class'));
    ic.style.cssText = 'fill:none;stroke:currentColor;flex:none';
    if (mine) mine.replaceWith(ic); else btn.insertBefore(ic, btn.firstChild);
    btn.setAttribute('data-dck-ic', name);
  }

  function removeHeaderButtons(pre) {
    const box = pre.parentElement && pre.parentElement.parentElement;
    if (box) box.querySelectorAll('[data-dck-act]').forEach((n) => n.remove());
  }

  // Puts our buttons next to Copy / Download. Returns true when the block has a header to put them in.
  function syncHeader(pre) {
    const copy = SITE.copyButton(pre);
    if (!copy) return false;
    const row = copy.parentElement;
    const want = actionsFor(pre);
    const have = Array.from(row.querySelectorAll(':scope > [data-dck-act]'));
    const sig = look(copy);
    const same = have.length === want.length && have.every((n, i) => n.getAttribute('data-dck-act') === want[i][0] && n.getAttribute('data-dck-look') === sig);
    if (!same) {
      have.forEach((n) => n.remove());
      want.forEach((w) => {
        // Deep clone so the label keeps the site's own inner element and styling, then drop the icon.
        const b = copy.cloneNode(true);
        b.removeAttribute('id');
        b.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
        setLabel(b, w[1]);
        b.setAttribute('data-dck-act', w[0]);
        b.setAttribute('data-dck-look', sig);
        b.setAttribute('role', 'button');
        b.setAttribute('tabindex', '0');
        b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); w[3](); });
        b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); w[3](); } });
        row.insertBefore(b, copy);
      });
    }
    row.querySelectorAll(':scope > [data-dck-act]').forEach((n, i) => { setLabel(n, want[i][1]); setHeaderIcon(n, want[i][2], copy); });
    return true;
  }

  // Line numbers: the site renders one <span> per line directly inside the <pre>, so a CSS counter on those
  // spans numbers them without adding any text (nothing to copy or download by accident).
  function syncLines(pre) {
    const kids = pre.children;
    const ok = settings.lineNumbers && kids.length > 0 && Array.prototype.every.call(kids, (c) => c.tagName === 'SPAN');
    if (!ok) {
      if (pre.hasAttribute('data-dck-lines')) { pre.removeAttribute('data-dck-lines'); pre.style.removeProperty('--dck-digits'); }
      return;
    }
    const digits = String(kids.length).length;
    if (!pre.hasAttribute('data-dck-lines')) pre.setAttribute('data-dck-lines', '');
    if (pre.style.getPropertyValue('--dck-digits') !== String(digits)) pre.style.setProperty('--dck-digits', String(digits));
  }

  function syncAll() {
    SITE.codeBlocks().forEach((pre) => {
      syncLines(pre);
      syncPreview(pre);
      if (settings.codeTools === false) removeHeaderButtons(pre); else syncHeader(pre);
    });
  }

  const scheduleCodeScan = SITE.oncePerFrame(syncAll);

  const scheduleCollapseScan = SITE.oncePerFrame(() => {
    if (!settings.collapseLong) return;
    const limit = Math.max(3, settings.collapseLines || 20);
    let changed = false;
    SITE.codeBlocks().forEach((pre) => {
      if (collapse.touched.has(pre)) return;
      if (lineCount(pre) > limit) { collapse.touched.add(pre); setCollapsed(pre, true); changed = true; }
    });
    if (changed) syncAll();
  });

  // ---------- Visuals: charts and widgets drawn inline from ```chart and ```viz code blocks ----------
  // The model is asked (see the built-in Visuals prompt) to put a chart spec or a small HTML widget in a code block
  // with the language chart or viz. When the block is finished it is hidden and a card is drawn right after it.
  // Charts are plain SVG built by visuals.js. Widgets run in a sandboxed iframe with no network (see visuals.js).
  const vis = { list: [], sandbox: null, seq: 0, dark: null };
  const VIS_LANGS = { chart: 'chart', viz: 'viz', widget: 'viz', ask: 'ask', question: 'ask', questions: 'ask' };
  const VIS_SETTLE = 700; // ms a block must stay unchanged before it counts as finished

  function pageIsDark() {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const m = getComputedStyle(el).backgroundColor.match(/rgba?\(([^)]+)\)/);
      if (!m) continue;
      const p = m[1].split(',').map((x) => parseFloat(x));
      if (p.length > 3 && p[3] < 0.5) continue;
      return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255 < 0.5;
    }
    return !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function visTheme(dark) {
    return dark
      ? { dark: true, text: '#eceef0', muted: '#9aa1a8', border: '#2c3035', surface: '#202327', accent: '#4d6bfe' }
      : { dark: false, text: '#15171a', muted: '#5b636b', border: '#e1e4e7', surface: '#f6f7f8', accent: '#3b57e6' };
  }

  // visOn: any of the card kinds is on. chartsOn: charts and widgets. kindOn: one kind.
  function visOn() { return !!(settings.enabled && (settings.visualsEnabled !== false || settings.askEnabled !== false)); }
  function chartsOn() { return !!(settings.enabled && settings.visualsEnabled !== false); }
  function kindOn(kind) { return kind === 'ask' ? settings.askEnabled !== false : settings.visualsEnabled !== false; }

  function visError(st, message) {
    st.error = message;
    renderVisStatus(st);
  }

  function sendVisError(st) {
    const el = getComposer();
    if (!el) { toast('Message box not found'); return; }
    const kind = st.kind === 'chart' ? 'chart' : st.kind === 'ask' ? 'question form' : 'interactive visual';
    const msg = 'The ' + kind + ' you made did not work: ' + (st.error || 'unknown error') + '\nPlease fix it and reply with the corrected ```' + st.kind + ' block.';
    setNativeValue(el, el.value && el.value.trim() ? el.value.replace(/\s+$/, '') + '\n\n' + msg : msg);
    el.focus();
    toast('Error added to your message');
    logEvent('Visual error sent to the message box');
  }

  function renderVisStatus(st) {
    st.status.textContent = '';
    if (!st.error) { st.status.style.display = 'none'; return; }
    st.status.style.display = '';
    st.status.append(
      h('span', { class: 'dck-viserr-text' }, (st.kind === 'ask' ? 'This question form hit a problem: ' : 'This visual hit a problem: ') + st.error),
      h('button', { type: 'button', class: 'dck-vbtn', onclick: () => sendVisError(st) }, 'Send error to DeepSeek'),
      h('button', { type: 'button', class: 'dck-vbtn', onclick: () => toggleVisCode(st, true) }, 'Show code'));
  }

  function toggleVisCode(st, on) {
    st.showCode = on === undefined ? !st.showCode : on;
    if (st.showCode) st.box.setAttribute('data-dck-vis-open', ''); else st.box.removeAttribute('data-dck-vis-open');
    st.codeBtn.textContent = st.showCode ? 'Hide code' : 'Code';
  }

  function openVisFull(st) {
    const overlay = h('div', { class: 'dck-visfull', 'data-theme': st.card.getAttribute('data-theme') },
      h('div', { class: 'dck-visfull-bar' }, h('span', {}, st.kind === 'chart' ? 'Chart' : 'Interactive visual'), h('button', { type: 'button', class: 'dck-vbtn', 'aria-label': 'Close', onclick: () => overlay.remove() }, 'Close')));
    const body = h('div', { class: 'dck-visfull-body' });
    if (st.kind === 'chart' && st.spec) {
      body.append(VIS.buildChart(document, st.spec).el);
    } else if (st.kind === 'viz') {
      body.append(h('iframe', { sandbox: 'allow-scripts', title: 'Interactive visual', srcdoc: VIS.buildWidgetDocument(st.text, visTheme(vis.dark), 'full'), style: 'width:100%;height:100%;border:0;display:block;color-scheme:' + (vis.dark ? 'dark' : 'light') }));
    }
    overlay.append(body);
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.remove(); });
    overlay.setAttribute('tabindex', '-1');
    document.body.append(overlay);
    overlay.focus();
  }

  function downloadChart(st, kind) {
    const svg = st.card.querySelector('svg.dck-csvg');
    if (!svg) return;
    const str = VIS.svgToString(svg, st.card);
    const base = (st.spec && st.spec.title ? st.spec.title : 'chart').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'chart';
    if (kind === 'svg') { saveFile(base + '.svg', str, 'image/svg+xml'); return; }
    const vb = svg.viewBox.baseVal;
    const scale = 2;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = vb.width * scale; c.height = vb.height * scale;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => { if (b) saveFile(base + '.png', b, 'image/png'); else toast('Could not make the image'); }, 'image/png');
    };
    img.onerror = () => toast('Could not make the image');
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str.replace('<svg ', '<svg width="' + vb.width + '" height="' + vb.height + '" '));
  }

  function makeVisCard(pre, box, kind) {
    const st = { pre, box, kind, text: '', changed: Date.now(), rendered: '', showCode: false, error: '', spec: null, id: 'v' + (++vis.seq) + Math.random().toString(36).slice(2, 8), iframe: null };
    st.body = h('div', { class: 'dck-visbody' });
    st.status = h('div', { class: 'dck-viserr', style: 'display:none' });
    st.codeBtn = h('button', { type: 'button', class: 'dck-vbtn', onclick: () => toggleVisCode(st) }, 'Code');
    st.actions = h('div', { class: 'dck-visactions' });
    st.card = h('div', { class: 'dck-vis', 'data-kind': kind, 'data-theme': vis.dark ? 'dark' : 'light' },
      h('div', { class: 'dck-visbar' }, h('span', { class: 'dck-vislabel' }, kind === 'chart' ? 'Chart' : kind === 'ask' ? 'Questions' : 'Interactive'), st.actions),
      st.body, st.status);
    return st;
  }

  function fillVisActions(st) {
    st.actions.textContent = '';
    if (st.kind === 'chart' && st.spec) {
      st.actions.append(
        h('button', { type: 'button', class: 'dck-vbtn', onclick: () => downloadChart(st, 'png') }, 'PNG'),
        h('button', { type: 'button', class: 'dck-vbtn', onclick: () => downloadChart(st, 'svg') }, 'SVG'));
    }
    if (st.kind !== 'ask' && (!st.error || st.rendered)) st.actions.append(h('button', { type: 'button', class: 'dck-vbtn', onclick: () => openVisFull(st) }, 'Full size'));
    st.actions.append(st.codeBtn);
  }

  function showVisPlaceholder(st) {
    if (st.shown === 'ph') return;
    st.shown = 'ph';
    st.body.textContent = '';
    st.error = ''; renderVisStatus(st);
    st.body.append(h('div', { class: 'dck-visph' }, h('span', { class: 'dck-visph-dot' }), st.kind === 'chart' ? 'Building chart...' : st.kind === 'ask' ? 'Preparing questions...' : 'Building interactive visual...'));
    st.actions.textContent = '';
    st.rendered = '';
  }

  // ----- question forms (```ask blocks): answers go into the message box, or are sent straight away if you chose that
  function askLabel() { return settings.askAutoSend ? 'Send answers' : 'Add to message'; }

  // Presses Enter in the message box like you would, so the Kit's own Enter handling (count, due context) applies.
  // If the site did not take it, the send button is pressed once. done('sent' | 'review' | 'failed').
  function sendNow(el, done) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    const t0 = Date.now();
    let clicked = false;
    const tick = () => {
      if (!el.isConnected || !el.value.trim()) { done('sent'); return; }
      if (alreadyHasContext(el.value)) { done('review'); return; } // the Kit added due context first: you review it, then send
      if (Date.now() - t0 >= SEND_WAIT * (clicked ? 2 : 1)) {
        if (clicked || !clickSend(el)) { done('failed'); return; }
        clicked = true;
      }
      setTimeout(tick, 100);
    };
    setTimeout(tick, 100);
  }

  // Question cards whose answers were sent, remembered by their question text for as long as the page is open, so a
  // card the site redraws comes back read-only with the answers still shown. Nothing is stored.
  const askSent = new Map();
  const askPending = new Set(); // cards whose answers sit in the message box, waiting to be sent
  let askPoll = null;
  function askMarkSent(text, answers) {
    askSent.set(text, answers);
    vis.list.forEach((s2) => { if (s2.kind === 'ask' && s2.ask && s2.text === text && !s2.ask.isSent()) { s2.ask.setAnswers(answers); s2.ask.markSent(true); } });
  }
  function askWatch(st) {
    askPending.add(st);
    if (askPoll) return;
    askPoll = setInterval(() => {
      const el = getComposer();
      const emptied = !!el && !String(el.value || '').trim();
      askPending.forEach((p) => {
        if (!p.ask || !p.body.isConnected) { if (emptied && p.ask) askMarkSent(p.text, p.ask.answers()); else if (emptied && p.sentText) askMarkSent(p.text, p.sentAnswers); askPending.delete(p); return; }
        p.sentText = p.text; p.sentAnswers = p.ask.answers();
        if (emptied) { askMarkSent(p.text, p.sentAnswers); askPending.delete(p); }
      });
      if (!askPending.size) { clearInterval(askPoll); askPoll = null; }
    }, 600);
  }

  function submitAsk(st, text) {
    const el = getComposer();
    if (!el) { toast('Message box not found'); st.ask.note('Message box not found'); return; }
    const cur = el.value || '';
    let next;
    if (st.added && cur.indexOf(st.added) >= 0) next = cur.replace(st.added, text); // answered again: replace our earlier answers
    else next = cur.trim() ? cur.replace(/\s+$/, '') + '\n\n' + text : text;
    setNativeValue(el, next);
    st.added = text;
    el.focus();
    try { el.setSelectionRange(next.length, next.length); } catch (e) { /* ignore */ }
    if (!settings.askAutoSend) {
      st.ask.note('Added to your message - press Enter to send');
      toast('Answers added - press Enter to send');
      logEvent('Answers added to the message box');
      askWatch(st); // once the box is emptied (you pressed Enter) the card turns read-only
      return;
    }
    st.ask.lock(true);
    st.ask.note('Sending...');
    sendNow(el, (result) => {
      if (result === 'sent') { askMarkSent(st.text, st.ask.answers()); logEvent('Answers sent'); }
      else if (result === 'review') { st.ask.lock(false); st.ask.note('Context added - review it, then press Enter to send'); askWatch(st); }
      else { st.ask.lock(false); st.ask.note('Could not send - your answers are in the message box'); toast('Could not send automatically - press Enter to send'); logEvent('Answers not sent'); }
    });
  }

  function renderAskCard(st) {
    if (st.rendered === st.text) return; // the form keeps what you picked, so only a changed block redraws it
    st.rendered = st.text;
    st.shown = 'done';
    st.error = '';
    st.added = '';
    st.body.textContent = '';
    st.ask = null;
    const r = ASK ? ASK.parseAskSpec(st.text) : { ok: false, error: 'Question forms are not available.' };
    if (!r.ok) { st.body.append(h('div', { class: 'dck-visph' }, 'These questions could not be shown.')); visError(st, r.error); fillVisActions(st); return; }
    st.ask = ASK.buildAsk(document, r.spec, { submitLabel: askLabel(), onSubmit: (text) => submitAsk(st, text), onAgain: () => { askSent.delete(st.text); askPending.delete(st); st.added = ''; } });
    st.body.append(st.ask.el);
    if (askSent.has(st.text)) { st.ask.setAnswers(askSent.get(st.text)); st.ask.markSent(true); }
    renderVisStatus(st);
    fillVisActions(st);
  }

  function renderVisCard(st) {
    if (st.kind === 'ask') { renderAskCard(st); return; }
    const key = st.text + '|' + (vis.dark ? 'd' : 'l');
    if (st.rendered === key) return;
    st.rendered = key;
    st.shown = 'done';
    st.error = '';
    st.body.textContent = '';
    st.spec = null;
    st.iframe = null;
    if (st.kind === 'chart') {
      const r = VIS.parseChartSpec(st.text);
      if (!r.ok) { st.body.append(h('div', { class: 'dck-visph' }, 'This chart could not be drawn.')); visError(st, r.error); fillVisActions(st); return; }
      st.spec = r.spec;
      st.body.append(VIS.buildChart(document, r.spec).el);
    } else {
      const frame = h('iframe', { sandbox: 'allow-scripts', referrerpolicy: 'no-referrer', title: 'Interactive visual', class: 'dck-visframe', style: 'height:150px;color-scheme:' + (vis.dark ? 'dark' : 'light') });
      frame.srcdoc = VIS.buildWidgetDocument(st.text, visTheme(vis.dark), st.id);
      st.iframe = frame;
      st.body.append(frame);
    }
    renderVisStatus(st);
    fillVisActions(st);
  }

  function dropVisCard(st) {
    st.card.remove();
    st.box.removeAttribute('data-dck-vis-src');
    st.box.removeAttribute('data-dck-vis-open');
  }

  function syncVisuals() {
    const on = visOn();
    const dark = pageIsDark();
    const flipped = dark !== vis.dark;
    vis.dark = dark;
    if (!on) { vis.list.forEach(dropVisCard); vis.list = []; return; }
    vis.list = vis.list.filter((st) => { if (st.pre.isConnected && st.box.isConnected) return true; st.card.remove(); return false; });
    const now = Date.now();
    SITE.codeBlocks().forEach((pre) => {
      let kind = VIS_LANGS[SITE.blockLang(pre)];
      if (kind && !kindOn(kind)) kind = null;
      let st = vis.list.find((x) => x.pre === pre);
      if (!kind) { if (st) { dropVisCard(st); vis.list = vis.list.filter((x) => x !== st); } return; }
      const box = SITE.blockBox(pre);
      if (!st) { st = makeVisCard(pre, box, kind); vis.list.push(st); }
      if (!st.card.isConnected || st.card.previousElementSibling !== box) box.after(st.card);
      if (!box.hasAttribute('data-dck-vis-src')) box.setAttribute('data-dck-vis-src', '');
      if (flipped) st.card.setAttribute('data-theme', dark ? 'dark' : 'light');
      const text = (pre.textContent || '').replace(/\n$/, '');
      if (text !== st.text) { st.text = text; st.changed = now; }
      const busy = SITE.blockBusy(pre) || now - st.changed < VIS_SETTLE || !text.trim();
      if (busy) showVisPlaceholder(st); else renderVisCard(st);
    });
  }
  const scheduleVisScan = SITE.oncePerFrame(syncVisuals);

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || typeof d.type !== 'string' || !d.type.startsWith('DCK_VIS_')) return;
    const st = vis.list.find((x) => x.iframe && x.iframe.contentWindow === e.source && x.id === d.id);
    if (!st) return;
    if (d.type === 'DCK_VIS_HEIGHT' && typeof d.height === 'number') {
      st.iframe.style.height = Math.max(60, Math.min(900, Math.round(d.height))) + 'px';
    } else if (d.type === 'DCK_VIS_ERROR') {
      st.error = String(d.message || 'Script error').slice(0, 300);
      renderVisStatus(st);
      logEvent('Visual error: ' + st.error.slice(0, 80));
    }
  });

  // Can a locked-down iframe run its scripts on this page at all? Its result shows in Diagnostics.
  function runSandboxProbe() {
    return new Promise((resolve) => {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none';
      frame.setAttribute('aria-hidden', 'true');
      let done = false;
      const finish = (v) => { if (done) return; done = true; window.removeEventListener('message', onMsg); frame.remove(); vis.sandbox = v; resolve(v); };
      const onMsg = (e) => { if (e.source === frame.contentWindow && e.data && e.data.type === 'DCK_VIS_PROBE') finish('ok'); };
      window.addEventListener('message', onMsg);
      frame.srcdoc = VIS.buildWidgetDocument('<script>parent.postMessage({type:"DCK_VIS_PROBE"},"*")<\/script>', visTheme(true), 'probe');
      document.body.append(frame);
      setTimeout(() => finish('blocked'), 1500);
    });
  }


  // ---------- Draggable Kit button ----------
  const fabDrag = { active: false, moved: false, startX: 0, startY: 0, dx: 0, dy: 0 };

  function placeFab(fab) {
    fab = fab || document.getElementById('dck-fab');
    if (!fab) return;
    const hgt = fab.offsetHeight || 36;
    const top = Math.min(window.innerHeight - hgt - 8, Math.max(8, fabPos.y * window.innerHeight - hgt / 2));
    fab.classList.toggle('side-left', fabPos.side === 'left');
    fab.classList.toggle('side-right', fabPos.side !== 'left');
    fab.style.top = top + 'px';
    fab.style.left = ''; fab.style.right = '';
  }

  function saveFab() { storeSet({ dck_fab: fabPos }); }

  function resetFab() {
    fabPos = { side: FAB_DEFAULT.side, y: FAB_DEFAULT.y };
    placeFab(); saveFab();
  }

  function initFab(fab) {
    placeFab(fab);
    window.addEventListener('resize', () => placeFab());
    fab.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = fab.getBoundingClientRect();
      fabDrag.active = true; fabDrag.moved = false;
      fabDrag.startX = e.clientX; fabDrag.startY = e.clientY;
      fabDrag.dx = e.clientX - r.left; fabDrag.dy = e.clientY - r.top;
      try { fab.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    fab.addEventListener('pointermove', (e) => {
      if (!fabDrag.active) return;
      if (!fabDrag.moved && Math.abs(e.clientX - fabDrag.startX) + Math.abs(e.clientY - fabDrag.startY) < 6) return;
      fabDrag.moved = true;
      fab.classList.add('dragging');
      fab.style.right = 'auto'; fab.style.left = Math.min(window.innerWidth - fab.offsetWidth, Math.max(0, e.clientX - fabDrag.dx)) + 'px';
      fab.style.top = Math.min(window.innerHeight - fab.offsetHeight, Math.max(0, e.clientY - fabDrag.dy)) + 'px';
    });
    const end = (e) => {
      if (!fabDrag.active) return;
      fabDrag.active = false;
      try { fab.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      fab.classList.remove('dragging');
      if (!fabDrag.moved) return;
      const r = fab.getBoundingClientRect();
      fabPos = cleanFab({ side: r.left + r.width / 2 < window.innerWidth / 2 ? 'left' : 'right', y: (r.top + r.height / 2) / window.innerHeight });
      placeFab(fab); saveFab();
      setTimeout(() => { fabDrag.moved = false; }, 0); // a drag never counts as a click
    };
    fab.addEventListener('pointerup', end);
    fab.addEventListener('pointercancel', end);
  }

  function mount() {
    applyFold(); // first thing, so reasoning blocks are folded before the page measures them
    if (document.getElementById('dck-fab')) return;
    const drawer = h('div', { id: 'dck-drawer' });
    ui.drawer = drawer;
    const fab = h('button', { id: 'dck-fab', type: 'button', title: 'Open Kit (drag to move)', onclick: () => {
      if (fabDrag.moved) { fabDrag.moved = false; return; }
      ui.preview = null; render(); drawer.classList.toggle('open');
    } }, 'Kit');
    document.body.append(fab, drawer);
    initFab(fab);
    render();
    startObserver();
    syncAll();
    syncVisuals();
    setTimeout(() => { if (chartsOn()) runSandboxProbe(); }, 1500);
    initThinkTracker();
    listenForOtherTabs();
    applyFold();
    if (settings.collapseLong) scheduleCollapseScan();
    if (settings.showInjected === false) scheduleStrip([document.body]);
  }

  load().then(mount);
})();
