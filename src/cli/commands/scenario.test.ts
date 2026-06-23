import { describe, it, expect, vi } from 'vitest'
import { runScenario } from './scenario.js'

type GrowCallOpts = { sourceOnly?: boolean; fromPaths?: string[] }
const sourceResult = { discovered: 0, uncovered: 0, proposed: [], mode: 'source' as const, requirementsRepos: 0, sourceError: false }

describe('runScenario (deprecated alias of grow --source-only)', () => {
  it('delegates to runGrow with sourceOnly + fromPaths and warns deprecation', async () => {
    const runGrow = vi.fn(async () => sourceResult)
    const warn = vi.fn()
    await runScenario('/cwd', { from: ['docs/a.md'] }, { runGrow, warn } as never)
    expect(runGrow).toHaveBeenCalledOnce()
    const [root, opts] = runGrow.mock.calls[0] as unknown as [string, GrowCallOpts]
    expect(root).toBe('/cwd')
    expect(opts.sourceOnly).toBe(true)
    expect(opts.fromPaths).toEqual(['docs/a.md'])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/deprecated|grow --source-only/i))
  })

  it('works without --from (fromPaths undefined)', async () => {
    const runGrow = vi.fn(async () => sourceResult)
    await runScenario('/cwd', {}, { runGrow, warn: vi.fn() } as never)
    const [, opts] = runGrow.mock.calls[0] as unknown as [string, GrowCallOpts]
    expect(opts.fromPaths).toBeUndefined()
  })
})
