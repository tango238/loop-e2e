import type { DiffFinding, VerifyFinding } from '../../../domain/types.js'

export function refutePrompt(
  finding: DiffFinding | VerifyFinding,
  evidence: string,
  lens: 'correctness' | 'security' | 'intentionality',
): string {
  const findingDesc = 'kind' in finding
    ? `Kind: ${finding.kind}\nSeverity: ${finding.severity}\nExpected: ${finding.expected}\nActual: ${finding.actual}\nLocation: ${finding.location}`
    : `Category: ${finding.category}\nSeverity: ${finding.severity}\nTitle: ${finding.title}\nDetail: ${finding.detail}\nEvidence: ${finding.evidence}`

  const lensInstructions: Record<string, string> = {
    correctness: 'Argue from a correctness perspective: is this truly incorrect, or could it be expected behavior? Could this be a test environment artifact?',
    security: 'Argue from a security perspective: is this a real security risk, or a false alarm? Could this be intentional security hardening?',
    intentionality: 'Argue from an intentionality perspective: is this change intentional? Could a developer have deliberately made this change?',
  }

  return `You are a devil's advocate reviewer. Your job is to ARGUE that the following finding is NOT a real bug or IS intentional.

## Finding
${findingDesc}

## Evidence
${evidence || '(none provided)'}

## Your Lens: ${lens}
${lensInstructions[lens]}

Respond with a JSON object:
{
  "lens": "${lens}",
  "refuted": <true if you successfully argued this is NOT a bug / IS intentional, false if you could not refute it>,
  "classification": <"bug" | "unnecessary" | "uncertain">,
  "confidence": <0.0-1.0, how confident you are in your assessment>,
  "rationale": "<one paragraph explaining your reasoning>"
}

Be honest: if the evidence clearly shows a real bug, set refuted:false and classification:"bug".`
}
