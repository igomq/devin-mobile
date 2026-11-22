import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpConnection } from '../src/acp.js';

const MOCK_AGENT = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'mock-agent', version: '1.0.0' },
        agentCapabilities: { sessionCapabilities: { list: true, close: true } },
        receivedClient: msg.params.clientInfo
      }
    }) + '\\n');
  } else if (msg.method === 'echo') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { ok: true } }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: { toolCall: { title: 'run' } } }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echo: msg.params } }) + '\\n');
  } else if (msg.id === 99) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'perm_ack', params: msg.result }) + '\\n');
  }
});
`;

test('AcpConnection initializes with uniharn clientInfo and exchanges requests/notifications', async () => {
  const conn = new AcpConnection(process.execPath, ['-e', MOCK_AGENT], process.env, { label: 'mock-acp' });
  const notifications: Array<{ method: string; params: any }> = [];
  conn.on('notification', (method, params) => notifications.push({ method, params }));
  conn.on('request', (id, method) => {
    if (method === 'session/request_permission') conn.respond(id, { outcome: { outcome: 'selected', optionId: 'allow' } });
  });

  const init = await conn.start();
  assert.equal(init.agentInfo.name, 'mock-agent');
  assert.equal(init.receivedClient.name, 'uniharn');
  assert.equal(init.receivedClient.title, 'uniharn');

  const res = await conn.request('echo', { hello: 'world' }, 5000);
  assert.deepEqual(res, { echo: { hello: 'world' } });

  await new Promise((r) => setTimeout(r, 50));
  assert.ok(notifications.some((n) => n.method === 'session/update' && n.params.ok === true));
  assert.ok(notifications.some((n) => n.method === 'perm_ack' && n.params?.outcome?.optionId === 'allow'));

  conn.stop();
});
