import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export interface Project {
  path: string;
  name: string;
  isGit: boolean;
}

function isDir(p: string) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Lists candidate working directories: each root itself plus its immediate (non-hidden) children. */
export function listProjects(roots: string[], extra: string[] = []): Project[] {
  const seen = new Map<string, Project>();
  const add = (p: string) => {
    const path = resolve(p);
    if (seen.has(path) || !isDir(path)) return;
    seen.set(path, { path, name: path === homedir() ? '~' : basename(path), isGit: existsSync(join(path, '.git')) });
  };
  for (const e of extra) add(e);
  for (const root of roots) {
    if (!isDir(root)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const p = join(root, name);
      if (isDir(p) && (existsSync(join(p, '.git')) || root !== homedir())) add(p);
    }
  }
  return [...seen.values()];
}

export function listDirectory(path: string) {
  const abs = resolve(path);
  const entries = readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
    .map((d) => ({ name: d.name, path: join(abs, d.name), isGit: existsSync(join(abs, d.name, '.git')) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { path: abs, parent: abs === '/' ? null : resolve(abs, '..'), entries };
}
