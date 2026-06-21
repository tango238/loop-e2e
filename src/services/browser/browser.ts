import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import { logger } from '../../util/logger.js'

export type BrowserCtx = {
  browser: Browser
}

/**
 * Launches a headless Chromium instance.
 */
export async function launchBrowser(): Promise<BrowserCtx> {
  logger.debug('Launching chromium browser')
  const browser = await chromium.launch({ headless: true })
  return { browser }
}
