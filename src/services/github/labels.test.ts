import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ensureLabels, parseRepoUrl } from './labels.js'

describe('parseRepoUrl', () => {
  it('parses standard github url', () => {
    expect(parseRepoUrl('https://github.com/owner/repo')).toEqual({ owner: 'owner', name: 'repo' })
  })

  it('parses url with trailing slash', () => {
    expect(parseRepoUrl('https://github.com/owner/repo/')).toEqual({ owner: 'owner', name: 'repo' })
  })

  it('parses url with .git suffix', () => {
    expect(parseRepoUrl('https://github.com/owner/repo.git')).toEqual({ owner: 'owner', name: 'repo' })
  })

  it('throws for invalid url', () => {
    expect(() => parseRepoUrl('https://notgithub.com/owner/repo')).toThrow()
  })
})

describe('ensureLabels', () => {
  const mockClient = {
    issues: {
      listLabelsForRepo: vi.fn(),
      createLabel: vi.fn(),
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates both labels when none exist', async () => {
    mockClient.issues.listLabelsForRepo.mockResolvedValue({ data: [] })
    mockClient.issues.createLabel.mockResolvedValue({ data: {} })

    await ensureLabels(
      mockClient as any,
      { owner: 'myorg', name: 'myrepo' },
      { ready: 'loop-e2e:ready', autoDetect: 'loop-e2e:auto-detect' },
    )

    expect(mockClient.issues.createLabel).toHaveBeenCalledTimes(2)
    expect(mockClient.issues.createLabel).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'myorg', repo: 'myrepo', name: 'loop-e2e:ready' }),
    )
    expect(mockClient.issues.createLabel).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'myorg', repo: 'myrepo', name: 'loop-e2e:auto-detect' }),
    )
  })

  it('skips creating labels that already exist', async () => {
    mockClient.issues.listLabelsForRepo.mockResolvedValue({
      data: [{ name: 'loop-e2e:ready' }, { name: 'loop-e2e:auto-detect' }],
    })

    await ensureLabels(
      mockClient as any,
      { owner: 'myorg', name: 'myrepo' },
      { ready: 'loop-e2e:ready', autoDetect: 'loop-e2e:auto-detect' },
    )

    expect(mockClient.issues.createLabel).not.toHaveBeenCalled()
  })

  it('creates only the missing label when one already exists', async () => {
    mockClient.issues.listLabelsForRepo.mockResolvedValue({
      data: [{ name: 'loop-e2e:ready' }],
    })
    mockClient.issues.createLabel.mockResolvedValue({ data: {} })

    await ensureLabels(
      mockClient as any,
      { owner: 'myorg', name: 'myrepo' },
      { ready: 'loop-e2e:ready', autoDetect: 'loop-e2e:auto-detect' },
    )

    expect(mockClient.issues.createLabel).toHaveBeenCalledTimes(1)
    expect(mockClient.issues.createLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'loop-e2e:auto-detect' }),
    )
  })

  it('wraps Octokit errors with a clear message', async () => {
    mockClient.issues.listLabelsForRepo.mockRejectedValue(new Error('API rate limit exceeded'))

    await expect(
      ensureLabels(
        mockClient as any,
        { owner: 'myorg', name: 'myrepo' },
        { ready: 'loop-e2e:ready', autoDetect: 'loop-e2e:auto-detect' },
      ),
    ).rejects.toThrow('Failed to ensure labels for myorg/myrepo')
  })
})
