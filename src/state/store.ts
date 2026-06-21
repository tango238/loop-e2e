import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readYaml, writeYaml } from '../util/fs.js'
import { statePaths } from './paths.js'
import type { SiteStructure, Feedback } from '../domain/types.js'

/**
 * Persists a run's SiteStructure under `.loop-e2e/runs/<runId>.yaml`.
 */
export async function saveRunStructure(
  root: string,
  runId: string,
  structure: SiteStructure,
): Promise<void> {
  const paths = statePaths(root)
  await writeYaml(join(paths.runs, `${runId}.yaml`), structure)
}

/**
 * Loads the baseline SiteStructure, or null if none exists yet.
 */
export async function loadBaseline(root: string): Promise<SiteStructure | null> {
  const paths = statePaths(root)
  const file = join(paths.baseline, 'baseline.yaml')
  try {
    return await readYaml<SiteStructure>(file)
  } catch {
    return null
  }
}

/**
 * Saves the given SiteStructure as the baseline snapshot.
 */
export async function saveBaseline(root: string, structure: SiteStructure): Promise<void> {
  const paths = statePaths(root)
  await writeYaml(join(paths.baseline, 'baseline.yaml'), structure)
}

/**
 * Loads the most recently saved run structure as the "latest report".
 * Returns null if no runs exist.
 */
export async function loadLatestReport(root: string): Promise<SiteStructure | null> {
  const paths = statePaths(root)
  let files: string[]
  try {
    files = await readdir(paths.runs)
  } catch {
    return null
  }
  const yamlFiles = files.filter((f) => f.endsWith('.yaml')).sort()
  if (yamlFiles.length === 0) return null
  const latest = yamlFiles[yamlFiles.length - 1]
  return readYaml<SiteStructure>(join(paths.runs, latest))
}

/**
 * Loads all feedback items from `.loop-e2e/feedback/feedback.yaml`.
 * Returns an empty array if no feedback file exists.
 */
export async function loadFeedback(root: string): Promise<Feedback[]> {
  const paths = statePaths(root)
  const file = join(paths.feedback, 'feedback.yaml')
  try {
    const data = await readYaml<Feedback[]>(file)
    return data ?? []
  } catch {
    return []
  }
}
