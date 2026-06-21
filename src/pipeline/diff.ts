import type { SiteStructure, DiffFinding, DisplayItem, InputItem } from '../domain/types.js'
import type { Scenario } from '../scenario/schema.js'
import type { Llm } from '../services/llm/client.js'
import { diffJudge } from '../services/llm/diffJudge.js'

export type DetectDiffsDeps = {
  current: SiteStructure
  baseline: SiteStructure | null
  scenarios: Scenario[]
  llm: Llm
}

function transitionKey(t: { fromUrl: string; toUrl: string; trigger: string }): string {
  return `${t.fromUrl}→${t.toUrl}:${t.trigger}`
}

function displayItemKey(d: DisplayItem): string {
  return `${d.type}:${d.label}`
}

function inputItemKey(i: InputItem): string {
  return `${i.type}:${i.label}:${i.name ?? ''}`
}

function detectTransitionDiffs(current: SiteStructure, baseline: SiteStructure): DiffFinding[] {
  const baselineKeys = new Set(baseline.transitions.map(transitionKey))
  const currentKeys = new Set(current.transitions.map(transitionKey))
  const findings: DiffFinding[] = []

  for (const t of current.transitions) {
    const key = transitionKey(t)
    if (!baselineKeys.has(key)) {
      findings.push({
        kind: 'transition',
        severity: 'high',
        expected: '(not present in baseline)',
        actual: `${t.fromUrl} → ${t.toUrl} via ${t.trigger}`,
        location: t.fromUrl,
      })
    }
  }

  for (const t of baseline.transitions) {
    const key = transitionKey(t)
    if (!currentKeys.has(key)) {
      findings.push({
        kind: 'transition',
        severity: 'high',
        expected: `${t.fromUrl} → ${t.toUrl} via ${t.trigger}`,
        actual: '(removed from current)',
        location: t.fromUrl,
      })
    }
  }

  return findings
}

function detectPageItemDiffs(current: SiteStructure, baseline: SiteStructure): DiffFinding[] {
  const findings: DiffFinding[] = []
  const baselinePageMap = new Map(baseline.pages.map((p) => [p.url, p]))

  for (const page of current.pages) {
    const basePage = baselinePageMap.get(page.url)
    if (!basePage) continue

    const baseDisplayKeys = new Set(basePage.displayItems.map(displayItemKey))
    const currDisplayKeys = new Set(page.displayItems.map(displayItemKey))

    for (const item of page.displayItems) {
      if (!baseDisplayKeys.has(displayItemKey(item))) {
        findings.push({
          kind: 'displayItem',
          severity: 'medium',
          expected: '(not present in baseline)',
          actual: `${item.type}: ${item.label}`,
          location: page.url,
        })
      }
    }

    for (const item of basePage.displayItems) {
      if (!currDisplayKeys.has(displayItemKey(item))) {
        findings.push({
          kind: 'displayItem',
          severity: 'medium',
          expected: `${item.type}: ${item.label}`,
          actual: '(removed from current)',
          location: page.url,
        })
      }
    }

    const baseInputKeys = new Set(basePage.inputItems.map(inputItemKey))
    const currInputKeys = new Set(page.inputItems.map(inputItemKey))

    for (const item of page.inputItems) {
      if (!baseInputKeys.has(inputItemKey(item))) {
        findings.push({
          kind: 'inputItem',
          severity: 'medium',
          expected: '(not present in baseline)',
          actual: `${item.type}: ${item.label}`,
          location: page.url,
        })
      }
    }

    for (const item of basePage.inputItems) {
      if (!currInputKeys.has(inputItemKey(item))) {
        findings.push({
          kind: 'inputItem',
          severity: 'medium',
          expected: `${item.type}: ${item.label}`,
          actual: '(removed from current)',
          location: page.url,
        })
      }
    }
  }

  return findings
}

export async function detectDiffs(deps: DetectDiffsDeps): Promise<DiffFinding[]> {
  const { current, baseline, scenarios, llm } = deps
  const findings: DiffFinding[] = []

  if (baseline) {
    findings.push(...detectTransitionDiffs(current, baseline))
    findings.push(...detectPageItemDiffs(current, baseline))
  }

  const gapFindings = await diffJudge(llm, scenarios, current)
  findings.push(...gapFindings)

  return findings
}
