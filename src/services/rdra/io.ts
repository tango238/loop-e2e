import { writeFile as fsWriteFile } from 'node:fs/promises'
import type { PendingEntry } from './types.js'

export type IoDeps = {
  writeFile?: (p: string, data: string) => Promise<void>
}

export async function writePending(path: string, pending: PendingEntry[], deps: IoDeps = {}): Promise<void> {
  const writeFile = deps.writeFile ?? ((p: string, d: string) => fsWriteFile(p, d, 'utf8'))
  await writeFile(path, JSON.stringify({ generatedBy: 'loop-e2e rdra-export', pending }, null, 2) + '\n')
}
