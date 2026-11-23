import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

type Json = any;

interface Pending {
  resolve: (v: Json) => void;
  reject: (e: Error) => void;
  method: string;
}

export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: Json) {
    super(message);
  }
}

export interface AcpClientInfo {
  name: string;
  title: string;
  version: string;
}

export interface AcpOptions {
  label?: string;
  cwd?: string;
  clientInfo?: AcpClientInfo;
  protocolVersion?: number;
}

/**
 * Harness-agnostic JSON-RPC 2.0 client for Agent Client Protocol (ACP) over stdio.
 * Emits:
 *  - 'notification' (method, params)
 *  - 'request' (id, method, params)  -> caller must call respond()/respondError()
 *  - 'exit' (code, signal)
 */
export class AcpConnection extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  public initResult: Json = null;
  public stderrTail: string[] = [];
  private label: string;
  private cwd?: string;
  private clientInfo: AcpClientInfo;
  private protocolVersion: number;

  constructor(private bin: string, private args: string[], private env: NodeJS.ProcessEnv, opts: AcpOptions = {}) {
    super();
    this.label = opts.label ?? 'acp';
    this.cwd = opts.cwd;
    this.clientInfo = opts.clientInfo ?? { name: 'uniharn', title: 'uniharn', version: '0.4.1' };
    this.protocolVersion = opts.protocolVersion ?? 1;
  }

  get alive() {
    return this.proc !== null;
  }

  /** True while any request (session/new, session/load, a prompt) is waiting for its answer. */
  get busy() {
    return this.pending.size > 0;
  }

  async start(): Promise<Json> {
    const proc = spawn(this.bin, this.args, {
      env: this.env,
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    // Writing to an agent that is exiting must not crash the gateway; its exit rejects pending requests.
    proc.stdin.on('error', () => undefined);
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this.onLine(line));
    proc.stderr.on('data', (buf: Buffer) => {
      for (const l of buf.toString().split('\n')) {
        if (!l.trim()) continue;
        this.stderrTail.push(l);
        if (this.stderrTail.length > 200) this.stderrTail.shift();
      }
    });
    const spawned = new Promise<void>((resolve, reject) => {
      proc.once('spawn', () => resolve());
      proc.once('error', (err) => reject(err));
    });
    proc.on('exit', (code, signal) => {
      this.proc = null;
      for (const p of this.pending.values()) p.reject(new Error(`${this.label} exited (${code ?? signal}) during ${p.method}`));
      this.pending.clear();
      this.emit('exit', code, signal);
    });
    await spawned;
    this.initResult = await this.request('initialize', {
      protocolVersion: this.protocolVersion,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: this.clientInfo,
    });
    return this.initResult;
  }

  /**
   * Closing stdin lets the agent and its own children exit (codex-acp ignores SIGTERM while its codex child runs,
   * and that child holds the conversation lock). Signals follow if it is still running.
   */
  stop(opts: { idle?: boolean } = {}) {
    const proc = this.proc;
    if (!proc) return;
    proc.stdin?.end();
    // On gateway shutdown there is no time to wait for timers.
    if (!opts.idle) proc.kill('SIGTERM');
    const term = setTimeout(() => proc.exitCode === null && proc.signalCode === null && proc.kill('SIGTERM'), 3000);
    const kill = setTimeout(() => proc.exitCode === null && proc.signalCode === null && proc.kill('SIGKILL'), 8000);
    term.unref();
    kill.unref();
    proc.once('exit', () => {
      clearTimeout(term);
      clearTimeout(kill);
    });
  }

  request(method: string, params: Json, timeoutMs = 0): Promise<Json> {
    if (!this.proc) return Promise.reject(new Error(`ACP agent (${this.label}) is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeoutMs);
      }
      this.pending.set(id, {
        method,
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: Json) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  respond(id: Json, result: Json) {
    this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: Json, code: number, message: string) {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private write(msg: Json) {
    this.proc?.stdin.write(JSON.stringify(msg) + '\n');
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      this.emit('request', msg.id, msg.method, msg.params);
    } else if (msg.method !== undefined) {
      this.emit('notification', msg.method, msg.params);
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
    }
  }
}
