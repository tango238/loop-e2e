import { describe, it, expect, vi } from 'vitest'
import { runDown } from './down.js'
import type { DownDeps } from './down.js'
import type { ProcessState } from '../../state/process.js'

describe('runDown (Task 3.2)', () => {
  const makeState = (): ProcessState => ({
    projectName: 'test-project',
    composeFiles: ['docker-compose.yml'],
    startedAt: '2024-01-01T00:00:00.000Z',
    readinessUrl: 'http://localhost:3000/health',
  })

  const makeSecrets = () => ({
    anthropicApiKey: 'sk-ant-test',
    githubToken: 'ghp_test',
    db: { DB_PASS: 'dbpassword' },
    targetAuth: { APP_PASS: 'apppassword' },
  })

  const makeDeps = (overrides?: Partial<DownDeps>): DownDeps => ({
    loadProcessState: vi.fn().mockResolvedValue(makeState()),
    composeDown: vi.fn().mockResolvedValue(undefined),
    clearProcessState: vi.fn().mockResolvedValue(undefined),
    secrets: makeSecrets(),
    ...overrides,
  })

  it('state present: calls composeDown with state and volumes, then clearProcessState', async () => {
    const deps = makeDeps()

    await runDown('/tmp/root', { volumes: true }, deps)

    expect(deps.composeDown).toHaveBeenCalledWith(
      makeState(),
      '/tmp/root',
      { volumes: true },
      undefined,
      expect.arrayContaining(['sk-ant-test', 'ghp_test', 'dbpassword', 'apppassword']),
    )
    expect(deps.clearProcessState).toHaveBeenCalledWith('/tmp/root')
  })

  it('state present: calls composeDown with volumes:false when not specified', async () => {
    const deps = makeDeps()

    await runDown('/tmp/root', {}, deps)

    expect(deps.composeDown).toHaveBeenCalledWith(
      makeState(),
      '/tmp/root',
      { volumes: false },
      undefined,
      expect.arrayContaining(['sk-ant-test']),
    )
  })

  it('state present: clearProcessState called after composeDown', async () => {
    const callOrder: string[] = []
    const deps = makeDeps({
      composeDown: vi.fn().mockImplementation(async () => { callOrder.push('composeDown') }),
      clearProcessState: vi.fn().mockImplementation(async () => { callOrder.push('clearProcessState') }),
    })

    await runDown('/tmp/root', {}, deps)

    expect(callOrder).toEqual(['composeDown', 'clearProcessState'])
  })

  it('state absent: composeDown and clearProcessState not called, no throw', async () => {
    const deps = makeDeps({
      loadProcessState: vi.fn().mockResolvedValue(null),
    })

    await expect(runDown('/tmp/root', {}, deps)).resolves.toBeUndefined()

    expect(deps.composeDown).not.toHaveBeenCalled()
    expect(deps.clearProcessState).not.toHaveBeenCalled()
  })

  it('state present: volumes flag false propagated correctly', async () => {
    const deps = makeDeps()

    await runDown('/tmp/root', { volumes: false }, deps)

    expect(deps.composeDown).toHaveBeenCalledWith(
      makeState(),
      '/tmp/root',
      { volumes: false },
      undefined,
      expect.any(Array),
    )
  })
})
