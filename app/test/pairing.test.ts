import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, httpBase, isCompleteCode, normalizeCode, pairDevice, parsePairingInput } from '../src/lib/pairing.ts';

test('normalizeCode uppercases and inserts the hyphen', () => {
	assert.equal(normalizeCode('abcdefgh'), 'ABCD-EFGH');
	assert.equal(normalizeCode(' ab cd-ef gh '), 'ABCD-EFGH');
	assert.equal(normalizeCode('abc'), 'ABC');
	assert.equal(normalizeCode('abcde'), 'ABCD-E');
	assert.equal(normalizeCode('abcdefghijk'), 'ABCD-EFGH');
	assert.ok(isCompleteCode('abcd-efgh'));
	assert.ok(!isCompleteCode('abcd-efg'));
});

test('parsePairingInput reads pairing links, deep links, legacy token links and bare codes', () => {
	assert.deepEqual(parsePairingInput('http://100.64.0.1:8787/#pair=ABCD-EFGH'), { url: 'http://100.64.0.1:8787', code: 'ABCD-EFGH' });
	assert.deepEqual(parsePairingInput('http://100.64.0.1:80/#pair=ABCD-EFGH'), { url: 'http://100.64.0.1:80', code: 'ABCD-EFGH' });
	assert.equal(httpBase(parsePairingInput('http://vm.local/#pair=ABCD-EFGH').url!), 'http://vm.local:80');
	assert.equal(httpBase('http://vm.local'), 'http://vm.local:8787');
	assert.deepEqual(parsePairingInput('https://vm.tail.ts.net/#x=1&pair=abcdefgh'), { url: 'https://vm.tail.ts.net', code: 'ABCD-EFGH' });
	assert.deepEqual(parsePairingInput('https://vm.tail.ts.net/sub/#pair=ABCD-EFGH'), { url: 'https://vm.tail.ts.net/sub', code: 'ABCD-EFGH' });
	assert.deepEqual(parsePairingInput('uniharn://pair?url=' + encodeURIComponent('http://h:8787/') + '&code=abcd-efgh'), { url: 'http://h:8787', code: 'ABCD-EFGH' });
	assert.deepEqual(parsePairingInput('uniharn://pair?code=ABCD-EFGH'), { code: 'ABCD-EFGH' });
	assert.deepEqual(parsePairingInput('http://h:8787/#token=secret%2Fx'), { url: 'http://h:8787', token: 'secret/x' });
	assert.deepEqual(parsePairingInput('  abcd-efgh '), { code: 'ABCD-EFGH' });
	assert.deepEqual(parsePairingInput('ABCDEFGH'), { code: 'ABCD-EFGH' });
	assert.deepEqual(parsePairingInput('not a code'), {});
	assert.deepEqual(parsePairingInput(''), {});
});

test('httpBase follows wsUrl rules', () => {
	assert.equal(httpBase('100.64.0.1'), 'http://100.64.0.1:8787');
	assert.equal(httpBase('my-vm.tailnet.ts.net'), 'http://my-vm.tailnet.ts.net:8787');
	assert.equal(httpBase('host:9000'), 'http://host:9000');
	assert.equal(httpBase('ws://host/ws'), 'http://host:8787');
	assert.equal(httpBase('wss://host.ts.net/ws'), 'https://host.ts.net');
	assert.equal(httpBase('https://host.ts.net/'), 'https://host.ts.net');
	assert.equal(httpBase('http://host:80'), 'http://host:80');
	assert.equal(httpBase('[fd7a::1]'), 'http://[fd7a::1]:8787');
});

test('compareVersions', () => {
	assert.ok(compareVersions('0.3.0', '0.3.0') === 0);
	assert.ok(compareVersions('0.2.9', '0.3.0') < 0);
	assert.ok(compareVersions('0.10.0', '0.9.1') > 0);
});

test('pairDevice maps gateway answers to friendly errors', async () => {
	const realFetch = globalThis.fetch;
	const answer = (status: number, body: object) => (globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch);
	try {
		answer(200, { ok: true, deviceId: 'dev_1', token: 'uhd_x', gatewayId: 'g' });
		assert.equal((await pairDevice('h', 'abcdefgh', 'Phone', 'ios-app')).deviceId, 'dev_1');
		answer(401, { ok: false, error: 'Pairing code has expired' });
		await assert.rejects(pairDevice('h', 'abcdefgh', 'Phone', 'ios-app'), /expired/);
		answer(429, { ok: false, error: 'Too many attempts; try again later' });
		await assert.rejects(pairDevice('h', 'abcdefgh', 'Phone', 'ios-app'), /Too many attempts, wait a minute/);
		globalThis.fetch = (async () => {
			throw new TypeError('Failed to fetch');
		}) as typeof fetch;
		await assert.rejects(pairDevice('h', 'abcdefgh', 'Phone', 'ios-app'), /Tailscale/);
	} finally {
		globalThis.fetch = realFetch;
	}
});
