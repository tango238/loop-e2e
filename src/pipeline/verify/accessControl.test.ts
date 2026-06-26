import { describe, it, expect, vi } from 'vitest'
import { verifyAccessControl, routePaths, isGuarded, looksLikeLoginPage } from './accessControl.js'
import type { AccessProbe, AccessProbeResult } from './accessControl.js'
import type { RawPage } from '../../domain/types.js'

const page = (url: string): RawPage => ({ url, title: 't', html: '', meta: {}, screenshotPath: '' })
const res = (status: number, location?: string, body = ''): AccessProbeResult => ({ status, location, body })

describe('routePaths', () => {
  it('extracts unique pathnames and excludes the login path', () => {
    const pages = [page('http://x/dashboard'), page('http://x/dashboard'), page('http://x/login'), page('http://x/users')]
    expect(routePaths(pages, '/login')).toEqual(['/dashboard', '/users'])
  })
})

describe('looksLikeLoginPage', () => {
  it('detects a password field', () => {
    expect(looksLikeLoginPage('<input type="password" name="p">', '/login')).toBe(true)
  })
  it('detects a form posting to the login path', () => {
    expect(looksLikeLoginPage('<form action="/login" method="post">', '/login')).toBe(true)
  })
  it('returns false for protected content', () => {
    expect(looksLikeLoginPage('<h1>Dashboard</h1><table>secret</table>', '/login')).toBe(false)
  })
})

describe('isGuarded', () => {
  it('treats a redirect to the login path as guarded', () => {
    expect(isGuarded(res(302, '/login'), '/login')).toBe(true)
    expect(isGuarded(res(302, 'http://x/login?next=/dashboard'), '/login')).toBe(true)
  })
  it('treats 401/403 as guarded', () => {
    expect(isGuarded(res(401), '/login')).toBe(true)
    expect(isGuarded(res(403), '/login')).toBe(true)
  })
  it('treats a 200 login page as guarded', () => {
    expect(isGuarded(res(200, undefined, '<input type="password">'), '/login')).toBe(true)
  })
  it('treats a 200 protected page as NOT guarded (broken access control)', () => {
    expect(isGuarded(res(200, undefined, '<h1>Dashboard</h1>'), '/login')).toBe(false)
  })
})

describe('verifyAccessControl', () => {
  const deps = (probe: AccessProbe, pages = [page('http://x/dashboard')]) => ({
    pages, baseUrl: 'http://x', loginPath: '/login', probe,
  })

  it('flags a high finding when an auth-gated route serves content anonymously', async () => {
    const probe = vi.fn(async () => res(200, undefined, '<h1>Dashboard</h1>'))
    const findings = await verifyAccessControl(deps(probe))
    expect(probe).toHaveBeenCalledWith('http://x/dashboard')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ category: 'access-control', severity: 'high' })
    expect(findings[0].evidence).toContain('/dashboard')
  })

  it('produces no finding when the route is guarded (redirect to login)', async () => {
    const probe = vi.fn(async () => res(302, '/login'))
    const findings = await verifyAccessControl(deps(probe))
    expect(findings).toEqual([])
  })

  it('never throws when a probe fails — that route is skipped', async () => {
    const probe = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const findings = await verifyAccessControl(deps(probe))
    expect(findings).toEqual([])
  })

  it('returns [] when there are no routes to probe', async () => {
    const probe = vi.fn(async () => res(200))
    const findings = await verifyAccessControl(deps(probe, [page('http://x/login')]))
    expect(probe).not.toHaveBeenCalled()
    expect(findings).toEqual([])
  })
})
