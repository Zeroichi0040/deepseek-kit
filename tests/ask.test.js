// ask.js: reading the model's question block, the form, and the text of the answers.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'ask.js'), 'utf8');
const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
dom.window.eval(src);
const A = dom.window.DCK_ASK;
const doc = dom.window.document;
const ok = (m) => console.log('ok  ' + m);
const parse = (o) => A.parseAskSpec(typeof o === 'string' ? o : JSON.stringify(o));
const Q = (extra) => ({ question: 'What kind of application?', options: ['Web application', 'Desktop application', 'Mobile application'], ...(extra || {}) });

// ---- parsing
{
  const r = parse({ questions: [Q()] });
  assert.ok(r.ok);
  const q = r.spec.questions[0];
  assert.strictEqual(JSON.stringify([q.text, q.type, q.options.length, q.other]), JSON.stringify(['What kind of application?', 'single', 3, true]));
  assert.strictEqual(parse(Q()).spec.questions.length, 1, 'a bare question object is fine');
  assert.strictEqual(parse([Q(), Q()]).spec.questions.length, 2, 'a bare list is fine');
  assert.strictEqual(parse('```json\n{"questions":[{"question":"A?","options":["x","y",],},],}\n```').ok, true, 'fence and trailing commas tolerated');
  assert.strictEqual(parse('Sure! {"question":"A?","options":["x","y"]} hope that helps').ok, true, 'text around the object tolerated');
  assert.strictEqual(parse({ questions: [Q({ type: 'multi' })] }).spec.questions[0].type, 'multi');
  assert.strictEqual(parse({ questions: [Q({ type: 'checkbox' })] }).spec.questions[0].type, 'multi');
  assert.strictEqual(parse({ questions: [Q({ multiple: true })] }).spec.questions[0].type, 'multi');
  assert.strictEqual(parse({ questions: [{ question: 'Why?', type: 'text' }] }).spec.questions[0].type, 'text');
  assert.strictEqual(parse({ questions: [{ question: 'No options given' }] }).spec.questions[0].type, 'text', 'no options means a free answer');
  assert.strictEqual(parse({ questions: [Q({ other: false })] }).spec.questions[0].other, false);
  assert.strictEqual(parse({ questions: [Q({ other: 'Something else' })] }).spec.questions[0].otherLabel, 'Something else');
  const d = parse({ questions: [Q({ options: [{ label: 'Login', description: 'email and password' }, { text: 'Dashboard' }, 'Search', 7, null, { nothing: 1 }] })] }).spec.questions[0].options;
  assert.strictEqual(d.map((o) => o.label).join('|'), 'Login|Dashboard|Search|7');
  assert.strictEqual(d[0].description, 'email and password');
  assert.strictEqual(parse({ questions: [{ text: 'Alt key?', choices: ['a', 'b'] }] }).spec.questions[0].text, 'Alt key?', 'alternative key names');
  ok('parsing is tolerant: fences, commas, bare object or list, type aliases, option shapes');
}
// ---- rejections and limits
{
  assert.ok(!parse('not json').ok);
  assert.ok(!parse('42').ok);
  assert.ok(!parse({ questions: [] }).ok);
  assert.ok(/no text/.test(parse({ questions: [{ options: ['a'] }] }).error));
  assert.ok(!parse('x'.repeat(A.MAX_CHARS + 1)).ok, 'size limit');
  const many = parse({ questions: Array.from({ length: 40 }, (_, i) => Q({ question: 'Q' + i, options: Array.from({ length: 50 }, (_, k) => 'o' + k) })) });
  assert.strictEqual(many.spec.questions.length, A.MAX_QUESTIONS);
  assert.strictEqual(many.spec.questions[0].options.length, A.MAX_OPTIONS);
  assert.ok(parse({ questions: [Q({ question: 'x'.repeat(5000) })] }).spec.questions[0].text.length <= 400);
  ok('bad input is rejected with a reason; sizes are limited');
}
// ---- answer text
{
  const one = parse({ questions: [Q()] }).spec;
  assert.strictEqual(A.compileAnswers(one, [{ picked: ['Web application'], other: '', useOther: false, text: '' }]), 'What kind of application?\nWeb application');
  assert.strictEqual(A.compileAnswers(one, [{ picked: [], other: '', useOther: false }]), '', 'nothing chosen: nothing to send');
  assert.strictEqual(A.compileAnswers(one, [{ picked: [], other: 'A CLI tool', useOther: true }]), 'What kind of application?\nA CLI tool', 'a custom answer replaces the choice');
  assert.strictEqual(A.compileAnswers(one, [{ picked: ['Web application'], other: 'ignored', useOther: false }]), 'What kind of application?\nWeb application');
  assert.strictEqual(A.compileAnswers(one, [{ picked: [], other: '   ', useOther: true }]), '', 'an empty custom answer is no answer');
  const three = parse({ questions: [Q(), Q({ question: 'Which features?', type: 'multi', options: ['Login', 'Dashboard'] }), { question: 'Anything else?', type: 'text' }] }).spec;
  const text = A.compileAnswers(three, [
    { picked: ['Web application'] },
    { picked: ['Login', 'Dashboard'], other: 'Reports', useOther: true },
    { text: '  keep it simple  ' },
  ]);
  assert.strictEqual(text, 'Here are my answers to your questions.\n\nQ1: What kind of application?\nA1: Web application\n\nQ2: Which features?\nA2: Login, Dashboard, Reports\n\nQ3: Anything else?\nA3: keep it simple');
  assert.ok(/\(skipped\)/.test(A.compileAnswers(three, [{ picked: ['Web application'] }, { picked: [] }, { text: '' }])), 'an unanswered question shows as skipped');
  ok('answer text: one question, several, custom answers, skipped');
}
// ---- the form
{
  const spec = parse({ questions: [Q(), Q({ question: 'Which features?', type: 'multi', options: ['Login', 'Dashboard'] }), { question: 'Notes?', type: 'text' }] }).spec;
  let sent = null;
  const f = A.buildAsk(doc, spec, { submitLabel: 'Add to message', onSubmit: (t) => { sent = t; } });
  doc.body.appendChild(f.el);
  const submit = f.el.querySelector('.dck-ask-submit');
  const fire = (el, ev) => el.dispatchEvent(new dom.window.Event(ev, { bubbles: true }));
  const click = (el) => { el.click(); };
  assert.strictEqual(submit.textContent, 'Add to message');
  assert.strictEqual(submit.disabled, true, 'nothing answered yet');
  assert.strictEqual(f.el.querySelectorAll('fieldset').length, 3);
  assert.strictEqual(f.el.querySelectorAll('input[type=radio]').length, 3 + 1, 'single question: its options plus Other');
  assert.strictEqual(f.el.querySelectorAll('input[type=checkbox]').length, 2 + 1, 'multi question: its options plus Other');
  const radios = Array.from(f.el.querySelectorAll('input[type=radio]'));
  click(radios[1]);
  assert.strictEqual(submit.disabled, false, 'one answer is enough to send');
  click(radios[0]);
  assert.strictEqual(f.answers()[0].picked.join('|'), 'Web application', 'single choice keeps one');
  const boxes = Array.from(f.el.querySelectorAll('input[type=checkbox]'));
  click(boxes[0]); click(boxes[1]);
  click(boxes[0]);
  assert.strictEqual(f.answers()[1].picked.join('|'), 'Dashboard', 'multi choice toggles');
  // custom answer: typing in the Other field selects it
  const other = f.el.querySelectorAll('.dck-ask-othertext')[0];
  other.value = 'A CLI tool'; fire(other, 'input');
  assert.strictEqual(f.answers()[0].useOther, true, 'typing picks Other');
  assert.strictEqual(radios[3].checked, true);
  assert.strictEqual(f.answers()[0].picked.length, 0, 'and clears the other choice for a single question');
  // free text
  const ta = f.el.querySelector('textarea');
  ta.value = 'keep it simple'; fire(ta, 'input');
  assert.strictEqual(f.text().split('\n').slice(-1)[0], 'A3: keep it simple');
  // submit
  f.el.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.strictEqual(sent, 'Here are my answers to your questions.\n\nQ1: What kind of application?\nA1: A CLI tool\n\nQ2: Which features?\nA2: Dashboard\n\nQ3: Notes?\nA3: keep it simple');
  // lock
  f.lock(true);
  assert.strictEqual(submit.disabled, true);
  assert.ok(Array.from(f.el.querySelectorAll('input, textarea')).every((i) => i.disabled));
  sent = null;
  f.el.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.strictEqual(sent, null, 'a locked form sends nothing');
  f.lock(false);
  // clear
  f.el.querySelector('.dck-ask-clear').click();
  assert.strictEqual(f.text(), '');
  assert.strictEqual(submit.disabled, true);
  assert.ok(Array.from(f.el.querySelectorAll('input[type=radio], input[type=checkbox]')).every((i) => !i.checked));
  assert.strictEqual(f.el.querySelector('textarea').value, '');
  f.setSubmitLabel('Send answers');
  assert.strictEqual(submit.textContent, 'Send answers');
  ok('form: choose, toggle, custom answer, free text, submit, lock, clear, relabel');
}
// ---- nothing in a question is ever markup
{
  const evil = '<img src=x onerror=window.__pwn=1>';
  const spec = parse({ title: evil, questions: [{ question: evil, options: [evil, { label: '<script>window.__pwn=2</script>', description: evil }], other: evil }] }).spec;
  const f = A.buildAsk(doc, spec, {});
  doc.body.appendChild(f.el);
  assert.strictEqual(f.el.querySelectorAll('img, script, iframe, svg, style').length, 0, 'no active elements');
  assert.ok(f.el.textContent.indexOf('<img src=x') >= 0, 'shown as text');
  assert.ok(Array.from(f.el.querySelectorAll('*')).every((e) => !Array.from(e.attributes).some((a) => /^on/i.test(a.name))));
  ok('hostile text in a question is shown as text, never as markup');
}
// ---- random input never throws
{
  let seed = 99;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const bits = ['{', '}', '[', ']', '"question"', ':', ',', '"options"', '"a"', '"type"', '"multi"', 'null', '1', '"other"', 'false', '\n', '```', ' '];
  for (let k = 0; k < 500; k++) {
    let s = '';
    const n = 1 + Math.floor(rnd() * 40);
    for (let j = 0; j < n; j++) s += bits[Math.floor(rnd() * bits.length)];
    const r = A.parseAskSpec(s);
    assert.ok(r && typeof r.ok === 'boolean');
    if (r.ok) { const f = A.buildAsk(doc, r.spec, {}); assert.ok(f.el); }
  }
  ok('500 random inputs: always a clean result, never an exception');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  // ---- the pager: arrows at the top right, one question at a time
  {
    const spec = parse({ questions: [Q(), Q({ question: 'Which features?', type: 'multi', options: ['Login', 'Dashboard'] }), { question: 'Notes?', type: 'text' }] }).spec;
    const f = A.buildAsk(doc, spec, {});
    doc.body.appendChild(f.el);
    const q = () => Array.from(f.el.querySelectorAll('fieldset')).map((x) => !x.hidden).join();
    const back = f.el.querySelector('[aria-label="Previous question"]');
    const next = f.el.querySelector('[aria-label="Next question"]');
    const submit = f.el.querySelector('.dck-ask-submit');
    const prog = () => f.el.querySelector('.dck-ask-progress').textContent;
    assert.ok(f.el.querySelector('.dck-ask-head .dck-ask-pager'), 'the arrows are in the header row');
    assert.strictEqual(f.el.querySelectorAll('.dck-ask-dot').length, 0, 'no dots any more');
    assert.strictEqual(q(), 'true,false,false');
    assert.strictEqual(back.disabled, true);
    assert.strictEqual(submit.hidden, true, 'Submit appears only on the last step');
    assert.strictEqual(prog(), '1 of 3');
    next.click();
    assert.strictEqual(q(), 'false,true,false'); assert.strictEqual(prog(), '2 of 3'); assert.strictEqual(back.disabled, false);
    next.click();
    assert.strictEqual(q(), 'false,false,true'); assert.strictEqual(next.disabled, true, 'no Next on the last step'); assert.strictEqual(submit.hidden, false);
    back.click(); back.click();
    assert.strictEqual(q(), 'true,false,false');
    ok('pager: arrows step through one question at a time; Submit only on the last');

    // auto-next: a single-choice pick moves on, nothing else does
    f.el.querySelectorAll('input[type=radio]')[0].click();
    assert.strictEqual(q(), 'true,false,false', 'not at once: the pick shows first');
    await sleep(380);
    assert.strictEqual(q(), 'false,true,false', 'a single-choice pick moves to the next question');
    f.el.querySelectorAll('input[type=checkbox]')[0].click();
    await sleep(380);
    assert.strictEqual(q(), 'false,true,false', 'a multi-choice pick stays put');
    back.click();
    const other = f.el.querySelectorAll('.dck-ask-othertext')[0];
    other.value = 'A CLI tool'; other.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await sleep(380);
    assert.strictEqual(q(), 'true,false,false', 'typing in Other stays put');
    f.el.querySelectorAll('input[type=radio]')[1].click();
    back.click(); next.click(); back.click(); // leaving before the timer fires cancels it
    await sleep(380);
    assert.strictEqual(q(), 'true,false,false', 'using an arrow cancels a pending auto-advance');
    next.click(); next.click();
    f.el.querySelector('textarea').value = 'x';
    // last question: no radio there, so check a form whose last question is single choice
    const spec2 = parse({ questions: [Q(), Q({ question: 'Second?' })] }).spec;
    const g = A.buildAsk(doc, spec2, {});
    doc.body.appendChild(g.el);
    const gq = () => Array.from(g.el.querySelectorAll('fieldset')).map((x) => !x.hidden).join();
    g.el.querySelectorAll('fieldset')[0].querySelector('input[type=radio]').click();
    await sleep(380);
    assert.strictEqual(gq(), 'false,true');
    g.el.querySelectorAll('fieldset')[1].querySelector('input[type=radio]').click();
    await sleep(380);
    assert.strictEqual(gq(), 'false,true', 'the last question never moves on by itself');
    ok('auto-next: single choice only, cancellable, never from the last question');

    // sent: read-only, still pageable, "Answer again" undoes it
    let again = 0;
    const h = A.buildAsk(doc, spec2, { onAgain: () => { again++; } });
    doc.body.appendChild(h.el);
    h.el.querySelectorAll('input[type=radio]')[0].click();
    h.markSent(true);
    assert.ok(Array.from(h.el.querySelectorAll('input, textarea')).every((i) => i.disabled), 'sent: options locked');
    assert.strictEqual(h.el.querySelector('.dck-ask-again').hidden, false);
    assert.strictEqual(h.el.querySelector('[aria-label="Next question"]').disabled, false, 'sent: still pageable');
    h.el.querySelector('.dck-ask-again').click();
    assert.strictEqual(again, 1);
    assert.ok(Array.from(h.el.querySelectorAll('input')).every((i) => !i.disabled) && h.el.querySelector('.dck-ask-again').hidden, 'Answer again unlocks it');
    // a rebuilt card gets the sent answers back
    const r2 = A.buildAsk(doc, spec2, {});
    r2.setAnswers(h.answers());
    r2.markSent(true);
    assert.strictEqual(JSON.stringify(r2.answers()), JSON.stringify(h.answers()));
    assert.ok(r2.el.querySelectorAll('input[type=radio]')[0].checked && r2.el.querySelector('.dck-ask-note').textContent === 'Answers sent');
    ok('sent: read-only, pageable, Answer again, answers restored on a rebuilt card');
  }
  // ---- recommended
  {
    const a = parse({ questions: [{ question: 'Which?', options: ['A', { label: 'B', recommended: true }, { label: 'C', recommended: true }] }] }).spec.questions[0];
    assert.strictEqual(a.options.filter((o) => o.recommended).map((o) => o.label).join(), 'B', 'single choice keeps the first recommended');
    const b = parse({ questions: [{ question: 'Which?', type: 'multi', options: ['A', 'B', 'C'], recommended: ['a', 'C', 'nope'] }] }).spec.questions[0];
    assert.strictEqual(b.options.filter((o) => o.recommended).map((o) => o.label).join(), 'A,C', 'named by label, any case, several for multi, unknown names ignored');
    const c = parse({ questions: [{ question: 'Which?', options: ['A', 'B'], recommended: 'B' }, { question: 'Hmm', type: 'text', recommended: 'x' }, { question: 'Which 2?', options: [{ label: 'A', recommended: 'yes' }] }] });
    assert.strictEqual(c.spec.questions[0].options[1].recommended, true);
    assert.ok(!c.spec.questions[2].options[0].recommended, 'only true counts');
    const f = A.buildAsk(doc, parse({ questions: [{ question: 'Which?', options: ['A', { label: 'B', recommended: true }] }] }).spec, {});
    const badges = f.el.querySelectorAll('.dck-ask-rec');
    assert.strictEqual(badges.length, 1); assert.strictEqual(badges[0].textContent, 'Recommended');
    assert.strictEqual(f.el.querySelectorAll('input:checked').length, 0, 'never preselected');
    assert.strictEqual(f.el.querySelectorAll('.dck-ask-optlabel')[1].textContent, 'B', 'the label itself is unchanged');
    ok('recommended: flag or label, one for single choice, badge shown, never preselected');
  }
  console.log('all ask tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
