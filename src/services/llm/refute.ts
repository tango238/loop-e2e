import { z } from 'zod'
import type { Llm } from './client.js'
import type { DiffFinding, VerifyFinding, RefuterVote, FindingVerdict } from '../../domain/types.js'
import type { Config } from '../../config/schema.js'
import { refutePrompt } from './prompts/refute.js'

const RefuterVoteSchema = z.object({
  lens: z.enum(['correctness', 'security', 'intentionality']),
  refuted: z.boolean(),
  classification: z.enum(['bug', 'unnecessary', 'uncertain']),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
})

export async function refuteOnce(
  llm: Llm,
  finding: DiffFinding | VerifyFinding,
  evidence: string,
  lens: 'correctness' | 'security' | 'intentionality',
): Promise<RefuterVote> {
  const prompt = refutePrompt(finding, evidence, lens)
  return llm.complete('verification', prompt, RefuterVoteSchema)
}

function mean(nums: number[]): number {
  if (nums.length === 0) return 0
  return nums.reduce((sum, n) => sum + n, 0) / nums.length
}

function majorityClass(votes: RefuterVote[]): 'bug' | 'unnecessary' | 'uncertain' {
  const counts: Record<string, number> = {}
  for (const v of votes) {
    counts[v.classification] = (counts[v.classification] ?? 0) + 1
  }
  let best: 'bug' | 'unnecessary' | 'uncertain' = 'uncertain'
  let bestCount = 0
  for (const [cls, count] of Object.entries(counts)) {
    if (count > bestCount) {
      bestCount = count
      best = cls as 'bug' | 'unnecessary' | 'uncertain'
    }
  }
  return best
}

export async function adjudicate(
  llm: Llm,
  finding: DiffFinding | VerifyFinding,
  evidence: string,
  refutation: Config['refutation'],
): Promise<FindingVerdict> {
  const { panelSize, lenses } = refutation

  // Expand lenses to fill panelSize by cycling
  const assignedLenses: ('correctness' | 'security' | 'intentionality')[] = Array.from(
    { length: panelSize },
    (_, i) => lenses[i % lenses.length] as 'correctness' | 'security' | 'intentionality',
  )

  const votes: RefuterVote[] = await Promise.all(
    assignedLenses.map((lens) => refuteOnce(llm, finding, evidence, lens)),
  )

  const confirmedVotes = votes.filter((v) => !v.refuted)
  const confirmedCount = confirmedVotes.length
  const majority = confirmedCount >= Math.ceil(panelSize / 2)

  if (majority) {
    const classification = majorityClass(confirmedVotes)
    const relevantVotes = confirmedVotes.filter((v) => v.classification === classification)
    const confidence = mean(relevantVotes.map((v) => v.confidence))
    const rationale = confirmedVotes.map((v) => v.rationale).join(' | ')

    return {
      classification,
      confidence,
      confirmedCount,
      panelSize,
      votes,
      rationale,
    }
  }

  return {
    classification: 'uncertain',
    confidence: mean(votes.map((v) => v.confidence)),
    confirmedCount,
    panelSize,
    votes,
    rationale: votes.map((v) => v.rationale).join(' | '),
  }
}
