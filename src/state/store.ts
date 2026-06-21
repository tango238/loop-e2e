import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readYaml, writeYaml } from '../util/fs.js'
import { statePaths } from './paths.js'
import type { SiteStructure, Feedback } from '../domain/types.js'

export type KnownFinding = {
  fingerprint: string
  reason: string
  by: string
  recordedAt?: string
}

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
  const yamlFiles = files.filter((f) => f.endsWith('.yaml'))
  if (yamlFiles.length === 0) return null
  // Sort by file modification time so ordering is robust to arbitrary runId formats
  const withMtimes = await Promise.all(
    yamlFiles.map(async (f) => {
      const { mtimeMs } = await stat(join(paths.runs, f))
      return { f, mtimeMs }
    }),
  )
  withMtimes.sort((a, b) => a.mtimeMs - b.mtimeMs)
  const latest = withMtimes[withMtimes.length - 1].f
  return readYaml<SiteStructure>(join(paths.runs, latest))
}

/**
 * Loads all feedback items from `.loop-e2e/feedback/*.feedback.yaml` (one file per item).
 * Falls back to reading a legacy `feedback.yaml` array file if present.
 * Returns an empty array if no feedback files exist.
 */
export async function loadFeedback(root: string): Promise<Feedback[]> {
  const paths = statePaths(root)
  let files: string[]
  try {
    files = await readdir(paths.feedback)
  } catch {
    return []
  }

  // Per-item files (new format: <id>.feedback.yaml)
  const perItemFiles = files.filter((f) => f.endsWith('.feedback.yaml'))
  if (perItemFiles.length > 0) {
    const items = await Promise.all(
      perItemFiles.map((f) => readYaml<Feedback>(join(paths.feedback, f))),
    )
    return items
  }

  // Legacy: single feedback.yaml array
  const legacyFile = join(paths.feedback, 'feedback.yaml')
  try {
    const data = await readYaml<Feedback[]>(legacyFile)
    return data ?? []
  } catch {
    return []
  }
}

/**
 * Persists a single feedback item to `.loop-e2e/feedback/<id>.feedback.yaml`.
 * Appends without reading existing items — each item lives in its own file.
 */
export async function saveFeedback(root: string, feedback: Feedback): Promise<void> {
  const paths = statePaths(root)
  const file = join(paths.feedback, `${feedback.id}.feedback.yaml`)
  await writeYaml(file, feedback)
}

/**
 * Loads all known-findings entries from `.loop-e2e/known-findings/*.yaml`.
 * Known findings are fingerprinted findings the user has acknowledged so future
 * diff/verify runs won't re-flag them.
 */
export async function loadKnownFindings(root: string): Promise<KnownFinding[]> {
  const paths = statePaths(root)
  let files: string[]
  try {
    files = await readdir(paths.knownFindings)
  } catch {
    return []
  }
  const yamlFiles = files.filter((f) => f.endsWith('.yaml'))
  if (yamlFiles.length === 0) return []
  const items = await Promise.all(
    yamlFiles.map((f) => readYaml<KnownFinding>(join(paths.knownFindings, f))),
  )
  return items
}

/**
 * Saves a known-finding entry keyed by fingerprint.
 * If an entry with the same fingerprint already exists it is overwritten.
 */
export async function saveKnownFinding(
  root: string,
  fingerprint: string,
  meta: { reason: string; by: string },
): Promise<void> {
  const paths = statePaths(root)
  // Sanitise fingerprint for use as a filename
  const safeName = fingerprint.replace(/[^a-zA-Z0-9_-]/g, '_')
  const file = join(paths.knownFindings, `${safeName}.yaml`)
  const entry: KnownFinding = {
    fingerprint,
    reason: meta.reason,
    by: meta.by,
    recordedAt: new Date().toISOString(),
  }
  await writeYaml(file, entry)
}
