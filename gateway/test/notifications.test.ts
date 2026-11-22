import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
// @ts-expect-error http_ece ships without types
import ece from 'http_ece';
import webpush from 'web-push';
import { NOTIFICATION_EVENTS, NotificationService, redactSecrets, type NotificationRecord, type SendWebPush } from '../src/notifications.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'uniharn-notif-test-'));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noPush: SendWebPush = async () => ({ statusCode: 201 });

test('every spec section 7 event type fires from its gateway trigger', async () => {
  const dir = tmp();
  const svc = new NotificationService(dir, { sendWebPush: noPush });
  const seen: NotificationRecord[] = [];
  svc.on('notification', (n) => seen.push(n));
  try {
    svc.setPrefs({ attentionTimeoutMs: 1000 });
    svc.onPermissionRequested({ sessionId: 'devin:s1', harnessId: 'devin', title: 'Fix login', requestId: 'r1', command: 'rm -rf build' });
    svc.onSessionState({ sessionId: 'devin:s2', harnessId: 'devin', title: 'Refactor', status: 'running' });
    svc.onSessionState({ sessionId: 'devin:s2', harnessId: 'devin', title: 'Refactor', status: 'idle' });
    svc.onSessionState({ sessionId: 'claude:s3', harnessId: 'claude', title: 'Tests', status: 'running' });
    svc.onSessionState({ sessionId: 'claude:s3', harnessId: 'claude', title: 'Tests', status: 'error', lastError: 'agent crashed' });
    svc.onTaskDone({ taskId: 't1', cwd: '/repo/app', command: 'npm test', exitCode: 1 });
    svc.notifySubagentCompleted({ taskId: 'sub1', harnessId: 'codex', title: 'Write docs', parentSessionId: 'devin:s1' });
    svc.notifyGitConflict('/repo/app', ['src/a.ts', 'src/b.ts']);
    svc.notifyGatewayShutdown('Stopped by SIGTERM.');
    await sleep(1150);
    const types = new Set(seen.map((n) => n.type));
    for (const e of NOTIFICATION_EVENTS) assert.ok(types.has(e), `missing ${e}`);
    const approval = seen.find((n) => n.type === 'approval_requested')!;
    assert.equal(approval.route, '#/s/devin%3As1');
    assert.match(approval.body, /rm -rf build/);
    assert.ok(seen.some((n) => n.type === 'execution_failed' && /npm test exited with 1/.test(n.body)));
    assert.ok(seen.some((n) => n.type === 'attention_needed' && n.sessionId === 'devin:s1'));
    const seqs = seen.map((n) => n.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length);
  } finally {
    svc.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicates are suppressed inside the dedup window and allowed after it', () => {
  const dir = tmp();
  let now = 1_000_000;
  const svc = new NotificationService(dir, { sendWebPush: noPush, now: () => now });
  try {
    const first = svc.notify({ type: 'git_conflict', title: 'Conflict', dedupKey: 'k' });
    assert.ok(first);
    now += 30_000;
    assert.equal(svc.notify({ type: 'git_conflict', title: 'Conflict', dedupKey: 'k' }), null);
    now += 31_000;
    assert.ok(svc.notify({ type: 'git_conflict', title: 'Conflict', dedupKey: 'k' }));
    // Same permission request reported twice yields one notification.
    svc.onPermissionRequested({ sessionId: 's', requestId: 'r', title: 'x' });
    svc.onPermissionRequested({ sessionId: 's', requestId: 'r', title: 'x' });
    assert.equal(svc.list().notifications.filter((n) => n.type === 'approval_requested').length, 1);
    // Same conflict set on repeated git.status polls fires once; a new set fires again.
    assert.ok(svc.notifyGitConflict('/r', ['a']));
    assert.equal(svc.notifyGitConflict('/r', ['a']), null);
    assert.ok(svc.notifyGitConflict('/r', ['a', 'b']));
  } finally {
    svc.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconnecting clients catch up by sequence and read state is tracked', () => {
  const dir = tmp();
  const svc = new NotificationService(dir, { sendWebPush: noPush, maxItems: 5 });
  try {
    for (let i = 0; i < 8; i++) svc.notify({ type: 'task_completed', title: `Done ${i}`, dedupKey: `d${i}` });
    const all = svc.list();
    assert.equal(all.lastSeq, 8);
    assert.equal(all.notifications.length, 5, 'ring buffer keeps the newest items');
    const missed = svc.list({ sinceSeq: 6 });
    assert.deepEqual(missed.notifications.map((n) => n.seq), [7, 8]);
    assert.equal(missed.unreadCount, 5);
    svc.markRead([missed.notifications[0].id]);
    assert.equal(svc.unreadCount(), 4);
    assert.equal(svc.list({ unreadOnly: true }).notifications.length, 4);
    svc.markRead();
    assert.equal(svc.unreadCount(), 0);
    svc.clear();
    assert.equal(svc.list().notifications.length, 0);
    assert.equal(svc.list().lastSeq, 8, 'sequence stays monotonic after clear');
  } finally {
    svc.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secrets are redacted and Web Push payloads hide details by default', () => {
  assert.equal(redactSecrets('Authorization: Bearer abcdefghijklmnop'), 'Authorization: Bearer [redacted]');
  assert.doesNotMatch(redactSecrets('use sk-proj-abcdefghijklmnopqrstu now'), /sk-proj/);
  assert.doesNotMatch(redactSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123'), /ghp_/);
  assert.doesNotMatch(redactSecrets('tskey-auth-abcdef123456'), /tskey-auth/);
  assert.doesNotMatch(redactSecrets('https://host/#token=deadbeefcafe'), /deadbeef/);
  assert.doesNotMatch(redactSecrets('mysql -u root password=hunter22'), /hunter22/);

  const dir = tmp();
  const svc = new NotificationService(dir, { sendWebPush: noPush });
  try {
    svc.onPermissionRequested({ sessionId: 's', requestId: 'r', title: 'Deploy', command: 'curl -H "Authorization: Bearer abcdefghijklmnop" https://api' });
    const rec = svc.list().notifications[0];
    assert.doesNotMatch(rec.body, /abcdefghijklmnop/);
    const hidden = svc.pushPayload(rec);
    assert.equal(hidden.title, 'uniharn');
    assert.equal(hidden.body, 'A session is waiting for your approval.');
    assert.doesNotMatch(JSON.stringify(hidden), /Deploy|curl/);
    svc.setPrefs({ hideSensitiveDetails: false });
    const shown = svc.pushPayload(rec);
    assert.equal(shown.title, 'Deploy needs approval');
    assert.match(shown.body, /curl/);
    assert.doesNotMatch(shown.body, /abcdefghijklmnop/);
  } finally {
    svc.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preferences persist privately and disabled events do not fire', () => {
  const dir = tmp();
  try {
    const a = new NotificationService(dir, { sendWebPush: noPush });
    const defaults = a.getPrefs();
    assert.equal(defaults.enabled, true);
    assert.equal(defaults.hideSensitiveDetails, true);
    assert.equal(defaults.dedupWindowMs, 60_000);
    assert.equal(defaults.attentionTimeoutMs, 300_000);
    a.setPrefs({ events: { task_completed: false } as any, webPush: false });
    a.dispose();
    const file = join(dir, 'notifications-prefs.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'notifications-vapid.json')).mode & 0o777, 0o600);

    const b = new NotificationService(dir, { sendWebPush: noPush });
    assert.equal(b.getPrefs().events.task_completed, false);
    assert.equal(b.getPrefs().events.git_conflict, true);
    assert.equal(b.getPrefs().webPush, false);
    assert.equal(b.notify({ type: 'task_completed', title: 'x' }), null);
    assert.ok(b.notify({ type: 'git_conflict', title: 'y' }));
    b.setPrefs({ enabled: false });
    assert.equal(b.notify({ type: 'git_conflict', title: 'z' }), null);
    b.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('attention timers clear when approvals resolve or sessions show activity', async () => {
  const dir = tmp();
  const svc = new NotificationService(dir, { sendWebPush: noPush });
  try {
    svc.setPrefs({ attentionTimeoutMs: 1000 });
    svc.onPermissionRequested({ sessionId: 's', requestId: 'r1', title: 'A' });
    svc.onSessionState({ sessionId: 's', title: 'A', status: 'running' });
    await sleep(600);
    svc.onPermissionResolved('s', 'r1');
    svc.onSessionActivity('s', null, 'A');
    await sleep(600);
    assert.equal(svc.list().notifications.filter((n) => n.type === 'attention_needed').length, 0);
    svc.onSessionState({ sessionId: 's', title: 'A', status: 'idle' });
    await sleep(1600);
    assert.equal(svc.list().notifications.filter((n) => n.type === 'attention_needed').length, 0, 'leaving running disarms the stall timer');
    svc.onSessionState({ sessionId: 's', title: 'A', status: 'running' });
    await sleep(2150);
    assert.equal(svc.list().notifications.filter((n) => n.type === 'attention_needed').length, 1, 'a run with no activity for 2x the timeout needs attention');
  } finally {
    svc.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Web Push is VAPID-signed, aes128gcm-encrypted, and dead subscriptions are dropped', async (t) => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
  } catch {
    t.skip('openssl not available');
    return;
  }
  const dir = tmp();
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
  const received: { url: string; headers: Record<string, any>; body: Buffer }[] = [];
  const server = https.createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.statusCode = req.url === '/gone' ? 410 : 201;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const agent = new https.Agent({ rejectUnauthorized: false });
  const svc = new NotificationService(dir, {
    sendWebPush: (sub, payload, opts) => webpush.sendNotification(sub, payload, { ...opts, agent }),
  });
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const auth = randomBytes(16);
    const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
    svc.subscribe({ endpoint: `https://127.0.0.1:${port}/live`, keys }, 'test phone');
    svc.subscribe({ endpoint: `https://127.0.0.1:${port}/gone`, keys });
    assert.equal(svc.listSubscriptions().length, 2);
    assert.equal(statSync(join(dir, 'notifications-push-subs.json')).mode & 0o777, 0o600);

    const rec = svc.notify({ type: 'approval_requested', title: 'Secret project needs approval', body: 'Run: deploy', sessionId: 'devin:s9' })!;
    const result = await svc.waitForPush(rec.id);
    assert.deepEqual(result, { sent: 1, failed: 1, removed: 1 });

    const live = received.find((r) => r.url === '/live')!;
    assert.match(String(live.headers.authorization), /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    assert.match(String(live.headers.authorization), new RegExp(`k=${svc.publicKey()}`));
    assert.equal(live.headers['content-encoding'], 'aes128gcm');
    assert.equal(live.headers.urgency, 'high');
    assert.ok(live.body.length > 0);
    assert.equal(live.body.includes(Buffer.from('Secret project')), false, 'body is encrypted');
    const plain = JSON.parse(ece.decrypt(live.body, { version: 'aes128gcm', privateKey: ecdh, authSecret: keys.auth }).toString('utf8'));
    assert.equal(plain.type, 'approval_requested');
    assert.equal(plain.route, '#/s/devin%3As9');
    assert.equal(plain.body, 'A session is waiting for your approval.');
    assert.doesNotMatch(JSON.stringify(plain), /Secret project|deploy/);

    const left = svc.listSubscriptions();
    assert.equal(left.length, 1, 'HTTP 410 subscription removed');
    assert.equal(left[0].label, 'test phone');
    assert.equal(JSON.stringify(left).includes(keys.auth), false, 'subscription list never exposes keys');
    const reloaded = new NotificationService(dir, { sendWebPush: noPush });
    assert.equal(reloaded.listSubscriptions().length, 1);
    assert.equal(reloaded.publicKey(), svc.publicKey(), 'VAPID keys persist across restarts');
    reloaded.dispose();
  } finally {
    svc.dispose();
    server.close();
    agent.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('subscriptions require an https endpoint and keys; VAPID keys can come from env', () => {
  const dir = tmp();
  try {
    const keys = webpush.generateVAPIDKeys();
    const svc = new NotificationService(dir, { sendWebPush: noPush, env: { UNIHARN_VAPID_PUBLIC_KEY: keys.publicKey, UNIHARN_VAPID_PRIVATE_KEY: keys.privateKey } });
    assert.equal(svc.publicKey(), keys.publicKey);
    assert.throws(() => svc.subscribe({ endpoint: 'http://evil', keys: { p256dh: 'a', auth: 'b' } }));
    assert.throws(() => svc.subscribe({ endpoint: 'https://push.example', keys: undefined as any }));
    svc.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('platform capabilities report native push limits honestly', () => {
  const dir = tmp();
  const svc = new NotificationService(dir, { sendWebPush: noPush });
  try {
    const c = svc.getCapabilities();
    assert.equal(c.inApp.status, 'available');
    assert.equal(c.webPush.status, 'available');
    assert.equal(c.webPush.background, true);
    assert.equal(c.androidFcm.status, 'requires_external_setup');
    assert.equal(c.androidFcm.background, false);
    assert.equal(c.iosApns.status, 'blocked_by_signing');
    assert.match(c.iosApns.detail, /aps-environment/);
  } finally {
    svc.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
