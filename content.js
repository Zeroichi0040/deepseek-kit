/* DeepSeek Kit - local-only, no network calls, no request patching.
 * It edits the text in your message box (and optionally hides its own inserted block in the chat view).
 * Pure logic lives in lib.js, which is loaded first. */
(function () {
  'use strict';

  const {
    DEFAULTS, BUILTIN_DEFAULT_PROMPT, VARIABLES, VARIABLE_NAMES, migrateSettings,
    hasLegacyKeys, tokens, selectMemories, scheduleDue, applyVariables,
    promptEntries, shouldInject, activePrompts, buildPrefix, estimateTokens,
    summarize, describeSummary, memoryLabel, alreadyHasContext, stripContext,
    slashQuery, cleanSnippetName, filterSnippets, searchSnippets, describeSchedule,
    insertAt, defaultPromptText, newId, LANG_EXT, normalizeLang,
    langFromClass, extFor, sniffLang, previewKind, detectBlock,
    suggestFilename, uniqueName, crc32, makeZip, MEMORY_GENERAL,
    memoryLine, memoryCategory, memoryPlan, memoryStatuses, memoryTokens,
    groupMemories, cleanCategory, isExistingChatPath, resolveCount, pruneCounts,
    MARKER_START, MARKER_END,
  } = globalThis.DCK_LIB;

  // ---------- Extension runtime ----------
  const store = chrome.storage.local;
  const diag = { events: [], stripped: 0, started: Date.now() };
  function logEvent(msg) {
    diag.events.push({ t: new Date(), msg: msg });
    if (diag.events.length > 30) diag.events.shift();
  }
  let settings = migrateSettings({});
  let memories = [];
  const ui = { drawer: null, strip: null, tab: 'prompts', editingId: null, editingSnippetId: null, editingMemory: null, settingsOpen: 'messages', search: '', showAllVars: false, preview: null };
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
    store.set({ dck_counts: counts });
  }

  function kitVersion() {
    try { return chrome.runtime.getManifest().version; } catch (e) { return '0.4.1'; }
  }

  function load() {
    return new Promise((resolve) => {
      store.get(['dck_settings', 'dck_memories', 'dck_counts'], (r) => {
        settings = migrateSettings(r.dck_settings);
        memories = Array.isArray(r.dck_memories) ? r.dck_memories : [];
        counts = r.dck_counts && typeof r.dck_counts === 'object' && !Array.isArray(r.dck_counts) ? r.dck_counts : {};
        if (hasLegacyKeys(r.dck_settings)) save(); // write the migrated shape back once
        resolve();
      });
    });
  }
  function save() {
    store.set({ dck_settings: settings, dck_memories: memories });
  }
  function commit() {
    save();
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
    refreshAll(false);
  }, 500);

  function getComposer() {
    return document.querySelector('textarea');
  }

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
  function findSendButton(el) {
    let node = el;
    for (let i = 0; i < 6 && node && node.parentElement; i++) {
      node = node.parentElement;
      const btns = Array.from(node.querySelectorAll('[role="button"], button')).filter(
        (b) => !b.closest('#dck-drawer, #dck-picker, #dck-chips') && b.querySelector('svg') && b.getAttribute('aria-disabled') !== 'true' && !b.disabled
      );
      if (btns.length) return btns[btns.length - 1];
    }
    return null;
  }

  function clickSend(el) {
    const b = findSendButton(el);
    if (!b) return false;
    b.click();
    return true;
  }

  // One Enter press from you -> context attached and the message sent. Falls back to the send button, then to asking you.
  function triggerSend(el) {
    bypass = true;
    try {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    } finally {
      bypass = false;
    }
    setTimeout(() => {
      if (!alreadyHasContext(el.value)) { delete el.dataset.dckCounted; logEvent('Hidden send: message went out on Enter'); return; }
      if (clickSend(el)) logEvent('Hidden send: used the send button');
      else { logEvent('Hidden send failed: no send button found'); toast('Could not send automatically - press Enter to send'); }
      setTimeout(() => { if (!alreadyHasContext(el.value)) delete el.dataset.dckCounted; }, 600);
    }, 450);
  }

  // ---------- Chips above the message box + the strip in the drawer ----------
  const chips = { el: null };
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
    if (sum.state === 'ready') {
      sum.names.slice(0, 3).forEach((n) => chips.el.append(h('span', { class: 'dck-chip' }, n)));
      if (sum.names.length > 3) chips.el.append(h('span', { class: 'dck-chip' }, '+' + (sum.names.length - 3)));
      if (sum.memories) chips.el.append(h('span', { class: 'dck-chip' }, memoryLabel(sum.memories)));
      if (sum.skipped) chips.el.append(h('span', { class: 'dck-chip warn' }, sum.skipped + ' over budget'));
    } else {
      chips.el.append(h('span', { class: 'dck-chip' }, sum.state === 'off' ? 'Off' : 'Nothing due'));
    }
    chips.el.append(h('span', { class: 'dck-chips-note' }, (settings.showInjected !== false ? 'Visible' : 'Hidden') + (sum.state === 'ready' ? ' - ~' + sum.tokens + ' tokens' : '')));
  }

  // The rounded box that visually holds the message input (it wraps the textarea in padding and a toolbar).
  // Falls back to the textarea itself when no such box is found.
  function composerRect(el) {
    const own = el.getBoundingClientRect();
    let best = own;
    let node = el.parentElement;
    for (let i = 0; i < 6 && node && node !== document.body; i++, node = node.parentElement) {
      const r = node.getBoundingClientRect();
      if (r.width > own.width + 200) break; // too wide to be the input box
      let radius = 0;
      try { radius = parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0; } catch (e) { /* ignore */ }
      if (radius >= 8 && r.width >= own.width && r.height >= own.height) best = r;
    }
    return best;
  }

  const CHIP_GAP = 12; // space between the chip row and the message box

  function positionChips() {
    if (!chips.el) return;
    const el = getComposer();
    const r = el ? composerRect(el) : null;
    const show = settings.enabled && settings.showChips && r && r.width > 0;
    chips.el.style.display = show ? 'flex' : 'none';
    if (!show) return;
    chips.el.style.left = Math.max(8, r.left + 4) + 'px';
    chips.el.style.width = Math.max(260, Math.min(r.width - 8, 760)) + 'px';
    chips.el.style.bottom = Math.max(8, window.innerHeight - r.top + CHIP_GAP) + 'px';
  }

  function refreshAll(force) {
    const sum = currentSummary();
    const sig = [settings.showInjected, settings.showSummary, settings.showChips, sum.state, sum.names.join('|'), sum.memories, sum.skipped, sum.tokens].join('~');
    if (force || sig !== liveSig) {
      liveSig = sig;
      renderStrip(sum);
      renderChips(sum);
    }
    positionChips();
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
    if (e.target instanceof HTMLTextAreaElement && !e.target.closest('#dck-drawer')) { updatePicker(); refreshAll(false); }
  }, true);

  // ---------- Enter handling ----------
  document.addEventListener(
    'keydown',
    (e) => {
      if (bypass) return; // our own synthetic Enter
      const el = e.target;
      if (!(el instanceof HTMLTextAreaElement)) return;
      if (el.closest('#dck-drawer')) return; // typing in the drawer never triggers sends
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
      if (!par || par.closest('textarea, #dck-drawer, #dck-picker, #dck-chips, #dck-toast')) return;
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
      if (settings.codeTools !== false) scheduleCodeScan();
      if (settings.collapseLong) scheduleCollapseScan();
      if (settings.showInjected !== false) return;
      const nodes = [];
      records.forEach((r) => {
        if (r.type === 'characterData') nodes.push(r.target);
        else r.addedNodes.forEach((n) => nodes.push(n));
      });
      if (nodes.length) scheduleStrip(nodes);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ---------- UI helpers ----------
  const SVGNS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    close: 'M18 6 6 18|M6 6l12 12',
    chev: 'M6 9l6 6 6-6',
    expand: 'M15 3h6v6|M9 21H3v-6|M21 3l-7 7|M3 21l7-7',
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
  function promptRow(p, builtin) {
    const customized = builtin && (settings.defaultText || '').trim();
    return h('div', { class: 'dck-card dck-rowcard' },
      sw(builtin ? settings.defaultEnabled !== false : p.enabled, (v) => {
        if (builtin) settings.defaultEnabled = v; else p.enabled = v;
        commit();
      }, 'Enable ' + (builtin ? 'Default' : (p.name || 'Untitled')) + ' prompt'),
      h('div', { class: 'dck-grow' },
        h('div', { class: 'dck-name' }, builtin ? 'Default' : (p.name || 'Untitled'),
          builtin ? h('span', { class: 'dck-badge' }, customized ? 'Customized' : 'Built-in') : null),
        h('div', { class: 'dck-sub' }, builtin ? describeSchedule(settings.defaultSchedule, settings.defaultEveryN) : describeSchedule(p.schedule, p.everyN))),
      iconBtn('edit', 'Edit ' + (builtin ? 'Default' : (p.name || 'Untitled')) + ' prompt', () => { ui.editingId = builtin ? 'default' : p.id; render(); }));
  }

  function promptEditor(p, builtin) {
    const name = h('input', { value: builtin ? '' : (p.name || ''), placeholder: 'Name', 'aria-label': 'Prompt name', style: builtin ? 'display:none' : '' });
    const text = h('textarea', { value: builtin ? defaultPromptText(settings) : p.text, placeholder: 'Prompt text', 'aria-label': 'Prompt text' });
    let sched = builtin ? (settings.defaultSchedule || 'first') : (p.schedule || 'first');
    const everyN = h('input', { type: 'number', min: 1, value: builtin ? (settings.defaultEveryN || 5) : (p.everyN || 5), 'aria-label': 'Every N messages', style: sched === 'every' ? '' : 'display:none' });
    const sel = scheduleSelect(sched, (v) => { sched = v; everyN.style.display = v === 'every' ? '' : 'none'; });
    return h('div', { class: 'dck-card dck-editor' },
      name, text, varChips(text), sel, everyN,
      h('div', { class: 'dck-actions' },
        h('button', {
          type: 'button', class: 'dck-btn primary',
          onclick: () => {
            const n = Math.max(1, parseInt(everyN.value, 10) || 5);
            if (builtin) {
              settings.defaultText = text.value.trim() === BUILTIN_DEFAULT_PROMPT.trim() ? '' : text.value;
              settings.defaultSchedule = sched;
              settings.defaultEveryN = n;
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
        builtin
          ? h('button', { type: 'button', class: 'dck-btn danger push', onclick: () => { settings.defaultText = ''; ui.editingId = null; commit(); render(); } }, 'Reset to built-in')
          : h('button', { type: 'button', class: 'dck-btn danger push', onclick: () => { settings.prompts = settings.prompts.filter((x) => x.id !== p.id); ui.editingId = null; commit(); render(); } }, 'Delete')));
  }

  function renderPrompts(body) {
    body.append(group('Built-in'));
    body.append(ui.editingId === 'default' ? promptEditor(null, true) : promptRow(null, true));
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
    const el = getComposer();
    const send = el ? findSendButton(el) : null;
    const pres = document.querySelectorAll('pre').length;
    const rows = [];
    const add = (label, ok, detail) => rows.push({ label: label, ok: ok, detail: detail });
    add('Message box', !!el, el ? '<' + el.tagName.toLowerCase() + '>' : 'not found - the site may have changed');
    add('Send button', send ? true : (settings.showInjected === false ? false : null), send ? 'found' : (settings.showInjected === false ? 'not found - Hidden mode cannot press send' : 'not found (only needed in Hidden mode)'));
    add('Chip row', settings.showChips === false ? null : !!el && !!document.getElementById('dck-chips') && !!composerRect(el), settings.showChips === false ? 'turned off' : 'placed above the message box');
    add('Hidden-mode cleanup', null, settings.showInjected === false ? 'on, ' + diag.stripped + ' block(s) hidden this session' : 'off (context is Visible)');
    add('Code blocks on page', null, pres + ' found, tools ' + (settings.codeTools === false ? 'off' : 'on'));
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
    const card = h('div', { class: 'dck-diag' });
    diagnostics().forEach((r) => card.append(h('div', { class: 'dck-diagrow' },
      h('span', { class: 'dck-diagdot ' + (r.ok === true ? 'ok' : r.ok === false ? 'bad' : 'info') }),
      h('div', { class: 'dck-grow' }, h('div', { class: 'dck-name' }, r.label), h('div', { class: 'dck-sub' }, r.detail)))));
    card.append(h('div', { class: 'dck-sub dck-diagevents-title' }, 'Recent events'));
    if (!diag.events.length) card.append(h('div', { class: 'dck-sub' }, 'Nothing yet this session.'));
    diag.events.slice(-8).reverse().forEach((e) => card.append(h('div', { class: 'dck-sub dck-diagevent' }, e.t.toTimeString().slice(0, 8) + '  ' + e.msg)));
    body.append(card);
    body.append(h('div', { class: 'dck-two' },
      h('button', { type: 'button', class: 'dck-btn', onclick: () => render() }, 'Refresh'),
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

  function renderSettings(body, drawer) {
    const onCount = (list) => list.filter(Boolean).length + ' of ' + list.length + ' on';
    body.append(accordion('messages', 'Messages', onCount([settings.autoInsertOnEnter, settings.showSummary, settings.showChips]), (box) => {
      box.append(settingRow('Insert context on Enter', 'Off: use the Insert now button only', settings.autoInsertOnEnter, (v) => { settings.autoInsertOnEnter = v; commit(); }));
      box.append(settingRow('Next-message summary', 'The strip under the header', settings.showSummary, (v) => { settings.showSummary = v; commit(); }));
      box.append(settingRow('Chips above message box', 'Shows what will be attached', settings.showChips, (v) => { settings.showChips = v; commit(); }));
    }));

    body.append(accordion('code', 'Code blocks', settings.codeTools === false ? 'Off' : 'Collapse and ZIP', (box) => {
      box.append(settingRow('Code block tools', 'Adds Collapse and + ZIP next to Copy and Download', settings.codeTools !== false, (v) => {
        settings.codeTools = v;
        if (!v) hideBar();
        commit(); syncAll();
      }));
      box.append(settingRow('Collapse long blocks', 'Blocks over ' + (settings.collapseLines || 20) + ' lines start collapsed', !!settings.collapseLong, (v) => {
        settings.collapseLong = v;
        if (v) scheduleCollapseScan(); else { document.querySelectorAll('pre[data-dck-collapsed]').forEach((p) => setCollapsed(p, false)); syncAll(); }
        commit();
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
        const data = JSON.parse(await importInput.files[0].text());
        if (data.settings) settings = migrateSettings(data.settings);
        if (Array.isArray(data.memories)) memories = data.memories;
        commit(); render(); toast('Imported');
      } catch (err) { toast('Invalid file'); }
    });
    body.append(accordion('data', 'Backup', 'Export or import your prompts, notes and snippets', (box) => {
      box.append(h('div', { class: 'dck-two' },
        h('button', {
          type: 'button', class: 'dck-btn',
          onclick: () => {
            const blob = new Blob([JSON.stringify({ settings, memories }, null, 2)], { type: 'application/json' });
            const a = h('a', { href: URL.createObjectURL(blob), download: 'deepseek-kit.json' });
            a.click(); URL.revokeObjectURL(a.href);
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
    else renderSettings(body, drawer);
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
            settings = migrateSettings({}); memories = []; ui.editingMemory = null; counts = {}; store.set({ dck_counts: counts }); ui.editingId = null; ui.editingSnippetId = null; commit(); render();
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

  // ---------- Code block tools (buttons in the code block header: collapse, ZIP basket) ----------
  const tools = { bar: null, pre: null, basket: [], hideTimer: 0, headed: new WeakMap(), zip: null, scanQueued: false };
  const collapse = { touched: new WeakSet(), queued: false };

  function lineCount(pre) { return (pre.textContent || '').replace(/\n$/, '').split('\n').length; }

  function setCollapsed(pre, on) {
    if (on) pre.setAttribute('data-dck-collapsed', ''); else pre.removeAttribute('data-dck-collapsed');
  }

  function blockInfo(pre) {
    const codeEl = pre.querySelector('code');
    const text = (codeEl || pre).textContent.replace(/\n$/, '');
    const hints = [langFromClass((codeEl && codeEl.className) || ''), langFromClass(pre.className)];
    const prev = pre.previousElementSibling || (pre.parentElement && pre.parentElement.firstElementChild !== pre ? pre.parentElement.firstElementChild : null);
    const label = prev ? String(prev.textContent || '').trim().split(/\s+/)[0] : '';
    if (label && label.length <= 20) hints.push(label);
    const info = detectBlock(hints, text);
    const all = Array.from(document.querySelectorAll('pre'));
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

  // ----- the buttons themselves
  // What a block offers: [id, label, handler]
  function actionsFor(pre) {
    const info = blockInfo(pre);
    const folded = pre.hasAttribute('data-dck-collapsed');
    const inBasket = tools.basket.some((b) => b.el === pre);
    const list = [];
    if (folded || lineCount(pre) > 3) list.push(['collapse', folded ? 'Expand' : 'Collapse', () => { collapse.touched.add(pre); setCollapsed(pre, !pre.hasAttribute('data-dck-collapsed')); syncAll(); }]);
    list.push(['zip', inBasket ? 'Added' : '+ ZIP', () => toggleBasket(pre)]);
    return list;
  }

  // The site's own "Copy" button of this block, found by its text. Null when the block has no header.
  function findCopyButton(pre) {
    let box = pre.parentElement;
    for (let i = 0; i < 4 && box && box !== document.body; i++, box = box.parentElement) {
      if (box.querySelectorAll('pre').length > 1) return null;
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = n.nodeValue.trim();
        if (t !== 'Copy' && t !== 'Copy code') continue;
        if (pre.contains(n) || n.parentElement.closest('[data-dck-act]')) continue;
        let btn = n.parentElement;
        while (btn.parentElement && btn.parentElement !== box && btn.parentElement.textContent.trim() === t) btn = btn.parentElement;
        if (btn.parentElement && !(pre.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING)) return btn;
      }
    }
    return null;
  }

  // Sets the visible text of a cloned button without flattening its inner markup.
  function setLabel(btn, label) {
    const walker = document.createTreeWalker(btn, NodeFilter.SHOW_TEXT);
    let n = walker.nextNode();
    while (n && !n.nodeValue.trim()) n = walker.nextNode();
    if (!n) { btn.textContent = label; return; }
    if (n.nodeValue !== label) n.nodeValue = label;
    // any further text (e.g. a second span) is cleared so only the label remains
    while ((n = walker.nextNode())) { if (n.nodeValue.trim()) n.nodeValue = ''; }
  }

  function removeHeaderButtons(pre) {
    const box = pre.parentElement && pre.parentElement.parentElement;
    if (box) box.querySelectorAll('[data-dck-act]').forEach((n) => n.remove());
  }

  // Puts our buttons next to Copy / Download. Returns true when the block has a header to put them in.
  function syncHeader(pre) {
    const copy = findCopyButton(pre);
    if (!copy) return false;
    const row = copy.parentElement;
    const want = actionsFor(pre);
    const have = Array.from(row.querySelectorAll(':scope > [data-dck-act]'));
    const same = have.length === want.length && have.every((n, i) => n.getAttribute('data-dck-act') === want[i][0]);
    if (!same) {
      have.forEach((n) => n.remove());
      want.forEach((w) => {
        // Deep clone so the label keeps the site's own inner element and styling, then drop the icon.
        const b = copy.cloneNode(true);
        b.removeAttribute('id');
        b.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
        b.querySelectorAll('svg, img').forEach((n) => n.remove());
        setLabel(b, w[1]);
        b.setAttribute('data-dck-act', w[0]);
        b.setAttribute('role', 'button');
        b.setAttribute('tabindex', '0');
        b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); w[2](); });
        b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); w[2](); } });
        row.insertBefore(b, copy);
      });
    }
    row.querySelectorAll(':scope > [data-dck-act]').forEach((n, i) => setLabel(n, want[i][1]));
    return true;
  }

  function syncAll() {
    document.querySelectorAll('pre').forEach((pre) => {
      if (pre.closest('#dck-drawer')) return;
      if (settings.codeTools === false) { removeHeaderButtons(pre); tools.headed.set(pre, false); return; }
      tools.headed.set(pre, syncHeader(pre));
    });
    if (tools.pre) updateBar();
  }

  function scheduleCodeScan() {
    if (tools.scanQueued) return;
    tools.scanQueued = true;
    requestAnimationFrame(() => { tools.scanQueued = false; syncAll(); });
  }

  function scheduleCollapseScan() {
    if (collapse.queued) return;
    collapse.queued = true;
    requestAnimationFrame(() => {
      collapse.queued = false;
      if (!settings.collapseLong) return;
      const limit = Math.max(3, settings.collapseLines || 20);
      let changed = false;
      document.querySelectorAll('pre').forEach((pre) => {
        if (collapse.touched.has(pre) || pre.closest('#dck-drawer')) return;
        if (lineCount(pre) > limit) { collapse.touched.add(pre); setCollapsed(pre, true); changed = true; }
      });
      if (changed) syncAll();
    });
  }

  // ----- fallback: floating bar for blocks without a header
  function updateBar() {
    const bar = tools.bar;
    if (!bar || !tools.pre) return;
    const pre = tools.pre;
    bar.textContent = '';
    actionsFor(pre).forEach((w) => bar.append(h('button', { type: 'button', class: 'dck-cbtn' + (w[0] === 'zip' && w[1] === 'Added' ? ' on' : ''), onclick: () => { w[2](); placeBar(); } }, w[1])));
  }

  function placeBar() {
    if (!tools.bar || !tools.pre || !tools.pre.isConnected) return hideBar();
    const r = tools.pre.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return hideBar();
    tools.bar.style.display = 'flex';
    tools.bar.style.top = Math.max(6, r.top + 6) + 'px';
    tools.bar.style.left = Math.max(6, Math.min(window.innerWidth - tools.bar.offsetWidth - 6, r.right - tools.bar.offsetWidth - 8)) + 'px';
  }

  function hideBar() {
    if (tools.bar) tools.bar.style.display = 'none';
    tools.pre = null;
  }

  function initCodeTools() {
    if (tools.bar) return;
    tools.bar = h('div', { id: 'dck-codebar', style: 'display:none' });
    document.body.append(tools.bar);
    const keep = () => { clearTimeout(tools.hideTimer); };
    const later = () => { clearTimeout(tools.hideTimer); tools.hideTimer = setTimeout(hideBar, 350); };
    tools.bar.addEventListener('mouseenter', keep);
    tools.bar.addEventListener('mouseleave', later);
    document.addEventListener('mouseover', (e) => {
      if (settings.codeTools === false || !(e.target instanceof Element)) return;
      if (e.target.closest('#dck-codebar, #dck-drawer')) return;
      const pre = e.target.closest('pre');
      if (!pre || tools.headed.get(pre)) { if (tools.pre) later(); return; }
      keep();
      if (pre !== tools.pre) { tools.pre = pre; updateBar(); }
      placeBar();
    });
    window.addEventListener('scroll', () => { if (tools.pre) placeBar(); }, true);
    window.addEventListener('resize', () => { if (tools.pre) placeBar(); });
    syncAll();
  }

  function mount() {
    if (document.getElementById('dck-fab')) return;
    const drawer = h('div', { id: 'dck-drawer' });
    ui.drawer = drawer;
    const fab = h('button', { id: 'dck-fab', type: 'button', onclick: () => { ui.preview = null; render(); drawer.classList.toggle('open'); } }, 'Kit');
    document.body.append(fab, drawer);
    render();
    startObserver();
    initCodeTools();
    if (settings.collapseLong) scheduleCollapseScan();
    if (settings.showInjected === false) scheduleStrip([document.body]);
  }

  load().then(mount);
})();
