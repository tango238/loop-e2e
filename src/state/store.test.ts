import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  saveRunStructure,
  loadBaseline,
  saveBaseline,
  loadLatestReport,
  loadFeedback,
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

    it('returns null when baseline file is missing', async () => {
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

    it('loads most recent run when multiple exist', async () => {
      const first = makeSiteStructure('run1')
      const second = makeSiteStructure('run2')
      await saveRunStructure(root, 'run-001', first)
      // Small delay to ensure filesystem ordering
      await saveRunStructure(root, 'run-002', second)
      const loaded = await loadLatestReport(root)
      expect(loaded).toEqual(second)
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
          scenarioId: 'sc-1',
          status: 'pass',
          message: 'All good',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ]
      await writeYaml(join(paths.feedback, 'feedback.yaml'), feedback)
      const result = await loadFeedback(root)
      expect(result).toEqual(feedback)
    })
  })
})
