import { AcpHarnessAdapter, type AcpHarnessSpec } from './acp-generic.js';
import type { CustomAcpHarnessSpec } from './types.js';

/**
 * Built-in non-Devin harnesses, all driven over ACP. Harnesses without a documented ACP
 * entrypoint are `verified: false`: listed, but disabled until the user points them at an
 * ACP-compatible command.
 */
export const BUILTIN_ACP_SPECS: AcpHarnessSpec[] = [
  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    bin: 'codex-acp',
    acpArgs: [],
    installHint: 'npm i -g @openai/codex @agentclientprotocol/codex-acp',
    authMethod: 'codex login',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude-agent-acp',
    altBins: ['claude-code-acp'],
    acpArgs: [],
    installHint: 'npm i -g @agentclientprotocol/claude-agent-acp',
    authMethod: 'claude /login',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    bin: 'opencode',
    acpArgs: ['acp'],
    installHint: 'curl -fsSL https://opencode.ai/install | bash',
    authMethod: 'opencode auth login',
  },
  {
    id: 'kiro',
    name: 'Kiro CLI',
    bin: 'kiro-cli',
    acpArgs: ['acp'],
    installHint: 'curl -fsSL https://cli.kiro.dev/install | bash',
    authMethod: 'kiro-cli login',
  },
  {
    id: 'command-code',
    name: 'Command Code',
    bin: 'cmd',
    acpArgs: [],
    verified: false,
    installHint: 'npm i -g command-code',
    note: 'No documented ACP entrypoint for Command Code; set bin/args to an ACP-compatible command to enable.',
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    bin: 'antigravity',
    acpArgs: [],
    verified: false,
    installHint: 'https://antigravity.google',
    note: 'Antigravity is an IDE without a documented ACP CLI entrypoint; set bin/args to an ACP-compatible command to enable.',
  },
];

export function createBuiltinAcpAdapters(): AcpHarnessAdapter[] {
  return BUILTIN_ACP_SPECS.map((s) => new AcpHarnessAdapter(s));
}

export function createCustomAcpAdapter(spec: CustomAcpHarnessSpec): AcpHarnessAdapter {
  return new AcpHarnessAdapter({
    id: spec.id,
    name: spec.name,
    bin: spec.command,
    acpArgs: spec.args ?? [],
    cwd: spec.cwd,
    envAllowlist: spec.envAllowlist,
    enabled: spec.enabled ?? true,
    custom: true,
  });
}
