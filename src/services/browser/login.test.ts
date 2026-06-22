import { describe, it, expect, vi } from 'vitest'
import { executeLoginScenario, authenticate } from './login.js'
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

  // --- Stage-specific detail prefix tests (M4 review finding) ---

  it('detail starts with "navigation failed:" on goto failure', async () => {
    const page = makeFakePage({})
    ;(page.goto as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'))

    const result = await executeLoginScenario(page, baseTarget, loginScenario, creds)

    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/^navigation failed:/)
    expect(result.detail).not.toContain(creds.password)
  })

  it('detail starts with "login form field not found or not fillable:" on fill failure', async () => {
    const page = makeFakePage({ fillShouldFail: true })

    const result = await executeLoginScenario(page, baseTarget, loginScenario, creds)

    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/^login form field not found or not fillable:/)
    expect(result.detail).not.toContain(creds.password)
  })

  it('detail starts with "submit failed:" on submit click failure', async () => {
    const page = makeFakePage({ clickShouldFail: true })

    const result = await executeLoginScenario(page, baseTarget, loginScenario, creds)

    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/^submit failed:/)
    expect(result.detail).not.toContain(creds.password)
  })

  it('detail starts with "login rejected:" when URL stays on loginPath after submit', async () => {
    const page = makeFakePage({
      currentUrl: 'http://localhost:3000/login',
      pageContent: '<html><body><p class="error">Invalid credentials</p></body></html>',
    })
    ;(page.locator as ReturnType<typeof vi.fn>).mockImplementation((_selector: string) => ({
      fill: vi.fn(async () => {}),
      click: vi.fn(async () => {}), // URL stays on /login
    }))

    const result = await executeLoginScenario(page, baseTarget, loginScenario, creds)

    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/^login rejected:/)
    expect(result.detail).not.toContain(creds.password)
  })

  it('detail starts with "login succeeded:" on successful login', async () => {
    const page = makeFakePage({ currentUrl: 'http://localhost:3000/dashboard' })
    ;(page.locator as ReturnType<typeof vi.fn>).mockImplementation((_selector: string) => ({
      fill: vi.fn(async () => {}),
      click: vi.fn(async () => {
        ;(page.url as ReturnType<typeof vi.fn>).mockReturnValue('http://localhost:3000/dashboard')
      }),
    }))

    const result = await executeLoginScenario(page, baseTarget, loginScenario, creds)

    expect(result.ok).toBe(true)
    expect(result.detail).toMatch(/^login succeeded:/)
    expect(result.detail).not.toContain(creds.password)
  })

  it('navigation failure and credentials-rejected failure have distinct detail prefixes', async () => {
    // Navigation failure
    const navPage = makeFakePage({})
    ;(navPage.goto as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Timeout'))
    const navResult = await executeLoginScenario(navPage, baseTarget, loginScenario, creds)

    // Credentials rejected
    const rejPage = makeFakePage({ currentUrl: 'http://localhost:3000/login' })
    ;(rejPage.locator as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      fill: vi.fn(async () => {}),
      click: vi.fn(async () => {}),
    }))
    const rejResult = await executeLoginScenario(rejPage, baseTarget, loginScenario, creds)

    expect(navResult.ok).toBe(false)
    expect(rejResult.ok).toBe(false)
    // Prefixes must differ so triage can distinguish failure modes
    const navPrefix = navResult.detail.split(':')[0]
    const rejPrefix = rejResult.detail.split(':')[0]
    expect(navPrefix).not.toBe(rejPrefix)
    expect(navResult.detail).not.toContain(creds.password)
    expect(rejResult.detail).not.toContain(creds.password)
  })
})

