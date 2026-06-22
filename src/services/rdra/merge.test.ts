import { describe, it, expect } from 'vitest'
import { mergeIntoAnalysisResult } from './merge.js'
import type { AnalysisResult, OperationScenario } from './types.js'

const op = (id: string, uc = 'UC-1'): OperationScenario => ({
  scenario_id: id,
  usecase_id: uc,
  usecase_name: 'n',
  scenario_name: id,
  scenario_type: 'normal',
  frontend_url: '/x',
  api_endpoint: '',
  steps: [],
  variations: [],
})

const base = (): AnalysisResult => ({
  metadata: { total_usecases: 1, total_scenarios: 2, note: 'keep me' },
  usecases: [{ id: 'UC-1', name: 'n' }],
  scenarios: [op('SC-001-01'), op('LE-old')],
  extra_top_level: 'preserve',
})

describe('mergeIntoAnalysisResult', () => {
  it('replaces LE- scenarios, preserves rdra scenarios + usecases + unknown fields', () => {
    const { analysis, replaced } = mergeIntoAnalysisResult(base(), [op('LE-grow-hotel')])
    expect(replaced).toBe(1)
    const ids = analysis.scenarios.map((s) => s.scenario_id)
    expect(ids).toContain('SC-001-01')
    expect(ids).toContain('LE-grow-hotel')
    expect(ids).not.toContain('LE-old')
    expect(analysis.usecases).toHaveLength(1)
    expect(analysis.extra_top_level).toBe('preserve')
  })

  it('recomputes metadata counts but keeps other metadata', () => {
    const { analysis } = mergeIntoAnalysisResult(base(), [op('LE-a'), op('LE-b')])
    expect(analysis.metadata?.total_scenarios).toBe(3) // SC-001-01 + LE-a + LE-b
    expect(analysis.metadata?.total_usecases).toBe(1)
    expect(analysis.metadata?.note).toBe('keep me')
  })

  it('is idempotent across re-runs', () => {
    const first = mergeIntoAnalysisResult(base(), [op('LE-grow-hotel')]).analysis
    const second = mergeIntoAnalysisResult(first, [op('LE-grow-hotel')]).analysis
    expect(second.scenarios.filter((s) => s.scenario_id === 'LE-grow-hotel')).toHaveLength(1)
  })
})
