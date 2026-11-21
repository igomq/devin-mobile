// Tiny hash router and UI preferences.
export interface Route {
  name: 'home' | 'session' | 'settings' | 'terminal';
  id?: string;
  tab?: string;
  login?: boolean;
}

function parse(): Route {
  const h = typeof location === 'undefined' ? '' : location.hash.replace(/^#\/?/, '');
  const [pathPart, query = ''] = h.split('?');
  const [name, ...rest] = pathPart.split('/');
  if (name === 's' && rest[0]) return { name: 'session', id: decodeURIComponent(rest[0]), tab: rest[1] || 'chat' };
  if (name === 'settings') return { name: 'settings' };
  if (name === 'terminal') return { name: 'terminal', login: query === 'login' };
  return { name: 'home' };
}

export const route = $state<Route>(parse());
const stored = (k: string) => (typeof localStorage !== 'undefined' && localStorage.getItem(k)) || null;
export const THEMES = ['system', 'dark', 'dim', 'light'] as const;
export const ACCENTS = [
  { id: 'mono', color: 'var(--text)' },
  { id: 'blue', color: '#4c8dff' },
  { id: 'violet', color: '#8b6cff' },
  { id: 'teal', color: '#1fb5b0' },
  { id: 'green', color: '#2fbf71' },
  { id: 'orange', color: '#ff8a3d' },
  { id: 'pink', color: '#ff5c9a' }
] as const;
export const prefs = $state({ theme: stored('devin-mobile.theme') || 'system', accent: stored('devin-mobile.accent') || 'mono' });

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    const r = parse();
    Object.assign(route, { id: undefined, tab: undefined, login: undefined }, r);
  });
}

export function go(hash: string, replace = false) {
  if (replace) location.replace(hash);
  else location.hash = hash;
}

export function back(fallback = '#/') {
  if (history.length > 1 && document.referrer !== undefined && history.state !== 'root') history.back();
  else go(fallback, true);
}

export function setTheme(theme: string) {
  prefs.theme = theme;
  localStorage.setItem('devin-mobile.theme', theme);
  applyTheme();
}

export function setAccent(accent: string) {
  prefs.accent = accent;
  localStorage.setItem('devin-mobile.accent', accent);
  applyTheme();
}

export function applyTheme() {
  const root = document.documentElement;
  if (prefs.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', prefs.theme);
  root.setAttribute('data-accent', prefs.accent);
  // Match the status bar to the page background.
  requestAnimationFrame(() => {
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', bg));
    // Resolve --bg on a probe: the body's own background is mid-transition right after a theme switch.
    const probe = document.createElement('i');
    probe.style.cssText = 'display:none;transition:none;background-color:var(--bg)';
    document.body.append(probe);
    const rgb = getComputedStyle(probe).backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number);
    probe.remove();
    if (!rgb || rgb.length < 3) return;
    const hex = '#' + rgb.map((n) => n.toString(16).padStart(2, '0')).join('');
    const dark = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] < 140;
    // Android shell only (src-tauri/android/MainActivity.kt).
    (window as { DevinMobileAndroid?: { setBars(color: string, dark: boolean): void } }).DevinMobileAndroid?.setBars(hex, dark);
  });
}

if (typeof window !== 'undefined') {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
}

export const toasts = $state<{ id: number; text: string; kind: 'info' | 'error' }[]>([]);
export function toast(text: string, kind: 'info' | 'error' = 'info') {
  const t = { id: Math.random(), text, kind };
  toasts.push(t);
  setTimeout(() => {
    const i = toasts.findIndex((x) => x.id === t.id);
    if (i >= 0) toasts.splice(i, 1);
  }, 3200);
}
