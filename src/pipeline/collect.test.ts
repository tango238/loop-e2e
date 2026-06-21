import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RunContext, RawPage, PageInfo, SiteStructure } from '../domain/types.js'
import type { Config } from '../config/schema.js'
import type { BrowserLike } from '../services/browser/crawler.js'

// --- Shared fixture data ---

const makeConfig = (): Config => ({
  repositories: [{ name: 'repo', label: 'Repo', url: 'https://github.com/org/repo', role: 'frontend', audience: 'user' }],
  targets: [{ name: 'test-target', baseUrl: 'https://example.com' }],
  databases: [],
  schedule: { intervalMinutes: 60 },
  scenarioDir: 'scenarios',
  github: { labels: { ready: 'ready', autoDetect: 'auto' } },
  baseline: { commit: false },
  models: { planning: 'claude-opus-4-8', report: 'claude-sonnet-4-6', verification: 'claude-opus-4-8' },
  ingestion: { cloneDepth: 50, tokenBudgetPerRepo: 120000, gitLogCount: 50 },
  refutation: { panelSize: 3, confidenceThreshold: 0.8, lenses: ['correctness', 'security', 'intentionality'] },
})

const makeRawPage = (): RawPage => ({
  url: 'https://example.com/',
  title: 'Home',
  html: '<html><body>Home</body></html>',
  meta: {},
  screenshotPath: '/tmp/screenshot.png',
})

const makePageInfo = (): PageInfo => ({
  url: 'https://example.com/',
  title: 'Home',
  description: 'Home page',
  meta: {},
  displayItems: [],
  inputItems: [],
  expectations: ['Can see homepage'],
  capabilities: ['Browse'],
})

const makeSiteStructure = (): SiteStructure => ({
  generatedAt: new Date().toISOString(),
  pages: [makePageInfo()],
  transitions: [],
})

// --- Mock factories ---

/** Minimal BrowserLike stub — the real crawl fn is mocked, so this just needs to be non-null */
const makeFakeBrowser = (): BrowserLike => ({
  newPage: vi.fn().mockResolvedValue({}),
  close: vi.fn().mockResolvedValue(undefined),
})

const makeMockStore = (baseline: SiteStructure | null = null) => ({
  loadBaseline: vi.fn().mockResolvedValue(baseline),
  saveBaseline: vi.fn().mockResolvedValue(undefined),
  loadLatestReport: vi.fn().mockResolvedValue(null),
  loadFeedback: vi.fn().mockResolvedValue([]),
  saveRunStructure: vi.fn().mockResolvedValue(undefined),
})

const makeMockCrawl = (rawPages: RawPage[] = [makeRawPage()]) =>
  vi.fn().mockResolvedValue(rawPages)

const makeMockExtract = (pageInfo: PageInfo = makePageInfo()) =>
  vi.fn().mockResolvedValue(pageInfo)

