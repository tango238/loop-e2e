import { describe, it, expect, vi } from 'vitest'
import type { CollectResult } from '../../pipeline/collect.js'
import type { DiffFinding } from '../../domain/types.js'
import { runRun } from './run.js'

const emptyStructure = { generatedAt: '2024-01-01T00:00:00.000Z', pages: [], transitions: [] }
const emptyPrior = { baseline: null, latestReport: null, feedback: [] }

const sampleFinding: DiffFinding = {
  kind: 'transition',
  severity: 'high',
  expected: 'expected',
  actual: 'actual',
  location: '/home',
}

function makeCollectResult(): CollectResult {
  return { structure: emptyStructure, prior: emptyPrior }
}

describe('runRun', () => {
  it('calls stages in order: collect → diff → report', async () => {
    const order: string[] = []

    const deps = {
      collect: vi.fn().mockImplementation(async () => { order.push('collect'); return makeCollectResult() }),
      detectDiffs: vi.fn().mockImplementation(async () => { order.push('diff'); return [] }),
      writeReport: vi.fn().mockImplementation(async () => { order.push('report') }),
      clock: () => 'run-2024-01-01',
    }

    await runRun('/tmp/root', {}, deps)

    expect(order).toEqual(['collect', 'diff', 'report'])
    expect(deps.collect).toHaveBeenCalledOnce()
    expect(deps.detectDiffs).toHaveBeenCalledOnce()
    expect(deps.writeReport).toHaveBeenCalledOnce()
  })

  it('uses injected clock for deterministic runId', async () => {
    const capturedRunIds: string[] = []

    const deps = {
      collect: vi.fn().mockImplementation(async (ctx: { runId: string }) => { capturedRunIds.push(ctx.runId); return makeCollectResult() }),
      detectDiffs: vi.fn().mockResolvedValue([]),
      writeReport: vi.fn().mockResolvedValue(undefined),
      clock: () => 'test-run-fixed',
    }

    await runRun('/tmp/root', {}, deps)
    expect(capturedRunIds[0]).toBe('test-run-fixed')
  })

  it('verifyFindings is always [] (M6 stub)', async () => {
    let capturedVerifyFindings: unknown = 'not-set'

    const deps = {
      collect: vi.fn().mockResolvedValue(makeCollectResult()),
      detectDiffs: vi.fn().mockResolvedValue([sampleFinding]),
      writeReport: vi.fn().mockImplementation(async (_root: string, _runId: string, reportDeps: { verifyFindings: unknown }) => {
        capturedVerifyFindings = reportDeps.verifyFindings
      }),
      clock: () => 'run-stub',
    }

    await runRun('/tmp/root', {}, deps)
    expect(capturedVerifyFindings).toEqual([])
  })

  it('if collect fails, diff and report still run with empty structure', async () => {
    const order: string[] = []

    const deps = {
      collect: vi.fn().mockImplementation(async () => { order.push('collect-fail'); throw new Error('crawl error') }),
      detectDiffs: vi.fn().mockImplementation(async () => { order.push('diff'); return [] }),
      writeReport: vi.fn().mockImplementation(async () => { order.push('report') }),
      clock: () => 'run-partial',
    }

    await runRun('/tmp/root', {}, deps)

    expect(order).toEqual(['collect-fail', 'diff', 'report'])
    // diff should be called with empty structure (no crash)
    expect(deps.detectDiffs).toHaveBeenCalledOnce()
    expect(deps.writeReport).toHaveBeenCalledOnce()
  })

  it('if diff fails, report still runs with empty diffFindings', async () => {
    const order: string[] = []
    let capturedDiffFindings: unknown = 'not-set'

    const deps = {
      collect: vi.fn().mockImplementation(async () => { order.push('collect'); return makeCollectResult() }),
      detectDiffs: vi.fn().mockImplementation(async () => { order.push('diff-fail'); throw new Error('diff error') }),
      writeReport: vi.fn().mockImplementation(async (_root: string, _runId: string, reportDeps: { diffFindings: unknown }) => {
        order.push('report')
        capturedDiffFindings = reportDeps.diffFindings
      }),
      clock: () => 'run-partial-diff',
    }

    await runRun('/tmp/root', {}, deps)

    expect(order).toEqual(['collect', 'diff-fail', 'report'])
    expect(capturedDiffFindings).toEqual([])
  })
})