describe('executeLoginScenario with 2FA', () => {
  const twoFactorTarget: TargetEnv = {
    name: 'local',
    baseUrl: 'http://localhost:3000',
    auth: {
      strategy: 'form',
      loginPath: '/login',
      twoFactor: {
        pinCommand: 'echo 123456',
        pinFieldSelector: 'input[name="pin_code"]',
        submitSelector: 'button[type="submit"]',
      },
    },
  }

  // Fake page that advances: /login -> (cred submit) /two-factor-auth -> (pin submit) /
  function makeTwoFactorPage() {
    let url = 'http://localhost:3000/login'
    let clicks = 0
    const fills: Array<{ sel: string; val: string }> = []
    const page = {
      goto: vi.fn(async (u: string) => { url = u }),
      url: vi.fn(() => url),
      title: vi.fn(async () => 't'),
      content: vi.fn(async () => '<html></html>'),
      evaluate: vi.fn(async () => ({})),
      screenshot: vi.fn(async () => {}),
      waitForLoadState: vi.fn(async () => {}),
      locator: vi.fn((selector: string) => ({
        fill: vi.fn(async (v: string) => { fills.push({ sel: selector, val: v }) }),
        click: vi.fn(async () => {
          clicks += 1
          url = clicks === 1 ? 'http://localhost:3000/two-factor-auth' : 'http://localhost:3000/'
        }),
      })),
    } as unknown as PageLike
    return { page, fills }
  }

  it('runs the 2FA step: pinCommand -> fill pin -> submit -> dashboard', async () => {
    const { page, fills } = makeTwoFactorPage()
    const pinRunner = vi.fn(async () => ({ stdout: '  123456\n', stderr: '' }))
    const res = await executeLoginScenario(page, twoFactorTarget, loginScenario, creds, { pinRunner })
    expect(pinRunner).toHaveBeenCalledWith('sh', ['-c', 'echo 123456'])
    expect(fills.some((f) => f.sel.includes('pin_code') && f.val === '123456')).toBe(true)
    expect(res.ok).toBe(true)
    expect(res.finalUrl).toBe('http://localhost:3000/')
  })

  it('fails when pinCommand output has no digits, without leaking the password', async () => {
    const { page } = makeTwoFactorPage()
    const pinRunner = vi.fn(async () => ({ stdout: 'no code here', stderr: '' }))
    const res = await executeLoginScenario(page, twoFactorTarget, loginScenario, creds, { pinRunner })
    expect(res.ok).toBe(false)
    expect(res.detail).toMatch(/pin not found/i)
    expect(res.detail).not.toContain(creds.password)
  })

  it('does not run 2FA when twoFactor is not configured', async () => {
    const page = makeFakePage({ currentUrl: 'http://localhost:3000/dashboard' })
    ;(page.locator as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      fill: vi.fn(async () => {}),
      click: vi.fn(async () => {
        ;(page.url as ReturnType<typeof vi.fn>).mockReturnValue('http://localhost:3000/dashboard')
      }),
    }))
    const pinRunner = vi.fn()
    const res = await executeLoginScenario(page, baseTarget, loginScenario, creds, { pinRunner })
    expect(pinRunner).not.toHaveBeenCalled()
    expect(res.ok).toBe(true)
  })

  it('never includes the PIN value in the detail', async () => {
    const { page } = makeTwoFactorPage()
    const pinRunner = vi.fn(async () => ({ stdout: '123456', stderr: '' }))
    const res = await executeLoginScenario(page, twoFactorTarget, loginScenario, creds, { pinRunner })
    expect(res.detail).not.toContain('123456')
  })

  it('does not run 2FA when the app skips the 2FA page (lands on dashboard)', async () => {
    // twoFactor configured, but credential submit goes straight to /dashboard
    const page = makeFakePage({ currentUrl: 'http://localhost:3000/login' })
    ;(page.locator as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      fill: vi.fn(async () => {}),
      click: vi.fn(async () => {
        ;(page.url as ReturnType<typeof vi.fn>).mockReturnValue('http://localhost:3000/dashboard')
      }),
    }))
    const pinRunner = vi.fn()
    const res = await executeLoginScenario(page, twoFactorTarget, loginScenario, creds, { pinRunner })
    expect(pinRunner).not.toHaveBeenCalled() // no 2FA page → no PIN step
    expect(res.ok).toBe(true)
  })
})

describe('authenticate', () => {
  it('drives login and returns ok when reaching the dashboard', async () => {
    const page = makeFakePage({ currentUrl: 'http://localhost:3000/login' })
    ;(page.locator as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      fill: vi.fn(async () => {}),
      click: vi.fn(async () => {
        ;(page.url as ReturnType<typeof vi.fn>).mockReturnValue('http://localhost:3000/dashboard')
      }),
    }))
    const res = await authenticate(page, baseTarget, creds)
    expect(res.ok).toBe(true)
    expect(res.finalUrl).toBe('http://localhost:3000/dashboard')
  })
})
