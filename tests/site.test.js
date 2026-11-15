// The DeepSeek-specific finders in site.js, run against small markup fixtures.
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');
const siteSrc = fs.readFileSync(path.join(__dirname, '..', 'site.js'), 'utf8');

function page(html, url) {
  const dom = new JSDOM('<!doctype html><body>' + html + '</body>', { url: url || 'https://chat.deepseek.com/a/chat/s/1', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.eval(siteSrc);
  return { w, doc: w.document, SITE: w.DCK_SITE };
}
const ok = (m) => console.log('ok  ' + m);

(async () => {
  // message box, toolbar pills, send button
  {
    const { doc, SITE } = page(fx('toolbar.html'));
    const ta = SITE.composer(doc);
    assert.ok(ta, 'composer found');
    const pills = SITE.toolbarPills(doc.getElementById('box'));
    assert.strictEqual(pills.map((p) => p.textContent.trim()).join(','), 'DeepThink,Search');
    assert.ok(pills.every((p) => p.classList.contains('pill')), 'pill is the whole button, not the inner span');
    assert.strictEqual(SITE.sendButton(ta).id, 'send', 'send is the last icon button');
    assert.strictEqual(SITE.toolbarPills(null).length, 0);
    const p = SITE.probe();
    assert.ok(p.composer && p.send && p.pills === 2, 'probe sees the box, send and 2 pills');
    ok('composer, toolbar pills and send button are found');
  }
  // a pill that is the only child of the box is not a toolbar pill
  {
    const { doc, SITE } = page('<div id="b"><span>Search</span></div>');
    assert.strictEqual(SITE.toolbarPills(doc.getElementById('b')).length, 0);
    ok('a lone label directly in the box is ignored');
  }
  // code block header
  {
    const { doc, SITE } = page(fx('codeblock.html') + fx('codeblock.html'));
    const pres = SITE.codeBlocks();
    assert.strictEqual(pres.length, 2);
    pres.forEach((pre) => {
      const c = SITE.copyButton(pre);
      assert.ok(c && c.getAttribute('role') === 'button' && c.textContent.trim() === 'Copy', 'Copy button is the whole button');
      assert.ok(pre.parentElement.querySelector('.acts').contains(c));
    });
    assert.notStrictEqual(SITE.copyButton(pres[0]), SITE.copyButton(pres[1]), 'each block gets its own button');
    const p = SITE.probe();
    assert.strictEqual(p.codeBlocks, 2); assert.strictEqual(p.codeHeaders, 2);
    ok('Copy buttons are found per block');
  }
  // a block without a header, and a block whose header is shared with another block
  {
    const { SITE } = page('<pre><span>a</span></pre>');
    assert.strictEqual(SITE.copyButton(SITE.codeBlocks()[0]), null);
    const p2 = page('<div><div role="button"><span>Copy</span></div><pre>a</pre><pre>b</pre></div>');
    assert.strictEqual(p2.SITE.copyButton(p2.SITE.codeBlocks()[0]), null, 'two blocks under one box: no guess');
    assert.strictEqual(SITE.probe().codeHeaders, 0);
    ok('no header means no button');
  }
  // text helpers
  {
    const { doc, SITE } = page('<div id="r"><b role="button"><i> Hello </i><u>x</u></b></div>');
    const r = doc.getElementById('r');
    assert.strictEqual(SITE.firstText(r.firstChild).nodeValue.trim(), 'Hello');
    assert.strictEqual(SITE.textNodes(r, (n) => n.nodeValue.trim() === 'x').length, 1);
    assert.strictEqual(SITE.findByText(r, ['Hello'])[0].tagName, 'I', 'widened only while the parent holds just that text');
    ok('text helpers');
  }
  // reasoning blocks
  {
    const open = '<div data-virtual-list-item-key="7">' + fx('reasoning-open.html') + '</div>';
    const closed = '<div data-virtual-list-item-key="8">' + fx('reasoning-closed.html') + '</div>';
    const { doc, SITE } = page(open + closed);
    const blocks = SITE.reasoningBlocks();
    assert.strictEqual(blocks.length, 2);
    assert.strictEqual(SITE.blockIsOpen(blocks[0]), true, 'open block has its think content');
    assert.strictEqual(SITE.blockIsOpen(blocks[1]), false, 'closed block does not');
    assert.strictEqual(SITE.blockKey(blocks[0]), '/a/chat/s/1#7');
    assert.strictEqual(SITE.blockOfHeader(blocks[0].firstElementChild), blocks[0]);
    assert.strictEqual(SITE.blockOfHeader(blocks[0].children[1]), null, 'only the first child is the header');
    const p = SITE.probe();
    assert.strictEqual(p.reasoning, 2); assert.strictEqual(p.reasoningOpen, 1);
    ok('reasoning blocks, open/closed state and keys');
  }
  // once-per-frame scheduler
  {
    const { w, SITE } = page('');
    let n = 0;
    const run = SITE.oncePerFrame(() => { n++; });
    run(); run(); run();
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(n, 1, 'three requests, one run');
    run(); await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(n, 2, 'and it can run again later');
    ok('oncePerFrame');
  }
  console.log('\nall site tests passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
