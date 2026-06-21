import { describe, it, expect } from 'vitest'
import { buildScenarioPrompt, type AuthHint } from './scenario.js'
import type { RequirementContext } from '../../repo/reader.js'

const ctx: RequirementContext = {
  repo: {
    name: 'app',
    label: 'App',
    url: 'https://github.com/acme/app',
    role: 'frontend',
    audience: 'user',
  },
  readme: '# App',
  docs: [],
  codeSummary: 'React frontend',
  gitlogSummary: 'abc Initial commit',
}

describe('buildScenarioPrompt', () => {
  it('includes a login scenario requirement when authHint is provided', () => {
    const authHint: AuthHint = { loginPath: '/auth/login' }
    const prompt = buildScenarioPrompt([ctx], authHint)

    expect(prompt).toContain('login')
    expect(prompt).toContain('/auth/login')
  })

  it('requires at least one login scenario in the generated output', () => {
    const authHint: AuthHint = { loginPath: '/login' }
    const prompt = buildScenarioPrompt([ctx], authHint)

    // The prompt must instruct the LLM to produce a login scenario
    expect(prompt.toLowerCase()).toMatch(/at least one.*login|login.*scenario/i)
  })

  it('does not include credential values in the prompt', () => {
    const authHint: AuthHint = {
      loginPath: '/login',
      usernameFieldHint: 'email',
      passwordFieldHint: 'password',
    }
    const sensitiveUsername = 'admin@secret.example.com'
    const sensitivePassword = 'hunter2-super-secret'

    // Even if someone passes credential values in some future variant, they must not appear
    const prompt = buildScenarioPrompt([ctx], authHint)
    expect(prompt).not.toContain(sensitiveUsername)
    expect(prompt).not.toContain(sensitivePassword)
  })

  it('works without authHint (no login instruction injected)', () => {
    const prompt = buildScenarioPrompt([ctx])

    // Without auth hint, the prompt must not inject login-path context
    expect(prompt).not.toContain('/login')
    expect(prompt).not.toContain('/auth/login')
  })

  it('includes field hints in prompt context when provided', () => {
    const authHint: AuthHint = {
      loginPath: '/sign-in',
      usernameFieldHint: 'input[name=email]',
      passwordFieldHint: 'input[type=password]',
    }
    const prompt = buildScenarioPrompt([ctx], authHint)

    expect(prompt).toContain('/sign-in')
    expect(prompt).toContain('input[name=email]')
    expect(prompt).toContain('input[type=password]')
  })
})
