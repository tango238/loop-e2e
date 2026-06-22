import { z } from 'zod'
import type { TwoFactor, Grow } from '../config/schema.js'

export type { TwoFactor, Grow }

export type Secrets = {
  db: Record<string, string>
  targetAuth: Record<string, string>
  anthropicApiKey: string
  githubToken: string
}

// --- RawPage: collected from browser ---
export type RawPage = {
  url: string
  title: string
  html: string
  meta: Record<string, string>
  screenshotPath: string
}

// --- PageInfo: structured by LLM ---
export const DisplayItemSchema = z.object({
  type: z.string(),
  label: z.string(),
  selector: z.string().optional(),
})

export const InputItemSchema = z.object({
  type: z.string(),
  label: z.string(),
  name: z.string().optional(),
  selector: z.string().optional(),
  required: z.boolean().optional(),
})

export const PageInfoSchema = z.object({
  url: z.string(),
  title: z.string(),
  description: z.string(),
  meta: z.record(z.string(), z.string()).optional(),
  displayItems: z.array(DisplayItemSchema),
  inputItems: z.array(InputItemSchema),
  expectations: z.array(z.string()),
  capabilities: z.array(z.string()),
})

export type PageInfo = z.infer<typeof PageInfoSchema>
export type DisplayItem = z.infer<typeof DisplayItemSchema>
export type InputItem = z.infer<typeof InputItemSchema>

// --- Transition: navigation between pages ---
export type Transition = {
  fromUrl: string
  toUrl: string
  trigger: string
}

// --- SiteStructure: assembled from crawl + LLM extraction ---
export type SiteStructure = {
  generatedAt: string
  pages: PageInfo[]
  transitions: Transition[]
}

// --- Minimal Scenario type (M4 will extend) ---
export type Scenario = {
  id: string
  name: string
  steps: ScenarioStep[]
}

export type ScenarioStep = {
  action: string
  target?: string
  value?: string
  expect?: string
}

// --- Feedback type (M7) ---
export type Feedback = {
  id: string
  /** Finding id this feedback targets (diffFinding or verifyFinding) */
  targetFindingId?: string
  /** Free-text user comment explaining the correction */
  userComment: string
  /** LLM-determined validity verdict: valid = real correction, invalid = misunderstanding */
  verdict?: 'valid' | 'invalid'
  /** Scenarios this feedback was applied to */
  appliedTo: string[]
  createdAt: string
}

// --- PriorState: loaded by collect pipeline ---
export type PriorState = {
  baseline: SiteStructure | null
  latestReport: unknown
  feedback: Feedback[]
}

// --- RunContext: passed to pipeline stages ---
export type RunContext = {
  root: string
  runId: string
  config: import('../config/schema.js').Config
  secrets: Secrets
}

// --- TargetEnv: augmented target with resolved credentials ---
export type TargetEnv = {
  name: string
  baseUrl: string
  auth?: {
    strategy: 'form' | 'basic' | 'none'
    loginPath?: string
    username?: string
    password?: string
    twoFactor?: TwoFactor
  }
}

// --- M5 diff/report types ---

export type DiffFinding = {
  kind: 'transition' | 'displayItem' | 'inputItem' | 'expectation-gap'
  severity: 'high' | 'medium' | 'low'
  expected: string
  actual: string
  location: string
}

export type VerifyFinding = {
  category: 'layout' | 'security' | 'conditional' | 'registered-data' | 'error-handling' | 'login'
  severity: 'high' | 'medium' | 'low'
  title: string
  detail: string
  evidence: string
}

export type RefuterVote = {
  lens: 'correctness' | 'security' | 'intentionality'
  refuted: boolean
  classification: 'bug' | 'unnecessary' | 'uncertain'
  confidence: number
  rationale: string
}

export type FindingVerdict = {
  classification: 'bug' | 'unnecessary' | 'uncertain'
  confidence: number
  confirmedCount: number
  panelSize: number
  votes: RefuterVote[]
  rationale: string
}

export type Report = {
  runId: string
  startedAt: string
  target: string
  diffFindings: DiffFinding[]
  verifyFindings: VerifyFinding[]
  verdicts: Record<string, FindingVerdict>
  siteStructureRef: string
  summary: string
}
