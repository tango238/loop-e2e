import { describe, it, expect, vi } from 'vitest'
import { waitForReadiness } from './readiness.js'
const noSleep = async () => {}
describe('waitForReadiness', () => {
  it('resolves once fetch returns 2xx', async () => {
    const statuses = [503, 503, 200]
    const fetchFn = vi.fn(async () => ({ status: statuses.shift() ?? 200 }))
    await expect(waitForReadiness('http://x', { timeoutSec: 30, intervalSec: 1 }, fetchFn, noSleep)).resolves.toBeUndefined()
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })
  it('throws on timeout when never 2xx', async () => {
    const fetchFn = vi.fn(async () => ({ status: 500 }))
    await expect(waitForReadiness('http://x', { timeoutSec: 2, intervalSec: 1 }, fetchFn, noSleep)).rejects.toThrow(/readiness check failed:.*not ready/)
  })
})
