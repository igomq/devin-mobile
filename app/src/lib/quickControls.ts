// Finds the reasoning-effort and fast-mode options among an agent's ACP config options, for the
// composer's quick controls. Detection is by id, name and category, so it works for any harness.
import type { ConfigOption, ConfigOptionValue } from './types.ts';
import { flatValues, isModelOption } from './models.ts';

const isModeOption = (o: ConfigOption) => o.id === 'mode' || o.category === 'mode';
const EFFORT = /reason|effort|thought|thinking/i;
const FAST = /fast|speed|turbo|priority|tier/i;
const words = (o: ConfigOption) => `${o.id} ${o.name} ${o.category ?? ''}`;

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');
const RANKS: Record<string, number> = {
  none: 0,
  off: 0,
  disabled: 0,
  minimal: 1,
  min: 1,
  lowest: 1,
  low: 2,
  medium: 3,
  med: 3,
  normal: 3,
  high: 4,
  xhigh: 5,
  extrahigh: 5,
  veryhigh: 5,
  higher: 5,
  max: 6,
  maximum: 6,
  ultra: 6,
};
const rank = (x: ConfigOptionValue) => RANKS[norm(x.value)] ?? RANKS[norm(x.name)];

export interface EffortControl {
  option: ConfigOption;
  /** Levels from least to most effort, when every level is a known one; otherwise in the agent's order. */
  levels: ConfigOptionValue[];
  /** Index of the current level, or -1 when the current value is not among the levels. */
  index: number;
}

export function effortControl(options: ConfigOption[] | null | undefined): EffortControl | null {
  const option = (options ?? []).find((o) => !isModelOption(o) && !isModeOption(o) && (o.category === 'thought_level' || EFFORT.test(words(o))) && flatValues(o).length >= 2);
  if (!option) return null;
  const values = flatValues(option);
  const levels = values.every((x) => rank(x) !== undefined) ? [...values].sort((a, b) => rank(a) - rank(b)) : values;
  return { option, levels, index: levels.findIndex((x) => x.value === option.currentValue) };
}

export interface FastControl {
  option: ConfigOption;
  on: boolean;
  onValue: string | boolean;
  offValue: string | boolean;
}

const ON = /^(on|true|enabled?|yes|fast|faster|turbo|priority)$/i;
const OFF = /^(off|false|disabled?|no|standard|default|normal|regular|none)$/i;
const matches = (re: RegExp, x: ConfigOptionValue) => re.test(x.value.trim()) || re.test(x.name.trim());

export function fastControl(options: ConfigOption[] | null | undefined, exclude?: ConfigOption | null): FastControl | null {
  for (const option of options ?? []) {
    if (option === exclude || isModelOption(option) || isModeOption(option) || !FAST.test(words(option))) continue;
    if (option.type === 'boolean' || typeof option.currentValue === 'boolean') {
      return { option, on: option.currentValue === true || option.currentValue === 'true', onValue: true, offValue: false };
    }
    // A small select works as a toggle when one value reads as "off" and another as "fast".
    const values = flatValues(option);
    if (values.length < 2 || values.length > 3) continue;
    const off = values.find((x) => matches(OFF, x));
    const on = values.find((x) => x !== off && matches(ON, x));
    if (on && off) return { option, on: option.currentValue === on.value, onValue: on.value, offValue: off.value };
  }
  return null;
}
