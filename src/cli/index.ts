#!/usr/bin/env node
import { Command } from 'commander'
import { createGithubClient } from '../services/github/client.js'
import { ensureLabels } from '../services/github/labels.js'
import { runInit } from './commands/init.js'
import { runDown } from './commands/down.js'
import { runScenario } from './commands/scenario.js'
import { runRun } from './commands/run.js'
import { runFeedback } from './commands/feedback.js'
import { runGrow } from './commands/grow.js'
import { runApprove } from './commands/approve.js'
import { createLlm } from '../services/llm/client.js'
import { loadConfig } from '../config/load.js'
import { logger } from '../util/logger.js'
import { composeUp, composeDown, defaultComposeRunner } from '../services/compose/compose.js'
import { waitForReadiness } from '../services/compose/readiness.js'
import { seedDatabase } from '../services/seed/seed.js'
import { ensureRepoClone } from '../services/repo/clone.js'
import { saveProcessState, loadProcessState, clearProcessState } from '../state/process.js'
import type { InitDeps } from './commands/init.js'

const program = new Command()
program.name('loop-e2e').description('AI-driven E2E verification loop').version('0.0.0')

program
  .command('init')
  .description('Initialise a project for loop-e2e')
  .action(async () => {
    const cwd = process.cwd()
    const githubToken = process.env['GITHUB_TOKEN']
    const githubClient = githubToken ? createGithubClient(githubToken) : null

    // Attempt to load secrets for launch orchestration; non-fatal if absent at init time
    let secrets: import('../domain/types.js').Secrets | undefined
    try {
      const loaded = await loadConfig(cwd)
      secrets = loaded.secrets
    } catch {
      // Config may not exist yet during first init — launch steps will use empty secrets
    }

    const realDeps: InitDeps = {
      prompt: async (_root, _opts) => {
        // Dynamic import keeps @clack/prompts out of non-init code paths
        const { promptConfig } = await import('./commands/init-prompt.js')
        return promptConfig()
      },
      ensureLabels,
      githubClient,
      composeUp,
      waitForReadiness: (url, opts) => waitForReadiness(url, opts, (u) => fetch(u).then((r) => ({ status: r.status }))),
      seedDatabase,
      ensureRepoClone: (repo, token, ingestion, root) => ensureRepoClone(repo, token, ingestion, root),
      saveProcessState,
      secrets,
      now: () => new Date().toISOString(),
      composeRunner: defaultComposeRunner,
    }

    await runInit(cwd, {}, realDeps)
  })

program
  .command('down')
  .description('Stop the local docker stack started by init')
  .option('--volumes', 'Also remove docker volumes')
  .action(async (opts: { volumes?: boolean }) => {
    const cwd = process.cwd()

    let secrets: import('../domain/types.js').Secrets
    try {
      const loaded = await loadConfig(cwd)
      secrets = loaded.secrets
    } catch (err) {
      // Config or .env missing/broken — proceed with empty secrets so a recorded stack
      // can still be torn down (runDown reads .loop-e2e/process.json, not config).
      // Masking is best-effort on teardown.
      process.stderr.write(`Warning: config load failed (${err instanceof Error ? err.message : String(err)}); proceeding with empty secrets\n`)
      secrets = { anthropicApiKey: '', githubToken: '', db: {}, targetAuth: {} }
    }

    await runDown(cwd, { volumes: opts.volumes }, {
      loadProcessState,
      composeDown,
      clearProcessState,
      secrets,
      composeRunner: defaultComposeRunner,
    })
  })

program
  .command('scenario')
  .description('Generate E2E test scenarios from repository requirements using AI')
  .option('--from <paths...>', 'Additional requirement files to merge into context')
  .action(async (opts: { from?: string[] }) => {
    await runScenario(process.cwd(), { from: opts.from })
  })

