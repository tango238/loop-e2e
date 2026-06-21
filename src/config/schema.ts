import { z } from 'zod'

export const RepositorySchema = z.object({
  name: z.string(),
  label: z.string(),
  url: z.string().url(),
  role: z.enum(['frontend', 'backend']),
  audience: z.enum(['user', 'admin']),
  branch: z.string().optional(),
})

export const AuthSchema = z.object({
  strategy: z.enum(['form', 'basic', 'none']),
  loginPath: z.string().optional(),
  usernameEnv: z.string().optional(),
  passwordEnv: z.string().optional(),
})

export const TargetSchema = z.object({
  name: z.string(),
  baseUrl: z.string().url(),
  auth: AuthSchema.optional(),
})

export const DbSchema = z.object({
  name: z.string(),
  type: z.enum(['postgres', 'mysql']),
  host: z.string(),
  port: z.number().int().positive(),
  database: z.string(),
  user: z.string(),
  passwordEnv: z.string(),
})

const ModelsSchema = z.object({
  planning: z.string().default('claude-opus-4-8'),
  report: z.string().default('claude-sonnet-4-6'),
  verification: z.string().default('claude-opus-4-8'),
}).default({ planning: 'claude-opus-4-8', report: 'claude-sonnet-4-6', verification: 'claude-opus-4-8' })

const IngestionSchema = z.object({
  cloneDepth: z.number().int().min(1).default(50),
  tokenBudgetPerRepo: z.number().int().min(1000).default(120000),
  gitLogCount: z.number().int().min(1).default(50),
}).default({ cloneDepth: 50, tokenBudgetPerRepo: 120000, gitLogCount: 50 })

const RefutationSchema = z.object({
  panelSize: z.number().int().min(1).default(3),
  confidenceThreshold: z.number().min(0).max(1).default(0.8),
  lenses: z.array(z.enum(['correctness', 'security', 'intentionality']))
    .default(['correctness', 'security', 'intentionality']),
}).default({ panelSize: 3, confidenceThreshold: 0.8, lenses: ['correctness', 'security', 'intentionality'] })

const LaunchSchema = z.object({
  compose: z.object({
    files: z.array(z.string().min(1)).min(1),
    projectName: z.string().min(1),
    envFile: z.string().optional(),
  }),
  readiness: z.object({
    url: z.string().url(),
    timeoutSec: z.number().int().positive().default(180),
    intervalSec: z.number().int().positive().default(3),
  }),
  seed: z.object({ command: z.string().min(1) }).optional(),
  targetName: z.string().min(1),
})

export type Launch = z.infer<typeof LaunchSchema>

export const ConfigSchema = z.object({
  repositories: z.array(RepositorySchema).min(1),
  targets: z.array(TargetSchema).min(1),
  databases: z.array(DbSchema),
  schedule: z.object({ intervalMinutes: z.number().int().min(1) }),
  scenarioDir: z.string().min(1),
  github: z.object({ labels: z.object({ ready: z.string(), autoDetect: z.string() }) }),
  baseline: z.object({ commit: z.boolean().default(false) }).default({ commit: false }),
  models: ModelsSchema,
  ingestion: IngestionSchema,
  refutation: RefutationSchema,
  launch: LaunchSchema.optional(),
  setup: z.array(z.object({ command: z.string().min(1) })).optional(),
})

export type Config = z.infer<typeof ConfigSchema>
export type DbConfig = z.infer<typeof DbSchema>
export const CONFIG_FILENAME = 'loop-e2e.config.yaml'
