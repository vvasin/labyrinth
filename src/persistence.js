// Best-effort localStorage for maze size, generation params, and view distance.
// Any storage/parse failure (private mode, quota, corruption) is swallowed and
// falls back to defaults.

const KEY = 'labyrinth/settings/v1';
const DEFAULTS = { N: 10, M: 10, p: 0.5, q: 0.5, viewDist: 4 };

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
      viewDist: num(s.viewDist, DEFAULTS.viewDist, 1, 8),
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
