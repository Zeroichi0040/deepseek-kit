/* DeepSeek Kit - local-only, no network calls, no request patching.
 * It edits the text in your message box (and optionally hides its own inserted block in the chat view). */
(function () {
  'use strict';

  // ---------- Pure logic (unit-testable) ----------
  const MARKER_START = '[Context from my notes]';
  const MARKER_END = '[End of context]';

  const BUILTIN_DEFAULT_PROMPT = [
    'You are a helpful, honest assistant. Today is {{date}} ({{weekday}}), local time {{time}} {{timezone}}.',
    '- Answer directly: lead with the answer, then add supporting detail only as needed.',
    '- Match the length and depth of your reply to the question. Do not pad.',
    '- If you are unsure or lack current information, say so instead of guessing.',
    '- Ask one short clarifying question only when the request is genuinely ambiguous; otherwise make a reasonable assumption and state it.',
    '- Put code, commands and file contents in fenced code blocks with a language tag.',
    '- Use plain prose by default; use lists or tables only when they make the content easier to scan.',
    '- Reply in the language the user writes in.',
  ].join('\n');

  const DEFAULTS = {
    enabled: true,
    showInjected: true, // false = attach context automatically and hide it in the chat
    autoInsertOnEnter: true,
    memoryEnabled: true,
    showSummary: true, // the "next message includes" strip in the drawer
    showChips: true, // the chip row above the message box
    prompts: [], // [{ id, name, text, enabled, schedule, everyN }]
    defaultEnabled: true, // built-in default prompt
    defaultText: '', // '' = use the built-in text
    defaultSchedule: 'first',
    defaultEveryN: 5,
    snippets: [], // [{ id, name, text }]
  };

  const VARIABLES = [
    { name: 'date', desc: 'Today, YYYY-MM-DD' },
    { name: 'time', desc: 'Local time, 24-hour' },
    { name: 'datetime', desc: 'Date and time' },
    { name: 'weekday', desc: 'e.g. Saturday' },
    { name: 'timezone', desc: 'e.g. Asia/Manila' },
    { name: 'message_number', desc: 'Message # in this chat' },
    { name: 'selection', desc: 'Text selected on the page' },
  ];
  const VARIABLE_NAMES = VARIABLES.map((v) => v.name);
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // Normalizes stored settings. Older versions had a single "systemPrompt" plus a multi-prompt switch;
  // now there is just a list, so a leftover single prompt becomes the first list entry.
  function migrateSettings(raw) {
    const s = { ...DEFAULTS, ...(raw || {}) };
    s.prompts = Array.isArray(s.prompts) ? s.prompts.slice() : [];
    s.snippets = Array.isArray(s.snippets) ? s.snippets.slice() : [];
    const legacy = String(s.systemPrompt || '');
    if (legacy.trim()) {
      s.prompts.unshift({
        id: newId(),
        name: s.multiPrompt ? 'Previous prompt' : 'Custom prompt',
        text: legacy,
        enabled: !s.multiPrompt, // in multi mode the single prompt was not in use, so keep it switched off
        schedule: s.mode || 'first',
        everyN: s.everyN || 5,
      });
    }
    delete s.systemPrompt;
    delete s.mode;
    delete s.everyN;
    delete s.multiPrompt;
    return s;
  }

  function hasLegacyKeys(raw) {
    return !!raw && ('systemPrompt' in raw || 'multiPrompt' in raw || 'mode' in raw || 'everyN' in raw);
  }

  function tokens(s) {
    return new Set(
      String(s || '')
        .toLowerCase()
        .split(/[^a-z0-9\u00c0-\uffff]+/)
        .filter((t) => t.length > 2)
    );
  }

  // "always" memories are always included; "called" ones only when the key's words appear in the message.
  function selectMemories(memories, userText) {
    const msg = tokens(userText);
    return (memories || []).filter((m) => {
      if (!m || !m.key) return false;
      if (m.importance === 'always') return true;
      const kt = tokens(m.key);
      if (kt.size === 0) return false;
      for (const t of kt) if (msg.has(t)) return true;
      return false;
    });
  }

  // sentCount = how many messages have already been sent in this chat.
  function scheduleDue(mode, everyN, sentCount) {
    if (mode === 'always') return true;
    if (mode === 'every') {
      const n = Math.max(1, parseInt(everyN, 10) || 1);
      return sentCount % n === 0;
    }
    return sentCount === 0; // 'first'
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function localTimezone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
  }

  // Replaces {{date}}, {{time}}, ... Unknown variables are left untouched.
  function applyVariables(text, ctx) {
    ctx = ctx || {};
    const d = ctx.now || new Date();
    const vars = {
      date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
      time: pad(d.getHours()) + ':' + pad(d.getMinutes()),
      weekday: WEEKDAYS[d.getDay()],
      timezone: ctx.timezone || localTimezone(),
      message_number: String(ctx.messageNumber || 1),
      selection: ctx.selection || '',
    };
    vars.datetime = vars.date + ' ' + vars.time;
    return String(text == null ? '' : text).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => {
      k = k.toLowerCase();
      return Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m;
    });
  }

  function defaultPromptText(settings) {
    return (settings.defaultText || '').trim() ? settings.defaultText : BUILTIN_DEFAULT_PROMPT;
  }

  // Every prompt that may take part: the built-in default, then your own list.
  function promptEntries(settings) {
    const list = [];
    if (settings.defaultEnabled !== false) {
      list.push({ id: 'default', name: 'Default', text: defaultPromptText(settings), enabled: true, schedule: settings.defaultSchedule || 'first', everyN: settings.defaultEveryN || 5 });
    }
    (settings.prompts || []).forEach((p) => { if (p) list.push(p); });
    return list;
  }

  function shouldInject(settings, sentCount) {
    if (!settings.enabled) return false;
    return promptEntries(settings).some((e) => e.enabled && (e.text || '').trim() && scheduleDue(e.schedule, e.everyN, sentCount));
  }

  // Prompts that go out with this message. `force` ignores schedules (the "Insert now" button).
  function activePrompts(settings, sentCount, force) {
    return promptEntries(settings)
      .filter((e) => e && e.enabled && (e.text || '').trim() && (force || scheduleDue(e.schedule, e.everyN, sentCount)))
      .map((e) => ({ name: (e.name || '').trim() || 'Untitled', text: e.text.trim() }));
  }

  function buildPrefix(settings, memories, userText, sentCount, force, ctx) {
    const parts = activePrompts(settings, sentCount || 0, !!force).map((p) => 'Instructions (' + p.name + '):\n' + p.text);
    if (settings.memoryEnabled) {
      const sel = selectMemories(memories, userText);
      if (sel.length) {
        parts.push('Things to remember about me:\n' + sel.map((m) => '- ' + m.key + ': ' + m.value).join('\n'));
      }
    }
    if (!parts.length) return '';
    const out = MARKER_START + '\n' + parts.join('\n\n') + '\n' + MARKER_END + '\n\n';
    return ctx ? applyVariables(out, ctx) : out;
  }

  function estimateTokens(text) {
    return Math.ceil(String(text || '').length / 4);
  }

  // What the next message will carry, for the strip in the drawer and the chips above the message box.
  function summarize(settings, memories, userText, sentCount) {
    if (!settings.enabled) return { state: 'off', names: [], memories: 0, tokens: 0 };
    if (!shouldInject(settings, sentCount)) return { state: 'idle', names: [], memories: 0, tokens: 0 };
    const names = activePrompts(settings, sentCount, false).map((p) => p.name);
    const mem = settings.memoryEnabled ? selectMemories(memories, userText).length : 0;
    const prefix = buildPrefix(settings, memories, userText, sentCount, false, {});
    return { state: 'ready', names: names, memories: mem, tokens: estimateTokens(prefix) };
  }

  function memoryLabel(n) {
    return n + (n === 1 ? ' memory' : ' memories');
  }

  function describeSummary(sum) {
    if (sum.state === 'off') return 'Kit is off';
    if (sum.state === 'idle') return 'Nothing is due for the next message';
    let t = sum.names.join(', ');
    if (sum.memories) t += (t ? ' + ' : '') + memoryLabel(sum.memories);
    return 'Next message includes ' + t;
  }

  function alreadyHasContext(text) {
    return String(text || '').trimStart().startsWith(MARKER_START);
  }

  // Removes the inserted block (used to hide it in the chat view when "show inserted context" is off).
  function stripContext(text) {
    return String(text || '').replace(/\[Context from my notes\][\s\S]*?\[End of context\]\s*/, '');
  }

  // "/foo" (and nothing else) in the message box opens the snippet picker.
  function slashQuery(value) {
    const m = /^\/([^\s\/]*)$/.exec(String(value || ''));
    return m ? m[1] : null;
  }

  function cleanSnippetName(s) {
    return String(s || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_\-\u00c0-\uffff]/g, '');
  }

  function filterSnippets(snippets, query, limit) {
    const q = String(query || '').toLowerCase();
    return (snippets || [])
      .filter((s) => s && s.name && String(s.name).toLowerCase().includes(q))
      .sort((a, b) => {
        const as = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bs = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return as - bs || a.name.localeCompare(b.name);
      })
      .slice(0, limit || 8);
  }

  // Drawer search box: matches the name or the text, keeps your order.
  function searchSnippets(snippets, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return (snippets || []).filter(Boolean);
    return (snippets || []).filter((s) => s && ((s.name || '').toLowerCase().includes(q) || (s.text || '').toLowerCase().includes(q)));
  }

  function describeSchedule(schedule, everyN) {
    if (schedule === 'always') return 'Every message';
    if (schedule === 'every') return 'Every ' + Math.max(1, parseInt(everyN, 10) || 1) + ' messages';
    return 'First message';
  }

  // A chat other than the new-chat screen ("/") already has messages in it. Used when we have no record of a chat,
  // for example after a page refresh, so "first message" prompts do not fire again in the middle of a conversation.
  function isExistingChatPath(path) {
    const p = String(path == null ? '/' : path);
    return p !== '/' && p !== '';
  }

  // How many messages have been sent in this chat. Unknown existing chats count as 1 (already started).
  function resolveCount(counts, path) {
    if (counts && Object.prototype.hasOwnProperty.call(counts, path)) {
      const n = Number(counts[path]);
      if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    }
    return isExistingChatPath(path) ? 1 : 0;
  }

  // Keeps only the most recently updated chats so the stored counters cannot grow without limit.
  function pruneCounts(counts, max) {
    const keys = Object.keys(counts || {});
    if (keys.length <= max) return counts || {};
    const out = {};
    keys.slice(keys.length - max).forEach((k) => { out[k] = counts[k]; });
    return out;
  }

  // Inserts text into `value` at the selection; returns the new value and caret position.
  function insertAt(value, start, end, text) {
    value = String(value || '');
    start = Math.max(0, Math.min(start == null ? value.length : start, value.length));
    end = Math.max(start, Math.min(end == null ? start : end, value.length));
    return { value: value.slice(0, start) + text + value.slice(end), caret: start + text.length };
  }

  const core = {
    DEFAULTS, BUILTIN_DEFAULT_PROMPT, VARIABLES, VARIABLE_NAMES, migrateSettings, hasLegacyKeys, tokens, selectMemories,
    scheduleDue, applyVariables, promptEntries, shouldInject, activePrompts, buildPrefix, estimateTokens, summarize,
    describeSummary, memoryLabel, alreadyHasContext, stripContext, slashQuery, cleanSnippetName, filterSnippets,
    searchSnippets, describeSchedule, insertAt, isExistingChatPath, resolveCount, pruneCounts, MARKER_START, MARKER_END,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = core;
    return;
  }

  // ---------- Extension runtime ----------
  const store = chrome.storage.local;
  let settings = migrateSettings({});
  let memories = [];
  const ui = { drawer: null, strip: null, tab: 'prompts', editingId: null, editingSnippetId: null, search: '', showAllVars: false, preview: null };
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
    if (!el) { toast('Message box not found'); return false; }
    const text = el.value;
    if (!text.trim()) { if (force) toast('Type a message first'); return false; }
    if (alreadyHasContext(text)) { if (force) toast('Context is already in the message'); return false; }
    const count = chatCount();
    if (!force && !shouldInject(settings, count)) return false;
    const prefix = buildPrefix(settings, memories, text, count, force, ctxFor(count));
    if (!prefix) { if (force) toast('Nothing to insert - switch on a prompt or add a memory note'); return false; }
    setNativeValue(el, prefix + text);
    return true;
  }

  // ---------- Sending (used only by "hide inserted context" mode) ----------
  function clickSend(el) {
    let node = el;
    for (let i = 0; i < 6 && node && node.parentElement; i++) {
      node = node.parentElement;
      const btns = Array.from(node.querySelectorAll('[role="button"], button')).filter(
        (b) => !b.closest('#dck-drawer, #dck-picker, #dck-chips') && b.querySelector('svg') && b.getAttribute('aria-disabled') !== 'true' && !b.disabled
      );
      if (btns.length) { btns[btns.length - 1].click(); return true; }
    }
    return false;
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
      if (!alreadyHasContext(el.value)) { delete el.dataset.dckCounted; return; }
      if (!clickSend(el)) toast('Could not send automatically - press Enter to send');
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
    const sig = [settings.showInjected, settings.showSummary, settings.showChips, sum.state, sum.names.join('|'), sum.memories, sum.tokens].join('~');
    if (force || sig !== liveSig) {
      liveSig = sig;
      renderStrip(sum);
      renderChips(sum);
    }
    positionChips();
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
        if (v !== node.nodeValue) node.nodeValue = v;
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
      else if (k === 'style' || k === 'role' || k.indexOf('aria-') === 0 || k.indexOf('data-') === 0) n.setAttribute(k, v);
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
  function renderMemory(body) {
    body.append(toggleCard('Use memory', 'Notes are added whenever context is inserted', settings.memoryEnabled, (v) => { settings.memoryEnabled = v; commit(); }));
    body.append(group('Notes'));
    if (!memories.length) body.append(h('div', { class: 'dck-hint' }, 'No notes yet. Add one below.'));
    memories.forEach((m, i) => {
      body.append(h('div', { class: 'dck-card dck-rowcard' },
        h('div', { class: 'dck-grow' }, h('div', { class: 'dck-name' }, m.key), h('div', { class: 'dck-sub' }, m.value)),
        h('span', { class: 'dck-badge' + (m.importance === 'always' ? '' : ' green') }, m.importance === 'always' ? 'Always' : 'When mentioned'),
        iconBtn('trash', 'Delete ' + m.key, () => { memories.splice(i, 1); commit(); render(); })));
    });
    const key = h('input', { placeholder: 'Key, e.g. my city', 'aria-label': 'Key' });
    const val = h('input', { placeholder: 'Value', 'aria-label': 'Value' });
    const imp = h('select', { 'aria-label': 'When to include' },
      h('option', { value: 'always' }, 'Always'),
      h('option', { value: 'called' }, 'When mentioned'));
    body.append(h('div', { class: 'dck-card dashed-card' },
      h('div', { class: 'dck-two' }, key, val),
      h('div', { class: 'dck-two' }, imp, h('button', {
        type: 'button', class: 'dck-btn primary',
        onclick: () => {
          if (!key.value.trim() || !val.value.trim()) { toast('Add a key and a value'); return; }
          memories.push({ key: key.value.trim(), value: val.value.trim(), importance: imp.value });
          commit(); render();
        },
      }, icon('plus', 14), 'Add'))));
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
  function renderSettings(body, drawer) {
    body.append(group('Behavior'));
    body.append(toggleCard('Insert context on Enter', 'Off: use the Insert now button only', settings.autoInsertOnEnter, (v) => { settings.autoInsertOnEnter = v; commit(); }));
    body.append(toggleCard('Next-message summary', 'The strip under the header', settings.showSummary, (v) => { settings.showSummary = v; commit(); }));
    body.append(toggleCard('Chips above message box', 'Shows what will be attached', settings.showChips, (v) => { settings.showChips = v; commit(); }));

    body.append(group('Variables'));
    const grid = h('div', { class: 'dck-card dck-vargrid' });
    VARIABLES.forEach((v) => grid.append(h('div', {}, h('span', { class: 'dck-vchip static' }, '{{' + v.name + '}}'), h('div', { class: 'dck-faint' }, v.desc))));
    body.append(grid);

    const importInput = h('input', { type: 'file', accept: 'application/json', style: 'display:none', 'aria-label': 'Import file' });
    importInput.addEventListener('change', async () => {
      try {
        const data = JSON.parse(await importInput.files[0].text());
        if (data.settings) settings = migrateSettings(data.settings);
        if (Array.isArray(data.memories)) memories = data.memories;
        commit(); render(); toast('Imported');
      } catch (err) { toast('Invalid file'); }
    });
    body.append(group('Backup'));
    body.append(h('div', { class: 'dck-two' },
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
        onclick: () => { ui.tab = t.id; ui.editingId = null; ui.editingSnippetId = null; render(); },
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
            settings = migrateSettings({}); memories = []; counts = {}; store.set({ dck_counts: counts }); ui.editingId = null; ui.editingSnippetId = null; commit(); render();
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

  function mount() {
    if (document.getElementById('dck-fab')) return;
    const drawer = h('div', { id: 'dck-drawer' });
    ui.drawer = drawer;
    const fab = h('button', { id: 'dck-fab', type: 'button', onclick: () => { ui.preview = null; render(); drawer.classList.toggle('open'); } }, 'Kit');
    document.body.append(fab, drawer);
    render();
    startObserver();
    if (settings.showInjected === false) scheduleStrip([document.body]);
  }

  load().then(mount);
})();
