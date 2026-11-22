// Shared helpers for the Changes screen's git panels.
import { errorText } from '#lib/api.svelte.ts';
import { ago } from '#lib/format.ts';
import type { ChangedFile } from '#lib/types.ts';
import { toast } from '#lib/ui.svelte.ts';

/** Per-action busy flags: a second tap on the same action while it runs is ignored. */
export class Busy {
  keys = $state<Record<string, boolean>>({});

  is(key: string) {
    return Boolean(this.keys[key]);
  }

  get any() {
    return Object.keys(this.keys).length > 0;
  }

  /** Runs `fn` under `key`. Errors are shown as a toast unless `onError` returns true (handled). */
  async run<T>(key: string, fn: () => Promise<T>, onError?: (e: unknown) => boolean | void): Promise<T | undefined> {
    if (this.keys[key]) return undefined;
    this.keys[key] = true;
    try {
      return await fn();
    } catch (e) {
      if (!onError?.(e)) toast(errorText(e), 'error');
      return undefined;
    } finally {
      delete this.keys[key];
    }
  }
}

/** A destructive (or otherwise consequential) action waiting for the user to confirm it. */
export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  /** Red confirm button; defaults to true. */
  danger?: boolean;
  /** The user must type this exact text before the confirm button enables. */
  typeToConfirm?: string;
  /** The user must tick this statement before the confirm button enables. */
  acknowledge?: string;
  /** An optional extra switch, passed to `run`. */
  option?: { label: string; checked: boolean };
  run: (option: boolean) => Promise<unknown>;
}

export function relTime(t: number | string | null | undefined) {
  const a = ago(t);
  if (!a) return '';
  return a === 'now' ? 'just now' : `${a} ago`;
}

export const ext = (p: string) => (p?.split('.').pop() ?? '').toLowerCase();

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Lines that still look like conflict markers after a manual edit. */
export const hasConflictMarkers = (text: string) => /^(<{7}|={7}|>{7})(\s|$)/m.test(text);

/** Mirrors the gateway's task slug so the form can preview the branch name it will create. */
export const taskSlug = (v: string) => v.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '');

const letters: Record<string, string> = { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', T: 'T', U: '!', '?': 'U' };

/** Status letter for a file row: the index side for staged rows, the working-tree side otherwise. */
export function fileLetter(f: ChangedFile, side: 'staged' | 'unstaged') {
  if (f.status === 'untracked') return 'U';
  if (f.status === 'conflict') return '!';
  const c = side === 'staged' ? f.index : f.worktree;
  return letters[c] ?? 'M';
}

export function fileKind(f: ChangedFile, side: 'staged' | 'unstaged') {
  const l = fileLetter(f, side);
  return l === 'A' || l === 'U' ? 'added' : l === 'D' ? 'deleted' : l === '!' ? 'conflict' : l === 'R' ? 'renamed' : 'modified';
}

/** "Local changes would be overwritten" style refusals from checkout / switch. */
export const isLocalChangesError = (e: unknown) => /would be overwritten|local changes|commit your changes or stash/i.test(errorText(e));

export const isNotMergedError = (e: unknown) => /not fully merged/i.test(errorText(e));
