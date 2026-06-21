#!/usr/bin/env node
import { Command } from 'commander'
import { createGithubClient } from '../services/github/client.js'
import { ensureLabels } from '../services/github/labels.js'
import { runInit } from './commands/init.js'
import { runScenario } from './commands/scenario.js'
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

program.parse()
