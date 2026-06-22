import { describe, it, expect, vi } from 'vitest'
import { rdraExport } from './rdraExport.js'
import type { Scenario } from '../scenario/schema.js'
import type { AnalysisResult } from '../services/rdra/types.js'

const scn = (id: string, target: string): Scenario => ({
  id,
  title: id,
  businessFlow: 'f',
  steps: [{ action: 'navigate', target, expectedOutcome: 'o' }],
  expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }],
  expectedDbState: [],
})

const analysis = (): AnalysisResult => ({
  metadata: {},
  usecases: [{ id: 'UC-1', name: 'hotel', related_pages: ['/hotel'] }],
  scenarios: [],
})

describe('rdraExport', () => {
  it('merges matched scenarios and writes pending for unmatched', async () => {
    let writtenAnalysis: AnalysisResult | null = null
    let writtenPending: unknown = null
    const result = await rdraExport(
      { scenarioDir: '/s', intoPath: '/out/usecases/analysis_result.json' },
      {
        loadScenarios: async () => [scn('grow-hotel', '/hotel'), scn('grow-booking', '/booking')],
        readAnalysisResult: async () => analysis(),
        writeAnalysisResult: async (_p, a) => {
          writtenAnalysis = a
        },
        writePending: async (_p, pend) => {
          writtenPending = pend
        },
      },
    )
    expect(result.matched).toBe(1)
    expect(result.pending).toBe(1)
    expect(result.pendingPath).toBe('/out/usecases/loop-e2e-pending.json')
    expect(writtenAnalysis!.scenarios.map((s) => s.scenario_id)).toContain('LE-grow-hotel')
    expect((writtenPending as { loop_e2e_id: string }[])[0].loop_e2e_id).toBe('grow-booking')
  })

  it('does not write pending when all match', async () => {
    const writePending = vi.fn()
    const result = await rdraExport(
      { scenarioDir: '/s', intoPath: '/out/analysis_result.json' },
      {
        loadScenarios: async () => [scn('grow-hotel', '/hotel')],
        readAnalysisResult: async () => analysis(),
        writeAnalysisResult: async () => {},
        writePending,
      },
    )
    expect(result.pending).toBe(0)
    expect(result.pendingPath).toBeUndefined()
    expect(writePending).not.toHaveBeenCalled()
  })

  it('returns zeros and writes nothing when there are no scenarios', async () => {
    const writeAnalysisResult = vi.fn()
    const result = await rdraExport(
      { scenarioDir: '/s', intoPath: '/out/analysis_result.json' },
      {
        loadScenarios: async () => [],
        readAnalysisResult: async () => analysis(),
        writeAnalysisResult,
      },
    )
    expect(result.matched).toBe(0)
    expect(writeAnalysisResult).not.toHaveBeenCalled()
  })

  it('does not write when validation fails (dangling usecase_id in existing file)', async () => {
    const writeAnalysisResult = vi.fn()
    await expect(
      rdraExport(
        { scenarioDir: '/s', intoPath: '/o/a.json' },
        {
          loadScenarios: async () => [scn('grow-hotel', '/hotel')],
          readAnalysisResult: async () => ({
            metadata: {},
            usecases: [{ id: 'UC-1', name: 'hotel', related_pages: ['/hotel'] }],
            scenarios: [
              {
                scenario_id: 'SC-x',
                usecase_id: 'GHOST',
                usecase_name: '',
                scenario_name: '',
                scenario_type: 'normal',
                frontend_url: '',
                api_endpoint: '',
                steps: [],
                variations: [],
              },
            ],
          }),
          writeAnalysisResult,
        },
      ),
    ).rejects.toThrow(/usecase_id/i)
    expect(writeAnalysisResult).not.toHaveBeenCalled()
  })
})
