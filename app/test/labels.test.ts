import test from 'node:test';
import assert from 'node:assert/strict';
import { isScratchPath, projectLabel, shortHarnessName } from '../src/lib/labels.ts';

test('harness names shorten for sentences', () => {
  assert.equal(shortHarnessName('OpenAI Codex CLI'), 'Codex');
  assert.equal(shortHarnessName('Devin CLI'), 'Devin');
  assert.equal(shortHarnessName('Claude Code'), 'Claude Code');
  assert.equal(shortHarnessName('Gemini CLI'), 'Gemini');
  assert.equal(shortHarnessName('CLI'), 'CLI');
  assert.equal(shortHarnessName(undefined), '');
});

test('scratch folders read as "No project"', () => {
  const scratch = '/home/u/.uniharn/scratch';
  assert.equal(projectLabel(scratch + '/20261123-101500-a1b2c3', scratch), 'No project');
  assert.equal(projectLabel('/home/u/repos/app', scratch), 'app');
  assert.equal(projectLabel('/home/u/repos/app/', null), 'app');
  assert.equal(projectLabel('/home/u/.uniharn/scratchpad', scratch), 'scratchpad');
  assert.equal(projectLabel('', scratch), '');
  assert.equal(isScratchPath(scratch + '/x', scratch + '/'), true);
  assert.equal(isScratchPath('/elsewhere/x', scratch), false);
  assert.equal(isScratchPath('/home/u/x', undefined), false);
});
