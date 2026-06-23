import { describe, it, expect, vi } from 'vitest'
import { runReport } from './report.js'
import type { FindingsEntry } from '../../state/findings.js'
import type { VerifyFinding } from '../../domain/types.js'

const config = {
  targets: [{ name: 't', baseUrl: 'http://app' }],
  databases: [],
  repositories: [],
  models: { planning: 'o', report: 's', verification: 'o' },
  refutation: { panelSize: 3, confidenceThreshold: 0.8, lenses: [] },
  github: { labels: { ready: 'R', autoDetect: 'A' } },
}
const secrets = { db: {}, targetAuth: {}, anthropicApiKey: 'k', githubToken: '' }

const vf = (title: string): VerifyFinding => ({ category: 'security', severity: 'medium', title, detail: 'd', evidence: 'e' })
const entry = (source: 'run' | 'explore', titles: string[]): FindingsEntry => ({
  source, runId: source, startedAt: 't', diffFindings: [], verifyFindings: titles.map(vf),
})

function baseDeps(over: Partial<Parameters<typeof runReport>[2]> = {}) {
  return {
    loadConfig: async () => ({ config, secrets }) as never,
    readPendingFindings: async () => [entry('run', ['a', 'b']), entry('explore', ['c'])],
    readPendingActivity: async () => [{ source: 'grow', runId: 'g', startedAt: 't', summary: 'proposed 36' }],
    archiveConsumed: vi.fn(async () => {}),
    renderReport: vi.fn(async () => {}),
    createLlm: () => ({}) as never,
    createGithubClient: () => ({}) as never,
    clock: () => 'report-run-1',
    ...over,
  } as Parameters<typeof runReport>[2]
}

describe('runReport', () => {
  it('aggregates pending findings + activity, renders once, then archives', async () => {
    const deps = baseDeps()
    const res = await runReport('/cwd', {}, deps)

    expect(deps.renderReport).toHaveBeenCalledOnce()
    const [, , rdeps] = (deps.renderReport as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(rdeps.verifyFindings.map((f: VerifyFinding) => f.title)).toEqual(['a', 'b', 'c'])
    expect(rdeps.activity[0].summary).toBe('proposed 36')
    expect(deps.archiveConsumed).toHaveBeenCalledWith('/cwd', 'report-run-1')
    expect(res).toMatchObject({ wrote: true, findings: 3, sources: ['run', 'explore'] })
  })

  it('does nothing when there are no pending findings or activity', async () => {
    const deps = baseDeps({ readPendingFindings: async () => [], readPendingActivity: async () => [] })
    const res = await runReport('/cwd', {}, deps)
    expect(deps.renderReport).not.toHaveBeenCalled()
    expect(deps.archiveConsumed).not.toHaveBeenCalled()
    expect(res.wrote).toBe(false)
  })

  it('renders (activity-only) even when there are no findings', async () => {
    const deps = baseDeps({ readPendingFindings: async () => [] })
    const res = await runReport('/cwd', {}, deps)
    expect(deps.renderReport).toHaveBeenCalledOnce()
    expect(res.wrote).toBe(true)
    expect(res.findings).toBe(0)
  })
})
