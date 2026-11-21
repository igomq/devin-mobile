// Splits Devin CLI's model option into single models and Fusion (main + sidekick) pairs.
import type { ConfigOption, ConfigOptionValue } from './types.ts';

export interface FusionPair {
  value: string;
  main: string;
  side: string;
}

export const flatValues = (o: ConfigOption): ConfigOptionValue[] => (o.options ?? []).flatMap((x) => ('options' in x ? x.options : [x]));

export const isModelOption = (o: ConfigOption) => o.id === 'model' || o.category === 'model';

function fusionPair(x: ConfigOptionValue): FusionPair | null {
  const m = /^Fusion \((.+) \+ (.+)\)$/.exec(x.name);
  return m ? { value: x.value, main: m[1], side: m[2] } : null;
}

export function splitModels(o: ConfigOption) {
  const singles: ConfigOptionValue[] = [];
  const pairs: FusionPair[] = [];
  for (const x of flatValues(o)) {
    const p = x.value.startsWith('fusion-') ? fusionPair(x) : null;
    if (p) pairs.push(p);
    else singles.push(x);
  }
  const mains = [...new Set(pairs.map((p) => p.main))];
  const sidesFor = (main: string) => pairs.filter((p) => p.main === main).map((p) => p.side);
  const find = (main: string, side: string) => pairs.find((p) => p.main === main && p.side === side);
  return { singles, pairs, mains, sidesFor, find };
}

/** Short label for the composer, e.g. "Claude Opus 5.5" or "Fusion: Opus 5.5 + SWE-2". */
export function modelLabel(o: ConfigOption | undefined): string | null {
  if (!o) return null;
  const cur = flatValues(o).find((x) => x.value === o.currentValue);
  if (!cur) return typeof o.currentValue === 'string' ? o.currentValue : null;
  const p = cur.value.startsWith('fusion-') ? fusionPair(cur) : null;
  if (!p) return cur.name;
  const trim = (s: string) => s.replace(/^Claude /, '').replace(/ (Medium|High|Max|High Thinking)$/, '');
  return `Fusion: ${trim(p.main)} + ${trim(p.side)}`;
}
