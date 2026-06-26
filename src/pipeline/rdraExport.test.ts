import { describe, it, expect, vi } from 'vitest'
import { rdraExport } from './rdraExport.js'
import type { Scenario } from '../scenario/schema.js'
import type { PendingEntry } from '../services/rdra/types.js'

const scn = (id: string, target: string): Scenario => ({
  id,
  title: id,
  businessFlow: 'f',
  steps: [{ action: 'navigate', target, expectedOutcome: 'o' }],
  expectedResults: [{ kind: 'ui', description: 'd', assertion: 'a' }],
  expectedDbState: [],
})

describe('rdraExport (all scenarios → pending; reconcile is the sole arbiter)', () => {
  it('writes every adopted scenario to pending with no usecase linkage', async () => {
    let written: PendingEntry[] | null = null
    const result = await rdraExport(
      { scenarioDir: '/s', intoPath: '/out/usecases/analysis_result.json' },
      {
        loadScenarios: async () => [scn('grow-hotel', '/hotel'), scn('grow-booking', '/booking')],
        writePending: async (_p, pend) => {
          written = pend
        },
      },
    )
    expect(result.pending).toBe(2)
    expect(result.pendingPath).toBe('/out/usecases/loop-e2e-pending.json')
    expect(written!.map((p) => p.loop_e2e_id)).toEqual(['grow-hotel', 'grow-booking'])
    // PendingEntry carries no usecase_id — matching is delegated to rdra-analyzer.
    expect(written!.every((p) => !('usecase_id' in p))).toBe(true)
  })

  it('never touches analysis_result.json (no analysis read/write to inject)', async () => {
    const writePending = vi.fn()
    await rdraExport(
      { scenarioDir: '/s', intoPath: '/out/usecases/analysis_result.json' },
      { loadScenarios: async () => [scn('grow-hotel', '/hotel')], writePending },
    )
    expect(writePending).toHaveBeenCalledTimes(1)
  })

  it('returns zero and writes nothing when there are no scenarios', async () => {
    const writePending = vi.fn()
    const result = await rdraExport(
      { scenarioDir: '/s', intoPath: '/out/usecases/analysis_result.json' },
      { loadScenarios: async () => [], writePending },
    )
    expect(result.pending).toBe(0)
    expect(result.pendingPath).toBeUndefined()
    expect(writePending).not.toHaveBeenCalled()
  })
})
