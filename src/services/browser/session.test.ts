import { describe, it, expect, vi } from 'vitest'
import { ensureAuthenticated, ensureUnauthenticated } from './session.js'
import type { PageLike } from './crawler.js'
import type { TargetEnv } from '../../domain/types.js'

const target: TargetEnv = {
  name: 'admin',
  baseUrl: 'https://app.test',
  auth: { strategy: 'form', loginPath: '/login', username: 'u', password: 'p' },
}
const creds = { username: 'u', password: 'p' }

function makePage(url: string): PageLike {
  let current = url
  return {
    goto: vi.fn(async (u: string) => {
      current = u
    }),
    url: () => current,
    title: vi.fn(async () => 'T'),
    content: vi.fn(async () => ''),
    evaluate: vi.fn(async () => ({})),
    screenshot: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => {}),
    locator: vi.fn(() => ({ fill: vi.fn(), click: vi.fn() })),
    newPage: vi.fn(),
  } as unknown as PageLike
}

describe('ensureAuthenticated', () => {
  it('skips login when the protected page does not redirect to login', async () => {
    const page = makePage('https://app.test/dashboard')
    const authenticate = vi.fn()
    const r = await ensureAuthenticated(page, target, creds, '/dashboard', { authenticate })
    expect(authenticate).not.toHaveBeenCalled()
    expect(r.ok).toBe(true)
  })

  it('logs in when the protected page redirects to loginPath', async () => {
    const page = makePage('https://app.test/dashboard')
    ;(page.goto as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      ;(page as { url: () => string }).url = () => 'https://app.test/login'
    })
    const authenticate = vi.fn(async () => ({ ok: true, detail: 'ok', finalUrl: 'https://app.test/' }))
    const r = await ensureAuthenticated(page, target, creds, '/dashboard', { authenticate })
    expect(authenticate).toHaveBeenCalledOnce()
    expect(r.ok).toBe(true)
  })

  it('returns ok:false when login fails', async () => {
    const page = makePage('https://app.test/dashboard')
    ;(page.goto as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      ;(page as { url: () => string }).url = () => 'https://app.test/login'
    })
    const authenticate = vi.fn(async () => ({ ok: false, detail: 'bad', finalUrl: 'https://app.test/login' }))
    const r = await ensureAuthenticated(page, target, creds, '/dashboard', { authenticate })
    expect(authenticate).toHaveBeenCalledOnce()
    expect(r.ok).toBe(false)
  })
})

describe('ensureUnauthenticated', () => {
  it('clears cookies when a clearer is provided', async () => {
    const page = makePage('https://app.test/')
    const clearCookies = vi.fn(async () => {})
    await ensureUnauthenticated(page, target, { clearCookies })
    expect(clearCookies).toHaveBeenCalledOnce()
  })

  it('is a no-op when no cookie clearer is provided', async () => {
    const page = makePage('https://app.test/')
    await expect(ensureUnauthenticated(page, target, {})).resolves.toBeUndefined()
  })
})

describe('ensureAuthenticated forceReauth', () => {
  it('clears the session and re-authenticates even if a session exists', async () => {
    const authenticate = vi.fn(async () => ({ ok: true, detail: 'logged in', finalUrl: 'https://app.test/' }))
    let cleared = false
    const page = {
      goto: async () => {},
      url: () => (cleared ? 'https://app.test/login' : 'https://app.test/'),
      waitForLoadState: async () => {},
    } as unknown as PageLike
    const clearCookies = vi.fn(async () => { cleared = true })
    const r = await ensureAuthenticated(
      page,
      { name: 'a', baseUrl: 'https://app.test', auth: { strategy: 'form', loginPath: '/login' } } as TargetEnv,
      { username: 'u', password: 'p' }, '/',
      { forceReauth: true, clearCookies, authenticate },
    )
    expect(clearCookies).toHaveBeenCalledOnce()
    expect(authenticate).toHaveBeenCalledOnce()
    expect(r.ok).toBe(true)
  })
})
