import { describe, it, expect, vi } from 'vitest'
import type { GithubClient } from './client.js'
import type { RepoRef } from './labels.js'
import { upsertIssue } from './issues.js'

function makeMockClient(existingBodies: string[] = []): GithubClient {
  const existingIssues = existingBodies.map((body, i) => ({ number: i + 1, title: 'Issue', body }))
  return {
    issues: {
      listForRepo: vi.fn().mockResolvedValue({ data: existingIssues }),
      create: vi.fn().mockResolvedValue({ data: { number: 99, html_url: 'https://github.com/o/r/issues/99' } }),
    },
  } as unknown as GithubClient
}

const repo: RepoRef = { owner: 'acme', name: 'myapp' }

const finding = {
  title: 'Missing nav link',
  body: 'The navigation link was removed unexpectedly.',
  fingerprint: 'abc123def456',
}

describe('upsertIssue', () => {
  it('creates issue when no existing issue contains the fingerprint', async () => {
    const client = makeMockClient([])
    await upsertIssue(client, repo, finding, 'Auto-Detect')

    expect(client.issues.listForRepo).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'myapp',
      state: 'open',
      labels: 'Auto-Detect',
    })
    expect(client.issues.create).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'myapp',
        title: 'Missing nav link',
        labels: ['Auto-Detect'],
      }),
    )
    const callArg = (client.issues.create as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(callArg.body).toContain('abc123def456')
    expect(callArg.body).toContain('fingerprint:')
  })

  it('skips creation when existing issue already contains the fingerprint', async () => {
    const bodyWithFingerprint = `Some issue\n\n<!-- fingerprint: abc123def456 -->`
    const client = makeMockClient([bodyWithFingerprint])
    await upsertIssue(client, repo, finding, 'Auto-Detect')

    expect(client.issues.create).not.toHaveBeenCalled()
  })

  it('creates issue when existing issues have different fingerprints', async () => {
    const otherBody = `Another issue\n\n<!-- fingerprint: different999 -->`
    const client = makeMockClient([otherBody])
    await upsertIssue(client, repo, finding, 'Auto-Detect')

    expect(client.issues.create).toHaveBeenCalled()
  })
})
