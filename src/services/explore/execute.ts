import { maskSecrets } from '../../util/mask.js'
import type { PageLike } from '../browser/crawler.js'
import type { DiscoveredForm, Baseline, InputCase, CaseOutcome } from './types.js'

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Matches an opening tag whose class/id marks an error container, capturing its inner text.
// The trailing (?![a-z]) excludes negation-ish tokens like "errorless"/"warningish".
// Limitation: non-greedy inner capture truncates at the first same-tag close, so deeply
// nested same-tag error containers under-report (mitigated by the DB-confirmation backstop).
const ERROR_ELEMENT_REGEX =
  /<([a-z0-9]+)[^>]*(?:class|id)=["'][^"']*(?:error|alert|warning|invalid|danger|fail)(?![a-z])[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi

/** Heuristically extract visible error-message text from page HTML. */
export function collectErrorsFromHtml(html: string): string[] {
  const out: string[] = []
  let m: RegExpExecArray | null
  ERROR_ELEMENT_REGEX.lastIndex = 0
  while ((m = ERROR_ELEMENT_REGEX.exec(html)) !== null) {
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (text) out.push(text)
  }
  return out
}

export type ExploreExecDeps = {
  secrets?: string[]
  navTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  /** last observed response status for the submit (wired from a Playwright response listener) */
  getLastStatus?: () => number | undefined
  /** override error collection (default parses page.content() HTML) */
  collectErrors?: (page: PageLike) => Promise<string[]>
}

/**
 * Drive one input case: fill baseline into every field, override the target field with the
 * case value, submit, wait for SPA settle, then observe shown errors / submit status / nav.
 * Never lets secret values appear in errorsShown.
 */
export async function runCase(
  page: PageLike,
  form: DiscoveredForm,
  baseline: Baseline,
  inputCase: InputCase,
  deps: ExploreExecDeps = {},
): Promise<CaseOutcome> {
  const sleep = deps.sleep ?? defaultSleep
  const secrets = deps.secrets ?? []
  const navTimeoutMs = deps.navTimeoutMs ?? 8000
  const intervalMs = 250
  const attempts = Math.max(1, Math.ceil(navTimeoutMs / intervalMs))

  // Fill baseline for every field, then override the target field.
  for (const field of form.fields) {
    const value = field.selector === inputCase.selector ? inputCase.value : baseline[field.selector] ?? ''
    await page.locator(field.selector).fill(value)
  }

  const before = page.url()
  await page.locator(form.submitSelector).click()
  await page.waitForLoadState('networkidle')
  for (let a = 0; a < attempts; a++) {
    if (page.url() !== before) break
    await sleep(intervalMs)
  }

  const collect = deps.collectErrors ?? (async (p: PageLike) => collectErrorsFromHtml(await p.content()))
  const errorsShown = (await collect(page)).map((e) => maskSecrets(e, secrets))
  const finalUrl = page.url()
  const outcome: CaseOutcome = {
    errorsShown,
    navigatedAway: finalUrl !== before,
    finalUrl,
  }
  const status = deps.getLastStatus?.()
  if (status !== undefined) outcome.submitStatus = status
  return outcome
}
