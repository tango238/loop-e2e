#!/usr/bin/env node
import { Command } from 'commander'
import { createGithubClient } from '../services/github/client.js'
import { ensureLabels } from '../services/github/labels.js'
import { runInit } from './commands/init.js'
import { runScenario } from './commands/scenario.js'
import { runRun } from './commands/run.js'
import { runFeedback } from './commands/feedback.js'
import { createLlm } from '../services/llm/client.js'
import { loadConfig } from '../config/load.js'
import type { InitDeps } from './commands/init.js'

const program = new Command()
program.name('loop-e2e').description('AI-driven E2E verification loop').version('0.0.0')

program
  .command('init')
  .description('Initialise a project for loop-e2e')
  .action(async () => {
    const githubToken = process.env['GITHUB_TOKEN']
    const githubClient = githubToken ? createGithubClient(githubToken) : null

    const realDeps: InitDeps = {
      prompt: async (_root, _opts) => {
        // Dynamic import keeps @clack/prompts out of non-init code paths
        const { promptConfig } = await import('./commands/init-prompt.js')
        return promptConfig()
      },
      ensureLabels,
      githubClient,
    }

    await runInit(process.cwd(), {}, realDeps)
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
    await runRun(process.cwd(), opts, {
      collect: async (_ctx, _deps) => {
        throw new Error('Real collect not wired — use programmatic API with deps')
      },
      detectDiffs: async () => {
        throw new Error('Real detectDiffs not yet wired (pending M6)')
      },
      writeReport: async () => {
        throw new Error('Real writeReport not yet wired (pending M6)')
      },
    })
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
