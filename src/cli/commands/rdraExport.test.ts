import { describe, it, expect, vi } from 'vitest'
import { runRdraExport } from './rdraExport.js'

describe('runRdraExport', () => {
  it('resolves default into path and config scenarioDir, calls rdraExport', async () => {
    const rdraExport = vi.fn(async (args) => ({ pending: 0, intoPath: args.intoPath }))
    const loadConfig = vi.fn(async () => ({ config: { scenarioDir: 'scenarios' } }))
    const r = await runRdraExport('/root', {}, { rdraExport, loadConfig })
    expect(rdraExport).toHaveBeenCalledWith({
      scenarioDir: '/root/scenarios',
      intoPath: '/root/output/usecases/analysis_result.json',
    })
    expect(r.pending).toBe(0)
  })

  it('honours --into and --scenario-dir overrides', async () => {
    const rdraExport = vi.fn(async (args) => ({ pending: 0, intoPath: args.intoPath }))
    const loadConfig = vi.fn(async () => ({ config: { scenarioDir: 'scenarios' } }))
    await runRdraExport('/root', { into: '/abs/a.json', scenarioDir: '/abs/scn' }, { rdraExport, loadConfig })
    expect(rdraExport).toHaveBeenCalledWith({ scenarioDir: '/abs/scn', intoPath: '/abs/a.json' })
  })

  it('falls back to scenarios dir when config load fails', async () => {
    const rdraExport = vi.fn(async (args) => ({ pending: 0, intoPath: args.intoPath }))
    const loadConfig = vi.fn(async () => {
      throw new Error('no config')
    })
    await runRdraExport('/root', {}, { rdraExport, loadConfig })
    expect(rdraExport).toHaveBeenCalledWith({
      scenarioDir: '/root/scenarios',
      intoPath: '/root/output/usecases/analysis_result.json',
    })
  })
})
