import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Json = any;
export interface ModelChoice {
  value: string;
  name: string;
}

/** Per-harness policy applied to sessions uniharn creates for delegation. */
export interface SubagentPolicy {
  /** ACP mode id, or a value of the harness's mode/permission config option. Null keeps the harness choice. */
  mode: string | null;
  /** Extra session config values, keyed by config option id (reasoning effort, fast mode, ...). */
  config: Record<string, string | boolean>;
  /** When false, delegation to this harness is refused before a session is created. */
  enabled: boolean;
}

export interface SubagentHarnessInfo {
  harnessId: string;
  model: string | null;
  models: ModelChoice[];
  policy: SubagentPolicy;
  /** Non-model session config options the harness has exposed, for Settings > Subagents. */
  options: Json[];
  /** Legacy ACP session modes the harness has exposed. */
  modes: Json[];
}

/** Live sessions by the ref their uniharn MCP server was started with, so a delegation knows its parent. */
export const sessionRefs = new Map<string, { harnessId: string; sessionId: string }>();

const catalog = new Map<string, ModelChoice[]>();
const optionCatalog = new Map<string, Json[]>();
const modeCatalog = new Map<string, Json[]>();
let onCatalogChange: (() => void) | null = null;

export function modelOptionOf(configOptions: Json[] | undefined): Json | null {
  return (configOptions ?? []).find((o) => o?.category === 'model' || o?.id === 'model') ?? null;
}

function optionValues(opt: Json): Json[] {
  return (opt?.options ?? []).flatMap((x: Json) => (Array.isArray(x?.options) ? x.options : [x])).filter((x: Json) => x && typeof x === 'object');
}

