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
// ---- the pager: one question at a time
{
  const spec = parse({ questions: [Q(), Q({ question: 'Which features?', type: 'multi', options: ['Login', 'Dashboard'] }), { question: 'Notes?', type: 'text' }] }).spec;
  const f = A.buildAsk(doc, spec, {});
  doc.body.appendChild(f.el);
  const q = () => Array.from(f.el.querySelectorAll('fieldset')).map((x) => !x.hidden);
  const nav = (t) => Array.from(f.el.querySelectorAll('.dck-ask-nav')).find((b) => b.textContent === t);
  const submit = f.el.querySelector('.dck-ask-submit');
  const dots = () => Array.from(f.el.querySelectorAll('.dck-ask-dot'));
  assert.strictEqual(q().join(), 'true,false,false', 'starts on the first question only');
  assert.strictEqual(nav('Back').disabled, true, 'no Back on the first step');
  assert.strictEqual(nav('Next').hidden, false);
  assert.strictEqual(submit.hidden, true, 'Submit appears only on the last step');
  assert.strictEqual(f.el.querySelector('.dck-ask-progress').textContent, 'Question 1 of 3');
  assert.strictEqual(dots().length, 3);
  f.el.querySelector('input[type=radio]').click();
  assert.strictEqual(q().join(), 'true,false,false', 'answering does not move on by itself');
  assert.ok(dots()[0].classList.contains('done') && dots()[0].classList.contains('cur') && !dots()[1].classList.contains('done'), 'dots show current and answered');
  nav('Next').click();
  assert.strictEqual(q().join(), 'false,true,false');
  assert.strictEqual(nav('Back').disabled, false);
  assert.strictEqual(f.el.querySelector('.dck-ask-progress').textContent, 'Question 2 of 3');
  nav('Next').click();
  assert.strictEqual(q().join(), 'false,false,true');
  assert.strictEqual(nav('Next').hidden, true, 'Next is replaced by Submit on the last step');
  assert.strictEqual(submit.hidden, false);
  assert.strictEqual(submit.disabled, false, 'one answer anywhere is enough');
  nav('Back').click(); nav('Back').click();
  assert.strictEqual(q().join(), 'true,false,false');
  assert.strictEqual(f.answers()[0].picked.length, 1, 'going back keeps the answer');
  dots()[2].click();
  assert.strictEqual(q().join(), 'false,false,true', 'a dot jumps to that question');
  assert.ok(f.text().indexOf('A2: (skipped)') > 0, 'a skipped question is listed as skipped');
  f.lock(true);
  assert.ok(!nav('Back').disabled && !dots()[0].disabled, 'a sent form can still be paged through to review');
  f.lock(false);
  f.reset();
  assert.strictEqual(q().join(), 'true,false,false', 'Clear goes back to the first question');
  // a single question has no pager at all
  const one = A.buildAsk(doc, parse({ questions: [Q()] }).spec, {});
  assert.strictEqual(one.el.querySelectorAll('.dck-ask-pager, .dck-ask-dot').length, 0);
  assert.strictEqual(one.el.querySelector('.dck-ask-submit').hidden, false);
  assert.strictEqual(one.el.querySelector('fieldset').hidden, false);
  ok('pager: one question at a time, Back/Next, dots, answers kept, Submit on the last step, none for one question');
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
console.log('all ask tests passed');
