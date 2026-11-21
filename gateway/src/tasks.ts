import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TaskRun {
  taskId: string;
  cwd: string;
  command: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  output: string;
  truncated: boolean;
}

const MAX_OUTPUT = 512 * 1024;

/** Guess a reasonable test command for a project directory. */
export function detectTestCommand(cwd: string): string | null {
  const pkg = join(cwd, 'package.json');
  if (existsSync(pkg)) {
    try {
      const p = JSON.parse(readFileSync(pkg, 'utf8'));
      if (p.scripts?.test) {
        const pm = existsSync(join(cwd, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(cwd, 'yarn.lock')) ? 'yarn' : existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock')) ? 'bun' : 'npm';
        return `${pm} test`;
      }
    } catch {
      /* ignore */
    }
  }
  if (existsSync(join(cwd, 'Cargo.toml'))) return 'cargo test';
  if (existsSync(join(cwd, 'go.mod'))) return 'go test ./...';
  if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'pytest.ini')) || existsSync(join(cwd, 'setup.py'))) return 'python -m pytest -q';
  if (existsSync(join(cwd, 'Makefile'))) return 'make test';
  return null;
}

/** Runs one-off commands (tests, builds) and keeps their results for the Changes screen. */
export class TaskRunner extends EventEmitter {
  runs = new Map<string, TaskRun>();
  private procs = new Map<string, ChildProcess>();
  private counter = 0;

  start(cwd: string, command: string): TaskRun {
    const taskId = `task_${Date.now().toString(36)}_${++this.counter}`;
    const run: TaskRun = { taskId, cwd, command, startedAt: Date.now(), endedAt: null, exitCode: null, output: '', truncated: false };
    this.runs.set(taskId, run);
    const shell = process.env.SHELL || '/bin/bash';
    const proc = spawn(shell, ['-lc', command], { cwd, detached: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
    this.procs.set(taskId, proc);
    const onData = (buf: Buffer) => {
      const chunk = buf.toString();
      if (run.output.length < MAX_OUTPUT) run.output += chunk;
      else run.truncated = true;
      this.emit('output', run, chunk);
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('close', (code) => {
      run.exitCode = code ?? -1;
      run.endedAt = Date.now();
      this.procs.delete(taskId);
      this.emit('done', run);
    });
    proc.on('error', (err) => onData(Buffer.from(`\n${err.message}\n`)));
    this.prune();
    return run;
  }

  /** Signals the whole process group so child processes of the shell stop too. */
  stop(taskId: string) {
    const proc = this.procs.get(taskId);
    if (!proc?.pid) return;
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      proc.kill('SIGTERM');
    }
  }

  stopAll() {
    for (const id of this.procs.keys()) this.stop(id);
  }

  list(cwd?: string): Omit<TaskRun, 'output'>[] {
    return [...this.runs.values()]
      .filter((r) => !cwd || r.cwd === cwd)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(({ output: _o, ...rest }) => rest);
  }

  private prune() {
    const all = [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
    for (const r of all.slice(30)) if (r.endedAt) this.runs.delete(r.taskId);
  }
}
