import { allSteps, type Scenario } from './schema.js'

/**
 * Returns true if the scenario looks like a login scenario.
 * Primary signal: any step navigates to the exact loginPath.
 * Secondary signal (title text) requires corroboration — the scenario must also have
 * a credential-action step (fill/submit/login) targeting the loginPath; title text alone
 * is not sufficient to avoid false-positives like "Logout redirects to login".
 */
export function isLoginScenario(scenario: Scenario, loginPath?: string): boolean {
  // Primary: exact path match
  if (loginPath && allSteps(scenario).some((s) => s.target === loginPath)) {
    return true
  }

  // Secondary: title/businessFlow mentions login only when there is also a
  // credential-action step targeting the loginPath
  if (loginPath) {
    const text = `${scenario.title} ${scenario.businessFlow}`.toLowerCase()
    const mentionsLogin = text.includes('login') || text.includes('sign in') || text.includes('signin')
    const hasCredentialStep = allSteps(scenario).some(
      (s) =>
        s.target === loginPath &&
        (s.action === 'fill' || s.action === 'submit' || s.action === 'login'),
    )
    if (mentionsLogin && hasCredentialStep) {
      return true
    }
  }

  return false
}

/** Find the designated login scenario among the loaded scenarios (first match), or undefined. */
export function findLoginScenario<T extends Scenario>(scenarios: T[], loginPath?: string): T | undefined {
  return scenarios.find((s) => isLoginScenario(s, loginPath))
}
