import { logger } from '../../util/logger.js'
import type { VerifyFinding, RawPage } from '../../domain/types.js'
import type { Llm } from '../../services/llm/client.js'

export type SecurityDeps = {
  llm: Llm
  pages: RawPage[]
}

// --- Luhn algorithm for credit card validation ---
function luhn(digits: string): boolean {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10)
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

// Strip spaces/dashes, keep only digit sequences 13–19 chars
const CARD_REGEX = /\b(?:\d[\s-]?){12,18}\d\b/g

/**
 * Finds Luhn-valid card-like sequences in text.
 * Returns the matched strings (already stripped of spaces/dashes).
 */
function findPlaintextCards(text: string): string[] {
  const matches = text.match(CARD_REGEX) ?? []
  return matches
    .map((m) => m.replace(/[\s-]/g, ''))
    .filter((digits) => digits.length >= 13 && digits.length <= 19 && luhn(digits))
}

// Detect password-like strings: input fields with type="password" that have a value attribute
// e.g. <input type="password" value="hunter2">
const PASSWORD_IN_VALUE_REGEX =
  /<input[^>]*type=["']password["'][^>]*value=["']([^"']+)["'][^>]*>/gi
const PASSWORD_VALUE_ALT_REGEX =
  /<input[^>]*value=["']([^"']+)["'][^>]*type=["']password["'][^>]*>/gi

function findPlaintextPasswords(html: string): string[] {
  const found: string[] = []
  let m: RegExpExecArray | null
  const r1 = new RegExp(PASSWORD_IN_VALUE_REGEX.source, 'gi')
  while ((m = r1.exec(html)) !== null) {
    found.push(m[1])
  }
  const r2 = new RegExp(PASSWORD_VALUE_ALT_REGEX.source, 'gi')
  while ((m = r2.exec(html)) !== null) {
    found.push(m[1])
  }
  return found
}

// CSRF token presence: look for common patterns in rendered HTML
const CSRF_PATTERNS = [
  /<input[^>]+name=["'](_csrf|csrf_token|csrfmiddlewaretoken|authenticity_token)["'][^>]*>/i,
  /meta[^>]+name=["']csrf-token["']/i,
  /"X-CSRF-Token"/i,
]

function hasCsrfProtection(html: string): boolean {
  return CSRF_PATTERNS.some((pattern) => pattern.test(html))
}

/**
 * Deterministic security scans on rendered HTML:
 * - Plaintext password values echoed back in DOM
 * - Luhn-valid credit card numbers in page text
 * - Absence of CSRF token/header patterns
 *
 * LLM is not used here — all checks are regex/deterministic for reliability.
 */
export async function verifySecurity(deps: SecurityDeps): Promise<VerifyFinding[]> {
  const { pages } = deps
  const findings: VerifyFinding[] = []

  for (const page of pages) {
    try {
      // Check 1: plaintext passwords in DOM
      const passwords = findPlaintextPasswords(page.html)
      if (passwords.length > 0) {
        findings.push({
          category: 'security',
          severity: 'high',
          title: 'Plaintext password exposed in HTML',
          detail: `Page renders a password field value in plaintext (${passwords.length} occurrence(s)).`,
          evidence: `[${page.url}] password value found in <input type="password" value="...">`,
        })
      }

      // Check 2: credit card numbers in page text
      // Strip HTML tags to get visible text, then scan
      const visibleText = page.html.replace(/<[^>]+>/g, ' ')
      const cards = findPlaintextCards(visibleText)
      if (cards.length > 0) {
        findings.push({
          category: 'security',
          severity: 'high',
          title: 'Credit card number exposed in rendered page',
          detail: `Luhn-valid card number(s) found in visible page text (${cards.length} occurrence(s)).`,
          evidence: `[${page.url}] card pattern detected in rendered text`,
        })
      }

      // Check 3: CSRF protection absence (only flag on pages with forms)
      const hasForms = /<form[\s>]/i.test(page.html)
      if (hasForms && !hasCsrfProtection(page.html)) {
        findings.push({
          category: 'security',
          severity: 'medium',
          title: 'CSRF protection not detected',
          detail:
            'Page contains a <form> but no CSRF token input or meta tag was found in the rendered HTML.',
          evidence: `[${page.url}] no csrf_token / _csrf / X-CSRF-Token pattern found`,
        })
      }
    } catch (error) {
      logger.warn({ error, url: page.url }, 'security verify: scan failed for page — skipping')
    }
  }

  return findings
}

// Export helpers for unit testing
export { findPlaintextCards, findPlaintextPasswords, hasCsrfProtection, luhn }
