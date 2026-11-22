#!/usr/bin/env node
/**
 * `uniharn-mcp`: a stdio MCP server that lets any agent delegate work to other uniharn harnesses
 * through the local gateway (`orchestration.delegate`, `harnesses.list`, `orchestration.list`).
 */
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

type Json = any;
export type GatewayCall = (type: string, params: Json) => Promise<Json>;

export const MCP_TOOLS = [
  {
    name: 'list_harnesses',
    description: 'List the coding harnesses (Devin, Codex, Claude Code, OpenCode, ...) available on this uniharn gateway.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'delegate_task',
    description:
      'Run a task as a subagent on another harness and wait for its final reply. Use worktree=true to isolate its file changes on a new git branch.',
    inputSchema: {
      type: 'object',
      properties: {
        harnessId: { type: 'string', description: 'Harness id from list_harnesses, e.g. "claude" or "codex".' },
        task: { type: 'string', description: 'Self-contained instructions for the subagent.' },
        cwd: { type: 'string', description: 'Project folder. Defaults to the folder this MCP server was started in.' },
        worktree: { type: 'boolean', description: 'Run in a new git worktree (branch uniharn/sub-*) instead of the folder itself.' },
      },
      required: ['harnessId', 'task'],
    },
  },
  {
    name: 'list_delegations',
    description: 'List earlier delegations and handoffs with their status, output, worktree and branch.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const textResult = (value: Json, isError = false) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

async function callTool(name: string, args: Json, call: GatewayCall, defaultCwd: string): Promise<Json> {
  switch (name) {
    case 'list_harnesses': {
      const { harnesses } = await call('harnesses.list', {});
      return textResult(
        harnesses.map((h: Json) => ({ id: h.id, name: h.name, installed: h.installed, enabled: h.enabled, status: h.status })),
      );
    }
    case 'delegate_task': {
      const { link } = await call('orchestration.delegate', {
        harnessId: args?.harnessId,
        task: args?.task,
        cwd: args?.cwd || defaultCwd,
        worktree: !!args?.worktree,
        wait: true,
      });
      const header = [`status: ${link.status}`, `session: ${link.childSessionId}`, link.branch ? `branch: ${link.branch} (${link.worktree})` : null]
        .filter(Boolean)
        .join('\n');
      return textResult(`${header}\n\n${link.output ?? link.error ?? ''}`, link.status === 'error');
    }
    case 'list_delegations': {
      const { links } = await call('orchestration.list', {});
      return textResult(links);
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

/** Handles one MCP JSON-RPC message; returns the response, or null for notifications. */
export async function handleMcpMessage(msg: Json, call: GatewayCall, defaultCwd = process.cwd()): Promise<Json | null> {
  const reply = (result: Json) => ({ jsonrpc: '2.0', id: msg.id, result });
  if (msg.id === undefined || msg.id === null) return null;
  try {
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'uniharn', version: '0.3.0' },
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: MCP_TOOLS });
      case 'tools/call':
        try {
          return reply(await callTool(msg.params?.name, msg.params?.arguments ?? {}, call, defaultCwd));
        } catch (e: Json) {
          if (e?.code) throw e;
          return reply(textResult(String(e?.message ?? e), true));
        }
      default:
        return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
  } catch (e: Json) {
    return { jsonrpc: '2.0', id: msg.id, error: { code: e?.code ?? -32603, message: String(e?.message ?? e) } };
  }
}

/** Connects to the gateway and returns a request function once `hello` succeeds. */
export function connectGateway(url: string, token: string, onClose?: () => void): Promise<GatewayCall> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map<number, { res: (v: Json) => void; rej: (e: Error) => void }>();
    let next = 1;
    const call: GatewayCall = (type, params) =>
      new Promise((res, rej) => {
        if (ws.readyState !== WebSocket.OPEN) return rej(new Error('Gateway connection closed'));
        const id = next++;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, type, ...params }));
      });
    ws.on('message', (data) => {
      const m = JSON.parse(String(data));
      if (m.type !== 'response') return;
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.res(m.result);
      else p.rej(new Error(m.error));
    });
    ws.on('error', reject);
    ws.on('close', () => {
      for (const p of pending.values()) p.rej(new Error('Gateway connection closed'));
      pending.clear();
      onClose?.();
    });
    ws.on('open', () => call('hello', { token }).then(() => resolve(call), reject));
  });
}

async function main() {
  const { loadConfig } = await import('./config.js');
  const config = loadConfig({ argv: process.argv, detectTailscale: () => null });
  const url = process.env.UNIHARN_GATEWAY_URL ?? `ws://${config.hosts[0].includes(':') ? `[${config.hosts[0]}]` : config.hosts[0]}:${config.port}/ws`;
  let gateway: Promise<GatewayCall> | null = null;
  const call: GatewayCall = async (type, params) => {
    gateway ??= connectGateway(url, config.token, () => {
      gateway = null;
    }).catch((e) => {
      gateway = null;
      throw new Error(`Cannot reach the uniharn gateway at ${url}: ${e?.message ?? e}`);
    });
    return (await gateway)(type, params);
  };
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const res = await handleMcpMessage(msg, call, process.env.UNIHARN_SESSION_CWD || process.cwd());
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
  rl.on('close', () => process.exit(0));
}

const entry = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === entry) void main();
