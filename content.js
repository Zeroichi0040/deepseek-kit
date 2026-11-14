/* DeepSeek Kit - local-only, no network, no request patching.
 * It only edits the text in your message box, in plain view, when you ask it to. */
(function () {
  'use strict';

  // ---------- Pure logic (unit-testable) ----------
  const MARKER_START = '[Context from my notes]';
  const MARKER_END = '[End of context]';

  const DEFAULTS = {
    enabled: true,
    systemPrompt: '',
    mode: 'first', // single-prompt schedule: 'first' | 'every' | 'always'
    everyN: 5,
    memoryEnabled: true,
    autoInsertOnEnter: true,
    multiPrompt: false,
    prompts: [], // [{ id, name, text, enabled, schedule, everyN }]
  };

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

  function shouldInject(settings, sentCount) {
    if (!settings.enabled) return false;
    if (settings.multiPrompt) {
      return (settings.prompts || []).some((p) => p && p.enabled && scheduleDue(p.schedule, p.everyN, sentCount));
    }
    return scheduleDue(settings.mode, settings.everyN, sentCount);
  }

  // Prompts that should go out with this message. `force` ignores schedules (the "Insert now" button).
  function activePrompts(settings, sentCount, force) {
    if (settings.multiPrompt) {
      return (settings.prompts || [])
        .filter((p) => p && p.enabled && (p.text || '').trim() && (force || scheduleDue(p.schedule, p.everyN, sentCount)))
        .map((p) => ({ name: (p.name || '').trim(), text: p.text.trim() }));
    }
    const t = (settings.systemPrompt || '').trim();
    if (!t) return [];
    if (!force && !scheduleDue(settings.mode, settings.everyN, sentCount)) return [];
    return [{ name: '', text: t }];
  }

  function buildPrefix(settings, memories, userText, sentCount, force) {
    const parts = activePrompts(settings, sentCount || 0, !!force).map((p) =>
      (p.name ? `Instructions (${p.name}):` : 'Instructions:') + '\n' + p.text
    );
    if (settings.memoryEnabled) {
      const sel = selectMemories(memories, userText);
      if (sel.length) {
        parts.push('Things to remember about me:\n' + sel.map((m) => `- ${m.key}: ${m.value}`).join('\n'));
      }
    }
    if (!parts.length) return '';
    return `${MARKER_START}\n${parts.join('\n\n')}\n${MARKER_END}\n\n`;
  }

  function alreadyHasContext(text) {
    return String(text || '').trimStart().startsWith(MARKER_START);
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function describeSchedule(p) {
    if (p.schedule === 'always') return 'Always (every message)';
    if (p.schedule === 'every') return `Every ${Math.max(1, parseInt(p.everyN, 10) || 1)} messages`;
    return 'Only on first message';
  }

  const core = { DEFAULTS, tokens, selectMemories, scheduleDue, shouldInject, activePrompts, buildPrefix, alreadyHasContext, describeSchedule, MARKER_START, MARKER_END };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = core;
    return;
  }

  // ---------- Extension runtime ----------
  const store = chrome.storage.local;
  let settings = { ...DEFAULTS };
  let memories = [];
  let editingId = null;
  const sentCounts = {}; // per chat path
  let lastPath = location.pathname;

  function load() {
    return new Promise((resolve) => {
      store.get(['dck_settings', 'dck_memories'], (r) => {
        settings = { ...DEFAULTS, ...(r.dck_settings || {}) };
        if (!Array.isArray(settings.prompts)) settings.prompts = [];
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
    const prefix = buildPrefix(settings, memories, text, count, force);
    if (!prefix) { if (force) toast('Nothing to insert \u2014 add a system prompt or memory first'); return false; }
    setNativeValue(el, prefix + text);
    return true;
  }

  // First Enter inserts the context (visible in the box). You press Enter again to send. Nothing is sent for you.
  document.addEventListener(
    'keydown',
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLTextAreaElement)) return;
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      if (!settings.enabled || !settings.autoInsertOnEnter) return;
      if (!el.value.trim()) return;
      const p = location.pathname;
      if (alreadyHasContext(el.value)) {
        sentCounts[p] = (sentCounts[p] || 0) + 1; // this Enter sends
        return;
      }
      const count = sentCounts[p] || 0;
      if (!shouldInject(settings, count)) {
        sentCounts[p] = count + 1;
        return;
      }
      if (insertContext(false)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        toast('Context added \u2014 review it, then press Enter to send');
      } else {
        sentCounts[p] = count + 1;
      }
    },
    true
  );

  // ---------- UI ----------
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n[k] = v;
    }
    for (const c of kids.flat()) n.append(c && c.nodeType ? c : document.createTextNode(c ?? ''));
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

  function promptEditor(drawer, p) {
    const name = h('input', { value: p.name, placeholder: 'Name' });
    const text = h('textarea', { value: p.text, placeholder: 'Prompt text' });
    let sched = p.schedule || 'first';
    const everyN = h('input', { type: 'number', min: 1, value: p.everyN || 5, style: sched === 'every' ? '' : 'display:none' });
    const sel = scheduleSelect(sched, (v) => { sched = v; everyN.style.display = v === 'every' ? '' : 'none'; });
    return h('div', { class: 'dck-card' },
      name, text, sel, everyN,
      h('div', { class: 'dck-row' },
        h('button', {
          onclick: () => {
            p.name = name.value.trim() || 'Untitled';
            p.text = text.value;
            p.schedule = sched;
            p.everyN = Math.max(1, parseInt(everyN.value, 10) || 5);
            editingId = null; save(); render(drawer);
          }
        }, 'Save'),
        h('button', { onclick: () => { editingId = null; render(drawer); } }, 'Cancel')));
  }

  function renderPrompts(drawer, body) {
    if (!settings.multiPrompt) {
      const prompt = h('textarea', { value: settings.systemPrompt, placeholder: 'e.g. Answer concisely. I am a Python developer.' });
      prompt.addEventListener('change', () => { settings.systemPrompt = prompt.value; save(); });
      const everyN = h('input', { type: 'number', min: 1, value: settings.everyN, onchange: (e) => { settings.everyN = parseInt(e.target.value, 10) || 1; save(); } });
      body.append(
        h('h4', {}, 'System prompt'),
        prompt,
        h('h4', {}, 'When to insert'),
        scheduleSelect(settings.mode, (v) => { settings.mode = v; save(); render(drawer); }),
        settings.mode === 'every' ? h('div', { class: 'dck-row' }, 'N =', everyN) : ''
      );
      return;
    }

    body.append(h('h4', {}, 'System prompts'));
    settings.prompts.forEach((p) => {
      if (editingId === p.id) { body.append(promptEditor(drawer, p)); return; }
      body.append(h('div', { class: 'dck-card' },
        h('div', { class: 'dck-toggle' },
          h('span', { class: 't' }, h('span', { class: 'name' }, p.name || 'Untitled'), h('span', { class: 'sub' }, describeSchedule(p))),
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

  function render(drawer) {
    const body = drawer.querySelector('.dck-body');
    body.textContent = '';

    body.append(
      toggleRow('Enabled', settings.enabled, (v) => { settings.enabled = v; save(); }),
      toggleRow('Insert context when I press Enter', settings.autoInsertOnEnter, (v) => { settings.autoInsertOnEnter = v; save(); }),
      toggleRow('Multi-system prompt mode', settings.multiPrompt, (v) => {
        settings.multiPrompt = v;
        if (v && settings.prompts.length === 0 && settings.systemPrompt.trim()) {
          settings.prompts.push({ id: newId(), name: 'Default', text: settings.systemPrompt, enabled: true, schedule: settings.mode, everyN: settings.everyN });
        }
        editingId = null; save(); render(drawer);
      }, 'Several prompts at once, each with its own schedule')
    );

    renderPrompts(drawer, body);

    body.append(
      h('div', { class: 'dck-hint' }, 'The text is placed in your message box so you can read and edit it before sending. Nothing is sent automatically.'),
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

    const importInput = h('input', { type: 'file', accept: 'application/json', style: 'display:none' });
    importInput.addEventListener('change', async () => {
      try {
        const data = JSON.parse(await importInput.files[0].text());
        if (data.settings) settings = { ...DEFAULTS, ...data.settings };
        if (!Array.isArray(settings.prompts)) settings.prompts = [];
        if (Array.isArray(data.memories)) memories = data.memories;
        save(); render(drawer); toast('Imported');
      } catch { toast('Invalid file'); }
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
  }

  load().then(mount);
})();
