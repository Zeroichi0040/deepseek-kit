/* DeepSeek Kit - interactive questions drawn from ```ask code blocks.
 * parseAskSpec() checks the model's JSON, buildAsk() makes a form out of it (plain DOM, no HTML parsing), and
 * compileAnswers() turns the chosen answers into the text that goes into the message box. Pure: no storage, no
 * network, nothing sent from here; content.js decides what to do with the compiled text. */
(function () {
  'use strict';

  const MAX_CHARS = 64 * 1024;
  const MAX_QUESTIONS = 10;
  const MAX_OPTIONS = 12;
  const MAX_LABEL = 200;
  const MAX_QUESTION = 400;
  const MAX_DESC = 300;

  const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

  // Model output often has a fence around the JSON, trailing commas or a sentence before it.
  function looseJson(text) {
    let t = String(text || '').trim();
    t = t.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
    const attempt = (s) => { try { return { v: JSON.parse(s) }; } catch (e) { return null; } };
    const tidy = (s) => s.replace(/,\s*([}\]])/g, '$1');
    let r = attempt(t) || attempt(tidy(t));
    if (r) return r.v;
    const a = Math.min(...['{', '['].map((c) => { const i = t.indexOf(c); return i < 0 ? Infinity : i; }));
    const b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (a !== Infinity && b > a) {
      const s = t.slice(a, b + 1);
      r = attempt(s) || attempt(tidy(s));
      if (r) return r.v;
    }
    return undefined;
  }

  function parseOption(o) {
    if (o == null) return null;
    if (typeof o === 'string' || typeof o === 'number') { const label = clip(o, MAX_LABEL); return label ? { label } : null; }
    if (typeof o === 'object') {
      const label = clip(o.label != null ? o.label : (o.text != null ? o.text : o.value), MAX_LABEL);
      if (!label) return null;
      const description = clip(o.description != null ? o.description : o.hint, MAX_DESC);
      return description ? { label, description } : { label };
    }
    return null;
  }

  function parseQuestion(q, index) {
    if (typeof q === 'string') q = { question: q, type: 'text' };
    if (!q || typeof q !== 'object') return { error: 'Question ' + (index + 1) + ' is not an object.' };
    const text = clip(q.question != null ? q.question : (q.text != null ? q.text : (q.prompt != null ? q.prompt : q.title)), MAX_QUESTION);
    if (!text) return { error: 'Question ' + (index + 1) + ' has no text.' };
    const rawOptions = Array.isArray(q.options) ? q.options : (Array.isArray(q.choices) ? q.choices : (Array.isArray(q.answers) ? q.answers : []));
    const options = rawOptions.map(parseOption).filter(Boolean).slice(0, MAX_OPTIONS);
    const t = String(q.type || '').toLowerCase();
    let type = 'single';
    if (t === 'text' || t === 'open' || t === 'free' || t === 'input') type = 'text';
    else if (t === 'multi' || t === 'multiple' || t === 'checkbox' || t === 'checkboxes' || q.multiple === true || q.multi === true) type = 'multi';
    if (!options.length) type = 'text';
    // "other" is on unless the model turns it off; a string sets its label
    let other = q.other !== false && q.allowOther !== false && q.allow_other !== false;
    let otherLabel = typeof q.other === 'string' ? clip(q.other, 60) : 'Other';
    if (type === 'text') other = false;
    return { id: 'q' + (index + 1), text, type, options, other, otherLabel: otherLabel || 'Other', placeholder: clip(q.placeholder, 80) };
  }

  function parseAskSpec(text) {
    const raw = String(text || '');
    if (raw.length > MAX_CHARS) return { ok: false, error: 'The question block is too large.' };
    const data = looseJson(raw);
    if (data === undefined || data === null || typeof data !== 'object') return { ok: false, error: 'The question block is not valid JSON.' };
    let list;
    let title = '';
    if (Array.isArray(data)) list = data;
    else if (Array.isArray(data.questions)) { list = data.questions; title = clip(data.title, MAX_QUESTION); }
    else list = [data];
    if (!list.length) return { ok: false, error: 'There are no questions in it.' };
    if (list.length > MAX_QUESTIONS) list = list.slice(0, MAX_QUESTIONS);
    const questions = [];
    for (let i = 0; i < list.length; i++) {
      const q = parseQuestion(list[i], i);
      if (q.error) return { ok: false, error: q.error };
      questions.push(q);
    }
    return { ok: true, spec: { title, questions } };
  }

  // answers: [{ picked: [labels], other: '', text: '' }] in question order. Returns the text for the message box.
  function answerValue(q, a) {
    a = a || {};
    const picked = (a.picked || []).slice();
    const other = clip(a.other, 500);
    const free = String(a.text == null ? '' : a.text).trim().slice(0, 2000);
    if (q.type === 'text') return free;
    if (q.type === 'single') return other && a.useOther ? other : (picked[0] || '');
    const all = picked.slice();
    if (other && a.useOther) all.push(other);
    return all.join(', ');
  }
  // One question: the bare pair. Several: every question is written out beside its answer with Q1/A1 labels, so the
  // model can tell what it asked from what was answered; a skipped question stays listed.
  function compileAnswers(spec, answers) {
    const parts = spec.questions.map((q, i) => ({ q, value: answerValue(q, answers && answers[i]) }));
    if (!parts.some((p) => p.value)) return '';
    if (parts.length === 1) return parts[0].q.text + '\n' + parts[0].value;
    const lines = ['Here are my answers to your questions.'];
    parts.forEach((p, i) => {
      lines.push('', 'Q' + (i + 1) + ': ' + p.q.text, 'A' + (i + 1) + ': ' + (p.value || '(skipped)'));
    });
    return lines.join('\n');
  }

  // ---------- the form ----------
  // opts: { onSubmit(text), submitLabel: string }. Returns { el, answers(), text(), reset(), lock(bool), onChange(fn) }.
  function buildAsk(doc, spec, opts) {
    opts = opts || {};
    const el = (tag, cls, txt) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
    const root = el('form', 'dck-ask');
    root.setAttribute('novalidate', '');
    if (spec.title) root.appendChild(el('div', 'dck-ask-title', spec.title));
    const uid = 'ask' + Math.random().toString(36).slice(2, 8);
    const state = spec.questions.map(() => ({ picked: [], other: '', useOther: false, text: '' }));
    const rows = [];
    let locked = false;
    let changeFn = null;

    const submit = el('button', 'dck-ask-submit', opts.submitLabel || 'Add to message');
    submit.type = 'submit';
    const clear = el('button', 'dck-ask-clear', 'Clear');
    clear.type = 'button';
    const note = el('div', 'dck-ask-note');
    // With several questions only one shows at a time: Back and Next step through them, the dots jump.
    const total = spec.questions.length;
    const paged = total > 1;
    let cur = 0;
    const back = el('button', 'dck-ask-nav', 'Back');
    const next = el('button', 'dck-ask-nav', 'Next');
    const progress = el('span', 'dck-ask-progress');
    progress.setAttribute('aria-live', 'polite');
    const dots = [];
    back.type = next.type = 'button';

    function showStep(n) {
      cur = Math.max(0, Math.min(total - 1, n));
      if (!paged) return;
      rows.forEach((r, i) => { r.hidden = i !== cur; });
      back.disabled = cur === 0;
      next.hidden = cur === total - 1;
      submit.hidden = cur !== total - 1;
      progress.textContent = 'Question ' + (cur + 1) + ' of ' + total;
      dots.forEach((d, i) => {
        d.classList.toggle('cur', i === cur);
        d.classList.toggle('done', !!answerValue(spec.questions[i], state[i]));
        if (i === cur) d.setAttribute('aria-current', 'step'); else d.removeAttribute('aria-current');
      });
    }

    function refresh() {
      const text = compileAnswers(spec, state);
      submit.disabled = locked || !text;
      clear.disabled = locked;
      rows.forEach((r) => r.querySelectorAll('input, textarea').forEach((i) => { i.disabled = locked; }));
      showStep(cur);
      if (changeFn) changeFn(text);
    }

    spec.questions.forEach((q, qi) => {
      const box = el('fieldset', 'dck-ask-q');
      const legend = el('legend', 'dck-ask-qtext', (spec.questions.length > 1 ? (qi + 1) + '. ' : '') + q.text);
      box.appendChild(legend);
      const st = state[qi];
      const name = uid + '-' + qi;
      rows.push(box);

      if (q.type === 'text') {
        const ta = el('textarea', 'dck-ask-text');
        ta.rows = 2;
        ta.placeholder = q.placeholder || 'Type your answer';
        ta.setAttribute('aria-label', q.text);
        ta.addEventListener('input', () => { st.text = ta.value; refresh(); });
        box.appendChild(ta);
        root.appendChild(box);
        return;
      }

      const kind = q.type === 'multi' ? 'checkbox' : 'radio';
      const optRows = [];
      q.options.forEach((o) => {
        const lab = el('label', 'dck-ask-opt');
        const inp = el('input');
        inp.type = kind;
        inp.name = name;
        inp.value = o.label;
        const body = el('span', 'dck-ask-optbody');
        body.appendChild(el('span', 'dck-ask-optlabel', o.label));
        if (o.description) body.appendChild(el('span', 'dck-ask-optdesc', o.description));
        inp.addEventListener('change', () => {
          if (kind === 'radio') { st.picked = inp.checked ? [o.label] : []; st.useOther = false; }
          else if (inp.checked) { if (st.picked.indexOf(o.label) < 0) st.picked.push(o.label); } else st.picked = st.picked.filter((x) => x !== o.label);
          if (kind === 'radio') optRows.forEach((r) => { if (r.other) r.other.classList.remove('on'); });
          refresh();
        });
        lab.append(inp, body);
        box.appendChild(lab);
        optRows.push({ inp });
      });

      if (q.other) {
        const lab = el('label', 'dck-ask-opt dck-ask-other');
        const inp = el('input');
        inp.type = kind;
        inp.name = name;
        inp.value = '__other__';
        const txt = el('input', 'dck-ask-othertext');
        txt.type = 'text';
        txt.placeholder = q.otherLabel + '...';
        txt.setAttribute('aria-label', q.otherLabel + ' answer for: ' + q.text);
        const syncOther = () => { st.useOther = inp.checked; st.other = txt.value; refresh(); };
        inp.addEventListener('change', () => {
          if (kind === 'radio' && inp.checked) st.picked = [];
          syncOther();
          if (inp.checked) txt.focus();
        });
        txt.addEventListener('input', () => {
          if (txt.value && !inp.checked) { inp.checked = true; if (kind === 'radio') st.picked = []; }
          if (!txt.value && inp.checked && kind === 'radio') { /* stays selected, counts as unanswered until typed */ }
          syncOther();
        });
        txt.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); e.stopPropagation(); });
        const body = el('span', 'dck-ask-optbody');
        body.appendChild(txt);
        lab.append(inp, body);
        box.appendChild(lab);
        optRows.forEach((r) => { r.other = lab; });
      }
      root.appendChild(box);
    });

    if (paged) {
      const nav = el('div', 'dck-ask-pager');
      const dotbox = el('span', 'dck-ask-dots');
      spec.questions.forEach((q, i) => {
        const d = el('button', 'dck-ask-dot');
        d.type = 'button';
        d.setAttribute('aria-label', 'Go to question ' + (i + 1));
        d.addEventListener('click', () => showStep(i));
        dots.push(d);
        dotbox.appendChild(d);
      });
      back.addEventListener('click', () => showStep(cur - 1));
      next.addEventListener('click', () => showStep(cur + 1));
      nav.append(back, el('span', 'dck-ask-mid'), next);
      nav.querySelector('.dck-ask-mid').append(progress, dotbox);
      root.appendChild(nav);
    }
    const foot = el('div', 'dck-ask-foot');
    foot.append(submit, clear, note);
    root.appendChild(foot);

    root.addEventListener('submit', (e) => {
      e.preventDefault();
      if (locked) return;
      const text = compileAnswers(spec, state);
      if (!text) return;
      if (opts.onSubmit) opts.onSubmit(text);
    });
    root.addEventListener('keydown', (e) => e.stopPropagation()); // typing here never reaches the site's shortcuts
    clear.addEventListener('click', () => api.reset());

    const api = {
      el: root,
      answers: () => JSON.parse(JSON.stringify(state)),
      text: () => compileAnswers(spec, state),
      reset() {
        state.forEach((s) => { s.picked = []; s.other = ''; s.useOther = false; s.text = ''; });
        root.querySelectorAll('input[type=radio], input[type=checkbox]').forEach((i) => { i.checked = false; });
        root.querySelectorAll('input[type=text], textarea').forEach((i) => { i.value = ''; });
        note.textContent = '';
        cur = 0;
        refresh();
      },
      step: () => cur,
      lock(v) { locked = !!v; root.classList.toggle('locked', locked); refresh(); },
      note(t) { note.textContent = t || ''; },
      setSubmitLabel(t) { submit.textContent = t; },
      onChange(fn) { changeFn = fn; },
    };
    refresh();
    return api;
  }

  const api = { parseAskSpec, compileAnswers, buildAsk, MAX_QUESTIONS, MAX_OPTIONS };
  if (typeof globalThis !== 'undefined') globalThis.DCK_ASK = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
