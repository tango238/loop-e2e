import type { GithubClient } from './client.js'

export interface RepoRef {
  owner: string
  name: string
}

export interface LabelConfig {
  ready: string
  autoDetect: string
}

/**
 * Parses a GitHub repository URL into owner and name.
 * Accepts: https://github.com/{owner}/{name}[.git][/]
 */
export function parseRepoUrl(url: string): { owner: string; name: string } {
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
  if (!match) {
    throw new Error(`Invalid GitHub repository URL: ${url}`)
  }
  return { owner: match[1] as string, name: match[2] as string }
}

/**
 * Ensures the given labels exist on the repository.
 * Creates only the labels that are missing (idempotent).
 */
export async function ensureLabels(
  client: GithubClient,
  repo: RepoRef,
  labels: LabelConfig,
): Promise<void> {
  try {
    const { data: existing } = await client.issues.listLabelsForRepo({
      owner: repo.owner,
      repo: repo.name,
    })

    const existingNames = new Set(existing.map((l) => l.name))
    const desired = [labels.ready, labels.autoDetect]
    const missing = desired.filter((name) => !existingNames.has(name))

    for (const name of missing) {
      await client.issues.createLabel({
        owner: repo.owner,
        repo: repo.name,
        name,
      })
    }
  } catch (error) {
    throw new Error(
      `Failed to ensure labels for ${repo.owner}/${repo.name}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
