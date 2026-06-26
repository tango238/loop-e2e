import { z } from 'zod'
import type { Llm } from './client.js'
import type { Feedback } from '../../domain/types.js'

/** Evidence from the original finding that the user is commenting on. */
export type FeedbackEvidence = {
  findingTitle: string
  findingDetail: string
  findingCategory: string
}

// `validityClass` (not `classification`): the word "classification" is reserved for the
// Adjudication domain (Verdict/RefuterVote = bug|unnecessary|uncertain). Feedback judgments live
// in the Learning context and are described under "validity" (valid + its sub-label).
const FeedbackVerifyResponseSchema = z.object({
  valid: z.boolean(),
  validityClass: z.string().min(1),
  rationale: z.string().min(1),
})

export type FeedbackVerifyResult = z.infer<typeof FeedbackVerifyResponseSchema>

/**
 * Uses the verification (Opus) LLM to judge whether user feedback is a valid
 * correction (a real false-positive / misclassification) or a misunderstanding.
 *
 * Returns:
 *   valid=true  → the finding should be suppressed / scenario updated
 *   valid=false → the finding stands; feedback is recorded but not applied
 */
export async function verifyFeedback(
  llm: Llm,
  feedback: Feedback,
  evidence: FeedbackEvidence,
): Promise<FeedbackVerifyResult> {
  const prompt = buildPrompt(feedback, evidence)
  return llm.complete('verification', prompt, FeedbackVerifyResponseSchema)
}

function buildPrompt(feedback: Feedback, evidence: FeedbackEvidence): string {
  const findingRef = feedback.targetFindingId
    ? `Finding ID: ${feedback.targetFindingId}`
    : 'No specific finding referenced'

  return `You are a senior QA engineer reviewing user feedback on an automated E2E test finding.

## Original Finding
${findingRef}
Category: ${evidence.findingCategory}
Title: ${evidence.findingTitle}
Detail: ${evidence.findingDetail}

## User Feedback
"${feedback.userComment}"

## Task
Determine whether the user feedback is:
1. A valid correction (the finding is a false positive or the user has identified a real issue with the finding)
2. A misunderstanding (the finding is correct and the user has misunderstood the finding)

Respond with a JSON object matching:
{
  "valid": boolean,          // true = valid correction, false = misunderstanding
  "validityClass": string,   // e.g. "false-positive", "misunderstanding", "general-correction", "out-of-scope"
  "rationale": string        // 1-3 sentences explaining your reasoning
}`
}
