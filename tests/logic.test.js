// Run with: node tests/logic.test.js
const assert = require('assert');
const c = require('../lib.js');

const fixed = { now: new Date(2026, 10, 14, 15, 30), timezone: 'Asia/Manila', messageNumber: 3, selection: 'picked' };
const base = { enabled: true, memoryEnabled: true, defaultEnabled: false, prompts: [] };

// ---- variables
assert.strictEqual(c.applyVariables('{{date}} {{time}} {{weekday}}', fixed), '2026-11-14 15:30 Saturday');
assert.strictEqual(c.applyVariables('{{ DATE }}|{{datetime}}|{{timezone}}', fixed), '2026-11-14|2026-11-14 15:30|Asia/Manila');
assert.strictEqual(c.applyVariables('n={{message_number}} s={{selection}}', fixed), 'n=3 s=picked');
assert.strictEqual(c.applyVariables('{{nope}} stays', fixed), '{{nope}} stays');
assert.deepStrictEqual(c.VARIABLE_NAMES, c.VARIABLES.map((v) => v.name));

// ---- memory
const mem = [
  { key: 'my name', value: 'Ana', importance: 'always' },
  { key: 'favorite editor', value: 'vim', importance: 'called' },
];
assert.deepStrictEqual(c.selectMemories(mem, 'which editor').map((m) => m.key), ['my name', 'favorite editor']);
assert.deepStrictEqual(c.selectMemories(mem, 'hello').map((m) => m.key), ['my name']);

// ---- settings migration (old single prompt / multi-prompt switch)
let m = c.migrateSettings({ systemPrompt: 'Be brief', mode: 'every', everyN: 4 });
assert.strictEqual(m.prompts.length, 1);
assert.deepStrictEqual([m.prompts[0].name, m.prompts[0].text, m.prompts[0].enabled, m.prompts[0].schedule, m.prompts[0].everyN], ['Custom prompt', 'Be brief', true, 'every', 4]);
assert.ok(!('systemPrompt' in m) && !('mode' in m) && !('everyN' in m) && !('multiPrompt' in m), 'legacy keys removed');
// multi mode with a leftover single prompt: kept, but switched off, after the existing list
m = c.migrateSettings({ multiPrompt: true, systemPrompt: 'Old text', prompts: [{ id: 'x', name: 'Mine', text: 't', enabled: true, schedule: 'first' }] });
assert.strictEqual(m.prompts.length, 2);
assert.strictEqual(m.prompts[0].name, 'Previous prompt');
assert.strictEqual(m.prompts[0].enabled, false);
assert.strictEqual(m.prompts[1].id, 'x');
// no legacy prompt -> list untouched; idempotent
m = c.migrateSettings({ prompts: [{ id: 'x', name: 'Mine', text: 't', enabled: true, schedule: 'first' }] });
assert.strictEqual(m.prompts.length, 1);
assert.deepStrictEqual(c.migrateSettings(m).prompts, m.prompts);
assert.ok(c.hasLegacyKeys({ systemPrompt: '' }) && c.hasLegacyKeys({ multiPrompt: true }) && !c.hasLegacyKeys({ prompts: [] }) && !c.hasLegacyKeys(undefined));
// defaults for a fresh install
m = c.migrateSettings(undefined);
assert.ok(m.enabled && m.showInjected && m.showSummary && m.showChips && m.defaultEnabled && Array.isArray(m.prompts) && Array.isArray(m.snippets));

