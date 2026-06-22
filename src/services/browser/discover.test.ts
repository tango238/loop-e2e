import { describe, it, expect, vi } from 'vitest'
import { discoverPages } from './discover.js'
import type { PageLike } from './crawler.js'
import type { TargetEnv, Grow } from '../../domain/types.js'

const target: TargetEnv = { name: 'local', baseUrl: 'http://localhost:3000', auth: { strategy: 'form' } }
const grow: Grow = { maxPages: 50, maxDepth: 3, excludePaths: [] }

/**
 * Fake page whose content() returns the HTML registered for the current URL.
 * goto() sets the current URL; pages return links via `<a href>`.
 */
function makePage(pages: Record<string, string>, failPaths: string[] = []): PageLike {
  let url = ''
  return {
    goto: vi.fn(async (u: string) => {
      const path = new URL(u).pathname.replace(/\/+$/, '') || '/'
      if (failPaths.includes(path)) throw new Error('load failed')
      url = u
    }),
    url: vi.fn(() => url),
    title: vi.fn(async () => `title:${url}`),
    content: vi.fn(async () => {
      // match by normalized path
      const path = new URL(url).pathname.replace(/\/+$/, '') || '/'
      return pages[path] ?? '<html></html>'
    }),
    evaluate: vi.fn(async () => ({})),
    screenshot: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    locator: vi.fn(() => ({ fill: vi.fn(async () => {}), click: vi.fn(async () => {}) })),
  } as unknown as PageLike
}

const link = (href: string) => `<a href="${href}">x</a>`

describe('discoverPages', () => {
  it('BFS-discovers same-origin in-app pages from the root', async () => {
    const page = makePage({
      '/': link('/hotel') + link('/booking'),
      '/hotel': link('/hotel/create'),
      '/booking': '',
      '/hotel/create': '',
    })
    const pages = await discoverPages(page, target, grow)
    const paths = pages.map((p) => new URL(p.url).pathname.replace(/\/+$/, '') || '/')
    expect(paths).toContain('/')
    expect(paths).toContain('/hotel')
    expect(paths).toContain('/booking')
    expect(paths).toContain('/hotel/create')
  })

  it('respects maxPages', async () => {
    const page = makePage({
      '/': link('/a') + link('/b') + link('/c') + link('/d'),
      '/a': '', '/b': '', '/c': '', '/d': '',
    })
    const pages = await discoverPages(page, target, { maxPages: 2, maxDepth: 3, excludePaths: [] })
    expect(pages.length).toBe(2)
  })

  it('respects maxDepth (does not follow links beyond depth)', async () => {
    const page = makePage({
      '/': link('/deep1'),
      '/deep1': link('/deep2'),
      '/deep2': link('/deep3'),
      '/deep3': '',
    })
    const pages = await discoverPages(page, target, { maxPages: 50, maxDepth: 1, excludePaths: [] })
    const paths = pages.map((p) => new URL(p.url).pathname.replace(/\/+$/, '') || '/')
    expect(paths).toContain('/')
    expect(paths).toContain('/deep1') // depth 1 captured
    expect(paths).not.toContain('/deep2') // depth 2 not followed (maxDepth=1)
  })

  it('excludes external origins, logout, assets, and excludePaths', async () => {
    const page = makePage({
      '/': link('https://evil.example.com/x') + link('/logout') + link('/app.js') + link('/admin') + link('/secret'),
      '/admin': '',
      '/secret': '',
    })
    const pages = await discoverPages(page, target, { maxPages: 50, maxDepth: 3, excludePaths: ['/secret'] })
    const paths = pages.map((p) => new URL(p.url).pathname.replace(/\/+$/, '') || '/')
    expect(paths).toContain('/admin')
    expect(paths).not.toContain('/logout')
    expect(paths).not.toContain('/secret')
    expect(paths.some((p) => p.includes('evil'))).toBe(false)
    expect(paths.some((p) => p.endsWith('.js'))).toBe(false)
  })

  it('dedups repeated links and skips pages that fail to load', async () => {
    const page = makePage(
      {
        '/': link('/x') + link('/x') + link('/y'),
        '/x': link('/'), // back-link to root (already visited)
        '/y': '',
      },
      ['/y'], // /y fails to load
    )
    const pages = await discoverPages(page, target, grow)
    const paths = pages.map((p) => new URL(p.url).pathname.replace(/\/+$/, '') || '/')
    // /x appears once (dedup), /y skipped (load failure), no crash
    expect(paths.filter((p) => p === '/x').length).toBe(1)
    expect(paths).not.toContain('/y')
  })
})