program
  .command('run')
  .description('Run E2E loop: collect → diff → report')
  .option('--target <name>', 'Target name to run against')
  .option('--skip-prepare', 'Skip the pre-run prepare phase (repo refresh + setup hooks)')
  .option('--skip-scenarios', 'Skip executing adopted scenarios (only collect/diff/verify)')
  .action(async (opts: { target?: string; skipPrepare?: boolean; skipScenarios?: boolean }) => {
    const cwd = process.cwd()

    let config: import('../config/schema.js').Config
    let secrets: import('../domain/types.js').Secrets
    try {
      const loaded = await loadConfig(cwd)
      config = loaded.config
      secrets = loaded.secrets
    } catch (err) {
      process.stderr.write(`Error loading config: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }

    const llm = createLlm(secrets.anthropicApiKey, config.models)

    const { loadScenarios } = await import('../scenario/schema.js')
    const scenarioDir = config.scenarioDir.startsWith('/')
      ? config.scenarioDir
      : `${cwd}/${config.scenarioDir}`
    const scenarios = await loadScenarios(scenarioDir)

    // Use named target if --target given; fall back to first target
    const selectedTarget = opts.target
      ? (config.targets.find((t) => t.name === opts.target) ?? config.targets[0])
      : config.targets[0]

    if (!selectedTarget) {
      process.stderr.write('Error: no targets configured in loop-e2e.yaml\n')
      process.exit(1)
    }

    logger.info({ target: selectedTarget.name }, 'Starting run for target')

    const { launchBrowser } = await import('../services/browser/browser.js')
    const { crawl } = await import('../services/browser/crawler.js')
    const { extractPageInfo } = await import('../services/llm/structureExtract.js')
    const { collect } = await import('../pipeline/collect.js')
    const { detectDiffs } = await import('../pipeline/diff.js')
    const { runVerify } = await import('../pipeline/verify/index.js')
    const { writeReport } = await import('../pipeline/report.js')
    const { prepare } = await import('../pipeline/prepare.js')
    const { adjudicate } = await import('../services/llm/refute.js')
    const { upsertIssue } = await import('../services/github/issues.js')
    const { parseRepoUrl } = await import('../services/github/labels.js')
    const { executeLoginScenario, authenticate } = await import('../services/browser/login.js')
    const { executeScenarios } = await import('../pipeline/executeScenarios.js')
    const storeModule = await import('../state/store.js')

    const githubClient = secrets.githubToken ? createGithubClient(secrets.githubToken) : null
    const repoUrl = config.repositories[0]?.url
    const repo = (githubClient && repoUrl) ? parseRepoUrl(repoUrl) : null

    const allSecrets: string[] = [
      secrets.anthropicApiKey,
      secrets.githubToken,
      ...Object.values(secrets.db),
      ...Object.values(secrets.targetAuth),
    ].filter(Boolean) as string[]

    let browserCtx: { browser: import('../services/browser/crawler.js').BrowserLike } | null = null
    try {
      browserCtx = await launchBrowser()
      const launchedBrowser = browserCtx.browser
      await runRun(cwd, { target: opts.target, skipPrepare: opts.skipPrepare, skipScenarios: opts.skipScenarios }, {
        prepare,
        collect: (ctx, _deps) => collect(ctx, {
          store: storeModule,
          crawl,
          extractPageInfo: (lm, raw) => extractPageInfo(lm as Parameters<typeof extractPageInfo>[0], raw),
          browser: launchedBrowser,
          llm,
          scenarios,
        }),
        detectDiffs,
        runVerify,
        writeReport,
        llm,
        scenarios,
        adjudicate,
        upsertIssue: (client, r, finding, label) => upsertIssue(client, r, finding, label, allSecrets),
        store: { saveBaseline: (root, structure) => storeModule.saveBaseline(root, structure) },
        githubClient,
        repo,
        executeLogin: executeLoginScenario,
        createPage: () => launchedBrowser.newPage(),
        executeScenarios,
        scenarioExecDeps: {
          authenticate,
          pinRunner: defaultComposeRunner,
          pinCommand: selectedTarget.auth?.twoFactor?.pinCommand,
          vars: secrets.targetAuth,
          secrets: allSecrets,
          clearCookies: async (p: unknown) => {
            const ctx = (p as { context?: () => { clearCookies?: () => Promise<void> } }).context?.()
            await ctx?.clearCookies?.()
          },
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Run failed: ${msg}\n`)
      process.exit(1)
    } finally {
      if (browserCtx) {
        await browserCtx.browser.close().catch(() => {})
      }
    }
  })

program
  .command('feedback')
  .description('Submit feedback on a finding to update known-state and scenarios')
  .option('--run <runId>', 'Run ID whose report to reference')
  .option('--finding <index>', 'Zero-based index of the finding to comment on (default: 0)', '0')
  .option('--comment <text>', 'Free-text comment explaining the correction')
  .option('--scenario <id>', 'Scenario ID to update if feedback is valid')
  .option('--scenario-dir <dir>', 'Directory where scenario files live (default: <cwd>/scenarios)')
  .action(async (opts: { run?: string; finding?: string; comment?: string; scenario?: string; scenarioDir?: string }) => {
    if (!opts.run || !opts.comment) {
      process.stderr.write('Error: --run and --comment are required\n')
      process.exit(1)
    }

    const cwd = process.cwd()
    const loaded = await loadConfig(cwd).catch(() => null)
    const apiKey = process.env['ANTHROPIC_API_KEY'] ?? ''
    const models = loaded?.config.models ?? {
      planning: 'claude-opus-4-8',
      report: 'claude-sonnet-4-6',
      verification: 'claude-opus-4-8',
    }

    await runFeedback(cwd, {
      runId: opts.run,
      findingIndex: parseInt(opts.finding ?? '0', 10),
      comment: opts.comment,
      scenarioId: opts.scenario,
      scenarioDir: opts.scenarioDir ?? `${cwd}/scenarios`,
    }, {
      llm: createLlm(apiKey, models),
    })
  })