// ---- list of prompts with schedules
const list = {
  ...base,
  prompts: [
    { id: '1', name: 'Custom', text: 'Rule A', enabled: true, schedule: 'first' },
    { id: '2', name: 'Tone', text: 'Rule B', enabled: true, schedule: 'every', everyN: 3 },
    { id: '3', name: 'Off', text: 'Rule C', enabled: false, schedule: 'always' },
    { id: '4', name: 'Always', text: 'Rule D', enabled: true, schedule: 'always' },
    { id: '5', name: 'Empty', text: '   ', enabled: true, schedule: 'always' },
  ],
};
let p = c.buildPrefix(list, [], 'x', 0);
assert.ok(p.includes('Rule A') && p.includes('Rule B') && p.includes('Rule D') && !p.includes('Rule C') && !p.includes('Empty'));
assert.ok(p.includes('Instructions (Custom):\nRule A'));
p = c.buildPrefix(list, [], 'x', 1);
assert.ok(!p.includes('Rule A') && !p.includes('Rule B') && p.includes('Rule D'));
p = c.buildPrefix(list, [], 'x', 3);
assert.ok(!p.includes('Rule A') && p.includes('Rule B') && p.includes('(Tone)'));
assert.ok(c.buildPrefix(list, [], 'x', 1, true).includes('Rule A'), 'force ignores schedules');
assert.ok(!c.buildPrefix(list, [], 'x', 1, true).includes('Rule C'), 'disabled stays out even when forced');
assert.ok(!c.shouldInject({ ...base, prompts: [{ id: '1', name: 'A', text: 't', enabled: true, schedule: 'first' }] }, 2));
assert.ok(!c.shouldInject({ ...base, prompts: [{ id: '1', name: 'A', text: '', enabled: true, schedule: 'always' }] }, 0), 'empty text never injects');
assert.ok(!c.shouldInject(base, 0));
assert.ok(!c.shouldInject({ ...list, enabled: false }, 0));
assert.strictEqual(c.buildPrefix({ ...base, memoryEnabled: false }, mem, 'x', 0), '');

// ---- built-in default prompt
const withDefault = { enabled: true, memoryEnabled: false, prompts: [] };
p = c.buildPrefix(withDefault, [], 'x', 0, false, fixed);
assert.ok(p.includes('Instructions (Default):'));
assert.ok(p.includes('Today is 2026-11-14 (Saturday), local time 15:30 Asia/Manila'));
assert.ok(!p.includes('{{'));
assert.ok(!c.buildPrefix({ ...withDefault, defaultEnabled: false }, [], 'x', 0).includes('Default'));
assert.ok(c.buildPrefix({ ...withDefault, defaultText: 'My own default' }, [], 'x', 0).includes('My own default'));
assert.ok(!c.buildPrefix({ ...withDefault, defaultText: 'My own default' }, [], 'x', 0).includes('honest assistant'));
assert.ok(!c.buildPrefix(withDefault, [], 'x', 1).includes('Default'));
assert.ok(c.buildPrefix({ ...withDefault, defaultSchedule: 'always' }, [], 'x', 5).includes('Default'));
assert.ok(c.shouldInject(withDefault, 0) && !c.shouldInject(withDefault, 1));
assert.ok(/^[\x00-\x7F]*$/.test(c.BUILTIN_DEFAULT_PROMPT));

// ---- next-message summary + token estimate
assert.strictEqual(c.estimateTokens(''), 0);
assert.strictEqual(c.estimateTokens('abcd'), 1);
assert.strictEqual(c.estimateTokens('abcde'), 2);
const sumSettings = { enabled: true, memoryEnabled: true, prompts: [{ id: '2', name: 'Concise tone', text: 'Be brief', enabled: true, schedule: 'first' }] };
let sum = c.summarize(sumSettings, mem, 'which editor', 0);
assert.strictEqual(sum.state, 'ready');
assert.deepStrictEqual(sum.names, ['Default', 'Concise tone']);
assert.strictEqual(sum.memories, 2);
assert.ok(sum.tokens > 0);
assert.strictEqual(c.describeSummary(sum), 'Next message includes Default, Concise tone + 2 memories');
sum = c.summarize(sumSettings, mem, 'hello', 0);
assert.strictEqual(sum.memories, 1);
assert.strictEqual(c.describeSummary(sum), 'Next message includes Default, Concise tone + 1 memory');
sum = c.summarize({ ...sumSettings, memoryEnabled: false }, mem, 'hello', 0);
assert.strictEqual(c.describeSummary(sum), 'Next message includes Default, Concise tone');
sum = c.summarize(sumSettings, mem, 'hello', 1);
assert.strictEqual(sum.state, 'idle');
assert.strictEqual(c.describeSummary(sum), 'Nothing is due for the next message');
sum = c.summarize({ ...sumSettings, enabled: false }, mem, 'hello', 0);
assert.strictEqual(sum.state, 'off');
assert.strictEqual(c.describeSummary(sum), 'Kit is off');
assert.strictEqual(c.memoryLabel(1), '1 memory');
assert.strictEqual(c.memoryLabel(3), '3 memories');

