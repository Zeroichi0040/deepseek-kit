const { JSDOM } = require('jsdom');
const fs = require('fs');
const assert = require('assert');

const ROOT = require('path').join(__dirname, '..');
const read = (f) => fs.readFileSync(require('path').join(ROOT, f), 'utf8');
const src = read('content.js');
const site = read('site.js');
const visSrc = read('visuals.js') + '\n' + read('markdown.js') + '\n' + read('ask.js');
const lib = read('lib.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(stored, memories) {
  const dom = new JSDOM(
    '<!doctype html><body><div id="chat"></div><div id="composer"><textarea></textarea><div role="button" id="attach"><svg></svg></div><div role="button" id="send"><svg></svg></div></div></body>',
    { url: 'https://chat.deepseek.com/', runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const w = dom.window;
  const saved = {};
  w.chrome = {
    storage: {
      local: {
        get: (keys, cb) => cb({ dck_settings: stored, dck_memories: memories || [] }),
        set: (o) => Object.assign(saved, o),
      },
    },
  };
  w.confirm = () => true;
  w.eval(lib);
  w.eval(site);
  w.eval(visSrc);
  w.eval(src);
  await sleep(60);
  const doc = w.document;
  const drawer = doc.getElementById('dck-drawer');
  const api = {
    w, doc, saved, drawer, ta: doc.querySelector('#composer textarea'),
    text: () => drawer.textContent,
    btn: (label) => Array.from(drawer.querySelectorAll('button')).find((b) => b.textContent.trim() === label || b.getAttribute('aria-label') === label),
    tab: (label) => Array.from(drawer.querySelectorAll('[role=tab]')).find((b) => b.textContent.trim().startsWith(label)),
    toggle: (label) => {
      const cb = Array.from(drawer.querySelectorAll('input[type=checkbox]')).find((i) => i.getAttribute('aria-label') === label);
      assert.ok(cb, 'toggle not found: ' + label);
      cb.click();
    },
    type: (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new w.Event('input', { bubbles: true }));
    },
    key: (target, k, extra) => {
      const ev = new w.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, extra || {}));
      target.dispatchEvent(ev);
      return ev;
    },
  };
  return api;
}

