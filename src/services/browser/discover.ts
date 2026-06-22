import { logger } from '../../util/logger.js'
import type { PageLike } from './crawler.js'
import type { TargetEnv, RawPage, Grow } from '../../domain/types.js'

/** Assets and non-page resources we never enqueue for discovery. */
const ASSET_EXT = /\.(js|mjs|css|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|map|pdf|zip|mp4|mp3|json|xml)(\?|#|$)/i

/**
 * Authenticated discovery crawl: starting from the post-login root, follow
 * same-origin in-app links breadth-first up to `maxPages`/`maxDepth`, skipping
 * excluded paths, logout, external origins, and asset URLs. Reuses the given
 * (already authenticated) page, navigating it sequentially. Pages that fail to
 * load are skipped (logged), not fatal.
 */
export async function discoverPages(
  page: PageLike,
  target: TargetEnv,
  opts: Grow,
): Promise<RawPage[]> {
  const baseUrl = target.baseUrl.replace(/\/$/, '')
  const origin = safeOrigin(baseUrl)
  const startUrl = `${baseUrl}/`

  const visited = new Set<string>()
  const results: RawPage[] = []
  const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }]

  while (queue.length > 0 && results.length < opts.maxPages) {
    const { url, depth } = queue.shift() as { url: string; depth: number }
    const key = normalizeUrl(url)
    if (visited.has(key)) continue
    visited.add(key)

    let raw: RawPage
    try {
      raw = await capture(page, url)
    } catch (err) {
      logger.warn({ url, err: String(err instanceof Error ? err.message : err) }, 'discover: page load failed, skipping')
      continue
    }
    results.push(raw)
    if (results.length >= opts.maxPages) break
    if (depth >= opts.maxDepth) continue

    for (const link of extractLinks(raw.html, baseUrl)) {
      if (safeOrigin(link) !== origin) continue
      if (isAsset(link)) continue
      if (isLogout(link)) continue
      if (isExcluded(link, opts.excludePaths)) continue
      const linkKey = normalizeUrl(link)
      if (visited.has(linkKey)) continue
      queue.push({ url: link, depth: depth + 1 })
    }
  }

  if (results.length >= opts.maxPages) {
    logger.info({ maxPages: opts.maxPages }, 'discover: reached maxPages limit')
  }
  logger.info({ discovered: results.length }, 'discover: crawl complete')
  return results
}

async function capture(page: PageLike, url: string): Promise<RawPage> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForLoadState('networkidle')
  const finalUrl = page.url()
  const title = await page.title()
  const html = await page.content()
  let meta: Record<string, string> = {}
  try {
    meta = await page.evaluate(() => ({}))
  } catch {
    meta = {}
  }
  return { url: finalUrl, title, html, meta, screenshotPath: '' }
}

/** Extract absolute, same-document `<a href>` links resolved against baseUrl. */
function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = []
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const href = m[1].trim()
    if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue
    try {
      links.push(new URL(href, `${baseUrl}/`).toString())
    } catch {
      // ignore unparseable hrefs
    }
  }
  return links
}

/** Normalize to origin+pathname (no query, no fragment, no trailing slash) for dedup. */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname.replace(/\/+$/, '') || '/'
    return `${u.origin}${path}`
  } catch {
    return url
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function isAsset(url: string): boolean {
  return ASSET_EXT.test(url)
}

function isLogout(url: string): boolean {
  try {
    const p = new URL(url).pathname.toLowerCase()
    return p.includes('logout') || p.includes('sign-out') || p.includes('signout')
  } catch {
    return false
  }
}

function isExcluded(url: string, excludePaths: string[]): boolean {
  if (excludePaths.length === 0) return false
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    pathname = url
  }
  return excludePaths.some((ex) => pathname.includes(ex))
}
