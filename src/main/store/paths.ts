import { app } from 'electron'
import { join } from 'path'

/**
 * Resolves a data file inside the app's userData directory at call time
 * (not at import time), so it reflects any app.setName done during startup.
 */
export function dataFile(name: string): string {
  return join(app.getPath('userData'), name)
}