// ---- hide / strip
const single = { enabled: true, memoryEnabled: false, defaultEnabled: false, prompts: [{ id: '1', name: 'A', text: 'Be brief', enabled: true, schedule: 'first' }] };
const withCtx = c.buildPrefix(single, [], 'hello', 0);
assert.ok(c.alreadyHasContext(withCtx + 'hello'));
assert.strictEqual(c.stripContext(withCtx + 'hello'), 'hello');
assert.strictEqual(c.stripContext('no context here'), 'no context here');

// ---- snippets
assert.strictEqual(c.slashQuery('/'), '');
assert.strictEqual(c.slashQuery('/sum'), 'sum');
assert.strictEqual(c.slashQuery('/home/user'), null);
assert.strictEqual(c.slashQuery('hello /sum'), null);
assert.strictEqual(c.slashQuery('/two words'), null);
assert.strictEqual(c.cleanSnippetName('  My Snippet! '), 'my-snippet');
const snips = [{ name: 'summarize', text: 'a' }, { name: 'sum-up', text: 'b' }, { name: 'translate', text: 'to English' }, { name: 'resume', text: 'd' }];
assert.deepStrictEqual(c.filterSnippets(snips, 'sum').map((s) => s.name), ['sum-up', 'summarize', 'resume']);
assert.strictEqual(c.filterSnippets(snips, '').length, 4);
assert.strictEqual(c.filterSnippets(snips, 'zzz').length, 0);
assert.strictEqual(c.filterSnippets(snips, '', 2).length, 2);
// drawer search: name or text, keeps order
assert.deepStrictEqual(c.searchSnippets(snips, 'english').map((s) => s.name), ['translate']);
assert.deepStrictEqual(c.searchSnippets(snips, 'SUM').map((s) => s.name), ['summarize', 'sum-up', 'resume']);
assert.strictEqual(c.searchSnippets(snips, '  ').length, 4);

// ---- schedule labels + caret insert
assert.strictEqual(c.describeSchedule('first'), 'First message');
assert.strictEqual(c.describeSchedule('always'), 'Every message');
assert.strictEqual(c.describeSchedule('every', 4), 'Every 4 messages');
assert.deepStrictEqual(c.insertAt('hello world', 6, 6, '{{date}} '), { value: 'hello {{date}} world', caret: 15 });
assert.deepStrictEqual(c.insertAt('hello world', 0, 5, 'X'), { value: 'X world', caret: 1 });
assert.deepStrictEqual(c.insertAt('abc', null, null, 'Z'), { value: 'abcZ', caret: 4 });

// ---- per-chat message counts (survive refresh; unknown existing chats count as already started)
assert.ok(!c.isExistingChatPath('/') && !c.isExistingChatPath('') && !c.isExistingChatPath(undefined));
assert.ok(c.isExistingChatPath('/a/chat/s/abc'));
assert.strictEqual(c.resolveCount({}, '/'), 0, 'new chat starts at 0');
assert.strictEqual(c.resolveCount({}, '/a/chat/s/abc'), 1, 'unknown existing chat is already started');
assert.strictEqual(c.resolveCount({ '/a/chat/s/abc': 4 }, '/a/chat/s/abc'), 4, 'stored count wins');
assert.strictEqual(c.resolveCount({ '/a/chat/s/abc': 0 }, '/a/chat/s/abc'), 0, 'a stored 0 is respected');
assert.strictEqual(c.resolveCount({ '/a/chat/s/abc': 'junk' }, '/a/chat/s/abc'), 1, 'corrupt value falls back');
assert.strictEqual(c.resolveCount({ '/a/chat/s/abc': -3 }, '/a/chat/s/abc'), 1);
assert.strictEqual(c.resolveCount(null, '/a/chat/s/abc'), 1);
// a refresh in an existing chat must not make "first message" prompts due again
const firstOnly = { enabled: true, memoryEnabled: false, prompts: [{ id: '1', name: 'A', text: 't', enabled: true, schedule: 'first' }] };
assert.ok(!c.shouldInject(firstOnly, c.resolveCount({}, '/a/chat/s/abc')), 'no first-message prompt after refresh');
assert.ok(c.shouldInject(firstOnly, c.resolveCount({}, '/')), 'new chat still gets it');
const many = {};
for (let i = 0; i < 10; i++) many['/a/chat/s/' + i] = i;
const pruned = c.pruneCounts(many, 4);
assert.deepStrictEqual(Object.keys(pruned), ['/a/chat/s/6', '/a/chat/s/7', '/a/chat/s/8', '/a/chat/s/9']);
assert.strictEqual(c.pruneCounts(many, 50), many);
assert.deepStrictEqual(c.pruneCounts(undefined, 5), {});

