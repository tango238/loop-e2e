import * as p from '@clack/prompts'
import type { Config } from '../../config/schema.js'

/**
 * Collects project configuration interactively using @clack/prompts.
 * Returns a Config object suitable for passing to runInit.
 */
export async function promptConfig(): Promise<Config> {
  p.intro('loop-e2e init')

  const scenarioDir = await p.text({
    message: 'Scenario directory',
    placeholder: 'scenarios',
    defaultValue: 'scenarios',
  })
  if (p.isCancel(scenarioDir)) {
    p.cancel('Cancelled.')
    process.exit(0)
  }

  const intervalMinutes = await p.text({
    message: 'Schedule interval (minutes)',
    placeholder: '60',
    defaultValue: '60',
    validate(value) {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1) return 'Must be a positive integer'
    },
  })
  if (p.isCancel(intervalMinutes)) {
    p.cancel('Cancelled.')
    process.exit(0)
  }

  const baselineCommit = await p.confirm({
    message: 'Commit baseline snapshots to git?',
    initialValue: false,
  })
  if (p.isCancel(baselineCommit)) {
    p.cancel('Cancelled.')
    process.exit(0)
  }

  const repoUrlsRaw = await p.text({
    message: 'GitHub repository URLs (comma-separated)',
    placeholder: 'https://github.com/org/frontend,https://github.com/org/backend',
    validate(value) {
      if (!value?.trim()) return 'At least one repository URL is required'
    },
  })
  if (p.isCancel(repoUrlsRaw)) {
    p.cancel('Cancelled.')
    process.exit(0)
  }

  const repositories: Config['repositories'] = (repoUrlsRaw as string)
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
    .map((url, i) => ({
      name: `repo-${i + 1}`,
      label: `Repo ${i + 1}`,
      url,
      role: 'frontend' as const,
      audience: 'user' as const,
    }))

  const targetUrlRaw = await p.text({
    message: 'Target base URL',
    placeholder: 'http://localhost:3000',
    validate(value) {
      if (!value?.trim()) return 'A target URL is required'
    },
  })
  if (p.isCancel(targetUrlRaw)) {
    p.cancel('Cancelled.')
    process.exit(0)
  }

  const targets: Config['targets'] = [
    {
      name: 'app',
      baseUrl: targetUrlRaw as string,
    },
  ]

  p.outro('Configuration collected — writing files…')

  return {
    repositories,
    targets,
    databases: [],
    schedule: { intervalMinutes: Number(intervalMinutes) },
    scenarioDir: scenarioDir as string,
    github: {
      labels: { ready: 'loop-e2e:ready', autoDetect: 'loop-e2e:auto-detect' },
    },
    baseline: { commit: baselineCommit as boolean },
    models: {
      planning: 'claude-opus-4-8',
      report: 'claude-sonnet-4-6',
      verification: 'claude-opus-4-8',
    },
    ingestion: { cloneDepth: 50, tokenBudgetPerRepo: 120000, gitLogCount: 50 },
    refutation: {
      panelSize: 3,
      confidenceThreshold: 0.8,
      lenses: ['correctness', 'security', 'intentionality'],
    },
  }
}
