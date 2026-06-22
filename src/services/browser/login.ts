import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logger } from '../../util/logger.js'
import { maskSecrets } from '../../util/mask.js'
import type { PageLike } from './crawler.js'
import type { TargetEnv } from '../../domain/types.js'
import type { Scenario, ScenarioTwoFactor, LoadedScenario } from '../../scenario/schema.js'
import type { ComposeRunner } from '../compose/compose.js'

export type LoginResult = {
  ok: boolean
  /** Human-readable detail — must never contain credential or PIN values */
  detail: string
  finalUrl: string
}

/** Injectable dependencies for login (shell runner for the 2FA pinCommand). */
export type LoginDeps = {
  pinRunner?: ComposeRunner
  secrets?: string[]
  /** Max ms to wait for a client-side navigation away from the login path (default 8000). */
  navTimeoutMs?: number
  /** Injectable sleep for deterministic tests (default real setTimeout). */
  sleep?: (ms: number) => Promise<void>
  /**
   * Returns the latest auth-endpoint HTTP response observed on the page (status + body),
   * wired from a Playwright response listener. Used to explain login/2FA failures precisely
   * (e.g. "HTTP 422: 登録情報と一致しませんでした") instead of guessing — the app may show the
   * error only as an auto-dismissing toast that is gone by the time the DOM is scanned.
   */
  getAuthResponse?: () => { status: number; bodyText?: string } | null
  /**
   * 2FA config for the login scenario (env-specific; owned by the scenario). Used when the
   * executing scenario itself has no `twoFactor` — e.g. the synthetic scenario built by
   * `authenticate` for grow/explore/authenticated-precondition flows.
   */
  twoFactor?: ScenarioTwoFactor
  /** Script directory for resolving the 2FA pinCommand (cwd). Login scenario's `scriptDir`. */
  scriptDir?: string
}

/** One-line description of the captured auth response, masked, or null if none captured. */
function describeAuthResponse(getAuthResponse: LoginDeps['getAuthResponse'], secrets: string[]): string | null {
  const r = getAuthResponse?.()
  if (!r) return null
  const body = r.bodyText ? `: ${maskSecrets(r.bodyText, secrets).slice(0, 300)}` : ''
  return `auth API responded HTTP ${r.status}${body}`
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const pexec = promisify(execFile)
const defaultPinRunner: ComposeRunner = (cmd, args, opts) =>
  pexec(cmd, args, opts) as Promise<{ stdout: string; stderr: string }>

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
  deps: LoginDeps = {},
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
      detail: `navigation failed: ${sanitizeError(err)}`,
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
      detail: `login form field not found or not fillable: ${sanitizeError(err)}`,
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
      detail: `login form field not found or not fillable: ${sanitizeError(err)}`,
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
      detail: `submit failed: ${sanitizeError(err)}`,
      finalUrl: page.url(),
    }
  }

  // SPA logins POST asynchronously then navigate client-side — `waitForLoadState`
  // can resolve before that route change. Wait for the URL to actually leave the
  // login path (up to navTimeoutMs) before deciding success/failure.
  const navTimeoutMs = deps.navTimeoutMs ?? 8000
  const sleep = deps.sleep ?? defaultSleep
  await waitForUrl(page, (u) => !urlMatchesPath(u, loginPath), navTimeoutMs, sleep)

  const afterSubmitUrl = page.url()

  if (urlMatchesPath(afterSubmitUrl, loginPath)) {
    // Stayed on the login path. Prefer the captured auth-API response (status + body) — it is the
    // ground truth. Fall back to a visible error element, then to "request likely did not complete"
    // (CORS/network/backend) when there is neither — the app may show errors only as toasts that
    // auto-dismiss before the DOM is scanned.
    const secrets = [creds.username, creds.password, ...(deps.secrets ?? [])].filter(Boolean)
    const authDesc = describeAuthResponse(deps.getAuthResponse, secrets)
    const errorText = authDesc ? '' : await readVisibleError(page)
    const detail = authDesc
      ? `login rejected: ${authDesc}`
      : errorText
        ? `login rejected: error shown on ${loginPath}: "${maskSecrets(errorText, secrets)}"`
        : `login did not advance past ${loginPath} and no error was shown — the request likely did not complete (check CORS/network/backend, or that the setup hook ran)`
    logger.info(
      { finalUrl: afterSubmitUrl, hadAuthResponse: Boolean(authDesc), hadError: Boolean(errorText) },
      'Login appears to have failed — still on login page',
    )
    return { ok: false, detail, finalUrl: afterSubmitUrl }
  }

  // If 2FA is configured AND the credential submit landed on a 2FA page, complete it.
  // If 2FA is configured but the app went straight to the dashboard (2FA remembered
  // for this device, or the user has no 2FA), do NOT run the PIN step — the login
  // already succeeded. 2FA config is owned by the scenario (env-specific); fall back to
  // deps.twoFactor for the synthetic scenario built by authenticate().
  const twoFactor = scenario.twoFactor ?? deps.twoFactor
  const scriptDir = (scenario as LoadedScenario).scriptDir ?? deps.scriptDir
  if (twoFactor && looksLikeTwoFactorPage(afterSubmitUrl)) {
    const secrets = [creds.username, creds.password, ...(deps.secrets ?? [])].filter(Boolean)
    return runTwoFactorStep(page, twoFactor, scriptDir, loginPath, deps.pinRunner ?? defaultPinRunner, secrets, navTimeoutMs, sleep, deps.getAuthResponse)
  }

  logger.info({ finalUrl: afterSubmitUrl }, 'Login succeeded')
  return {
    ok: true,
    detail: `login succeeded: navigated to ${afterSubmitUrl}`,
    finalUrl: afterSubmitUrl,
  }
}

