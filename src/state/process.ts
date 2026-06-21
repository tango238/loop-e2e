import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureDir, readJson } from '../util/fs.js'
import { statePaths } from './paths.js'

export type ProcessState = {
  projectName: string
  composeFiles: string[]
  startedAt: string
  readinessUrl: string
}

function processJsonPath(root: string): string {
  return join(statePaths(root).base, 'process.json')
}

export async function saveProcessState(root: string, state: ProcessState): Promise<void> {
  const base = statePaths(root).base
  await ensureDir(base)
  await writeFile(processJsonPath(root), JSON.stringify(state, null, 2), 'utf8')
}

export async function loadProcessState(root: string): Promise<ProcessState | null> {
  try {
    return await readJson<ProcessState>(processJsonPath(root))
  } catch {
    return null
  }
}

export async function clearProcessState(root: string): Promise<void> {
  await rm(processJsonPath(root), { force: true })
}
