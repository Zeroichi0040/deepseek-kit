// Real-Chromium checks: loads this folder as an unpacked extension and runs it on mocked chat.deepseek.com pages.
// Skipped (exit 0) when Playwright or its Chromium is not installed.
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.log('skip  e2e (playwright is not installed)'); process.exit(0); }

const EXT = path.join(__dirname, '..');
const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8').trim();
const openHTML = fx('reasoning-open.html');
const closedHTML = fx('reasoning-closed.html');

async function launch(width, height, extra) {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'dck-')), {
    headless: false, acceptDownloads: true,
    args: ['--headless=new', '--disable-extensions-except=' + EXT, '--load-extension=' + EXT, '--no-sandbox'],
    viewport: { width, height }, ...(extra || {}),
  });
  return ctx;
}
async function open(ctx, html, url) {
  await ctx.route('https://chat.deepseek.com/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.errs = errs;
  await p.goto(url || 'https://chat.deepseek.com/a/chat/s/1');
  await p.waitForSelector('#dck-fab');
  return p;
}
const settingsTab = async (p, section) => {
  await p.click('#dck-fab');
  await p.click('[role=tab]:has-text("Settings")');
  await p.locator('.dck-acchead:has-text("' + section + '")').click();
};
const toggle = (p, row) => p.locator('.dck-setrow:has-text("' + row + '") .dck-switch').click();
const close = (p) => p.click('#dck-drawer [aria-label="Close panel"]');
const ok = (m) => console.log('ok  ' + m);

// ---------- code blocks: header buttons, ZIP, collapse, line numbers, no floating bar
const long = Array.from({ length: 30 }, (_, i) => 'line ' + (i + 1)).join('\n');
const btn = (t) => `<div role="button" class="sb"><svg width="12" height="12"><rect width="12" height="12"/></svg><span class="lb">${t}</span></div>`;
const blk = (lang, code) => `<div class="cb" style="margin:14px 0;border:1px solid #444;background:#222;color:#eee"><div style="display:flex;align-items:center;padding:8px 12px"><span>${lang}</span><div class="acts" style="margin-left:auto;display:flex;gap:16px">${btn('Copy')}${btn('Download')}</div></div><pre style="margin:0;padding:12px;white-space:pre-wrap"><code class="language-${lang}">${code}</code></pre></div>`;
const noHeader = '<pre id="nohead" style="margin:12px 0;padding:12px">plain block without a header</pre>';

async function codeBlocks() {
  const ctx = await launch(1000, 900);
  const p = await open(ctx, `<body style="background:#111;color:#eee;width:560px">${blk('html', '&lt;h1&gt;Hi&lt;/h1&gt;')}${blk('python', long)}${blk('python', 'print(1)')}${noHeader}<div style="position:fixed;left:200px;right:200px;bottom:30px;height:90px;border-radius:20px;background:#2b2b2e"><textarea style="width:90%"></textarea></div></body>`);
  await p.waitForSelector('[data-dck-act]');
  const acts = () => p.evaluate(() => Array.from(document.querySelectorAll('.cb')).map((cb) => Array.from(cb.querySelectorAll('.acts > div')).map((n) => n.textContent.trim()).join(',')));
  assert.deepStrictEqual(await acts(), ['Collapse,+ ZIP,Copy,Download'.replace('Collapse,', ''), 'Collapse,+ ZIP,Copy,Download', '+ ZIP,Copy,Download']);
  ok('buttons sit before Copy and Download; a 1-line block has no Collapse');
  assert.strictEqual(await p.locator('#nohead [data-dck-act]').count(), 0);
  assert.strictEqual(await p.locator('#dck-codebar').count(), 0);
  await p.hover('#nohead');
  await p.waitForTimeout(500);
  assert.strictEqual(await p.locator('#dck-codebar').count(), 0, 'no floating bar on hover');
  ok('a block with no header gets nothing (no floating bar)');
  const muts = await p.evaluate(() => new Promise((res) => { let n = 0; const o = new MutationObserver((r) => { n += r.length; }); o.observe(document.body, { subtree: true, childList: true, characterData: true }); setTimeout(() => { o.disconnect(); res(n); }, 800); }));
  assert.ok(muts < 5, 'idle mutations: ' + muts);
  ok('idle page is quiet (' + muts + ' mutations)');
  const second = p.locator('.cb').nth(1);
  await second.locator('[data-dck-act=collapse]').click();
  assert.ok(await p.evaluate(() => document.querySelectorAll('pre')[1].hasAttribute('data-dck-collapsed')));
  assert.ok((await acts())[1].startsWith('Expand'));
  await second.locator('[data-dck-act=collapse]').click();
  assert.ok((await acts())[1].startsWith('Collapse'));
  ok('collapse and expand');
  await p.locator('.cb').nth(0).locator('[data-dck-act=zip]').click();
  await p.locator('.cb').nth(2).locator('[data-dck-act=zip]').click();
  assert.ok((await acts())[0].startsWith('Added'));
  assert.ok((await p.locator('#dck-zipchip').innerText()).includes('Download ZIP (2)'));
  // the pill must not cover the message box or its toolbar
  const overlap = await p.evaluate(() => {
    const z = document.getElementById('dck-zipchip').getBoundingClientRect();
    const ta = document.querySelector('textarea');
    let box = ta; for (let i = 0; i < 3 && box.parentElement && box.parentElement !== document.body; i++) box = box.parentElement;
    const b = box.getBoundingClientRect();
    return z.bottom > b.top && z.top < b.bottom && z.right > b.left && z.left < b.right;
  });
  assert.ok(!overlap, 'ZIP pill overlaps the message box');
  const [z] = await Promise.all([p.waitForEvent('download'), p.click('#dck-zipchip >> text=Download ZIP')]);
  const zp = path.join(os.tmpdir(), 'dck-test-' + Date.now() + '.zip');
  await z.saveAs(zp);
  const bytes = fs.readFileSync(zp);
  assert.strictEqual(bytes.readUInt32LE(0), 0x04034b50, 'zip signature');
  fs.unlinkSync(zp);
  assert.ok(!(await p.locator('#dck-zipchip').isVisible()));
  ok('ZIP of two blocks downloads and the chip clears');
  // diagnostics reflect the probe
  await settingsTab(p, 'Diagnostics');
  const diag = await p.locator('#dck-drawer').innerText();
  assert.ok(/Code block headers/.test(diag) && /4 code block\(s\), 3 with a Copy button found/.test(diag), diag);
  ok('Diagnostics reports 3 of 4 blocks with a header');
  assert.strictEqual(p.errs.length, 0, p.errs.join(';'));
  await ctx.close();
}

async function lineNumbers() {
  const K = (c, t) => `<span class="token ${c}">${t}</span>`;
  const lines = [`<span>${K('keyword', 'import')} time${K('punctuation', ',')} functools</span>`, '<span></span>',
    `<span>${K('keyword', 'def')} ${K('function', 'retry')}()</span>`,
    `<span>        x = "${'a very long string that has to wrap across several rows '.repeat(5)}"</span>`];
  for (let i = 0; i < 5; i++) lines.push(`<span>    row${i}</span>`);
  const PAGE = `<body style="background:#1c1c1e;color:#ddd;width:520px;padding:20px"><textarea></textarea><div class="md-code-block"><div class="md-code-block-banner-wrap" style="display:flex;padding:8px 12px"><span>python</span><div style="margin-left:auto;display:flex;gap:16px"><div role="button"><svg width="12" height="12"></svg><span>Copy</span></div><div role="button"><span>Download</span></div></div></div><pre style="font:13px/20px monospace;white-space:pre-wrap;word-break:break-all;padding:16px;margin:0">${lines.join('\n')}</pre></div></body>`;
  const ctx = await launch(640, 700);
  const p = await open(ctx, PAGE);
  await p.waitForSelector('[data-dck-act]');
  const sel = () => p.evaluate(() => { const pre = document.querySelector('pre'); const r = document.createRange(); r.selectNodeContents(pre); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString(); });
  const off = await sel();
  await settingsTab(p, 'Code blocks');
  await toggle(p, 'Line numbers');
  await p.waitForTimeout(200);
  await close(p);
  assert.ok(await p.evaluate(() => document.querySelector('pre').hasAttribute('data-dck-lines')));
  assert.strictEqual(await sel(), off, 'selected text identical with numbers on');
  assert.ok(!/^\d+$/m.test(off));
  ok('line numbers on: selection and copy text unchanged, blank lines kept');
  await ctx.close();
}

async function fab() {
  const ctx = await launch(1000, 700);
  const p = await open(ctx, '<body style="background:#151517;color:#eee"><textarea></textarea></body>');
  const box = () => p.locator('#dck-fab').boundingBox();
  const drawerOpen = () => p.evaluate(() => document.getElementById('dck-drawer').classList.contains('open'));
  let b = await box();
  assert.strictEqual(Math.round(b.x + b.width), 1000, 'docked on the right edge');
  await p.mouse.move(b.x + 10, b.y + 10); await p.mouse.down(); await p.mouse.move(400, 300, { steps: 8 }); await p.mouse.move(120, 210, { steps: 8 }); await p.mouse.up();
  b = await box();
  assert.ok(b.x < 20 && !(await drawerOpen()), 'drag docks left without opening the drawer');
  await p.reload(); await p.waitForSelector('#dck-fab');
  b = await box();
  assert.ok(b.x < 20, 'position survives a reload');
  await p.click('#dck-fab');
  assert.ok(await drawerOpen());
  await p.click('#dck-drawer [aria-label="Close panel"]');
  await settingsTab(p, 'Messages');
  await p.click('button:has-text("Reset"):not(:has-text("all"))');
  await close(p);
  b = await box();
  assert.strictEqual(Math.round(b.x + b.width), 1000, 'reset puts it back on the right');
  await p.click('#dck-fab');
  assert.ok(!(await p.locator('#dck-fab').isVisible()), 'right-docked button hides while the drawer is open');
  ok('Kit button: drag, dock, persist, reset');
  await ctx.close();
}

async function streamingCopy() {
  const b = (t) => `<div role="button" class="sb off" aria-disabled="true"><svg width="12" height="12"></svg><span class="lb">${t}</span></div>`;
  const PAGE = `<style>.sb{color:#ddd;cursor:pointer}.sb.off{color:#666;cursor:not-allowed}</style><body style="background:#1c1c1e;color:#ddd;width:520px"><textarea></textarea><div class="md-code-block"><div style="display:flex;padding:8px 12px"><span>python</span><div class="acts" style="margin-left:auto;display:flex;gap:16px">${b('Copy')}${b('Download')}</div></div><pre><span>a</span>\n<span>b</span>\n<span>c</span>\n<span>d</span></pre></div></body>`;
  const ctx = await launch(640, 260);
  const p = await open(ctx, PAGE);
  await p.waitForSelector('[data-dck-act]');
  const cursors = () => p.evaluate(() => Array.from(document.querySelectorAll('.acts > div')).map((n) => getComputedStyle(n).cursor));
  assert.ok((await cursors()).every((c) => c === 'not-allowed'), 'copies mirror the dimmed state while streaming');
  await p.evaluate(() => document.querySelectorAll('.acts > .sb:not([data-dck-act])').forEach((n) => { n.classList.remove('off'); n.removeAttribute('aria-disabled'); }));
  await p.waitForTimeout(500);
  assert.ok((await cursors()).every((c) => c === 'pointer'), 'and become normal when the site finishes');
  ok('our buttons follow the site Copy button (streaming then finished)');
  await ctx.close();
}

async function toolbarChips() {
  const ic = '<svg width="14" height="14"><rect width="14" height="14" fill="#999"/></svg>';
  const sb = (t) => `<div role="button" class="sb"><div style="width:14px;height:14px;margin-right:6px;display:flex">${ic}</div><span class="lb">${t}</span></div>`;
  const PAGE = (bw) => `<style>.sb{display:flex;align-items:center;color:#ddd;font-size:13px}.pill{border:1px solid #3b5bdb;border-radius:999px;padding:6px 12px;display:flex}</style>
<body style="background:#151517;color:#ddd;margin:0;padding:20px"><div style="width:760px"><div class="md-code-block"><div style="display:flex;padding:8px 12px"><span>html</span><div class="acts" style="margin-left:auto;display:flex;gap:22px">${sb('Copy')}${sb('Download')}</div></div><pre><span>a</span>\n<span>b</span>\n<span>c</span>\n<span>d</span></pre></div>
<div id="box" style="border-radius:20px;background:#2b2b2e;padding:16px;width:${bw}px"><textarea style="width:100%;background:none;border:0;color:#ddd"></textarea><div style="display:flex;justify-content:space-between;margin-top:20px"><div id="left" style="display:flex;gap:12px"><div class="pill" role="button"><span>DeepThink</span></div><div class="pill" role="button"><span>Search</span></div></div><div>attach send</div></div></div></div></body>`;
  for (const [w, inToolbar] of [[1000, true], [620, false]]) {
    const ctx = await launch(w, 520);
    const p = await open(ctx, PAGE(inToolbar ? 700 : 500)); // a box under 560px wide keeps the chips above it
    await p.waitForSelector('[data-dck-act]');
    await p.waitForTimeout(900);
    const where = await p.evaluate(() => ({ inToolbar: !!document.getElementById('dck-chips').closest('#left'), inline: document.getElementById('dck-chips').classList.contains('inline') }));
    assert.strictEqual(where.inToolbar, inToolbar, 'width ' + w);
    assert.strictEqual(where.inline, inToolbar);
    if (w === 1000) {
      // header buttons keep the same icon-to-text rhythm as the site's own
      const gaps = await p.evaluate(() => Array.from(document.querySelectorAll('.acts > div')).map((n) => { const a = n.querySelector('svg').getBoundingClientRect(); const l = n.querySelector('.lb') || n; return Math.round(l.getBoundingClientRect().left - a.right); }));
      assert.ok(Math.max.apply(null, gaps) - Math.min.apply(null, gaps) <= 2, 'icon gaps even: ' + gaps);
      await settingsTab(p, 'Messages');
      await toggle(p, 'Chips in the toolbar');
      await p.waitForTimeout(700);
      assert.ok(await p.evaluate(() => getComputedStyle(document.getElementById('dck-chips')).display === 'none'));
      await p.reload(); await p.waitForSelector('#dck-fab'); await p.waitForTimeout(900);
      assert.ok(await p.evaluate(() => { const c = document.getElementById('dck-chips'); return !c || getComputedStyle(c).display === 'none'; }), 'stays off after reload');
    }
    await ctx.close();
  }
  // no toolbar at all: chips go above the box and Diagnostics says so
  const ctx = await launch(1000, 520);
  const p = await open(ctx, '<body style="background:#151517;margin:0"><div style="height:300px"></div><div style="border-radius:20px;background:#2b2b2e;padding:16px;width:700px"><textarea style="width:100%"></textarea></div></body>');
  await p.waitForTimeout(900);
  assert.ok(await p.evaluate(() => document.getElementById('dck-chips').parentElement === document.body));
  await settingsTab(p, 'Diagnostics');
  const txt = await p.locator('#dck-drawer').innerText();
  assert.ok(/Toolbar pills/.test(txt) && /0 found/.test(txt) && /above the message box/.test(txt), txt);
  ok('chips: toolbar when wide, above when narrow or no toolbar; Diagnostics says which');
  await ctx.close();
}

// ---------- visuals: chart and viz blocks become cards
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function fence(lang, code, busy) {
  const spans = code.split('\n').map((l) => `<span>${esc(l)}</span>`).join('\n');
  const dis = busy ? ' aria-disabled="true" style="opacity:.4;cursor:not-allowed"' : '';
  return `<div class="md-code-block"><div class="md-code-block-banner-wrap" style="display:flex;padding:8px 12px"><span>${lang}</span><div class="acts" style="margin-left:auto;display:flex;gap:16px"><div role="button"${dis}><svg width="12" height="12"></svg><span>Copy</span></div><div role="button"><svg width="12" height="12"></svg><span>Download</span></div></div></div><pre>${spans}</pre></div>`;
}
const CHART = JSON.stringify({ type: 'bar', title: 'Monthly API usage', subtitle: 'Calls in thousands', labels: ['Jan', 'Feb', 'Mar'], series: [{ name: 'Calls', values: [12, 19, 15] }] }, null, 1);
const WIDGET = '<div class="v-card"><div class="v-title">Counter</div><button id="inc">Add</button> <span id="n" class="v-stat">0</span><div style="height:300px"></div></div>\n<script>var n=0;document.getElementById("inc").onclick=function(){n++;document.getElementById("n").textContent=n}</script>';
const BROKEN = '<div>x</div><script>throw new Error("boom")</script>';
const visPage = (inner, bg) => `<body style="background:${bg || '#151517'};color:#eee;margin:0"><div style="width:700px;padding:20px">${inner}</div><div style="border-radius:20px;background:#2b2b2e;padding:16px;width:700px;margin:20px"><textarea style="width:100%"></textarea></div></body>`;

async function visuals() {
  const ctx = await launch(1000, 900);
  const p = await open(ctx, visPage(fence('chart', CHART) + '<p id="gap">between</p>' + fence('viz', WIDGET) + fence('viz', BROKEN)));
  const hosts = new Set();
  p.on('request', (r) => { try { hosts.add(new URL(r.url()).host); } catch (e) { /* ignore */ } });
  await p.waitForSelector('.dck-vis[data-kind=chart] svg.dck-csvg', { timeout: 8000 });
  assert.strictEqual(await p.locator('.dck-vis[data-kind=chart] rect.dck-bar').count(), 3);
  assert.ok(await p.evaluate(() => getComputedStyle(document.querySelector('.md-code-block')).display === 'none'), 'source block hidden');
  assert.strictEqual(await p.locator('.dck-vis[data-kind=chart] .dck-ctitle').innerText(), 'Monthly API usage');
  assert.ok(await p.evaluate(() => document.querySelector('.md-code-block').nextElementSibling.classList.contains('dck-vis')), 'card sits right after its block');
  ok('chart block becomes a card and the source is hidden');

  await p.locator('.dck-vis[data-kind=chart]').hover();
  await p.locator('.dck-vis[data-kind=chart] .dck-vbtn:has-text("Code")').click();
  assert.ok(await p.evaluate(() => getComputedStyle(document.querySelector('.md-code-block')).display !== 'none'), 'Code shows the source');
  await p.locator('.dck-vis[data-kind=chart] .dck-vbtn:has-text("Hide code")').click();
  assert.ok(await p.evaluate(() => getComputedStyle(document.querySelector('.md-code-block')).display === 'none'));
  const [d1] = await Promise.all([p.waitForEvent('download'), p.locator('.dck-vis[data-kind=chart] .dck-vbtn:has-text("SVG")').click()]);
  const svgPath = path.join(os.tmpdir(), 'dck-' + Date.now() + '.svg');
  await d1.saveAs(svgPath);
  const svgText = fs.readFileSync(svgPath, 'utf8'); fs.unlinkSync(svgPath);
  assert.ok(svgText.startsWith('<svg') && !/var\(/.test(svgText), 'svg export has real colours');
  assert.ok(/monthly-api-usage\.svg/.test(d1.suggestedFilename()), d1.suggestedFilename());
  const [d2] = await Promise.all([p.waitForEvent('download'), p.locator('.dck-vis[data-kind=chart] .dck-vbtn:has-text("PNG")').click()]);
  const pngPath = path.join(os.tmpdir(), 'dck-' + Date.now() + '.png');
  await d2.saveAs(pngPath);
  const png = fs.readFileSync(pngPath); fs.unlinkSync(pngPath);
  assert.strictEqual(png.slice(1, 4).toString(), 'PNG', 'png signature');
  ok('Code toggle, SVG and PNG downloads');

  // tooltip
  const box = await p.locator('.dck-vis[data-kind=chart] rect.dck-hit').first().boundingBox();
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p.waitForSelector('.dck-tip:visible');
  assert.ok(/Jan/.test(await p.locator('.dck-tip').innerText()) && /12/.test(await p.locator('.dck-tip').innerText()));
  ok('hover tooltip');

  // widget
  const frameEl = p.locator('.dck-vis[data-kind=viz] iframe').first();
  await frameEl.waitFor();
  assert.strictEqual(await frameEl.getAttribute('sandbox'), 'allow-scripts', 'sandbox is scripts only');
  const fl = p.frameLocator('.dck-vis[data-kind=viz] iframe').first();
  await fl.locator('#inc').click(); await fl.locator('#inc').click();
  assert.strictEqual(await fl.locator('#n').innerText(), '2', 'widget script runs');
  await p.waitForFunction(() => parseInt(document.querySelector('.dck-vis[data-kind=viz] iframe').style.height, 10) > 250);
  ok('widget runs in the sandbox and sizes itself to its content');
  const frame = p.frames().find((f) => f !== p.mainFrame() && /Counter/.test(f.url() + '') === false && f.parentFrame() === p.mainFrame());
  const blocked = await p.frames().filter((f) => f !== p.mainFrame())[0].evaluate(() => fetch('https://example.com/x').then(() => 'reached', () => 'blocked'));
  assert.strictEqual(blocked, 'blocked', 'widget fetch is blocked by its CSP');
  const sameOrigin = await p.frames().filter((f) => f !== p.mainFrame())[0].evaluate(() => { try { return typeof parent.document.title; } catch (e) { return 'denied'; } });
  assert.strictEqual(sameOrigin, 'denied', 'widget cannot reach the page');
  assert.ok([...hosts].every((h) => h === 'chat.deepseek.com' || h === ''), 'no request left the page: ' + [...hosts].join(','));
  ok('widget has no network and no access to the page');

  // error path
  const bad = p.locator('.dck-vis[data-kind=viz]').nth(1);
  await bad.locator('.dck-viserr-text').waitFor({ timeout: 5000 });
  assert.ok(/boom/.test(await bad.locator('.dck-viserr-text').innerText()));
  await bad.locator('.dck-vbtn:has-text("Send error to DeepSeek")').click();
  const sent = await p.locator('textarea').inputValue();
  assert.ok(/boom/.test(sent) && /```viz/.test(sent), sent);
  ok('a widget error can be sent to the message box (not auto-sent)');

  const stray = p.errs.filter((m) => !/boom/.test(m)); // the broken widget throws on purpose
  assert.strictEqual(stray.length, 0, stray.join(';'));
  // diagnostics + prompt row
  await settingsTab(p, 'Diagnostics');
  const diag = await p.locator('#dck-drawer').innerText();
  assert.ok(/Widget sandbox/.test(diag) && /isolated frames run scripts/.test(diag), diag);
  assert.ok(/3 chart\/viz block\(s\)/.test(diag), diag);
  await close(p);
  await p.click('#dck-fab');
  await p.click('[role=tab]:has-text("Prompts")');
  assert.ok(/Visuals/.test(await p.locator('#dck-drawer').innerText()), 'Visuals prompt listed');
  ok('Diagnostics and the Visuals prompt row');

  // turning it off
  await close(p);
  await settingsTab(p, 'Visuals');
  await toggle(p, 'Draw charts and widgets');
  await p.waitForTimeout(300);
  assert.strictEqual(await p.locator('.dck-vis').count(), 0, 'cards removed');
  assert.ok(await p.evaluate(() => getComputedStyle(document.querySelector('.md-code-block')).display !== 'none'), 'plain block is back');
  await toggle(p, 'Draw charts and widgets');
  await p.waitForSelector('.dck-vis[data-kind=chart] svg', { timeout: 5000 });
  ok('the switch removes and restores cards');
  await ctx.close();

  // streaming placeholder, then the finished card
  const ctx2 = await launch(1000, 700);
  const p2 = await open(ctx2, visPage(fence('chart', CHART, true)));
  await p2.waitForSelector('.dck-visph');
  assert.ok(/Building chart/.test(await p2.locator('.dck-vis').innerText()));
  assert.strictEqual(await p2.locator('svg.dck-csvg').count(), 0, 'nothing drawn while streaming');
  await p2.evaluate(() => { const b = document.querySelector('.acts > div[aria-disabled]:not([data-dck-act])'); b.removeAttribute('aria-disabled'); b.style.cssText = ''; });
  await p2.waitForSelector('svg.dck-csvg', { timeout: 5000 });
  ok('placeholder while the site is still writing, card when it finishes');
  await ctx2.close();

  // bad chart json
  const ctx3 = await launch(1000, 700);
  const p3 = await open(ctx3, visPage(fence('chart', '{ "type": "bar", ')));
  await p3.waitForSelector('.dck-viserr-text', { timeout: 5000 });
  assert.ok(/not valid JSON/.test(await p3.locator('.dck-viserr-text').innerText()));
  await ctx3.close();
  ok('a broken chart shows a readable error');

  // light page
  const ctx4 = await launch(1000, 700);
  const p4 = await open(ctx4, visPage(fence('chart', CHART), '#ffffff').replace('color:#eee', 'color:#111'));
  await p4.waitForSelector('.dck-vis svg.dck-csvg', { timeout: 5000 });
  assert.strictEqual(await p4.locator('.dck-vis').getAttribute('data-theme'), 'light');
  ok('light pages get the light card');
  await ctx4.close();
}

// ---------- Hidden mode must not touch the site's hidden measuring copy of a box (its height comes from that text)
async function mirror() {
  const ctxText = '[Context from my notes]\nInstructions (Default):\nline\n[End of context]\n\nhello';
  const html = `<body style="background:#151517;color:#eee;margin:0"><div id="bubble">${ctxText.replace(/\n/g, '<br>')}</div><div id="wrap"><textarea id="ta"></textarea><div class="ds-textarea__mirror" id="mir"></div></div><div id="wrap2"><textarea id="ta2"></textarea><div class="b13855df" id="mir2"></div></div></body>`;
  const ctx = await launch(1000, 800);
  const p = await open(ctx, html);
  await p.click('#dck-fab');
  await p.locator('#dck-drawer button:has-text("Hidden")').first().click();
  await p.waitForTimeout(500);
  await p.evaluate((t) => { document.getElementById('mir').textContent = t; document.getElementById('mir2').textContent = t; document.getElementById('bubble').textContent = t; }, ctxText);
  await p.waitForTimeout(600);
  assert.strictEqual(await p.evaluate(() => document.getElementById('mir').textContent.indexOf('[Context from my notes]') === 0), true, 'the measuring copy keeps its full text');
  assert.strictEqual(await p.evaluate(() => document.getElementById('mir2').textContent.indexOf('[Context from my notes]') === 0), true, 'the message box copy (any class name) keeps its full text');
  assert.strictEqual(await p.evaluate(() => document.getElementById('bubble').textContent.indexOf('[Context from my notes]') === -1), true, 'the chat bubble is still shortened');
  ok('Hidden mode: bubbles are shortened, the site measuring copy of a box is left alone');
  await ctx.close();
}

// ---------- reasoning fold
const chevOpen = openHTML.match(/<div class="ds-icon" style="font-size: 14px[^>]*>.*?<\/svg><\/div>/s)[0];
const chevClosed = closedHTML.match(/<div class="ds-icon _3d79d66"[^>]*>.*?<\/svg><\/div>/s)[0];
const longText=Array.from({length:12},(_,i)=>`<p class="ds-markdown-paragraph"><span class="">Reasoning paragraph ${i} - ${'words '.repeat(40)}</span></p>`).join('');
// "think content" like the site: several .ds-think-content children plus search rows (as described in the notes)
const stepHTML=`<div class="e1675d8b ds-think-content _767406f"><div class="ds-markdown">${longText}</div></div><div class="_60aa7fb"><span>Found 9 web pages</span></div><div class="e4c3fd02"><span>Read 3 pages</span></div>`;
const head=openHTML.slice(0,openHTML.indexOf('<div class="e1675d8b'));          // header + spacer c2b72bb8
const tail='<div class="_8f7678d"></div></div>';
const PAGE=`<!doctype html><html class="dark"><head><style>.ds-think-content{margin:0}</style>
<script>
window.STEP=${JSON.stringify(stepHTML)}; window.heights=[]; window.siteClicks=0; window.errs=[];
window.addEventListener('error',e=>errs.push(e.message));
// the "site": a React-like toggle on the header row (handler on a descendant, like a real one)
function build(label,open){ const d=document.createElement('div'); d.innerHTML=${JSON.stringify(head)}+(${JSON.stringify(stepHTML)}*0||'')+${JSON.stringify(tail)};
  const block=d.firstElementChild; block.querySelector('span._5255ff8').textContent=label;
  const row=block.querySelector('._5ab5d64'); const spacer=block.querySelector('._8f7678d');
  const steps=()=>Array.from(block.querySelectorAll(':scope > .ds-think-content, :scope > ._60aa7fb, :scope > .e4c3fd02'));
  const addSteps=()=>{ const t=document.createElement('div'); t.innerHTML=${JSON.stringify(stepHTML)}; Array.from(t.children).forEach(n=>block.insertBefore(n,spacer)); };
  const setChev=(o)=>{ const t=document.createElement('div'); t.innerHTML=o?${JSON.stringify(chevOpen)}:${JSON.stringify(chevClosed)}; row.lastElementChild.replaceWith(t.firstElementChild); };
  if(open){ addSteps(); setChev(true);} else setChev(false);
  row.addEventListener('click',()=>{ siteClicks++; if(steps().length){ steps().forEach(n=>n.remove()); setChev(false);} else { addSteps(); setChev(true);} });
  block.__open=()=>steps().length>0; return block; }
function addMessage(key,label,open){ const item=document.createElement('div'); item.setAttribute('data-virtual-list-item-key',String(key)); const m=document.createElement('div'); m.className='ds-message'; m.append(build(label,open)); item.append(m); document.getElementById('list').append(item); return item; }
window.build=build; window.addMessage=addMessage;
</script></head><body style="background:#151517;color:#ddd;font-family:sans-serif;width:640px;padding:20px"><textarea></textarea><div id="list"></div></body></html>`;

async function fold() {
  const ctx = await launch(900, 900);
  const p = await open(ctx, PAGE, 'https://chat.deepseek.com/a/chat/s/A');
  const perr = p.errs;
  const results = [];
  const chk = (n, c, d) => { results.push([c, n, d || '']); };
 const H=(k)=>p.evaluate((k)=>Math.round(document.querySelector('[data-virtual-list-item-key="'+k+'"] [style*="--collapsible"]').getBoundingClientRect().height),k);
 const vis=(k)=>p.evaluate((k)=>Array.from(document.querySelectorAll('[data-virtual-list-item-key="'+k+'"] .ds-think-content')).some(n=>n.getBoundingClientRect().height>0),k);
 const hdr=(k)=>p.locator('[data-virtual-list-item-key="'+k+'"] ._245c867');
 await p.evaluate(()=>{ addMessage(1,'Thought for 12 seconds',true); addMessage(2,'Thought for 3 seconds',false); });
 const open0=await H(1), closed0=await H(2);
 chk('C1 fold off: open block much taller than site-closed one',open0>closed0*3,`open ${open0}px, closed ${closed0}px`);
 // turn the setting on through the real UI
 await p.click('#dck-fab'); await p.click('[role=tab]:has-text("Settings")'); await p.locator('.dck-acchead:has-text("Messages")').click();
 await p.locator('.dck-setrow:has-text("Collapse reasoning") .dck-switch').click(); await p.waitForTimeout(250); await p.click('#dck-drawer [aria-label="Close panel"]');
 chk('C2 fold on: open block folds to the closed height, text hidden',(await H(1))===closed0 && !(await vis(1)),`${await H(1)}px vs closed ${closed0}px`);
 const c0=await p.evaluate(()=>siteClicks);
 await hdr(1).click({position:{x:30,y:12}}); await p.waitForTimeout(150);
 chk('C3a first header click unfolds and the site handler is NOT called',(await H(1))===open0 && (await p.evaluate(()=>siteClicks))===c0,`height ${await H(1)}, siteClicks ${await p.evaluate(()=>siteClicks)}`);
 await hdr(1).click({position:{x:30,y:12}}); await p.waitForTimeout(150);
 chk('C3b second click reaches the site (it closes the block)',(await p.evaluate(()=>siteClicks))===c0+1 && (await H(1))===closed0,`siteClicks ${await p.evaluate(()=>siteClicks)}, height ${await H(1)}`);
 await hdr(1).click({position:{x:30,y:12}}); await p.waitForTimeout(150);
 chk('C3c third click: site opens it, stays open',(await H(1))===open0,`height ${await H(1)}`);
 // C4 site-closed block opened by the site
 await hdr(2).click({position:{x:30,y:12}}); await p.waitForTimeout(150);
 chk('C4 site-closed block opened by the site is not re-hidden',(await H(2))>closed0*3 && await vis(2),`height ${await H(2)}`);
 // C5 rebuilt message keeps open state
 await p.evaluate(()=>{ const old=document.querySelector('[data-virtual-list-item-key="1"]'); const n=addMessage(1,'Thought for 12 seconds',true); old.remove(); document.getElementById('list').prepend(n); });
 await p.waitForTimeout(300);
 chk('C5 rebuilt message keeps the block you opened open',(await H(1))===open0,`height ${await H(1)}`);
 // C6 new streaming block: never grows
 await p.evaluate(()=>{ window.__h=[]; const item=addMessage(3,'Thinking...',false); const block=item.querySelector('[style*="--collapsible"]'); const ro=new ResizeObserver(()=>__h.push(Math.round(block.getBoundingClientRect().height))); ro.observe(block);
   setTimeout(()=>{ const spacer=block.querySelector('._8f7678d'); const t=document.createElement('div'); t.innerHTML=STEP; Array.from(t.children).forEach(n=>block.insertBefore(n,spacer)); },100); });
 await p.waitForTimeout(500);
 const hs=await p.evaluate(()=>__h); chk('C6 block that starts streaming never grows past the header',Math.max(...hs)<=closed0+2,'heights seen '+JSON.stringify(hs));
 // C7 site rewrites <html class>
 await p.evaluate(()=>{ document.documentElement.className='light'; }); await p.waitForTimeout(700);
 await p.evaluate(()=>addMessage(4,'Thought for 5 seconds',true)); await p.waitForTimeout(300);
 chk('C7 fold survives the site rewriting the html class',(await H(4))===closed0,`new open block is ${await H(4)}px (closed ${closed0})`);
 // C8 other chat, same item key
 await p.evaluate(()=>{ history.pushState({},'','/a/chat/s/B'); document.getElementById('list').textContent=''; addMessage(1,'Thought for 9 seconds',true); }); await p.waitForTimeout(700);
 chk('C8 different chat, same item key: block stays folded',(await H(1))===closed0,`height ${await H(1)} (open would be ${open0})`);
 chk('C9 no page errors',perr.length===0&&(await p.evaluate(()=>errs.length))===0,JSON.stringify(perr));

  const bad = results.filter((r) => !r[0]);
  results.forEach((r) => console.log((r[0] ? 'ok  ' : 'FAIL') + ' reasoning fold ' + r[1] + (r[0] ? '' : ' | ' + r[2])));
  await ctx.close();
  assert.strictEqual(bad.length, 0, bad.length + ' fold check(s) failed');
}

(async () => {
  try {
    await codeBlocks();
    await lineNumbers();
    await fab();
    await streamingCopy();
    await toolbarChips();
    await visuals();
    await mirror();
    await fold();
  } catch (e) {
    if (/Executable doesn't exist|browserType.launch/.test(e.message)) { console.log('skip  e2e (Chromium is not installed)'); process.exit(0); }
    console.error('FAIL:', e.stack || e.message);
    process.exit(1);
  }
  console.log('\nall e2e tests passed');
  process.exit(0);
})();
