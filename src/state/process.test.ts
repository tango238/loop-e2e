import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { saveProcessState, loadProcessState, clearProcessState } from './process.js'
import type { ProcessState } from './process.js'

const makeState = (): ProcessState => ({
  projectName: 'e2e',
  composeFiles: ['docker-compose.yml'],
  startedAt: new Date().toISOString(),
  readinessUrl: 'http://localhost:3000',
})

describe('processState', () => {
  it('save then load round-trips correctly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loop-e2e-test-'))
    const state = makeState()
    await saveProcessState(root, state)
    const loaded = await loadProcessState(root)
    expect(loaded).toEqual(state)
  })

  it('returns null when no state file exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loop-e2e-test-'))
    const loaded = await loadProcessState(root)
    expect(loaded).toBeNull()
  })

  it('returns null after clear', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loop-e2e-test-'))
    const state = makeState()
    await saveProcessState(root, state)
    await clearProcessState(root)
    const loaded = await loadProcessState(root)
    expect(loaded).toBeNull()
  })

  it('clear is a no-op when file does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'loop-e2e-test-'))
    await expect(clearProcessState(root)).resolves.toBeUndefined()
  })
})
