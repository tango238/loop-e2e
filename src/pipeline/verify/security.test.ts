import { describe, it, expect, vi } from 'vitest'
import {
  verifySecurity,
  findPlaintextCards,
  findPlaintextPasswords,
  hasCsrfProtection,
  luhn,
} from './security.js'
import type { RawPage } from '../../domain/types.js'
import type { Llm } from '../../services/llm/client.js'

function makePage(html: string, url = 'http://example.com/'): RawPage {
  return { url, title: 'Test', html, meta: {}, screenshotPath: '/tmp/shot.png' }
}

function makeLlm(): Llm {
  return { complete: vi.fn() } as unknown as Llm
}

// --- unit tests for helpers ---

describe('luhn', () => {
  it('validates a known Visa test number', () => {
    expect(luhn('4111111111111111')).toBe(true)
  })
  it('rejects an invalid number', () => {
    expect(luhn('4111111111111112')).toBe(false)
  })
})

describe('findPlaintextCards', () => {
  it('detects a Visa test card in text', () => {
    const text = 'Your card: 4111111111111111 was charged.'
    expect(findPlaintextCards(text)).toContain('4111111111111111')
  })

  it('ignores numbers that fail Luhn check', () => {
    const text = 'Number: 4111111111111112'
    expect(findPlaintextCards(text)).toHaveLength(0)
  })

  it('handles card with spaces', () => {
    const text = '4111 1111 1111 1111'
    expect(findPlaintextCards(text)).toContain('4111111111111111')
  })

  it('returns empty array when no card-like sequences present', () => {
    const text = 'Hello world, order #12345 shipped.'
    expect(findPlaintextCards(text)).toHaveLength(0)
  })
})

describe('findPlaintextPasswords', () => {
  it('detects password value in standard order', () => {
    const html = `<input type="password" value="hunter2" name="pass">`
    expect(findPlaintextPasswords(html)).toContain('hunter2')
  })

  it('detects password value in reverse attribute order', () => {
    const html = `<input value="secret123" type="password">`
    expect(findPlaintextPasswords(html)).toContain('secret123')
  })

  it('returns empty when no password value', () => {
    const html = `<input type="password" name="pass">`
    expect(findPlaintextPasswords(html)).toHaveLength(0)
  })

  it('returns empty for non-password input with value', () => {
    const html = `<input type="text" value="hunter2">`
    expect(findPlaintextPasswords(html)).toHaveLength(0)
  })
})

describe('hasCsrfProtection', () => {
  it('detects _csrf hidden input', () => {
    const html = `<form><input name="_csrf" value="abc123" type="hidden"></form>`
    expect(hasCsrfProtection(html)).toBe(true)
  })

  it('detects csrf-token meta tag', () => {
    const html = `<meta name="csrf-token" content="tok">`
    expect(hasCsrfProtection(html)).toBe(true)
  })

  it('detects csrfmiddlewaretoken (Django)', () => {
    const html = `<input name="csrfmiddlewaretoken" value="x">`
    expect(hasCsrfProtection(html)).toBe(true)
  })

  it('detects X-CSRF-Token header reference in script', () => {
    const html = `<form>...</form><script>const headers = {"X-CSRF-Token": tok}</script>`
    expect(hasCsrfProtection(html)).toBe(true)
  })

  it('returns false when no CSRF pattern found', () => {
    const html = `<form><input name="email"><button>Submit</button></form>`
    expect(hasCsrfProtection(html)).toBe(false)
  })
})

// --- integration tests for verifySecurity ---

describe('verifySecurity', () => {
  it('returns empty array for clean page with no form', async () => {
    const html = `<html><body><p>Hello world</p></body></html>`
    const result = await verifySecurity({ llm: makeLlm(), pages: [makePage(html)] })
    expect(result).toEqual([])
  })

  it('detects plaintext password in DOM', async () => {
    const html = `<form><input type="password" value="hunter2"></form>`
    const result = await verifySecurity({ llm: makeLlm(), pages: [makePage(html)] })
    const finding = result.find((f) => f.title.includes('password'))
    expect(finding).toBeDefined()
    expect(finding?.category).toBe('security')
    expect(finding?.severity).toBe('high')
  })

  it('detects credit card number in rendered text', async () => {
    const html = `<html><body><p>Your card 4111111111111111 was charged</p></body></html>`
    const result = await verifySecurity({ llm: makeLlm(), pages: [makePage(html)] })
    const finding = result.find((f) => f.title.includes('card'))
    expect(finding).toBeDefined()
    expect(finding?.severity).toBe('high')
  })

  it('detects missing CSRF on page with form', async () => {
    const html = `<form><input type="text" name="email"><button>Submit</button></form>`
    const result = await verifySecurity({ llm: makeLlm(), pages: [makePage(html)] })
    const finding = result.find((f) => f.title.includes('CSRF'))
    expect(finding).toBeDefined()
    expect(finding?.severity).toBe('medium')
  })

  it('does NOT flag missing CSRF on page without form', async () => {
    const html = `<html><body><p>No form here</p></body></html>`
    const result = await verifySecurity({ llm: makeLlm(), pages: [makePage(html)] })
    const csrfFinding = result.find((f) => f.title.includes('CSRF'))
    expect(csrfFinding).toBeUndefined()
  })

  it('does NOT flag missing CSRF when CSRF token present', async () => {
    const html = `<form><input name="_csrf" value="tok" type="hidden"><input type="text"></form>`
    const result = await verifySecurity({ llm: makeLlm(), pages: [makePage(html)] })
    const csrfFinding = result.find((f) => f.title.includes('CSRF'))
    expect(csrfFinding).toBeUndefined()
  })

  it('does NOT flag missing CSRF when X-CSRF-Token header reference is present', async () => {
    const html = `<form>...</form><script>const headers = {"X-CSRF-Token": tok}</script>`
    const result = await verifySecurity({ llm: makeLlm(), pages: [makePage(html)] })
    const csrfFinding = result.find((f) => f.title.includes('CSRF'))
    expect(csrfFinding).toBeUndefined()
  })

  it('accumulates findings across multiple pages', async () => {
    const page1 = makePage(`<form><input type="password" value="pw1"></form>`, 'http://a.com/')
    const page2 = makePage(`<form><input type="text"><button>Go</button></form>`, 'http://b.com/')
    const result = await verifySecurity({ llm: makeLlm(), pages: [page1, page2] })
    // page1: password finding; page2: CSRF finding
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  it('continues if one page scan throws', async () => {
    const badPage: RawPage = {
      url: 'http://bad.com/',
      title: 'Bad',
      // Force a throw by making html a getter that throws
      get html(): string { throw new Error('read error') },
      meta: {},
      screenshotPath: '',
    }
    const goodPage = makePage(`<p>clean</p>`, 'http://good.com/')
    // Should not throw; bad page is skipped
    const result = await verifySecurity({ llm: makeLlm(), pages: [badPage, goodPage] })
    expect(Array.isArray(result)).toBe(true)
  })
})
