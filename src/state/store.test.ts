import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  saveRunStructure,
  loadBaseline,
  saveBaseline,
  loadLatestReport,
  loadFeedback,
  saveFeedback,
  loadKnownFindings,
  saveKnownFinding,
} from './store.js'
import type { SiteStructure, Feedback } from '../domain/types.js'

const makeSiteStructure = (tag: string): SiteStructure => ({
  generatedAt: `2024-01-01T00:00:00.000Z`,
  pages: [
    {
      url: `https://example.com/${tag}`,
      title: `Page ${tag}`,
      description: `Description ${tag}`,
      meta: {},
      displayItems: [],
      inputItems: [],
      expectations: [],
      capabilities: [],
    },
  ],
  transitions: [],
})

describe('state/store', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'loop-e2e-test-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  describe('loadBaseline', () => {
    it('returns null when no baseline exists', async () => {
      const result = await loadBaseline(root)
      expect(result).toBeNull()
    })
  })

  describe('saveBaseline + loadBaseline round-trip', () => {
    it('saves and loads baseline correctly', async () => {
      const structure = makeSiteStructure('baseline')
      await saveBaseline(root, structure)
      const loaded = await loadBaseline(root)
      expect(loaded).toEqual(structure)
    })

    it('overwrites baseline on second save', async () => {
      const first = makeSiteStructure('first')
      const second = makeSiteStructure('second')
      await saveBaseline(root, first)
      await saveBaseline(root, second)
      const loaded = await loadBaseline(root)
      expect(loaded).toEqual(second)
    })
  })

  describe('saveRunStructure + loadLatestReport round-trip', () => {
    it('saves and loads run structure correctly', async () => {
      const structure = makeSiteStructure('run1')
      const runId = 'run-2024-01-01'
      await saveRunStructure(root, runId, structure)
      const loaded = await loadLatestReport(root)
      expect(loaded).toEqual(structure)
    })

    it('loads most recent run when multiple exist (lexicographic order)', async () => {
      const first = makeSiteStructure('run1')
      const second = makeSiteStructure('run2')
      await saveRunStructure(root, 'run-001', first)
      await saveRunStructure(root, 'run-002', second)
      const loaded = await loadLatestReport(root)
      expect(loaded).toEqual(second)
    })

    it('selects latest run by mtime, not filename order', async () => {
      const { statePaths } = await import('./paths.js')
      const paths = statePaths(root)

      // Write 'run-zzz' first (lexicographically last) then 'run-aaa' (lexicographically first)
      // but set mtime so 'run-aaa' is the most recently modified — it should win
      const older = makeSiteStructure('older')
      const newer = makeSiteStructure('newer')
      await saveRunStructure(root, 'run-zzz', older)
      await saveRunStructure(root, 'run-aaa', newer)

      // Backdate run-zzz to 1 hour ago so run-aaa is definitively newer by mtime
      const oneHourAgo = new Date(Date.now() - 3600_000)
      await utimes(join(paths.runs, 'run-zzz.yaml'), oneHourAgo, oneHourAgo)

      const loaded = await loadLatestReport(root)
      expect(loaded).toEqual(newer)
    })
  })

  describe('loadFeedback', () => {
    it('returns empty array when no feedback exists', async () => {
      const result = await loadFeedback(root)
      expect(result).toEqual([])
    })

    it('returns feedback items when feedback file exists', async () => {
      const { writeYaml } = await import('../util/fs.js')
      const { statePaths } = await import('./paths.js')
      const paths = statePaths(root)
      const feedback: Feedback[] = [
        {
          id: 'fb-1',
          targetFindingId: 'finding-1',
          userComment: 'This is a false positive',
          verdict: 'valid',
          appliedTo: [],
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ]
      await writeYaml(join(paths.feedback, 'feedback.yaml'), feedback)
      const result = await loadFeedback(root)
      expect(result).toEqual(feedback)
    })
  })

  describe('saveFeedback + loadFeedback round-trip', () => {
    it('saves a single feedback item and loads it back', async () => {
      const feedback: Feedback = {
        id: 'fb-1',
        targetFindingId: 'finding-abc',
        userComment: 'False positive — token present in meta tag',
        verdict: 'valid',
        appliedTo: ['scenario-1'],
        createdAt: '2024-01-01T00:00:00.000Z',
      }
      await saveFeedback(root, feedback)
      const loaded = await loadFeedback(root)
      expect(loaded).toHaveLength(1)
      expect(loaded[0]).toEqual(feedback)
    })

    it('appends multiple feedback items without losing prior ones', async () => {
      const fb1: Feedback = {
        id: 'fb-1',
        userComment: 'First feedback',
        appliedTo: [],
        createdAt: '2024-01-01T00:00:00.000Z',
      }
      const fb2: Feedback = {
        id: 'fb-2',
        targetFindingId: 'finding-xyz',
        userComment: 'Second feedback',
        verdict: 'invalid',
        appliedTo: [],
        createdAt: '2024-01-02T00:00:00.000Z',
      }
      await saveFeedback(root, fb1)
      await saveFeedback(root, fb2)
      const loaded = await loadFeedback(root)
      expect(loaded).toHaveLength(2)
      expect(loaded.find((f) => f.id === 'fb-1')).toEqual(fb1)
      expect(loaded.find((f) => f.id === 'fb-2')).toEqual(fb2)
    })

    it('uses a per-item file so feedback items can be added independently', async () => {
      const { statePaths: sp } = await import('./paths.js')
      const paths = sp(root)
      const { readdir } = await import('node:fs/promises')
      const fb: Feedback = {
        id: 'fb-unique',
        userComment: 'Test',
        appliedTo: [],
        createdAt: '2024-01-01T00:00:00.000Z',
      }
      await saveFeedback(root, fb)
      const files = await readdir(paths.feedback)
      expect(files.some((f) => f.includes('fb-unique'))).toBe(true)
    })
  })

  describe('saveKnownFinding + loadKnownFindings', () => {
    it('returns empty array when no known findings exist', async () => {
      const result = await loadKnownFindings(root)
      expect(result).toEqual([])
    })

    it('saves and loads a known finding by fingerprint', async () => {
      await saveKnownFinding(root, 'fp-abc123', { reason: 'acknowledged false positive', by: 'user' })
      const findings = await loadKnownFindings(root)
      expect(findings).toHaveLength(1)
      expect(findings[0]?.fingerprint).toBe('fp-abc123')
      expect(findings[0]?.reason).toBe('acknowledged false positive')
    })

    it('stores multiple known findings independently', async () => {
      await saveKnownFinding(root, 'fp-1', { reason: 'false positive', by: 'user' })
      await saveKnownFinding(root, 'fp-2', { reason: 'accepted risk', by: 'user' })
      const findings = await loadKnownFindings(root)
      expect(findings).toHaveLength(2)
    })

    it('overwriting the same fingerprint updates rather than duplicates', async () => {
      await saveKnownFinding(root, 'fp-dup', { reason: 'first', by: 'user' })
      await saveKnownFinding(root, 'fp-dup', { reason: 'updated', by: 'user' })
      const findings = await loadKnownFindings(root)
      const dup = findings.filter((f) => f.fingerprint === 'fp-dup')
      expect(dup).toHaveLength(1)
      expect(dup[0]?.reason).toBe('updated')
    })
  })
})
