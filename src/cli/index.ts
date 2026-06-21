#!/usr/bin/env node
import { Command } from 'commander'
import { createGithubClient } from '../services/github/client.js'
import { ensureLabels } from '../services/github/labels.js'
import { runInit } from './commands/init.js'
import { runDown } from './commands/down.js'
import { runScenario } from './commands/scenario.js'
import { runRun } from './commands/run.js'
import { runFeedback } from './commands/feedback.js'
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

    let secrets: import('../domain/types.js').Secrets | undefined
    try {
      const loaded = await loadConfig(cwd)
      secrets = loaded.secrets
    } catch (err) {
      process.stderr.write(`Error loading config: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
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
  .action(async (opts: { target?: string }) => {
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
    const { adjudicate } = await import('../services/llm/refute.js')
    const { upsertIssue } = await import('../services/github/issues.js')
    const { parseRepoUrl } = await import('../services/github/labels.js')
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
      await runRun(cwd, opts, {
        collect: (ctx, _deps) => collect(ctx, {
          store: storeModule,
          crawl,
          extractPageInfo: (lm, raw) => extractPageInfo(lm as Parameters<typeof extractPageInfo>[0], raw),
          browser: browserCtx!.browser,
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

program.parse()
