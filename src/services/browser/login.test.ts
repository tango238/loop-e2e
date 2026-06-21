import { describe, it, expect, vi } from 'vitest'
import { executeLoginScenario } from './login.js'
import type { PageLike } from './crawler.js'
import type { TargetEnv } from '../../domain/types.js'
import type { Scenario } from '../../scenario/schema.js'

const baseTarget: TargetEnv = {
  name: 'local',
  baseUrl: 'http://localhost:3000',
  auth: {
    strategy: 'form',
    loginPath: '/login',
  },
}

const loginScenario: Scenario = {
  id: 'sc-001',
  title: 'User login',
  businessFlow: 'User logs in with email and password',
  steps: [
    { action: 'navigate', target: '/login', expectedOutcome: 'Login page shown' },
    { action: 'fill', target: 'input[name=email]', input: 'user@example.com', expectedOutcome: 'Email filled' },
    { action: 'fill', target: 'input[type=password]', input: 'password123', expectedOutcome: 'Password filled' },
    { action: 'submit', target: 'button[type=submit]', expectedOutcome: 'Logged in' },
  ],
  expectedResults: [{ kind: 'ui', description: 'Dashboard shown', assertion: 'URL is /dashboard' }],
  expectedDbState: [],
}

const creds = { username: 'user@example.com', password: 'secret-pass' }

/**
 * Build a minimal fake PageLike for testing.
 * currentUrl controls what page.url() returns after navigation/submit.
 * pageContent controls what page.content() returns for error-checking.
 */
function makeFakePage(opts: {
  currentUrl?: string
  pageContent?: string
  fillShouldFail?: boolean
  clickShouldFail?: boolean
}): PageLike {
  let url = opts.currentUrl ?? 'http://localhost:3000/login'

  return {
    goto: vi.fn(async (targetUrl: string) => {
      url = targetUrl
    }),
    url: vi.fn(() => url),
    title: vi.fn(async () => 'Login'),
    content: vi.fn(async () => opts.pageContent ?? '<html><body><form></form></body></html>'),
    evaluate: vi.fn(async () => ({})),
    screenshot: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    locator: vi.fn((selector: string) => ({
      fill: opts.fillShouldFail
        ? vi.fn(async () => { throw new Error(`Could not find element: ${selector}`) })
        : vi.fn(async () => {}),
      click: opts.clickShouldFail
        ? vi.fn(async () => { throw new Error(`Could not click: ${selector}`) })
        : vi.fn(async () => { url = 'http://localhost:3000/dashboard' }),
    })),
  }
}

describe('executeLoginScenario', () => {
  it('returns ok:true when URL changes away from loginPath after submit', async () => {
    const page = makeFakePage({ currentUrl: 'http://localhost:3000/dashboard' })

    // Simulate: after goto /login and submit click, url becomes /dashboard
    ;(page.locator as ReturnType<typeof vi.fn>).mockImplementation((_selector: string) => ({
      fill: vi.fn(async () => {}),
      click: vi.fn(async () => {
        // After submit, url is now dashboard
        ;(page.url as ReturnType<typeof vi.fn>).mockReturnValue('http://localhost:3000/dashboard')
      }),
    }))

    const result = await executeLoginScenario(page, baseTarget, loginScenario, creds)

    expect(result.ok).toBe(true)
    expect(result.finalUrl).toContain('/dashboard')
    expect(result.detail).not.toContain(creds.password)
  })

  it('returns ok:false when URL remains on loginPath after submit (auth error)', async () => {
    const page = makeFakePage({
      currentUrl: 'http://localhost:3000/login',
      pageContent: '<html><body><p class="error">Invalid credentials</p></body></html>',
    })

    // URL never changes — stays on /login
    ;(page.locator as ReturnType<typeof vi.fn>).mockImplementation((_selector: string) => ({
      fill: vi.fn(async () => {}),
      click: vi.fn(async () => {}), // no URL change
    }))

    const result = await executeLoginScenario(page, baseTarget, loginScenario, creds)

    expect(result.ok).toBe(false)
    expect(result.detail).toBeTruthy()
    expect(result.detail).not.toContain(creds.password)
    expect(result.finalUrl).toContain('/login')
  })

  it('returns ok:false with detail when a field cannot be found', async () => {
    const page = makeFakePage({ fillShouldFail: true })

    const result = await executeLoginScenario(page, baseTarget, loginScenario, creds)

    expect(result.ok).toBe(false)
    expect(result.detail).toBeTruthy()
    expect(result.detail).not.toContain(creds.password)
  })

  it('never includes the password value in the detail string', async () => {
    // Even on success, detail must not contain credentials
    const page = makeFakePage({ currentUrl: 'http://localhost:3000/dashboard' })
    ;(page.locator as ReturnType<typeof vi.fn>).mockImplementation((_selector: string) => ({
      fill: vi.fn(async () => {}),
      click: vi.fn(async () => {
        ;(page.url as ReturnType<typeof vi.fn>).mockReturnValue('http://localhost:3000/dashboard')
      }),
    }))

    const result = await executeLoginScenario(page, baseTarget, loginScenario, creds)
    expect(result.detail).not.toContain(creds.password)
    expect(result.detail).not.toContain(creds.username)
  })

  it('uses default login path /login when target.auth.loginPath is not set', async () => {
    const targetWithoutLoginPath: TargetEnv = {
      name: 'local',
      baseUrl: 'http://localhost:3000',
      auth: { strategy: 'form' },
    }

    let navigatedTo = ''
    const page = makeFakePage({ currentUrl: 'http://localhost:3000/dashboard' })
    ;(page.goto as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      navigatedTo = url
    })
    ;(page.locator as ReturnType<typeof vi.fn>).mockImplementation((_selector: string) => ({
      fill: vi.fn(async () => {}),
      click: vi.fn(async () => {
        ;(page.url as ReturnType<typeof vi.fn>).mockReturnValue('http://localhost:3000/dashboard')
      }),
    }))

    await executeLoginScenario(page, targetWithoutLoginPath, loginScenario, creds)
    expect(navigatedTo).toContain('/login')
  })
})
