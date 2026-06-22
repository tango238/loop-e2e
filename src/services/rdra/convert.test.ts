import { describe, it, expect } from 'vitest'
import {
  toOperationScenario,
  toPendingEntry,
  toOperationSteps,
  firstNavigateTarget,
  parseApiEndpoint,
  apiEndpoints,
  apiEndpointString,
} from './convert.js'
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

describe('apiEndpoints / apiEndpointString', () => {
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
  it('builds a single string: <METHOD> <path> / path / raw / empty', () => {
    expect(apiEndpointString([{ method: 'GET', path: '/api/x', raw: 'r' }])).toBe('GET /api/x')
    expect(apiEndpointString([{ method: null, path: '/api/x', raw: 'r' }])).toBe('/api/x')
    expect(apiEndpointString([{ method: null, path: null, raw: 'raw text' }])).toBe('raw text')
    expect(apiEndpointString([])).toBe('')
  })
})

describe('convert', () => {
  it('maps a scenario to an OperationScenario with LE- prefix, usecase linkage, single-string api_endpoint', () => {
    const op = toOperationScenario(scn, { id: 'UC-012', name: 'ホテル一覧' })
    expect(op.scenario_id).toBe('LE-grow-hotel')
    expect(op.usecase_id).toBe('UC-012')
    expect(op.usecase_name).toBe('ホテル一覧')
    expect(op.scenario_name).toBe('View hotel page')
    expect(op.scenario_type).toBe('normal')
    expect(op.frontend_url).toBe('/hotel')
    expect(op.api_endpoint).toBe('GET /api/v2/hotels') // single string, not array
    expect(op.variations).toEqual([])
  })

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

  it('toPendingEntry carries structured api_endpoints + context for reconcile', () => {
    const p = toPendingEntry(scn, ['/hotel'])
    expect(p.loop_e2e_id).toBe('grow-hotel')
    expect(p.frontend_url).toBe('/hotel')
    expect(p.navigate_routes).toEqual(['/hotel'])
    expect(p.api_endpoints).toEqual([{ method: 'GET', path: '/api/v2/hotels', raw: 'GET /api/v2/hotels returns 200' }])
    expect(p.reason).toMatch(/no matching usecase/i)
    expect(p.steps[0].step_no).toBe(1)
  })

  it('uses empty strings when no navigate / no api result', () => {
    const bare: Scenario = {
      ...scn,
      steps: [{ action: 'click', target: '#x', expectedOutcome: 'o' }],
      expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }],
    }
    const op = toOperationScenario(bare, { id: 'UC-1', name: 'n' })
    expect(op.frontend_url).toBe('')
    expect(op.api_endpoint).toBe('')
  })
})
