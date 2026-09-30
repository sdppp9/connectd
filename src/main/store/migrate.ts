import { app } from 'electron'
import { existsSync, mkdirSync, copyFileSync } from 'fs'
import { join } from 'path'

// "Local State" holds the safeStorage encryption key — it MUST come along or
// the migrated (encrypted) passwords can't be decrypted in the new folder.
const DATA_FILES = ['Local State', 'connections.json', 'history.json', 'saved-queries.json']
// Older app-name folders whose data should be adopted, in priority order.
const LEGACY_NAMES = ['connectd', 'connectdee']

/**
 * One-time migration: if this app's userData has no connections yet but an
 * older-named folder does (from before the app was renamed), copy its data in.
 * Keeps saved connections/history/queries across the rename.
 */
export function migrateLegacyData(): void {
  const userData = app.getPath('userData')
  if (existsSync(join(userData, 'connections.json'))) return

  const appData = app.getPath('appData')
  for (const legacy of LEGACY_NAMES) {
    const dir = join(appData, legacy)
    if (dir === userData) continue
    if (!existsSync(join(dir, 'connections.json'))) continue

    mkdirSync(userData, { recursive: true })
    for (const f of DATA_FILES) {
      const src = join(dir, f)
      if (existsSync(src)) {
        try {
          copyFileSync(src, join(userData, f))
        } catch {
          // best-effort
        }
      }
    }
    return
  }
}
