import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';

const SCROLLBACK = 256 * 1024;

export interface TerminalInfo {
  termId: string;
  cwd: string;
  command: string;
  title: string;
  startedAt: number;
  exited: boolean;
  exitCode: number | null;
}

class Term {
  buffer = '';
  exited = false;
  exitCode: number | null = null;
  startedAt = Date.now();
  constructor(public termId: string, public cwd: string, public command: string, public title: string, public proc: pty.IPty) {}
  info(): TerminalInfo {
    return { termId: this.termId, cwd: this.cwd, command: this.command, title: this.title, startedAt: this.startedAt, exited: this.exited, exitCode: this.exitCode };
  }
}

/** PTY terminals that survive client disconnects; scrollback is replayed on attach. */
export class TerminalManager extends EventEmitter {
  terms = new Map<string, Term>();
  private counter = 0;

  constructor(private devinBin: string) {
    super();
  }

  open(opts: { cwd: string; cols?: number; rows?: number; kind?: 'shell' | 'devin'; args?: string[] }): TerminalInfo {
    const shell = process.env.SHELL || '/bin/bash';
    const kind = opts.kind ?? 'shell';
    const file = kind === 'devin' ? this.devinBin : shell;
    const args = kind === 'devin' ? opts.args ?? [] : ['-l'];
    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: Math.max(20, opts.cols ?? 80),
      rows: Math.max(5, opts.rows ?? 24),
      cwd: opts.cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
    });
    const termId = `term_${Date.now().toString(36)}_${++this.counter}`;
    const t = new Term(termId, opts.cwd, [file, ...args].join(' '), kind === 'devin' ? 'devin' : shell.split('/').pop() || 'shell', proc);
    this.terms.set(termId, t);
    proc.onData((d) => {
      t.buffer += d;
      if (t.buffer.length > SCROLLBACK) t.buffer = t.buffer.slice(-SCROLLBACK);
      this.emit('data', termId, d);
    });
    proc.onExit(({ exitCode }) => {
      t.exited = true;
      t.exitCode = exitCode;
      this.emit('exit', t.info());
    });
    return t.info();
  }

  attach(termId: string) {
    const t = this.terms.get(termId);
    if (!t) throw new Error('Terminal not found');
    return { info: t.info(), scrollback: t.buffer };
  }

  write(termId: string, data: string) {
    const t = this.terms.get(termId);
    if (t && !t.exited) t.proc.write(data);
  }

  resize(termId: string, cols: number, rows: number) {
    const t = this.terms.get(termId);
    if (t && !t.exited) t.proc.resize(Math.max(20, cols | 0), Math.max(5, rows | 0));
  }

  close(termId: string) {
    const t = this.terms.get(termId);
    if (!t) return;
    if (!t.exited) t.proc.kill();
    this.terms.delete(termId);
  }

  list(): TerminalInfo[] {
    return [...this.terms.values()].map((t) => t.info());
  }
}