/**
 * Complete the 2FA step: fetch the PIN via the configured shell command,
 * fill it, submit, and judge success. The PIN and credentials never appear
 * in the returned detail or in logs (masked).
 */
async function runTwoFactorStep(
  page: PageLike,
  twoFactor: ScenarioTwoFactor,
  scriptDir: string | undefined,
  loginPath: string,
  pinRunner: ComposeRunner,
  secrets: string[],
  navTimeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  getAuthResponse?: LoginDeps['getAuthResponse'],
): Promise<LoginResult> {
  let stdout = ''
  try {
    // Run the env-specific pinCommand in the scenario's script dir so it can reference
    // scripts placed alongside the scenario (e.g. "bash get-2fa-pin.sh").
    const result = await pinRunner('sh', ['-c', twoFactor.pinCommand], scriptDir ? { cwd: scriptDir } : undefined)
    stdout = result.stdout
  } catch (err) {
    return {
      ok: false,
      detail: `2FA failed: pin command error: ${maskSecrets(sanitizeError(err), secrets)}`,
      finalUrl: page.url(),
    }
  }

  const match = stdout.match(/\d{4,8}/)
  if (!match) {
    return { ok: false, detail: '2FA failed: pin not found in command output', finalUrl: page.url() }
  }
  const pin = match[0]
  const maskWith = [...secrets, pin]

  try {
    await page.locator(twoFactor.pinFieldSelector).fill(pin)
    await page.locator(twoFactor.submitSelector).click()
    await page.waitForLoadState('networkidle')
  } catch (err) {
    return { ok: false, detail: `2FA failed: ${maskSecrets(sanitizeError(err), maskWith)}`, finalUrl: page.url() }
  }

  // The 2FA verify is also an async POST + client-side navigation — wait for the
  // URL to leave the 2FA/login page before judging (same reason as the login submit).
  const succeeded = (u: string): boolean =>
    twoFactor.successUrlPattern
      ? new RegExp(twoFactor.successUrlPattern).test(u)
      : !urlMatchesPath(u, loginPath) && !looksLikeTwoFactorPage(u)
  await waitForUrl(page, succeeded, navTimeoutMs, sleep)

  const finalUrl = page.url()
  const ok = succeeded(finalUrl)

  const safeUrl = maskSecrets(finalUrl, maskWith)
  if (!ok) {
    const authDesc = describeAuthResponse(getAuthResponse, maskWith)
    const reason = authDesc ? `: ${authDesc}` : ` (at ${safeUrl})`
    return { ok: false, detail: `2FA failed: still not authenticated${reason}`, finalUrl }
  }
  logger.info({ finalUrl }, '2FA passed; login succeeded')
  return { ok: true, detail: `login succeeded: 2FA passed, navigated to ${safeUrl}`, finalUrl }
}

/** Heuristic: does this URL look like a 2-factor / OTP verification page? */
function looksLikeTwoFactorPage(url: string): boolean {
  return /two-?factor|2fa|otp|mfa|verify/i.test(url)
}

// First error/alert container's text (trailing (?![a-z]) avoids "errorless" etc.).
const LOGIN_ERROR_REGEX =
  /<[a-z0-9]+[^>]*(?:class|id)=["'][^"']*(?:error|alert|invalid|danger|fail)(?![a-z])[^"']*["'][^>]*>([\s\S]*?)<\/[a-z0-9]+>/i

/** Read the first visible error-message text on the page (e.g. "メールアドレスまたはパスワードが違います"). */
async function readVisibleError(page: PageLike): Promise<string> {
  try {
    const m = LOGIN_ERROR_REGEX.exec(await page.content())
    if (!m) return ''
    return m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
  } catch {
    return ''
  }
}

/**
 * Poll until `predicate(url)` is true, or until `timeoutMs` elapses. Handles
 * SPA client-side navigation that `waitForLoadState` resolves too early for.
 */
async function waitForUrl(
  page: PageLike,
  predicate: (url: string) => boolean,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const intervalMs = 250
  const attempts = Math.max(0, Math.ceil(timeoutMs / intervalMs))
  for (let i = 0; i < attempts; i++) {
    if (predicate(page.url())) return
    await sleep(intervalMs)
  }
}

/**
 * Authenticate the given page against the target (form login + optional 2FA).
 * On success the SAME page is left authenticated. Reuses executeLoginScenario
 * with a minimal login scenario so default field selectors apply.
 */
export async function authenticate(
  page: PageLike,
  target: TargetEnv,
  creds: { username: string; password: string },
  deps: LoginDeps = {},
): Promise<LoginResult> {
  const minimalScenario: Scenario = {
    id: 'authenticate',
    title: 'authenticate',
    businessFlow: 'Log in to obtain an authenticated session',
    steps: [
      { action: 'navigate', target: target.auth?.loginPath ?? '/login', expectedOutcome: 'login page shown' },
    ],
    expectedResults: [{ kind: 'ui', description: 'authenticated', assertion: 'navigated past login' }],
    expectedDbState: [],
    // 2FA config + script dir come from the designated login scenario via deps.
    ...(deps.twoFactor ? { twoFactor: deps.twoFactor } : {}),
  }
  return executeLoginScenario(page, target, minimalScenario, creds, deps)
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
