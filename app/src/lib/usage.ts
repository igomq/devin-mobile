/** Self-serve quota, remaining credits and reset time live here; the Devin CLI does not report them. */
export const USAGE_URL = 'https://app.devin.ai/settings/usage';

export const compact = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n));
