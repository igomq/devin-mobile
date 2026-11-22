import test from 'node:test';
import assert from 'node:assert/strict';
import { readThemePrefs, writeThemePrefs } from '../src/lib/theme-prefs.ts';
import { DEFAULT_THEME_PREFS, resolveThemeId } from '../src/lib/themes.ts';

function storage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

test('a fresh install follows the system with the uniharn themes', () => {
  assert.deepEqual(readThemePrefs(storage()), DEFAULT_THEME_PREFS);
  assert.equal(resolveThemeId(DEFAULT_THEME_PREFS, true), 'uniharn-dark');
  assert.equal(resolveThemeId(DEFAULT_THEME_PREFS, false), 'uniharn-light');
});

test('old Light/Dark/Dim/System and accent settings migrate', () => {
  assert.equal(readThemePrefs(storage({ theme: 'system' })).followSystem, true);
  for (const [old, id] of [['dark', 'uniharn-dark'], ['dim', 'uniharn-dim'], ['light', 'uniharn-light']]) {
    const p = readThemePrefs(storage({ theme: old, accent: 'mono' }));
    assert.equal(p.followSystem, false, old);
    assert.equal(resolveThemeId(p, old === 'light'), id);
    assert.equal(p.accent, 'theme');
  }
  assert.equal(readThemePrefs(storage({ accent: 'violet' })).accent, 'violet');
  assert.equal(readThemePrefs(storage({ accent: '#AABBCC' })).accent, '#aabbcc');
  assert.equal(readThemePrefs(storage({ accent: 'nonsense' })).accent, 'theme');
});

test('a fixed theme ignores the system appearance', () => {
  const p = { ...DEFAULT_THEME_PREFS, followSystem: false, theme: 'gruvbox-light' };
  assert.equal(resolveThemeId(p, true), 'gruvbox-light');
  assert.equal(resolveThemeId(p, false), 'gruvbox-light');
});

test('following the system switches between the chosen light and dark themes', () => {
  const p = { ...DEFAULT_THEME_PREFS, lightTheme: 'catppuccin-latte', darkTheme: 'catppuccin-mocha' };
  assert.equal(resolveThemeId(p, false), 'catppuccin-latte');
  assert.equal(resolveThemeId(p, true), 'catppuccin-mocha');
  // A slot holding a theme of the wrong appearance falls back instead of showing a light theme in dark mode.
  assert.equal(resolveThemeId({ ...p, darkTheme: 'github-light' }, true), 'uniharn-dark');
});

test('preferences survive a round trip through storage', () => {
  const s = storage();
  const p = { theme: 'dracula-dark', followSystem: false, lightTheme: 'ayu-light', darkTheme: 'ayu-mirage', accent: '#ff5c9a' as const };
  writeThemePrefs(s, p);
  assert.deepEqual(readThemePrefs(s), p);
  writeThemePrefs(s, { ...p, followSystem: true });
  assert.equal(readThemePrefs(s).followSystem, true);
});

test('unknown or mismatched stored ids fall back safely', () => {
  const p = readThemePrefs(storage({ theme: 'solarized-dark', themeLight: 'linear-dark', themeDark: 'nope' }));
  assert.equal(p.theme, DEFAULT_THEME_PREFS.theme);
  assert.equal(p.lightTheme, 'uniharn-light');
  assert.equal(p.darkTheme, 'uniharn-dark');
});
