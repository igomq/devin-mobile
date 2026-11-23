/** What a user types to run an agent command: Codex lists skills as `$name`, everything else is `/name`. */
export function commandToken(c: { name: string }): string {
  return c.name.startsWith('$') ? c.name : '/' + c.name;
}

/** The `/` or `$` word being typed at the end of `text`, if any. `/` only counts at the start of the message. */
export function commandQuery(text: string): { start: number; prefix: '/' | '$'; q: string } | null {
  const m = /(^|\s)([/$])([^\s/$]*)$/.exec(text);
  if (!m) return null;
  const start = m.index + m[1].length;
  if (m[2] === '/' && start !== 0) return null;
  return { start, prefix: m[2] as '/' | '$', q: m[3].toLowerCase() };
}

/**
 * Commands, skills and plugins matching what is being typed. `/` lists every command; `$` lists skills
 * named `$...` anywhere in the message, and every command at its start (inserted with its own prefix).
 */
export function matchCommands<T extends { name: string }>(commands: T[], text: string, limit = 50): T[] {
  const query = commandQuery(text);
  if (!query) return [];
  const pool = query.prefix === '$' && query.start !== 0 ? commands.filter((c) => c.name.startsWith('$')) : commands;
  const key = (c: T) => c.name.replace(/^\$/, '').toLowerCase();
  const starts = pool.filter((c) => key(c).startsWith(query.q));
  const contains = pool.filter((c) => !key(c).startsWith(query.q) && key(c).includes(query.q));
  return [...starts, ...contains].slice(0, limit);
}

/** `text` with the word being typed replaced by the command's own token. */
export function applyCommand(text: string, c: { name: string }): string {
  const query = commandQuery(text);
  return (query ? text.slice(0, query.start) : text) + commandToken(c) + ' ';
}
