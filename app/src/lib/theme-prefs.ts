import { ACCENTS, DEFAULT_THEME_PREFS, THEMES, getTheme, isCustomAccent } from './themes.ts';
import type { Accent, Appearance, ThemePrefs } from './themes.ts';

export const LEGACY_THEME_IDS = { dark: 'uniharn-dark', dim: 'uniharn-dim', light: 'uniharn-light' };
const legacyThemes = new Map(Object.entries(LEGACY_THEME_IDS));
const themeIds = new Set(THEMES.map(({ id }) => id));

export function normalizeAccent(value: string | null): Accent {
  if (value && isCustomAccent(value)) return value.toLowerCase() as Accent;
  return ACCENTS.find(({ id }) => id === value)?.id ?? 'theme';
}

export function readThemePrefs(storage: Pick<Storage, 'getItem'>): ThemePrefs {
  const storedTheme = storage.getItem('theme');
  const manual = legacyThemes.get(storedTheme ?? '') ??
    (storedTheme && themeIds.has(storedTheme) ? storedTheme : null);
  function readSlot(key: string, appearance: Appearance, fallback: string) {
    const id = storage.getItem(key);
    return id && themeIds.has(id) && getTheme(id).appearance === appearance ? id : fallback;
  }

  const follow = storage.getItem('themeFollowSystem');
  return {
    theme: manual ?? DEFAULT_THEME_PREFS.theme,
    followSystem: follow === 'true' || (follow !== 'false' && !manual),
    lightTheme: readSlot('themeLight', 'light', DEFAULT_THEME_PREFS.lightTheme),
    darkTheme: readSlot('themeDark', 'dark', DEFAULT_THEME_PREFS.darkTheme),
    accent: normalizeAccent(storage.getItem('accent'))
  };
}

export function writeThemePrefs(storage: Pick<Storage, 'setItem'>, prefs: ThemePrefs) {
  storage.setItem('theme', prefs.theme);
  storage.setItem('themeFollowSystem', String(prefs.followSystem));
  storage.setItem('themeLight', prefs.lightTheme);
  storage.setItem('themeDark', prefs.darkTheme);
  storage.setItem('accent', prefs.accent);
}
