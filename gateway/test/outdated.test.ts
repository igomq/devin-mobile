import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILD, VERSION, installedBuild, isOutdated } from '../src/diagnostics.js';

test('isOutdated: same version and build is current', () => {
  assert.equal(isOutdated({ version: VERSION, build: BUILD }, BUILD), false);
});

test('isOutdated: a gateway from before 0.3.1 reports no build and is outdated', () => {
  assert.equal(isOutdated({ version: '0.3.0' }, BUILD), true);
  assert.equal(isOutdated({ version: VERSION }, '123'), true);
});

test('isOutdated: a rebuilt install marks the running process outdated', () => {
  assert.equal(isOutdated({ version: VERSION, build: '1' }, '2'), true);
});

test('installedBuild matches the build this process loaded', () => {
  assert.equal(installedBuild(), BUILD);
  assert.match(String(BUILD), /^\d+$/);
});
