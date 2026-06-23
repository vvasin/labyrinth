// Best-effort localStorage. Two records are kept:
//   • settings — durable preferences that outlive any single maze (the last
//     chosen size preset and the view distance);
//   • session  — the resumable game: the maze as {N,M,p,q,seed}, the app state,
//     the player's position, the surrender point, and the hint layout (locations,
//     which are used, and the absolute end-time of an active path reveal so the
//     countdown continues — never resets — across a reload).
// Any storage/parse failure (private mode, quota, corruption) is swallowed and
// falls back to defaults.

const SETTINGS_KEY = 'labyrinth/settings/v2';
const SESSION_KEY = 'labyrinth/session/v1';

const SETTINGS_DEFAULTS = { N: 12, viewDist: 6 };

export function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const num = (v, d, lo, hi) => (typeof v === 'number' && v >= lo && v <= hi ? v : d);
    return {
      N: num(s.N, SETTINGS_DEFAULTS.N, 3, 40),
      viewDist: num(s.viewDist, SETTINGS_DEFAULTS.viewDist, 4, 16),
    };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSession(s) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}