(async () => {
  // ---------- 1. Legacy settings are migrated; drawer shell ----------
  {
    const a = await boot({ systemPrompt: 'Answer in French', mode: 'first', multiPrompt: false });
    assert.ok(a.saved.dck_settings && !('systemPrompt' in a.saved.dck_settings), 'migrated shape written back');
    assert.strictEqual(a.saved.dck_settings.prompts[0].text, 'Answer in French');
    a.doc.getElementById('dck-fab').click();
    assert.ok(a.drawer.classList.contains('open'));
    const t = a.text();
    ['DeepSeek Kit', 'Context in chat', 'Visible', 'Hidden', 'Prompts', 'Memory', 'Snippets', 'Settings', 'Built-in', 'Yours', 'Custom prompt', 'New prompt', 'Insert now', 'Preview'].forEach((s) => assert.ok(t.includes(s), 'drawer shows ' + s));
    assert.ok(a.tab('Prompts').getAttribute('aria-selected') === 'true');
    assert.ok(!t.includes('Multi-system'), 'multi-prompt switch is gone');
    console.log('ok  migration + drawer shell');
  }

  // ---------- 2. Summary strip + chips follow the composer ----------
  {
    const a = await boot({}, [{ key: 'my name', value: 'Ana', importance: 'always' }, { key: 'favorite editor', value: 'vim', importance: 'called' }]);
    const strip = a.doc.getElementById('dck-strip');
    assert.ok(strip.textContent.includes('Next message includes') && strip.textContent.includes('Default') && strip.textContent.includes('1 memory'), strip.textContent);
    assert.ok(/~\d+ tokens/.test(strip.textContent));
    a.type(a.ta, 'which editor is best');
    assert.ok(strip.textContent.includes('2 memories'), 'strip updates while typing: ' + strip.textContent);
    const chips = a.doc.getElementById('dck-chips');
    assert.ok(chips, 'chips element exists');
    assert.ok(chips.textContent.includes('Kit') && chips.textContent.includes('Default') && chips.textContent.includes('2 memories') && chips.textContent.includes('Hidden'), chips.textContent);
    // tab badges
    assert.ok(a.tab('Memory').textContent.includes('2'));
    console.log('ok  summary strip + chips');
  }

  // ---------- 3. Visible/Hidden switch + settings tab ----------
  {
    const a = await boot({ showInjected: true }); // Hidden is the default now; start from Visible to test the switch both ways
    assert.strictEqual(a.btn('Visible').getAttribute('aria-pressed'), 'true');
    a.btn('Edit Default prompt').click();
    const draft = a.drawer.querySelector('textarea[aria-label="Prompt text"]');
    draft.value = 'unsaved draft';
    a.btn('Hidden').click();
    assert.strictEqual(a.drawer.querySelector('textarea[aria-label="Prompt text"]').value, 'unsaved draft', 'switching visibility keeps an open editor');
    a.btn('Cancel').click();
    assert.strictEqual(a.saved.dck_settings.showInjected, false, 'hidden persisted');
    assert.strictEqual(a.btn('Hidden').getAttribute('aria-pressed'), 'true');
    assert.ok(a.doc.getElementById('dck-chips').textContent.includes('Hidden'), 'chip note shows Hidden');
    a.btn('Visible').click();
    assert.strictEqual(a.saved.dck_settings.showInjected, true);

    a.tab('Settings').click();
    const acc = (t) => Array.from(a.drawer.querySelectorAll('.dck-acchead')).find((b) => b.querySelector('.dck-name').textContent === t);
    ['Messages', 'Code blocks', 'Variables', 'Diagnostics', 'Backup', 'Reset all'].forEach((t) => assert.ok(a.text().includes(t), 'settings has ' + t));
    assert.ok(!a.text().includes('Next-message summary'), 'every section starts closed');
    acc('Messages').click();
    ['Insert context on Enter', 'Next-message summary', 'Collapse reasoning', 'Chips in the toolbar', 'Send answers straight away'].forEach((t) => assert.ok(a.text().includes(t), 'messages has ' + t));
    acc('Messages').click();
    assert.ok(!a.text().includes('{{date}}'), 'variables are collapsed at first');
    acc('Variables').click();
    assert.ok(a.text().includes('{{date}}') && a.text().includes('{{selection}}') && !a.text().includes('Next-message summary'), 'only one section is open');
    acc('Backup').click();
    assert.ok(a.text().includes('Export') && a.text().includes('Import'));
    acc('Code blocks').click();
    a.toggle('Collapse long blocks');
    assert.strictEqual(a.saved.dck_settings.collapseLong, false, 'on for a new install, so the first click turns it off');
    a.toggle('Collapse long blocks');
    assert.strictEqual(a.saved.dck_settings.collapseLong, true);
    acc('Messages').click();
    a.toggle('Next-message summary');
    assert.strictEqual(a.saved.dck_settings.showSummary, false);
    assert.strictEqual(a.doc.getElementById('dck-strip').style.display, 'none', 'strip hidden');
    a.toggle('Chips in the toolbar');
    assert.strictEqual(a.saved.dck_settings.showChips, false);
    assert.strictEqual(a.doc.getElementById('dck-chips').style.display, 'none');
    assert.ok(!a.doc.documentElement.hasAttribute('data-dck-fold'), 'fold is off by default');
    a.toggle('Collapse reasoning');
    assert.strictEqual(a.saved.dck_settings.collapseThinking, true);
    assert.ok(a.doc.documentElement.hasAttribute('data-dck-fold'), 'fold attribute set on <html>');
    a.toggle('Collapse reasoning');
    assert.ok(!a.doc.documentElement.hasAttribute('data-dck-fold'), 'fold attribute removed again');
    a.toggle('Insert context on Enter');
    assert.strictEqual(a.saved.dck_settings.autoInsertOnEnter, false);
    // Reset all
    a.btn('Reset all').click();
    assert.strictEqual(a.saved.dck_settings.showSummary, true, 'reset restored defaults');
    assert.strictEqual(a.saved.dck_settings.snippets.length, 0, 'reset leaves no snippets');
    assert.strictEqual(a.saved.dck_memories.length, 0, 'and no notes');
    console.log('ok  visibility switch + settings + reset');
  }

  // ---------- 3b. No starter content: a new install is empty, and the old seeded flag is dropped ----------
  {
    const a = await boot(undefined); // nothing stored: a new install
    assert.strictEqual(a.saved.dck_settings, undefined, 'nothing is written on first run');
    assert.ok(!/\d/.test(a.tab('Snippets').textContent) && !/\d/.test(a.tab('Memory').textContent), 'no snippets, no notes');
    a.tab('Settings').click();
    Array.from(a.drawer.querySelectorAll('.dck-acchead')).find((x) => x.querySelector('.dck-name').textContent === 'Backup').click();
    assert.ok(!a.text().includes('Starter content'), 'no Starter content button');
    // an install that has the old flag and its own snippet keeps the snippet, loses the flag
    const c = await boot({ starterSeeded: true, snippets: [{ id: 's1', name: 'summarize', text: 'mine' }] });
    assert.ok(c.tab('Snippets').textContent.includes('1'), 'own snippet kept');
    assert.ok(!('starterSeeded' in c.saved.dck_settings), 'old flag removed');
    console.log('ok  no starter content');
  }

  // ---------- 3c. Diagnostics: problems first, the rest folded ----------
  {
    const a = await boot({});
    a.tab('Settings').click();
    Array.from(a.drawer.querySelectorAll('.dck-acchead')).find((x) => x.querySelector('.dck-name').textContent === 'Diagnostics').click();
    assert.ok(a.drawer.querySelector('.dck-diagsum') || a.drawer.querySelector('.dck-diagdot.bad'), 'a green verdict, or the failed checks themselves');
    assert.strictEqual(a.drawer.querySelectorAll('.dck-diagtoggle').length, 2);
    assert.strictEqual(a.drawer.querySelectorAll('.dck-diagrow.compact').length, 0, 'OK rows start folded');
    assert.ok(!a.text().includes('Reasoning blocks'), 'the OK rows are not listed until asked for');
    a.drawer.querySelectorAll('.dck-diagtoggle')[0].click();
    assert.ok(a.drawer.querySelectorAll('.dck-diagrow.compact').length >= 8, 'all checks open on request');
    assert.ok(a.text().includes('Reasoning blocks') && a.text().includes('Stored data'));
    a.drawer.querySelectorAll('.dck-diagtoggle')[1].click();
    assert.ok(a.text().includes('Nothing yet this session') || a.drawer.querySelectorAll('.dck-diagevent').length > 0, 'events open on request');
    assert.ok(a.btn('Copy report') && a.btn('Refresh'));
    console.log('ok  compact Diagnostics');
  }

  // ---------- 3d. Settings categories: non-interactive headings group the accordions ----------
  {
    const a = await boot({});
    a.tab('Settings').click();
    const body = () => a.drawer.querySelector('.dck-body');
    // The top level of the Settings body, in order: headings and accordions as [kind, label]
    const layout = () => Array.from(body().children).map((el) => {
      if (el.classList.contains('dck-group')) return ['group', el.textContent];
      if (el.classList.contains('dck-acc')) return ['acc', el.querySelector('.dck-acchead .dck-name').textContent];
      return ['other', el.className];
    });
    const EXPECTED = [
      ['group', 'Chat Behavior'], ['acc', 'Messages'],
      ['group', 'Response Display'], ['acc', 'Code blocks'], ['acc', 'Visuals'],
      ['group', 'Tools & Maintenance'], ['acc', 'Variables'], ['acc', 'Diagnostics'], ['acc', 'Backup'],
    ];
    const head = (t) => Array.from(a.drawer.querySelectorAll('.dck-acchead')).find((b) => b.querySelector('.dck-name').textContent === t);
    const openNames = () => Array.from(a.drawer.querySelectorAll('.dck-acc.open')).map((el) => el.querySelector('.dck-name').textContent);
    const expandedCount = () => a.drawer.querySelectorAll('.dck-acchead[aria-expanded="true"]').length;
    const headings = () => Array.from(body().querySelectorAll('.dck-group'));

    // all three headings appear, each accordion sits under the right one, in the intended order
    assert.deepStrictEqual(layout(), EXPECTED, 'category layout: ' + JSON.stringify(layout()));
    assert.strictEqual(body().firstElementChild.textContent, 'Chat Behavior', 'the first heading leads the list, so .dck-group:first-child drops its top margin');
    assert.strictEqual(headings().length, 3);
    assert.strictEqual(openNames().length, 0, 'every section still starts closed');

    // headings are plain labels: not buttons, links, inputs or focus targets, and carry no state
    headings().forEach((hd) => {
      assert.strictEqual(hd.tagName, 'DIV', hd.textContent + ' is a plain div');
      assert.strictEqual(hd.children.length, 0, hd.textContent + ' holds text only');
      ['tabindex', 'role', 'aria-expanded', 'aria-pressed', 'aria-controls', 'onclick'].forEach((attr) => assert.ok(!hd.hasAttribute(attr), hd.textContent + ' has no ' + attr));
      assert.ok(!hd.closest('button, a, input, [role=button]'), hd.textContent + ' is not inside a control');
    });
    assert.strictEqual(body().querySelectorAll('.dck-group button, .dck-group a, .dck-group input, .dck-group [tabindex]').length, 0, 'no controls inside headings');

    // clicking or pressing keys on a heading does nothing: no re-render, no accordion change, nothing saved
    const nodes = headings();
    const savedBefore = JSON.stringify(a.saved);
    nodes.forEach((hd) => { hd.click(); a.key(hd, 'Enter'); a.key(hd, ' '); });
    assert.ok(nodes.every((el) => el.isConnected), 'headings are not re-rendered by clicks');
    assert.strictEqual(openNames().length, 0, 'clicking a heading opens nothing');
    assert.strictEqual(JSON.stringify(a.saved), savedBefore, 'clicking a heading saves nothing');
    head('Messages').click();
    headings().forEach((hd) => hd.click());
    assert.deepStrictEqual(openNames(), ['Messages'], 'clicking a heading does not close the open section');
    head('Messages').click();

    // opening one accordion closes the previous one, across all three categories, and the layout holds
    ['Messages', 'Code blocks', 'Visuals', 'Variables', 'Diagnostics', 'Backup'].forEach((t) => {
      head(t).click();
      assert.deepStrictEqual(openNames(), [t], 'only ' + t + ' is open');
      assert.strictEqual(expandedCount(), 1, 'one aria-expanded=true while ' + t + ' is open');
      assert.strictEqual(head(t).getAttribute('aria-expanded'), 'true');
      assert.deepStrictEqual(layout(), EXPECTED, 'headings stay in place while ' + t + ' is open');
    });
    head('Messages').click();
    assert.deepStrictEqual(openNames(), ['Messages'], 'jumping back to the first section closes Backup');
    head('Messages').click();
    assert.strictEqual(openNames().length, 0, 'clicking the open section closes it');
    assert.strictEqual(expandedCount(), 0);

    // there is no Questions section: its one remaining switch lives under Messages, and the other two are gone
    assert.ok(!head('Questions'), 'no Questions section');
    head('Messages').click();
    assert.ok(a.text().includes('Send answers straight away') && !a.text().includes('Draw question forms') && !a.text().includes('Ask the model for them'), 'Messages content');
    a.toggle('Send answers straight away');
    assert.strictEqual(a.saved.dck_settings.askAutoSend, false);
    assert.ok(!('askEnabled' in a.saved.dck_settings), 'no askEnabled setting is stored');
    // the sections themselves still work: Visuals opens and saves
    head('Visuals').click();
    assert.ok(a.text().includes('Draw charts and widgets') && !a.text().includes('Send answers straight away'), 'Visuals content, Messages closed');
    a.toggle('Draw charts and widgets');
    assert.strictEqual(a.saved.dck_settings.visualsEnabled, false);
    assert.deepStrictEqual(layout(), EXPECTED, 'layout survives saving a setting');
    console.log('ok  Settings categories');
  }

  // ---------- 3e. Settings information icons: descriptions on demand, one panel at a time ----------
  {
    const a = await boot({});
    a.tab('Settings').click();
    const head = (t) => Array.from(a.drawer.querySelectorAll('.dck-acchead')).find((b) => b.querySelector('.dck-name').textContent === t);
    const rowOf = (t) => Array.from(a.drawer.querySelectorAll('.dck-setrow')).find((r) => r.querySelector('.dck-name span, .dck-name').textContent.startsWith(t));
    const info = (t) => rowOf(t).querySelector('.dck-infobtn');
    const panel = (t) => rowOf(t).querySelector('.dck-help');
    const openPanels = () => Array.from(a.drawer.querySelectorAll('.dck-help')).filter((el) => !el.hidden);
    const SPEC = {
      Messages: {
        'Insert context on Enter': 'When enabled, Kit automatically adds scheduled prompts and eligible memory to your message when you send it. When disabled, use Insert now to add context manually.',
        'Next-message summary': 'Shows which prompts and memories are scheduled to be included in your next message. This is not a summary of your conversation.',
        'Collapse reasoning': "Folds DeepSeek's reasoning content to its header while it is generating and after it finishes. Click the header to expand it.",
        'Chips in the toolbar': 'Displays which prompts and memories are due for your next message, along with whether context is Visible or Hidden, beside DeepThink and Search.',
        'Send answers straight away': 'When enabled, submitting a question form sends your answers immediately. When disabled, answers are inserted into the message box for you to review and send.',
      },
      'Code blocks': {
        'Code block tools': 'Adds Collapse/Expand and + ZIP controls to code block headers.',
        'Always collapse': 'Collapses every code block of more than 3 lines, whatever its length. Individual blocks can still be expanded. While on, Collapse long blocks does not apply.',
        'Collapse long blocks': 'Automatically collapses code blocks exceeding 20 lines. Individual blocks can still be expanded.',
      },
      Visuals: {
        'Draw charts and widgets': 'Renders chart and viz code blocks as inline cards. Widgets execute generated code in an isolated iframe, but can navigate that frame. Treat generated widget code as untrusted.',
      },
    };
    const NO_INFO = {
      Messages: ['Continue lists with Shift+Enter'],
      'Code blocks': ['Line numbers', 'Markdown preview', 'Lines before collapsing'],
      Visuals: ['Ask the model for visuals'],
    };

    for (const section of Object.keys(SPEC)) {
      head(section).click();
      const rows = Array.from(a.drawer.querySelectorAll('.dck-accbody .dck-setrow'));
      // 1 + 2: no permanent description on toggle rows; icons only on the specified settings
      rows.forEach((r) => assert.strictEqual(r.querySelectorAll('.dck-sub').length, section === 'Messages' && r.textContent.includes('Kit button position') ? 1 : 0, 'no permanent description in ' + r.textContent));
      assert.strictEqual(a.drawer.querySelectorAll('.dck-accbody .dck-infobtn').length, Object.keys(SPEC[section]).length, section + ': icon count');
      NO_INFO[section].forEach((t) => assert.ok(rowOf(t) && !rowOf(t).querySelector('.dck-infobtn'), t + ' has no info icon'));
      assert.strictEqual(openPanels().length, 0, 'every panel starts closed');
      // 3: each icon shows its own text, as a proper accessible disclosure button
      Object.entries(SPEC[section]).forEach(([t, text]) => {
        const b = info(t);
        assert.strictEqual(b.tagName, 'BUTTON');
        assert.strictEqual(b.type, 'button');
        assert.strictEqual(b.getAttribute('aria-label'), 'About ' + t);
        assert.strictEqual(b.getAttribute('aria-expanded'), 'false');
        assert.strictEqual(b.getAttribute('aria-controls'), panel(t).id);
        assert.ok(a.doc.querySelectorAll('#' + panel(t).id).length === 1, 'panel id is unique');
        assert.ok(!rowOf(t).querySelector('.dck-switch').contains(b), 'icon sits outside the switch label');
        assert.ok(panel(t).hidden, 'panel takes no space while collapsed');
        const before = JSON.stringify(a.saved);
        const cb = rowOf(t).querySelector('input[type=checkbox]');
        const checkedBefore = cb.checked;
        b.click();
        assert.strictEqual(b.getAttribute('aria-expanded'), 'true');
        assert.ok(!panel(t).hidden, 'panel opens');
        assert.strictEqual(panel(t).textContent, text, t + ' text');
        assert.strictEqual(cb.checked, checkedBefore, 'icon click does not flip the switch');
        assert.strictEqual(JSON.stringify(a.saved), before, 'opening help writes nothing to storage');
        assert.strictEqual(openPanels().length, 1);
        b.click();
        assert.strictEqual(b.getAttribute('aria-expanded'), 'false');
        assert.ok(panel(t).hidden, 'same icon closes it');
        assert.strictEqual(JSON.stringify(a.saved), before, 'closing help writes nothing either');
      });
      head(section).click();
    }

    // 5: only one panel at a time (within and across sections)
    head('Messages').click();
    info('Insert context on Enter').click();
    info('Collapse reasoning').click();
    assert.strictEqual(openPanels().length, 1, 'opening a second closes the first');
    assert.ok(panel('Collapse reasoning') && !panel('Collapse reasoning').hidden && panel('Insert context on Enter').hidden);
    assert.strictEqual(info('Insert context on Enter').getAttribute('aria-expanded'), 'false');
    // the open panel is kept when the drawer re-renders; switching section clears it
    a.tab('Prompts').click(); a.tab('Settings').click();
    head('Code blocks').click();
    assert.strictEqual(openPanels().length, 0, 'switching section leaves nothing open');
    info('Collapse long blocks').click();
    // 4/8: switches work on their own, help state unaffected, and the dynamic threshold follows the setting
    a.toggle('Collapse long blocks');
    assert.strictEqual(a.saved.dck_settings.collapseLong, false);
    assert.ok(!panel('Collapse long blocks').hidden, 'toggling the switch leaves the panel as it was');
    const lnBefore = rowOf('Line numbers').querySelector('input').checked;
    a.toggle('Line numbers');
    assert.strictEqual(a.saved.dck_settings.lineNumbers, !lnBefore, 'a switch still flips its own setting');
    head('Code blocks').click();

    // 9: grouping untouched; the Kit button row keeps its short description
    head('Messages').click();
    assert.strictEqual(rowOf('Kit button position').querySelector('.dck-sub').textContent, 'Drag the button to move it; it docks to the nearest side');
    assert.ok(!rowOf('Kit button position').querySelector('.dck-infobtn'));
    head('Messages').click();

    // 6/10: stylesheet defines readable, understated help panels from the theme variables, in both schemes
    const css = read('content.css');
    assert.ok(/\.dck-help\s*\{[^}]*color:\s*var\(--k-soft\)[^}]*background:\s*var\(--k-bg\)/.test(css) || /\.dck-help\s*\{[^}]*background:\s*var\(--k-bg\)[^}]*color:\s*var\(--k-soft\)/.test(css), 'help panel colours come from theme variables');
    assert.ok(/\.dck-help\[hidden\]\s*\{\s*display:\s*none/.test(css), 'collapsed panels take no space');
    assert.ok(/prefers-color-scheme: light[\s\S]*--k-bg:[\s\S]*--k-soft:/.test(css), 'light theme redefines the variables the panel uses');
    assert.ok(/\.dck-infobtn:focus-visible/.test(css), 'icon has a focus style');
    console.log('ok  Settings information icons');
  }

  // ---------- 3g. A profile whose only obsolete key is askEnabled is cleaned in storage at load ----------
  {
    const a = await boot({ askEnabled: false, showSummary: false });
    assert.ok(a.saved.dck_settings, 'the migrated settings are written back without any other change');
    assert.ok(!('askEnabled' in a.saved.dck_settings), 'askEnabled is gone from what was stored');
    assert.strictEqual(a.saved.dck_settings.showSummary, false, 'the person\'s other settings are kept');
    const b = await boot({ askEnabled: false });
    assert.ok(b.saved.dck_settings && !('askEnabled' in b.saved.dck_settings), 'askEnabled alone is enough to trigger the write');
    const c = await boot({ showSummary: false });
    assert.ok(!c.saved.dck_settings, 'a profile with nothing obsolete is not rewritten at load');
    console.log('ok  askEnabled migration is persisted');
  }

  // ---------- 3f. Always collapse: greys out Collapse long blocks; the line limit is editable in the drawer ----------
  {
    const a = await boot({});
    a.tab('Settings').click();
    const head = (t) => Array.from(a.drawer.querySelectorAll('.dck-acchead')).find((b) => b.querySelector('.dck-name').textContent === t);
    head('Code blocks').click();
    const rowOf = (t) => Array.from(a.drawer.querySelectorAll('.dck-setrow')).find((r) => r.querySelector('.dck-name').textContent.startsWith(t));
    const cb = (t) => rowOf(t).querySelector('input[type=checkbox]');
    const lines = () => a.drawer.querySelector('input[aria-label="Lines before a block collapses"]');
    const setLines = (v) => { lines().value = v; lines().dispatchEvent(new a.w.Event('change', { bubbles: true })); };
    const order = Array.from(a.drawer.querySelectorAll('.dck-accbody .dck-setrow')).map((r) => r.querySelector('.dck-name').textContent);
    assert.ok(order.indexOf('Always collapse') >= 0 && order.indexOf('Always collapse') < order.indexOf('Collapse long blocks') && order.indexOf('Collapse long blocks') < order.indexOf('Lines before collapsing'), 'order: Always collapse, Collapse long blocks, then its line limit');

    // idle state: Collapse long blocks is on and usable, the limit shows 20 and can be edited
    assert.ok(!cb('Collapse long blocks').disabled && !rowOf('Collapse long blocks').classList.contains('dck-disabled'), 'usable at first');
    assert.ok(!lines().disabled && lines().value === '20', 'limit shows the default of 20');
    setLines('35');
    assert.strictEqual(a.saved.dck_settings.collapseLines, 35, 'the limit is saved');
    assert.strictEqual(lines().value, '35');
    setLines('1');
    assert.strictEqual(a.saved.dck_settings.collapseLines, 3, 'the limit never goes below 3 (shorter blocks have no collapse control)');
    assert.strictEqual(lines().value, '3');
    setLines('abc');
    assert.strictEqual(a.saved.dck_settings.collapseLines, 20, 'junk falls back to the default');
    setLines('12');

    // Always collapse on: Collapse long blocks and the limit grey out, without losing their values
    a.toggle('Always collapse');
    assert.strictEqual(a.saved.dck_settings.collapseAlways, true);
    assert.ok(cb('Collapse long blocks').disabled && rowOf('Collapse long blocks').classList.contains('dck-disabled'), 'Collapse long blocks is greyed out');
    assert.ok(lines().disabled && rowOf('Lines before collapsing').classList.contains('dck-disabled'), 'the limit is greyed out too');
    assert.strictEqual(a.saved.dck_settings.collapseLong, true, 'its own setting is left alone');
    assert.strictEqual(a.saved.dck_settings.collapseLines, 12, 'and so is the limit');
    assert.ok(!cb('Always collapse').disabled, 'Always collapse itself stays usable');

    // the state survives a re-render of the drawer
    a.tab('Prompts').click(); a.tab('Settings').click();
    assert.ok(cb('Collapse long blocks').disabled && lines().disabled, 'still greyed after re-render');

    // Always collapse off: everything is usable again
    a.toggle('Always collapse');
    assert.strictEqual(a.saved.dck_settings.collapseAlways, false);
    assert.ok(!cb('Collapse long blocks').disabled && !lines().disabled && !rowOf('Collapse long blocks').classList.contains('dck-disabled'), 'usable again');

    // with Collapse long blocks itself off, the limit has nothing to do and greys out
    a.toggle('Collapse long blocks');
    assert.strictEqual(a.saved.dck_settings.collapseLong, false);
    assert.ok(lines().disabled, 'the limit is idle while Collapse long blocks is off');
    a.toggle('Collapse long blocks');
    assert.ok(!lines().disabled, 'and live again when it is back on');
    console.log('ok  Always collapse + editable line limit');
  }

  // ---------- 4. Prompts tab: edit, new, delete, default ----------
  {
    const a = await boot({ prompts: [{ id: 'p1', name: 'Concise tone', text: 'Be brief', enabled: true, schedule: 'every', everyN: 5 }] });
    assert.ok(a.text().includes('Every 5 messages') && a.text().includes('First message'));
    // toggle a prompt off -> strip drops it
    a.toggle('Enable Concise tone prompt');
    assert.strictEqual(a.saved.dck_settings.prompts[0].enabled, false);
    assert.ok(!a.doc.getElementById('dck-strip').textContent.includes('Concise tone'), 'strip drops disabled prompt');
    a.toggle('Enable Concise tone prompt');
    // edit
    a.btn('Edit Concise tone prompt').click();
    const ta = a.drawer.querySelector('textarea[aria-label="Prompt text"]');
    assert.ok(ta && ta.value === 'Be brief');
    // variable chip inserts at the caret
    ta.focus(); ta.setSelectionRange(2, 2);
    Array.from(a.drawer.querySelectorAll('.dck-vchip')).find((b) => b.textContent === '{{date}}').click();
    assert.strictEqual(ta.value, 'Be{{date}} brief');
    ta.value = 'Be very brief';
    a.drawer.querySelector('input[aria-label="Prompt name"]').value = 'Short';
    a.btn('Save').click();
    assert.strictEqual(a.saved.dck_settings.prompts[0].name, 'Short');
    assert.strictEqual(a.saved.dck_settings.prompts[0].text, 'Be very brief');
    // new prompt, then delete it
    a.btn('New prompt').click();
    assert.strictEqual(a.saved.dck_settings.prompts.length, 2);
    a.btn('Delete').click();
    assert.strictEqual(a.saved.dck_settings.prompts.length, 1);
    // built-in default: edit then reset
    a.btn('Edit Default prompt').click();
    const dta = a.drawer.querySelector('textarea[aria-label="Prompt text"]');
    assert.ok(dta.value.includes('honesty and safety'));
    dta.value = 'My default';
    a.btn('Save').click();
    assert.strictEqual(a.saved.dck_settings.defaultText, 'My default');
    assert.ok(a.text().includes('Customized'));
    a.btn('Edit Default prompt').click();
    a.btn('Reset to built-in').click();
    assert.strictEqual(a.saved.dck_settings.defaultText, '');
    assert.ok(a.text().includes('Built-in'));
    console.log('ok  prompts tab');
  }

  // ---------- 5. Memory tab ----------
  {
    const a = await boot({});
    a.tab('Memory').click();
    assert.ok(a.text().includes('Use memory') && a.text().includes('No notes yet') && a.text().includes('Token budget'));
    const q = (sel) => a.drawer.querySelector(sel);
    a.btn('Add').click();
    assert.strictEqual((a.saved.dck_memories || []).length, 0, 'empty add is rejected');
    q('input[aria-label="New note key"]').value = 'my city';
    q('input[aria-label="New note value"]').value = 'Sample City';
    q('input[aria-label="New note category"]').value = 'About me';
    q('select[aria-label="New note: when to include"]').value = 'called';
    a.btn('Add').click();
    assert.strictEqual(JSON.stringify(a.saved.dck_memories), JSON.stringify([{ key: 'my city', value: 'Sample City', importance: 'called', category: 'About me', enabled: true }]));
    assert.ok(a.text().includes('my city') && a.text().includes('About me') && a.text().includes('Included when mentioned'));
    assert.ok(a.text().includes('Not mentioned'), 'status idle: ' + a.text());
    // live status follows the message box
    const ta = a.w.document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(a.w.HTMLTextAreaElement.prototype, 'value').set.call(ta, 'what is the weather in my city');
    ta.dispatchEvent(new a.w.Event('input', { bubbles: true }));
    await sleep(80);
    assert.ok(a.text().includes('In next message'), 'status included: ' + a.text());
    // per-note switch
    q('[aria-label="Enable my city"]').click();
    assert.strictEqual(a.saved.dck_memories[0].enabled, false);
    q('[aria-label="Enable my city"]').click();
    // edit in place
    a.btn('Edit my city').click();
    q('input[aria-label=Key]').value = 'home city';
    q('textarea[aria-label=Value]').value = 'Example City';
    q('select[aria-label="When to include"]').value = 'always';
    a.btn('Save').click();
    const m0 = a.saved.dck_memories[0];
    assert.ok(m0.key === 'home city' && m0.value === 'Example City' && m0.importance === 'always' && m0.category === 'About me', JSON.stringify(m0));
    // budget
    const bud = q('input[aria-label="Memory token budget"]');
    bud.value = '300'; bud.dispatchEvent(new a.w.Event('change', { bubbles: true }));
    assert.strictEqual(a.saved.dck_settings.memoryBudget, 300);
    a.toggle('Use memory');
    assert.strictEqual(a.saved.dck_settings.memoryEnabled, false);
    a.toggle('Use memory');
    a.btn('Edit home city').click();
    a.btn('Delete').click();
    assert.strictEqual(JSON.stringify(a.saved.dck_memories), '[]');
    console.log('ok  memory tab');
  }

  // ---------- 6. Snippets tab + slash picker ----------
  {
    const a = await boot({ snippets: [{ id: 's1', name: 'translate', text: 'Translate to English:' }, { id: 's2', name: 'summarize', text: 'Summarize on {{date}}:' }] });
    a.tab('Snippets').click();
    assert.ok(a.text().includes('/translate') && a.text().includes('/summarize'));
    // search by text
    const search = a.drawer.querySelector('.dck-search');
    search.value = 'english';
    search.dispatchEvent(new a.w.Event('input', { bubbles: true }));
    assert.ok(a.text().includes('/translate') && !a.text().includes('/summarize'), 'search filters');
    a.drawer.querySelector('.dck-search').value = '';
    a.drawer.querySelector('.dck-search').dispatchEvent(new a.w.Event('input', { bubbles: true }));
    // new snippet
    a.btn('New snippet').click();
    assert.strictEqual(a.saved.dck_settings.snippets.length, 3);
    const nm = a.drawer.querySelector('input[aria-label="Snippet name"]');
    const tx = a.drawer.querySelector('textarea[aria-label="Snippet text"]');
    nm.value = 'Commit Message'; tx.value = 'Write a commit message for: ';
    tx.focus(); tx.setSelectionRange(tx.value.length, tx.value.length);
    Array.from(a.drawer.querySelectorAll('.dck-vchip')).find((b) => b.textContent === '+3').click();
    // expanding the chip list must not wipe what was typed
    assert.strictEqual(a.drawer.querySelector('input[aria-label="Snippet name"]').value, 'Commit Message', 'name kept');
    assert.strictEqual(a.drawer.querySelector('textarea[aria-label="Snippet text"]').value, 'Write a commit message for: ', 'text kept');
    Array.from(a.drawer.querySelectorAll('.dck-vchip')).find((b) => b.textContent === '{{selection}}').click();
    assert.strictEqual(tx.value, 'Write a commit message for: {{selection}}');
    a.btn('Save').click();
    const saved = a.saved.dck_settings.snippets[0];
    assert.strictEqual(saved.name, 'commit-message');
    assert.strictEqual(saved.text, 'Write a commit message for: {{selection}}');
    assert.ok(a.text().includes('/commit-message'));
    console.log('ok  snippets tab (list/search/new/expand chips)');
  }
  {
    const a = await boot({ snippets: [{ id: 's1', name: 'summarize', text: 'Summarize on {{date}}:' }, { id: 's2', name: 'translate', text: 'Translate:' }] });
    a.ta.focus();
    a.type(a.ta, '/');
    const pk = a.doc.getElementById('dck-picker');
    assert.ok(pk.style.display === 'block' && pk.querySelectorAll('.dck-pick').length === 2);
    assert.ok(pk.textContent.includes('Enter to insert'), 'picker footer hint');
    a.type(a.ta, '/sum');
    assert.strictEqual(pk.querySelectorAll('.dck-pick').length, 1);
    const ev = a.key(a.ta, 'Enter');
    assert.ok(ev.defaultPrevented);
    assert.ok(/^Summarize on \d{4}-\d{2}-\d{2}:$/.test(a.ta.value), a.ta.value);
    console.log('ok  slash picker');
  }

  // ---------- 7. Preview + Insert now ----------
  {
    const a = await boot({ prompts: [{ id: 'p', name: 'Tone', text: 'Be brief', enabled: true, schedule: 'always' }] });
    a.btn('Insert now').click();
    assert.strictEqual(a.ta.value, '', 'insert now needs a message');
    a.type(a.ta, 'hello');
    a.btn('Preview').click();
    const pv = a.drawer.querySelector('.dck-preview');
    assert.ok(pv && pv.textContent.includes('added to your next message') && pv.textContent.includes('Be brief') && pv.textContent.includes('Instructions (Default):'));
    a.btn('Close preview').click();
    assert.ok(!a.drawer.querySelector('.dck-preview'));
    a.btn('Insert now').click();
    assert.ok(a.ta.value.startsWith('[Context from my notes]') && a.ta.value.endsWith('hello'));
    console.log('ok  preview + insert now');
  }

  // ---------- 8. Send flows ----------
  {
    const a = await boot({ prompts: [{ id: 'p', name: 'Custom', text: 'Be brief', enabled: true, schedule: 'first' }] });
    a.type(a.ta, 'hello');
    const e1 = a.key(a.ta, 'Enter');
    assert.ok(e1.defaultPrevented, 'visible mode: first Enter inserts');
    assert.ok(a.ta.value.includes('Instructions (Custom):') && a.ta.value.endsWith('hello') && !a.ta.value.includes('{{'));
    const e2 = a.key(a.ta, 'Enter');
    assert.ok(!e2.defaultPrevented, 'second Enter sends');
    a.type(a.ta, 'again');
    assert.ok(!a.key(a.ta, 'Enter').defaultPrevented && a.ta.value === 'again', 'nothing due on message 2');
    assert.ok(a.doc.getElementById('dck-strip').textContent.includes('Nothing is due'), 'strip says nothing due');
    console.log('ok  visible mode');
  }
  {
    const a = await boot({ showInjected: false, prompts: [{ id: 'p', name: 'Custom', text: 'Be brief', enabled: true, schedule: 'first' }] });
    const seen = [];
    a.ta.addEventListener('keydown', (e) => { if (e.key === 'Enter') seen.push(a.ta.value); });
    a.type(a.ta, 'hello');
    assert.ok(a.key(a.ta, 'Enter').defaultPrevented);
    assert.strictEqual(seen.length, 1);
    assert.ok(seen[0].startsWith('[Context from my notes]') && seen[0].endsWith('hello'));
    a.type(a.ta, '');
    await sleep(700);
    const bubble = a.doc.createElement('div');
    bubble.textContent = seen[0];
    a.doc.getElementById('chat').appendChild(bubble);
    await sleep(100);
    assert.strictEqual(bubble.textContent, 'hello', 'hidden in chat view');
    console.log('ok  hidden mode');
  }
  {
    const a = await boot({ showInjected: false, prompts: [{ id: 'p', name: 'Custom', text: 'Be brief', enabled: true, schedule: 'first' }] });
    let clicks = 0;
    a.doc.getElementById('send').addEventListener('click', () => clicks++);
    a.doc.getElementById('attach').addEventListener('click', () => (clicks += 100));
    a.type(a.ta, 'hello');
    a.key(a.ta, 'Enter');
    await sleep(1900);
    assert.strictEqual(clicks, 1, 'fallback clicks send, not attach');
    console.log('ok  hidden mode fallback');
  }
  {
    // typing Enter inside the drawer never triggers a send
    const a = await boot({ snippets: [{ id: 's', name: 'x', text: 'y' }] });
    a.tab('Snippets').click();
    a.btn('New snippet').click();
    const tx = a.drawer.querySelector('textarea[aria-label="Snippet text"]');
    tx.value = 'some text';
    const ev = a.key(tx, 'Enter');
    assert.ok(!ev.defaultPrevented, 'drawer textarea Enter left alone');
    console.log('ok  drawer typing is isolated');
  }

  {
    // The widget iframe can still navigate itself, so the settings text must not promise that nothing leaves the page.
    assert.ok(!/Nothing leaves the page/.test(src), 'settings text does not overclaim isolation');
    assert.ok(/isolated iframe/.test(src), 'widget setting describes the sandbox');
    assert.ok(/Treat generated widget code as untrusted/.test(src), 'widget setting warns that widget code is untrusted');
    assert.ok(/can navigate that frame/.test(src), 'widget setting mentions the self-navigation limitation');
    const readme = read('README.md');
    const ver = JSON.parse(read('manifest.json')).version;
    assert.ok(readme.indexOf('**Current version:** ' + ver) !== -1, 'README shows the manifest version');
    console.log('ok  settings wording and README version');
  }

  console.log('\nall smoke tests passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.stack || e.message); process.exit(1); });
