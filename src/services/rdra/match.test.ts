import { describe, it, expect } from 'vitest'
import { normalizePath, normalizeRoute, navigateRoutes, matchUsecase } from './match.js'
import type { Usecase } from './types.js'
import type { Scenario } from '../../scenario/schema.js'

const navScn = (target: string, api: string[] = []): Scenario => ({
  id: 'x',
  title: 'x',
  businessFlow: 'f',
  steps: [{ action: 'navigate', target, expectedOutcome: 'o' }],
  expectedResults: [
    { kind: 'ui', description: 'd', assertion: 'a' },
    ...api.map((a) => ({ kind: 'api' as const, description: 'd', assertion: a })),
  ],
  expectedDbState: [],
})

describe('normalizePath', () => {
  it('strips origin, query, fragment, trailing slash', () => {
    expect(normalizePath('https://app.test/hotel/?q=1#x')).toBe('/hotel')
    expect(normalizePath('/hotel/')).toBe('/hotel')
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('https://app.test/')).toBe('/')
  })
})

describe('normalizeRoute', () => {
  it('strips leading METHOD token and normalizes the path', () => {
    expect(normalizeRoute('GET /api/v2/hotels/')).toEqual({ method: 'GET', path: '/api/v2/hotels' })
    expect(normalizeRoute('post /api/x?y=1')).toEqual({ method: 'POST', path: '/api/x' })
  })
  it('defaults method to ANY when no leading METHOD token', () => {
    expect(normalizeRoute('/hotel')).toEqual({ method: 'ANY', path: '/hotel' })
  })
})

describe('matchUsecase — navigate key (frontend pages)', () => {
  const ucs: Usecase[] = [
    { id: 'UC-1', name: 'hotel', related_pages: ['/hotel'] },
    { id: 'UC-2', name: 'hotel detail', related_pages: ['/hotel/edit'] },
  ]
  it('matches navigate path exactly', () => {
    expect(matchUsecase(navScn('/hotel'), ucs)?.id).toBe('UC-1')
  })
  it('prefers exact over prefix', () => {
    expect(matchUsecase(navScn('/hotel/edit'), ucs)?.id).toBe('UC-2')
  })
  it('falls back to navigate prefix', () => {
    expect(matchUsecase(navScn('/hotel/123'), ucs)?.id).toBe('UC-1')
  })
})

describe('matchUsecase — api key (related_routes are API routes)', () => {
  // Real-world Spotly shape: related_pages empty, related_routes are "<METHOD> <path>".
  const ucs: Usecase[] = [{ id: 'UC-10', name: 'hotels', related_routes: ['GET /api/v2/hotels', 'POST /api/v2/hotels'] }]

  it('matches by API endpoint when navigate path does not match any page', () => {
    const s = navScn('/hotel', ['GET /api/v2/hotels returns 200'])
    expect(matchUsecase(s, ucs)?.id).toBe('UC-10')
  })
  it('ANY method matches any concrete method', () => {
    const ucsAny: Usecase[] = [{ id: 'UC-11', name: 'x', related_routes: ['ANY /api/v2/hotels'] }]
    expect(matchUsecase(navScn('/hotel', ['GET /api/v2/hotels']), ucsAny)?.id).toBe('UC-11')
  })
  it('does not match when method differs and neither is ANY', () => {
    const s = navScn('/hotel', ['DELETE /api/v2/hotels'])
    const onlyGet: Usecase[] = [{ id: 'UC-12', name: 'x', related_routes: ['GET /api/v2/hotels'] }]
    expect(matchUsecase(s, onlyGet)).toBeNull()
  })
})

describe('matchUsecase — priority navigate-exact > api-exact', () => {
  it('navigate exact wins over an api exact on a different usecase', () => {
    const ucs: Usecase[] = [
      { id: 'API', name: 'api', related_routes: ['GET /api/v2/hotels'] },
      { id: 'PAGE', name: 'page', related_pages: ['/hotel'] },
    ]
    expect(matchUsecase(navScn('/hotel', ['GET /api/v2/hotels']), ucs)?.id).toBe('PAGE')
  })
})

describe('matchUsecase — misc', () => {
  const ucs: Usecase[] = [{ id: 'UC-1', name: 'hotel', related_pages: ['/hotel'] }]
  it('returns null when nothing matches', () => {
    expect(matchUsecase(navScn('/booking'), ucs)).toBeNull()
  })
  it('matches via api even with no navigate step', () => {
    const noNav: Scenario = {
      ...navScn('/hotel', ['GET /api/v2/hotels']),
      steps: [{ action: 'click', target: '#x', expectedOutcome: 'o' }],
    }
    const apiUc: Usecase[] = [{ id: 'A', name: 'a', related_routes: ['GET /api/v2/hotels'] }]
    expect(matchUsecase(noNav, apiUc)?.id).toBe('A')
  })
})

describe('navigateRoutes', () => {
  it('collects normalized navigate targets', () => {
    const s: Scenario = {
      ...navScn('/hotel'),
      steps: [
        { action: 'navigate', target: '/hotel/', expectedOutcome: 'o' },
        { action: 'navigate', target: 'https://app.test/booking?x=1', expectedOutcome: 'o' },
      ],
    }
    expect(navigateRoutes(s)).toEqual(['/hotel', '/booking'])
  })
})
