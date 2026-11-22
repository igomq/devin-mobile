import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACCENTS, FAMILIES, THEMES, contrast, getTheme, themeVars } from '../src/lib/themes.ts';

const REQUIRED: Record<string, string[]> = {
  uniharn: ['Dark', 'Dim', 'Light'],
  Absolutely: ['Light', 'Dark'],
  Ayu: ['Light', 'Dark', 'Mirage'],
  Catppuccin: ['Latte', 'Frappé', 'Macchiato', 'Mocha'],
  Dracula: ['Dark'],
  Everforest: ['Light', 'Dark'],
  GitHub: ['Light', 'Dark'],
  Gruvbox: ['Light', 'Dark'],
  Linear: ['Light', 'Dark']
};
const COLOR = /^(#[\da-f]{6}([\da-f]{2})?|rgba?\(\s*\d{1,3},\s*\d{1,3},\s*\d{1,3}(,\s*[\d.]+)?\))$/i;

test('every required family and variant is registered once', () => {
  assert.deepEqual(FAMILIES.map((f) => f.name), Object.keys(REQUIRED));
  for (const f of FAMILIES) assert.deepEqual(f.variants.map((v) => v.name), REQUIRED[f.name], f.name);
  assert.equal(new Set(THEMES.map((t) => t.id)).size, THEMES.length);
  for (const t of THEMES) {
    assert.match(t.id, /^[a-z]+(-[a-z]+)+$/);
    assert.match(t.source, /^https:\/\//);
  }
});

test('every token, ANSI and syntax value is a color', () => {
  for (const t of THEMES) {
    for (const [group, values] of Object.entries({ tokens: t.tokens, ansi: t.ansi, syntax: t.syntax })) {
      for (const [k, v] of Object.entries(values)) {
        if (k === 'glassShadow') continue;
        assert.match(v, COLOR, `${t.id} ${group}.${k} = ${v}`);
      }
    }
    assert.equal(Object.keys(t.ansi).length, 20, t.id);
  }
});

test('text, status and syntax colors stay readable on every theme', () => {
  const failures: string[] = [];
  const need = (id: string, what: string, fg: string, bg: string, min: number) => {
    const c = contrast(fg, bg);
    if (c < min) failures.push(`${id} ${what} ${fg} on ${bg}: ${c.toFixed(2)} < ${min}`);
  };
  for (const t of THEMES) {
    const k = t.tokens;
    need(t.id, 'text', k.text, k.bg, 7);
    need(t.id, 'text-2', k.text2, k.bg, 4.5);
    need(t.id, 'text-3', k.text3, k.bg, 3);
    need(t.id, 'text on elevated', k.text, k.bgElev, 4.5);
    need(t.id, 'on-accent', k.onAccent, k.accent, 4.5);
    for (const s of ['green', 'red', 'amber', 'blue'] as const) need(t.id, s, k[s], k.bg, 3);
    for (const [s, c] of Object.entries(t.syntax)) need(t.id, `syntax ${s}`, c, k.codeBg, 3);
    need(t.id, 'terminal fg', t.ansi.foreground, t.ansi.background, 4.5);
  }
  assert.deepEqual(failures, []);
});

test('themeVars defines every theme variable app.css reads', () => {
  const css = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  for (const t of THEMES) {
    const vars = themeVars(t);
    for (const name of Object.keys(vars)) assert.ok(defined.has(name), `${name} has a :root default in app.css`);
    for (const name of used) {
      if (/^--(safe|bar|vvh|column|r-|radius|ease|mono|sans|glass-blur|glass-drop|accent-soft$|accent-text$|fill)/.test(name)) continue;
      assert.ok(name in vars, `${t.id} sets ${name}`);
    }
  }
});

test('the default theme matches the first paint defaults in app.css', () => {
  const css = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  for (const [name, value] of Object.entries(themeVars(getTheme('uniharn-dark')))) {
    const m = new RegExp(`${name}:\\s*([^;]+);`).exec(root);
    if (m) assert.equal(m[1].trim(), value, name);
  }
});

test('accents resolve to readable on-accent colors', () => {
  for (const t of THEMES) {
    for (const accent of [...ACCENTS.map((a) => a.id), '#ffee00', '#101010', '#7f7f7f'] as const) {
      const vars = themeVars(t, accent);
      assert.ok(contrast(vars['--on-accent'], vars['--accent']) >= 4.5, `${t.id} ${accent}`);
    }
    assert.equal(themeVars(t, 'theme')['--accent'], t.tokens.accent);
    assert.equal(themeVars(t, '#123456')['--accent'], '#123456');
  }
});
