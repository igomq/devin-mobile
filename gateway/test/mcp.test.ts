import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpMessage, type GatewayCall } from '../src/mcp.js';

test('uniharn-mcp exposes delegation tools and forwards calls to the gateway', async () => {
  const calls: [string, any][] = [];
  const call: GatewayCall = async (type, params) => {
    calls.push([type, params]);
    if (type === 'harnesses.list') return { harnesses: [{ id: 'claude', name: 'Claude Code', installed: true, enabled: true, status: 'idle', capabilities: {} }] };
    if (type === 'orchestration.delegate')
      return { link: { status: 'done', childSessionId: 'claude:s1', branch: 'uniharn/sub-1', worktree: '/r/.uniharn/worktrees/1', output: 'all done' } };
    throw new Error('boom');
  };

  const init = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, call);
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, call), null);

  const list = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, call);
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ['list_harnesses', 'delegate_task', 'list_delegations']);

  const hs = await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_harnesses' } }, call);
  assert.equal(JSON.parse(hs.result.content[0].text)[0].id, 'claude');

  const d = await handleMcpMessage(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'delegate_task', arguments: { harnessId: 'claude', task: 'write tests', worktree: true } } },
    call,
    '/repo',
  );
  assert.deepEqual(calls.at(-1), ['orchestration.delegate', { harnessId: 'claude', task: 'write tests', cwd: '/repo', worktree: true, wait: true }]);
  assert.match(d.result.content[0].text, /status: done\nsession: claude:s1\nbranch: uniharn\/sub-1/);
  assert.match(d.result.content[0].text, /all done$/);
  assert.equal(d.result.isError, undefined);

  const bg = await handleMcpMessage(
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'delegate_task', arguments: { harnessId: 'claude', task: 'review', model: 'opus', background: true } } },
    call,
    '/repo',
    'ref-1',
  );
  assert.deepEqual(calls.at(-1), ['orchestration.delegate', { harnessId: 'claude', task: 'review', cwd: '/repo', worktree: false, model: 'opus', sessionRef: 'ref-1', wait: false }]);
  assert.equal(bg.result.isError, undefined);

  const failed = await handleMcpMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_delegations' } }, call);
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.content[0].text, 'boom');

  const unknown = await handleMcpMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } }, call);
  assert.equal(unknown.error.code, -32602);
  const missing = await handleMcpMessage({ jsonrpc: '2.0', id: 7, method: 'resources/list' }, call);
  assert.equal(missing.error.code, -32601);
});