function sameJson(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Remembers the models a harness offers, from any of its sessions' config options. */
export function noteModels(harnessId: string, configOptions: Json[] | undefined) {
  const opt = modelOptionOf(configOptions);
  if (!opt || !Array.isArray(opt.options)) return;
  const models: ModelChoice[] = optionValues(opt)
    .filter((x: Json) => typeof x?.value === 'string')
    .map((x: Json) => ({ value: x.value, name: typeof x.name === 'string' && x.name ? x.name : x.value }));
  if (!models.length || sameJson(catalog.get(harnessId), models)) return;
  catalog.set(harnessId, models);
  onCatalogChange?.();
}

/** Remembers non-model config options so Settings can offer delegation effort/fast/mode values. */
export function noteConfigOptions(harnessId: string, configOptions: Json[] | undefined) {
  const options = (configOptions ?? [])
    .filter((o) => o && typeof o.id === 'string' && o.id !== 'model' && o.category !== 'model')
    .map((o) => ({ id: o.id, name: o.name ?? o.id, description: o.description ?? null, category: o.category ?? null, type: o.type ?? 'select', options: o.options ?? [] }));
  if (!options.length || sameJson(optionCatalog.get(harnessId), options)) return;
  optionCatalog.set(harnessId, options);
  onCatalogChange?.();
}

/** Remembers ACP session modes for harnesses that still report them instead of a mode config option. */
export function noteModes(harnessId: string, modes: Json | null | undefined) {
  const list = (modes?.availableModes ?? [])
    .filter((m: Json) => m && typeof m.id === 'string')
    .map((m: Json) => ({ id: m.id, name: m.name ?? m.id, description: m.description ?? null }));
  if (!list.length || sameJson(modeCatalog.get(harnessId), list)) return;
  modeCatalog.set(harnessId, list);
  onCatalogChange?.();
}

function choiceText(c: Json): string {
  return `${c?.id ?? ''} ${c?.value ?? ''} ${c?.name ?? ''} ${c?.description ?? ''}`.toLowerCase();
}

/** Mode identity without the free-text description, so prose like "the agent ..." cannot impersonate a mode. */
function choiceIdentity(c: Json): string {
  return `${c?.id ?? ''} ${c?.value ?? ''} ${c?.name ?? ''}`.toLowerCase();
}

export function isUnsafeModeChoice(c: Json): boolean {
  return /bypass|danger|yolo|full[-_ ]?access|skip[-_ ]?permissions/.test(choiceText(c));
}

const STRONG_AUTONOMY = /\b(auto|agent|unattended|non[-_ ]?interactive|trusted)\b/;
const EDIT_AUTONOMY = /\b(accept[-_ ]?edits?|workspace[-_ ]?write|code)\b/;

export function isAutonomousModeChoice(c: Json): boolean {
  if (isUnsafeModeChoice(c)) return false;
  const text = choiceIdentity(c);
  return STRONG_AUTONOMY.test(text) || EDIT_AUTONOMY.test(text);
}

export function isInteractiveModeChoice(c: Json): boolean {
  return /ask|manual|confirm|approval|permission|default|read[-_ ]?only|plan/.test(choiceText(c));
}

function modeConfigOption(configOptions: Json[] | undefined): Json | null {
  return (
    (configOptions ?? []).find((o) => {
      if (!o || o.category === 'model' || o.id === 'model' || optionValues(o).length === 0) return false;
      const text = `${o.id ?? ''} ${o.name ?? ''} ${o.category ?? ''}`;
      if (/fast|speed|turbo|priority|tier|thought|thinking|effort|reason|collaboration|model_config/i.test(text)) return false;
      return o.category === 'mode' || o.id === 'mode' || /mode|permission|approval/i.test(text);
    }) ?? null
  );
}

export function modeChoices(configOptions: Json[] | undefined, modes: Json | null | undefined): Json[] {
  const opt = modeConfigOption(configOptions);
  if (opt) return optionValues(opt).map((v) => ({ ...v, source: 'config', configId: opt.id }));
  return (modes?.availableModes ?? []).map((m: Json) => ({ ...m, source: 'mode' }));
}

export function findModeChoice(configOptions: Json[] | undefined, modes: Json | null | undefined, modeId: string): Json | null {
  const choices = modeChoices(configOptions, modes);
  return choices.find((c) => c?.value === modeId || c?.id === modeId) ?? null;
}

/** Safest autonomous delegation mode exposed by the harness; bypass/full-access choices are never automatic. */
export function recommendedDelegationMode(configOptions: Json[] | undefined, modes: Json | null | undefined): Json | null {
  const choices = modeChoices(configOptions, modes);
  const score = (c: Json) => {
    if (!isAutonomousModeChoice(c)) return -1;
    return STRONG_AUTONOMY.test(choiceIdentity(c)) ? 1 : 0;
  };
  return choices.map((c, i) => ({ c, i, s: score(c) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s || a.i - b.i)[0]?.c ?? null;
}

function currentModeChoice(configOptions: Json[] | undefined, modes: Json | null | undefined): Json | null {
  const opt = modeConfigOption(configOptions);
  if (opt) {
    const current = optionValues(opt).find((v) => String(v?.value) === String(opt.currentValue)) ?? { value: opt.currentValue, name: String(opt.currentValue) };
    return { ...current, source: 'config', configId: opt.id };
  }
  const id = modes?.currentModeId;
  return id ? { id, value: id, name: id, source: 'mode' } : null;
}

/** Explains why a delegated session would be stuck on per-action approval, or null when it can run unattended. */
export function delegationApprovalProblem(configOptions: Json[] | undefined, modes: Json | null | undefined): string | null {
  const choices = modeChoices(configOptions, modes);
  if (!choices.length) return null;
  const autonomous = choices.filter(isAutonomousModeChoice);
  if (autonomous.length) return null;
  const current = currentModeChoice(configOptions, modes);
  if (current && isInteractiveModeChoice(current)) {
    return `only offers per-action approval (${choices.map((c) => c.name ?? c.value ?? c.id).join(', ')})`;
  }
  return null;
}

/** Default model per harness for subagents, kept apart from the model each chat session uses. */
export class SubagentSettings {
  private file: string;
  private defaults: Record<string, string> = {};
  private policies: Record<string, SubagentPolicy> = {};

  constructor(dataDir: string) {
    this.file = join(dataDir, 'subagents.json');
    try {
      if (existsSync(this.file)) {
        const data = JSON.parse(readFileSync(this.file, 'utf8'));
        for (const [k, v] of Object.entries(data?.defaults ?? {})) if (typeof v === 'string' && v) this.defaults[k] = v;
        for (const [k, v] of Object.entries(data?.models ?? {})) if (Array.isArray(v) && !catalog.has(k)) catalog.set(k, v as ModelChoice[]);
        for (const [k, v] of Object.entries(data?.options ?? {})) if (Array.isArray(v) && !optionCatalog.has(k)) optionCatalog.set(k, v);
        for (const [k, v] of Object.entries(data?.modes ?? {})) if (Array.isArray(v) && !modeCatalog.has(k)) modeCatalog.set(k, v);
        for (const [k, v] of Object.entries(data?.policies ?? {})) {
          const p = v as Partial<SubagentPolicy>;
          this.policies[k] = {
            mode: typeof p?.mode === 'string' && p.mode ? p.mode : null,
            config: p?.config && typeof p.config === 'object' ? Object.fromEntries(Object.entries(p.config).filter(([, x]) => typeof x === 'string' || typeof x === 'boolean')) : {},
            enabled: p?.enabled !== false,
          };
        }
      }
    } catch {
      // Start empty on a damaged file.
    }
    onCatalogChange = () => {
      try {
        this.save();
      } catch {
        // Losing the model list only costs a reload; it must not break a session.
      }
    };
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + '.tmp';
    writeFileSync(
      tmp,
      JSON.stringify(
        {
          defaults: this.defaults,
          models: Object.fromEntries(catalog),
          options: Object.fromEntries(optionCatalog),
          modes: Object.fromEntries(modeCatalog),
          policies: this.policies,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    renameSync(tmp, this.file);
  }

  defaultModel(harnessId: string): string | null {
    return this.defaults[harnessId] ?? null;
  }

  setDefault(harnessId: string, model: string | null) {
    const before = this.defaults[harnessId];
    if (model) this.defaults[harnessId] = model;
    else delete this.defaults[harnessId];
    try {
      this.save();
    } catch (e) {
      if (before) this.defaults[harnessId] = before;
      else delete this.defaults[harnessId];
      throw e;
    }
  }

  policy(harnessId: string): SubagentPolicy {
    const p = this.policies[harnessId];
    return { mode: p?.mode ?? null, config: { ...(p?.config ?? {}) }, enabled: p?.enabled !== false };
  }

  setPolicy(harnessId: string, patch: { mode?: string | null; config?: Record<string, string | boolean>; enabled?: boolean }) {
    const before = this.policy(harnessId);
    const next: SubagentPolicy = { ...before, config: { ...before.config } };
    if ('mode' in patch) next.mode = typeof patch.mode === 'string' && patch.mode ? patch.mode : null;
    if ('enabled' in patch) next.enabled = patch.enabled !== false;
    if (patch.config && typeof patch.config === 'object') {
      next.config = {};
      for (const [k, v] of Object.entries(patch.config)) if (typeof v === 'string' || typeof v === 'boolean') next.config[k] = v;
    }
    const empty = !next.mode && !Object.keys(next.config).length && next.enabled;
    if (empty) delete this.policies[harnessId];
    else this.policies[harnessId] = next;
    try {
      this.save();
    } catch (e) {
      if (before.mode || Object.keys(before.config).length || !before.enabled) this.policies[harnessId] = before;
      else delete this.policies[harnessId];
      throw e;
    }
  }

  list(): SubagentHarnessInfo[] {
    const ids = new Set([...Object.keys(this.defaults), ...Object.keys(this.policies), ...catalog.keys(), ...optionCatalog.keys(), ...modeCatalog.keys()]);
    return [...ids].map((harnessId) => ({
      harnessId,
      model: this.defaults[harnessId] ?? null,
      models: catalog.get(harnessId) ?? [],
      policy: this.policy(harnessId),
      options: optionCatalog.get(harnessId) ?? [],
      modes: modeCatalog.get(harnessId) ?? [],
    }));
  }
}
