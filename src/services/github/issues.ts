import type { GithubClient } from './client.js'
import type { RepoRef } from './labels.js'
import { maskSecrets } from '../../util/mask.js'
import { logger } from '../../util/logger.js'

type IssueFinding = {
  title: string
  body: string
  fingerprint: string
}

function embedFingerprint(body: string, fingerprint: string): string {
  return `${body}\n\n<!-- fingerprint: ${fingerprint} -->`
}

/**
 * Creates a GitHub issue only if no existing open issue with the same fingerprint exists.
 * Fingerprint is embedded as an HTML comment in the issue body for deduplication.
 */
export async function upsertIssue(
  client: GithubClient,
  repo: RepoRef,
  finding: IssueFinding,
  autoDetectLabel: string,
  secrets: string[] = [],
): Promise<void> {
  const { owner, name } = repo

  try {
    const { data: existingIssues } = await client.issues.listForRepo({
      owner,
      repo: name,
      state: 'open',
      labels: autoDetectLabel,
    })

    const alreadyExists = existingIssues.some(
      (issue) => issue.body?.includes(`fingerprint: ${finding.fingerprint}`),
    )

    if (alreadyExists) {
      logger.debug({ fingerprint: finding.fingerprint }, 'Issue already exists, skipping')
      return
    }

    const safeBody = maskSecrets(
      embedFingerprint(finding.body, finding.fingerprint),
      secrets,
    )

    await client.issues.create({
      owner,
      repo: name,
      title: finding.title,
      body: safeBody,
      labels: [autoDetectLabel],
    })

    logger.info({ fingerprint: finding.fingerprint, title: finding.title }, 'GitHub issue created')
  } catch (error) {
    throw new Error(
      `Failed to upsert issue for ${owner}/${name}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
