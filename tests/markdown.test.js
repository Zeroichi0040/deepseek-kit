// markdown.js: what the preview draws, and that a hostile source cannot inject anything.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'markdown.js'), 'utf8');
const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
dom.window.eval(src);
const MD = dom.window.DCK_MD;
const doc = dom.window.document;
const ok = (m) => console.log('ok  ' + m);
const html = (s) => MD.render(doc, s).innerHTML;
const root = (s) => MD.render(doc, s);

// ---- what it draws
{
  assert.strictEqual(html('# Title'), '<h1>Title</h1>');
  assert.strictEqual(html('### Three ###'), '<h3>Three</h3>');
  assert.strictEqual(html('Setext\n======'), '<h1>Setext</h1>');
  assert.strictEqual(html('Sub\n---'), '<h2>Sub</h2>');
  assert.strictEqual(html('This is **important** and *soft* and ~~gone~~ and __bold__ and _it_.'), '<p>This is <strong>important</strong> and <em>soft</em> and <del>gone</del> and <strong>bold</strong> and <em>it</em>.</p>');
  assert.strictEqual(html('snake_case_name and 2*3*4'), '<p>snake_case_name and 2<em>3</em>4</p>', 'intraword underscores stay literal');
  assert.strictEqual(html('Use `a < b` here'), '<p>Use <code>a &lt; b</code> here</p>');
  assert.strictEqual(html('a\\*b'), '<p>a*b</p>', 'escapes');
  assert.strictEqual(html('one\ntwo'), '<p>one two</p>', 'soft break is a space');
  assert.strictEqual(html('one  \ntwo'), '<p>one<br>two</p>', 'two trailing spaces = hard break');
  ok('headings, emphasis, code, escapes, breaks');
}
{
  assert.strictEqual(html('---'), '<hr>');
  assert.strictEqual(html('* * *'), '<hr>');
  assert.strictEqual(html('> quoted\n> more'), '<blockquote><p>quoted more</p></blockquote>');
  assert.strictEqual(html('> a\n>\n> > nested'), '<blockquote><p>a</p><blockquote><p>nested</p></blockquote></blockquote>');
  assert.strictEqual(html('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
  assert.strictEqual(html('1. first\n2. second'), '<ol><li>first</li><li>second</li></ol>');
  assert.strictEqual(html('3. three\n4. four'), '<ol start="3"><li>three</li><li>four</li></ol>');
  assert.strictEqual(html('- a\n  - b\n  - c\n- d'), '<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>');
  assert.strictEqual(html('1. a\n   - x\n2. b'), '<ol><li>a<ul><li>x</li></ul></li><li>b</li></ol>');
  assert.ok(/<input type="checkbox" disabled="" checked="">done/.test(html('- [x] done')));
  assert.ok(/<input type="checkbox" disabled="">todo/.test(html('- [ ] todo')));
  ok('rules, quotes, lists (nested, ordered start, tasks)');
}
{
  const t = root('| Name | Qty |\n|:-----|----:|\n| a | 1 |\n| b \\| c | 2 |');
  assert.strictEqual(t.querySelectorAll('th').length, 2);
  assert.strictEqual(t.querySelectorAll('tbody tr').length, 2);
  assert.strictEqual(t.querySelectorAll('th')[1].style.textAlign, 'right');
  assert.strictEqual(t.querySelectorAll('tbody tr')[1].children[0].textContent, 'b | c');
  assert.strictEqual(root('a | b\nnot a table').querySelectorAll('table').length, 0);
  const f = root('```js\nlet a = 1 < 2;\n  indented\n```\nafter');
  assert.strictEqual(f.querySelector('pre code').textContent, 'let a = 1 < 2;\n  indented');
  assert.strictEqual(f.querySelector('code').getAttribute('data-lang'), 'js');
  assert.strictEqual(f.querySelector('p').textContent, 'after');
  assert.strictEqual(root('~~~\nx\n~~~').querySelector('pre code').textContent, 'x');
  assert.strictEqual(root('```\nunclosed').querySelector('pre code').textContent, 'unclosed', 'an unclosed fence runs to the end');
  assert.strictEqual(root('    code here\n    more').querySelector('pre code').textContent, 'code here\nmore');
  ok('tables, fenced and indented code');
}
{
  const sample = '# Project Notes\n\nThis is **important**.\n\n- First item\n- Second item\n\n---\n\n1. First step\n2. Second step';
  const r = root(sample);
  assert.deepStrictEqual(Array.from(r.children).map((c) => c.tagName), ['H1', 'P', 'UL', 'HR', 'OL']);
  assert.strictEqual(r.querySelector('strong').textContent, 'important');
  ok('the example from the feature notes');
}
// ---- links
{
  assert.strictEqual(html('[site](https://example.com/a?b=1 "title")'), '<p><a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer nofollow">site</a></p>');
  assert.strictEqual(html('<https://example.com>'), '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">https://example.com</a></p>');
  assert.strictEqual(html('see https://example.com/x.'), '<p>see <a href="https://example.com/x" target="_blank" rel="noopener noreferrer nofollow">https://example.com/x</a>.</p>');
  assert.strictEqual(html('[**bold** link](mailto:a@b.co)'), '<p><a href="mailto:a@b.co" target="_blank" rel="noopener noreferrer nofollow"><strong>bold</strong> link</a></p>');
  ok('links');
}
// ---- hostile input: nothing is ever markup
{
  const bad = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<iframe src="https://evil"></iframe>', '<a href="javascript:alert(1)">x</a>',
    '[x](javascript:alert(1))', '[x]( javascript:alert(1) )', '[x](JaVaScRiPt:alert(1))', '[x](java\tscript:alert(1))', '[x](data:text/html;base64,PHNjcmlwdD4=)',
    '[x](vbscript:msgbox(1))', '[x](//evil.example/x)', '[x](/relative)', '[x](#frag)', '![a](https://evil.example/pixel.png)', '![a](javascript:alert(1))',
    '[x](https://ok.example "t\\" onmouseover=\\"alert(1)")', '[x](<https://ok.example/a" onclick="alert(1)>)', '<svg onload=alert(1)>', '`<script>`', '**<b onclick=1>**',
    '| <script> | x |\n|---|---|\n| <img src=x onerror=1> | y |', '# <img src=x onerror=1>', '- <script>x</script>', '> <iframe>', '```\n<script>alert(1)</script>\n```',
  ];
  bad.forEach((s) => {
    const r = root(s);
    assert.strictEqual(r.querySelectorAll('script, img, iframe, svg, object, embed, form, style, link, base, meta').length, 0, 'no active elements: ' + s);
    r.querySelectorAll('*').forEach((el) => {
      Array.from(el.attributes).forEach((a) => assert.ok(!/^on/i.test(a.name), 'no handler attribute: ' + s));
    });
    r.querySelectorAll('a').forEach((a) => assert.ok(/^(https?:\/\/|mailto:)/i.test(a.getAttribute('href')), 'safe href only: ' + s + ' -> ' + a.getAttribute('href')));
  });
  assert.strictEqual(root('![a](https://evil.example/pixel.png)').querySelector('.dck-md-img').textContent, '[image: a]');
  assert.strictEqual(root('[x](javascript:alert(1))').querySelectorAll('a').length, 0, 'an unsafe link is plain text');
  assert.strictEqual(root('[x](javascript:alert(1))').textContent, 'x');
  assert.strictEqual(root('<script>alert(1)</script>').textContent, '<script>alert(1)</script>', 'shown as text');
  ok('hostile sources: no scripts, images, frames, handlers or unsafe links');
}
// ---- robustness
{
  assert.strictEqual(MD.render(doc, 'x'.repeat(MD.MAX_CHARS + 1)), null, 'too long: no preview');
  assert.strictEqual(root('').children.length, 0);
  // nesting and odd input must terminate and never throw
  const t0 = Date.now();
  const deep = '> '.repeat(500) + 'x';
  assert.ok(root(deep));
  assert.ok(root('- a\n'.repeat(3000)));
  assert.ok(root('*'.repeat(5000)));
  assert.ok(root('['.repeat(3000) + '](' + ')'.repeat(3000)));
  assert.ok(root('`'.repeat(4000)));
  assert.ok(root('| a |'.repeat(2000) + '\n' + '|-'.repeat(2000)));
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const alphabet = ['*', '_', '`', '[', ']', '(', ')', '!', '<', '>', '|', '-', '#', '~', '\\', '\n', ' ', '1.', '  ', 'a', 'http://x.co', '```', '> ', '- ', '    '];
  for (let k = 0; k < 400; k++) {
    let s = '';
    const len = 1 + Math.floor(rnd() * 120);
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    const r = root(s);
    assert.ok(r, 'random input renders');
    assert.strictEqual(r.querySelectorAll('script, img, iframe, svg').length, 0);
  }
  assert.ok(Date.now() - t0 < 8000, 'pathological and random inputs stay fast: ' + (Date.now() - t0) + ' ms');
  ok('robust: depth, huge and random inputs finish quickly without errors');
}
console.log('all markdown tests passed');