describe('pipeline/collect', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'loop-e2e-collect-test-'))
    vi.resetModules()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('first run: baseline absent → saves structure, returns null prior baseline', async () => {
    const { collect } = await import('./collect.js')
    const mockStore = makeMockStore(null) // no baseline
    const mockCrawl = makeMockCrawl()
    const mockExtract = makeMockExtract()

    const ctx: RunContext = {
      root,
      runId: 'run-001',
      config: makeConfig(),
      secrets: { db: {}, targetAuth: {}, anthropicApiKey: 'key', githubToken: 'tok' },
    }

    const result = await collect(ctx, {
      store: mockStore,
      crawl: mockCrawl,
      extractPageInfo: mockExtract,
      browser: makeFakeBrowser(),
    })

    // Returns the assembled structure
    expect(result.structure.pages).toHaveLength(1)
    expect(result.structure.pages[0].url).toBe('https://example.com/')

    // Prior state: first run has no baseline
    expect(result.prior.baseline).toBeNull()
    expect(result.prior.feedback).toEqual([])

    // saveRunStructure was called
    expect(mockStore.saveRunStructure).toHaveBeenCalledWith(root, 'run-001', expect.objectContaining({
      pages: expect.arrayContaining([expect.objectContaining({ url: 'https://example.com/' })]),
    }))

    // On first run, also saves baseline
    expect(mockStore.saveBaseline).toHaveBeenCalledWith(root, expect.objectContaining({
      pages: expect.any(Array),
    }))
  })

  it('returning run: baseline present → does NOT overwrite baseline, returns prior baseline', async () => {
    const { collect } = await import('./collect.js')
    const existingBaseline = makeSiteStructure()
    const mockStore = makeMockStore(existingBaseline) // baseline exists
    const mockCrawl = makeMockCrawl()
    const mockExtract = makeMockExtract()

    const ctx: RunContext = {
      root,
      runId: 'run-002',
      config: makeConfig(),
      secrets: { db: {}, targetAuth: {}, anthropicApiKey: 'key', githubToken: 'tok' },
    }

    const result = await collect(ctx, {
      store: mockStore,
      crawl: mockCrawl,
      extractPageInfo: mockExtract,
      browser: makeFakeBrowser(),
    })

    // Prior state includes the existing baseline
    expect(result.prior.baseline).toEqual(existingBaseline)

    // saveRunStructure still called
    expect(mockStore.saveRunStructure).toHaveBeenCalledWith(root, 'run-002', expect.any(Object))

    // On returning run, baseline is NOT overwritten
    expect(mockStore.saveBaseline).not.toHaveBeenCalled()
  })

  it('calls crawl with the first target from config', async () => {
    const { collect } = await import('./collect.js')
    const mockStore = makeMockStore(null)
    const mockCrawl = makeMockCrawl()
    const mockExtract = makeMockExtract()

    const ctx: RunContext = {
      root,
      runId: 'run-003',
      config: makeConfig(),
      secrets: { db: {}, targetAuth: {}, anthropicApiKey: 'key', githubToken: 'tok' },
    }

    await collect(ctx, { store: mockStore, crawl: mockCrawl, extractPageInfo: mockExtract, browser: makeFakeBrowser() })

    expect(mockCrawl).toHaveBeenCalledTimes(1)
    const [, target] = mockCrawl.mock.calls[0]
    expect(target.baseUrl).toBe('https://example.com')
  })

  it('calls extractPageInfo for each crawled page', async () => {
    const { collect } = await import('./collect.js')
    const rawPages = [makeRawPage(), { ...makeRawPage(), url: 'https://example.com/about', title: 'About' }]
    const mockStore = makeMockStore(null)
    const mockCrawl = makeMockCrawl(rawPages)
    const mockExtract = makeMockExtract()

    const ctx: RunContext = {
      root,
      runId: 'run-004',
      config: makeConfig(),
      secrets: { db: {}, targetAuth: {}, anthropicApiKey: 'key', githubToken: 'tok' },
    }

    await collect(ctx, { store: mockStore, crawl: mockCrawl, extractPageInfo: mockExtract, browser: makeFakeBrowser() })

    expect(mockExtract).toHaveBeenCalledTimes(2)
  })

  it('skips crawl and returns empty pages when browser is null', async () => {
    const { collect } = await import('./collect.js')
    const mockStore = makeMockStore(null)
    const mockCrawl = makeMockCrawl()
    const mockExtract = makeMockExtract()

    const ctx: RunContext = {
      root,
      runId: 'run-005',
      config: makeConfig(),
      secrets: { db: {}, targetAuth: {}, anthropicApiKey: 'key', githubToken: 'tok' },
    }

    const result = await collect(ctx, {
      store: mockStore,
      crawl: mockCrawl,
      extractPageInfo: mockExtract,
      browser: null,
    })

    // With no browser, crawl is skipped and pages is empty
    expect(result.structure.pages).toHaveLength(0)
    expect(mockCrawl).not.toHaveBeenCalled()
    expect(mockExtract).not.toHaveBeenCalled()
  })

  it('returns rawPages from the crawler in CollectResult for threading into verify', async () => {
    const { collect } = await import('./collect.js')
    const rawPage = makeRawPage()
    const mockStore = makeMockStore(null)
    const mockCrawl = makeMockCrawl([rawPage])
    const mockExtract = makeMockExtract()

    const ctx: RunContext = {
      root,
      runId: 'run-006',
      config: makeConfig(),
      secrets: { db: {}, targetAuth: {}, anthropicApiKey: 'key', githubToken: 'tok' },
    }

    const result = await collect(ctx, {
      store: mockStore,
      crawl: mockCrawl,
      extractPageInfo: mockExtract,
      browser: makeFakeBrowser(),
    })

    // rawPages must be threaded back so verify stages receive real HTML
    expect(result.rawPages).toHaveLength(1)
    expect(result.rawPages[0]).toEqual(rawPage)
  })
})
