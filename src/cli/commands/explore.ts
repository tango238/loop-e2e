import { logger } from '../../util/logger.js'
import type { ExploreOpts, ExploreResult, ExploreDeps } from '../../pipeline/explore.js'
import type { Config } from '../../config/schema.js'
import type { Secrets, TargetEnv } from '../../domain/types.js'
import type { BrowserLike } from '../../services/browser/crawler.js'

export type RunExploreDeps = {
  loadConfig: (cwd: string) => Promise<{ config: Config; secrets: Secrets }>
  explore: (root: string, opts: ExploreOpts, deps: ExploreDeps) => Promise<ExploreResult>
  createLlm: (apiKey: string, models: Config['models']) => import('../../services/llm/client.js').Llm
  createDbAdapter: (conn: Config['databases'][number], password: string) => import('../../services/db/adapter.js').DbAdapter
  createGithubClient: (token: string) => import('../../services/github/client.js').GithubClient
  launchBrowser: () => Promise<{ browser: BrowserLike }>
}

function resolveCreds(secrets: Secrets, auth: NonNullable<Config['targets'][number]['auth']>): { username: string; password: string } | null {
  const username = auth.usernameEnv ? secrets.targetAuth[auth.usernameEnv] : undefined
  const password = auth.passwordEnv ? secrets.targetAuth[auth.passwordEnv] : undefined
  if (!username || !password) return null
  return { username, password }
}

/** Resolve config/target/creds/db and invoke the explore pipeline with real deps. */
export async function runExplore(cwd: string, opts: ExploreOpts, deps: RunExploreDeps): Promise<ExploreResult> {
  const { config, secrets } = await deps.loadConfig(cwd)

  const selected = opts.target
    ? config.targets.find((t) => t.name === opts.target)
    : config.targets[0]
  if (!selected) throw new Error(`explore: no matching target${opts.target ? ` "${opts.target}"` : ''} configured`)
  if (!selected.auth || selected.auth.strategy === 'none') throw new Error('explore: target has no form auth configured')

  const creds = resolveCreds(secrets, selected.auth)
  if (!creds) throw new Error('explore: target credentials not configured (usernameEnv/passwordEnv)')

  const target: TargetEnv = {
    name: selected.name,
    baseUrl: selected.baseUrl,
    auth: {
      strategy: selected.auth.strategy,
      loginPath: selected.auth.loginPath,
      username: creds.username,
      password: creds.password,
      twoFactor: selected.auth.twoFactor,
    },
  }

  const allSecrets: string[] = [
    secrets.anthropicApiKey,
    secrets.githubToken,
    ...Object.values(secrets.db),
    ...Object.values(secrets.targetAuth),
  ].filter(Boolean) as string[]

  const llm = deps.createLlm(secrets.anthropicApiKey, config.models)

  const dbConf = config.databases[0]
  const dbType: 'postgres' | 'mysql' = (dbConf?.type as 'postgres' | 'mysql') ?? 'postgres'
  const db = dbConf ? deps.createDbAdapter(dbConf, secrets.db[dbConf.passwordEnv] ?? '') : undefined

  const githubClient = secrets.githubToken ? deps.createGithubClient(secrets.githubToken) : null
  const repoUrl = config.repositories[0]?.url

  // lazily import the heavy/real implementations
  const { authenticate } = await import('../../services/browser/login.js')
  const { discoverForms } = await import('../../services/explore/discover.js')
  const { inferCandidateTables, modelConstraints } = await import('../../services/explore/constraintModel.js')
  const { introspectTable } = await import('../../services/explore/dbIntrospect.js')
  const { generateCases, buildBaseline } = await import('../../services/explore/caseGen.js')
  const { runCase } = await import('../../services/explore/execute.js')
  const { classifyGap, classifyErrorQuality } = await import('../../services/explore/oracle.js')
  const { wasValueSaved } = await import('../../services/explore/dbProbe.js')
  const { writeReport } = await import('../../pipeline/report.js')
  const { prepare } = await import('../../pipeline/prepare.js')
  const { seedDatabase } = await import('../../services/seed/seed.js')
  const { adjudicate } = await import('../../services/llm/refute.js')
  const { upsertIssue } = await import('../../services/github/issues.js')
  const { parseRepoUrl } = await import('../../services/github/labels.js')
  const { defaultComposeRunner } = await import('../../services/compose/compose.js')

  const repo = githubClient && repoUrl ? parseRepoUrl(repoUrl) : null

  const browserCtx = await deps.launchBrowser()
  try {
    const ctx = { root: cwd, runId: '', config, secrets }

    // Track the most recent mutating-request response status, used by the gap oracle's
    // "2xx accepted" signal. Attached per page; explore drives a single page.
    let lastStatus: number | undefined
    const createPage = async () => {
      const page = await browserCtx.browser.newPage()
      const raw = page as unknown as {
        on?: (event: 'response', cb: (res: { status: () => number; request: () => { method: () => string } }) => void) => void
      }
      raw.on?.('response', (res) => {
        try {
          const method = res.request().method().toUpperCase()
          if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) lastStatus = res.status()
        } catch {
          /* ignore listener errors */
        }
      })
      return page
    }

    const result = await deps.explore(cwd, opts, {
      target,
      creds,
      dbType,
      seed: config.launch?.seed,
      config,
      secrets: allSecrets,
      // Real execution deps: mask page error text against ALL secrets, and feed the
      // mutating-response status into the oracle. (Without this, runCase would mask against
      // [] and the 2xx gap signal would be dead — see review #1.)
      execDeps: { secrets: allSecrets, getLastStatus: () => lastStatus },
      createPage,
      authenticate: (page, t, c) => authenticate(page, t, c, { pinRunner: defaultComposeRunner, secrets: allSecrets }),
      discoverForms: (page, t, screens) => discoverForms(page, t, screens),
      inferCandidateTables,
      introspectTable,
      modelConstraints,
      generateCases,
      buildBaseline,
      runCase,
      classifyGap,
      classifyErrorQuality,
      wasValueSaved,
      db,
      llm,
      // sourceRules (spec §4.2 — Laravel FormRequest / Zod / class-validator extraction) is a
      // deferred follow-up; constraint modeling currently uses DB columns + HTML only. The
      // `sourceRules` hook on ExploreDeps is left injectable for when ingestion is wired.
      writeReport,
      reportDeps: {
        ctx,
        llm,
        adjudicate,
        upsertIssue: (client, r, finding, label) => upsertIssue(client, r, finding, label, allSecrets),
        // No-op baseline save: explore must NOT clobber the crawl baseline.
        store: { saveBaseline: async () => {} },
        githubClient,
        repo,
      },
      prepare,
      seedDatabase: (seed, root, s) => seedDatabase(seed, root, defaultComposeRunner, s),
    })
    logger.info({ result: { forms: result.forms, cases: result.cases } }, 'explore complete')
    return result
  } finally {
    await browserCtx.browser.close().catch(() => {})
  }
}
