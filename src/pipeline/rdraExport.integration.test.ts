import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rdraExport } from './rdraExport.js'
import type { Scenario } from '../scenario/schema.js'

const scn = (id: string, target: string, api: string[] = []): Scenario => ({
  id,
  title: id,
  businessFlow: 'f',
  steps: [{ action: 'navigate', target, expectedOutcome: 'o' }],
  expectedResults: [
    { kind: 'ui', description: 'd', assertion: 'a' },
    ...api.map((a) => ({ kind: 'api' as const, description: 'd', assertion: a })),
  ],
  expectedDbState: [],
})

describe('rdraExport (real fs round trip)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rdra-'))
    await mkdir(join(dir, 'usecases'), { recursive: true })
    await writeFile(
      join(dir, 'usecases', 'analysis_result.json'),
      JSON.stringify({
        metadata: {},
        usecases: [{ id: 'UC-1', name: 'hotel', related_pages: [], related_routes: ['GET /api/v2/hotels'] }],
        scenarios: [],
      }),
    )
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes all scenarios to pending and leaves analysis_result.json untouched', async () => {
    const into = join(dir, 'usecases', 'analysis_result.json')
    const before = await readFile(into, 'utf8')
    const deps = {
      loadScenarios: async () => [
        scn('grow-hotel', '/hotel', ['GET /api/v2/hotels returns 200']),
        scn('grow-booking', '/booking'),
      ],
    }
    const r = await rdraExport({ scenarioDir: '/unused', intoPath: into }, deps)
    expect(r.pending).toBe(2)
    expect(r.pendingPath).toBe(join(dir, 'usecases', 'loop-e2e-pending.json'))

    // analysis_result.json is the ① Core's file — rdra-export must not modify it.
    expect(await readFile(into, 'utf8')).toBe(before)

    const pending = JSON.parse(await readFile(join(dir, 'usecases', 'loop-e2e-pending.json'), 'utf8'))
    expect(pending.generatedBy).toBe('loop-e2e rdra-export')
    expect(pending.pending.map((p: { loop_e2e_id: string }) => p.loop_e2e_id)).toEqual(['grow-hotel', 'grow-booking'])
    // Structured api_endpoints survive in full for reconcile to fact-check.
    expect(pending.pending[0].api_endpoints).toEqual([
      { method: 'GET', path: '/api/v2/hotels', raw: 'GET /api/v2/hotels returns 200' },
    ])
    expect(pending.pending[0]).not.toHaveProperty('usecase_id')
  })

  it('writes no pending file when there are no scenarios', async () => {
    const into = join(dir, 'usecases', 'analysis_result.json')
    const r = await rdraExport({ scenarioDir: '/unused', intoPath: into }, { loadScenarios: async () => [] })
    expect(r.pending).toBe(0)
    await expect(access(join(dir, 'usecases', 'loop-e2e-pending.json'))).rejects.toThrow()
  })
})
