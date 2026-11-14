// Run with: node tests/logic.test.js
const assert = require('assert');
const c = require('../content.js');

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

console.log('all logic tests passed');
