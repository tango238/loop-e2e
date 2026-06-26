export type OperationStep = {
  step_no: number
  actor: string
  action: string
  expected_result: string
  ui_element: string
}

/** Structured API endpoint. method/path are null when not parseable; raw is always present. */
export type ApiEndpoint = {
  method: string | null
  path: string | null
  raw: string
}

/**
 * The inbound Published-Language record loop-e2e hands to rdra-analyzer's reconcile.
 * Carries NO usecase linkage — reconcile is the sole arbiter (context-map R4).
 */
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
