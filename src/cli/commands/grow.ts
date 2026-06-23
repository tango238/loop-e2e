import { join, isAbsolute } from 'node:path'
import { loadConfig as defaultLoadConfig } from '../../config/load.js'
import { grow as defaultGrow, type GrowDeps, type GrowResult } from '../../pipeline/grow.js'
import { collectRequirements as defaultCollectRequirements } from '../../services/repo/reader.js'
import type { Config } from '../../config/schema.js'
import type { Secrets, TargetEnv } from '../../domain/types.js'

export type RunGrowOpts = {
  target?: string
  maxPages?: number
  skipPrepare?: boolean
  sourceOnly?: boolean
  crawlOnly?: boolean
  /** Extra requirement files (from the `--from` of the deprecated `scenario` alias). */
  fromPaths?: string[]
}

export type RunGrowDeps = GrowDeps & {
  /** Injectable for tests */
  loadConfig?: typeof defaultLoadConfig
  grow?: typeof defaultGrow
  /** Record an activity line for the aggregated report (injected; omitted in tests = no-op). */
  appendActivity?: (root: string, entry: import('../../state/findings.js').ActivityEntry) => Promise<void>
  /** Injected for deterministic activity runId in tests */
  clock?: () => string
}

/**
 * `loop-e2e grow` command: load config, resolve the target + credentials (and
 * 2FA settings), then run the grow pipeline (authenticate → discover → propose).
 */
export async function runGrow(root: string, opts: RunGrowOpts, deps: RunGrowDeps): Promise<GrowResult> {
  const load = deps.loadConfig ?? defaultLoadConfig
  const growFn = deps.grow ?? defaultGrow

  if (opts.sourceOnly && opts.crawlOnly) {
    throw new Error('grow: --source-only and --crawl-only cannot both be set')
  }

  const { config, secrets } = await load(root)

  const target = selectTarget(config, opts.target)
  // Crawl needs a form login + credentials; --source-only does not (no live app).
  let creds = { username: '', password: '' }
  if (!opts.sourceOnly) {
    if (!target.auth || target.auth.strategy !== 'form') {
      throw new Error(`grow: target '${target.name}' has no form login configured`)
    }
    const resolved = resolveCredentials(secrets, target.auth)
    if (!resolved) {
      throw new Error(`grow: missing credentials for target '${target.name}' (check usernameEnv/passwordEnv in .env)`)
    }
    creds = resolved
  }

  const envTarget = toTargetEnv(target, creds)

  const scenarioDir = isAbsolute(config.scenarioDir) ? config.scenarioDir : join(root, config.scenarioDir)

  // Apply --max-pages override onto the grow config.
  const growConfig: Config = opts.maxPages
    ? { ...config, grow: { ...(config.grow ?? { maxPages: 50, maxDepth: 3, excludePaths: [] }), maxPages: opts.maxPages } }
    : config

  const allSecrets = [
    secrets.anthropicApiKey,
    secrets.githubToken,
    ...Object.values(secrets.db),
    ...Object.values(secrets.targetAuth),
  ].filter(Boolean)

  const startedAt = new Date().toISOString()
  const result = await growFn(
    {
      config: growConfig, root, scenarioDir, target: envTarget, creds, skipPrepare: opts.skipPrepare,
      sourceOnly: opts.sourceOnly, crawlOnly: opts.crawlOnly, fromPaths: opts.fromPaths,
    },
    { ...deps, collectRequirements: deps.collectRequirements ?? defaultCollectRequirements, secrets: allSecrets, gitToken: secrets.githubToken },
  )

  // Record activity for the aggregated `report` (grow produces scenarios, not findings).
  const runId = deps.clock ? deps.clock() : new Date().toISOString().replace(/[:.]/g, '-')
  await deps.appendActivity?.(root, {
    source: 'grow', runId, startedAt,
    summary: `proposed ${result.proposed.length} scenarios (mode ${result.mode}, discovered ${result.discovered}, uncovered ${result.uncovered}, source-repos ${result.requirementsRepos})`,
  })

  return result
}

function selectTarget(config: Config, name?: string): Config['targets'][number] {
  const target = name ? config.targets.find((t) => t.name === name) : config.targets[0]
  if (!target) {
    throw new Error(name ? `grow: target not found: ${name}` : 'grow: no targets configured')
  }
  return target
}

function resolveCredentials(
  secrets: Secrets,
  auth: NonNullable<Config['targets'][number]['auth']>,
): { username: string; password: string } | null {
  const username = auth.usernameEnv ? secrets.targetAuth[auth.usernameEnv] : undefined
  const password = auth.passwordEnv ? secrets.targetAuth[auth.passwordEnv] : undefined
  if (!username || !password) return null
  return { username, password }
}

/** Map a config target (env-name auth) to a domain TargetEnv with resolved creds. */
function toTargetEnv(
  target: Config['targets'][number],
  creds: { username: string; password: string },
): TargetEnv {
  const auth = target.auth
  return {
    name: target.name,
    baseUrl: target.baseUrl,
    auth: auth
      ? {
          strategy: auth.strategy,
          loginPath: auth.loginPath,
          username: creds.username,
          password: creds.password,
        }
      : undefined,
  }
}
