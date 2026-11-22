import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function redactSecrets(text: string, extraSecrets: string[] = []): string {
  const explicit = [...new Set(extraSecrets.filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const value = [
    ...explicit.map((secret) => String.raw`${secret}(?=$|[\s&#"'<>;,])`),
    String.raw`"[^"]*"|'[^']*'|[^\s&#"'<>;,]+`,
  ].join('|');
  const patterns = [
    String.raw`(\b[Bb][Ee][Aa][Rr][Ee][Rr]\s+|\b[Tt][Oo][Kk][Ee][Nn]=|\b[Cc][Oo][Dd][Ee]=)(?:${value})`,
    String.raw`uhd_[A-Za-z0-9_-]+`,
    ...explicit,
  ];
  return text.replace(new RegExp(patterns.join('|'), 'g'), (_match, prefix?: string) => `${prefix ?? ''}[REDACTED]`);
}

export class RateLimiter {
  private failures = new Map<string, number[]>();
  private nextSweep = 0;

  constructor(
    private maxFailures = 10,
    private windowMs = 60_000,
    private now = Date.now,
  ) {}

  check(key: string): boolean {
    return this.retryAfterMs(key) === 0;
  }

  recordFailure(key: string): void {
    const now = this.now();
    if (now >= this.nextSweep) {
      for (const knownKey of this.failures.keys()) this.recentFailures(knownKey, now);
      this.nextSweep = now + this.windowMs;
    }
    const recent = this.recentFailures(key, now);
    if (recent.length < this.maxFailures) {
      recent.push(now);
      this.failures.set(key, recent);
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  retryAfterMs(key: string): number {
    const now = this.now();
    const recent = this.recentFailures(key, now);
    return recent.length >= this.maxFailures ? recent[0] + this.windowMs - now : 0;
  }

  private recentFailures(key: string, now: number): number[] {
    const recent = this.failures.get(key);
    if (!recent) return [];
    while (recent.length && recent[0] <= now - this.windowMs) recent.shift();
    if (!recent.length) this.failures.delete(key);
    return recent;
  }
}

export function isRunningAsRoot(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

export function isPublicBindHost(host: string): boolean {
  return ['0.0.0.0', '::', '*', ''].includes(host.trim());
}

function realpathWithMissingSuffix(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A dangling symlink must never be treated as a missing directory.
    if (lstatSync(path, { throwIfNoEntry: false })) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(realpathWithMissingSuffix(parent), basename(path));
  }
}

function withinRoots(target: string, roots: string[]): boolean {
  return roots.some((root) => {
    try {
      const rel = relative(realpathWithMissingSuffix(resolve(root)), target);
      return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    } catch {
      return false;
    }
  });
}

export function isPathWithinRoots(targetPath: string, roots: string[]): boolean {
  try {
    return withinRoots(realpathWithMissingSuffix(resolve(targetPath)), roots);
  } catch {
    return false;
  }
}

export function assertAllowedPath(targetPath: string, roots: string[], strictRoots: boolean): string {
  const resolved = resolve(targetPath);
  if (!strictRoots) return resolved;
  try {
    const canonical = realpathWithMissingSuffix(resolved);
    if (withinRoots(canonical, roots)) return canonical;
  } catch {
    // Reject paths whose ancestors could not be checked.
  }
  throw new Error('Path is outside allowed roots');
}
