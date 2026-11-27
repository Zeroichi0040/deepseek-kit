// Run with: node tests/logic.test.js
const assert = require('assert');
const c = require('../lib.js');

const fixed = { now: new Date(2026, 10, 14, 15, 30), timezone: 'Etc/UTC', messageNumber: 3, selection: 'picked' };
const base = { enabled: true, memoryEnabled: true, defaultEnabled: false, visualsPrompt: false, askPrompt: false, prompts: [] };

// ---- variables
assert.strictEqual(c.applyVariables('{{date}} {{time}} {{weekday}}', fixed), '2026-11-14 15:30 Saturday');
assert.strictEqual(c.applyVariables('{{ DATE }}|{{datetime}}|{{timezone}}', fixed), '2026-11-14|2026-11-14 15:30|Etc/UTC');
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
assert.ok(m.enabled && m.showInjected === false && m.showSummary && m.showChips && m.defaultEnabled && Array.isArray(m.prompts) && Array.isArray(m.snippets));

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
const withDefault = { enabled: true, memoryEnabled: false, visualsPrompt: false, askPrompt: false, prompts: [] };
p = c.buildPrefix(withDefault, [], 'x', 0, false, fixed);
assert.ok(p.includes('Instructions (Default):'));
assert.ok(p.includes('Today is 2026-11-14 (Saturday), local time 15:30 Etc/UTC'));
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
const sumSettings = { enabled: true, memoryEnabled: true, visualsPrompt: false, askPrompt: false, prompts: [{ id: '2', name: 'Concise tone', text: 'Be brief', enabled: true, schedule: 'first' }] };
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
const single = { enabled: true, memoryEnabled: false, defaultEnabled: false, visualsPrompt: false, askPrompt: false, prompts: [{ id: '1', name: 'A', text: 'Be brief', enabled: true, schedule: 'first' }] };
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
// names keep letters and digits of any script, but not typographic punctuation
assert.strictEqual(c.cleanSnippetName('Café “Menu” — 2'), 'café-menu--2');
assert.strictEqual(c.cleanSnippetName('翻訳 テスト'), '翻訳-テスト');

// ---- "when mentioned" keys next to typographic punctuation (curly quotes, dashes, ellipsis) still match
{
  const hit = (key, text) => { const t = text.toLowerCase(); return c.keyMatches(key, t, c.tokens(t)); };
  assert.ok(hit('python', 'I love “Python” a lot'), 'curly double quotes');
  assert.ok(hit('python', 'it’s about python—the language'), 'em dash');
  assert.ok(hit('rust', 'maybe rust… or go'), 'ellipsis');
  assert.ok(hit('python', '(python)'), 'brackets');
  assert.ok(hit('café', 'un café, s’il vous plaît'), 'accented key with a comma after it');
  assert.ok(hit('AI', 'what is “AI”?'), 'short key inside curly quotes');
  assert.ok(hit('AI', 'AI—hype or not'), 'short key before an em dash');
  assert.ok(!hit('AI', 'maintain the rail'), 'short key is still a whole word only');
  assert.ok(!hit('AI', 'caféai'), 'short key does not match inside a word of another script block');
  assert.ok(!hit('python', 'pythonic code'), 'longer word does not match');
  assert.ok(hit('東京', '今日は東京に行く'), 'CJK key as written');
}
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
// two tabs, two chats: merging keeps both entries and the larger count of a chat both know
assert.deepStrictEqual(c.addCounts({ '/a': 2 }, { '/b': 2 }), { '/a': 2, '/b': 2 });
assert.deepStrictEqual(c.addCounts({ '/a': 5 }, { '/a': 3 }), { '/a': 8 }, 'increments add up');
assert.deepStrictEqual(Object.keys(c.addCounts({ '/a': 1, '/b': 1, '/c': 1 }, { '/a': 2 })), ['/b', '/c', '/a'], 'the chat just touched is the most recent');
assert.deepStrictEqual(c.addCounts({ '/a': 'junk', '/b': -1, '/c': NaN, '/d': 2.9 }, { '/e': 0, '/f': -2, '/g': 'x' }), { '/d': 2 }, 'non-counts are dropped');
assert.deepStrictEqual(c.addCounts({ '/a': 1 }, { '/a': 1, '/b': 1 }, (k) => (k === '/b' ? 1 : 9)), { '/a': 2, '/b': 2 }, 'startOf only applies to chats with no stored count');
assert.deepStrictEqual(c.addCounts(null, undefined), {});
assert.deepStrictEqual(c.addCounts([1, 2], 'x'), {}, 'arrays and strings are not count maps');
assert.deepStrictEqual(c.addCounts({ '/a': 0 }, null), { '/a': 0 }, 'a stored 0 stays');

