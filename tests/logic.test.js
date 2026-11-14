// Run with: node tests/logic.test.js
const assert = require('assert');
const c = require('../content.js');

const fixed = { now: new Date(2026, 10, 14, 15, 30), timezone: 'Asia/Manila', messageNumber: 3, selection: 'picked' };
const off = { enabled: true, memoryEnabled: true, defaultEnabled: false };

// ---- variables
assert.strictEqual(c.applyVariables('{{date}} {{time}} {{weekday}}', fixed), '2026-11-14 15:30 Saturday');
assert.strictEqual(c.applyVariables('{{ DATE }}|{{datetime}}|{{timezone}}', fixed), '2026-11-14|2026-11-14 15:30|Asia/Manila');
assert.strictEqual(c.applyVariables('n={{message_number}} s={{selection}}', fixed), 'n=3 s=picked');
assert.strictEqual(c.applyVariables('{{nope}} stays', fixed), '{{nope}} stays');

// ---- memory
const mem = [
  { key: 'my name', value: 'Ana', importance: 'always' },
  { key: 'favorite editor', value: 'vim', importance: 'called' },
];
assert.deepStrictEqual(c.selectMemories(mem, 'which editor').map((m) => m.key), ['my name', 'favorite editor']);
assert.deepStrictEqual(c.selectMemories(mem, 'hello').map((m) => m.key), ['my name']);

// ---- single mode
const single = { ...off, mode: 'first', systemPrompt: 'Be brief' };
assert.ok(c.shouldInject(single, 0) && !c.shouldInject(single, 1));
assert.ok(c.buildPrefix(single, mem, 'hi', 0).includes('Instructions:\nBe brief'));
assert.ok(!c.buildPrefix(single, mem, 'hi', 1).includes('Be brief'));
assert.ok(c.buildPrefix(single, mem, 'hi', 1, true).includes('Be brief'));
assert.ok(!c.shouldInject({ ...single, enabled: false }, 0));

// ---- built-in default prompt
const withDefault = { enabled: true, memoryEnabled: false, systemPrompt: '', mode: 'first' };
let p = c.buildPrefix(withDefault, [], 'x', 0, false, fixed);
assert.ok(p.includes('Instructions (Default):'), 'default prompt included by default');
assert.ok(p.includes('Today is 2026-11-14 (Saturday), local time 15:30 Asia/Manila'), 'variables filled in default');
assert.ok(!p.includes('{{'), 'no unresolved variables');
assert.ok(!c.buildPrefix({ ...withDefault, defaultEnabled: false }, [], 'x', 0).includes('Default'));
assert.ok(c.buildPrefix({ ...withDefault, defaultText: 'My own default' }, [], 'x', 0).includes('My own default'));
assert.ok(!c.buildPrefix({ ...withDefault, defaultText: 'My own default' }, [], 'x', 0).includes('honest assistant'));
assert.ok(!c.buildPrefix(withDefault, [], 'x', 1).includes('Default'), 'first-message schedule respected');
assert.ok(c.buildPrefix({ ...withDefault, defaultSchedule: 'always' }, [], 'x', 5).includes('Default'));
assert.ok(c.shouldInject(withDefault, 0) && !c.shouldInject(withDefault, 1));
assert.ok(c.BUILTIN_DEFAULT_PROMPT.indexOf('\u2014') === -1 && /^[\x00-\x7F]*$/.test(c.BUILTIN_DEFAULT_PROMPT));

// ---- multi mode
const multi = {
  ...off, multiPrompt: true,
  prompts: [
    { id: '1', name: 'Custom', text: 'Rule A', enabled: true, schedule: 'first' },
    { id: '2', name: 'Tone', text: 'Rule B', enabled: true, schedule: 'every', everyN: 3 },
    { id: '3', name: 'Off', text: 'Rule C', enabled: false, schedule: 'always' },
    { id: '4', name: 'Always', text: 'Rule D', enabled: true, schedule: 'always' },
  ],
};
p = c.buildPrefix(multi, [], 'x', 0);
assert.ok(p.includes('Rule A') && p.includes('Rule B') && p.includes('Rule D') && !p.includes('Rule C'));
p = c.buildPrefix(multi, [], 'x', 1);
assert.ok(!p.includes('Rule A') && !p.includes('Rule B') && p.includes('Rule D'));
p = c.buildPrefix(multi, [], 'x', 3);
assert.ok(!p.includes('Rule A') && p.includes('Rule B') && p.includes('(Tone)'));
assert.ok(c.buildPrefix(multi, [], 'x', 1, true).includes('Rule A'));
assert.ok(!c.shouldInject({ ...off, multiPrompt: true, prompts: [{ id: '1', name: 'A', text: 't', enabled: true, schedule: 'first' }] }, 2));
assert.ok(!c.shouldInject({ ...off, multiPrompt: true, prompts: [] }, 0));

// ---- hide / strip
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
const snips = [{ name: 'summarize', text: 'a' }, { name: 'sum-up', text: 'b' }, { name: 'translate', text: 'c' }, { name: 'resume', text: 'd' }];
assert.deepStrictEqual(c.filterSnippets(snips, 'sum').map((s) => s.name), ['sum-up', 'summarize', 'resume']);
assert.strictEqual(c.filterSnippets(snips, '').length, 4);
assert.strictEqual(c.filterSnippets(snips, 'zzz').length, 0);
assert.strictEqual(c.filterSnippets(snips, '', 2).length, 2);

console.log('all logic tests passed');
