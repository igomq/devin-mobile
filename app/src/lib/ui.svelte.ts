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
export const prefs = $state({ theme: (typeof localStorage !== 'undefined' && localStorage.getItem('devin-mobile.theme')) || 'system' });

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

export function applyTheme() {
  const root = document.documentElement;
  if (prefs.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', prefs.theme);
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
