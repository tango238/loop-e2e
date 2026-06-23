import { join } from 'node:path'

export const STATE_DIR = '.loop-e2e'

export const statePaths = (root: string) => ({
  base: join(root, STATE_DIR),
  baseline: join(root, STATE_DIR, 'baseline'),
  runs: join(root, STATE_DIR, 'runs'),
  reports: join(root, STATE_DIR, 'reports'),
  feedback: join(root, STATE_DIR, 'feedback'),
  knownFindings: join(root, STATE_DIR, 'known-findings'),
  findings: join(root, STATE_DIR, 'findings'),
})
