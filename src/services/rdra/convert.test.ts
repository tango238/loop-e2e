import { describe, it, expect } from 'vitest'
import { toPendingEntry, toOperationSteps, firstNavigateTarget, parseApiEndpoint, apiEndpoints } from './convert.js'
import type { Scenario } from '../../scenario/schema.js'

const scn: Scenario = {
  id: 'grow-hotel',
  title: 'View hotel page',
  businessFlow: 'admin views hotels',
  steps: [
    { action: 'navigate', target: '/hotel', expectedOutcome: 'Hotel page loads' },
    { action: 'assert', target: 'text=Hotel', expectedOutcome: 'heading shown' },
  ],
  expectedResults: [
    { kind: 'ui', description: 'd', assertion: 'heading visible' },
    { kind: 'api', description: 'd', assertion: 'GET /api/v2/hotels returns 200' },
  ],
  expectedDbState: [],
}

describe('parseApiEndpoint (best-effort)', () => {
  it('extracts leading METHOD + path', () => {
    expect(parseApiEndpoint('GET /api/v2/hotels returns 200')).toEqual({
      method: 'GET',
      path: '/api/v2/hotels',
      raw: 'GET /api/v2/hotels returns 200',
    })
  })
  it('defaults method to null when no leading METHOD token', () => {
    expect(parseApiEndpoint('/api/v2/hotels')).toEqual({ method: null, path: '/api/v2/hotels', raw: '/api/v2/hotels' })
  })
  it('keeps method/path null but always carries raw when unparseable', () => {
    expect(parseApiEndpoint('returns a list of hotels')).toEqual({
      method: null,
      path: null,
      raw: 'returns a list of hotels',
    })
  })
})

describe('apiEndpoints', () => {
  it('collects structured endpoints from kind=api results (best-effort)', () => {
    expect(apiEndpoints(scn)).toEqual([{ method: 'GET', path: '/api/v2/hotels', raw: 'GET /api/v2/hotels returns 200' }])
  })
  it('prefers a structured apiEndpoint field when present', () => {
    const s: Scenario = {
      ...scn,
      expectedResults: [
        { kind: 'api', description: 'd', assertion: 'list hotels', apiEndpoint: { method: 'post', path: '/api/x' } },
      ],
    }
    expect(apiEndpoints(s)).toEqual([{ method: 'POST', path: '/api/x', raw: 'list hotels' }])
  })
})

describe('convert (pending handoff)', () => {
  it('numbers steps from 1 and maps fields (no input leakage)', () => {
    const steps = toOperationSteps(scn)
    expect(steps[0]).toEqual({
      step_no: 1,
      actor: 'ユーザー',
      action: 'navigate /hotel',
      expected_result: 'Hotel page loads',
      ui_element: '/hotel',
    })
    expect(steps[1].step_no).toBe(2)
  })

  it('firstNavigateTarget returns the first navigate target or null', () => {
    expect(firstNavigateTarget(scn)).toBe('/hotel')
    expect(
      firstNavigateTarget({ ...scn, steps: [{ action: 'click', target: '#x', expectedOutcome: 'o' }] }),
    ).toBeNull()
  })

  it('toPendingEntry carries structured api_endpoints + context for reconcile, no usecase linkage', () => {
    const p = toPendingEntry(scn, ['/hotel'])
    expect(p.loop_e2e_id).toBe('grow-hotel')
    expect(p.frontend_url).toBe('/hotel')
    expect(p.navigate_routes).toEqual(['/hotel'])
    expect(p.api_endpoints).toEqual([{ method: 'GET', path: '/api/v2/hotels', raw: 'GET /api/v2/hotels returns 200' }])
    expect(p.reason).toMatch(/reconcile-owned/i)
    expect(p.steps[0].step_no).toBe(1)
    expect(p).not.toHaveProperty('usecase_id')
  })

  it('uses empty frontend_url when there is no navigate step', () => {
    const bare: Scenario = {
      ...scn,
      steps: [{ action: 'click', target: '#x', expectedOutcome: 'o' }],
      expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }],
    }
    const p = toPendingEntry(bare, [])
    expect(p.frontend_url).toBe('')
    expect(p.api_endpoints).toEqual([])
  })
})
