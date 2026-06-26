import { describe, it, expect, vi } from 'vitest'
import { verifyAccessControl, collectRoutes, extractHrefs, isGuarded, looksLikeLoginPage } from './accessControl.js'
import type { AccessProbe, AccessProbeResult } from './accessControl.js'
import type { RawPage } from '../../domain/types.js'

const page = (url: string, html = ''): RawPage => ({ url, title: 't', html, meta: {}, screenshotPath: '' })
const res = (status: number, location?: string, body = ''): AccessProbeResult => ({ status, location, body })

describe('extractHrefs', () => {
  it('pulls href targets from rendered HTML', () => {
    expect(extractHrefs('<a href="/a">x</a><a href=\'/b\'>y</a>')).toEqual(['/a', '/b'])
  })
})

describe('collectRoutes', () => {
  it('extracts unique pathnames and excludes the login path', () => {
    const pages = [page('http://x/dashboard'), page('http://x/dashboard'), page('http://x/login'), page('http://x/users')]
    expect(collectRoutes(pages, 'http://x', '/login')).toEqual(['/dashboard', '/users'])
  })

  it('includes same-origin href targets that were never crawled (linked-but-uncrawled)', () => {
    const pages = [page('http://x/dashboard', '<a href="/internal-report">leak</a><a href="/relative-leak">r</a>')]
    expect(collectRoutes(pages, 'http://x', '/login')).toEqual(['/dashboard', '/internal-report', '/relative-leak'])
  })

  it('drops off-origin and non-http href targets', () => {
    const pages = [page('http://x/ok', '<a href="https://evil.example.com/x">e</a><a href="mailto:a@b.c">m</a>')]
    expect(collectRoutes(pages, 'http://x', '/login')).toEqual(['/ok'])
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

  it('probes a linked-but-uncrawled route (href in crawled page HTML)', async () => {
    const probe = vi.fn(async (url: string) =>
      url.endsWith('/internal-report') ? res(200, undefined, '<h1>Secret</h1>') : res(303, '/login'),
    )
    const findings = await verifyAccessControl(deps(probe, [page('http://x/dashboard', '<a href="/internal-report">leak</a>')]))
    expect(probe).toHaveBeenCalledWith('http://x/internal-report')
    expect(findings).toHaveLength(1)
    expect(findings[0].evidence).toContain('/internal-report')
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
