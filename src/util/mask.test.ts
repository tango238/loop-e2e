import { describe, it, expect } from 'vitest'
import { maskSecrets } from './mask.js'

describe('maskSecrets', () => {
  it('replaces every occurrence of each secret with ***', () => {
    expect(maskSecrets('token=abc123 and abc123', ['abc123'])).toBe('token=*** and ***')
  })
  it('ignores empty secrets', () => {
    expect(maskSecrets('hello', ['', undefined as unknown as string])).toBe('hello')
  })
})
