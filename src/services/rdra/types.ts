export type OperationStep = {
  step_no: number
  actor: string
  action: string
  expected_result: string
  ui_element: string
}

export type OperationScenario = {
  scenario_id: string
  usecase_id: string
  usecase_name: string
  scenario_name: string
  scenario_type: string
  frontend_url: string
  /** Single string (rdra reads api_endpoint as a scalar) — "<METHOD> <path>" / path / raw / "" */
  api_endpoint: string
  steps: OperationStep[]
  variations: string[]
}

export type Usecase = {
  id: string
  name: string
  related_routes?: string[]
  related_pages?: string[]
  [k: string]: unknown
}

export type AnalysisResult = {
  metadata?: Record<string, unknown>
  usecases: Usecase[]
  scenarios: OperationScenario[]
  [k: string]: unknown
}

/** Structured API endpoint. method/path are null when not parseable; raw is always present. */
export type ApiEndpoint = {
  method: string | null
  path: string | null
  raw: string
}

export type PendingEntry = {
  loop_e2e_id: string
  scenario_name: string
  frontend_url: string
  navigate_routes: string[]
  /** Structured per the agreed contract; reconcile parses these. */
  api_endpoints: ApiEndpoint[]
  steps: OperationStep[]
  reason: string
}

/** Prefix marking loop-e2e-origin scenarios in the merged analysis file. */
export const LE_PREFIX = 'LE-'
