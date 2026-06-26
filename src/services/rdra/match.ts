import { allSteps, type Scenario } from '../../scenario/schema.js'

// Route/path helpers for the rdra-export pending handoff. Usecase matching itself
// lives in rdra-analyzer's reconcile (context-map R4: ② is the sole arbiter) — loop-e2e
// only normalizes navigate targets so reconcile can fact-check them against checkpoint.

/** Strip origin/query/fragment and trailing slash (root "/" kept). Handles full URL or path. */
export function normalizePath(url: string): string {
  let path: string
  if (url.startsWith('/')) {
    // Already a path — strip query/fragment directly (avoids new URL mis-parsing "foo:bar").
    path = url.split('#')[0].split('?')[0]
  } else {
    try {
      path = new URL(url).pathname
    } catch {
      path = url.split('#')[0].split('?')[0]
    }
  }
  if (path.length > 1) path = path.replace(/\/+$/, '')
  return path === '' ? '/' : path
}

/** All navigate targets, normalized to paths. */
export function navigateRoutes(scenario: Scenario): string[] {
  return allSteps(scenario).filter((s) => s.action === 'navigate').map((s) => normalizePath(s.target))
}
