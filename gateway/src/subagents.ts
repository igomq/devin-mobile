import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Json = any;
export interface ModelChoice {
  value: string;
  name: string;
}

/** Live sessions by the ref their uniharn MCP server was started with, so a delegation knows its parent. */
export const sessionRefs = new Map<string, { harnessId: string; sessionId: string }>();

const catalog = new Map<string, ModelChoice[]>();
let onCatalogChange: (() => void) | null = null;

export function modelOptionOf(configOptions: Json[] | undefined): Json | null {
  return (configOptions ?? []).find((o) => o?.category === 'model' || o?.id === 'model') ?? null;
}

/** Remembers the models a harness offers, from any of its sessions' config options. */
export function noteModels(harnessId: string, configOptions: Json[] | undefined) {
  const opt = modelOptionOf(configOptions);
  if (!opt || !Array.isArray(opt.options)) return;
  const models: ModelChoice[] = opt.options
    .flatMap((x: Json) => (Array.isArray(x?.options) ? x.options : [x]))
    .filter((x: Json) => typeof x?.value === 'string')
    .map((x: Json) => ({ value: x.value, name: typeof x.name === 'string' && x.name ? x.name : x.value }));
  if (!models.length || JSON.stringify(catalog.get(harnessId)) === JSON.stringify(models)) return;
  catalog.set(harnessId, models);
  onCatalogChange?.();
}

/** Default model per harness for subagents, kept apart from the model each chat session uses. */
export class SubagentSettings {
  private file: string;
  private defaults: Record<string, string> = {};

  constructor(dataDir: string) {
    this.file = join(dataDir, 'subagents.json');
    try {
      if (existsSync(this.file)) {
        const data = JSON.parse(readFileSync(this.file, 'utf8'));
        for (const [k, v] of Object.entries(data?.defaults ?? {})) if (typeof v === 'string' && v) this.defaults[k] = v;
        for (const [k, v] of Object.entries(data?.models ?? {})) if (Array.isArray(v) && !catalog.has(k)) catalog.set(k, v as ModelChoice[]);
      }
    } catch {
      // Start empty on a damaged file.
    }
    onCatalogChange = () => this.save();
  }

  private save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify({ defaults: this.defaults, models: Object.fromEntries(catalog) }, null, 2), { mode: 0o600 });
    } catch {
      // Losing the model list only costs a reload; it must not break a session.
    }
  }

  defaultModel(harnessId: string): string | null {
    return this.defaults[harnessId] ?? null;
  }

  setDefault(harnessId: string, model: string | null) {
    if (model) this.defaults[harnessId] = model;
    else delete this.defaults[harnessId];
    this.save();
  }

  list() {
    const ids = new Set([...Object.keys(this.defaults), ...catalog.keys()]);
    return [...ids].map((harnessId) => ({ harnessId, model: this.defaults[harnessId] ?? null, models: catalog.get(harnessId) ?? [] }));
  }
}
