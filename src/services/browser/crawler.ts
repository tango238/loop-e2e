import { ensureDir } from '../../util/fs.js'
import { logger } from '../../util/logger.js'
import { screenshot } from './snapshot.js'
import type { RawPage, TargetEnv } from '../../domain/types.js'
import { allSteps, type Scenario } from '../../scenario/schema.js'

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
    count?: () => Promise<number>
  }
  /** Optional: close the page after capture to release resources */
  close?: () => Promise<void>
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

/** Returns true if the step target looks like a navigable URL path or absolute URL */
function isNavigationTarget(t: string): boolean {
  return t.startsWith('/') || t.startsWith('http://') || t.startsWith('https://')
}

/** Resolves a step target to an absolute URL */
function resolveUrl(stepTarget: string, baseUrl: string): string {
  if (stepTarget.startsWith('http://') || stepTarget.startsWith('https://')) {
    return stepTarget
  }
  return `${baseUrl.replace(/\/$/, '')}${stepTarget}`
}

/**
 * Captures a single page at the given URL: navigates, waits, collects metadata, takes screenshot.
 */
async function capturePage(page: PageLike, url: string, screenshotDir: string): Promise<RawPage> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForLoadState('networkidle')

  const finalUrl = page.url()
  const title = await page.title()
  const html = await page.content()
  let meta: Record<string, string> = {}
  try {
    meta = await page.evaluate(buildMetaCollector())
  } catch {
    // evaluate may not work in all test environments; default to empty
  }

  const screenshotFilename = `${slugify(finalUrl)}.png`
  let screenshotPath = ''
  try {
    screenshotPath = await screenshot(page, screenshotDir, screenshotFilename)
  } catch {
    screenshotPath = `${screenshotDir}/${screenshotFilename}`
  }

  logger.debug({ url: finalUrl, title }, 'Crawled page')
  return { url: finalUrl, title, html, meta, screenshotPath }
}

/**
 * Core crawl function that accepts an injectable browser-like object.
 * This design allows unit tests to pass a fake browser with no real Playwright.
 *
 * Crawls the base URL first, then follows navigation targets from scenario steps
 * to build a multi-page RawPage array. Deduplicates by URL.
 */
export async function crawlWithBrowser(
  browser: BrowserLike,
  target: TargetEnv,
  scenarios: Scenario[],
  screenshotDir: string,
): Promise<RawPage[]> {
  await ensureDir(screenshotDir)

  const visitedUrls = new Set<string>()
  const rawPages: RawPage[] = []

  const page = await browser.newPage()

  try {
    // Authenticate if needed
    if (target.auth?.strategy === 'form') {
      await performFormLogin(page, target.baseUrl, target.auth)
    }

    // Always capture the base URL first
    const basePage = await capturePage(page, target.baseUrl, screenshotDir)
    visitedUrls.add(basePage.url)
    rawPages.push(basePage)

    // Follow scenario step navigation targets to build multi-page crawl
    for (const scenario of scenarios) {
      for (const step of allSteps(scenario)) {
        if (!isNavigationTarget(step.target)) continue

        const targetUrl = resolveUrl(step.target, target.baseUrl)
        if (visitedUrls.has(targetUrl)) continue

        try {
          const stepPage = await capturePage(page, targetUrl, screenshotDir)
          visitedUrls.add(targetUrl)
          rawPages.push(stepPage)
          logger.debug(
            { from: rawPages[rawPages.length - 2]?.url, to: stepPage.url, trigger: step.action },
            'Followed scenario transition',
          )
        } catch (err) {
          logger.warn(
            { err, targetUrl, scenario: scenario.id },
            'Failed to navigate to scenario step target — skipping',
          )
        }
      }
    }
  } finally {
    // Close page to release browser resources
    await page.close?.().catch(() => {})
  }

  return rawPages
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
