import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '../src/workspaces.js';

test('WorkspaceStore links multiple harness sessions to one workspace and persists across restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uniharn-ws-test-'));
  try {
    const store1 = new WorkspaceStore(dir);
    const ws = store1.createOrGet('/tmp/my-repo', { name: 'my-repo', harnessId: 'devin' });
    store1.attachSession(ws.workspaceId, { harnessId: 'devin', sessionId: 'devin-1', title: 'Fix bug', updatedAt: 1000 });
    store1.attachSession(ws.workspaceId, { harnessId: 'claude', sessionId: 'claude:c-1', title: 'UI polish', updatedAt: 2000 });

    const store2 = new WorkspaceStore(dir);
    const loaded = store2.get(ws.workspaceId);
    assert.ok(loaded);
    assert.equal(loaded.sessions.length, 2);
    assert.equal(loaded.activeHarnessId, 'claude');
    assert.equal(loaded.activeSessionId, 'claude:c-1');

    store2.removeSession('claude:c-1');
    assert.equal(store2.get(ws.workspaceId)?.sessions.length, 1);
    assert.equal(store2.get(ws.workspaceId)?.activeSessionId, 'devin-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
