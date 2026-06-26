import { logger } from '../../util/logger.js'
import type { VerifyFinding, RawPage } from '../../domain/types.js'

/** Result of an anonymous (no-cookie) probe of a single route. */
export type AccessProbeResult = {
  status: number
  /** Value of the Location header on a redirect, if any. */
  location?: string
  /** Response body (used to recognise a 200-rendered login page). */
  body: string
}

/** Probes a URL with NO authentication and reports status/redirect/body. */
export type AccessProbe = (url: string) => Promise<AccessProbeResult>

export type AccessControlDeps = {
  /** Pages discovered by the authenticated crawl — their routes are the auth-gated candidates. */
  pages: RawPage[]
  /** Target base URL, e.g. http://127.0.0.1:3000 */
  baseUrl: string
  /** The login path, e.g. /login — guarded routes redirect here. */
  loginPath: string
  /** Injectable probe (defaults to a cookie-less fetch). */
  probe?: AccessProbe
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** Unique pathnames of the crawled pages, excluding the login path itself. */
export function routePaths(pages: RawPage[], loginPath: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of pages) {
    let path: string
    try {
      path = new URL(p.url).pathname
    } catch {
      continue
    }
    if (path === loginPath) continue
    if (seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

/** True when a rendered body looks like the login page (password field or a form posting to loginPath). */
export function looksLikeLoginPage(body: string, loginPath: string): boolean {
  if (/<input[^>]*type=["']password["']/i.test(body)) return true
  const escaped = loginPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`action=["'][^"']*${escaped}`, 'i').test(body)
}

/**
 * An anonymous response is "guarded" when it does NOT hand protected content to an
 * unauthenticated client: a redirect to the login path, a 401/403, or a 200 that merely
 * re-renders the login page. Only a 2xx carrying non-login content is a broken-access signal.
 */
export function isGuarded(result: AccessProbeResult, loginPath: string): boolean {
  const { status, body } = result
  if (status === 401 || status === 403) return true
  if (REDIRECT_STATUSES.has(status)) {
    // A redirect keeps protected content from rendering to the anonymous client; the canonical
    // guard redirects to the login path. Treat any redirect as guarded (conservative: avoids
    // false positives on apps that bounce to a home/error page).
    return true
  }
  if (status >= 200 && status < 300) {
    return looksLikeLoginPage(body, loginPath)
  }
  // 4xx (other) / 5xx — not serving protected content; not our concern here.
  return true
}

/**
 * Access-control verification: for every route discovered by the AUTHENTICATED crawl, probe it
 * ANONYMOUSLY and expect a guard (redirect to login / 401 / 403). A route that serves protected
 * content to an unauthenticated client is a Broken Access Control finding.
 *
 * This is the Assert counterpart to the scenario `precondition.auth` Arrange (D-4/D-5): the same
 * "route requires auth" knowledge that drives login is here asserted empirically. The oracle is the
 * live probe response — not the mere fact a page was found after login — so genuinely public pages
 * that also appear post-login are filtered by their actual (login-page / redirect) response, and any
 * residual false positives are downgraded by the refutation panel.
 */
export async function verifyAccessControl(deps: AccessControlDeps): Promise<VerifyFinding[]> {
  const { pages, baseUrl, loginPath } = deps
  const probe = deps.probe ?? defaultProbe()
  const findings: VerifyFinding[] = []

  for (const path of routePaths(pages, loginPath)) {
    let url: string
    try {
      url = new URL(path, baseUrl).toString()
    } catch {
      continue
    }
    try {
      const result = await probe(url)
      if (!isGuarded(result, loginPath)) {
        findings.push({
          category: 'access-control',
          severity: 'high',
          title: 'Auth-gated page reachable without authentication',
          detail:
            `Route '${path}' was discovered only after login, but an anonymous (no-cookie) request ` +
            `returned HTTP ${result.status} with non-login content instead of redirecting to '${loginPath}' ` +
            `or returning 401/403. This indicates a missing authentication guard (Broken Access Control).`,
          evidence: `[anonymous GET ${url}] status ${result.status}${result.location ? ` → ${result.location}` : ''}; not guarded`,
        })
      }
    } catch (error) {
      logger.warn({ error, url }, 'access-control verify: probe failed for route — skipping')
    }
  }

  return findings
}

/** Default probe: a cookie-less fetch that does not follow redirects. */
function defaultProbe(): AccessProbe {
  return async (url) => {
    const res = await fetch(url, { redirect: 'manual', headers: { accept: 'text/html' } })
    const location = res.headers.get('location') ?? undefined
    let body = ''
    try {
      body = await res.text()
    } catch {
      body = ''
    }
    return { status: res.status, location, body }
  }
}
