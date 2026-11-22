import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { Marked } from 'marked';
import type { DiffRow } from './types.ts';

const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => entities[c]);

export function highlight(code: string, lang?: string | null) {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {}
  return esc(code);
}

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const language = (lang || '').trim().split(/\s+/)[0];
      return `<div class="codeblock"><div class="codehead"><span>${esc(language || 'text')}</span><button type="button" data-copy>Copy</button></div><pre><code class="hljs">${highlight(text, language)}</code></pre></div>`;
    }
  }
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function markdown(src: string | null | undefined) {
  return DOMPurify.sanitize(marked.parse(src ?? '', { async: false }), { ADD_ATTR: ['data-copy'] });
}

export function basename(p: string | null | undefined) {
  if (!p) return '';
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || '/';
}

export function shortPath(p: string | null | undefined, home?: string | null) {
  if (!p) return '';
  return home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p;
}

export function ago(iso: string | number | null | undefined) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Elapsed time for a running turn: "8s", "1m 05s", "1h 02m". */
export function duration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor(s / 60) % 60)}m`;
}

// Unified diff text -> rows for rendering. `files` adds a row naming each file of a multi-file patch.
export function parseDiff(text: string | null | undefined, { files = false } = {}) {
  const rows: DiffRow[] = [];
  let a = 0;
  let b = 0;
  // Lines left in the current hunk, so a deleted `-- comment` (`--- comment`) is not read as a file header.
  let leftA = 0;
  let leftB = 0;
  const lines = (text || '').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const inHunk = leftA > 0 || leftB > 0;
    if (!inHunk && line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) {
        a = Number(m[1]);
        b = Number(m[3]);
        leftA = Number(m[2] ?? 1);
        leftB = Number(m[4] ?? 1);
      }
      rows.push({ type: 'hunk', text: line });
    } else if (!inHunk && files && line.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(line);
      rows.push({ type: 'meta', text: m ? m[1] : line.slice(11) });
    } else if (!inHunk && /^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) continue;
    else if (line.startsWith('+')) rows.push({ type: 'add', b: b++, text: line.slice(1) }), leftB--;
    else if (line.startsWith('-')) rows.push({ type: 'del', a: a++, text: line.slice(1) }), leftA--;
    else if (line.startsWith('\\')) rows.push({ type: 'meta', text: line.slice(2) });
    else if (line.startsWith(' ') || inHunk) rows.push({ type: 'ctx', a: a++, b: b++, text: line.slice(1) }), leftA--, leftB--;
    else if (line.startsWith('Binary files')) rows.push({ type: 'meta', text: 'Binary file' });
  }
  return rows;
}

// Line diff for the old/new text an edit tool call reports (small inputs only).
export function lineDiff(oldText: string | null | undefined, newText: string | null | undefined): DiffRow[] {
  const A = (oldText ?? '').split('\n');
  const B = (newText ?? '').split('\n');
  if (A.length * B.length > 250000) return [...A.map((text): DiffRow => ({ type: 'del', text })), ...B.map((text): DiffRow => ({ type: 'add', text }))];
  const n = A.length;
  const m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) rows.push({ type: 'ctx', a: i + 1, b: j + 1, text: A[i++] }), j++;
    else if (L[i + 1][j] >= L[i][j + 1]) rows.push({ type: 'del', a: i + 1, text: A[i++] });
    else rows.push({ type: 'add', b: j + 1, text: B[j++] });
  }
  while (i < n) rows.push({ type: 'del', a: i + 1, text: A[i++] });
  while (j < m) rows.push({ type: 'add', b: j + 1, text: B[j++] });
  // Keep three lines of context around changes.
  const keep = new Uint8Array(rows.length);
  rows.forEach((r, k) => {
    if (r.type !== 'ctx') for (let x = Math.max(0, k - 3); x <= Math.min(rows.length - 1, k + 3); x++) keep[x] = 1;
  });
  const out: DiffRow[] = [];
  rows.forEach((r, k) => {
    if (keep[k]) out.push(r);
    else if (out.length && out[out.length - 1].type !== 'hunk') out.push({ type: 'hunk', text: '⋯' });
  });
  if (out.length && out[out.length - 1].type === 'hunk') out.pop();
  return out;
}