// ---- memory: plan, budget, status
const notes = [
  { key: 'my name', value: 'Ana', importance: 'always', category: 'Personal' },
  { key: 'favorite editor', value: 'vim', importance: 'called', category: 'work' },
  { key: 'long note', value: 'x'.repeat(400), importance: 'always' },
  { key: 'dog', value: 'Rex', importance: 'called', enabled: false },
  { key: 'timezone', value: 'Asia/Manila', importance: 'always', category: 'Personal' },
];
let plan = c.memoryPlan(notes, 'which editor', 0);
assert.deepStrictEqual(plan.status, ['included', 'included', 'included', 'off', 'included'], 'no budget: everything due is included');
assert.deepStrictEqual(c.memoryPlan(notes, 'hello', 0).status, ['included', 'idle', 'included', 'off', 'included'], 'called note not mentioned -> idle');
assert.deepStrictEqual(c.memoryPlan(notes, 'my dog', 0).status[3], 'off', 'a switched-off note stays off even when mentioned');
// a budget skips what does not fit, in priority order (always first), and smaller later notes can still fit
plan = c.memoryPlan(notes, 'which editor', 40);
assert.deepStrictEqual(plan.status, ['included', 'included', 'budget', 'off', 'included'], JSON.stringify(plan));
assert.ok(plan.tokens > 0 && plan.tokens <= 40);
assert.deepStrictEqual(c.memoryPlan(notes, 'which editor', 1).status, ['budget', 'budget', 'budget', 'off', 'budget'], 'tiny budget includes nothing');
assert.strictEqual(c.memoryPlan(notes, 'x', 1).tokens, 0);
// "always" notes win over "when mentioned" when the budget only fits one
const two = [{ key: 'mentioned note', value: 'v', importance: 'called' }, { key: 'always note', value: 'v', importance: 'always' }];
const oneFit = c.memoryPlan(two, 'mentioned note', 13);
assert.deepStrictEqual(oneFit.status, ['budget', 'included'], JSON.stringify(oneFit));
// selectMemories keeps list order and respects the budget
assert.deepStrictEqual(c.selectMemories(notes, 'which editor', 40).map((m) => m.key), ['my name', 'favorite editor', 'timezone']);
assert.deepStrictEqual(c.selectMemories(notes, 'hello').map((m) => m.key), ['my name', 'long note', 'timezone']);
// statuses for the Memory tab
assert.deepStrictEqual(c.memoryStatuses({ memoryEnabled: true, memoryBudget: 0 }, notes, 'hello'), ['included', 'idle', 'included', 'off', 'included']);
assert.deepStrictEqual(c.memoryStatuses({ memoryEnabled: false, memoryBudget: 0 }, notes, 'hello'), ['paused', 'paused', 'paused', 'off', 'paused']);
assert.strictEqual(c.memoryTokens({ memoryEnabled: false }, notes, 'x'), 0);
assert.ok(c.memoryTokens({ memoryEnabled: true, memoryBudget: 0 }, notes, 'x') > 100);
// prefix and summary honour the budget
const budgetSettings = { enabled: true, memoryEnabled: true, memoryBudget: 40, defaultEnabled: false, prompts: [{ id: 'a', name: 'A', text: 't', enabled: true, schedule: 'always' }] };
p = c.buildPrefix(budgetSettings, notes, 'which editor', 0);
assert.ok(p.includes('my name: Ana') && p.includes('favorite editor: vim') && !p.includes('xxxx') && !p.includes('dog'));
sum = c.summarize(budgetSettings, notes, 'which editor', 0);
assert.strictEqual(sum.memories, 3);
assert.strictEqual(sum.skipped, 1);
assert.strictEqual(c.describeSummary(sum), 'Next message includes A + 3 memories (1 over budget)');
assert.strictEqual(c.summarize({ ...budgetSettings, memoryBudget: 0 }, notes, 'which editor', 0).skipped, 0);
// categories
const groups = c.groupMemories(notes);
assert.deepStrictEqual(groups.map((g) => g.category), ['General', 'Personal', 'work']);
assert.deepStrictEqual(groups[0].items.map((x) => x.m.key), ['long note', 'dog']);
assert.deepStrictEqual(groups[1].items.map((x) => x.index), [0, 4], 'items keep their index in the full list');
assert.strictEqual(c.memoryCategory({ key: 'k', category: '  ' }), 'General');
assert.strictEqual(c.cleanCategory('personal', notes), 'Personal', 'reuses existing spelling');
assert.strictEqual(c.cleanCategory('  New   Cat ', notes), 'New Cat');
assert.strictEqual(c.cleanCategory('general', notes), '', 'General means no category');
assert.strictEqual(c.cleanCategory('', notes), '');
assert.ok(c.migrateSettings({}).memoryBudget === 0 && c.migrateSettings({}).codeTools === true && c.migrateSettings({}).previewExternal === false);

