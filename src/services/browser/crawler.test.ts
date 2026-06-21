import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RawPage, TargetEnv } from '../../domain/types.js'

// --- Unit tests: fake browser, no real Playwright ---

type FakePage = {
  goto: ReturnType<typeof vi.fn>
  url: ReturnType<typeof vi.fn>
  title: ReturnType<typeof vi.fn>
  content: ReturnType<typeof vi.fn>
  evaluate: ReturnType<typeof vi.fn>
  screenshot: ReturnType<typeof vi.fn>
  waitForLoadState: ReturnType<typeof vi.fn>
  $: ReturnType<typeof vi.fn>
  fill: ReturnType<typeof vi.fn>
  click: ReturnType<typeof vi.fn>
  locator: ReturnType<typeof vi.fn>
}

type FakeBrowser = {
  newPage: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

const makeFakePage = (overrides: Partial<FakePage> = {}): FakePage => ({
  goto: vi.fn().mockResolvedValue(undefined),
  url: vi.fn().mockReturnValue('https://example.com/'),
  title: vi.fn().mockResolvedValue('Example Page'),
  content: vi.fn().mockResolvedValue('<html><head></head><body>Hello</body></html>'),
  evaluate: vi.fn().mockResolvedValue({}),
  screenshot: vi.fn().mockResolvedValue(undefined),
  waitForLoadState: vi.fn().mockResolvedValue(undefined),
  $: vi.fn().mockResolvedValue(null),
  fill: vi.fn().mockResolvedValue(undefined),
  click: vi.fn().mockResolvedValue(undefined),
  locator: vi.fn().mockReturnValue({
    fill: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
  }),
  ...overrides,
})

const makeFakeBrowser = (page: FakePage): FakeBrowser => ({
  newPage: vi.fn().mockResolvedValue(page),
  close: vi.fn().mockResolvedValue(undefined),
})

describe('crawler (unit, fake browser)', () => {
  let fakePage: FakePage
  let fakeBrowser: FakeBrowser

  beforeEach(() => {
    fakePage = makeFakePage()
    fakeBrowser = makeFakeBrowser(fakePage)
    vi.resetModules()
  })

  it('crawls a single page and returns RawPage fields', async () => {
    // Dynamic import so we can inject the fake browser transport
    const { crawlWithBrowser } = await import('./crawler.js')
    const target: TargetEnv = {
      name: 'test-target',
      baseUrl: 'https://example.com',
      auth: { strategy: 'none' },
    }
    const pages = await crawlWithBrowser(fakeBrowser as unknown as Parameters<typeof crawlWithBrowser>[0], target, [], '/tmp')
    expect(pages).toHaveLength(1)
    const page = pages[0]
    expect(page.url).toBe('https://example.com/')
    expect(page.title).toBe('Example Page')
    expect(page.html).toContain('<html>')
    expect(typeof page.screenshotPath).toBe('string')
  })

  it('performs form login when auth strategy is form', async () => {
    const formPage = makeFakePage({
      url: vi.fn().mockReturnValue('https://example.com/dashboard'),
      title: vi.fn().mockResolvedValue('Dashboard'),
    })
    const browserWithLogin = makeFakeBrowser(formPage)
    const { crawlWithBrowser } = await import('./crawler.js')
    const target: TargetEnv = {
      name: 'test-target',
      baseUrl: 'https://example.com',
      auth: {
        strategy: 'form',
        loginPath: '/login',
        username: 'user@example.com',
        password: 'secret',
      },
    }
    await crawlWithBrowser(browserWithLogin as unknown as Parameters<typeof crawlWithBrowser>[0], target, [], '/tmp')
    // form login: should have navigated to login path
    expect(formPage.goto).toHaveBeenCalledWith('https://example.com/login', expect.any(Object))
  })
})

// --- E2E test: real Playwright against a local static server ---
// Gated: skips if chromium is not available

describe('crawler (E2E, real browser)', () => {
  it.runIf(process.env.RUN_E2E === '1')('crawls a local static HTML server and returns valid RawPage', async () => {
    // Gated: runs only when RUN_E2E=1 (e.g. `RUN_E2E=1 pnpm test`).
    // Requires chromium: `pnpm exec playwright install chromium`
    const http = await import('node:http')
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { launchBrowser } = await import('./browser.js')
    const { crawlWithBrowser } = await import('./crawler.js')

    const htmlContent = `<!DOCTYPE html>
<html><head><title>Test Page</title></head><body><h1>Hello E2E</h1></body></html>`

    const server = http.createServer((_, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(htmlContent)
    })

    await new Promise<void>((resolve) => server.listen(0, resolve))
    const addr = server.address() as { port: number }
    const baseUrl = `http://localhost:${addr.port}`

    const screenshotDir = await mkdtemp(join(tmpdir(), 'loop-e2e-e2e-'))
    let pages: RawPage[] = []
    try {
      const ctx = await launchBrowser()
      const target: TargetEnv = { name: 'e2e-test', baseUrl, auth: { strategy: 'none' } }
      pages = await crawlWithBrowser(ctx.browser, target, [], screenshotDir)
      await ctx.browser.close()
    } finally {
      await rm(screenshotDir, { recursive: true, force: true })
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }

    expect(pages).toHaveLength(1)
    expect(pages[0].title).toBe('Test Page')
    expect(pages[0].html).toContain('Hello E2E')
  })
})
