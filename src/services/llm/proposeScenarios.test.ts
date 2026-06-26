import { describe, it, expect, vi } from 'vitest'
import { proposeScenarios, summarizeRequirements, applyDefaultAuthPrecondition } from './proposeScenarios.js'
import type { Llm } from './client.js'
import type { RawPage, PageInfo } from '../../domain/types.js'
import type { Scenario } from '../../scenario/schema.js'
import type { RequirementContext } from '../repo/reader.js'

const rawPage = (url: string): RawPage => ({ url, title: 't', html: '', meta: {}, screenshotPath: '' })
const pageInfo = (url: string): PageInfo => ({
  url, title: 'Hotel list', description: 'list of hotels',
  displayItems: [{ type: 'table', label: 'hotels' }],
  inputItems: [], expectations: ['shows hotels'], capabilities: ['view hotels'],
})
const scn = (id: string): Scenario => ({
  id, title: 'T', businessFlow: 'f',
  steps: [{ action: 'navigate', target: '/x', expectedOutcome: 'o' }],
  expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }], expectedDbState: [],
})
const req = (name: string): RequirementContext => ({
  repo: { name, label: name, url: `https://github.com/o/${name}`, role: 'frontend', audience: 'user' },
  readme: 'README body', docs: [], codeSummary: 'function buy(){}', gitlogSummary: 'abc feat: buy',
})

describe('summarizeRequirements', () => {
  it('returns a bounded summary including repo names', () => {
    const s = summarizeRequirements([req('web')], 2000)
    expect(s).toContain('web')
    expect(s.length).toBeLessThanOrEqual(2000)
  })
  it('returns empty string for no requirements', () => {
    expect(summarizeRequirements([])).toBe('')
  })
})

describe('proposeScenarios', () => {
  it('returns [] when neither uncovered pages nor requirements are given', async () => {
    const llm = { complete: vi.fn() } as unknown as Llm
    const result = await proposeScenarios(llm, { uncovered: [], requirements: [] })
    expect(result).toEqual([])
    expect(llm.complete).not.toHaveBeenCalled()
  })

  it('proposes from uncovered pages only (crawl), grow-prefixing ids', async () => {
    const extractPageInfo = vi.fn(async (_l: Llm, r: RawPage) => pageInfo(r.url))
    const llm = { complete: vi.fn(async () => [scn('hotel')]) } as unknown as Llm
    const result = await proposeScenarios(llm, { uncovered: [rawPage('http://x/hotel')], requirements: [] }, { extractPageInfo })
    expect(extractPageInfo).toHaveBeenCalledTimes(1)
    expect(result[0].id).toMatch(/^grow-/)
  })

  it('proposes from requirements only (source) via generateScenarios', async () => {
    const generateScenarios = vi.fn(async () => [scn('buy-flow')])
    const llm = { complete: vi.fn() } as unknown as Llm
    const result = await proposeScenarios(llm, { uncovered: [], requirements: [req('web')] }, { generateScenarios })
    expect(generateScenarios).toHaveBeenCalledOnce()
    expect(llm.complete).not.toHaveBeenCalled() // page path not taken
    expect(result[0].id).toMatch(/^grow-/)
  })

  it('fuses both: page proposals carry the source summary, plus source-derived flows; ids deduped', async () => {
    const extractPageInfo = vi.fn(async (_l: Llm, r: RawPage) => pageInfo(r.url))
    let pagePrompt = ''
    const llm = { complete: vi.fn(async (_role: string, prompt: string) => { pagePrompt = prompt; return [scn('grow-hotel')] }) } as unknown as Llm
    const generateScenarios = vi.fn(async () => [scn('grow-hotel')]) // same id → dedup
    const result = await proposeScenarios(
      llm,
      { uncovered: [rawPage('http://x/hotel')], requirements: [req('web')] },
      { extractPageInfo, generateScenarios },
    )
    expect(pagePrompt).toContain('web') // source summary fused into the page prompt
    expect(generateScenarios).toHaveBeenCalledOnce()
    expect(result.map((s) => s.id)).toEqual(['grow-hotel', 'grow-hotel-2']) // combined + deduped
  })

  it('isolates a failing page batch but still returns source-derived scenarios', async () => {
    const extractPageInfo = vi.fn(async (_l: Llm, r: RawPage) => pageInfo(r.url))
    const llm = { complete: vi.fn(async () => { throw new Error('truncated') }) } as unknown as Llm
    const generateScenarios = vi.fn(async () => [scn('src')])
    const result = await proposeScenarios(
      llm,
      { uncovered: [rawPage('http://x/a')], requirements: [req('web')] },
      { extractPageInfo, generateScenarios },
    )
    expect(result.map((s) => s.id)).toEqual(['grow-src'])
  })

  it('defaults proposed scenarios to an authenticated precondition (grow = post-login pages)', async () => {
    const extractPageInfo = vi.fn(async (_l: Llm, r: RawPage) => pageInfo(r.url))
    const llm = { complete: vi.fn(async () => [scn('dashboard')]) } as unknown as Llm
    const result = await proposeScenarios(llm, { uncovered: [rawPage('http://x/dashboard')], requirements: [] }, { extractPageInfo })
    expect(result[0].precondition).toEqual({ auth: 'authenticated' })
  })
})

describe('applyDefaultAuthPrecondition', () => {
  it('adds auth:authenticated to a scenario lacking a precondition', () => {
    const [out] = applyDefaultAuthPrecondition([scn('a')])
    expect(out.precondition).toEqual({ auth: 'authenticated' })
  })

  it('preserves an explicit precondition (does not override unauthenticated)', () => {
    const explicit: Scenario = { ...scn('b'), precondition: { auth: 'unauthenticated' } }
    const [out] = applyDefaultAuthPrecondition([explicit])
    expect(out.precondition).toEqual({ auth: 'unauthenticated' })
  })

  it('exempts the login scenario (step targets the loginPath)', () => {
    const login: Scenario = {
      id: 'grow-login', title: 'ログイン', businessFlow: 'sign in',
      steps: [
        { action: 'navigate', target: '/login', expectedOutcome: 'login form' },
        { action: 'fill', target: '/login', input: 'x', expectedOutcome: 'filled' },
        { action: 'submit', target: '/login', expectedOutcome: 'dashboard' },
      ],
      expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }], expectedDbState: [],
    }
    const [out] = applyDefaultAuthPrecondition([login], '/login')
    expect(out.precondition).toBeUndefined()
  })
})
