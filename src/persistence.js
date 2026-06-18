// Best-effort localStorage for maze size, generation params, and mirror depth.
// Any storage/parse failure (private mode, quota, corruption) is swallowed and
// falls back to defaults.

const KEY = 'labyrinth/settings/v1';
const DEFAULTS = { N: 10, M: 10, p: 0.5, q: 0.5, maxDepth: 1 };

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const s = JSON.parse(raw);
    const num = (v, d, lo, hi) =>
      (typeof v === 'number' && v >= lo && v <= hi ? v : d);
    return {
      N: num(s.N, DEFAULTS.N, 3, 40),
      M: num(s.M, DEFAULTS.M, 3, 40),
      p: num(s.p, DEFAULTS.p, 0, 1),
      q: num(s.q, DEFAULTS.q, 0, 1),
      maxDepth: num(s.maxDepth, DEFAULTS.maxDepth, 0, 4),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
