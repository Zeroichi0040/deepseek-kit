/* DeepSeek Kit - pure logic (no DOM, no browser APIs), shared by content.js and the Node tests. */
(function (root) {
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
    memoryBudget: 0, // max tokens of memory per message, 0 = no limit
    codeTools: true, // hover bar (preview / download) on code blocks
    previewExternal: false, // let previews load web assets (CDN scripts, styles, images)
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

  const MEMORY_GENERAL = 'General';
  const MEMORY_HEADER = 'Things to remember about me:\n';

  function memoryLine(m) {
    return '- ' + m.key + ': ' + m.value;
  }

  function memoryCategory(m) {
    const c = String((m && m.category) || '').trim();
    return c || MEMORY_GENERAL;
  }

  // Decides, for every note, whether it goes into the next message and why not otherwise.
  // status: 'off' (switched off), 'idle' ("when mentioned" and it was not), 'budget' (would not fit), 'included'.
  // "Always" notes are considered before "when mentioned" ones, each in list order; a note that does not fit the
  // token budget is skipped and smaller ones after it may still fit.
  function memoryPlan(memories, userText, budget) {
    const list = memories || [];
    const msg = tokens(userText);
    const plan = list.map(() => 'idle');
    const cands = [];
    list.forEach((m, i) => {
      if (!m || !m.key || m.enabled === false) { plan[i] = 'off'; return; }
      let match = m.importance === 'always';
      if (!match) {
        for (const t of tokens(m.key)) if (msg.has(t)) { match = true; break; }
      }
      if (match) cands.push(i);
    });
    cands.sort((a, b) => (list[a].importance === 'always' ? 0 : 1) - (list[b].importance === 'always' ? 0 : 1) || a - b);
    const limit = Number(budget) > 0 ? Number(budget) : Infinity;
    const header = estimateTokens(MEMORY_HEADER);
    let used = 0;
    let any = false;
    cands.forEach((i) => {
      const total = used + estimateTokens(memoryLine(list[i]) + '\n') + (any ? 0 : header);
      if (total <= limit) { plan[i] = 'included'; used = total; any = true; } else plan[i] = 'budget';
    });
    return { status: plan, tokens: used };
  }

  // The notes that go into the next message, in list order.
  function selectMemories(memories, userText, budget) {
    const plan = memoryPlan(memories, userText, budget).status;
    return (memories || []).filter((m, i) => plan[i] === 'included');
  }

  // Per-note status for the Memory tab. When memory as a whole is switched off every note shows 'paused'.
  function memoryStatuses(settings, memories, userText) {
    const plan = memoryPlan(memories, userText, settings.memoryBudget).status;
    return settings.memoryEnabled ? plan : plan.map((st) => (st === 'off' ? 'off' : 'paused'));
  }

  function memoryTokens(settings, memories, userText) {
    return settings.memoryEnabled ? memoryPlan(memories, userText, settings.memoryBudget).tokens : 0;
  }

  // Groups notes by category: General first, then alphabetical. Items keep their index in the full list.
  function groupMemories(memories) {
    const map = new Map();
    (memories || []).forEach((m, index) => {
      if (!m) return;
      const c = memoryCategory(m);
      if (!map.has(c)) map.set(c, []);
      map.get(c).push({ m: m, index: index });
    });
    const names = Array.from(map.keys()).sort((a, b) => (a === MEMORY_GENERAL ? -1 : b === MEMORY_GENERAL ? 1 : a.toLowerCase().localeCompare(b.toLowerCase())));
    return names.map((n) => ({ category: n, items: map.get(n) }));
  }

  // Reuses the spelling of an existing category when the new one matches ignoring case ("work" -> "Work").
  function cleanCategory(input, memories) {
    const c = String(input || '').trim().replace(/\s+/g, ' ');
    if (!c || c.toLowerCase() === MEMORY_GENERAL.toLowerCase()) return '';
    const hit = (memories || []).map((m) => String((m && m.category) || '').trim()).find((x) => x && x.toLowerCase() === c.toLowerCase());
    return hit || c;
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
      const sel = selectMemories(memories, userText, settings.memoryBudget);
      if (sel.length) {
        parts.push(MEMORY_HEADER + sel.map(memoryLine).join('\n'));
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
    const none = { names: [], memories: 0, skipped: 0, tokens: 0 };
    if (!settings.enabled) return Object.assign({ state: 'off' }, none);
    if (!shouldInject(settings, sentCount)) return Object.assign({ state: 'idle' }, none);
    const names = activePrompts(settings, sentCount, false).map((p) => p.name);
    let included = 0;
    let skipped = 0;
    if (settings.memoryEnabled) {
      memoryPlan(memories, userText, settings.memoryBudget).status.forEach((st) => {
        if (st === 'included') included++;
        else if (st === 'budget') skipped++;
      });
    }
    const prefix = buildPrefix(settings, memories, userText, sentCount, false, {});
    return { state: 'ready', names: names, memories: included, skipped: skipped, tokens: estimateTokens(prefix) };
  }

  function memoryLabel(n) {
    return n + (n === 1 ? ' memory' : ' memories');
  }

  function describeSummary(sum) {
    if (sum.state === 'off') return 'Kit is off';
    if (sum.state === 'idle') return 'Nothing is due for the next message';
    let t = sum.names.join(', ');
    if (sum.memories) t += (t ? ' + ' : '') + memoryLabel(sum.memories);
    if (sum.skipped) t += ' (' + sum.skipped + ' over budget)';
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

  // ---------- Code blocks: language detection, file names, ZIP ----------
  const LANG_EXT = {
    javascript: 'js', typescript: 'ts', python: 'py', bash: 'sh', html: 'html', css: 'css', scss: 'scss', json: 'json',
    markdown: 'md', yaml: 'yaml', xml: 'xml', svg: 'svg', mermaid: 'mmd', sql: 'sql', java: 'java', c: 'c', cpp: 'cpp',
    csharp: 'cs', go: 'go', rust: 'rs', php: 'php', ruby: 'rb', swift: 'swift', kotlin: 'kt', powershell: 'ps1',
    toml: 'toml', ini: 'ini', csv: 'csv', text: 'txt', diff: 'diff', lua: 'lua', r: 'r', dart: 'dart', perl: 'pl',
    scala: 'scala', haskell: 'hs', vue: 'vue', latex: 'tex', batch: 'bat',
  };
  const LANG_ALIASES = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', node: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', python3: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', htm: 'html', xhtml: 'html',
    md: 'markdown', yml: 'yaml', 'c++': 'cpp', 'c#': 'csharp', cs: 'csharp', rs: 'rust', rb: 'ruby', golang: 'go',
    ps1: 'powershell', kt: 'kotlin', txt: 'text', plaintext: 'text', plain: 'text', tex: 'latex', bat: 'batch', cmd: 'batch',
  };
  const MERMAID_START = /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|sankey-beta|xychart-beta)\b/;

  function normalizeLang(s) {
    const t = String(s || '').trim().toLowerCase().replace(/^(language|lang)-/, '');
    return LANG_ALIASES[t] || t;
  }

  // "language-html" -> "html"
  function langFromClass(className) {
    const m = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/i.exec(String(className || ''));
    return m ? normalizeLang(m[1]) : '';
  }

  function extFor(lang) {
    return LANG_EXT[lang] || 'txt';
  }

  // Looks at the content itself when no (useful) language label is available.
  function sniffLang(text) {
    const t = String(text || '').replace(/^\uFEFF/, '');
    const head = t.replace(/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)?/, '');
    if (/^<svg[\s>]/i.test(head)) return 'svg';
    if (/^\s*(<!doctype html|<html[\s>])/i.test(t)) return 'html';
    const first = t.split(/\r?\n/).map((l) => l.trim()).find((l) => l && l.indexOf('%%') !== 0) || '';
    if (MERMAID_START.test(first)) return 'mermaid';
    if (/^\s*[{[]/.test(t)) { try { JSON.parse(t); return 'json'; } catch (e) { /* not json */ } }
    return '';
  }

  function previewKind(lang) {
    return lang === 'html' || lang === 'svg' || lang === 'mermaid' || lang === 'markdown' ? lang : null;
  }

  // hints: label candidates in priority order (class name, header text, ...). The first one that is a known
  // language wins; with no usable label (or a generic one) the content is inspected instead.
  function detectBlock(hints, text) {
    let lang = '';
    for (const hint of hints || []) {
      const n = normalizeLang(hint);
      if (n && Object.prototype.hasOwnProperty.call(LANG_EXT, n)) { lang = n; break; }
    }
    if (!lang || lang === 'text' || lang === 'xml') lang = sniffLang(text) || lang;
    if (!lang) lang = 'text';
    return { lang: lang, kind: previewKind(lang), ext: extFor(lang) };
  }

  // "dir/name.ext" (a leading ./ or ../ is allowed and cleaned later) or a dotfile such as ".gitignore".
  const FILE_RE = /^(?:[\w.][\w\-. /]*\.[A-Za-z][A-Za-z0-9]{0,7}|\.[A-Za-z][\w-]*)$/;

  function cleanPath(p) {
    return String(p || '').trim().replace(/\\/g, '/').replace(/^[a-z]:/i, '').split('/').filter((x) => x && x !== '.' && x !== '..').join('/');
  }

  // Uses a file name from a comment in the first lines ("// file: app.js", "# main.py", "<!-- index.html -->"),
  // otherwise snippet-N.ext.
  function suggestFilename(lang, text, index) {
    const lines = String(text || '').split(/\r?\n/).slice(0, 3);
    for (const line of lines) {
      const m = /^(?:\/\/|#|--|;|<!--|\/\*|\*)\s*(?:file(?:name)?|path)?\s*:?\s*([^\s*]+?)\s*(?:-->|\*\/)?$/i.exec(line.trim());
      if (m && FILE_RE.test(m[1])) {
        const name = cleanPath(m[1]);
        if (name) return name;
      }
    }
    return 'snippet-' + (index || 1) + '.' + extFor(lang);
  }

  // Adds -2, -3 ... before the extension when a name is already taken. `used` is a Set that gets updated.
  function uniqueName(name, used) {
    if (!used.has(name)) { used.add(name); return name; }
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let n = 2;
    while (used.has(stem + '-' + n + ext)) n++;
    const out = stem + '-' + n + ext;
    used.add(out);
    return out;
  }

  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // Minimal ZIP writer (no compression). files: [{ name, data }] where data is a string or Uint8Array.
  function makeZip(files, date) {
    const enc = new TextEncoder();
    const d = date || new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const parts = [];
    const central = [];
    let offset = 0;
    files.forEach((f) => {
      const name = enc.encode(f.name);
      const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // names are UTF-8
      local.setUint16(8, 0, true); // stored
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), name, data);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, dosTime, true);
      cd.setUint16(14, dosDate, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, name.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), name);
      offset += 30 + name.length + data.length;
    });
    const cdSize = central.reduce((n, a) => n + a.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    const out = new Uint8Array(all.reduce((n, a) => n + a.length, 0));
    let pos = 0;
    all.forEach((a) => { out.set(a, pos); pos += a.length; });
    return out;
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
    searchSnippets, describeSchedule, insertAt, defaultPromptText, newId,
    LANG_EXT, normalizeLang, langFromClass, extFor, sniffLang, previewKind, detectBlock, suggestFilename, uniqueName, crc32, makeZip,
    MEMORY_GENERAL, memoryLine, memoryCategory, memoryPlan, memoryStatuses, memoryTokens, groupMemories, cleanCategory, isExistingChatPath, resolveCount, pruneCounts, MARKER_START, MARKER_END,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  else root.DCK_LIB = core;
})(typeof globalThis !== 'undefined' ? globalThis : this);
