// Persistent localStorage helper with transparent migration from legacy `devin-mobile.*` keys.
const NEW_PREFIX = 'uniharn.';
const LEGACY_PREFIX = 'devin-mobile.';

export function getStorageItem(suffix: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  const key = NEW_PREFIX + suffix;
  const val = localStorage.getItem(key);
  if (val !== null) return val;
  const legacyKey = LEGACY_PREFIX + suffix;
  const legacyVal = localStorage.getItem(legacyKey);
  if (legacyVal !== null) {
    try {
      localStorage.setItem(key, legacyVal);
    } catch {
      // Ignore storage quota errors; legacy value still works.
    }
    return legacyVal;
  }
  return null;
}

export function setStorageItem(suffix: string, value: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(NEW_PREFIX + suffix, value);
}

export function removeStorageItem(suffix: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(NEW_PREFIX + suffix);
  localStorage.removeItem(LEGACY_PREFIX + suffix);
}
