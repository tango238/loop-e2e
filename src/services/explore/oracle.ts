import { logger } from '../../util/logger.js'
import { QualityFindingsSchema } from './types.js'
import type { InputCase, CaseOutcome, GapVerdict, DiscoveredForm, QualityFinding } from './types.js'
import type { Llm } from '../llm/client.js'

function isSuspicious(outcome: CaseOutcome): boolean {
  const noErrors = outcome.errorsShown.length === 0
  const accepted = (outcome.submitStatus !== undefined && outcome.submitStatus >= 200 && outcome.submitStatus < 300) || outcome.navigatedAway
  return noErrors && accepted
}

/**
 * Classify a reject-expectation case as a validation gap.
 * Suspicion (no error + accepted) → confirm via DB probe when available:
 *   saved → high; probe disproves → not a gap; no probe → medium (UI signal only).
 */
export async function classifyGap(
  inputCase: InputCase,
  outcome: CaseOutcome,
  dbProbe?: () => Promise<boolean>,
): Promise<GapVerdict> {
  if (inputCase.expectation !== 'reject') return { gap: false, confidence: 'medium' }
  if (!isSuspicious(outcome)) return { gap: false, confidence: 'high' }
  if (dbProbe) {
    const saved = await dbProbe()
    return saved ? { gap: true, confidence: 'high' } : { gap: false, confidence: 'medium' }
  }
  return { gap: true, confidence: 'medium' }
}

/** Opus judges whether reject-case errors are bundled / unclear / unmapped to fields. */
export async function classifyErrorQuality(
  form: DiscoveredForm,
  outcomes: CaseOutcome[],
  llm: Llm,
): Promise<QualityFinding[]> {
  const errorSets = outcomes
    .map((o, i) => `case ${i + 1}: [${o.errorsShown.join(' | ') || '(no error shown)'}]`)
    .join('\n')
  const prompt =
    `You are a UX reviewer of form validation error messages on screen ${form.screenPath}. ` +
    `Below are the error messages shown across several deliberately-invalid submissions. ` +
    `Flag quality problems: multiple distinct field errors collapsed into one generic message; ` +
    `messages that do not say which field or what is wrong; vague or overly technical text. ` +
    `Only report genuine problems.\n\n${errorSets}`
  try {
    const out = await llm.complete('verification', prompt, QualityFindingsSchema)
    return out.findings.map((f) => ({ screenPath: form.screenPath, issue: f.issue, evidence: f.evidence, severity: f.severity }))
  } catch (err) {
    logger.warn({ err: String(err), screen: form.screenPath }, 'classifyErrorQuality failed')
    return []
  }
}
