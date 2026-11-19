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
const allChecks = (p) => p.locator('.dck-diagtoggle').first().click(); // Diagnostics folds the OK rows
const toggle = (p, row) => p.locator('.dck-setrow:has-text("' + row + '") .dck-switch').click();
const close = (p) => p.click('#dck-drawer [aria-label="Close panel"]');
const ok = (m) => console.log('ok  ' + m);

// ---------- code blocks: header buttons, ZIP, collapse, line numbers, no floating bar
const long = Array.from({ length: 30 }, (_, i) => 'line ' + (i + 1)).join('\n');
const btn = (t) => `<div role="button" class="sb"><svg width="12" height="12"><rect width="12" height="12"/></svg><span class="lb">${t}</span></div>`;
const blk = (lang, code) => `<div class="cb" style="margin:14px 0;border:1px solid #444;background:#222;color:#eee"><div style="display:flex;align-items:center;padding:8px 12px"><span>${lang}</span><div class="acts" style="margin-left:auto;display:flex;gap:16px">${btn('Copy')}${btn('Download')}</div></div><pre style="margin:0;padding:12px;white-space:pre-wrap"><code class="language-${lang}">${code}</code></pre></div>`;
// the real site puts no language class on the code element: the language is only the header label
const plainBlk = (lang, code) => `<div class="cb" style="margin:14px 0;border:1px solid #444;background:#222;color:#eee"><div style="display:flex;align-items:center;padding:8px 12px"><span>${lang}</span><div class="acts" style="margin-left:auto;display:flex;gap:16px">${btn('Copy')}${btn('Download')}</div></div><pre style="margin:0;padding:12px;white-space:pre-wrap">${code}</pre></div>`;
const noHeader = '<pre id="nohead" style="margin:12px 0;padding:12px">plain block without a header</pre>';

