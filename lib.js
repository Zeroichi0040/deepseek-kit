/* DeepSeek Kit - pure logic (no DOM, no browser APIs), shared by content.js and the Node tests. */
(function (root) {
  'use strict';

  // ---------- Pure logic (unit-testable) ----------
  const MARKER_START = '[Context from my notes]';
  const MARKER_END = '[End of context]';

  const BUILTIN_DEFAULT_PROMPT = [
    'You are using a DeepSeek Kit extension. Today is {{date}} ({{weekday}}), local time {{time}} {{timezone}}.',
    '',
    '## Answering',
    '- If instructions conflict, prioritize: honesty and safety > answering the actual question > brevity > formatting.',
    '- Lead with the answer. Yes/no questions open with yes or no; how-to questions with the method; analysis with the conclusion. Supporting detail follows only as far as it earns its place.',
    '- Calibrate length to the question, not the topic. A simple question gets one to three sentences; a complex one gets structure. Do not pad, and do not truncate substance.',
    '- If you are unsure, say so in one sentence, then give your best estimate, a confidence label (low/medium/high), and what would change it. Do not guess silently.',
    '- Make a reasonable assumption and state it. Ask at most one short clarifying question, and only when a wrong assumption would likely make the answer materially wrong or useless; otherwise proceed.',
    '- Work to completion. Deliver the finished result, not a plan for it, unless a plan was requested.',
    '- For opinion questions, give a clear view and brief reasoning; don\'t hide behind neutrality.',
    '- Before sending, check the output against the request: does it answer what was asked, at the requested depth, in the requested form?',
    '',
    '## Formatting',
    '- Plain prose is the default. Use lists for parallel items, tables for comparisons, headings for long structured answers.',
    '- Put code, commands, config, and file contents in fenced blocks with a language tag. Code should be complete and runnable as written unless a sketch was explicitly requested.',
    '- When a reply contains several files, make the first line of each file\'s block a comment with its path, e.g. // file: src/app.js, # file: main.py, <!-- file: index.html -->, /* file: style.css */. Skip this for JSON and other formats that cannot hold comments.',
    '- Reply in the language the user writes in. Keep identifiers and proper nouns in their original form.',
    '',
    '## Tone',
    '- Match the user\'s register. Be direct but not terse. No filler ("Certainly," "Great question," "I hope this helps"), no sycophancy, and no moralizing unless asked or genuinely necessary.',
    '- Own mistakes plainly: name the error, correct it, move on. Do not over-apologize.',
    '- If the user is wrong about a fact that matters, say so and explain why, briefly.',
    '',
    'DeepSeek Kit Github Repository: https://github.com/Zeroichi0040/deepseek-kit',
  ].join('\n');

  const VISUALS_PROMPT = [
    'When a chart or an interactive demo would explain something better than text, put it in a fenced code block whose language is chart or viz. The chat draws it automatically, so do not also describe the code.',
    '- chart: one JSON object: {"type":"bar|line|area|scatter|pie|donut","title":"...","subtitle":"one-line takeaway","labels":["Jan","Feb"],"series":[{"name":"Calls","values":[12,19]}],"xTitle":"","yTitle":"","unit":"","stacked":false}. For scatter, give series[].points as [[x,y],...] and no labels. Bars always start at zero, so use line or scatter for years and other values that sit far from zero. Use only numbers you were given or actually know; never invent data.',
    '- viz: one self-contained HTML snippet (HTML, CSS and JS together) for simulations, calculators and interactive diagrams. It runs in an isolated frame with no network: no external scripts, fonts, images or libraries. Ready-made classes: v-card, v-title, v-btn, v-btn-outline, v-row, v-control-group, v-label, v-stat; buttons, sliders, inputs and selects are already styled. Keep the background transparent so it reads on dark and light pages, never size anything with vh, and keep it simple.',
    '- Use ordinary markdown for anything else, and do not make a visual when plain text answers the question.',
  ].join('\n');

  const ASK_PROMPT = [
    'When you need the user to choose between options or answer a few short questions before you can go on, put them in a fenced code block whose language is ask. The chat turns it into a form the user can click, so do not also write the questions out.',
    'Use one JSON object: {"questions":[{"question":"What kind of app?","type":"single","options":[{"label":"Web","recommended":true},"Desktop","Mobile"]},{"question":"Which features?","type":"multi","options":[{"label":"Login","description":"email and password"},"Dashboard"]},{"question":"Anything else?","type":"text"}]}. type is single (pick one), multi (pick several) or text (a free answer). Choice questions get an Other field automatically; add "other":false to remove it. When one option is clearly the better choice, list it first and add "recommended":true to it; mark at most one per question, and only with a real reason. Ask only what you need (usually 1 to 4 questions), keep options short, and use plain text for ordinary questions that need no choices.',
  ].join('\n');

  const DEFAULTS = {
    enabled: true,
    showInjected: false, // false = attach context automatically and hide it in the chat
    autoInsertOnEnter: true,
    memoryEnabled: true,
    showSummary: true, // the "next message includes" strip in the drawer
    showChips: true, // the chip row in the message box toolbar
    prompts: [], // [{ id, name, text, enabled, schedule, everyN }]
    defaultEnabled: true, // built-in default prompt
    defaultText: '', // '' = use the built-in text
    defaultSchedule: 'first',
    defaultEveryN: 5,
    snippets: [], // [{ id, name, text }]
    memoryBudget: 0, // max tokens of memory per message, 0 = no limit
    codeTools: true, // header buttons (collapse, ZIP) on code blocks
    collapseThinking: false, // close DeepThink reasoning blocks, while thinking and once finished (also after a refresh)
    lineNumbers: true, // number the lines of code blocks (CSS counters, never part of copied text)
    mdPreview: true, // Preview button on markdown code blocks
    collapseLong: true, // collapse long code blocks automatically
    collapseLines: 20, // blocks longer than this many lines count as long
    visualsEnabled: true, // draw chart and viz code blocks as inline cards
    visualsPrompt: true, // built-in "Visuals" prompt that teaches the model the two formats
    visualsText: '', // '' = use the built-in text
    visualsSchedule: 'first',
    visualsEveryN: 5,
    askEnabled: true, // draw ask code blocks as clickable question forms
    askPrompt: true, // built-in "Questions" prompt that teaches the model the format
    askText: '', // '' = use the built-in text
    askSchedule: 'first',
    askEveryN: 5,
    listContinue: true, // Shift+Enter in a list in the message box continues it
    askAutoSend: true, // false = answers go into the message box for you to send; true = sent straight away
  };

  const VARIABLES = [
    { name: 'date', desc: 'Today, YYYY-MM-DD' },
    { name: 'time', desc: 'Local time, 24-hour' },
    { name: 'datetime', desc: 'Date and time' },
    { name: 'weekday', desc: 'e.g. Saturday' },
    { name: 'timezone', desc: 'e.g. Etc/UTC' },
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
  // Lists that came from storage or a hand-edited backup: keep only real objects and coerce the fields we read.
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  function cleanPrompts(list) {
    return (Array.isArray(list) ? list : []).filter(isObj).map((p) => ({
      ...p,
      id: p.id ? String(p.id) : newId(),
      name: String(p.name == null ? '' : p.name),
      text: String(p.text == null ? '' : p.text),
      enabled: p.enabled === undefined ? true : !!p.enabled,
      schedule: ['first', 'always', 'every'].indexOf(p.schedule) >= 0 ? p.schedule : 'first',
      everyN: Math.max(1, parseInt(p.everyN, 10) || 5),
    }));
  }
  function cleanSnippets(list) {
    return (Array.isArray(list) ? list : []).filter(isObj).map((x) => ({
      ...x,
      id: x.id ? String(x.id) : newId(),
      name: String(x.name == null ? '' : x.name),
      text: String(x.text == null ? '' : x.text),
    }));
  }
  function cleanMemories(list) {
    return (Array.isArray(list) ? list : []).filter(isObj).map((m) => ({
      ...m,
      key: String(m.key == null ? '' : m.key),
      value: String(m.value == null ? '' : m.value),
      importance: m.importance === 'always' ? 'always' : 'called',
      category: String(m.category == null ? '' : m.category),
      enabled: m.enabled !== false,
    }));
  }

  function migrateSettings(raw) {
    const s = { ...DEFAULTS, ...(isObj(raw) ? raw : {}) };
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
    delete s.starterSeeded; // starter content was removed
    delete s.chipsInline; // placement is automatic now: the toolbar
    s.prompts = cleanPrompts(s.prompts);
    s.snippets = cleanSnippets(s.snippets);
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

  // A note key matches a message when one of its words (3+ letters) appears in it, when a very short key
  // ("AI", "Go", "C#") appears as a whole word, or when a key with CJK characters appears as written.
  const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
  function keyMatches(key, text, msgTokens) {
    const k = String(key || '').trim().toLowerCase();
    if (!k) return false;
    for (const t of tokens(k)) if (msgTokens.has(t)) return true;
    if (CJK.test(k)) return text.indexOf(k) !== -1;
    if (k.length >= 2 && k.length <= 3) {
      const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('(^|[^a-z0-9])' + esc + '($|[^a-z0-9])').test(text);
    }
    return false;
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
    const text = String(userText || '').toLowerCase();
    const msg = tokens(text);
    const plan = list.map(() => 'idle');
    const cands = [];
    list.forEach((m, i) => {
      if (!m || !m.key || m.enabled === false) { plan[i] = 'off'; return; }
      let match = m.importance === 'always';
      if (!match) match = keyMatches(m.key, text, msg);
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

  function visualsPromptText(settings) {
    return (settings.visualsText || '').trim() ? settings.visualsText : VISUALS_PROMPT;
  }

  function askPromptText(settings) {
    return (settings.askText || '').trim() ? settings.askText : ASK_PROMPT;
  }

  // Every prompt that may take part: the built-in default and Visuals prompts, then your own list.
  function promptEntries(settings) {
    const list = [];
    if (settings.defaultEnabled !== false) {
      list.push({ id: 'default', name: 'Default', text: defaultPromptText(settings), enabled: true, schedule: settings.defaultSchedule || 'first', everyN: settings.defaultEveryN || 5 });
    }
    if (settings.visualsPrompt !== false && settings.visualsEnabled !== false) {
      list.push({ id: 'visuals', name: 'Visuals', text: visualsPromptText(settings), enabled: true, schedule: settings.visualsSchedule || 'first', everyN: settings.visualsEveryN || 5 });
    }
    if (settings.askPrompt !== false && settings.askEnabled !== false) {
      list.push({ id: 'ask', name: 'Questions', text: askPromptText(settings), enabled: true, schedule: settings.askSchedule || 'first', everyN: settings.askEveryN || 5 });
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
  // Shift+Enter in a list: carry the list on to the next line, or leave the list when the item is empty. Pure: takes the
  // box text and caret and returns null (let the key do its normal newline) or { from, to, insert }, meaning "replace
  // value[from..to] with insert". Only acts with a plain caret at the very end of a line, and never inside a code fence.
  function continueList(value, start, end) {
    value = String(value == null ? '' : value);
    if (start !== end || start < 0 || start > value.length) return null;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = value.indexOf('\n', start);
    if (lineEnd < 0) lineEnd = value.length;
    if (lineEnd !== start) return null;
    const fences = value.slice(0, lineStart).split('\n').filter((l) => /^\s*(```|~~~)/.test(l)).length;
    if (fences % 2 === 1) return null; // inside a code block the text is meant literally
    const line = value.slice(lineStart, lineEnd);
    const m = /^([ \t]*)(>|[-*+]|(\d{1,9})([.)]))([ \t]+)(.*)$/.exec(line);
    if (!m) return null;
    if (!m[6].trim()) return { from: lineStart, to: lineEnd, insert: '' }; // an empty item: the list ends here
    let marker = m[2];
    if (m[3] !== undefined) {
      const next = parseInt(m[3], 10) + 1;
      if (next > 999999999) return null;
      marker = next + m[4];
    }
    return { from: start, to: start, insert: '\n' + m[1] + marker + m[5] };
  }

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

  // Elapsed time for the reasoning timer: "23s", "1m 2s", "1h 5m". Never "0:23".
  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    if (total < 60) return total + 's';
    if (total < 3600) return Math.floor(total / 60) + 'm ' + (total % 60) + 's';
    return Math.floor(total / 3600) + 'h ' + Math.floor((total % 3600) / 60) + 'm';
  }

  const core = {
    formatElapsed, DEFAULTS, BUILTIN_DEFAULT_PROMPT, VISUALS_PROMPT, ASK_PROMPT, askPromptText, cleanPrompts, cleanSnippets, cleanMemories, keyMatches, visualsPromptText, VARIABLES, VARIABLE_NAMES, migrateSettings, hasLegacyKeys, tokens, selectMemories,
    scheduleDue, applyVariables, promptEntries, shouldInject, activePrompts, buildPrefix, estimateTokens, summarize,
    describeSummary, memoryLabel, alreadyHasContext, stripContext, slashQuery, continueList, cleanSnippetName, filterSnippets,
    searchSnippets, describeSchedule, insertAt, defaultPromptText, newId,
    LANG_EXT, normalizeLang, langFromClass, extFor, sniffLang, previewKind, detectBlock, suggestFilename, uniqueName, crc32, makeZip,
    MEMORY_GENERAL, memoryLine, memoryCategory, memoryPlan, memoryStatuses, memoryTokens, groupMemories, cleanCategory, isExistingChatPath, resolveCount, pruneCounts, MARKER_START, MARKER_END,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  else root.DCK_LIB = core;
})(typeof globalThis !== 'undefined' ? globalThis : this);
