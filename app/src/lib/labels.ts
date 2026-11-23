/** Short harness name for sentences: "OpenAI Codex CLI" -> "Codex", "Devin CLI" -> "Devin". */
export function shortHarnessName(name: string | null | undefined) {
  const short = (name ?? '').trim().replace(/^OpenAI\s+/i, '').replace(/\s+CLI$/i, '').trim();
  return short || (name ?? '').trim();
}

/** Whether a session folder is one of the gateway's scratch folders for sessions without a project. */
export function isScratchPath(cwd: string | null | undefined, scratchDir: string | null | undefined) {
  if (!cwd || !scratchDir) return false;
  const root = scratchDir.replace(/\/+$/, '');
  return cwd === root || cwd.startsWith(root + '/');
}

/** Folder name shown for a session; scratch folders read as "No project". */
export function projectLabel(cwd: string | null | undefined, scratchDir: string | null | undefined) {
  if (isScratchPath(cwd, scratchDir)) return 'No project';
  if (!cwd) return '';
  const parts = cwd.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || '/';
}
