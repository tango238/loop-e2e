import { join } from 'node:path'
import { ensureDir } from '../../util/fs.js'
import { logger } from '../../util/logger.js'
import type { Page } from 'playwright'

/**
 * Takes a screenshot of the current page and saves to dest directory.
 * Returns the path of the saved file.
 */
export async function screenshot(page: Page, destDir: string, filename: string): Promise<string> {
  await ensureDir(destDir)
  const filePath = join(destDir, filename)
  await page.screenshot({ path: filePath, fullPage: true })
  logger.debug({ filePath }, 'Screenshot saved')
  return filePath
}