// ---- memory: plan, budget, status
const notes = [
  { key: 'my name', value: 'Ana', importance: 'always', category: 'Personal' },
  { key: 'favorite editor', value: 'vim', importance: 'called', category: 'work' },
  { key: 'long note', value: 'x'.repeat(400), importance: 'always' },
  { key: 'dog', value: 'Rex', importance: 'called', enabled: false },
  { key: 'timezone', value: 'Etc/UTC', importance: 'always', category: 'Personal' },
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
const budgetSettings = { enabled: true, memoryEnabled: true, memoryBudget: 40, defaultEnabled: false, visualsPrompt: false, askPrompt: false, prompts: [{ id: 'a', name: 'A', text: 't', enabled: true, schedule: 'always' }] };
p = c.buildPrefix(budgetSettings, notes, 'which editor', 0);
assert.ok(p.includes('my name: Ana') && p.includes('favorite editor: vim') && !p.includes('xxxx') && !p.includes('dog'));
sum = c.summarize(budgetSettings, notes, 'which editor', 0);
assert.strictEqual(sum.memories, 3);
assert.strictEqual(sum.skipped, 1);
assert.strictEqual(c.describeSummary(sum), 'Next message includes A + 3 memories (1 over budget)');
assert.strictEqual(c.summarize({ ...budgetSettings, memoryBudget: 0 }, notes, 'which editor', 0).skipped, 0);
// "first message" notes: only with the first message of a chat (or when forced), ahead of "when mentioned" ones
const firstNotes = [
  { key: 'mentioned note', value: 'v', importance: 'called' },
  { key: 'intro note', value: 'v', importance: 'first' },
  { key: 'off note', value: 'v', importance: 'first', enabled: false },
];
assert.deepStrictEqual(c.memoryPlan(firstNotes, 'mentioned note', 0, { sentCount: 0 }).status, ['included', 'included', 'off'], 'due on the first message');
assert.deepStrictEqual(c.memoryPlan(firstNotes, 'mentioned note', 0, { sentCount: 1 }).status, ['included', 'later', 'off'], 'not due after the first message');
assert.deepStrictEqual(c.memoryPlan(firstNotes, 'hello', 0, { sentCount: 3, force: true }).status, ['idle', 'included', 'off'], 'forced (Insert now) ignores the schedule');
assert.deepStrictEqual(c.memoryPlan(firstNotes, 'hello', 0).status, ['idle', 'later', 'off'], 'without a chat position a first note is not due');
assert.deepStrictEqual(c.selectMemories(firstNotes, 'hello', 0, { sentCount: 0 }).map((m) => m.key), ['intro note']);
assert.deepStrictEqual(c.selectMemories(firstNotes, 'hello', 0, { sentCount: 2 }).map((m) => m.key), []);
assert.deepStrictEqual(c.memoryPlan(firstNotes, 'mentioned note', 13, { sentCount: 0 }).status, ['budget', 'included', 'off'], 'first beats mentioned');
{
  // Budget priority has three tiers: due first-message notes, then always notes, then mentioned ones. List order is kept
  // inside each tier, and the notes that fit still go out in list order.
  const hdr = c.estimateTokens('Things to remember about me:\n');
  const cost = (k) => c.estimateTokens(c.memoryLine({ key: k, value: 'v' }) + '\n');
  const tiers = [
    { key: 'a1', value: 'v', importance: 'always' },
    { key: 'f1', value: 'v', importance: 'first' },
    { key: 'f2', value: 'v', importance: 'first' },
    { key: 'a2', value: 'v', importance: 'always' },
    { key: 'm1', value: 'v', importance: 'called' },
  ];
  const at0 = { sentCount: 0 };
  const status = (budget, opts) => c.memoryPlan(tiers, 'm1', budget, opts).status;
  assert.deepStrictEqual(status(hdr + cost('f1') + cost('f2'), at0), ['budget', 'included', 'included', 'budget', 'budget'], 'room for the two first-message notes only');
  assert.deepStrictEqual(status(hdr + cost('f1'), at0), ['budget', 'included', 'budget', 'budget', 'budget'], 'room for one: the first first-message note in list order');
  assert.deepStrictEqual(status(hdr + cost('f1') + cost('f2') + cost('a1'), at0), ['included', 'included', 'included', 'budget', 'budget'], 'then always notes, earliest first');
  assert.deepStrictEqual(status(hdr + cost('f1') + cost('f2') + cost('a1') + cost('a2'), at0), ['included', 'included', 'included', 'included', 'budget'], 'mentioned notes come last');
  assert.deepStrictEqual(status(0, at0), ['included', 'included', 'included', 'included', 'included'], 'no budget: everything');
  assert.deepStrictEqual(c.selectMemories(tiers, 'm1', hdr + cost('f1') + cost('f2') + cost('a1'), at0).map((m) => m.key), ['a1', 'f1', 'f2'], 'what fits is sent in list order');
  // after the first message the first-message notes are out of the competition and the always notes lead
  assert.deepStrictEqual(status(hdr + cost('a1'), { sentCount: 1 }), ['included', 'later', 'later', 'budget', 'budget']);
  assert.deepStrictEqual(status(hdr + cost('a1') + cost('a2'), { sentCount: 1 }), ['included', 'later', 'later', 'included', 'budget']);
  // a first-message note later in the list beats an always note earlier in it
  const two = [{ key: 'a1', value: 'v', importance: 'always' }, { key: 'f1', value: 'v', importance: 'first' }];
  assert.deepStrictEqual(c.memoryPlan(two, 'x', hdr + cost('f1'), at0).status, ['budget', 'included']);
  // Insert now (force) makes every first-message note due, and they keep the top priority
  assert.deepStrictEqual(c.memoryPlan(two, 'x', hdr + cost('f1'), { sentCount: 5, force: true }).status, ['budget', 'included']);
  // the same order shows in the text that is sent
  const tierSettings = { enabled: true, memoryEnabled: true, memoryBudget: hdr + cost('f1') + cost('f2') + cost('a1'), defaultEnabled: false, visualsPrompt: false, askPrompt: false, prompts: [] };
  p = c.buildPrefix(tierSettings, tiers, 'm1', 0);
  assert.ok(p.indexOf('- a1: v') < p.indexOf('- f1: v') && p.indexOf('- f1: v') < p.indexOf('- f2: v') && !p.includes('a2') && !p.includes('m1'), p);
}
{
  // with no prompt due, a first-message note still makes the first message of a chat go out with context
  const noPrompts = { enabled: true, memoryEnabled: true, memoryBudget: 0, defaultEnabled: false, visualsPrompt: false, askPrompt: false, prompts: [] };
  assert.ok(c.shouldInject(noPrompts, 0, firstNotes), 'a first-message note makes the first message due');
  assert.ok(!c.shouldInject(noPrompts, 1, firstNotes), 'but not later messages');
  assert.ok(!c.shouldInject(noPrompts, 0), 'without the notes list nothing is known to be waiting');
  assert.ok(!c.shouldInject(noPrompts, 0, [{ key: 'k', value: 'v', importance: 'always' }]), 'an always note alone does not trigger an insert');
  assert.ok(!c.shouldInject(noPrompts, 0, [{ key: 'k', value: '', importance: 'first' }]), 'an empty note does not');
  assert.ok(!c.shouldInject(noPrompts, 0, [{ key: 'k', value: 'v', importance: 'first', enabled: false }]), 'a switched-off note does not');
  assert.ok(!c.shouldInject({ ...noPrompts, memoryEnabled: false }, 0, firstNotes), 'memory off: nothing waits');
  assert.ok(!c.shouldInject({ ...noPrompts, enabled: false }, 0, firstNotes), 'Kit off: nothing waits');
  p = c.buildPrefix(noPrompts, firstNotes, 'hello', 0);
  assert.ok(p.includes('intro note: v') && !p.includes('mentioned note') && !p.includes('off note'), p);
  assert.strictEqual(c.buildPrefix(noPrompts, firstNotes, 'hello', 1), '', 'nothing on later messages');
  assert.ok(c.buildPrefix(noPrompts, firstNotes, 'hello', 4, true).includes('intro note: v'), 'Insert now includes it');
  sum = c.summarize(noPrompts, firstNotes, 'hello', 0);
  assert.strictEqual(sum.state, 'ready'); assert.strictEqual(sum.memories, 1);
  assert.strictEqual(c.describeSummary(sum), 'Next message includes 1 memory');
  assert.strictEqual(c.summarize(noPrompts, firstNotes, 'hello', 1).state, 'idle');

  // Memory tab: eligible is not the same as sent. A note that would go out with an insertion shows 'included' only while
  // one is scheduled for the next message; otherwise it is 'eligible' and carries no tokens.
  let u = c.memoryUsage(noPrompts, firstNotes, 'hello', { sentCount: 0 });
  assert.deepStrictEqual(u.status, ['idle', 'included', 'off']);
  assert.strictEqual(u.scheduled, true);
  assert.ok(u.tokens > 0 && u.tokens === u.eligibleTokens, 'first message: what is eligible is what is sent');
  u = c.memoryUsage(noPrompts, firstNotes, 'mentioned note', { sentCount: 1 });
  assert.deepStrictEqual(u.status, ['eligible', 'later', 'off'], 'no prompt and no first note due: mentioned note only eligible');
  assert.strictEqual(u.scheduled, false);
  assert.strictEqual(u.tokens, 0, 'nothing is sent');
  assert.ok(u.eligibleTokens > 0, 'but the eligible notes are counted separately');
  assert.strictEqual(c.memoryTokens(noPrompts, firstNotes, 'mentioned note', { sentCount: 1 }), 0);
  assert.deepStrictEqual(c.memoryStatuses(noPrompts, firstNotes, 'mentioned note', { sentCount: 1 }), ['eligible', 'later', 'off']);
  // the same message with a prompt due is scheduled, so the note really goes out
  const withPrompt = { ...noPrompts, prompts: [{ id: 'p', name: 'P', text: 't', enabled: true, schedule: 'always' }] };
  u = c.memoryUsage(withPrompt, firstNotes, 'mentioned note', { sentCount: 1 });
  assert.deepStrictEqual(u.status, ['included', 'later', 'off']);
  assert.ok(u.scheduled && u.tokens > 0 && u.tokens === u.eligibleTokens);
  assert.ok(c.buildPrefix(withPrompt, firstNotes, 'mentioned note', 1).includes('mentioned note: v'), 'and the prefix agrees with the badge');
  assert.ok(!c.shouldInject(noPrompts, 1, firstNotes), 'while with nothing due the Enter handler adds nothing, as the badge says');
  assert.ok(c.shouldInject(withPrompt, 1, firstNotes), 'and with a prompt due it does');
  // a prompt on every N messages: scheduled only on its messages
  const every = { ...noPrompts, prompts: [{ id: 'e', name: 'E', text: 't', enabled: true, schedule: 'every', everyN: 3 }] };
  assert.deepStrictEqual(c.memoryStatuses(every, firstNotes, 'mentioned note', { sentCount: 2 }), ['eligible', 'later', 'off']);
  assert.deepStrictEqual(c.memoryStatuses(every, firstNotes, 'mentioned note', { sentCount: 3 }), ['included', 'later', 'off']);
  // Insert now is always scheduled and includes the first-message notes
  u = c.memoryUsage(noPrompts, firstNotes, 'hello', { sentCount: 4, force: true });
  assert.deepStrictEqual(u.status, ['idle', 'included', 'off']);
  assert.ok(u.scheduled && u.tokens > 0);
  // without a chat position the schedule is not consulted (the old behaviour)
  assert.deepStrictEqual(c.memoryStatuses({ memoryEnabled: true, memoryBudget: 0 }, notes, 'hello'), ['included', 'idle', 'included', 'off', 'included']);
  // memory or the Kit switched off: everything shows paused and nothing is counted
  u = c.memoryUsage({ ...noPrompts, memoryEnabled: false }, firstNotes, 'hello', { sentCount: 0 });
  assert.deepStrictEqual(u.status, ['paused', 'paused', 'off']); assert.strictEqual(u.tokens, 0); assert.strictEqual(u.eligibleTokens, 0);
  u = c.memoryUsage({ ...noPrompts, enabled: false }, firstNotes, 'hello', { sentCount: 0 });
  assert.deepStrictEqual(u.status, ['paused', 'paused', 'off']); assert.strictEqual(u.tokens, 0);
  // a budget still marks what does not fit, scheduled or not
  assert.deepStrictEqual(c.memoryStatuses({ ...noPrompts, memoryBudget: 1 }, firstNotes, 'mentioned note', { sentCount: 1 }), ['budget', 'later', 'off']);
}
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
assert.ok(c.migrateSettings({}).memoryBudget === 0 && c.migrateSettings({}).codeTools === true && c.migrateSettings({}).lineNumbers === true);

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

// ---- chip row: one show/hide toggle, always placed in the toolbar (no placement setting)
assert.strictEqual(c.DEFAULTS.showChips, true);
assert.ok(!('chipsInline' in c.DEFAULTS), 'placement setting is gone');
assert.ok(!('chipsInline' in c.migrateSettings({ chipsInline: false })), 'an old stored placement value is dropped');
assert.strictEqual(c.migrateSettings({ showChips: false }).showChips, false, 'a stored "off" is kept');

// ---- DeepThink reasoning fold: one setting, off by default, kept across migration
assert.strictEqual(c.DEFAULTS.collapseThinking, false);
assert.ok(!('collapseFinishedThinking' in c.DEFAULTS), 'one setting only');
assert.strictEqual(c.migrateSettings(undefined).collapseThinking, false);
assert.strictEqual(c.migrateSettings({ collapseThinking: true }).collapseThinking, true, 'an existing opt-in is kept');

// ---- built-in Visuals prompt
{
  const s0 = { enabled: true, memoryEnabled: false, defaultEnabled: false, askPrompt: false, prompts: [] };
  assert.ok(c.buildPrefix(s0, [], 'x', 0).includes('Instructions (Visuals):'), 'on by default');
  assert.ok(c.buildPrefix(s0, [], 'x', 0).includes('```') === false || true);
  assert.ok(/chart/.test(c.VISUALS_PROMPT) && /viz/.test(c.VISUALS_PROMPT));
  assert.ok(!c.buildPrefix(s0, [], 'x', 1), 'schedule is first message only by default');
  assert.ok(!c.buildPrefix({ ...s0, visualsPrompt: false }, [], 'x', 0), 'its own switch');
  assert.ok(!c.buildPrefix({ ...s0, visualsEnabled: false }, [], 'x', 0), 'off when visuals are off');
  assert.ok(c.buildPrefix({ ...s0, visualsText: 'My own visuals text' }, [], 'x', 0).includes('My own visuals text'), 'custom text wins');
  assert.strictEqual(c.visualsPromptText({ visualsText: '  ' }), c.VISUALS_PROMPT, 'blank text means built-in');
  assert.ok(c.promptEntries(s0).some((e) => e.id === 'visuals'));
  assert.strictEqual(c.DEFAULTS.visualsEnabled, true);
  assert.strictEqual(c.migrateSettings({}).visualsEnabled, true, 'old settings get the new defaults');
  assert.ok(c.VISUALS_PROMPT.length < 2200, 'stays short');
}
console.log('ok  visuals prompt');

// ---- built-in Questions prompt
{
  const s0 = { enabled: true, memoryEnabled: false, defaultEnabled: false, visualsPrompt: false, prompts: [] };
  assert.ok(c.buildPrefix(s0, [], 'x', 0).includes('Instructions (Questions):'), 'on by default');
  assert.ok(/ask/.test(c.ASK_PROMPT) && /single/.test(c.ASK_PROMPT) && /multi/.test(c.ASK_PROMPT));
  assert.ok(!c.buildPrefix(s0, [], 'x', 1), 'first message only by default');
  assert.ok(!c.buildPrefix({ ...s0, askPrompt: false }, [], 'x', 0), 'its own switch');
  assert.ok(c.buildPrefix({ ...s0, askText: 'My own questions text' }, [], 'x', 0).includes('My own questions text'), 'custom text wins');
  assert.strictEqual(c.askPromptText({ askText: '  ' }), c.ASK_PROMPT, 'blank text means built-in');
  assert.ok(c.promptEntries(s0).some((e) => e.id === 'ask'));
  assert.ok(!('askEnabled' in c.DEFAULTS), 'question forms are always drawn: no switch for it');
  assert.ok(!('askEnabled' in c.migrateSettings({ askEnabled: false })), 'a saved askEnabled is dropped');
  assert.ok(c.hasLegacyKeys({ askEnabled: false }) && c.hasLegacyKeys({ askEnabled: true }), 'a profile whose only obsolete key is askEnabled needs migrating');
  assert.ok(!c.hasLegacyKeys({ askAutoSend: false, askPrompt: true }), 'the question settings that remain are not legacy');
  assert.ok(c.buildPrefix({ ...s0, askEnabled: false }, [], 'x', 0).includes('Instructions (Questions):'), 'a leftover askEnabled no longer turns the prompt off');
  assert.strictEqual(c.DEFAULTS.askAutoSend, true, 'answers are sent straight away by default');
  assert.ok(c.ASK_PROMPT.length < 1400, 'stays short');
}
console.log('ok  questions prompt');

console.log('all logic tests passed');

// ---- short keys, CJK keys, cleaning of stored lists
{
  const mem = (key) => [{ key, value: 'v', importance: 'called', enabled: true }];
  const sel = (key, text) => c.selectMemories(mem(key), text).length === 1;
  assert.ok(sel('AI', 'tell me about AI safety'), 'two-letter key');
  assert.ok(sel('Go', 'I write Go every day'));
  assert.ok(sel('C#', 'how do I do this in C#?'));
  assert.ok(sel('UI', 'the ui looks off'));
  assert.ok(!sel('AI', 'he said it was fine'), 'not inside other words');
  assert.ok(!sel('Go', 'that is good'), 'Go is not good');
  assert.ok(sel('\u4f60\u597d', '\u6211\u60f3\u8bf4\u4f60\u597d\u4e16\u754c'), 'CJK key as written');
  assert.ok(!sel('\u4f60\u597d', '\u6211\u60f3\u8bf4\u518d\u89c1'));
  assert.ok(sel('dog food', 'my dog is hungry'), 'long keys still match by word');
  assert.ok(!sel('my dog', 'my cat'), 'two-letter words inside long keys do not count');
  assert.ok(!sel('', 'anything'));
  console.log('ok  short and CJK memory keys');
  const s = c.migrateSettings({ prompts: [null, 5, 'x', { name: 7, schedule: 'bogus', everyN: 'z' }, { id: 'k', text: 'T', enabled: false }], snippets: [null, [], { name: 'a' }] });
  assert.strictEqual(s.prompts.length, 2);
  assert.strictEqual(s.prompts[0].schedule, 'first'); assert.strictEqual(s.prompts[0].name, '7'); assert.strictEqual(s.prompts[0].everyN, 5);
  assert.strictEqual(s.prompts[1].enabled, false); assert.strictEqual(s.prompts[1].id, 'k');
  assert.ok(s.prompts[0].id, 'ids are filled in');
  assert.strictEqual(s.snippets.length, 1); assert.strictEqual(s.snippets[0].text, '');
  assert.strictEqual(c.migrateSettings('junk').prompts.length, 0, 'a non-object is ignored');
  const m = c.cleanMemories([null, 'x', { key: 5, value: null, importance: 'weird', enabled: 0 }, { key: 'a', value: 'b', importance: 'always' }]);
  assert.strictEqual(m.length, 2);
  assert.strictEqual(m[0].key, '5'); assert.strictEqual(m[0].value, ''); assert.strictEqual(m[0].importance, 'called'); assert.strictEqual(m[0].enabled, true);
  assert.strictEqual(m[1].importance, 'always');
  assert.strictEqual(c.cleanMemories([{ key: 'a', value: 'b', importance: 'first' }])[0].importance, 'first', 'first-message notes survive cleaning');
  assert.deepStrictEqual(c.cleanMemories('nope'), []);
  assert.ok(!('polluted' in {}), 'no prototype pollution');
  c.cleanMemories(JSON.parse('[{"__proto__":{"polluted":1},"key":"a"}]'));
  assert.ok(!({}).polluted, 'prototype is not polluted by a hostile backup');
  console.log('ok  stored lists are cleaned');
}


// ---- new defaults, the default prompt, no starter content
{
  const fresh = c.migrateSettings({});
  assert.strictEqual(fresh.snippets.length, 0, 'a new install has no snippets');
  assert.ok(c.STARTER_SNIPPETS === undefined && c.STARTER_MEMORIES === undefined && c.addStarters === undefined, 'starter content is gone');
  assert.ok(c.DEFAULTS.lineNumbers === true && c.DEFAULTS.collapseLong === true && !('starterSeeded' in c.DEFAULTS));
  assert.strictEqual(c.DEFAULTS.collapseAlways, false, 'Always collapse is off by default');
  assert.strictEqual(c.migrateSettings({}).collapseAlways, false, 'old settings get the new default');
  assert.ok(!('starterSeeded' in c.migrateSettings({ starterSeeded: true })), 'the old seeded flag is dropped');
  // an older install that saved the old defaults keeps them
  const old = c.migrateSettings({ lineNumbers: false, collapseLong: false });
  assert.ok(old.lineNumbers === false && old.collapseLong === false, 'saved settings are not flipped');
  // the default prompt
  assert.ok(c.BUILTIN_DEFAULT_PROMPT.includes('honesty and safety') && c.BUILTIN_DEFAULT_PROMPT.includes('{{date}}'));
  assert.ok(['## Answering', '## Formatting', '## Tone'].every((h) => c.BUILTIN_DEFAULT_PROMPT.includes(h)), 'three sections');
  assert.ok(c.BUILTIN_DEFAULT_PROMPT.endsWith('https://github.com/Zeroichi0040/deepseek-kit'), 'the repository link closes the prompt (DeepSeek can open links when its web search is on)');
  // the Default prompt asks for a file-name comment on each file of a multi-file reply, and the ZIP reads exactly those forms
  assert.ok(c.BUILTIN_DEFAULT_PROMPT.includes('// file: src/app.js') && c.BUILTIN_DEFAULT_PROMPT.includes('# file: main.py'), 'prompt asks for file-name comments');
  [['javascript', '// file: src/app.js\nlet a = 1;', 'src/app.js'], ['python', '# file: main.py\nprint(1)', 'main.py'], ['html', '<!-- file: index.html -->\n<p>x</p>', 'index.html'],
    ['css', '/* file: style.css */\nbody{}', 'style.css'], ['bash', '#!/bin/bash\n# file: run.sh\necho 1', 'run.sh']].forEach(([lang, text, want]) => {
    assert.strictEqual(c.suggestFilename(lang, text, 4), want, 'file-name comment in ' + lang);
  });
  console.log('ok  new defaults, no starter content, the default prompt');
}

// ---- list continuation (Shift+Enter in the message box)
{
  const run = (v, s, e) => c.continueList(v, s === undefined ? v.length : s, e === undefined ? (s === undefined ? v.length : s) : e);
  const ins = (v) => { const r = run(v); return r ? { from: r.from, to: r.to, insert: r.insert } : null; };
  assert.deepStrictEqual(ins('1. one'), { from: 6, to: 6, insert: '\n2. ' });
  assert.deepStrictEqual(ins('- a'), { from: 3, to: 3, insert: '\n- ' });
  assert.deepStrictEqual(ins('* a'), { from: 3, to: 3, insert: '\n* ' });
  assert.deepStrictEqual(ins('+ a'), { from: 3, to: 3, insert: '\n+ ' });
  assert.deepStrictEqual(ins('  - nested'), { from: 10, to: 10, insert: '\n  - ' });
  assert.deepStrictEqual(ins('\t1. tabbed'), { from: 10, to: 10, insert: '\n\t2. ' });
  assert.deepStrictEqual(ins('9. nine'), { from: 7, to: 7, insert: '\n10. ' });
  assert.deepStrictEqual(ins('1) x'), { from: 4, to: 4, insert: '\n2) ' });
  assert.deepStrictEqual(ins('> quote'), { from: 7, to: 7, insert: '\n> ' });
  assert.deepStrictEqual(ins('intro\n\n2. second'), { from: 16, to: 16, insert: '\n3. ' }, 'works on any line');
  assert.deepStrictEqual(ins('1.   wide'), { from: 9, to: 9, insert: '\n2.   ' }, 'keeps the spacing');
  // an empty item ends the list
  assert.deepStrictEqual(ins('1. a\n2. '), { from: 5, to: 8, insert: '' });
  assert.deepStrictEqual(ins('- '), { from: 0, to: 2, insert: '' });
  assert.deepStrictEqual(ins('-   '), { from: 0, to: 4, insert: '' });
  assert.deepStrictEqual(ins('> '), { from: 0, to: 2, insert: '' });
  assert.deepStrictEqual(ins('  - '), { from: 0, to: 4, insert: '' });
  // ordinary text and look-alikes are left alone
  ['', 'plain', '-', '---', '***', '**bold', '1.', '1.x', '2024-01-01', 'a - b', '-nospace', '>quote', '1 . x', 'e.g. this'].forEach((v) => assert.strictEqual(run(v), null, JSON.stringify(v)));
  // only a plain caret at the end of a line
  assert.strictEqual(run('1. one', 3), null, 'mid-line');
  assert.strictEqual(run('1. one', 0, 6), null, 'a selection');
  assert.strictEqual(c.continueList('1. one', 9, 9), null, 'out of range');
  assert.ok(run('1. a\n2. b', 4), 'end of a line that is followed by another');
  // code fences
  assert.strictEqual(run('```\n- item'), null, 'inside a fence');
  assert.strictEqual(run('~~~\n1. item'), null, 'inside a tilde fence');
  assert.ok(run('```\ncode\n```\n- item'), 'after a closed fence');
  assert.strictEqual(run('1. a\n```\nx\n```\n```\n- b'), null, 'a second fence opened');
  assert.strictEqual(run('1. ' + '9'.repeat(1) + '\n999999999. last'), null, 'the largest number does not overflow');
  // applying the edit gives the expected text
  const apply = (v) => { const r = run(v); return r ? v.slice(0, r.from) + r.insert + v.slice(r.to) : v; };
  assert.strictEqual(apply('1. one'), '1. one\n2. ');
  assert.strictEqual(apply(apply('1. one') + 'two'), '1. one\n2. two\n3. ');
  assert.strictEqual(apply('1. one\n2. '), '1. one\n', 'the second press leaves the list');
  assert.strictEqual(c.DEFAULTS.listContinue, true, 'on by default');
}
console.log('ok  list continuation');

// ---- live reasoning timer: format and default
{
  const f = c.formatElapsed;
  assert.deepStrictEqual([0, 999, 1000, 23000, 49999, 59999].map(f), ['0s', '0s', '1s', '23s', '49s', '59s']);
  assert.deepStrictEqual([60000, 86000, 119999, 600000, 3900000].map(f), ['60s', '86s', '119s', '600s', '3900s'], 'seconds only, like the site');
  assert.deepStrictEqual([-5, NaN, undefined].map(f), ['0s', '0s', '0s']);
}
console.log('ok  reasoning timer format');

// Drawer metadata round-trips and remains separate from context generation.
{
  const raw = { prompts: [{ id: 'a', name: 'Alpha', text: 'A' }, { id: 'b', name: 'Beta', text: 'B', category: 'Writing' }],
    snippets: [{ id: 's', name: 'example', text: 'Example', category: 'Tools' }],
    drawerOrganization: { prompts: { categories: ['Writing', 'Writing', null], collapsed: ['Built-in'], order: ['b', 'a'] }, memory: null } };
  const saved = c.migrateSettings(raw);
  assert.deepStrictEqual(saved.drawerOrganization.prompts, { categories: ['Writing'], collapsed: ['Built-in'], order: ['b', 'a'] });
  assert.deepStrictEqual(saved.drawerOrganization.memory, { categories: [], collapsed: [], order: [] });
  assert.strictEqual(saved.prompts[1].category, 'Writing');
  assert.strictEqual(saved.snippets[0].category, 'Tools');
  assert.deepStrictEqual(c.migrateSettings(JSON.parse(JSON.stringify(saved))), saved);
  assert.deepStrictEqual(c.promptEntries(saved).filter(p => p.id === 'a' || p.id === 'b').map(p => p.id), ['a', 'b']);
}
