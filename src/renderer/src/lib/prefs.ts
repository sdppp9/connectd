/** Small per-machine UI preferences kept in localStorage (safe if storage is unavailable). */

export function readNumberPref(key: string, fallback: number, min: number, max: number): number {
  try {
    const v = Number(localStorage.getItem(key))
    if (Number.isFinite(v) && v >= min && v <= max) return v
  } catch {
    // storage blocked — use the default
  }
  return fallback
}

export function writePref(key: string, value: string | number): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // storage blocked — the value just won't persist
  }
}

export const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))
