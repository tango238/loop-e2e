import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises'
import type { AnalysisResult, PendingEntry } from './types.js'

export type IoDeps = {
  readFile?: (p: string) => Promise<string>
  writeFile?: (p: string, data: string) => Promise<void>
}

export async function readAnalysisResult(path: string, deps: IoDeps = {}): Promise<AnalysisResult> {
  const readFile = deps.readFile ?? ((p: string) => fsReadFile(p, 'utf8'))
  let raw: string
  try {
    raw = await readFile(path)
  } catch (err) {
    throw new Error(
      `cannot read analysis_result.json at ${path} (run rdra-analyzer analyze first): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `analysis_result.json at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const obj = parsed as AnalysisResult
  if (!Array.isArray(obj.usecases) || !Array.isArray(obj.scenarios)) {
    throw new Error(`analysis_result.json at ${path} must have array "usecases" and "scenarios"`)
  }
  return obj
}

export async function writeAnalysisResult(path: string, analysis: AnalysisResult, deps: IoDeps = {}): Promise<void> {
  const writeFile = deps.writeFile ?? ((p: string, d: string) => fsWriteFile(p, d, 'utf8'))
  await writeFile(path, JSON.stringify(analysis, null, 2) + '\n')
}

export async function writePending(path: string, pending: PendingEntry[], deps: IoDeps = {}): Promise<void> {
  const writeFile = deps.writeFile ?? ((p: string, d: string) => fsWriteFile(p, d, 'utf8'))
  await writeFile(path, JSON.stringify({ generatedBy: 'loop-e2e rdra-export', pending }, null, 2) + '\n')
}
