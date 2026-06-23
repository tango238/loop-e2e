import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  writeFindings,
  readPendingFindings,
  appendActivity,
  readPendingActivity,
  archiveConsumed,
  type FindingsEntry,
} from './findings.js'
import { statePaths } from './paths.js'
import type { VerifyFinding } from '../domain/types.js'

const vf = (title: string): VerifyFinding => ({ category: 'security', severity: 'medium', title, detail: 'd', evidence: 'e' })

const entry = (source: 'run' | 'explore', runId: string, titles: string[]): FindingsEntry => ({
  source, runId, startedAt: '2026-06-23T00:00:00.000Z',
  diffFindings: [], verifyFindings: titles.map(vf),
})

describe('findings store', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'loop-e2e-findings-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('round-trips findings entries (write → readPending)', async () => {
    await writeFindings(root, entry('run', 'r1', ['a', 'b']))
    await writeFindings(root, entry('explore', 'e1', ['c']))
    const pending = await readPendingFindings(root)
    expect(pending.map((p) => p.source).sort()).toEqual(['explore', 'run'])
    expect(pending.flatMap((p) => p.verifyFindings).length).toBe(3)
  })

  it('returns [] when the findings dir does not exist', async () => {
    expect(await readPendingFindings(root)).toEqual([])
    expect(await readPendingActivity(root)).toEqual([])
  })

  it('skips unreadable/invalid entry files', async () => {
    await writeFindings(root, entry('run', 'r1', ['a']))
    await writeFile(join(statePaths(root).findings, 'broken-x.json'), '{not json', 'utf8')
    await writeFile(join(statePaths(root).findings, 'missing-y.json'), '{"source":"run"}', 'utf8')
    const pending = await readPendingFindings(root)
    expect(pending.length).toBe(1)
  })

  it('appends and reads activity records, skipping malformed lines', async () => {
    await appendActivity(root, { source: 'grow', runId: 'g1', startedAt: 't', summary: 'proposed 36 scenarios' })
    await appendActivity(root, { source: 'scenario', runId: 's1', startedAt: 't', summary: 'generated 4 scenarios' })
    await writeFile(join(statePaths(root).findings, 'activity.jsonl'),
      (await readPendingActivityRaw(root)) + 'not-json\n', 'utf8')
    const acts = await readPendingActivity(root)
    expect(acts.map((a) => a.source)).toEqual(['grow', 'scenario'])
  })

  it('archives consumed findings + activity so the next readPending is empty', async () => {
    await writeFindings(root, entry('run', 'r1', ['a']))
    await appendActivity(root, { source: 'run', runId: 'r1', startedAt: 't', summary: 'ran' })
    await archiveConsumed(root, 'report-1')
    expect(await readPendingFindings(root)).toEqual([])
    expect(await readPendingActivity(root)).toEqual([])
    const archived = await readdir(join(statePaths(root).findings, 'archive', 'report-1'))
    expect(archived).toContain('activity.jsonl')
    expect(archived.some((f) => f.endsWith('.json'))).toBe(true)
  })

  it('archiveConsumed is a no-op when nothing is pending', async () => {
    await archiveConsumed(root, 'report-empty') // must not throw
    expect(await readPendingFindings(root)).toEqual([])
  })

  it('gives each entry a unique filename so same-runId writes do not clobber', async () => {
    await writeFindings(root, entry('run', 'same', ['a']))
    await writeFindings(root, entry('run', 'same', ['b'])) // same source + runId
    const pending = await readPendingFindings(root)
    expect(pending.length).toBe(2)
    expect(new Set(pending.map((p) => p.file)).size).toBe(2)
  })

  it('archives only the consumed files; a file written during reporting stays pending', async () => {
    await writeFindings(root, entry('run', 'r1', ['a']))
    const consumed = (await readPendingFindings(root)).map((p) => p.file)
    // a new entry arrives after the read (simulating a concurrent producer)
    await writeFindings(root, entry('explore', 'e1', ['b']))
    await archiveConsumed(root, 'report-1', consumed)
    const stillPending = await readPendingFindings(root)
    expect(stillPending.map((p) => p.source)).toEqual(['explore'])
  })
})

// Helper to read the raw activity file content for the malformed-line test.
async function readPendingActivityRaw(root: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(join(statePaths(root).findings, 'activity.jsonl'), 'utf8')
}
