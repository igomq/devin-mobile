import test from 'node:test';
import assert from 'node:assert/strict';
import { base64Bytes, decodeText, isMarkdown, isTextFile } from '../src/lib/textfile.ts';

test('text files are recognized by type or extension', () => {
  assert.equal(isTextFile({ name: 'notes.md', type: '' }), true);
  assert.equal(isTextFile({ name: 'a.bin', type: 'text/plain' }), true);
  assert.equal(isTextFile({ name: 'photo.png', type: 'image/png' }), false);
  assert.equal(isMarkdown('README.MD'), true);
  assert.equal(isMarkdown('a.txt'), false);
});

test('decodeText detects UTF-8, BOMs, UTF-16 and EUC-KR', () => {
  assert.equal(decodeText(new TextEncoder().encode('안녕 hello')), '안녕 hello');
  assert.equal(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])), 'hi');
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x48, 0xc5, 0x55, 0xb1])), '안녕');
  assert.equal(decodeText(new Uint8Array([0xbe, 0xc8, 0xb3, 0xe7])), '안녕');
  assert.equal(decodeText(base64Bytes(btoa('plain'))), 'plain');
});

test('attached files are split out of user messages, live and replayed', async () => {
  const { applyUpdate, emptyState } = await import('../src/lib/timeline.ts');
  const view: any = { epoch: null, seq: 0, cwd: null, items: [], tools: {}, state: emptyState(), ready: true, error: null, truncated: false };
  const resource = { type: 'resource', resource: { uri: 'attachment:///%EB%A9%94%EB%AA%A8.md', mimeType: 'text/markdown', text: '# hi' } };
  applyUpdate(view, { sessionUpdate: 'user_message_chunk', _local: true, _content: [{ type: 'text', text: 'look' }, resource] });
  assert.equal(view.items[0].text, 'look');
  assert.deepEqual(view.items[0].files, [{ name: '메모.md', mimeType: 'text/markdown', text: '# hi' }]);
  applyUpdate(view, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
  applyUpdate(view, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'again' } });
  applyUpdate(view, { sessionUpdate: 'user_message_chunk', content: { type: 'resource', resource: { uri: 'file:///a.txt', mimeType: 'text/plain', blob: btoa('plain') } } });
  assert.equal(view.items.length, 3);
  assert.equal(view.items[2].text, 'again');
  assert.deepEqual(view.items[2].files, [{ name: 'a.txt', mimeType: 'text/plain', text: 'plain' }]);
});
