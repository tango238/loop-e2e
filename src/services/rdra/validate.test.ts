import { describe, it, expect } from 'vitest'
import { validateAnalysisResult } from './validate.js'
import type { AnalysisResult, OperationScenario, OperationStep } from './types.js'

const step = (n: number): OperationStep => ({ step_no: n, actor: 'ユーザー', action: 'a', expected_result: 'r', ui_element: 'u' })

const op = (id: string, uc: string, steps: OperationStep[] = [step(1)]): OperationScenario => ({
  scenario_id: id,
  usecase_id: uc,
  usecase_name: 'n',
  scenario_name: id,
  scenario_type: 'normal',
  frontend_url: '',
  api_endpoint: '',
  steps,
  variations: [],
})

const wrap = (scenarios: OperationScenario[]): AnalysisResult => ({ usecases: [{ id: 'UC-1', name: 'n' }], scenarios })

describe('validateAnalysisResult', () => {
  it('passes for a referentially valid file', () => {
    expect(() => validateAnalysisResult(wrap([op('LE-a', 'UC-1')]))).not.toThrow()
  })
  it('throws on a dangling usecase_id', () => {
    expect(() => validateAnalysisResult(wrap([op('LE-a', 'UC-X')]))).toThrow(/usecase_id/i)
  })
  it('throws on duplicate scenario_id', () => {
    expect(() => validateAnalysisResult(wrap([op('LE-a', 'UC-1'), op('LE-a', 'UC-1')]))).toThrow(/duplicate/i)
  })
  it('throws on non-sequential step_no', () => {
    expect(() => validateAnalysisResult(wrap([op('LE-a', 'UC-1', [step(2)])]))).toThrow(/step_no/i)
  })
})
