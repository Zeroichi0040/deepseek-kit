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
  // composer: decoys
  {
    const { w, doc, SITE } = page('<div id="edit"><textarea id="e"></textarea></div><textarea id="hid"></textarea><div role="dialog"><textarea id="dlg"></textarea></div><div id="dck-drawer"><textarea id="ours"></textarea></div><div id="main"><textarea id="comp"></textarea></div>');
    const tops = { e: 100, hid: 0, dlg: 500, ours: 700, comp: 600 };
    const rect = (id) => ({ top: tops[id], bottom: tops[id] + 40, left: 0, right: 300, width: id === 'hid' ? 0 : 300, height: 40 });
    w.HTMLElement.prototype.getBoundingClientRect = function () { return this.id && tops[this.id] !== undefined ? rect(this.id) : { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; };
    w.HTMLElement.prototype.getClientRects = function () { return this.id === 'hid' ? [] : [rect(this.id || 'x')]; };
    assert.strictEqual(SITE.composer(doc).id, 'comp', 'lowest visible textarea outside dialogs and our UI');
    doc.getElementById('e').closest('#edit').remove();
    assert.strictEqual(SITE.composer(doc).id, 'comp');
    ok('composer ignores hidden, dialog, our own and edit-message textareas');
  }
  {
    const { doc, SITE } = page('<textarea id="a"></textarea><textarea id="b"></textarea>');
    assert.strictEqual(SITE.composer(doc).id, 'a', 'without layout the first textarea is used');
    assert.strictEqual(page('').SITE.composer(), null);
    ok('composer fallback without layout');
  }
  // send button choice
  {
    const mk = (inner) => { const p = page('<div id="bx"><textarea></textarea><div id="bar">' + inner + '</div></div>'); return { SITE: p.SITE, ta: p.doc.querySelector('textarea') }; };
    const ic = '<svg></svg>';
    let r = mk('<div role="button" aria-label="Voice input">' + ic + '</div><div role="button" aria-label="Attach file">' + ic + '</div><div role="button" aria-label="Send message">' + ic + '</div><div role="button" aria-label="Voice mode">' + ic + '</div>');
    assert.strictEqual(r.SITE.sendButton(r.ta).getAttribute('aria-label'), 'Send message', 'a button named send wins over a later mic');
    r = mk('<div role="button" id="s1">' + ic + '</div><div role="button" aria-label="Attach file">' + ic + '</div>');
    assert.strictEqual(r.SITE.sendButton(r.ta).id, 's1', 'named attach/mic buttons are never chosen');
    r = mk('<div role="button" aria-label="Attach">' + ic + '</div><div role="button" title="Voice">' + ic + '</div>');
    assert.strictEqual(r.SITE.sendButton(r.ta), null, 'only non-send buttons: no guess');
    r = mk('<div role="button" id="x1">' + ic + '</div><div role="button" id="x2">' + ic + '</div>');
    assert.strictEqual(r.SITE.sendButton(r.ta).id, 'x2', 'unnamed buttons: the last/right-most');
    r = mk('<div role="button" aria-label="Send" aria-disabled="true">' + ic + '</div><div role="button" id="ok">' + ic + '</div>');
    assert.strictEqual(r.SITE.sendButton(r.ta).id, 'ok', 'disabled buttons are skipped');
    ok('send button: named send wins, attach/mic never chosen, no guess when only those exist');
  }
  // block language and box, also after our own header buttons were added
  {
    const { doc, SITE } = page(fx('codeblock.html') + '<div class="md-code-block"><div><span>chart</span><div><div role="button"><span>+ ZIP</span></div><div role="button"><span>Copy</span></div></div></div><pre>{}</pre></div><pre class="x"><code class="language-viz">a</code></pre>');
    const pres = SITE.codeBlocks();
    assert.strictEqual(SITE.blockLang(pres[0]), 'python');
    assert.strictEqual(SITE.blockLang(pres[1]), 'chart', 'label is read from its own text node');
    assert.strictEqual(SITE.blockLang(pres[2]), 'viz', 'code class wins');
    assert.strictEqual(SITE.blockBox(pres[0]), pres[0].parentElement);
    assert.strictEqual(SITE.blockBusy(pres[0]), false);
    pres[0].parentElement.querySelector('[role=button]').setAttribute('aria-disabled', 'true');
    assert.strictEqual(SITE.blockBusy(pres[0]), true, 'a disabled Copy button means the site is still writing');
    ok('block language, box and busy state');
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
