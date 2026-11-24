import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

/** Joins PATH lists, dropping empty and repeated entries while keeping the first occurrence's order. */
export function mergePath(...lists: (string | null | undefined)[]): string {
  const seen = new Set<string>();
  for (const list of lists) {
    for (const dir of (list ?? '').split(delimiter)) if (dir) seen.add(dir);
  }
  return [...seen].join(delimiter);
}

/**
 * Directories where agent CLIs and their ACP adapters are commonly installed but which a service
 * manager, tmux or a non-login shell may leave off PATH.
 */
export function fallbackBinDirs(home = homedir()): string[] {
  const dirs = [
    dirname(process.execPath),
    join(home, '.local', 'bin'),
    join(home, '.grok', 'bin'),
    join(home, '.local', 'opt', 'node', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.opencode', 'bin'),
    join(home, '.volta', 'bin'),
  ];
  try {
    const nvm = join(home, '.nvm', 'versions', 'node');
    dirs.push(...readdirSync(nvm).sort().reverse().map((version) => join(nvm, version, 'bin')));
  } catch {
    // No nvm installs.
  }
  dirs.push('/usr/local/bin', '/opt/homebrew/bin');
  return dirs;
}

/** PATH as the user's login shell sets it up (profile files included), or null when it cannot be read. */
export function loginShellPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform === 'win32' || env.UNIHARN_LOGIN_SHELL_PATH === '0') return null;
  const shell = env.SHELL || '/bin/sh';
  const marker = '__UNIHARN_PATH__';
  // Profile scripts and anything they start must not see the master token.
  const { UNIHARN_TOKEN: _token, DEVIN_MOBILE_TOKEN: _legacyToken, ...shellEnv } = env;
  try {
    const result = spawnSync(shell, ['-lc', `printf '${marker}%s${marker}' "$PATH"`], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], env: shellEnv,
    });
    const match = result.stdout?.match(new RegExp(`${marker}(.*)${marker}`, 's'));
    return match?.[1].trim() || null;
  } catch {
    return null;
  }
}

/** The PATH the gateway runs with: its own, then the login shell's, then the usual install directories. */
export function gatewayPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return mergePath(env.PATH, loginShellPath(env), fallbackBinDirs(home).join(delimiter));
}
