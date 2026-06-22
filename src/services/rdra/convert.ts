import { LE_PREFIX } from './types.js'
import type { ApiEndpoint, OperationScenario, OperationStep, PendingEntry } from './types.js'
import type { Scenario } from '../../scenario/schema.js'

const METHOD_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)\s+(\S+)/i

export function firstNavigateTarget(scenario: Scenario): string | null {
  const nav = scenario.steps.find((s) => s.action === 'navigate')
  return nav ? nav.target : null
}

/**
 * Best-effort parse of an API endpoint description into { method, path, raw }.
 * "GET /api/x returns 200" → method GET, path /api/x. A bare path → path only.
 * Unparseable text → method/path null but raw always carries the original.
 */
export function parseApiEndpoint(raw: string): ApiEndpoint {
  const t = raw.trim()
  const m = METHOD_RE.exec(t)
  if (m) return { method: m[1].toUpperCase(), path: m[2], raw }
  const first = t.split(/\s+/)[0] ?? ''
  if (first.startsWith('/')) return { method: null, path: first, raw }
  return { method: null, path: null, raw }
}

/** Structured API endpoints from a scenario's kind:'api' results (structured field wins). */
export function apiEndpoints(scenario: Scenario): ApiEndpoint[] {
  return scenario.expectedResults
    .filter((e) => e.kind === 'api')
    .map((e) => {
      if (e.apiEndpoint) {
        return {
          method: e.apiEndpoint.method ? e.apiEndpoint.method.toUpperCase() : null,
          path: e.apiEndpoint.path,
          raw: e.assertion,
        }
      }
      return parseApiEndpoint(e.assertion)
    })
}

/** Reduce endpoints to the single string rdra reads: "<METHOD> <path>" / path / raw / "". */
export function apiEndpointString(eps: ApiEndpoint[]): string {
  const first = eps[0]
  if (!first) return ''
  if (first.method && first.path) return `${first.method} ${first.path}`
  if (first.path) return first.path
  return first.raw
}

export function toOperationSteps(scenario: Scenario): OperationStep[] {
  return scenario.steps.map((s, i) => ({
    step_no: i + 1,
    actor: 'ユーザー',
    action: `${s.action} ${s.target}`.trim(),
    expected_result: s.expectedOutcome,
    ui_element: s.target,
  }))
}

export function toOperationScenario(scenario: Scenario, usecase: { id: string; name: string }): OperationScenario {
  return {
    scenario_id: `${LE_PREFIX}${scenario.id}`,
    usecase_id: usecase.id,
    usecase_name: usecase.name,
    scenario_name: scenario.title,
    scenario_type: 'normal',
    frontend_url: firstNavigateTarget(scenario) ?? '',
    api_endpoint: apiEndpointString(apiEndpoints(scenario)),
    steps: toOperationSteps(scenario),
    variations: [],
  }
}

export function toPendingEntry(scenario: Scenario, navigateRoutes: string[]): PendingEntry {
  return {
    loop_e2e_id: scenario.id,
    scenario_name: scenario.title,
    frontend_url: firstNavigateTarget(scenario) ?? '',
    navigate_routes: navigateRoutes,
    api_endpoints: apiEndpoints(scenario),
    steps: toOperationSteps(scenario),
    reason: 'no matching usecase by route',
  }
}
