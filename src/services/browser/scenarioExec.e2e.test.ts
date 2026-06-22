import { describe, it, expect } from 'vitest'
import { executeScenarios } from '../../pipeline/executeScenarios.js'
import { authenticate } from './login.js'
import { defaultComposeRunner } from '../compose/compose.js'
import type { TargetEnv } from '../../domain/types.js'
import type { Scenario } from '../../scenario/schema.js'

/**
 * Real-machine E2E: runs an authenticated scenario against a live admin target.
 * Gated behind RUN_E2E=1 (skipped by default). Requires:
 *   - the target app running locally (e.g. the spotly admin dogfood stack)
 *   - env: E2E_BASE_URL, E2E_LOGIN_PATH, ADMIN_USER, ADMIN_PASS, E2E_PIN_COMMAND,
 *     E2E_PROBE_PATH (an authenticated route, e.g. /hotel)
 * Run: RUN_E2E=1 E2E_BASE_URL=https://… ADMIN_USER=… ADMIN_PASS=… E2E_PIN_COMMAND='…' \
 *      pnpm vitest run src/services/browser/scenarioExec.e2e.test.ts
 */
describe.skipIf(!process.env.RUN_E2E)('executeScenarios (real machine)', () => {
  it('logs in once and runs an authenticated scenario to a passing finding', async () => {
    const { chromium } = await import('playwright')
    const baseUrl = process.env.E2E_BASE_URL ?? 'https://development.admin.spot-ly.jp:3100'
    const probe = process.env.E2E_PROBE_PATH ?? '/hotel'

    const target: TargetEnv = {
      name: 'admin',
      baseUrl,
      auth: {
        strategy: 'form',
        loginPath: process.env.E2E_LOGIN_PATH ?? '/login',
        username: process.env.ADMIN_USER ?? '',
        password: process.env.ADMIN_PASS ?? '',
        twoFactor: process.env.E2E_PIN_COMMAND
          ? {
              pinCommand: process.env.E2E_PIN_COMMAND,
              pinFieldSelector: 'input[name="pin_code"]',
              submitSelector: 'button[type="submit"]',
            }
          : undefined,
      },
    }

    const scenario: Scenario = {
      id: 'grow-hotel',
      title: 'View hotel page',
      businessFlow: 'An authenticated admin views the hotel page',
      steps: [
        { action: 'navigate', target: probe, expectedOutcome: 'hotel page loads' },
        { action: 'assert', target: `url=${probe}`, expectedOutcome: 'on hotel page' },
      ],
      expectedResults: [{ kind: 'ui', description: 'hotel page', assertion: 'reached' }],
      expectedDbState: [],
      precondition: { auth: 'authenticated' },
    }

    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      const findings = await executeScenarios(
        page as never,
        target,
        [scenario],
        { username: target.auth!.username!, password: target.auth!.password! },
        {
          authenticate,
          pinRunner: defaultComposeRunner,
          pinCommand: target.auth?.twoFactor?.pinCommand,
          secrets: [target.auth!.password!],
        },
      )
      expect(findings).toHaveLength(1)
      expect(findings[0].category).toBe('scenario')
      expect(findings[0].severity).toBe('low')
    } finally {
      await browser.close()
    }
  }, 120_000)
})