// ---- code blocks: language detection
assert.strictEqual(c.normalizeLang('JS'), 'javascript');
assert.strictEqual(c.normalizeLang('language-py'), 'python');
assert.strictEqual(c.normalizeLang('c++'), 'cpp');
assert.strictEqual(c.langFromClass('hljs language-html extra'), 'html');
assert.strictEqual(c.langFromClass('lang-yml'), 'yaml');
assert.strictEqual(c.langFromClass('nothing'), '');
assert.strictEqual(c.sniffLang('<!DOCTYPE html><html></html>'), 'html');
assert.strictEqual(c.sniffLang('  <html lang="en">'), 'html');
assert.strictEqual(c.sniffLang('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'svg');
assert.strictEqual(c.sniffLang('<?xml version="1.0"?>\n<svg></svg>'), 'svg');
assert.strictEqual(c.sniffLang('%% comment\ngraph TD\n A-->B'), 'mermaid');
assert.strictEqual(c.sniffLang('sequenceDiagram\n A->>B: hi'), 'mermaid');
assert.strictEqual(c.sniffLang('{"a": 1}'), 'json');
assert.strictEqual(c.sniffLang('{ not json'), '');
assert.strictEqual(c.sniffLang('const x = 1;'), '');
let d = c.detectBlock(['Copy', 'html'], '<div></div>');
assert.deepStrictEqual([d.lang, d.kind, d.ext], ['html', 'html', 'html'], 'unknown header word is skipped, later hint used');
d = c.detectBlock(['md'], '# hi');
assert.deepStrictEqual([d.lang, d.kind, d.ext], ['markdown', 'markdown', 'md']);
d = c.detectBlock([], '<svg></svg>');
assert.deepStrictEqual([d.lang, d.kind, d.ext], ['svg', 'svg', 'svg'], 'no label: sniffed');
d = c.detectBlock(['xml'], '<svg></svg>');
assert.strictEqual(d.lang, 'svg', 'generic xml label with svg content');
d = c.detectBlock(['text'], 'graph LR\n A-->B');
assert.strictEqual(d.kind, 'mermaid');
d = c.detectBlock(['python'], '<html></html>');
assert.deepStrictEqual([d.lang, d.kind, d.ext], ['python', null, 'py'], 'a clear label is trusted');
d = c.detectBlock([], 'just words');
assert.deepStrictEqual([d.lang, d.kind, d.ext], ['text', null, 'txt']);

// ---- file names
assert.strictEqual(c.suggestFilename('javascript', '// file: src/app.js\nconsole.log(1)', 1), 'src/app.js');
assert.strictEqual(c.suggestFilename('python', '# main.py\nprint(1)', 2), 'main.py');
assert.strictEqual(c.suggestFilename('html', '<!-- index.html -->\n<p>x</p>', 1), 'index.html');
assert.strictEqual(c.suggestFilename('css', '/* styles.css */\nbody{}', 1), 'styles.css');
assert.strictEqual(c.suggestFilename('python', '# filename: ../../etc/passwd.py\nx=1', 1), 'etc/passwd.py', 'path traversal is stripped');
assert.strictEqual(c.suggestFilename('bash', '# .gitignore\nnode_modules', 1), '.gitignore');
assert.strictEqual(c.suggestFilename('yaml', '# file: .github/workflows/ci.yml\non: push', 1), '.github/workflows/ci.yml');
assert.strictEqual(c.suggestFilename('javascript', '// ./src/app.js\nx', 1), 'src/app.js');
assert.strictEqual(c.suggestFilename('text', '# ...\nx', 1), 'snippet-1.txt');
assert.strictEqual(c.suggestFilename('python', '# this is a comment\nx=1', 3), 'snippet-3.py', 'ordinary comments are not file names');
assert.strictEqual(c.suggestFilename('python', '# v2.0\nx=1', 1), 'snippet-1.py');
assert.strictEqual(c.suggestFilename('json', '{}', 0), 'snippet-1.json');
const used = new Set();
assert.strictEqual(c.uniqueName('a.js', used), 'a.js');
assert.strictEqual(c.uniqueName('a.js', used), 'a-2.js');
assert.strictEqual(c.uniqueName('a.js', used), 'a-3.js');
assert.strictEqual(c.uniqueName('README', used), 'README');
assert.strictEqual(c.uniqueName('README', used), 'README-2');

// ---- zip
assert.strictEqual(c.crc32(new TextEncoder().encode('123456789')), 0xCBF43926, 'CRC-32 check value');
assert.strictEqual(c.crc32(new Uint8Array(0)), 0);
function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  assert.strictEqual(dv.getUint32(eocd, true), 0x06054b50, 'end of central directory');
  const count = dv.getUint16(eocd + 10, true);
  let pos = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.strictEqual(dv.getUint32(pos, true), 0x02014b50, 'central entry');
    const crc = dv.getUint32(pos + 16, true);
    const size = dv.getUint32(pos + 20, true);
    const nlen = dv.getUint16(pos + 28, true);
    const lho = dv.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nlen));
    assert.strictEqual(dv.getUint32(lho, true), 0x04034b50, 'local header');
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    out.push({ name: name, data: new TextDecoder().decode(bytes.subarray(start, start + size)), crc: crc });
    pos += 46 + nlen;
  }
  return out;
}
const zipFiles = [
  { name: 'src/app.js', data: 'console.log("hi");\n' },
  { name: 'notes/caf\u00e9.md', data: '# caf\u00e9 \u2713\n' },
  { name: 'empty.txt', data: '' },
  { name: 'bin.dat', data: new Uint8Array([0, 1, 2, 255]) },
];
const zipped = readZip(c.makeZip(zipFiles, new Date(2026, 10, 15, 10, 30, 20)));
assert.deepStrictEqual(zipped.map((f) => f.name), ['src/app.js', 'notes/caf\u00e9.md', 'empty.txt', 'bin.dat']);
assert.strictEqual(zipped[0].data, 'console.log("hi");\n');
assert.strictEqual(zipped[1].data, '# caf\u00e9 \u2713\n');
assert.strictEqual(zipped[2].data, '');
const zlib = require('zlib');
if (typeof zlib.crc32 === 'function') zipped.forEach((f, i) => assert.strictEqual(f.crc, zlib.crc32(typeof zipFiles[i].data === 'string' ? Buffer.from(zipFiles[i].data) : Buffer.from(zipFiles[i].data)), 'crc matches zlib for ' + f.name));
assert.strictEqual(c.makeZip([]).length, 22, 'empty zip is just the end record');

console.log('all logic tests passed');
