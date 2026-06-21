import { describe, it, expect } from 'vitest'
import { fingerprint } from './hash.js'
describe('fingerprint', () => {
  it('is stable and order-sensitive', () => {
    expect(fingerprint(['a', 'b'])).toBe(fingerprint(['a', 'b']))
    expect(fingerprint(['a', 'b'])).not.toBe(fingerprint(['b', 'a']))
  })
})