program
  .command('grow')
  .description('Discover post-login pages and propose new scenarios (proposed drafts)')
  .option('--target <name>', 'Target name to run against')
  .option('--max-pages <n>', 'Max pages to discover', (v) => parseInt(v, 10))
  .option('--skip-prepare', 'Skip the pre-run prepare phase (repo refresh + setup hooks)')
  .action(async (opts: { target?: string; maxPages?: number; skipPrepare?: boolean }) => {
    const cwd = process.cwd()

    let config: import('../config/schema.js').Config
    let secrets: import('../domain/types.js').Secrets
    try {
      const loaded = await loadConfig(cwd)
      config = loaded.config
      secrets = loaded.secrets
    } catch (err) {
      process.stderr.write(`Error loading config: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }

    const llm = createLlm(secrets.anthropicApiKey, config.models)

    const { launchBrowser } = await import('../services/browser/browser.js')
    const { authenticate } = await import('../services/browser/login.js')
    const { discoverPages } = await import('../services/browser/discover.js')
    const { findUncoveredPages } = await import('../services/grow/coverage.js')
    const { proposeScenarios } = await import('../services/llm/proposeScenarios.js')
    const { loadScenarios, saveProposedScenario } = await import('../scenario/schema.js')
    const { prepare } = await import('../pipeline/prepare.js')

    let browserCtx: { browser: import('../services/browser/crawler.js').BrowserLike } | null = null
    try {
      browserCtx = await launchBrowser()
      const browser = browserCtx.browser
      const result = await runGrow(
        cwd,
        { target: opts.target, maxPages: opts.maxPages, skipPrepare: opts.skipPrepare },
        {
          prepare,
          createPage: () => browser.newPage(),
          authenticate,
          discoverPages,
          findUncoveredPages,
          proposeScenarios,
          loadScenarios,
          saveProposedScenario,
          llm,
          pinRunner: defaultComposeRunner,
        },
      )
      process.stdout.write(
        `grow: discovered ${result.discovered} pages, ${result.uncovered} uncovered; ` +
          `proposed ${result.proposed.length} scenarios → ${config.scenarioDir}/proposed/\n` +
          `Review with 'loop-e2e approve --all' (or per id) to adopt them.\n`,
      )
    } catch (err) {
      process.stderr.write(`grow failed: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    } finally {
      if (browserCtx) {
        await browserCtx.browser.close().catch(() => {})
      }
    }
  })

program
  .command('approve')
  .description('Promote proposed scenarios (from grow) to active')
  .argument('[ids...]', 'Scenario ids to approve (omit with --all to approve every proposed scenario)')
  .option('--all', 'Approve all proposed scenarios')
  .action(async (ids: string[], opts: { all?: boolean }) => {
    const cwd = process.cwd()
    try {
      const result = await runApprove(cwd, { all: opts.all, ids }, {})
      if (result.approved.length === 0 && result.skipped.length === 0) {
        process.stdout.write('approve: no proposed scenarios to approve (use --all or pass ids)\n')
        return
      }
      if (result.approved.length > 0) {
        process.stdout.write(`approved: ${result.approved.join(', ')}\n`)
      }
      for (const s of result.skipped) {
        process.stdout.write(`skipped ${s.id}: ${s.reason}\n`)
      }
    } catch (err) {
      process.stderr.write(`approve failed: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }
  })

program
  .command('rdra-export')
  .description('Export adopted scenarios into an rdra-analyzer analysis_result.json (route-matched merge + pending handoff)')
  .option('--into <path>', 'Path to rdra-analyzer analysis_result.json (default: <cwd>/output/usecases/analysis_result.json)')
  .option('--scenario-dir <dir>', 'Scenario directory (default: <cwd>/<config.scenarioDir>)')
  .action(async (opts: { into?: string; scenarioDir?: string }) => {
    const cwd = process.cwd()
    const { runRdraExport } = await import('./commands/rdraExport.js')
    const { rdraExport } = await import('../pipeline/rdraExport.js')
    try {
      const r = await runRdraExport(cwd, opts, { rdraExport, loadConfig })
      process.stdout.write(`matched ${r.matched} → ${r.intoPath}\n`)
      if (r.pendingPath) process.stdout.write(`pending ${r.pending} → ${r.pendingPath}\n`)
    } catch (err) {
      process.stderr.write(`rdra-export failed: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }
  })

program.parse()
