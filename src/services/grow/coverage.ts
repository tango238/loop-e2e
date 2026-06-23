import type { RawPage } from '../../domain/types.js'
import { allSteps, type Scenario } from '../../scenario/schema.js'

/**
 * Return the discovered pages whose path is NOT already covered by an existing
 * scenario. A page is "covered" when some scenario has a `navigate` step whose
 * target resolves to the same normalized path. Paths are compared by pathname
 * with trailing slashes, query strings, and fragments ignored.
 */
export function findUncoveredPages(discovered: RawPage[], scenarios: Scenario[]): RawPage[] {
  const covered = new Set<string>()
  for (const scenario of scenarios) {
    for (const step of allSteps(scenario)) {
      if (step.action === 'navigate') {
        covered.add(normalizePath(step.target))
      }
    }
  }
  return discovered.filter((page) => !covered.has(normalizePath(page.url)))
}

/** Normalize a URL or bare path to a comparable pathname (no query/fragment/trailing slash). */
function normalizePath(urlOrPath: string): string {
  let path: string
  try {
    path = new URL(urlOrPath).pathname
  } catch {
    // bare path — strip fragment and query manually
    path = urlOrPath.split('#')[0].split('?')[0]
  }
  path = path.replace(/\/+$/, '')
  return path === '' ? '/' : path
}
