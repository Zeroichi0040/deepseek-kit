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
    systemPrompt: '',
    mode: 'first', // single-prompt schedule: 'first' | 'every' | 'always'
    everyN: 5,
    memoryEnabled: true,
    autoInsertOnEnter: true,
    multiPrompt: false,
    prompts: [], // [{ id, name, text, enabled, schedule, everyN }]
    defaultEnabled: true, // built-in default prompt
    defaultText: '', // '' = use the built-in text
    defaultSchedule: 'first',
    defaultEveryN: 5,
    snippets: [], // [{ id, name, text }]
  };

  const VARIABLE_NAMES = ['date', 'time', 'datetime', 'weekday', 'timezone', 'message_number', 'selection'];
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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

  // Every prompt that may take part: the built-in default, then either the single prompt or the multi list.
  function promptEntries(settings) {
    const list = [];
    if (settings.defaultEnabled !== false) {
      list.push({ id: 'default', name: 'Default', text: defaultPromptText(settings), enabled: true, schedule: settings.defaultSchedule || 'first', everyN: settings.defaultEveryN || 5 });
    }
    if (settings.multiPrompt) {
      (settings.prompts || []).forEach((p) => { if (p) list.push(p); });
    } else {
      list.push({ id: 'single', name: '', text: settings.systemPrompt || '', enabled: true, schedule: settings.mode, everyN: settings.everyN });
    }
    return list;
  }

  function shouldInject(settings, sentCount) {
    if (!settings.enabled) return false;
    return promptEntries(settings).some((e) => e.enabled && scheduleDue(e.schedule, e.everyN, sentCount));
  }

  // Prompts that go out with this message. `force` ignores schedules (the "Insert now" button).
  function activePrompts(settings, sentCount, force) {
    return promptEntries(settings)
      .filter((e) => e && e.enabled && (e.text || '').trim() && (force || scheduleDue(e.schedule, e.everyN, sentCount)))
      .map((e) => ({ name: (e.name || '').trim(), text: e.text.trim() }));
  }

  function buildPrefix(settings, memories, userText, sentCount, force, ctx) {
    const parts = activePrompts(settings, sentCount || 0, !!force).map((p) =>
      (p.name ? 'Instructions (' + p.name + '):' : 'Instructions:') + '\n' + p.text
    );
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

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function describeSchedule(schedule, everyN) {
    if (schedule === 'always') return 'Always (every message)';
    if (schedule === 'every') return 'Every ' + Math.max(1, parseInt(everyN, 10) || 1) + ' messages';
    return 'Only on first message';
  }

  const core = {
    DEFAULTS, BUILTIN_DEFAULT_PROMPT, VARIABLE_NAMES, tokens, selectMemories, scheduleDue, applyVariables,
    promptEntries, shouldInject, activePrompts, buildPrefix, alreadyHasContext, stripContext, slashQuery,
    cleanSnippetName, filterSnippets, describeSchedule, MARKER_START, MARKER_END,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = core;
    return;
  }

  // ---------- Extension runtime ----------
  const store = chrome.storage.local;
  let settings = { ...DEFAULTS };
  let memories = [];
  let editingId = null; // prompt id, or 'default'
  let editingSnippetId = null;
  let bypass = false; // true while we dispatch our own Enter
  const sentCounts = {}; // per chat path
  let lastPath = location.pathname;

  function normalizeSettings(s) {
    const out = { ...DEFAULTS, ...(s || {}) };
    if (!Array.isArray(out.prompts)) out.prompts = [];
    if (!Array.isArray(out.snippets)) out.snippets = [];
    return out;
  }

  function load() {
    return new Promise((resolve) => {
      store.get(['dck_settings', 'dck_memories'], (r) => {
        settings = normalizeSettings(r.dck_settings);
        memories = Array.isArray(r.dck_memories) ? r.dck_memories : [];
        resolve();
      });
    });
  }
  function save() {
    store.set({ dck_settings: settings, dck_memories: memories });
  }

  // A new chat lives at "/" until the first message creates /a/chat/s/<id>; carry its counter over.
  setInterval(() => {
    const p = location.pathname;
    if (p !== lastPath) {
      if (lastPath === '/' && p !== '/') {
        sentCounts[p] = sentCounts['/'] || 0;
        sentCounts['/'] = 0;
      }
      lastPath = p;
    }
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
    if (!text.trim() || alreadyHasContext(text)) return false;
    const count = sentCounts[location.pathname] || 0;
    if (!force && !shouldInject(settings, count)) return false;
    const prefix = buildPrefix(settings, memories, text, count, force, ctxFor(count));
    if (!prefix) { if (force) toast('Nothing to insert - add a system prompt or memory first'); return false; }
    setNativeValue(el, prefix + text);
    return true;
  }

  // ---------- Sending (used only by "hide inserted context" mode) ----------
  function clickSend(el) {
    let node = el;
    for (let i = 0; i < 6 && node && node.parentElement; i++) {
      node = node.parentElement;
      const btns = Array.from(node.querySelectorAll('[role="button"], button')).filter(
        (b) => !b.closest('#dck-drawer, #dck-picker') && b.querySelector('svg') && b.getAttribute('aria-disabled') !== 'true' && !b.disabled
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
  }

  function updatePicker() {
    const el = getComposer();
    if (!el || !settings.enabled) { closePicker(); return; }
    const q = slashQuery(el.value);
    if (q === null) { closePicker(); return; }
    const items = filterSnippets(settings.snippets, q, 8);
    if (!items.length) { closePicker(); return; }
    picker.items = items;
    if (picker.index >= items.length) picker.index = 0;
    if (!picker.el) {
      picker.el = h('div', { id: 'dck-picker' });
      document.body.append(picker.el);
    }
    renderPicker();
    const r = el.getBoundingClientRect();
    picker.el.style.left = Math.max(8, r.left) + 'px';
    picker.el.style.width = Math.max(260, Math.min(r.width, 560)) + 'px';
    picker.el.style.bottom = Math.max(8, window.innerHeight - r.top + 8) + 'px';
    picker.el.style.display = 'block';
  }

  function chooseSnippet(s) {
    const el = getComposer();
    if (!el || !s) return;
    const count = sentCounts[location.pathname] || 0;
    const text = applyVariables(s.text, ctxFor(count));
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
  document.addEventListener('input', (e) => { if (e.target instanceof HTMLTextAreaElement) updatePicker(); }, true);

  // ---------- Enter handling ----------
  document.addEventListener(
    'keydown',
    (e) => {
      if (bypass) return; // our own synthetic Enter
      const el = e.target;
      if (!(el instanceof HTMLTextAreaElement)) return;
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      if (!settings.enabled || !settings.autoInsertOnEnter) return;
      if (!el.value.trim()) return;
      const p = location.pathname;

      if (alreadyHasContext(el.value)) {
        // Context is already in the box: this Enter sends.
        if (el.dataset.dckCounted) delete el.dataset.dckCounted;
        else sentCounts[p] = (sentCounts[p] || 0) + 1;
        return;
      }
      const count = sentCounts[p] || 0;
      if (!shouldInject(settings, count)) {
        sentCounts[p] = count + 1;
        return;
      }

      if (settings.showInjected !== false) {
        // Visible mode: put the context in the box, you review it and press Enter again.
        if (insertContext(false)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          toast('Context added - review it, then press Enter to send');
        } else {
          sentCounts[p] = count + 1;
        }
        return;
      }

      // Hidden mode: attach the context and send in one step; the inserted block is hidden in the chat view.
      const prefix = buildPrefix(settings, memories, el.value, count, false, ctxFor(count));
      if (!prefix) { sentCounts[p] = count + 1; return; }
      e.preventDefault();
      e.stopImmediatePropagation();
      sentCounts[p] = count + 1;
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
      if (!par || par.closest('textarea, #dck-drawer, #dck-picker, #dck-toast')) return;
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

  // ---------- UI ----------
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n[k] = v;
    }
    for (const c of kids.flat()) n.append(c && c.nodeType ? c : document.createTextNode(c == null ? '' : c));
    return n;
  }

  function sw(checked, onchange) {
    return h('label', { class: 'dck-switch' },
      h('input', { type: 'checkbox', checked: !!checked, onchange: (e) => onchange(e.target.checked) }),
      h('span', { class: 'dck-slider' }));
  }

  function toggleRow(label, checked, onchange, sub) {
    return h('div', { class: 'dck-toggle' },
      h('span', { class: 't' }, label, sub ? h('span', { class: 'sub' }, sub) : ''),
      sw(checked, onchange));
  }

  function scheduleSelect(value, onchange) {
    return h('select', { onchange: (e) => onchange(e.target.value) },
      h('option', { value: 'first', selected: value === 'first' }, 'Only on first message'),
      h('option', { value: 'every', selected: value === 'every' }, 'Every N messages'),
      h('option', { value: 'always', selected: value === 'always' }, 'Every message'));
  }

  // Shared editor for a prompt-like entry. opts: { showName, onSave(fields), extra: [buttons] }
  function entryEditor(drawer, entry, opts) {
    const name = h('input', { value: entry.name || '', placeholder: 'Name', style: opts.showName ? '' : 'display:none' });
    const text = h('textarea', { value: entry.text, placeholder: 'Prompt text' });
    let sched = entry.schedule || 'first';
    const everyN = h('input', { type: 'number', min: 1, value: entry.everyN || 5, style: sched === 'every' ? '' : 'display:none' });
    const sel = scheduleSelect(sched, (v) => { sched = v; everyN.style.display = v === 'every' ? '' : 'none'; });
    return h('div', { class: 'dck-card' },
      name, text, sel, everyN,
      h('div', { class: 'dck-hint' }, 'Variables: ' + VARIABLE_NAMES.map((v) => '{{' + v + '}}').join(' ')),
      h('div', { class: 'dck-row' },
        h('button', {
          onclick: () => opts.onSave({ name: name.value.trim() || 'Untitled', text: text.value, schedule: sched, everyN: Math.max(1, parseInt(everyN.value, 10) || 5) })
        }, 'Save'),
        h('button', { onclick: () => { editingId = null; render(drawer); } }, 'Cancel'),
        ...(opts.extra || [])));
  }

  function renderDefault(drawer, body) {
    body.append(h('h4', {}, 'Built-in default prompt'));
    if (editingId === 'default') {
      body.append(entryEditor(drawer,
        { text: defaultPromptText(settings), schedule: settings.defaultSchedule, everyN: settings.defaultEveryN },
        {
          showName: false,
          onSave: (f) => {
            settings.defaultText = f.text.trim() === BUILTIN_DEFAULT_PROMPT.trim() ? '' : f.text;
            settings.defaultSchedule = f.schedule;
            settings.defaultEveryN = f.everyN;
            editingId = null; save(); render(drawer);
          },
          extra: [h('button', { class: 'danger', onclick: () => { settings.defaultText = ''; editingId = null; save(); render(drawer); } }, 'Reset to built-in')],
        }));
      return;
    }
    body.append(h('div', { class: 'dck-card' },
      h('div', { class: 'dck-toggle' },
        h('span', { class: 't' },
          h('span', { class: 'name' }, 'Default' + (settings.defaultText ? ' (customized)' : '')),
          h('span', { class: 'sub' }, describeSchedule(settings.defaultSchedule, settings.defaultEveryN))),
        sw(settings.defaultEnabled !== false, (v) => { settings.defaultEnabled = v; save(); })),
      h('div', { class: 'dck-row' }, h('button', { class: 'link', onclick: () => { editingId = 'default'; render(drawer); } }, 'Edit'))));
  }

  function renderPrompts(drawer, body) {
    if (!settings.multiPrompt) {
      const prompt = h('textarea', { value: settings.systemPrompt, placeholder: 'e.g. Answer concisely. I am a Python developer.' });
      prompt.addEventListener('change', () => { settings.systemPrompt = prompt.value; save(); });
      const everyN = h('input', { type: 'number', min: 1, value: settings.everyN, onchange: (e) => { settings.everyN = parseInt(e.target.value, 10) || 1; save(); } });
      body.append(
        h('h4', {}, 'Your system prompt'),
        prompt,
        h('h4', {}, 'When to insert'),
        scheduleSelect(settings.mode, (v) => { settings.mode = v; save(); render(drawer); }),
        settings.mode === 'every' ? h('div', { class: 'dck-row' }, 'N =', everyN) : ''
      );
      return;
    }

    body.append(h('h4', {}, 'System prompts'));
    settings.prompts.forEach((p) => {
      if (editingId === p.id) {
        body.append(entryEditor(drawer, p, {
          showName: true,
          onSave: (f) => { Object.assign(p, f); editingId = null; save(); render(drawer); },
        }));
        return;
      }
      body.append(h('div', { class: 'dck-card' },
        h('div', { class: 'dck-toggle' },
          h('span', { class: 't' }, h('span', { class: 'name' }, p.name || 'Untitled'), h('span', { class: 'sub' }, describeSchedule(p.schedule, p.everyN))),
          sw(p.enabled, (v) => { p.enabled = v; save(); })),
        h('div', { class: 'dck-row' },
          h('button', { class: 'link', onclick: () => { editingId = p.id; render(drawer); } }, 'Edit'),
          h('button', {
            class: 'danger',
            onclick: () => { settings.prompts = settings.prompts.filter((x) => x.id !== p.id); save(); render(drawer); }
          }, 'Delete'))));
    });
    body.append(h('div', { class: 'dck-row' }, h('button', {
      onclick: () => {
        const p = { id: newId(), name: 'New prompt', text: '', enabled: true, schedule: 'first', everyN: 5 };
        settings.prompts.push(p); editingId = p.id; save(); render(drawer);
      }
    }, '+ Add prompt')));
  }

  function renderSnippets(drawer, body) {
    body.append(h('h4', {}, 'Snippets'),
      h('div', { class: 'dck-hint' }, 'Type / in the message box to pick one. Variables are filled in when you pick it.'));
    settings.snippets.forEach((s) => {
      if (editingSnippetId === s.id) {
        const name = h('input', { value: s.name, placeholder: 'name (used after the /)' });
        const text = h('textarea', { value: s.text, placeholder: 'Snippet text' });
        body.append(h('div', { class: 'dck-card' }, name, text,
          h('div', { class: 'dck-hint' }, 'Variables: ' + VARIABLE_NAMES.map((v) => '{{' + v + '}}').join(' ')),
          h('div', { class: 'dck-row' },
            h('button', {
              onclick: () => {
                const nm = cleanSnippetName(name.value);
                if (!nm) { toast('Give the snippet a name'); return; }
                s.name = nm; s.text = text.value; editingSnippetId = null; save(); render(drawer);
              }
            }, 'Save'),
            h('button', { onclick: () => { editingSnippetId = null; render(drawer); } }, 'Cancel'))));
        return;
      }
      body.append(h('div', { class: 'dck-card' },
        h('div', { class: 'name' }, '/' + s.name),
        h('div', { class: 'meta' }, s.text.replace(/\s+/g, ' ').slice(0, 90)),
        h('div', { class: 'dck-row' },
          h('button', { class: 'link', onclick: () => { editingSnippetId = s.id; render(drawer); } }, 'Edit'),
          h('button', { class: 'danger', onclick: () => { settings.snippets = settings.snippets.filter((x) => x.id !== s.id); save(); render(drawer); } }, 'Delete'))));
    });
    body.append(h('div', { class: 'dck-row' }, h('button', {
      onclick: () => {
        const s = { id: newId(), name: 'snippet' + (settings.snippets.length + 1), text: '' };
        settings.snippets.push(s); editingSnippetId = s.id; save(); render(drawer);
      }
    }, '+ Add snippet')));
  }

  function render(drawer) {
    const body = drawer.querySelector('.dck-body');
    body.textContent = '';

    body.append(
      toggleRow('Enabled', settings.enabled, (v) => { settings.enabled = v; save(); }),
      toggleRow('Insert context when I press Enter', settings.autoInsertOnEnter, (v) => { settings.autoInsertOnEnter = v; save(); }),
      toggleRow('Show inserted context', settings.showInjected !== false, (v) => {
        settings.showInjected = v; save();
        if (!v) scheduleStrip([document.body]);
      }, 'Off: context is attached and sent in one step, and hidden in the chat view'),
      toggleRow('Multi-system prompt mode', settings.multiPrompt, (v) => {
        settings.multiPrompt = v;
        if (v && settings.prompts.length === 0 && settings.systemPrompt.trim()) {
          settings.prompts.push({ id: newId(), name: 'Custom', text: settings.systemPrompt, enabled: true, schedule: settings.mode, everyN: settings.everyN });
        }
        editingId = null; save(); render(drawer);
      }, 'Several prompts at once, each with its own schedule')
    );

    renderDefault(drawer, body);
    renderPrompts(drawer, body);

    body.append(
      h('div', { class: 'dck-hint' }, settings.showInjected !== false
        ? 'The text is placed in your message box so you can read and edit it before sending. Nothing is sent automatically.'
        : 'Hidden mode: when context is due, pressing Enter attaches it and sends the message. It is hidden in the chat view here, but it is part of the message.'),
      h('h4', {}, 'Memory'),
      toggleRow('Use memory', settings.memoryEnabled, (v) => { settings.memoryEnabled = v; save(); })
    );

    const key = h('input', { placeholder: 'key (e.g. my name)' });
    const val = h('input', { placeholder: 'value' });
    const imp = h('select', {},
      h('option', { value: 'always' }, 'always'),
      h('option', { value: 'called' }, 'only when mentioned'));
    body.append(
      key, val,
      h('div', { class: 'dck-row' }, imp, h('button', {
        onclick: () => {
          if (!key.value.trim() || !val.value.trim()) return;
          memories.push({ key: key.value.trim(), value: val.value.trim(), importance: imp.value });
          save(); render(drawer);
        }
      }, 'Add'))
    );

    memories.forEach((m, i) => {
      body.append(h('div', { class: 'dck-card' },
        h('div', { class: 'name' }, m.key),
        h('div', {}, m.value),
        h('div', { class: 'dck-row' },
          h('span', { class: 'meta' }, m.importance === 'always' ? 'always included' : 'included when mentioned'),
          h('button', { class: 'danger', onclick: () => { memories.splice(i, 1); save(); render(drawer); } }, 'Delete'))));
    });

    renderSnippets(drawer, body);

    const importInput = h('input', { type: 'file', accept: 'application/json', style: 'display:none' });
    importInput.addEventListener('change', async () => {
      try {
        const data = JSON.parse(await importInput.files[0].text());
        if (data.settings) settings = normalizeSettings(data.settings);
        if (Array.isArray(data.memories)) memories = data.memories;
        save(); render(drawer); toast('Imported');
      } catch (err) { toast('Invalid file'); }
    });

    body.append(
      h('h4', {}, 'Backup'),
      h('div', { class: 'dck-row' },
        h('button', {
          onclick: () => {
            const blob = new Blob([JSON.stringify({ settings, memories }, null, 2)], { type: 'application/json' });
            const a = h('a', { href: URL.createObjectURL(blob), download: 'deepseek-kit.json' });
            a.click(); URL.revokeObjectURL(a.href);
          }
        }, 'Export'),
        h('button', { onclick: () => importInput.click() }, 'Import'),
        h('button', { onclick: () => { if (insertContext(true)) toast('Context inserted'); } }, 'Insert now')),
      importInput
    );
  }

  function mount() {
    if (document.getElementById('dck-fab')) return;
    const drawer = h('div', { id: 'dck-drawer' },
      h('header', {}, 'DeepSeek Kit', h('button', { onclick: () => drawer.classList.remove('open') }, '\u2715')),
      h('div', { class: 'dck-body' }));
    const fab = h('button', { id: 'dck-fab', onclick: () => { render(drawer); drawer.classList.toggle('open'); } }, 'Kit');
    document.body.append(fab, drawer);
    startObserver();
    if (settings.showInjected === false) scheduleStrip([document.body]);
  }

  load().then(mount);
})();
