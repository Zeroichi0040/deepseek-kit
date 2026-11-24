/* DeepSeek Kit - interactive questions drawn from ```ask code blocks.
 * parseAskSpec() checks the model's JSON, buildAsk() makes a form out of it (plain DOM, no HTML parsing), and
 * compileAnswers() turns the chosen answers into the text that goes into the message box. Pure: no storage, no
 * network, nothing sent from here; content.js decides what to do with the compiled text. */
(function () {
  'use strict';

  const MAX_CHARS = 256 * 1024;
  // Bound the DOM cost of a single mounted page (each option creates several nodes).
  const MAX_PAGE_OPTIONS = 1000;
  const clean = (v) => typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';

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
    if (typeof o === 'string' || typeof o === 'number') { const label = clean(o); return label ? { label } : null; }
    if (typeof o === 'object') {
      const label = clean(o.label != null ? o.label : (o.text != null ? o.text : o.value));
      if (!label) return null;
      const description = clean(o.description != null ? o.description : o.hint);
      const out = { label };
      if (description) out.description = description;
      if (o.recommended === true || o.recommended === 'true') out.recommended = true;
      return out;
    }
    return null;
  }

  function parseQuestion(q, index) {
    if (typeof q === 'string') q = { question: q, type: 'text' };
    if (!q || typeof q !== 'object') return { error: 'Question ' + (index + 1) + ' is not an object.' };
    const text = clean(q.question != null ? q.question : (q.text != null ? q.text : (q.prompt != null ? q.prompt : q.title)));
    if (!text) return { error: 'Question ' + (index + 1) + ' has no text.' };
    const rawOptions = Array.isArray(q.options) ? q.options : (Array.isArray(q.choices) ? q.choices : (Array.isArray(q.answers) ? q.answers : []));
    const options = rawOptions.map(parseOption).filter(Boolean);
    const t = String(q.type || '').toLowerCase();
    let type = 'single';
    if (t === 'text' || t === 'open' || t === 'free' || t === 'input') type = 'text';
    else if (t === 'multi' || t === 'multiple' || t === 'checkbox' || t === 'checkboxes' || q.multiple === true || q.multi === true) type = 'multi';
    if (!options.length) type = 'text';
    if (type !== 'text' && options.length > MAX_PAGE_OPTIONS) return { error: 'Question ' + (index + 1) + ' exceeds the rendering budget (' + MAX_PAGE_OPTIONS + ' options on one page).' };
    // "recommended": true on an option, or the question names the option's label (or several, as a list). A name that
    // matches nothing is ignored. A single-choice question keeps only the first one.
    const named = new Set((Array.isArray(q.recommended) ? q.recommended : [q.recommended]).filter((x) => typeof x === 'string').map((x) => clean(x).toLowerCase()));
    options.forEach((o) => { if (named.has(o.label.toLowerCase())) o.recommended = true; });
    if (type !== 'multi') { let seen = false; options.forEach((o) => { if (o.recommended) { if (seen) delete o.recommended; seen = true; } }); }
    // "other" is on unless the model turns it off; a string sets its label
    let other = q.other !== false && q.allowOther !== false && q.allow_other !== false;
    let otherLabel = typeof q.other === 'string' ? clean(q.other) : 'Other';
    if (type === 'text') other = false;
    return { id: 'q' + (index + 1), text, type, options, other, otherLabel: otherLabel || 'Other', placeholder: clean(q.placeholder) };
  }

  function parseAskSpec(text) {
    const raw = String(text || '');
    if (raw.length > MAX_CHARS) return { ok: false, error: 'The question block exceeds the ' + MAX_CHARS + ' character safety limit.' };
    const data = looseJson(raw);
    if (data === undefined || data === null || typeof data !== 'object') return { ok: false, error: 'The question block is not valid JSON.' };
    let list;
    let title = '';
    if (Array.isArray(data)) list = data;
    else if (Array.isArray(data.questions)) { list = data.questions; title = clean(data.title); }
    else list = [data];
    if (!list.length) return { ok: false, error: 'There are no questions in it.' };
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
    const other = String(a.other == null ? '' : a.other).trim();
    const free = String(a.text == null ? '' : a.text).trim();
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
    const total = spec.questions.length;
    const paged = total > 1;
    const root = el('form', 'dck-ask');
    root.setAttribute('novalidate', '');
    if (spec.title || total > 1) {
      const head = el('div', 'dck-ask-head');
      head.appendChild(el('div', 'dck-ask-title', spec.title || ''));
      root.appendChild(head);
    }
    const uid = 'ask' + Math.random().toString(36).slice(2, 8);
    const state = spec.questions.map(() => ({ picked: [], other: '', useOther: false, text: '' }));
    const page = el('div', 'dck-ask-page');
    root.appendChild(page);
    let mounted = -1;
    let locked = false;
    let sent = false;
    let changeFn = null;

    const submit = el('button', 'dck-ask-submit', opts.submitLabel || 'Add to message');
    submit.type = 'submit';
    const clear = el('button', 'dck-ask-clear', 'Clear');
    clear.type = 'button';
    const note = el('div', 'dck-ask-note');
    // With several questions only one shows at a time: arrows at the top right step through them.
    let cur = 0;
    let autoTimer = null;
    const svg = (d) => {
      const ns = 'http://www.w3.org/2000/svg';
      const sv = doc.createElementNS(ns, 'svg');
      sv.setAttribute('width', '16'); sv.setAttribute('height', '16'); sv.setAttribute('viewBox', '0 0 24 24');
      sv.setAttribute('fill', 'none'); sv.setAttribute('stroke', 'currentColor'); sv.setAttribute('stroke-width', '2.2');
      sv.setAttribute('stroke-linecap', 'round'); sv.setAttribute('stroke-linejoin', 'round'); sv.setAttribute('aria-hidden', 'true');
      const pa = doc.createElementNS(ns, 'path'); pa.setAttribute('d', d); sv.appendChild(pa);
      return sv;
    };
    const back = el('button', 'dck-ask-arrow');
    const next = el('button', 'dck-ask-arrow');
    back.type = next.type = 'button';
    back.setAttribute('aria-label', 'Previous question');
    next.setAttribute('aria-label', 'Next question');
    back.appendChild(svg('M15 6l-6 6 6 6'));
    next.appendChild(svg('M9 6l6 6-6 6'));
    const progress = el('span', 'dck-ask-progress');
    progress.setAttribute('aria-live', 'polite');

    function showStep(n) {
      cur = Math.max(0, Math.min(total - 1, n));
      if (mounted !== cur) mountQuestion(cur);
      if (!paged) return;
      back.disabled = cur === 0;
      next.disabled = cur === total - 1;
      submit.hidden = cur !== total - 1;
      progress.textContent = (cur + 1) + ' of ' + total;
    }
    function cancelAuto() { if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; } }
    function go(n) { cancelAuto(); showStep(n); }

    function refresh() {
      submit.disabled = locked || !state.some((s, i) => answerValue(spec.questions[i], s));
      clear.disabled = locked;
      showStep(cur);
      page.querySelectorAll('input, textarea').forEach((i) => { i.disabled = locked; });
      if (changeFn) changeFn(compileAnswers(spec, state));
    }

    function mountQuestion(qi) {
      mounted = qi;
      const q = spec.questions[qi];
      page.textContent = '';
      const box = el('fieldset', 'dck-ask-q');
      const legend = el('legend', 'dck-ask-qtext', (spec.questions.length > 1 ? (qi + 1) + '. ' : '') + q.text);
      box.appendChild(legend);
      const st = state[qi];
      const name = uid + '-' + qi;


      if (q.type === 'text') {
        const ta = el('textarea', 'dck-ask-text');
        ta.rows = 2;
        ta.value = st.text;
        ta.disabled = locked;
        ta.placeholder = q.placeholder || 'Type your answer';
        ta.setAttribute('aria-label', q.text);
        ta.addEventListener('input', () => { st.text = ta.value; refresh(); });
        box.appendChild(ta);
        page.appendChild(box);
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
        inp.checked = st.picked.includes(o.label) && (kind !== 'radio' || !st.useOther);
        inp.disabled = locked;
        const body = el('span', 'dck-ask-optbody');
        const lrow = el('span', 'dck-ask-optrow');
        lrow.appendChild(el('span', 'dck-ask-optlabel', o.label));
        if (o.recommended) lrow.appendChild(el('span', 'dck-ask-rec', 'Recommended'));
        body.appendChild(lrow);
        if (o.description) body.appendChild(el('span', 'dck-ask-optdesc', o.description));
        inp.addEventListener('change', () => {
          if (kind === 'radio') { st.picked = inp.checked ? [o.label] : []; st.useOther = false; }
          else if (inp.checked) { if (st.picked.indexOf(o.label) < 0) st.picked.push(o.label); } else st.picked = st.picked.filter((x) => x !== o.label);
          if (kind === 'radio') optRows.forEach((r) => { if (r.other) r.other.classList.remove('on'); });
          refresh();
          // a single-choice pick moves on by itself (not from the last question, not while sent); Back undoes it
          if (kind === 'radio' && inp.checked && paged && !locked && qi < total - 1) {
            if (autoTimer) clearTimeout(autoTimer);
            autoTimer = setTimeout(() => { autoTimer = null; if (cur === qi && !locked) showStep(qi + 1); }, 260);
          }
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
        inp.checked = st.useOther;
        inp.disabled = locked;
        const txt = el('input', 'dck-ask-othertext');
        txt.type = 'text';
        txt.value = st.other;
        txt.disabled = locked;
        txt.placeholder = q.otherLabel + '...';
        txt.setAttribute('aria-label', q.otherLabel + ' answer for: ' + q.text);
        const syncOther = () => { cancelAuto(); st.useOther = inp.checked; st.other = txt.value; refresh(); };
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
      page.appendChild(box);
    }

    if (paged) {
      const pager = el('div', 'dck-ask-pager');
      back.addEventListener('click', () => go(cur - 1));
      next.addEventListener('click', () => go(cur + 1));
      pager.append(progress, back, next);
      root.querySelector('.dck-ask-head').appendChild(pager);
    }
    const foot = el('div', 'dck-ask-foot');
    const again = el('button', 'dck-ask-again', 'Answer again');
    again.type = 'button';
    again.hidden = true;
    foot.append(submit, clear, again, note);
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
    again.addEventListener('click', () => { api.markSent(false); if (opts.onAgain) opts.onAgain(); });

    const api = {
      el: root,
      answers: () => JSON.parse(JSON.stringify(state)),
      text: () => compileAnswers(spec, state),
      reset() {
        state.forEach((s) => { s.picked = []; s.other = ''; s.useOther = false; s.text = ''; });
        cancelAuto();
        mounted = -1;
        note.textContent = '';
        cur = 0;
        sent = false; again.hidden = true; root.classList.remove('sent');
        refresh();
      },
      step: () => cur,
      // After the answers are sent the card is read-only (you can still page through it); "Answer again" undoes that.
      markSent(v) {
        sent = !!v;
        again.hidden = !sent;
        root.classList.toggle('sent', sent);
        locked = sent;
        if (locked) cancelAuto();
        root.classList.toggle('locked', locked);
        note.textContent = sent ? 'Answers sent' : '';
        refresh();
      },
      isSent: () => sent,
      // Puts earlier answers (from answers()) back into the form, e.g. when the site redraws the chat.
      setAnswers(list) {
        (list || []).forEach((a, i) => {
          const st = state[i];
          if (!st || !a) return;
          st.picked = Array.isArray(a.picked) ? a.picked.map(String) : [];
          st.other = String(a.other || ''); st.useOther = !!a.useOther; st.text = String(a.text || '');
        });
        cancelAuto();
        mounted = -1;
        refresh();
      },
      lock(v) { locked = !!v; if (locked) cancelAuto(); root.classList.toggle('locked', locked); refresh(); },
      note(t) { note.textContent = t || ''; },
      setSubmitLabel(t) { submit.textContent = t; },
      onChange(fn) { changeFn = fn; },
    };
    refresh();
    return api;
  }

  const api = { parseAskSpec, compileAnswers, buildAsk, MAX_CHARS, MAX_PAGE_OPTIONS };
  if (typeof globalThis !== 'undefined') globalThis.DCK_ASK = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