async function codeBlocks() {
  const ctx = await launch(1000, 900);
  const p = await open(ctx, `<body style="background:#111;color:#eee;width:560px">${blk('html', '&lt;h1&gt;Hi&lt;/h1&gt;')}${blk('python', long)}${plainBlk('python', 'print(1)')}${noHeader}<div style="position:fixed;left:200px;right:200px;bottom:30px;height:90px;border-radius:20px;background:#2b2b2e"><textarea style="width:90%"></textarea></div></body>`);
  await p.waitForSelector('[data-dck-act]');
  const acts = () => p.evaluate(() => Array.from(document.querySelectorAll('.cb')).map((cb) => Array.from(cb.querySelectorAll('.acts > div')).map((n) => n.textContent.trim()).join(',')));
  assert.deepStrictEqual(await acts(), ['+ ZIP,Copy,Download', 'Expand (30 lines),+ ZIP,Copy,Download', '+ ZIP,Copy,Download']);
  ok('buttons sit before Copy and Download; a 1-line block has no Collapse; a 30-line block starts collapsed and says so');
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
  const folded = () => p.evaluate(() => document.querySelectorAll('pre')[1].hasAttribute('data-dck-collapsed'));
  assert.ok(await folded(), 'a block over 20 lines starts collapsed on a new install');
  await second.locator('[data-dck-act=collapse]').click();
  assert.ok(!(await folded()));
  assert.ok((await acts())[1].startsWith('Collapse'));
  await p.waitForTimeout(300);
  assert.ok(!(await folded()), 'a block you opened stays open');
  await second.locator('[data-dck-act=collapse]').click();
  assert.ok(await folded());
  assert.ok((await acts())[1].startsWith('Expand (30 lines)'));
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
  const names = bytes.toString('latin1');
  assert.ok(/snippet-1\.html/.test(names), 'html block keeps .html: ' + names.replace(/[^\x20-\x7e]/g, '.').slice(0, 200));
  assert.ok(/snippet-3\.py/.test(names), 'a python block whose language is only in the header label keeps .py: ' + names.replace(/[^\x20-\x7e]/g, '.').slice(0, 200));
  fs.unlinkSync(zp);
  assert.ok(!(await p.locator('#dck-zipchip').isVisible()));
  ok('ZIP of two blocks downloads and the chip clears');
  // diagnostics reflect the probe
  await settingsTab(p, 'Diagnostics');
  const diag = await p.locator('#dck-drawer').innerText();
  assert.ok(/1 problem found/.test(diag) && /Code block headers/.test(diag) && /4 code block\(s\), 3 with a Copy button found/.test(diag), diag);
  assert.ok(!/Reasoning blocks/.test(diag), 'problems show first; the OK rows are folded until asked for');
  await allChecks(p);
  assert.ok(/Other checks/.test(await p.locator('#dck-drawer').innerText()) && /Reasoning blocks/.test(await p.locator('#dck-drawer').innerText()));
  ok('Diagnostics: problem shown first with the OK rows folded, then expandable'); ok('Diagnostics reports 3 of 4 blocks with a header');
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
  const numbered = () => p.evaluate(() => document.querySelector('pre').hasAttribute('data-dck-lines'));
  assert.ok(await numbered(), 'line numbers are on for a new install');
  const on = await sel();
  await settingsTab(p, 'Code blocks');
  await toggle(p, 'Line numbers');
  await p.waitForTimeout(200);
  await close(p);
  assert.ok(!(await numbered()), 'the switch turns them off');
  assert.strictEqual(await sel(), on, 'selected text identical with numbers on and off');
  assert.ok(!/^\d+$/m.test(on));
  ok('line numbers on by default: selection and copy text unchanged, blank lines kept');
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
  await allChecks(p);
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
  const brief = await p.locator('#dck-drawer').innerText();
  assert.ok(/Everything found/.test(brief) && !/Widget sandbox/.test(brief), 'with no problems the OK rows stay folded');
  await allChecks(p);
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

// ---------- Markdown preview
async function mdPreview() {
  const MDTEXT = '# Project Notes\n\nThis is **important**.\n\n- First item\n- Second item\n\n---\n\n1. First step\n2. Second step\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nlet x = 1;\n```';
  const HOSTILE = '<script>window.__pwn=1</script>\n\n<img src="https://evil.example/a.png" onerror="window.__pwn=2">\n\n[click](javascript:window.__pwn=3)\n\n![pixel](https://evil.example/p.png)\n\n[ok](https://example.com/page)';
  const ctx = await launch(1000, 900);
  const reqs = new Set();
  const p = await open(ctx, visPage(fence('markdown', MDTEXT) + '<p id="gap">between</p>' + fence('js', 'a = 1') + fence('md', HOSTILE) + fence('markdown', '# Streaming', true)));
  p.on('request', (r) => { try { reqs.add(new URL(r.url()).host); } catch (e) { /* ignore */ } });
  await p.waitForSelector('[data-dck-act]');
  const blocks = () => p.locator('.md-code-block');
  const hasBtn = (i, label) => blocks().nth(i).locator('[data-dck-act="preview"]:has-text("' + label + '")').count();
  assert.strictEqual(await hasBtn(0, 'Preview'), 1, 'a markdown block offers Preview');
  assert.strictEqual(await blocks().nth(1).locator('[data-dck-act="preview"]').count(), 0, 'a js block does not');
  assert.strictEqual(await hasBtn(2, 'Preview'), 1, 'md is the same as markdown');
  assert.strictEqual(await blocks().nth(3).locator('[data-dck-act="preview"]').count(), 0, 'no Preview while the block is still being written');
  ok('Preview is offered on finished markdown blocks only');

  const sourceBefore = await p.evaluate(() => document.querySelectorAll('.md-code-block pre')[0].textContent);
  await blocks().nth(0).locator('[data-dck-act="preview"]').click();
  await p.waitForSelector('.md-code-block .dck-mdprev h1');
  const v = await p.evaluate(() => {
    const box = document.querySelector('.md-code-block');
    const prev = box.querySelector(':scope > .dck-mdprev');
    const src = box.querySelector(':scope > pre');
    return {
      h1: prev.querySelector('h1').textContent, strong: prev.querySelector('strong').textContent,
      ul: prev.querySelectorAll('ul li').length, ol: prev.querySelectorAll('ol li').length, hr: prev.querySelectorAll('hr').length,
      td: prev.querySelectorAll('td').length, code: prev.querySelector('pre code').textContent,
      srcHidden: getComputedStyle(src).display === 'none', prevShown: getComputedStyle(prev).display !== 'none',
      innerHeaderButtons: prev.querySelectorAll('[data-dck-act]').length, innerNumbered: prev.querySelectorAll('pre[data-dck-lines]').length,
      headerStill: !!box.querySelector('.md-code-block-banner-wrap'),
    };
  });
  assert.deepStrictEqual(v, { h1: 'Project Notes', strong: 'important', ul: 2, ol: 2, hr: 1, td: 2, code: 'let x = 1;', srcHidden: true, prevShown: true, innerHeaderButtons: 0, innerNumbered: 0, headerStill: true });
  assert.strictEqual(await hasBtn(0, 'Source'), 1, 'the button now says Source');
  assert.strictEqual(await blocks().nth(0).locator('[data-dck-act="collapse"]').count(), 0, 'no Collapse while previewing');
  ok('Preview draws the rendered markdown and hides the source (header and its code blocks left alone)');
  // the site can restyle table cells inside its code block; the text must still clear the borders
  await p.addStyleTag({ content: '.md-code-block th, .md-code-block td, .md-code-block table td { padding: 0 !important; }' });
  const pad = await p.evaluate(() => { const c = getComputedStyle(document.querySelector('.md-code-block .dck-mdprev td')); return [c.paddingLeft, c.paddingTop]; });
  assert.ok(parseFloat(pad[0]) >= 12 && parseFloat(pad[1]) >= 6, 'table cell padding survives a site rule: ' + pad);
  ok('Preview table cells keep their padding even if the site resets it');

  await blocks().nth(0).locator('[data-dck-act="preview"]').click();
  await p.waitForTimeout(200);
  const back = await p.evaluate(() => ({ prev: document.querySelectorAll('.dck-mdprev').length, shown: getComputedStyle(document.querySelector('.md-code-block pre')).display !== 'none', text: document.querySelectorAll('.md-code-block pre')[0].textContent, flag: document.querySelector('.md-code-block').hasAttribute('data-dck-prev') }));
  assert.deepStrictEqual({ prev: back.prev, shown: back.shown, flag: back.flag }, { prev: 0, shown: true, flag: false });
  assert.strictEqual(back.text, sourceBefore, 'the original source text is never changed');
  assert.strictEqual(await hasBtn(0, 'Preview'), 1);
  ok('Source switches back; the original text is untouched');

  // hostile markdown
  await blocks().nth(2).locator('[data-dck-act="preview"]').click();
  await p.waitForSelector('.md-code-block:nth-of-type(3) .dck-mdprev, .dck-mdprev');
  await p.waitForTimeout(300);
  const h = await p.evaluate(() => {
    const prev = Array.from(document.querySelectorAll('.dck-mdprev')).pop();
    return { active: prev.querySelectorAll('script, img, iframe, svg, object, embed').length, handlers: Array.from(prev.querySelectorAll('*')).filter((e) => Array.from(e.attributes).some((a) => /^on/i.test(a.name))).length,
      hrefs: Array.from(prev.querySelectorAll('a')).map((a) => a.getAttribute('href')), text: prev.textContent, pwn: window.__pwn || 0 };
  });
  assert.deepStrictEqual({ active: h.active, handlers: h.handlers, hrefs: h.hrefs, pwn: h.pwn }, { active: 0, handlers: 0, hrefs: ['https://example.com/page'], pwn: 0 });
  assert.ok(h.text.indexOf('<script>') >= 0 && h.text.indexOf('[image: pixel]') >= 0, 'markup shown as text, image shown as a label');
  assert.ok(!reqs.has('evil.example'), 'no request was made for the image or anything else in the source');
  ok('hostile markdown: nothing runs, no image is fetched, only the safe link remains');

  // streaming: no Preview while writing, appears when finished; an open preview follows the text
  await p.evaluate(() => document.querySelectorAll('.md-code-block')[3].querySelectorAll('div[role=button]:not([data-dck-act])').forEach((n) => { n.removeAttribute('aria-disabled'); n.style.cssText = ''; }));
  await p.waitForSelector('.md-code-block:nth-of-type(4) [data-dck-act="preview"], [data-dck-act="preview"]');
  await p.waitForTimeout(400);
  assert.strictEqual(await hasBtn(3, 'Preview'), 1, 'Preview appears once the site finishes the block');
  await blocks().nth(3).locator('[data-dck-act="preview"]').click();
  await p.evaluate(() => { const pre = document.querySelectorAll('.md-code-block')[3].querySelector('pre'); pre.insertAdjacentHTML('beforeend', '\n<span>more text</span>'); });
  await p.waitForTimeout(500);
  assert.ok(await p.evaluate(() => document.querySelectorAll('.dck-mdprev')[document.querySelectorAll('.dck-mdprev').length - 1].textContent.indexOf('more text') >= 0), 'an open preview redraws when the block text changes');
  ok('streaming: Preview waits for the finished block; an open preview follows edits');

  // the setting
  await settingsTab(p, 'Code blocks');
  await toggle(p, 'Markdown preview');
  await p.waitForTimeout(400);
  await close(p);
  assert.strictEqual(await p.locator('[data-dck-act="preview"]').count(), 0, 'switching it off removes the buttons');
  assert.strictEqual(await p.locator('.dck-mdprev').count(), 0, 'and closes open previews');
  assert.ok(await p.evaluate(() => Array.from(document.querySelectorAll('.md-code-block pre')).every((x) => getComputedStyle(x).display !== 'none')), 'every source is visible again');
  ok('the Markdown preview setting');
  assert.deepStrictEqual(p.errs.filter((m) => !/boom/.test(m)), [], 'no page errors');
  await ctx.close();
}

// ---------- Question forms (```ask blocks)
async function askForms() {
  const SPEC = JSON.stringify({ questions: [
    { question: 'What kind of application?', options: ['Web application', 'Desktop application'] },
    { question: 'Which features?', type: 'multi', options: [{ label: 'Login', description: 'email and password' }, 'Dashboard'] },
    { question: 'Anything else?', type: 'text' },
  ] });
  const page = (mode) => `<body style="background:#151517;color:#eee;margin:0"><div style="width:700px;padding:20px">${fence('ask', SPEC)}<p id="gap">between</p>${fence('ask', '{ this is not json')}</div><div id="box" style="border-radius:20px;background:#2b2b2e;padding:16px;width:700px;margin:20px"><textarea id="main" style="width:100%"></textarea><div role="button" aria-label="Send" id="sendbtn" style="width:30px;height:30px"><svg width="12" height="12"><rect width="12" height="12"/></svg></div></div><script>window.__sent=[];window.__enter=0;var m=document.getElementById("main");m.addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){window.__enter++;if("${mode}"==="enter"){window.__sent.push(m.value);m.value="";}}});document.getElementById("sendbtn").addEventListener("click",function(){window.__sent.push(m.value);m.value="";});</script></body>`;
  const ctx = await launch(1000, 1100);
  const p = await open(ctx, page('enter'));
  const hosts = new Set();
  p.on('request', (r) => { try { hosts.add(new URL(r.url()).host); } catch (e) { /* ignore */ } });
  const card = p.locator('.dck-vis[data-kind=ask]').first();
  await card.waitFor({ timeout: 8000 });
  await p.waitForSelector('.dck-ask .dck-ask-opt');
  // "Send answers straight away" is on by default now; these first checks cover the "Add to message" mode
  await settingsTab(p, 'Questions');
  await toggle(p, 'Send answers straight away');
  await close(p);
  await p.waitForFunction(() => document.querySelector('.dck-ask-submit').textContent === 'Add to message');
  const info = await p.evaluate(() => ({
    fs: document.querySelectorAll('.dck-vis[data-kind=ask]')[0].querySelectorAll('fieldset').length,
    radios: document.querySelectorAll('.dck-vis[data-kind=ask]')[0].querySelectorAll('input[type=radio]').length,
    boxes: document.querySelectorAll('.dck-vis[data-kind=ask]')[0].querySelectorAll('input[type=checkbox]').length,
    hidden: getComputedStyle(document.querySelector('.md-code-block')).display === 'none',
    label: document.querySelector('.dck-vislabel').textContent, desc: document.querySelector('.dck-ask-optdesc').textContent,
    disabled: document.querySelector('.dck-ask-submit').disabled, submit: document.querySelector('.dck-ask-submit').textContent,
  }));
  assert.deepStrictEqual(info, { fs: 3, radios: 3, boxes: 3, hidden: true, label: 'Questions', desc: 'email and password', disabled: true, submit: 'Add to message' });
  ok('an ask block becomes a form card (source hidden, Add disabled until you answer)');

  // add to message
  const first = p.locator('.dck-vis[data-kind=ask]').first();
  const step = (name) => first.locator(name === 'Next' ? '[aria-label="Next question"]' : '[aria-label="Previous question"]').click();
  assert.strictEqual(await first.locator('.dck-ask-progress').innerText(), '1 of 3');
  assert.strictEqual(await first.locator('.dck-ask-submit').isVisible(), false, 'Add to message waits for the last question');
  await first.locator('.dck-ask-opt', { hasText: 'Web application' }).click();
  await step('Next');
  await first.locator('.dck-ask-opt', { hasText: 'Login' }).click();
  await step('Next');
  assert.strictEqual(await first.locator('.dck-ask-progress').innerText(), '3 of 3');
  await first.locator('.dck-ask-text').fill('keep it simple');
  await p.fill('#main', 'hello');
  await first.locator('.dck-ask-submit').click();
  const want = 'Here are my answers to your questions.\n\nQ1: What kind of application?\nA1: Web application\n\nQ2: Which features?\nA2: Login\n\nQ3: Anything else?\nA3: keep it simple';
  assert.strictEqual(await p.inputValue('#main'), 'hello\n\n' + want, 'answers go after what you had typed');
  assert.ok((await first.locator('.dck-ask-note').innerText()).indexOf('press Enter') >= 0);
  await step('Back');
  await first.locator('.dck-ask-opt', { hasText: 'Dashboard' }).click();
  await step('Next');
  await first.locator('.dck-ask-submit').click();
  const v2 = await p.inputValue('#main');
  assert.ok(v2.startsWith('hello\n\n') && v2.indexOf('Login, Dashboard') > 0 && v2.split('Here are my answers to your questions.').length === 2, 'answering again replaces the earlier answers: ' + JSON.stringify(v2));
  assert.strictEqual(await p.evaluate(() => window.__sent.length), 0, 'nothing is sent in this mode');
  ok('Add to message: appended after your text, and re-adding replaces instead of duplicating');

  // typing in the form never triggers the Kit or the site
  const enters = await p.evaluate(() => window.__enter);
  await first.locator('.dck-ask-text').press('Enter');
  await first.locator('.dck-ask-text').press('Enter');
  assert.strictEqual(await p.inputValue('#main'), v2, 'Enter inside the form does not touch the message box');
  assert.strictEqual(await p.evaluate(() => window.__enter), enters, 'and the site never sees it as a send');
  ok('typing inside the form never inserts context or sends');

  // sent: once the message box is emptied (Enter pressed) the card turns read-only, and survives the site redrawing it
  await p.fill('#main', '');
  await p.waitForFunction(() => /Answers sent/.test(document.querySelector('.dck-ask-note').textContent), null, { timeout: 4000 });
  assert.ok(await first.locator('input[type=radio]').first().isDisabled(), 'sent: the options are locked');
  assert.ok(await first.locator('.dck-ask-again').isVisible());
  await p.evaluate((html) => { const b = document.querySelector('.md-code-block'); b.insertAdjacentHTML('afterend', html); b.remove(); }, fence('ask', SPEC));
  await p.waitForFunction(() => { const c = document.querySelector('.dck-vis[data-kind=ask]'); return c && /Answers sent/.test(c.querySelector('.dck-ask-note').textContent); }, null, { timeout: 4000 });
  const re = p.locator('.dck-vis[data-kind=ask]').first();
  assert.ok(await re.locator('input[type=radio]').first().isDisabled(), 'a redrawn card comes back locked');
  assert.ok(await re.locator('.dck-ask-opt', { hasText: 'Web application' }).locator('input').isChecked(), 'and still shows what was sent');
  await re.locator('.dck-ask-again').click();
  assert.ok(await re.locator('input[type=radio]').first().isEnabled(), 'Answer again unlocks it');
  ok('after the answers are sent the card is read-only (even redrawn); Answer again unlocks it');

  // the broken block
  const bad = p.locator('.dck-vis[data-kind=ask]').nth(1);
  assert.ok((await bad.innerText()).indexOf('could not be shown') >= 0, 'invalid JSON says so');
  assert.ok((await bad.innerText()).indexOf('question form hit a problem') >= 0, 'in the right words');
  assert.strictEqual(await bad.locator('.dck-visactions .dck-vbtn:has-text("Code")').count(), 1, 'and offers the source');
  ok('an invalid block shows a clear message with the source one click away');

  // send straight away - context due (first message, Insert on Enter is on): the Kit adds it first, you review
  await p.click('#dck-fab'); // the Questions section is still open from the first visit
  await p.locator('#dck-drawer button:has-text("Visible")').first().click(); // Hidden is the default; this part checks the review flow
  await p.click('[role=tab]:has-text("Settings")');
  await toggle(p, 'Send answers straight away');
  await close(p);
  assert.strictEqual(await first.locator('.dck-ask-submit').innerText(), 'Send answers', 'the button says what it will do');
  await p.goto('https://chat.deepseek.com/'); // a new chat: the first message is due the built-in prompts
  await p.waitForSelector('.dck-ask .dck-ask-opt');
  const nf = p.locator('.dck-vis[data-kind=ask]').first();
  await nf.locator('.dck-ask-opt', { hasText: 'Web application' }).click();
  await nf.locator('[aria-label=\"Next question\"]').click();
  await nf.locator('[aria-label=\"Next question\"]').click();
  await nf.locator('.dck-ask-submit').click();
  await p.waitForFunction(() => /Context added|Answers sent|Could not/.test(document.querySelector('.dck-ask-note').textContent), null, { timeout: 6000 });
  const rev = await p.evaluate(() => ({ note: document.querySelector('.dck-ask-note').textContent, box: document.getElementById('main').value, sent: window.__sent.length }));
  assert.ok(/review it/.test(rev.note) && rev.box.indexOf('[Context from my notes]') >= 0 && rev.box.indexOf('Here are my answers') > 0 && rev.sent === 0, 'due context is added for review, not sent: ' + JSON.stringify(rev).slice(0, 300));
  ok('Send straight away: when context is due the Kit adds it and waits for you');

  // ... and with nothing due it goes out on Enter
  await p.goto('https://chat.deepseek.com/a/chat/s/1'); // an existing chat: nothing is due, so Enter just sends
  await p.waitForSelector('.dck-ask .dck-ask-opt');
  const f2 = p.locator('.dck-vis[data-kind=ask]').first();
  await f2.locator('.dck-ask-opt', { hasText: 'Desktop application' }).click();
  await f2.locator('[aria-label=\"Next question\"]').click();
  await f2.locator('[aria-label=\"Next question\"]').click();
  await f2.locator('.dck-ask-submit').click();
  await p.waitForFunction(() => window.__sent.length === 1, null, { timeout: 6000 });
  assert.strictEqual(await p.inputValue('#main'), '', 'the box emptied');
  assert.ok((await p.evaluate(() => window.__sent[0])).indexOf('Desktop application') > 0);
  await p.waitForFunction(() => document.querySelector('.dck-ask-note').textContent === 'Answers sent');
  assert.ok(await f2.locator('input[type=radio]').first().isDisabled(), 'the answered form is locked');
  ok('Send straight away: sent with Enter, the form shows Answers sent and locks');

  // ... and when the site ignores the Enter, the send button is used once
  await ctx.unroute('https://chat.deepseek.com/**');
  await ctx.route('https://chat.deepseek.com/**', (r) => r.fulfill({ contentType: 'text/html', body: page('ignore') }));
  await p.reload();
  await p.waitForSelector('.dck-ask .dck-ask-opt');
  const f3 = p.locator('.dck-vis[data-kind=ask]').first();
  await f3.locator('.dck-ask-opt', { hasText: 'Web application' }).click();
  await f3.locator('[aria-label=\"Next question\"]').click();
  await f3.locator('[aria-label=\"Next question\"]').click();
  await f3.locator('.dck-ask-submit').click();
  await p.waitForFunction(() => window.__sent.length === 1, null, { timeout: 8000 });
  assert.strictEqual(await p.evaluate(() => window.__sent.length), 1, 'sent exactly once');
  await p.waitForTimeout(2500);
  assert.strictEqual(await p.evaluate(() => window.__sent.length), 1, 'and never a second time');
  ok('Send straight away: falls back to the send button once when Enter is ignored');

  // the setting
  await settingsTab(p, 'Questions');
  await toggle(p, 'Draw question forms');
  await close(p);
  await p.waitForTimeout(400);
  assert.strictEqual(await p.locator('.dck-vis[data-kind=ask]').count(), 0, 'switching it off removes the forms');
  assert.ok(await p.evaluate(() => Array.from(document.querySelectorAll('.md-code-block')).every((b) => getComputedStyle(b).display !== 'none')), 'and shows the source blocks again');
  ok('the Questions setting');
  assert.deepStrictEqual(Array.from(hosts).filter((h) => h !== 'chat.deepseek.com'), [], 'no outside requests');
  await ctx.close();
}

// ---------- Lists in the message box (Shift+Enter)
async function listKeys() {
  const html = `<body style="background:#151517;color:#eee;margin:0"><div style="border-radius:20px;background:#2b2b2e;padding:16px;width:700px;margin:20px"><textarea id="main" rows="6" style="width:100%"></textarea></div><script>window.__inputs=0;window.__shiftEnter=0;window.__enter=0;var m=document.getElementById("main");m.addEventListener("input",function(){window.__inputs++});m.addEventListener("keydown",function(e){if(e.key==="Enter"&&e.shiftKey)window.__shiftEnter++;if(e.key==="Enter"&&!e.shiftKey)window.__enter++});</script></body>`;
  const ctx = await launch(1000, 700);
  const p = await open(ctx, html);
  await p.waitForSelector('#dck-fab');
  const val = () => p.inputValue('#main');
  const reset = async () => { await p.fill('#main', ''); await p.evaluate(() => { window.__shiftEnter = 0; window.__enter = 0; }); await p.click('#main'); };
  const typeLines = async (s) => { await p.keyboard.type(s); };

  // on by default: Shift+Enter continues the list
  await reset();
  await typeLines('1. one');
  await p.keyboard.press('Shift+Enter');
  assert.strictEqual(await val(), '1. one\n2. ', 'on by default');
  ok('lists: on by default');

  // switched off: Shift+Enter is the ordinary newline
  await settingsTab(p, 'Messages');
  await toggle(p, 'Continue lists with Shift+Enter');
  await close(p);
  await reset();
  await typeLines('1. one');
  await p.keyboard.press('Shift+Enter');
  assert.strictEqual(await val(), '1. one\n', 'off when switched off');
  ok('lists: switched off, Shift+Enter is the plain newline');

  await p.click('#dck-fab'); // the Messages section is still open from the first visit
  await p.click('[role=tab]:has-text("Settings")');
  await toggle(p, 'Continue lists with Shift+Enter');
  await close(p);

  // numbered list: continue, continue, then leave
  await reset();
  await typeLines('1. one');
  await p.keyboard.press('Shift+Enter');
  assert.strictEqual(await val(), '1. one\n2. ');
  assert.strictEqual(await p.evaluate(() => { const m = document.getElementById('main'); return m.selectionStart === m.value.length && m.selectionEnd === m.value.length; }), true, 'caret after the new marker');
  await typeLines('two');
  await p.keyboard.press('Shift+Enter');
  assert.strictEqual(await val(), '1. one\n2. two\n3. ');
  await p.keyboard.press('Shift+Enter');
  assert.strictEqual(await val(), '1. one\n2. two\n', 'a second press on the empty item leaves the list');
  await typeLines('after');
  assert.strictEqual(await val(), '1. one\n2. two\nafter');
  assert.strictEqual(await p.evaluate(() => window.__shiftEnter), 0, 'the site never saw those Shift+Enter presses (no double newline)');
  assert.ok(await p.evaluate(() => window.__inputs) >= 8, 'the page saw real input events');
  ok('lists: numbered list continues, and a second Shift+Enter leaves it');

  // undo works
  await reset();
  await typeLines('1. one');
  await p.keyboard.press('Shift+Enter');
  await p.keyboard.press('Control+z');
  assert.strictEqual(await val(), '1. one', 'Ctrl+Z undoes the continuation');
  ok('lists: Ctrl+Z undoes it');

  // bullets and quotes, nested indent
  for (const [start, expect] of [['- a', '- a\n- '], ['* a', '* a\n* '], ['  - nested', '  - nested\n  - '], ['> q', '> q\n> '], ['9. nine', '9. nine\n10. ']]) {
    await reset();
    await typeLines(start);
    await p.keyboard.press('Shift+Enter');
    assert.strictEqual(await val(), expect, 'continues ' + JSON.stringify(start));
  }
  ok('lists: bullets, quotes, nested lines and number rollover');

  // everything else keeps the normal behaviour
  await reset();
  await typeLines('hello');
  await p.keyboard.press('Shift+Enter');
  assert.strictEqual(await val(), 'hello\n');
  assert.strictEqual(await p.evaluate(() => window.__shiftEnter), 1, 'not a list: the site sees Shift+Enter as usual');
  await reset();
  await typeLines('```');
  await p.keyboard.press('Shift+Enter');
  await typeLines('- code');
  await p.keyboard.press('Shift+Enter');
  assert.strictEqual(await val(), '```\n- code\n', 'inside a code fence nothing is added');
  await reset();
  await typeLines('1. one two');
  for (let i = 0; i < 4; i++) await p.keyboard.press('ArrowLeft');
  await p.keyboard.press('Shift+Enter');
  assert.strictEqual(await val(), '1. one\n two', 'with the caret mid-line it is the plain newline');
  await reset();
  await typeLines('1. one');
  await p.keyboard.press('Enter');
  assert.strictEqual(await val(), '1. one\n', 'plain Enter is not touched (no list item added)');
  assert.strictEqual(await p.evaluate(() => window.__enter), 1, 'and still reaches the site');
  ok('lists: ordinary text, code fences, mid-line caret and plain Enter are untouched');

  // switching it off again (the Messages section is still open from before)
  await p.click('#dck-fab');
  await toggle(p, 'Continue lists with Shift+Enter');
  await close(p);
  await reset();
  await typeLines('1. one');
  await p.keyboard.press('Shift+Enter');
  assert.strictEqual(await val(), '1. one\n', 'off again');
  ok('lists: the setting switches it off');
  assert.deepStrictEqual(p.errs, [], 'no page errors');
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

// ---------- live reasoning timer
const thinkingHTML = fx('reasoning-thinking.html');
const TPAGE = `<!doctype html><html class="dark"><body style="background:#151517;color:#ddd;font-family:sans-serif;width:640px;padding:20px"><textarea></textarea><div id="list">
<div data-virtual-list-item-key="boot"><div class="ds-message">${thinkingHTML}</div></div></div><script>
window.errs=[]; window.addEventListener('error',e=>errs.push(e.message));
window.addThinking=(key,more)=>{ const item=document.createElement('div'); item.setAttribute('data-virtual-list-item-key',String(key)); const m=document.createElement('div'); m.className='ds-message'; m.innerHTML=${JSON.stringify(thinkingHTML)};
  if(more) m.querySelector('.ds-markdown-paragraph span').textContent='x'.repeat(300); item.append(m); document.getElementById('list').append(item); };
window.finish=(key)=>{ document.querySelector('[data-virtual-list-item-key="'+key+'"] span._5255ff8').textContent='Thought for 5 seconds'; };
</script></body></html>`;

async function thinkTimer() {
  const ctx = await launch(900, 900);
  const p = await open(ctx, TPAGE, 'https://chat.deepseek.com/a/chat/s/T');
  const results = [];
  const chk = (n, c, d) => { results.push([c, n, d || '']); };
  const T = (k) => p.evaluate((k) => { const t = document.querySelector('[data-virtual-list-item-key="' + k + '"] .dck-think-timer'); return t ? t.textContent : null; }, k);
  await p.waitForTimeout(1500);
  chk('T1 a block already thinking when the page loaded gets no clock (start unknown)', (await T('boot')) === null, String(await T('boot')));
  await p.waitForTimeout(3500); // past the first seconds after load
  await p.evaluate(() => addThinking(1)); await p.waitForTimeout(400);
  chk('T2 a block that starts thinking now gets a clock at 0s', (await T(1)) === '0s', String(await T(1)));
  chk('T3 the clock sits right after the Thinking label, not inside it', await p.evaluate(() => { const t = document.querySelector('[data-virtual-list-item-key="1"] .dck-think-timer'); return !!t && t.previousElementSibling.matches('span._5255ff8') && t.parentElement.matches('._5ab5d64'); }));
  await p.waitForTimeout(2200);
  chk('T4 it counts up in seconds', /^[23]s$/.test(await T(1)), String(await T(1)));
  chk('T5 the shimmer label is untouched', await p.evaluate(() => document.querySelector('[data-virtual-list-item-key="1"] span._5255ff8').firstChild.nodeValue === 'Thinking'));
  const look = await p.evaluate(() => { const b = document.querySelector('[data-virtual-list-item-key="1"]'); const t = getComputedStyle(b.querySelector('.dck-think-timer')), l = getComputedStyle(b.querySelector('span._5255ff8')); return { same: t.color === l.color && t.fontSize === l.fontSize, opacity: t.opacity }; });
  chk('T5b the clock has the label\'s size and colour, fully opaque', look.same && look.opacity === '1', JSON.stringify(look));
  await p.evaluate(() => document.documentElement.setAttribute('data-dck-fold', '')); await p.waitForTimeout(200);
  const folded = await p.evaluate(() => { const t = document.querySelector('[data-virtual-list-item-key="1"] .dck-think-timer'); const r = t.getBoundingClientRect(); const body = document.querySelector('[data-virtual-list-item-key="1"] .ds-think-content'); return { w: r.width, h: r.height, bodyH: body.getBoundingClientRect().height }; });
  chk('T6 the clock stays visible while the block is folded', folded.w > 0 && folded.h > 0 && folded.bodyH === 0, JSON.stringify(folded));
  await p.evaluate(() => document.documentElement.removeAttribute('data-dck-fold'));
  await p.evaluate(() => finish(1)); await p.waitForTimeout(300);
  chk('T7 the clock is gone once the site says "Thought for N seconds"', (await T(1)) === null, String(await T(1)));
  await p.evaluate(() => addThinking(2, true)); await p.waitForTimeout(1500);
  chk('T8 a block that already holds lots of text when first seen gets no clock', (await T(2)) === null, String(await T(2)));
  chk('T9 no page errors', p.errs.length === 0 && (await p.evaluate(() => errs.length)) === 0, JSON.stringify(p.errs));

  const bad = results.filter((r) => !r[0]);
  results.forEach((r) => console.log((r[0] ? 'ok  ' : 'FAIL') + ' reasoning timer ' + r[1] + (r[0] ? '' : ' | ' + r[2])));
  await ctx.close();
  assert.strictEqual(bad.length, 0, bad.length + ' timer check(s) failed');
}

// ---------- two tabs: a save in one tab must not be overwritten by a tab that was opened earlier
async function twoTabs() {
  const ctx = await launch(1000, 900);
  const PAGE = '<body><textarea></textarea></body>';
  const memTab = (p) => p.locator('[role=tab]:has-text("Memory")');
  const B = await open(ctx, PAGE); // opened first, so it holds the older copy of the notes
  const A = await open(ctx, PAGE);
  await A.click('#dck-fab');
  await memTab(A).click();
  await A.fill('[aria-label="New note key"]', 'my city');
  await A.fill('[aria-label="New note value"]', 'Sample City');
  await A.locator('.dck-btn.primary:has-text("Add")').click();
  await B.waitForFunction(() => { const t = Array.from(document.querySelectorAll('[role=tab]')).find((x) => x.textContent.indexOf('Memory') === 0); return !!t && /1$/.test(t.textContent); }, null, { timeout: 3000 });
  ok('a note added in one tab shows up in the other without a reload');
  const sw = 'input[aria-label="Enable DeepSeek Kit"]';
  await B.evaluate((s) => { document.querySelector(s).click(); document.querySelector(s).click(); }, sw); // a save from the tab that was open earlier
  await B.waitForTimeout(300);
  const C = await open(ctx, PAGE);
  const txt = (await memTab(C).textContent()).trim();
  assert.ok(/1$/.test(txt), 'the note was lost after the other tab saved (tab shows "' + txt + '")');
  assert.ok(await C.locator(sw).isChecked(), 'switch state');
  ok('a save in the older tab does not erase the new note');
  await ctx.close();
}

// ---------- a new profile has no snippets: the slash picker stays closed
async function noStarters() {
  const ctx = await launch(1000, 900);
  const p = await open(ctx, '<body><textarea></textarea></body>');
  const ta = p.locator('textarea');
  await ta.click();
  await p.keyboard.type('/');
  await p.waitForTimeout(300);
  assert.strictEqual(await p.locator('#dck-picker .dck-pick').count(), 0);
  ok('a new profile has no starter snippets after /');
  await ctx.close();
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
    await mdPreview();
    await askForms();
    await listKeys();
    await fold();
    await thinkTimer();
    await twoTabs();
    await noStarters();
  } catch (e) {
    if (/Executable doesn't exist|browserType.launch/.test(e.message)) { console.log('skip  e2e (Chromium is not installed)'); process.exit(0); }
    console.error('FAIL:', e.stack || e.message);
    process.exit(1);
  }
  console.log('\nall e2e tests passed');
  process.exit(0);
})();
