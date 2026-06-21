import { logger } from '../../util/logger.js'
import { maskSecrets } from '../../util/mask.js'
import type { GithubClient } from './client.js'
import type { RepoRef } from './labels.js'

type FindingInput = {
  title: string
  body: string
  fingerprint: string
}

/**
 * Creates a GitHub issue for the given finding if no open issue already contains
 * the fingerprint (idempotent). Appends an HTML comment with the fingerprint so
 * future runs can detect duplicates. The autoDetectLabel is applied to all issues.
 *
 * @param secrets - optional list of secret strings to mask in the issue body
 */
export async function upsertIssue(
  client: GithubClient,
  repo: RepoRef,
  finding: FindingInput,
  autoDetectLabel: string,
  secrets: string[] = [],
): Promise<void> {
  try {
    // Search open issues with the auto-detect label
    const { data: existing } = await client.issues.listForRepo({
      owner: repo.owner,
      repo: repo.name,
      state: 'open',
      labels: autoDetectLabel,
    })

    // Check if any open issue already embeds this fingerprint
    const alreadyFiled = existing.some(
      (issue) => typeof issue.body === 'string' && issue.body.includes(`fingerprint: ${finding.fingerprint}`),
    )

    if (alreadyFiled) {
      logger.debug({ fingerprint: finding.fingerprint }, 'Issue already exists — skipping creation')
      return
    }

    // Mask secrets from both title and body before publishing
    const maskedTitle = maskSecrets(finding.title, secrets)
    const maskedBody = maskSecrets(finding.body, secrets)
    const bodyWithFingerprint = `${maskedBody}\n\n<!-- fingerprint: ${finding.fingerprint} -->`

    await client.issues.create({
      owner: repo.owner,
      repo: repo.name,
      title: maskedTitle,
      body: bodyWithFingerprint,
      labels: [autoDetectLabel],
    })

    logger.info({ fingerprint: finding.fingerprint, title: finding.title }, 'GitHub issue created')
  } catch (error) {
    throw new Error(
      `Failed to upsert issue "${finding.title}" in ${repo.owner}/${repo.name}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
