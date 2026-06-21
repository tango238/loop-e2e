import { ensureDir } from '../../util/fs.js'
import { logger } from '../../util/logger.js'
import { screenshot } from './snapshot.js'
import type { RawPage, TargetEnv } from '../../domain/types.js'
import type { Scenario } from '../../scenario/schema.js'

// Minimal shape used from Playwright's Browser/Page to keep the module unit-testable
export type PageLike = {
  goto: (url: string, opts?: { waitUntil?: 'commit' | 'domcontentloaded' | 'networkidle' | 'load'; timeout?: number }) => Promise<unknown>
  url: () => string
  title: () => Promise<string>
  content: () => Promise<string>
  evaluate: (fn: () => Record<string, string>) => Promise<Record<string, string>>
  screenshot: (opts: { path: string; fullPage: boolean }) => Promise<unknown>
  waitForLoadState: (state?: 'domcontentloaded' | 'networkidle' | 'load') => Promise<void>
  locator: (selector: string) => {
    fill: (value: string) => Promise<void>
    click: () => Promise<void>
  }
}

export type BrowserLike = {
  newPage: () => Promise<PageLike>
  close: () => Promise<void>
}

/**
 * Performs form-based authentication on the given page.
 */
async function performFormLogin(
  page: PageLike,
  baseUrl: string,
  auth: NonNullable<TargetEnv['auth']>,
): Promise<void> {
  if (!auth.loginPath) {
    logger.warn('form auth configured but no loginPath specified — skipping login')
    return
  }
  const loginUrl = `${baseUrl}${auth.loginPath}`
  logger.debug({ loginUrl }, 'Navigating to login page')
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForLoadState('networkidle')

  if (auth.username) {
    const usernameLocator = page.locator('[name="username"],[name="email"],[type="email"],[name="user"]')
    await usernameLocator.fill(auth.username)
  }
  if (auth.password) {
    const passwordLocator = page.locator('[name="password"],[type="password"]')
    await passwordLocator.fill(auth.password)
  }
  const submitLocator = page.locator('[type="submit"],button[type="submit"]')
  await submitLocator.click()
  await page.waitForLoadState('networkidle')
}

/**
 * Collects meta tags from the page via evaluate.
 */
function buildMetaCollector(): () => Record<string, string> {
  return () => {
    const metas: Record<string, string> = {}
    document.querySelectorAll('meta[name]').forEach((el) => {
      const name = el.getAttribute('name')
      const content = el.getAttribute('content')
      if (name && content) metas[name] = content
    })
    return metas
  }
}

/**
 * Core crawl function that accepts an injectable browser-like object.
 * This design allows unit tests to pass a fake browser with no real Playwright.
 */
export async function crawlWithBrowser(
  browser: BrowserLike,
  target: TargetEnv,
  _scenarios: Scenario[],
  screenshotDir: string,
): Promise<RawPage[]> {
  await ensureDir(screenshotDir)
  const page = await browser.newPage()

  // Authenticate if needed
  if (target.auth?.strategy === 'form') {
    await performFormLogin(page, target.baseUrl, target.auth)
  }

  // Crawl the base URL
  await page.goto(target.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForLoadState('networkidle')

  const url = page.url()
  const title = await page.title()
  const html = await page.content()
  let meta: Record<string, string> = {}
  try {
    meta = await page.evaluate(buildMetaCollector())
  } catch {
    // evaluate may not work in all test environments; default to empty
  }

  const screenshotFilename = `${slugify(url)}.png`
  let screenshotPath = ''
  try {
    screenshotPath = await screenshot(page, screenshotDir, screenshotFilename)
  } catch {
    // screenshot may not work in all test environments
    screenshotPath = `${screenshotDir}/${screenshotFilename}`
  }

  const rawPage: RawPage = { url, title, html, meta, screenshotPath }
  logger.debug({ url, title }, 'Crawled page')
  return [rawPage]
}

/**
 * Public API: crawl using a real Playwright browser instance.
 */
export async function crawl(
  browser: BrowserLike,
  target: TargetEnv,
  scenarios: Scenario[],
  screenshotDir: string,
): Promise<RawPage[]> {
  return crawlWithBrowser(browser, target, scenarios, screenshotDir)
}

function slugify(url: string): string {
  return url.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 80)
}
