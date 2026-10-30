import type { World } from '@/lib/sim'

// The prototype keeps the whole game in this browser. Storage can be missing or
// full (private windows, quota), so every access is allowed to fail quietly.
// Bump the version when the world's shape changes; older saves are then ignored.
const SAVE_KEY = 'emporion-save-v2'

export function loadWorld(): World | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    return raw ? (JSON.parse(raw) as World) : null
  } catch {
    return null
  }
}

export function saveWorld(world: World): boolean {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(world))
    return true
  } catch {
    return false
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY)
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}
