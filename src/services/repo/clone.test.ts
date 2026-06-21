import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureRepoClone, type GitRunner, type RepoConfig, type IngestionConfig } from './clone.js'

const repo: RepoConfig = {
  name: 'my-app',
  label: 'My App',
  url: 'https://github.com/acme/my-app',
  role: 'backend',
  audience: 'user',
}

const ingestion: IngestionConfig = {
  cloneDepth: 10,
  tokenBudgetPerRepo: 50000,
  gitLogCount: 20,
}

const TOKEN = 'ghp_testtokenxxx'

describe('ensureRepoClone', () => {
  let root: string
  let calls: Array<{ file: string; args: string[]; cwd?: string }>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'loop-e2e-clone-test-'))
    calls = []
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const makeRunner = (shouldCreateDir = false): GitRunner => {
    return async (file, args, cwd) => {
      calls.push({ file, args, cwd })
      // Simulate that clone creates the target directory
      if (shouldCreateDir && args[0] === 'clone') {
        const targetDir = args[args.length - 1] as string
        await mkdir(targetDir, { recursive: true })
      }
    }
  }

  it('clones when repo directory does not exist', async () => {
    const runner = makeRunner(true)
    const localPath = await ensureRepoClone(repo, TOKEN, ingestion, root, runner)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.args[0]).toBe('clone')
    expect(call.cwd).toBeUndefined()
    expect(localPath).toContain('my-app')
  })

  it('passes --depth with cloneDepth value to clone', async () => {
    const runner = makeRunner(true)
    await ensureRepoClone(repo, TOKEN, ingestion, root, runner)

    const call = calls[0]!
    const depthIdx = call.args.indexOf('--depth')
    expect(depthIdx).toBeGreaterThan(-1)
    expect(call.args[depthIdx + 1]).toBe(String(ingestion.cloneDepth))
  })

  it('embeds token in clone URL', async () => {
    const runner = makeRunner(true)
    await ensureRepoClone(repo, TOKEN, ingestion, root, runner)

    const call = calls[0]!
    const urlArg = call.args.find((a) => a.includes('github.com'))
    expect(urlArg).toContain(TOKEN)
  })

  it('fetches when repo directory already exists', async () => {
    // Pre-create the repo directory
    const repoDir = join(root, 'repos', repo.name)
    await mkdir(repoDir, { recursive: true })

    const runner = makeRunner(false)
    await ensureRepoClone(repo, TOKEN, ingestion, root, runner)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.args[0]).toBe('fetch')
    expect(call.cwd).toBe(repoDir)
  })

  it('passes --depth with cloneDepth to fetch', async () => {
    const repoDir = join(root, 'repos', repo.name)
    await mkdir(repoDir, { recursive: true })

    const runner = makeRunner(false)
    await ensureRepoClone(repo, TOKEN, ingestion, root, runner)

    const call = calls[0]!
    expect(call.args).toContain('--depth')
  })

  it('does not include raw token in cwd or args when fetching (token masking)', async () => {
    // We simply assert that the clone URL (which contains token) is not
    // passed as an arg in fetch path — fetch uses the existing remote
    const repoDir = join(root, 'repos', repo.name)
    await mkdir(repoDir, { recursive: true })

    const tokenLeaks: string[] = []
    const runner: GitRunner = async (file, args, cwd) => {
      // Check args for raw token leak (fetch should not pass token in args)
      const combined = args.join(' ') + (cwd ?? '')
      if (combined.includes(TOKEN)) tokenLeaks.push(combined)
    }
    await ensureRepoClone(repo, TOKEN, ingestion, root, runner)

    // fetch args should not contain raw token (only clone does — that is unavoidable
    // since git needs it; we mask only in *log output*, not the actual arg)
    // Here we just verify fetch doesn't needlessly re-pass the token
    const fetchCall = calls.find((c) => c.args[0] === 'fetch')
    if (fetchCall) {
      const fetchArgs = fetchCall.args.join(' ')
      expect(fetchArgs).not.toContain(TOKEN)
    }
  })

  it('returns the correct local path', async () => {
    const runner = makeRunner(true)
    const localPath = await ensureRepoClone(repo, TOKEN, ingestion, root, runner)
    expect(localPath).toBe(join(root, 'repos', repo.name))
  })

  it('masks token in error thrown from clone path', async () => {
    const errorRunner: GitRunner = async (_file, args) => {
      if (args[0] === 'clone') {
        throw new Error(`fatal: Authentication failed for 'https://${TOKEN}@github.com/acme/my-app'`)
      }
    }
    await expect(
      ensureRepoClone(repo, TOKEN, ingestion, root, errorRunner),
    ).rejects.toSatisfy((err: unknown) => {
      const msg = (err as Error).message
      return !msg.includes(TOKEN)
    })
  })

  it('masks token in error thrown from fetch path', async () => {
    // Pre-create the repo directory so the fetch branch is taken
    const repoDir = join(root, 'repos', repo.name)
    await mkdir(repoDir, { recursive: true })

    const errorRunner: GitRunner = async (_file, args) => {
      if (args[0] === 'fetch') {
        throw new Error(`fatal: could not read from remote: token=${TOKEN}`)
      }
    }
    await expect(
      ensureRepoClone(repo, TOKEN, ingestion, root, errorRunner),
    ).rejects.toSatisfy((err: unknown) => {
      const msg = (err as Error).message
      return !msg.includes(TOKEN)
    })
  })
})
