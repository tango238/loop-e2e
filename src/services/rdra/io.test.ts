import { describe, it, expect, vi } from 'vitest'
import { writePending } from './io.js'

describe('writePending', () => {
  it('wraps pending entries under generatedBy/pending with a trailing newline', async () => {
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
    expect(written.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(written)
    expect(parsed.generatedBy).toBe('loop-e2e rdra-export')
    expect(parsed.pending).toHaveLength(1)
    expect(parsed.pending[0].api_endpoints[0].method).toBe('GET')
  })
})
