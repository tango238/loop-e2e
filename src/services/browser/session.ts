import { authenticate as defaultAuthenticate } from './login.js'
import type { LoginDeps, LoginResult } from './login.js'
import type { PageLike } from './crawler.js'
import type { TargetEnv } from '../../domain/types.js'

export type SessionDeps = LoginDeps & {
  authenticate?: (
    page: PageLike,
    target: TargetEnv,
    creds: { username: string; password: string },
    deps?: LoginDeps,
  ) => Promise<LoginResult>
  clearCookies?: (page: PageLike) => Promise<void>
  /** Drop the current session before probing so a different identity re-logs in. */
  forceReauth?: boolean
}

function urlIsLoginPath(url: string, loginPath: string): boolean {
  try {
    const p = new URL(url).pathname
    return p === loginPath || p.startsWith(loginPath + '/')
  } catch {
    return url.includes(loginPath)
  }
}

/**
 * Ensure the page holds an authenticated session. Navigates to `probePath`;
 * if the app redirects to the login path, runs `authenticate` (form + 2FA).
 * Reuses an existing session (no-op) when the protected page loads directly.
 */
export async function ensureAuthenticated(
  page: PageLike,
  target: TargetEnv,
  creds: { username: string; password: string },
  probePath: string,
  deps: SessionDeps = {},
): Promise<{ ok: boolean; detail: string }> {
  const loginPath = target.auth?.loginPath ?? '/login'
  const base = target.baseUrl.replace(/\/$/, '')
  const probe = /^https?:\/\//i.test(probePath) ? probePath : `${base}/${probePath.replace(/^\//, '')}`

  if (deps.forceReauth && deps.clearCookies) {
    await deps.clearCookies(page) // drop current identity so the probe redirects to login
  }

  await page.goto(probe, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForLoadState('networkidle')

  if (!urlIsLoginPath(page.url(), loginPath)) return { ok: true, detail: 'session reused' }

  const auth = deps.authenticate ?? defaultAuthenticate
  const res = await auth(page, target, creds, deps)
  return { ok: res.ok, detail: res.detail }
}

/** Put the page into a logged-out state before running an unauthenticated scenario. */
export async function ensureUnauthenticated(
  page: PageLike,
  _target: TargetEnv,
  deps: SessionDeps = {},
): Promise<void> {
  if (deps.clearCookies) await deps.clearCookies(page)
}
