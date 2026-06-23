import { join } from 'node:path'
import { readdir, readFile, writeFile, rename, appendFile } from 'node:fs/promises'
import { ensureDir } from '../util/fs.js'
import { logger } from '../util/logger.js'
import { statePaths } from './paths.js'
import type { DiffFinding, VerifyFinding } from '../domain/types.js'

/** One finding-producing command invocation's results, persisted to the shared store. */
export type FindingsEntry = {
  source: 'run' | 'explore'
  runId: string
  startedAt: string
  diffFindings: DiffFinding[]
  verifyFindings: VerifyFinding[]
}

/** A lightweight "what was done" record for non-findings commands (grow/scenario) + run/explore. */
export type ActivityEntry = {
  source: string
  runId: string
  startedAt: string
  summary: string
}

const ACTIVITY_FILE = 'activity.jsonl'
const ARCHIVE_DIR = 'archive'

/** Keep stored filenames safe — runId/source are project-local but never trust them as paths. */
function safe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '-')
}

/** Persist one command's findings to `.loop-e2e/findings/<source>-<runId>.json`. */
export async function writeFindings(root: string, entry: FindingsEntry): Promise<void> {
  const dir = statePaths(root).findings
  await ensureDir(dir)
  const file = join(dir, `${safe(entry.source)}-${safe(entry.runId)}.json`)
  await writeFile(file, JSON.stringify(entry, null, 2), 'utf8')
}

/** Read all not-yet-consumed findings entries. Unreadable/invalid files are skipped (logged). */
export async function readPendingFindings(root: string): Promise<FindingsEntry[]> {
  const dir = statePaths(root).findings
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: FindingsEntry[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = JSON.parse(await readFile(join(dir, name), 'utf8')) as Partial<FindingsEntry>
      if (raw && Array.isArray(raw.diffFindings) && Array.isArray(raw.verifyFindings) && typeof raw.source === 'string') {
        out.push(raw as FindingsEntry)
      } else {
        logger.warn({ file: name }, 'findings: entry missing required fields — skipping')
      }
    } catch (err) {
      logger.warn({ err: String(err), file: name }, 'findings: unreadable entry — skipping')
    }
  }
  return out
}

/** Append a one-line activity record to `.loop-e2e/findings/activity.jsonl`. */
export async function appendActivity(root: string, entry: ActivityEntry): Promise<void> {
  const dir = statePaths(root).findings
  await ensureDir(dir)
  await appendFile(join(dir, ACTIVITY_FILE), `${JSON.stringify(entry)}\n`, 'utf8')
}

/** Read all not-yet-consumed activity records. Malformed lines are skipped. */
export async function readPendingActivity(root: string): Promise<ActivityEntry[]> {
  const file = join(statePaths(root).findings, ACTIVITY_FILE)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ActivityEntry]
      } catch {
        return []
      }
    })
}

/**
 * Move consumed findings entries + the activity log into `findings/archive/<reportRunId>/`
 * so a subsequent `report` starts from an empty pending set. No-op if nothing is pending.
 */
export async function archiveConsumed(root: string, reportRunId: string): Promise<void> {
  const dir = statePaths(root).findings
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  const movable = names.filter((n) => n.endsWith('.json') || n === ACTIVITY_FILE)
  if (movable.length === 0) return
  const archiveDir = join(dir, ARCHIVE_DIR, safe(reportRunId))
  await ensureDir(archiveDir)
  for (const name of movable) {
    await rename(join(dir, name), join(archiveDir, name)).catch((err) =>
      logger.warn({ err: String(err), file: name }, 'findings: archive failed'),
    )
  }
}
