import { logger } from '../../util/logger.js'
import type { PageLike } from './crawler.js'
import type { TargetEnv } from '../../domain/types.js'
import type { Scenario } from '../../scenario/schema.js'

export type LoginResult = {
  ok: boolean
  /** Human-readable detail — must never contain credential values */
  detail: string
  finalUrl: string
}

// Default selector fallbacks when scenario steps don't provide specific selectors
const DEFAULT_USERNAME_SELECTORS = [
  'input[name=email]',
  'input[type=email]',
  'input[name=username]',
  'input[name=user]',
]
const DEFAULT_PASSWORD_SELECTORS = ['input[type=password]', 'input[name=password]']
const DEFAULT_SUBMIT_SELECTORS = ['button[type=submit]', 'input[type=submit]', '[type=submit]']

/**
 * Execute a login scenario against the given page using the provided credentials.
 *
 * Strategy:
 * 1. Navigate to loginPath.
 * 2. Fill username field — uses step target selector if present, else defaults.
 * 3. Fill password field — uses step target selector if present, else defaults.
 * 4. Submit form — uses step target selector if present, else defaults.
 * 5. Assess success: URL must change away from loginPath.
 *
 * On a normal login failure (wrong credentials, still on login page) returns
 * ok:false with a descriptive detail. Only unexpected exceptions bubble.
 * Credential values are never included in detail or logs.
 */
export async function executeLoginScenario(
  page: PageLike,
  target: TargetEnv,
  scenario: Scenario,
  creds: { username: string; password: string },
): Promise<LoginResult> {
  const loginPath = target.auth?.loginPath ?? '/login'
  const loginUrl = `${target.baseUrl.replace(/\/$/, '')}${loginPath}`

  logger.info({ loginUrl }, 'Executing login scenario')

  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForLoadState('networkidle')
  } catch (err) {
    return {
      ok: false,
      detail: `Failed to navigate to login page: ${sanitizeError(err)}`,
      finalUrl: page.url(),
    }
  }

  // Identify fill-step selectors from scenario steps
  const { usernameSelector, passwordSelector, submitSelector } =
    extractSelectorsFromScenario(scenario)

  // Fill username
  try {
    const selector = usernameSelector ?? DEFAULT_USERNAME_SELECTORS.join(',')
    await page.locator(selector).fill(creds.username)
    logger.debug('Username field filled')
  } catch (err) {
    return {
      ok: false,
      detail: `Could not fill username field: ${sanitizeError(err)}`,
      finalUrl: page.url(),
    }
  }

  // Fill password
  try {
    const selector = passwordSelector ?? DEFAULT_PASSWORD_SELECTORS.join(',')
    await page.locator(selector).fill(creds.password)
    logger.debug('Password field filled')
  } catch (err) {
    return {
      ok: false,
      detail: `Could not fill password field: ${sanitizeError(err)}`,
      finalUrl: page.url(),
    }
  }

  // Submit the form
  try {
    const selector = submitSelector ?? DEFAULT_SUBMIT_SELECTORS.join(',')
    await page.locator(selector).click()
    await page.waitForLoadState('networkidle')
  } catch (err) {
    return {
      ok: false,
      detail: `Could not submit login form: ${sanitizeError(err)}`,
      finalUrl: page.url(),
    }
  }

  const finalUrl = page.url()
  const stillOnLoginPage = urlMatchesPath(finalUrl, loginPath)

  if (stillOnLoginPage) {
    logger.info({ finalUrl }, 'Login appears to have failed — still on login page')
    return {
      ok: false,
      detail: `Login failed: URL did not change away from ${loginPath}`,
      finalUrl,
    }
  }

  logger.info({ finalUrl }, 'Login succeeded')
  return {
    ok: true,
    detail: `Login succeeded — navigated to ${finalUrl}`,
    finalUrl,
  }
}

/**
 * Extract the best selectors for username, password, and submit from scenario steps.
 * Looks for fill steps whose target matches expected field patterns, and submit steps.
 */
function extractSelectorsFromScenario(scenario: Scenario): {
  usernameSelector: string | null
  passwordSelector: string | null
  submitSelector: string | null
} {
  let usernameSelector: string | null = null
  let passwordSelector: string | null = null
  let submitSelector: string | null = null

  for (const step of scenario.steps) {
    if (step.action === 'fill') {
      const t = step.target.toLowerCase()
      if (
        t.includes('email') ||
        t.includes('username') ||
        t.includes('user') ||
        t.includes('login')
      ) {
        usernameSelector = usernameSelector ?? step.target
      } else if (t.includes('password') || t.includes('pass')) {
        passwordSelector = passwordSelector ?? step.target
      }
    } else if (step.action === 'submit' || step.action === 'click') {
      const t = step.target.toLowerCase()
      if (
        t.includes('submit') ||
        t.includes('login') ||
        t.includes('sign') ||
        t.includes('button')
      ) {
        submitSelector = submitSelector ?? step.target
      }
    }
  }

  return { usernameSelector, passwordSelector, submitSelector }
}

/** Returns true if the given absolute URL's path matches or starts with loginPath */
function urlMatchesPath(url: string, loginPath: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.pathname === loginPath || parsed.pathname.startsWith(loginPath + '/')
  } catch {
    // If URL parsing fails, fall back to simple string containment
    return url.includes(loginPath)
  }
}

/**
 * Sanitize an error into a safe string for logging/detail.
 * Must not include credential values (callers are responsible for not passing creds to errors).
 */
function sanitizeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
