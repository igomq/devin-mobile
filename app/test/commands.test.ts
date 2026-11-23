import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, commandQuery, commandToken, matchCommands } from '../src/lib/commands.ts';

const claude = [{ name: 'review' }, { name: 'articulate' }, { name: 'code-review' }];
const codex = [{ name: 'review' }, { name: '$articulate' }, { name: '$skill-creator' }];

test('each command keeps its own prefix', () => {
  assert.equal(commandToken({ name: 'review' }), '/review');
  assert.equal(commandToken({ name: '$articulate' }), '$articulate');
});

test('slash lists commands only at the start of the message', () => {
  assert.deepEqual(matchCommands(claude, '/rev').map((c) => c.name), ['review', 'code-review']);
  assert.deepEqual(matchCommands(claude, 'look at src/rev'), []);
  assert.deepEqual(matchCommands(claude, 'hi /rev'), []);
  assert.equal(commandQuery('/review now'), null);
});

test('dollar lists skills anywhere, and every command at the start', () => {
  assert.deepEqual(matchCommands(codex, '$ar').map((c) => c.name), ['$articulate']);
  assert.deepEqual(matchCommands(codex, 'use $sk').map((c) => c.name), ['$skill-creator']);
  assert.deepEqual(matchCommands(codex, '/art').map((c) => c.name), ['$articulate']);
  assert.deepEqual(matchCommands(claude, '$art').map((c) => c.name), ['articulate']);
  assert.deepEqual(matchCommands(claude, 'use $art'), []);
});

test('picking a command inserts its own token in place of the typed word', () => {
  assert.equal(applyCommand('$art', { name: 'articulate' }), '/articulate ');
  assert.equal(applyCommand('/art', { name: '$articulate' }), '$articulate ');
  assert.equal(applyCommand('please use $sk', { name: '$skill-creator' }), 'please use $skill-creator ');
});
