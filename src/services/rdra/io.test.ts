import { describe, it, expect, vi } from 'vitest'
import { readAnalysisResult, writeAnalysisResult, writePending } from './io.js'

describe('readAnalysisResult', () => {
  it('parses a valid file', async () => {
    const readFile = vi.fn(async () => JSON.stringify({ usecases: [], scenarios: [] }))
    const a = await readAnalysisResult('/p', { readFile })
    expect(a.scenarios).toEqual([])
  })
  it('throws a clear error when the file is missing', async () => {
    const readFile = vi.fn(async () => {
      throw new Error('ENOENT')
    })
    await expect(readAnalysisResult('/p', { readFile })).rejects.toThrow(/analysis_result|read|analyze/i)
  })
  it('throws when usecases/scenarios are not arrays', async () => {
    const readFile = vi.fn(async () => JSON.stringify({ usecases: {}, scenarios: [] }))
    await expect(readAnalysisResult('/p', { readFile })).rejects.toThrow(/usecases|scenarios|array/i)
  })
  it('throws on invalid JSON', async () => {
    const readFile = vi.fn(async () => 'not json{')
    await expect(readAnalysisResult('/p', { readFile })).rejects.toThrow(/json/i)
  })
})

describe('writeAnalysisResult / writePending', () => {
  it('writes pretty JSON with trailing newline for the analysis', async () => {
    let written = ''
    const writeFile = vi.fn(async (_p: string, d: string) => {
      written = d
    })
    await writeAnalysisResult('/p', { usecases: [], scenarios: [] }, { writeFile })
    expect(written).toContain('"scenarios"')
    expect(written.endsWith('\n')).toBe(true)
  })
  it('wraps pending entries under generatedBy/pending', async () => {
    let written = ''
    const writeFile = vi.fn(async (_p: string, d: string) => {
      written = d
    })
    await writePending(
      '/p',
      [
        {
          loop_e2e_id: 'x',
          scenario_name: 'x',
          frontend_url: '/x',
          navigate_routes: ['/x'],
          api_endpoints: [{ method: 'GET', path: '/api/x', raw: 'GET /api/x' }],
          steps: [],
          reason: 'r',
        },
      ],
      { writeFile },
    )
    const parsed = JSON.parse(written)
    expect(parsed.generatedBy).toBe('loop-e2e rdra-export')
    expect(parsed.pending).toHaveLength(1)
    expect(parsed.pending[0].api_endpoints[0].method).toBe('GET')
  })
})
