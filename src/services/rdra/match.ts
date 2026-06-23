import { firstNavigateTarget, apiEndpoints } from './convert.js'
import type { Usecase } from './types.js'
import { allSteps, type Scenario } from '../../scenario/schema.js'

type RouteKey = { method: string; path: string }

const METHOD_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)\s+/i

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

/** Parse "<METHOD> <path>" into a route key; method defaults to ANY. Shared with rdra-analyzer. */
export function normalizeRoute(s: string): RouteKey {
  const t = s.trim()
  const m = METHOD_RE.exec(t)
  const method = m ? m[1].toUpperCase() : 'ANY'
  const rest = m ? t.slice(m[0].length) : t
  return { method, path: normalizePath(rest) }
}

function methodMatches(a: string, b: string): boolean {
  return a === 'ANY' || b === 'ANY' || a === b
}

function routeKeyEquals(x: RouteKey, y: RouteKey): boolean {
  return methodMatches(x.method, y.method) && x.path === y.path
}

/** key.path is under route.path (e.g. /hotel/123 under /hotel), with method compatible. */
function routeKeyUnder(key: RouteKey, route: RouteKey): boolean {
  return route.path !== '/' && methodMatches(key.method, route.method) && key.path.startsWith(route.path + '/')
}

/** All navigate targets, normalized to paths. */
export function navigateRoutes(scenario: Scenario): string[] {
  return allSteps(scenario).filter((s) => s.action === 'navigate').map((s) => normalizePath(s.target))
}

function usecaseRouteKeys(uc: Usecase): RouteKey[] {
  return [...(uc.related_routes ?? []), ...(uc.related_pages ?? [])].map(normalizeRoute)
}

function scenarioKeys(scenario: Scenario): { nav: RouteKey | null; apis: RouteKey[] } {
  const navTarget = firstNavigateTarget(scenario)
  const nav: RouteKey | null = navTarget === null ? null : { method: 'ANY', path: normalizePath(navTarget) }
  const apis: RouteKey[] = apiEndpoints(scenario)
    .filter((e) => e.path !== null)
    .map((e) => ({ method: e.method ?? 'ANY', path: normalizePath(e.path as string) }))
  return { nav, apis }
}

/**
 * Match a scenario to a usecase by route, two keys (navigate + API), shared normalization.
 * Priority: navigate exact > api exact > navigate prefix > api prefix. Same priority → first usecase.
 */
export function matchUsecase(scenario: Scenario, usecases: Usecase[]): Usecase | null {
  const { nav, apis } = scenarioKeys(scenario)
  const ucKeys = usecases.map((uc) => ({ uc, keys: usecaseRouteKeys(uc) }))

  // 1) navigate exact
  if (nav) {
    for (const { uc, keys } of ucKeys) {
      if (keys.some((r) => routeKeyEquals(nav, r))) return uc
    }
  }
  // 2) api exact
  for (const { uc, keys } of ucKeys) {
    if (apis.some((a) => keys.some((r) => routeKeyEquals(a, r)))) return uc
  }
  // 3) navigate prefix
  if (nav) {
    for (const { uc, keys } of ucKeys) {
      if (keys.some((r) => routeKeyUnder(nav, r))) return uc
    }
  }
  // 4) api prefix
  for (const { uc, keys } of ucKeys) {
    if (apis.some((a) => keys.some((r) => routeKeyUnder(a, r)))) return uc
  }
  return null
}
