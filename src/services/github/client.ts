import { Octokit } from '@octokit/rest'

export type GithubClient = InstanceType<typeof Octokit>

export function createGithubClient(token: string): GithubClient {
  return new Octokit({ auth: token })
}
