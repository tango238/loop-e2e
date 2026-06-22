# 探索的入力検証 `explore` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `loop-e2e explore` command that drives each form with deliberately invalid/boundary inputs, detects validation gaps (bad value accepted/saved) and poor error-message quality, and files findings through the existing report + refutation-gate + GitHub-issue pipeline.

**Architecture:** A new `src/services/explore/*` layer (pure, all I/O injected) provides: DB introspection, LLM constraint modeling (Opus), deterministic + optional-LLM case generation, browser case execution, and oracle classification (gap via UI/network signal → DB confirmation; message quality via Opus). `src/pipeline/explore.ts` orchestrates discover → model → generate → execute → classify → findings → `writeReport` → re-seed, mirroring `src/cli/commands/run.ts`'s injectable-deps structure. `src/cli/commands/explore.ts` + `src/cli/index.ts` wire real dependencies.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Node 20+, pnpm, vitest, zod, Playwright (via existing `PageLike`), Anthropic SDK (via existing role-based `Llm`).

## Global Constraints

- TypeScript strict + ESM. Every intra-repo import path ends in `.js` (NodeNext resolution).
- Immutability: never mutate inputs; build new objects/arrays.
- All external I/O (browser, DB, LLM, shell/seed) injected via a deps object; unit tests use fakes/mocks — no real network/DB/browser.
- Secrets (credentials, 2FA PIN, DB values) masked from every detail/log/report via `maskSecrets(text, secrets[])` from `../util/mask.js`.
- LLM roles: constraint modeling, table inference, and message-quality judgment use role `'verification'` (Opus). Never invent new roles. Signature: `llm.complete(role, prompt)` or `llm.complete(role, prompt, zodSchema)` → validated `T`.
- DB access via `DbAdapter.query(sql: string, params: unknown[]): Promise<Row[]>` (`Row = Record<string, unknown>`). Postgres placeholders are `$1,$2,…`; MySQL placeholders are `?`. Thread `dbType: 'postgres' | 'mysql'` to every query builder.
- New finding category string is exactly `'input-validation'`.
- Must not break the existing suite (450 pass + 4 skip). Real-machine E2E gated behind `RUN_E2E=1` (skipped by default).
- Test runner: `pnpm vitest run <path>`. Build check: `pnpm build`. Lint: `pnpm lint`.

---

### Task 1: Types + `VerifyFinding` category

**Files:**
- Create: `src/services/explore/types.ts`
- Modify: `src/domain/types.ts:132-138` (extend `VerifyFinding.category`)
- Test: `src/services/explore/types.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by all later tasks):
  - `FormField = { name: string; selector: string; htmlType: string; label?: string }`
  - `DiscoveredForm = { screenPath: string; submitSelector: string; fields: FormField[] }`
  - `ColumnDef = { name: string; dataType: string; nullable: boolean; maxLength?: number; numericPrecision?: number }`
  - `ConstraintType = 'string'|'number'|'integer'|'boolean'|'date'|'email'|'url'|'enum'|'unknown'`
  - `FieldConstraint = { field: string; selector: string; required: boolean; type: ConstraintType; maxLength?: number; minLength?: number; min?: number; max?: number; format?: string; enumValues?: string[]; table?: string; column?: string; evidence: string }`
  - `InputCase = { field: string; selector: string; value: string; expectation: 'reject'|'accept'; rationale: string; table?: string; column?: string }`
  - `Baseline = Record<string, string>` (selector → valid value)
  - `CaseOutcome = { errorsShown: string[]; submitStatus?: number; navigatedAway: boolean; finalUrl: string }`
  - `GapVerdict = { gap: boolean; confidence: 'high'|'medium' }`
  - `QualityFinding = { screenPath: string; issue: string; evidence: string; severity: 'medium'|'low' }`
  - Zod: `FieldConstraintSchema`, `FieldConstraintsSchema` (`{ constraints: FieldConstraint[] }`), `CandidateTablesSchema` (`{ tables: string[] }`), `LlmCasesSchema` (`{ cases: {field;selector;value;rationale}[] }`), `QualityFindingsSchema` (`{ findings: {issue;evidence;severity}[] }`).

- [ ] **Step 1: Write the failing test**

Create `src/services/explore/types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  FieldConstraintSchema,
  FieldConstraintsSchema,
  CandidateTablesSchema,
  LlmCasesSchema,
  QualityFindingsSchema,
} from './types.js'

describe('explore types schemas', () => {
  it('accepts a minimal FieldConstraint', () => {
    const c = FieldConstraintSchema.parse({
      field: 'email',
      selector: '[name="email"]',
      required: true,
      type: 'email',
      evidence: 'DB column users.email NOT NULL',
    })
    expect(c.required).toBe(true)
    expect(c.type).toBe('email')
  })

  it('rejects an unknown constraint type', () => {
    expect(() =>
      FieldConstraintSchema.parse({
        field: 'x',
        selector: '#x',
        required: false,
        type: 'banana',
        evidence: '',
      }),
    ).toThrow()
  })

  it('wraps constraints/tables/cases/findings', () => {
    expect(FieldConstraintsSchema.parse({ constraints: [] }).constraints).toEqual([])
    expect(CandidateTablesSchema.parse({ tables: ['users'] }).tables).toEqual(['users'])
    expect(
      LlmCasesSchema.parse({ cases: [{ field: 'a', selector: '#a', value: ' x ', rationale: 'space' }] })
        .cases.length,
    ).toBe(1)
    expect(
      QualityFindingsSchema.parse({ findings: [{ issue: 'bundled', evidence: 'one box', severity: 'medium' }] })
        .findings[0].severity,
    ).toBe('medium')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/services/explore/types.test.ts`
Expected: FAIL — cannot resolve `./types.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/explore/types.ts`:

```typescript
import { z } from 'zod'

// --- discovery ---
export type FormField = { name: string; selector: string; htmlType: string; label?: string }
export type DiscoveredForm = { screenPath: string; submitSelector: string; fields: FormField[] }

// --- db introspection ---
export type ColumnDef = {
  name: string
  dataType: string
  nullable: boolean
  maxLength?: number
  numericPrecision?: number
}

// --- constraint model ---
export type ConstraintType =
  | 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'email' | 'url' | 'enum' | 'unknown'

export const FieldConstraintSchema = z.object({
  field: z.string(),
  selector: z.string(),
  required: z.boolean(),
  type: z.enum(['string', 'number', 'integer', 'boolean', 'date', 'email', 'url', 'enum', 'unknown']),
  maxLength: z.number().int().optional(),
  minLength: z.number().int().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  format: z.string().optional(),
  enumValues: z.array(z.string()).optional(),
  table: z.string().optional(),
  column: z.string().optional(),
  evidence: z.string(),
})
export type FieldConstraint = z.infer<typeof FieldConstraintSchema>

export const FieldConstraintsSchema = z.object({ constraints: z.array(FieldConstraintSchema) })
export const CandidateTablesSchema = z.object({ tables: z.array(z.string()) })

// --- case generation ---
export type InputCase = {
  field: string
  selector: string
  value: string
  expectation: 'reject' | 'accept'
  rationale: string
  table?: string
  column?: string
}
export type Baseline = Record<string, string>

export const LlmCasesSchema = z.object({
  cases: z.array(
    z.object({ field: z.string(), selector: z.string(), value: z.string(), rationale: z.string() }),
  ),
})

// --- execution / oracle ---
export type CaseOutcome = {
  errorsShown: string[]
  submitStatus?: number
  navigatedAway: boolean
  finalUrl: string
}
export type GapVerdict = { gap: boolean; confidence: 'high' | 'medium' }
export type QualityFinding = { screenPath: string; issue: string; evidence: string; severity: 'medium' | 'low' }

export const QualityFindingsSchema = z.object({
  findings: z.array(
    z.object({ issue: z.string(), evidence: z.string(), severity: z.enum(['medium', 'low']) }),
  ),
})
```

- [ ] **Step 4: Extend `VerifyFinding.category`**

In `src/domain/types.ts`, change the `category` union (line ~133) to add `'input-validation'`:

```typescript
export type VerifyFinding = {
  category: 'layout' | 'security' | 'conditional' | 'registered-data' | 'error-handling' | 'login' | 'scenario' | 'input-validation'
  severity: 'high' | 'medium' | 'low'
  title: string
  detail: string
  evidence: string
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm vitest run src/services/explore/types.test.ts && pnpm build`
Expected: test PASS, build PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/explore/types.ts src/services/explore/types.test.ts src/domain/types.ts
git commit -m "feat(explore): add explore domain types + input-validation finding category"
```

---

### Task 2: DB introspection (`dbIntrospect`)

**Files:**
- Create: `src/services/explore/dbIntrospect.ts`
- Test: `src/services/explore/dbIntrospect.test.ts`

**Interfaces:**
- Consumes: `ColumnDef` (Task 1); `DbAdapter` from `../db/adapter.js`.
- Produces: `introspectTable(db: DbAdapter, dbType: 'postgres'|'mysql', table: string): Promise<ColumnDef[]>` — queries `information_schema.columns`, maps rows (case-insensitive keys) to `ColumnDef[]`. Returns `[]` on query error (logged), never throws.

- [ ] **Step 1: Write the failing test**

Create `src/services/explore/dbIntrospect.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { introspectTable } from './dbIntrospect.js'
import type { DbAdapter } from '../db/adapter.js'

function fakeDb(rows: Record<string, unknown>[]): DbAdapter & { calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    async query(sql: string, params: unknown[]) {
      calls.push([sql, params])
      return rows
    },
    async close() {},
  }
}

describe('introspectTable', () => {
  it('maps information_schema rows to ColumnDef (postgres, $1 placeholder)', async () => {
    const db = fakeDb([
      { column_name: 'email', data_type: 'varchar', is_nullable: 'NO', character_maximum_length: 255, numeric_precision: null },
      { column_name: 'age', data_type: 'integer', is_nullable: 'YES', character_maximum_length: null, numeric_precision: 32 },
    ])
    const cols = await introspectTable(db, 'postgres', 'users')
    expect(db.calls[0][0]).toContain('$1')
    expect(db.calls[0][1]).toEqual(['users'])
    expect(cols).toEqual([
      { name: 'email', dataType: 'varchar', nullable: false, maxLength: 255 },
      { name: 'age', dataType: 'integer', nullable: true, numericPrecision: 32 },
    ])
  })

  it('uses ? placeholder for mysql and reads UPPERCASE keys', async () => {
    const db = fakeDb([
      { COLUMN_NAME: 'name', DATA_TYPE: 'varchar', IS_NULLABLE: 'NO', CHARACTER_MAXIMUM_LENGTH: 100, NUMERIC_PRECISION: null },
    ])
    const cols = await introspectTable(db, 'mysql', 'hotels')
    expect(db.calls[0][0]).toContain('?')
    expect(cols[0]).toEqual({ name: 'name', dataType: 'varchar', nullable: false, maxLength: 100 })
  })

  it('returns [] and does not throw when the query fails', async () => {
    const db: DbAdapter = {
      async query() { throw new Error('boom') },
      async close() {},
    }
    expect(await introspectTable(db, 'postgres', 'x')).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/services/explore/dbIntrospect.test.ts`
Expected: FAIL — cannot resolve `./dbIntrospect.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/explore/dbIntrospect.ts`:

```typescript
import { logger } from '../../util/logger.js'
import type { DbAdapter } from '../db/adapter.js'
import type { ColumnDef } from './types.js'

/** Case-insensitive lookup over a DB row (information_schema casing differs by driver). */
function pick(row: Record<string, unknown>, key: string): unknown {
  if (key in row) return row[key]
  const lower = key.toLowerCase()
  for (const k of Object.keys(row)) {
    if (k.toLowerCase() === lower) return row[k]
  }
  return undefined
}

function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Read column definitions for `table` from information_schema.columns.
 * Postgres uses `$1`; MySQL uses `?`. Never throws — returns [] on error.
 */
export async function introspectTable(
  db: DbAdapter,
  dbType: 'postgres' | 'mysql',
  table: string,
): Promise<ColumnDef[]> {
  const placeholder = dbType === 'postgres' ? '$1' : '?'
  const sql =
    `SELECT column_name, data_type, is_nullable, character_maximum_length, numeric_precision ` +
    `FROM information_schema.columns WHERE table_name = ${placeholder}`
  try {
    const rows = await db.query(sql, [table])
    return rows.map((row) => {
      const maxLength = toNumber(pick(row, 'character_maximum_length'))
      const numericPrecision = toNumber(pick(row, 'numeric_precision'))
      const col: ColumnDef = {
        name: String(pick(row, 'column_name') ?? ''),
        dataType: String(pick(row, 'data_type') ?? ''),
        nullable: String(pick(row, 'is_nullable') ?? '').toUpperCase() === 'YES',
      }
      if (maxLength !== undefined) col.maxLength = maxLength
      if (numericPrecision !== undefined) col.numericPrecision = numericPrecision
      return col
    })
  } catch (err) {
    logger.warn({ err: String(err), table }, 'introspectTable: query failed — returning []')
    return []
  }
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm vitest run src/services/explore/dbIntrospect.test.ts && pnpm build`
Expected: PASS + build PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/explore/dbIntrospect.ts src/services/explore/dbIntrospect.test.ts
git commit -m "feat(explore): introspectTable reads column defs from information_schema"
```

---

### Task 3: Constraint modeling (`constraintModel`, Opus)

**Files:**
- Create: `src/services/explore/constraintModel.ts`
- Test: `src/services/explore/constraintModel.test.ts`

**Interfaces:**
- Consumes: `DiscoveredForm`, `ColumnDef`, `FieldConstraint`, `FieldConstraintsSchema`, `CandidateTablesSchema` (Task 1); `Llm` from `../llm/client.js`.
- Produces:
  - `inferCandidateTables(form: DiscoveredForm, llm: Llm): Promise<string[]>` — Opus guesses DB table names from the screen path + field names.
  - `modelConstraints(form: DiscoveredForm, columns: ColumnDef[], sourceRules: string, llm: Llm): Promise<FieldConstraint[]>` — Opus fuses HTML fields + DB columns + source validation text into per-field constraints; reconciled so every returned constraint's `selector` is a real form-field selector (constraints that can't be reconciled are dropped). Returns `[]` on LLM error (logged), never throws.

- [ ] **Step 1: Write the failing test**

Create `src/services/explore/constraintModel.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { modelConstraints, inferCandidateTables } from './constraintModel.js'
import type { Llm } from '../llm/client.js'
import type { DiscoveredForm } from './types.js'

const form: DiscoveredForm = {
  screenPath: '/user/create',
  submitSelector: 'button[type="submit"]',
  fields: [
    { name: 'email', selector: '[name="email"]', htmlType: 'email' },
    { name: 'age', selector: '[name="age"]', htmlType: 'number' },
  ],
}

function llmReturning(obj: unknown): Llm {
  return {
    // @ts-expect-error overload narrowing in fake
    complete: async (_role: string, _prompt: string, _schema?: unknown) => obj,
  }
}

describe('modelConstraints', () => {
  it('returns constraints whose selectors are reconciled to form fields', async () => {
    const llm = llmReturning({
      constraints: [
        { field: 'email', selector: '[name="email"]', required: true, type: 'email', maxLength: 255, table: 'users', column: 'email', evidence: 'NOT NULL' },
        { field: 'age', selector: 'WRONG', required: false, type: 'integer', min: 0, max: 150, evidence: 'unsigned' },
        { field: 'ghost', selector: '#ghost', required: true, type: 'string', evidence: 'hallucinated' },
      ],
    })
    const out = await modelConstraints(form, [], 'rules text', llm)
    expect(out.map((c) => c.field).sort()).toEqual(['age', 'email'])
    // age selector reconciled from form field name
    expect(out.find((c) => c.field === 'age')?.selector).toBe('[name="age"]')
    // ghost dropped (no matching form field)
    expect(out.find((c) => c.field === 'ghost')).toBeUndefined()
  })

  it('returns [] on LLM error', async () => {
    const llm: Llm = {
      // @ts-expect-error fake
      complete: async () => { throw new Error('llm down') },
    }
    expect(await modelConstraints(form, [], '', llm)).toEqual([])
  })
})

describe('inferCandidateTables', () => {
  it('returns the table list from the model', async () => {
    const llm = llmReturning({ tables: ['users', 'profiles'] })
    expect(await inferCandidateTables(form, llm)).toEqual(['users', 'profiles'])
  })

  it('returns [] on LLM error', async () => {
    const llm: Llm = {
      // @ts-expect-error fake
      complete: async () => { throw new Error('x') },
    }
    expect(await inferCandidateTables(form, llm)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/services/explore/constraintModel.test.ts`
Expected: FAIL — cannot resolve `./constraintModel.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/explore/constraintModel.ts`:

```typescript
import { logger } from '../../util/logger.js'
import { CandidateTablesSchema, FieldConstraintsSchema } from './types.js'
import type { DiscoveredForm, ColumnDef, FieldConstraint } from './types.js'
import type { Llm } from '../llm/client.js'

function fieldList(form: DiscoveredForm): string {
  return form.fields
    .map((f) => `- field="${f.name}" selector="${f.selector}" htmlType="${f.htmlType}"${f.label ? ` label="${f.label}"` : ''}`)
    .join('\n')
}

/** Opus guesses candidate DB table names for a form from its path + fields. Never throws. */
export async function inferCandidateTables(form: DiscoveredForm, llm: Llm): Promise<string[]> {
  const prompt =
    `You are mapping a web form to database tables. Given the screen path and form fields, ` +
    `list the most likely database table name(s) that this form writes to (snake_case, plural where typical). ` +
    `Return at most 3.\n\nScreen: ${form.screenPath}\nFields:\n${fieldList(form)}`
  try {
    const out = await llm.complete('verification', prompt, CandidateTablesSchema)
    return out.tables
  } catch (err) {
    logger.warn({ err: String(err), screen: form.screenPath }, 'inferCandidateTables failed')
    return []
  }
}

function columnList(columns: ColumnDef[]): string {
  if (columns.length === 0) return '(no DB columns available)'
  return columns
    .map((c) => `- ${c.name} ${c.dataType} ${c.nullable ? 'NULL' : 'NOT NULL'}${c.maxLength ? ` maxlen=${c.maxLength}` : ''}`)
    .join('\n')
}

/**
 * Fuse HTML fields + DB columns + source validation rules into per-field constraints (Opus).
 * Reconciles each constraint's selector to a real form field (by selector, else by field name);
 * drops constraints that match no form field. Never throws — returns [] on error.
 */
export async function modelConstraints(
  form: DiscoveredForm,
  columns: ColumnDef[],
  sourceRules: string,
  llm: Llm,
): Promise<FieldConstraint[]> {
  const prompt =
    `You are deriving input-validation constraints for a web form. Names may differ across ` +
    `the HTML field, the DB column, and the source validation rule — reconcile them.\n\n` +
    `Screen: ${form.screenPath}\n\nHTML fields:\n${fieldList(form)}\n\n` +
    `DB columns:\n${columnList(columns)}\n\nSource validation rules:\n${sourceRules || '(none)'}\n\n` +
    `For each HTML field, output a constraint: required, type (string|number|integer|boolean|date|email|url|enum|unknown), ` +
    `maxLength/minLength/min/max/format/enumValues when known, the backing table/column when identifiable, ` +
    `and an "evidence" string citing the DB column or rule (never include secret values). ` +
    `Use the EXACT selector from the HTML fields list.`
  let parsed
  try {
    parsed = await llm.complete('verification', prompt, FieldConstraintsSchema)
  } catch (err) {
    logger.warn({ err: String(err), screen: form.screenPath }, 'modelConstraints failed')
    return []
  }

  const bySelector = new Map(form.fields.map((f) => [f.selector, f]))
  const byName = new Map(form.fields.map((f) => [f.name, f]))
  const reconciled: FieldConstraint[] = []
  for (const c of parsed.constraints) {
    const match = bySelector.get(c.selector) ?? byName.get(c.field)
    if (!match) continue // drop hallucinated fields
    reconciled.push({ ...c, selector: match.selector, field: match.name })
  }
  return reconciled
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm vitest run src/services/explore/constraintModel.test.ts && pnpm build`
Expected: PASS + build PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/explore/constraintModel.ts src/services/explore/constraintModel.test.ts
git commit -m "feat(explore): Opus constraint modeling + table inference with selector reconciliation"
```

---

### Task 4: Case generation (`caseGen`)

**Files:**
- Create: `src/services/explore/caseGen.ts`
- Test: `src/services/explore/caseGen.test.ts`

**Interfaces:**
- Consumes: `FieldConstraint`, `InputCase`, `Baseline`, `LlmCasesSchema` (Task 1); `Llm`.
- Produces:
  - `validValueFor(c: FieldConstraint): string` — a deterministic valid value for a constraint.
  - `buildBaseline(constraints: FieldConstraint[]): Baseline` — selector → valid value for every constraint.
  - `generateCases(constraints: FieldConstraint[], llm?: Llm): Promise<InputCase[]>` — deterministic reject/boundary cases per constraint (+ one accept baseline case per field), plus optional LLM "looks-valid-but-should-reject" cases when `llm` is given. Each case carries `table`/`column` copied from its constraint. LLM failure is swallowed (rule cases still returned).

- [ ] **Step 1: Write the failing test**

Create `src/services/explore/caseGen.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { generateCases, buildBaseline, validValueFor } from './caseGen.js'
import type { FieldConstraint } from './types.js'
import type { Llm } from '../llm/client.js'

const required: FieldConstraint = { field: 'name', selector: '#name', required: true, type: 'string', maxLength: 10, table: 't', column: 'name', evidence: 'e' }
const num: FieldConstraint = { field: 'age', selector: '#age', required: false, type: 'integer', min: 0, max: 150, evidence: 'e' }
const email: FieldConstraint = { field: 'email', selector: '#email', required: true, type: 'email', evidence: 'e' }
const enumC: FieldConstraint = { field: 'role', selector: '#role', required: true, type: 'enum', enumValues: ['admin', 'user'], evidence: 'e' }

describe('validValueFor', () => {
  it('produces type-appropriate valid values', () => {
    expect(validValueFor(email)).toContain('@')
    expect(Number(validValueFor(num))).toBeGreaterThanOrEqual(0)
    expect(['admin', 'user']).toContain(validValueFor(enumC))
    expect(validValueFor(required).length).toBeLessThanOrEqual(10)
  })
})

describe('buildBaseline', () => {
  it('maps every selector to a valid value', () => {
    const b = buildBaseline([required, num, email])
    expect(Object.keys(b).sort()).toEqual(['#age', '#email', '#name'])
  })
})

describe('generateCases (rule-based)', () => {
  it('emits empty + over-length reject cases for a required maxLength field', async () => {
    const cases = await generateCases([required])
    const rejects = cases.filter((c) => c.expectation === 'reject')
    expect(rejects.some((c) => c.value === '')).toBe(true)
    expect(rejects.some((c) => c.value.length === 11)).toBe(true)
    expect(cases.some((c) => c.expectation === 'accept')).toBe(true)
    // table/column propagated
    expect(rejects[0].table).toBe('t')
    expect(rejects[0].column).toBe('name')
  })

  it('emits min-1 / max+1 and non-numeric reject cases for an integer field', async () => {
    const cases = await generateCases([num])
    const values = cases.filter((c) => c.expectation === 'reject').map((c) => c.value)
    expect(values).toContain('-1')
    expect(values).toContain('151')
    expect(values.some((v) => Number.isNaN(Number(v)))).toBe(true)
  })

  it('emits malformed-email and out-of-enum reject cases', async () => {
    const cases = await generateCases([email, enumC])
    const rejects = cases.filter((c) => c.expectation === 'reject').map((c) => c.value)
    expect(rejects).toContain('notanemail')
    expect(rejects.some((v) => v === '__not_in_enum__')).toBe(true)
  })

  it('works without an LLM (rule-only)', async () => {
    const cases = await generateCases([required])
    expect(cases.length).toBeGreaterThan(0)
  })
})

describe('generateCases (LLM add-on)', () => {
  it('appends LLM reject cases when llm is given', async () => {
    const llm: Llm = {
      // @ts-expect-error fake
      complete: async () => ({ cases: [{ field: 'name', selector: '#name', value: '  trailing  ', rationale: 'whitespace' }] }),
    }
    const cases = await generateCases([required], llm)
    expect(cases.some((c) => c.value === '  trailing  ' && c.expectation === 'reject')).toBe(true)
  })

  it('swallows LLM failure and still returns rule cases', async () => {
    const llm: Llm = {
      // @ts-expect-error fake
      complete: async () => { throw new Error('x') },
    }
    const cases = await generateCases([required], llm)
    expect(cases.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/services/explore/caseGen.test.ts`
Expected: FAIL — cannot resolve `./caseGen.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/explore/caseGen.ts`:

```typescript
import { logger } from '../../util/logger.js'
import { LlmCasesSchema } from './types.js'
import type { FieldConstraint, InputCase, Baseline } from './types.js'
import type { Llm } from '../llm/client.js'

/** A deterministic valid value satisfying a constraint (used for baseline + accept cases). */
export function validValueFor(c: FieldConstraint): string {
  switch (c.type) {
    case 'email': return 'valid@example.com'
    case 'url': return 'https://example.com'
    case 'date': return '2024-01-01'
    case 'boolean': return 'true'
    case 'enum': return c.enumValues?.[0] ?? 'value'
    case 'number':
    case 'integer': {
      const lo = c.min ?? 1
      const hi = c.max ?? lo + 1
      const v = Math.min(Math.max(1, lo), hi)
      return String(v)
    }
    default: {
      const min = c.minLength ?? 1
      const max = c.maxLength ?? Math.max(min, 6)
      const len = Math.min(Math.max(min, 1), max)
      return 'a'.repeat(Math.max(1, len))
    }
  }
}

/** selector → valid value for every constraint. */
export function buildBaseline(constraints: FieldConstraint[]): Baseline {
  const baseline: Baseline = {}
  for (const c of constraints) baseline[c.selector] = validValueFor(c)
  return baseline
}

function reject(c: FieldConstraint, value: string, rationale: string): InputCase {
  const base: InputCase = { field: c.field, selector: c.selector, value, expectation: 'reject', rationale }
  if (c.table) base.table = c.table
  if (c.column) base.column = c.column
  return base
}

function ruleCases(c: FieldConstraint): InputCase[] {
  const cases: InputCase[] = []
  if (c.required) {
    cases.push(reject(c, '', 'required field left empty'))
    cases.push(reject(c, '   ', 'required field with whitespace only'))
  }
  if (c.maxLength !== undefined) {
    cases.push(reject(c, 'a'.repeat(c.maxLength + 1), `exceeds maxLength ${c.maxLength}`))
  }
  if (c.minLength !== undefined && c.minLength > 0) {
    cases.push(reject(c, 'a'.repeat(c.minLength - 1), `below minLength ${c.minLength}`))
  }
  if (c.type === 'number' || c.type === 'integer') {
    cases.push(reject(c, 'notanumber', 'non-numeric value for numeric field'))
    if (c.type === 'integer') cases.push(reject(c, '1.5', 'decimal for integer field'))
    if (c.min !== undefined) cases.push(reject(c, String(c.min - 1), `below min ${c.min}`))
    if (c.max !== undefined) cases.push(reject(c, String(c.max + 1), `above max ${c.max}`))
  }
  if (c.type === 'email') {
    for (const v of ['notanemail', 'a@', '@b.com']) cases.push(reject(c, v, 'malformed email'))
  }
  if (c.type === 'enum') {
    cases.push(reject(c, '__not_in_enum__', 'value outside allowed enum'))
  }
  // one accept baseline case per field
  const accept: InputCase = { field: c.field, selector: c.selector, value: validValueFor(c), expectation: 'accept', rationale: 'valid baseline value' }
  if (c.table) accept.table = c.table
  if (c.column) accept.column = c.column
  cases.push(accept)
  return cases
}

async function llmCases(constraints: FieldConstraint[], llm: Llm): Promise<InputCase[]> {
  const summary = constraints
    .map((c) => `- field="${c.field}" selector="${c.selector}" type=${c.type}${c.maxLength ? ` maxLength=${c.maxLength}` : ''}`)
    .join('\n')
  const prompt =
    `For the form fields below, propose values that LOOK valid but SHOULD be rejected ` +
    `(Unicode tricks, leading/trailing whitespace, semantically invalid but well-formed). ` +
    `One per field at most. Use the exact selector.\n\n${summary}`
  try {
    const out = await llm.complete('verification', prompt, LlmCasesSchema)
    const byField = new Map(constraints.map((c) => [c.field, c]))
    return out.cases.map((lc) => {
      const c = byField.get(lc.field)
      const ic: InputCase = { field: lc.field, selector: lc.selector, value: lc.value, expectation: 'reject', rationale: `LLM: ${lc.rationale}` }
      if (c?.table) ic.table = c.table
      if (c?.column) ic.column = c.column
      return ic
    })
  } catch (err) {
    logger.warn({ err: String(err) }, 'caseGen LLM add-on failed — using rule cases only')
    return []
  }
}

/**
 * Generate input cases: deterministic rule-based reject/boundary cases + one accept baseline
 * per field; optionally LLM "looks-valid-but-reject" cases when `llm` is supplied.
 */
export async function generateCases(constraints: FieldConstraint[], llm?: Llm): Promise<InputCase[]> {
  const rule = constraints.flatMap(ruleCases)
  if (!llm) return rule
  const extra = await llmCases(constraints, llm)
  return [...rule, ...extra]
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm vitest run src/services/explore/caseGen.test.ts && pnpm build`
Expected: PASS + build PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/explore/caseGen.ts src/services/explore/caseGen.test.ts
git commit -m "feat(explore): rule-based + optional-LLM input case generation"
```

---

### Task 5: Case execution (`execute`)

**Files:**
- Create: `src/services/explore/execute.ts`
- Test: `src/services/explore/execute.test.ts`

**Interfaces:**
- Consumes: `DiscoveredForm`, `Baseline`, `InputCase`, `CaseOutcome` (Task 1); `PageLike` from `../browser/crawler.js`.
- Produces:
  - `collectErrorsFromHtml(html: string): string[]` — heuristic extraction of visible error-message text from elements whose class/id matches the error indicators.
  - `ExploreExecDeps = { secrets?: string[]; navTimeoutMs?: number; sleep?: (ms:number)=>Promise<void>; getLastStatus?: () => number | undefined; collectErrors?: (page: PageLike) => Promise<string[]> }`
  - `runCase(page: PageLike, form: DiscoveredForm, baseline: Baseline, inputCase: InputCase, deps?: ExploreExecDeps): Promise<CaseOutcome>` — fills baseline into all fields, overrides the target field with the case value, clicks submit, waits for SPA settle, observes shown errors / submit status / navigation. Masks secrets in `errorsShown`.

- [ ] **Step 1: Write the failing test**

Create `src/services/explore/execute.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { runCase, collectErrorsFromHtml } from './execute.js'
import type { PageLike } from '../browser/crawler.js'
import type { DiscoveredForm, Baseline, InputCase } from './types.js'

const form: DiscoveredForm = {
  screenPath: '/user/create',
  submitSelector: '#submit',
  fields: [
    { name: 'email', selector: '#email', htmlType: 'email' },
    { name: 'age', selector: '#age', htmlType: 'number' },
  ],
}
const baseline: Baseline = { '#email': 'valid@example.com', '#age': '30' }

type FakeOpts = { afterSubmitUrl?: string; afterSubmitHtml?: string }
function fakePage(startUrl: string, html: string, opts: FakeOpts = {}): PageLike & { filled: Record<string, string> } {
  const filled: Record<string, string> = {}
  let url = startUrl
  let body = html
  return {
    filled,
    url: () => url,
    title: async () => 'x',
    content: async () => body,
    goto: async (u: string) => { url = u },
    waitForLoadState: async () => {},
    evaluate: async () => ({}),
    screenshot: async () => {},
    locator: (selector: string) => ({
      fill: async (v: string) => { filled[selector] = v },
      click: async () => {
        if (selector === '#submit') {
          if (opts.afterSubmitUrl) url = opts.afterSubmitUrl
          if (opts.afterSubmitHtml !== undefined) body = opts.afterSubmitHtml
        }
      },
      count: async () => 1,
    }),
  }
}

describe('collectErrorsFromHtml', () => {
  it('extracts text from error-class elements', () => {
    const html = `<div class="error">メールアドレスの形式が不正です</div><span id="age-error">範囲外</span>`
    const errs = collectErrorsFromHtml(html)
    expect(errs.join(' ')).toContain('形式が不正')
    expect(errs.join(' ')).toContain('範囲外')
  })

  it('returns [] when no error elements', () => {
    expect(collectErrorsFromHtml('<div class="ok">fine</div>')).toEqual([])
  })
})

describe('runCase', () => {
  it('fills baseline + overrides the target field, then observes a shown error', async () => {
    const page = fakePage('http://app/user/create', '<form></form>', {
      afterSubmitHtml: '<div class="error">invalid email</div>',
    })
    const target: InputCase = { field: 'email', selector: '#email', value: 'notanemail', expectation: 'reject', rationale: 'malformed' }
    const out = await runCase(page, form, baseline, target, { getLastStatus: () => 422, sleep: async () => {} })
    expect(page.filled['#age']).toBe('30')         // baseline kept
    expect(page.filled['#email']).toBe('notanemail') // target overridden
    expect(out.errorsShown.join(' ')).toContain('invalid email')
    expect(out.submitStatus).toBe(422)
    expect(out.navigatedAway).toBe(false)
  })

  it('detects navigation away with no error (validation gap signal)', async () => {
    const page = fakePage('http://app/user/create', '<form></form>', {
      afterSubmitUrl: 'http://app/user/42',
      afterSubmitHtml: '<div class="ok">saved</div>',
    })
    const target: InputCase = { field: 'age', selector: '#age', value: '-1', expectation: 'reject', rationale: 'below min' }
    const out = await runCase(page, form, baseline, target, { getLastStatus: () => 200, sleep: async () => {} })
    expect(out.errorsShown).toEqual([])
    expect(out.navigatedAway).toBe(true)
    expect(out.finalUrl).toBe('http://app/user/42')
  })

  it('masks secrets from shown errors', async () => {
    const page = fakePage('http://app/user/create', '<form></form>', {
      afterSubmitHtml: '<div class="error">bad token s3cr3t</div>',
    })
    const target: InputCase = { field: 'email', selector: '#email', value: 'x', expectation: 'reject', rationale: 'r' }
    const out = await runCase(page, form, baseline, target, { secrets: ['s3cr3t'], sleep: async () => {} })
    expect(out.errorsShown.join(' ')).not.toContain('s3cr3t')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/services/explore/execute.test.ts`
Expected: FAIL — cannot resolve `./execute.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/explore/execute.ts`:

```typescript
import { maskSecrets } from '../../util/mask.js'
import type { PageLike } from '../browser/crawler.js'
import type { DiscoveredForm, Baseline, InputCase, CaseOutcome } from './types.js'

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Matches an opening tag whose class/id marks an error container, capturing its inner text.
const ERROR_ELEMENT_REGEX =
  /<([a-z0-9]+)[^>]*(?:class|id)=["'][^"']*(?:error|alert|warning|invalid|danger|fail)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi

/** Heuristically extract visible error-message text from page HTML. */
export function collectErrorsFromHtml(html: string): string[] {
  const out: string[] = []
  let m: RegExpExecArray | null
  ERROR_ELEMENT_REGEX.lastIndex = 0
  while ((m = ERROR_ELEMENT_REGEX.exec(html)) !== null) {
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (text) out.push(text)
  }
  return out
}

export type ExploreExecDeps = {
  secrets?: string[]
  navTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  /** last observed response status for the submit (wired from a Playwright response listener) */
  getLastStatus?: () => number | undefined
  /** override error collection (default parses page.content() HTML) */
  collectErrors?: (page: PageLike) => Promise<string[]>
}

/**
 * Drive one input case: fill baseline into every field, override the target field with the
 * case value, submit, wait for SPA settle, then observe shown errors / submit status / nav.
 * Never lets secret values appear in errorsShown.
 */
export async function runCase(
  page: PageLike,
  form: DiscoveredForm,
  baseline: Baseline,
  inputCase: InputCase,
  deps: ExploreExecDeps = {},
): Promise<CaseOutcome> {
  const sleep = deps.sleep ?? defaultSleep
  const secrets = deps.secrets ?? []
  const navTimeoutMs = deps.navTimeoutMs ?? 8000
  const intervalMs = 250
  const attempts = Math.max(1, Math.ceil(navTimeoutMs / intervalMs))

  // Fill baseline for every field, then override the target field.
  for (const field of form.fields) {
    const value = field.selector === inputCase.selector ? inputCase.value : baseline[field.selector] ?? ''
    await page.locator(field.selector).fill(value)
  }

  const before = page.url()
  await page.locator(form.submitSelector).click()
  await page.waitForLoadState('networkidle')
  for (let a = 0; a < attempts; a++) {
    if (page.url() !== before) break
    await sleep(intervalMs)
  }

  const collect = deps.collectErrors ?? (async (p: PageLike) => collectErrorsFromHtml(await p.content()))
  const errorsShown = (await collect(page)).map((e) => maskSecrets(e, secrets))
  const finalUrl = page.url()
  const outcome: CaseOutcome = {
    errorsShown,
    navigatedAway: finalUrl !== before,
    finalUrl,
  }
  const status = deps.getLastStatus?.()
  if (status !== undefined) outcome.submitStatus = status
  return outcome
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm vitest run src/services/explore/execute.test.ts && pnpm build`
Expected: PASS + build PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/explore/execute.ts src/services/explore/execute.test.ts
git commit -m "feat(explore): runCase fills baseline + overrides target field and observes outcome"
```

---

### Task 6: DB probe + oracle (`dbProbe`, `oracle`)

**Files:**
- Create: `src/services/explore/dbProbe.ts`
- Create: `src/services/explore/oracle.ts`
- Test: `src/services/explore/dbProbe.test.ts`
- Test: `src/services/explore/oracle.test.ts`

**Interfaces:**
- Consumes: `InputCase`, `CaseOutcome`, `GapVerdict`, `DiscoveredForm`, `QualityFinding`, `QualityFindingsSchema` (Task 1); `DbAdapter`; `Llm`.
- Produces:
  - `wasValueSaved(db: DbAdapter, dbType: 'postgres'|'mysql', table: string, column: string, value: string): Promise<boolean>` — parameterized `SELECT 1 ... LIMIT 1`; true if ≥1 row. Returns false on error.
  - `classifyGap(inputCase: InputCase, outcome: CaseOutcome, dbProbe?: () => Promise<boolean>): Promise<GapVerdict>` — only for `expectation==='reject'`. Suspicion = no errors AND (2xx submit OR navigatedAway). With a DB probe confirming the value was saved → `gap:true, high`; suspicion but no probe → `gap:true, medium`; otherwise `gap:false`.
  - `classifyErrorQuality(form: DiscoveredForm, outcomes: CaseOutcome[], llm: Llm): Promise<QualityFinding[]>` — Opus judges whether reject-case errors are bundled/unclear. Returns [] on LLM error.

- [ ] **Step 1: Write the failing tests**

Create `src/services/explore/dbProbe.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { wasValueSaved } from './dbProbe.js'
import type { DbAdapter } from '../db/adapter.js'

describe('wasValueSaved', () => {
  it('builds a parameterized query and returns true when a row exists (postgres)', async () => {
    const calls: unknown[][] = []
    const db: DbAdapter = {
      async query(sql, params) { calls.push([sql, params]); return [{ '?column?': 1 }] },
      async close() {},
    }
    const found = await wasValueSaved(db, 'postgres', 'users', 'email', 'x@y.com')
    expect(found).toBe(true)
    expect(String(calls[0][0])).toContain('$1')
    expect(calls[0][1]).toEqual(['x@y.com'])
  })

  it('uses ? for mysql and returns false on no rows', async () => {
    const db: DbAdapter = { async query() { return [] }, async close() {} }
    expect(await wasValueSaved(db, 'mysql', 't', 'c', 'v')).toBe(false)
  })

  it('returns false on query error', async () => {
    const db: DbAdapter = { async query() { throw new Error('x') }, async close() {} }
    expect(await wasValueSaved(db, 'postgres', 't', 'c', 'v')).toBe(false)
  })
})
```

Create `src/services/explore/oracle.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { classifyGap, classifyErrorQuality } from './oracle.js'
import type { InputCase, CaseOutcome, DiscoveredForm } from './types.js'
import type { Llm } from '../llm/client.js'

const rejectCase: InputCase = { field: 'age', selector: '#age', value: '-1', expectation: 'reject', rationale: 'below min', table: 'users', column: 'age' }

describe('classifyGap', () => {
  it('high when no error, 2xx, and DB confirms the value was saved', async () => {
    const outcome: CaseOutcome = { errorsShown: [], submitStatus: 200, navigatedAway: true, finalUrl: '/u/1' }
    const v = await classifyGap(rejectCase, outcome, async () => true)
    expect(v).toEqual({ gap: true, confidence: 'high' })
  })

  it('medium when suspicious but no DB probe available', async () => {
    const outcome: CaseOutcome = { errorsShown: [], submitStatus: 200, navigatedAway: false, finalUrl: '/x' }
    const v = await classifyGap(rejectCase, outcome)
    expect(v).toEqual({ gap: true, confidence: 'medium' })
  })

  it('no gap when an error was shown', async () => {
    const outcome: CaseOutcome = { errorsShown: ['範囲外です'], submitStatus: 422, navigatedAway: false, finalUrl: '/x' }
    const v = await classifyGap(rejectCase, outcome, async () => true)
    expect(v.gap).toBe(false)
  })

  it('no gap (medium downgrade) when suspicious but DB probe disproves save', async () => {
    const outcome: CaseOutcome = { errorsShown: [], submitStatus: 200, navigatedAway: true, finalUrl: '/u/1' }
    const v = await classifyGap(rejectCase, outcome, async () => false)
    expect(v).toEqual({ gap: false, confidence: 'medium' })
  })
})

describe('classifyErrorQuality', () => {
  const form: DiscoveredForm = { screenPath: '/user/create', submitSelector: '#s', fields: [] }

  it('returns Opus quality findings', async () => {
    const llm: Llm = {
      // @ts-expect-error fake
      complete: async () => ({ findings: [{ issue: 'all errors bundled into one banner', evidence: '入力に誤りがあります', severity: 'medium' }] }),
    }
    const out = await classifyErrorQuality(form, [{ errorsShown: ['入力に誤りがあります'], navigatedAway: false, finalUrl: '/x' }], llm)
    expect(out).toHaveLength(1)
    expect(out[0].screenPath).toBe('/user/create')
    expect(out[0].severity).toBe('medium')
  })

  it('returns [] on LLM error', async () => {
    const llm: Llm = {
      // @ts-expect-error fake
      complete: async () => { throw new Error('x') },
    }
    expect(await classifyErrorQuality(form, [], llm)).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/services/explore/dbProbe.test.ts src/services/explore/oracle.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `dbProbe.ts`**

Create `src/services/explore/dbProbe.ts`:

```typescript
import { logger } from '../../util/logger.js'
import type { DbAdapter } from '../db/adapter.js'

/**
 * True if a row exists in `table` where `column` equals `value`. Parameterized
 * ($1 for postgres, ? for mysql). Never throws — returns false on error.
 */
export async function wasValueSaved(
  db: DbAdapter,
  dbType: 'postgres' | 'mysql',
  table: string,
  column: string,
  value: string,
): Promise<boolean> {
  const placeholder = dbType === 'postgres' ? '$1' : '?'
  const sql = `SELECT 1 FROM ${table} WHERE ${column} = ${placeholder} LIMIT 1`
  try {
    const rows = await db.query(sql, [value])
    return rows.length > 0
  } catch (err) {
    logger.warn({ err: String(err), table, column }, 'wasValueSaved: query failed — treating as not saved')
    return false
  }
}
```

- [ ] **Step 4: Write `oracle.ts`**

Create `src/services/explore/oracle.ts`:

```typescript
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
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm vitest run src/services/explore/dbProbe.test.ts src/services/explore/oracle.test.ts && pnpm build`
Expected: PASS + build PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/explore/dbProbe.ts src/services/explore/oracle.ts src/services/explore/dbProbe.test.ts src/services/explore/oracle.test.ts
git commit -m "feat(explore): dbProbe + oracle (gap classification + error-message quality)"
```

---

### Task 7: Form discovery (`discover`)

**Files:**
- Create: `src/services/explore/discover.ts`
- Test: `src/services/explore/discover.test.ts`

**Interfaces:**
- Consumes: `DiscoveredForm`, `FormField` (Task 1); `PageLike`; `TargetEnv` from `../../domain/types.js`.
- Produces: `discoverForms(page: PageLike, target: TargetEnv, screenPaths: string[], deps?: { sleep?: (ms:number)=>Promise<void> }): Promise<DiscoveredForm[]>` — for each path: navigate, parse the rendered HTML for `<input>/<select>/<textarea>` fields (name/type/selector/label) and a submit control. Screens with no input fields are skipped (logged). Also export `parseFormFromHtml(html: string, screenPath: string): DiscoveredForm | null` (the pure parser).

- [ ] **Step 1: Write the failing test**

Create `src/services/explore/discover.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { discoverForms, parseFormFromHtml } from './discover.js'
import type { PageLike } from '../browser/crawler.js'
import type { TargetEnv } from '../../domain/types.js'

const target: TargetEnv = { name: 't', baseUrl: 'http://app' }

const formHtml = `
<form>
  <input name="email" type="email" />
  <input name="age" type="number" />
  <select name="role"><option>admin</option></select>
  <textarea name="bio"></textarea>
  <button type="submit">Save</button>
</form>`

function fakePage(htmlByPath: Record<string, string>): PageLike {
  let url = 'http://app/'
  return {
    url: () => url,
    title: async () => 'x',
    content: async () => htmlByPath[new URL(url).pathname] ?? '<html></html>',
    goto: async (u: string) => { url = u },
    waitForLoadState: async () => {},
    evaluate: async () => ({}),
    screenshot: async () => {},
    locator: () => ({ fill: async () => {}, click: async () => {}, count: async () => 0 }),
  }
}

describe('parseFormFromHtml', () => {
  it('extracts input/select/textarea fields + a submit selector', () => {
    const form = parseFormFromHtml(formHtml, '/user/create')
    expect(form).not.toBeNull()
    expect(form!.fields.map((f) => f.name).sort()).toEqual(['age', 'bio', 'email', 'role'])
    expect(form!.fields.find((f) => f.name === 'email')!.htmlType).toBe('email')
    expect(form!.submitSelector).toBeTruthy()
  })

  it('returns null when there are no input fields', () => {
    expect(parseFormFromHtml('<div>no form</div>', '/x')).toBeNull()
  })
})

describe('discoverForms', () => {
  it('returns one DiscoveredForm per screen that has inputs, skipping empty ones', async () => {
    const page = fakePage({ '/user/create': formHtml, '/empty': '<div>nothing</div>' })
    const forms = await discoverForms(page, target, ['/user/create', '/empty'], { sleep: async () => {} })
    expect(forms).toHaveLength(1)
    expect(forms[0].screenPath).toBe('/user/create')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/services/explore/discover.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/explore/discover.ts`:

```typescript
import { logger } from '../../util/logger.js'
import type { PageLike } from '../browser/crawler.js'
import type { TargetEnv } from '../../domain/types.js'
import type { DiscoveredForm, FormField } from './types.js'

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)
  return m ? m[1] : undefined
}

function selectorFor(name: string | undefined, id: string | undefined, fallbackTag: string): string {
  if (name) return `[name="${name}"]`
  if (id) return `#${id}`
  return fallbackTag
}

/** Parse a rendered HTML page into a DiscoveredForm, or null if it has no inputs. */
export function parseFormFromHtml(html: string, screenPath: string): DiscoveredForm | null {
  const fields: FormField[] = []

  const inputRe = /<input\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = inputRe.exec(html)) !== null) {
    const tag = m[0]
    const type = (attr(tag, 'type') ?? 'text').toLowerCase()
    if (['submit', 'button', 'hidden', 'reset', 'image'].includes(type)) continue
    const name = attr(tag, 'name')
    const id = attr(tag, 'id')
    if (!name && !id) continue
    fields.push({ name: name ?? id!, selector: selectorFor(name, id, `input[type="${type}"]`), htmlType: type })
  }

  for (const [tagName, defType] of [['select', 'select'], ['textarea', 'textarea']] as const) {
    const re = new RegExp(`<${tagName}\\b[^>]*>`, 'gi')
    while ((m = re.exec(html)) !== null) {
      const tag = m[0]
      const name = attr(tag, 'name')
      const id = attr(tag, 'id')
      if (!name && !id) continue
      fields.push({ name: name ?? id!, selector: selectorFor(name, id, tagName), htmlType: defType })
    }
  }

  if (fields.length === 0) return null

  const hasSubmitButton = /<button\b[^>]*type=["']submit["']/i.test(html) || /<input\b[^>]*type=["']submit["']/i.test(html)
  const submitSelector = hasSubmitButton ? 'button[type="submit"],input[type="submit"]' : 'button[type="submit"]'
  return { screenPath, submitSelector, fields }
}

/** Navigate to each screen path and extract its form. Screens without inputs are skipped. */
export async function discoverForms(
  page: PageLike,
  target: TargetEnv,
  screenPaths: string[],
  deps: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<DiscoveredForm[]> {
  const base = target.baseUrl.replace(/\/$/, '')
  const forms: DiscoveredForm[] = []
  for (const path of screenPaths) {
    const url = /^https?:\/\//i.test(path) ? path : `${base}/${path.replace(/^\//, '')}`
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForLoadState('networkidle')
      const form = parseFormFromHtml(await page.content(), path)
      if (form) forms.push(form)
      else logger.info({ path }, 'explore discover: no input fields — skipping screen')
    } catch (err) {
      logger.warn({ err: String(err), path }, 'explore discover: failed to load screen — skipping')
    }
  }
  return forms
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm vitest run src/services/explore/discover.test.ts && pnpm build`
Expected: PASS + build PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/explore/discover.ts src/services/explore/discover.test.ts
git commit -m "feat(explore): discover forms by navigating screen paths and parsing inputs"
```

---

### Task 8: Orchestration pipeline (`src/pipeline/explore.ts`)

**Files:**
- Create: `src/pipeline/explore.ts`
- Test: `src/pipeline/explore.test.ts`

**Interfaces:**
- Consumes: every Task 1–7 export; `writeReport` + `WriteReportDeps` from `./report.js`; `authenticate` (`../services/browser/login.js`); `seedDatabase` (`../services/seed/seed.js`); `prepare` (`./prepare.js`); `PageLike`; `TargetEnv`, `VerifyFinding`, `SiteStructure`.
- Produces:
  - `ExploreOpts = { target?: string; screens?: string[]; skipPrepare?: boolean; noReseed?: boolean }`
  - `ExploreResult = { findings: VerifyFinding[]; forms: number; cases: number; gapsHigh: number; gapsMedium: number; messageIssues: number }`
  - `ExploreDeps` (all I/O injected — see code).
  - `explore(root: string, opts: ExploreOpts, deps: ExploreDeps): Promise<ExploreResult>` — guard → prepare → page+auth → discover → per-form(model→generate→execute→classify) → findings → writeReport → re-seed. Per-form/per-case failures are isolated; auth failure aborts before any destructive submit.

- [ ] **Step 1: Write the failing test**

Create `src/pipeline/explore.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { explore } from './explore.js'
import type { ExploreDeps } from './explore.js'
import type { DiscoveredForm, FieldConstraint, InputCase, CaseOutcome, Baseline } from '../services/explore/types.js'
import type { PageLike } from '../services/browser/crawler.js'

const form: DiscoveredForm = {
  screenPath: '/user/create',
  submitSelector: '#submit',
  fields: [{ name: 'age', selector: '#age', htmlType: 'number' }],
}
const constraint: FieldConstraint = { field: 'age', selector: '#age', required: true, type: 'integer', min: 0, table: 'users', column: 'age', evidence: 'e' }
const gapCase: InputCase = { field: 'age', selector: '#age', value: '-1', expectation: 'reject', rationale: 'below min', table: 'users', column: 'age' }

function fakePage(): PageLike {
  return {
    url: () => 'http://app/user/create',
    title: async () => 'x',
    content: async () => '<form></form>',
    goto: async () => {},
    waitForLoadState: async () => {},
    evaluate: async () => ({}),
    screenshot: async () => {},
    locator: () => ({ fill: async () => {}, click: async () => {}, count: async () => 1 }),
    close: async () => {},
  }
}

function baseDeps(overrides: Partial<ExploreDeps> = {}): ExploreDeps {
  const writeReport = vi.fn(async () => {})
  const seedDatabase = vi.fn(async () => {})
  return {
    target: { name: 't', baseUrl: 'http://app', auth: { strategy: 'form', loginPath: '/login' } },
    creds: { username: 'u', password: 'p' },
    dbType: 'postgres',
    seed: { command: 'seed-cmd' },
    createPage: async () => fakePage(),
    authenticate: async () => ({ ok: true, detail: 'ok', finalUrl: 'http://app/' }),
    discoverForms: async () => [form],
    inferCandidateTables: async () => ['users'],
    introspectTable: async () => [],
    modelConstraints: async () => [constraint],
    generateCases: async () => [gapCase],
    buildBaseline: () => ({ '#age': '5' }) as Baseline,
    runCase: async () => ({ errorsShown: [], submitStatus: 200, navigatedAway: true, finalUrl: 'http://app/user/1' }) as CaseOutcome,
    classifyGap: async () => ({ gap: true, confidence: 'high' }),
    classifyErrorQuality: async () => [],
    wasValueSaved: async () => true,
    writeReport,
    reportDeps: {} as ExploreDeps['reportDeps'],
    seedDatabase,
    ...overrides,
  }
}

describe('explore pipeline', () => {
  it('produces a high input-validation finding for a confirmed gap and re-seeds', async () => {
    const deps = baseDeps()
    const res = await explore('/root', { screens: ['/user/create'] }, deps)
    expect(res.gapsHigh).toBe(1)
    expect(res.findings.some((f) => f.category === 'input-validation' && f.severity === 'high')).toBe(true)
    expect(deps.writeReport).toHaveBeenCalledOnce()
    expect(deps.seedDatabase).toHaveBeenCalledOnce()
  })

  it('aborts (throws) before executing cases when auth fails — no reseed, no report', async () => {
    const deps = baseDeps({
      authenticate: async () => ({ ok: false, detail: 'bad creds', finalUrl: 'http://app/login' }),
      runCase: vi.fn(async () => ({ errorsShown: [], navigatedAway: false, finalUrl: 'x' }) as CaseOutcome),
    })
    await expect(explore('/root', { screens: ['/user/create'] }, deps)).rejects.toThrow(/auth/i)
    expect(deps.runCase).not.toHaveBeenCalled()
    expect(deps.writeReport).not.toHaveBeenCalled()
    expect(deps.seedDatabase).not.toHaveBeenCalled()
  })

  it('skips re-seed when noReseed is set', async () => {
    const deps = baseDeps()
    await explore('/root', { screens: ['/user/create'], noReseed: true }, deps)
    expect(deps.seedDatabase).not.toHaveBeenCalled()
  })

  it('throws a guard error when no seed is configured and reseed is not disabled', async () => {
    const deps = baseDeps({ seed: undefined })
    await expect(explore('/root', { screens: ['/user/create'] }, deps)).rejects.toThrow(/seed/i)
  })

  it('runs prepare before discovery unless skipped', async () => {
    const prepare = vi.fn(async () => {})
    const deps = baseDeps({ prepare, config: { setup: [] } as never })
    await explore('/root', { screens: ['/user/create'] }, deps)
    expect(prepare).toHaveBeenCalledOnce()
  })

  it('isolates a per-form modeling failure and still reports', async () => {
    const deps = baseDeps({ modelConstraints: async () => { throw new Error('llm down') } })
    const res = await explore('/root', { screens: ['/user/create'] }, deps)
    expect(res.forms).toBe(1)
    expect(res.cases).toBe(0)
    expect(deps.writeReport).toHaveBeenCalledOnce()
    expect(deps.seedDatabase).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/pipeline/explore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/pipeline/explore.ts`:

```typescript
import { logger } from '../util/logger.js'
import type { TargetEnv, VerifyFinding, SiteStructure } from '../domain/types.js'
import type { PageLike } from '../services/browser/crawler.js'
import type { DbAdapter } from '../services/db/adapter.js'
import type { Llm } from '../services/llm/client.js'
import type { Config } from '../config/schema.js'
import type { WriteReportDeps } from './report.js'
import type { LoginResult } from '../services/browser/login.js'
import type {
  DiscoveredForm, ColumnDef, FieldConstraint, InputCase, CaseOutcome, Baseline, GapVerdict, QualityFinding,
} from '../services/explore/types.js'
import type { ExploreExecDeps } from '../services/explore/execute.js'

export type ExploreOpts = { target?: string; screens?: string[]; skipPrepare?: boolean; noReseed?: boolean }

export type ExploreResult = {
  findings: VerifyFinding[]
  forms: number
  cases: number
  gapsHigh: number
  gapsMedium: number
  messageIssues: number
}

/** All external I/O is injected. `reportDeps` is everything writeReport needs except findings. */
export type ExploreDeps = {
  target: TargetEnv
  creds: { username: string; password: string }
  dbType: 'postgres' | 'mysql'
  /** launch.seed config (undefined ⇒ none configured) */
  seed?: { command: string }
  /** config used for prepare + setup hooks (optional; only needed when prepare runs) */
  config?: Config
  secrets?: string[]
  sleep?: (ms: number) => Promise<void>

  createPage: () => Promise<PageLike>
  authenticate: (page: PageLike, target: TargetEnv, creds: { username: string; password: string }) => Promise<LoginResult>
  discoverForms: (page: PageLike, target: TargetEnv, screens: string[]) => Promise<DiscoveredForm[]>
  inferCandidateTables: (form: DiscoveredForm, llm: Llm) => Promise<string[]>
  introspectTable: (db: DbAdapter, dbType: 'postgres' | 'mysql', table: string) => Promise<ColumnDef[]>
  modelConstraints: (form: DiscoveredForm, columns: ColumnDef[], sourceRules: string, llm: Llm) => Promise<FieldConstraint[]>
  generateCases: (constraints: FieldConstraint[], llm?: Llm) => Promise<InputCase[]>
  buildBaseline: (constraints: FieldConstraint[]) => Baseline
  runCase: (page: PageLike, form: DiscoveredForm, baseline: Baseline, inputCase: InputCase, deps?: ExploreExecDeps) => Promise<CaseOutcome>
  classifyGap: (inputCase: InputCase, outcome: CaseOutcome, dbProbe?: () => Promise<boolean>) => Promise<GapVerdict>
  classifyErrorQuality: (form: DiscoveredForm, outcomes: CaseOutcome[], llm: Llm) => Promise<QualityFinding[]>
  wasValueSaved: (db: DbAdapter, dbType: 'postgres' | 'mysql', table: string, column: string, value: string) => Promise<boolean>

  db?: DbAdapter
  llm: Llm
  sourceRules?: string
  execDeps?: ExploreExecDeps

  writeReport: (root: string, runId: string, deps: WriteReportDeps) => Promise<void>
  reportDeps: Omit<WriteReportDeps, 'verifyFindings' | 'diffFindings' | 'currentStructure'>
  prepare?: (config: Config, root: string, deps: { secrets: string[]; gitToken: string }) => Promise<void>
  seedDatabase: (seed: { command: string }, root: string, runner?: never, secrets?: string[]) => Promise<void>
  runId?: string
}

function emptyStructure(): SiteStructure {
  return { generatedAt: new Date().toISOString(), pages: [], transitions: [] }
}

function gapFinding(form: DiscoveredForm, c: InputCase, v: GapVerdict): VerifyFinding {
  return {
    category: 'input-validation',
    severity: v.confidence === 'high' ? 'high' : 'medium',
    title: `入力チェック漏れ: ${form.screenPath} ${c.field}`,
    detail:
      `不正値「${c.value}」（${c.rationale}）が ${form.screenPath} の ${c.field} で拒否されませんでした。` +
      (v.confidence === 'high' ? ` DB(${c.table}.${c.column})に保存を確認。` : ' UI/ネットワーク信号のみ（DB裏取り不可）。'),
    evidence: `selector=${c.selector} expectation=reject confidence=${v.confidence}`,
  }
}

function qualityFinding(q: QualityFinding): VerifyFinding {
  return {
    category: 'input-validation',
    severity: q.severity,
    title: `エラーメッセージ品質: ${q.screenPath}`,
    detail: q.issue,
    evidence: q.evidence,
  }
}

/**
 * Orchestrate exploratory input validation. Guards destructive runs (requires seed or --no-reseed),
 * authenticates once, then per form: model constraints → generate cases → execute → classify gaps
 * and message quality. Findings flow through writeReport; the DB is re-seeded afterward.
 */
export async function explore(root: string, opts: ExploreOpts, deps: ExploreDeps): Promise<ExploreResult> {
  // Guard: refuse to run destructively without a way to restore state.
  if (!deps.seed && !opts.noReseed) {
    throw new Error('explore: launch.seed is not configured and --no-reseed was not passed; aborting to avoid leaving the DB dirty')
  }

  const secrets = deps.secrets ?? []
  const runId = deps.runId ?? new Date().toISOString().replace(/[:.]/g, '-')

  // Stage 0: prepare (repo refresh + setup hooks).
  if (!opts.skipPrepare && deps.prepare && deps.config) {
    logger.info({ root }, 'explore prepare phase starting')
    await deps.prepare(deps.config, root, { secrets, gitToken: '' })
    logger.info({ root }, 'explore prepare phase complete')
  }

  const page = await deps.createPage()
  try {
    // Stage 1: authenticate once. Abort before any destructive submit on failure.
    const auth = await deps.authenticate(page, deps.target, deps.creds)
    if (!auth.ok) {
      throw new Error(`explore: authentication failed (${auth.detail}) — aborting before any form submission`)
    }

    // Stage 2: discover forms.
    const screens = opts.screens ?? []
    const forms = await deps.discoverForms(page, deps.target, screens)

    const findings: VerifyFinding[] = []
    let cases = 0
    let gapsHigh = 0
    let gapsMedium = 0
    let messageIssues = 0

    for (const form of forms) {
      try {
        // model
        const tables = await deps.inferCandidateTables(form, deps.llm)
        const columns: ColumnDef[] = []
        if (deps.db) {
          for (const t of tables) columns.push(...(await deps.introspectTable(deps.db, deps.dbType, t)))
        }
        const constraints = await deps.modelConstraints(form, columns, deps.sourceRules ?? '', deps.llm)
        if (constraints.length === 0) continue

        // generate
        const baseline = deps.buildBaseline(constraints)
        const inputCases = await deps.generateCases(constraints, deps.llm)

        // execute + classify gaps
        const rejectOutcomes: CaseOutcome[] = []
        for (const c of inputCases) {
          try {
            const outcome = await deps.runCase(page, form, baseline, c, deps.execDeps)
            cases++
            if (c.expectation !== 'reject') continue
            rejectOutcomes.push(outcome)
            const probe =
              deps.db && c.table && c.column
                ? () => deps.wasValueSaved(deps.db!, deps.dbType, c.table!, c.column!, c.value)
                : undefined
            const verdict = await deps.classifyGap(c, outcome, probe)
            if (verdict.gap) {
              findings.push(gapFinding(form, c, verdict))
              if (verdict.confidence === 'high') gapsHigh++
              else gapsMedium++
            }
          } catch (err) {
            logger.warn({ err: String(err), screen: form.screenPath, field: c.field }, 'explore: case failed — continuing')
          }
        }

        // message quality
        const quality = await deps.classifyErrorQuality(form, rejectOutcomes, deps.llm)
        for (const q of quality) {
          findings.push(qualityFinding(q))
          messageIssues++
        }
      } catch (err) {
        logger.warn({ err: String(err), screen: form.screenPath }, 'explore: form failed — continuing')
      }
    }

    // Stage 3: report.
    await deps.writeReport(root, runId, {
      ...deps.reportDeps,
      verifyFindings: findings,
      diffFindings: [],
      currentStructure: emptyStructure(),
    })

    // Stage 4: re-seed to restore the DB.
    if (!opts.noReseed && deps.seed) {
      await deps.seedDatabase(deps.seed, root, undefined as never, secrets)
    }

    return { findings, forms: forms.length, cases, gapsHigh, gapsMedium, messageIssues }
  } finally {
    await page.close?.().catch(() => {})
  }
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm vitest run src/pipeline/explore.test.ts && pnpm build`
Expected: PASS + build PASS. (If `reportDeps` typing needs the `ctx` field present at runtime, the test casts `{} as ExploreDeps['reportDeps']`; production supplies the real object in Task 9.)

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/explore.ts src/pipeline/explore.test.ts
git commit -m "feat(explore): orchestration pipeline with guard, single auth, per-form isolation, re-seed"
```

---

### Task 9: CLI command + wiring (`explore`)

**Files:**
- Create: `src/cli/commands/explore.ts`
- Modify: `src/cli/index.ts` (register `explore` command, after the `rdra-export` block, before `program.parse()`)
- Test: `src/cli/commands/explore.test.ts`

**Interfaces:**
- Consumes: `explore`, `ExploreOpts`, `ExploreResult`, `ExploreDeps` (Task 8); `loadConfig`; `createLlm`; `createDbAdapter`; `createGithubClient`; `adjudicate`; `upsertIssue`; `parseRepoUrl`; `authenticate`; `defaultComposeRunner`; `seedDatabase`; `launchBrowser`.
- Produces: `runExplore(cwd: string, opts: ExploreOpts, deps: RunExploreDeps): Promise<ExploreResult>` — resolves config/target/creds/dbType/secrets, builds `ExploreDeps`, calls `explore`. Stdout summary printed by the index action. Uses a **no-op `store.saveBaseline`** so explore never clobbers the crawl baseline.

- [ ] **Step 1: Write the failing test**

Create `src/cli/commands/explore.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { runExplore } from './explore.js'

describe('runExplore', () => {
  const config = {
    targets: [{ name: 't', baseUrl: 'http://app', auth: { strategy: 'form', loginPath: '/login', usernameEnv: 'U', passwordEnv: 'P', twoFactor: { pinCommand: 'pin' } } }],
    databases: [{ type: 'postgres', passwordEnv: 'DBPASS' }],
    launch: { seed: { command: 'seed-cmd' } },
    models: { planning: 'o', report: 's', verification: 'o' },
    refutation: { panelSize: 3, confidenceThreshold: 0.8, lenses: [] },
    github: { labels: { ready: 'R', autoDetect: 'A' } },
    repositories: [],
    setup: [],
  }
  const secrets = { db: { DBPASS: 'pw' }, targetAuth: { U: 'user', P: 'pass' }, anthropicApiKey: 'k', githubToken: '' }

  it('resolves config and invokes explore with wired deps', async () => {
    const exploreFn = vi.fn(async () => ({ findings: [], forms: 2, cases: 9, gapsHigh: 1, gapsMedium: 0, messageIssues: 1 }))
    const res = await runExplore('/cwd', { screens: ['/user/create'] }, {
      loadConfig: async () => ({ config, secrets }) as never,
      explore: exploreFn as never,
      createLlm: () => ({}) as never,
      createDbAdapter: () => ({ query: async () => [], close: async () => {} }),
      createGithubClient: () => ({}) as never,
      launchBrowser: async () => ({ browser: { newPage: async () => ({ close: async () => {} }), close: async () => {} } }) as never,
    } as never)
    expect(exploreFn).toHaveBeenCalledOnce()
    expect(res.gapsHigh).toBe(1)
  })

  it('throws when the named target is missing', async () => {
    await expect(
      runExplore('/cwd', { target: 'nope' }, {
        loadConfig: async () => ({ config: { ...config, targets: [] }, secrets }) as never,
        explore: vi.fn() as never,
        createLlm: () => ({}) as never,
        createDbAdapter: () => ({ query: async () => [], close: async () => {} }),
        createGithubClient: () => ({}) as never,
        launchBrowser: async () => ({ browser: { newPage: async () => ({}), close: async () => {} } }) as never,
      } as never),
    ).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/cli/commands/explore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the command module**

Create `src/cli/commands/explore.ts`:

```typescript
import { logger } from '../../util/logger.js'
import type { ExploreOpts, ExploreResult, ExploreDeps } from '../../pipeline/explore.js'
import type { Config } from '../../config/schema.js'
import type { Secrets, TargetEnv } from '../../domain/types.js'
import type { BrowserLike } from '../../services/browser/crawler.js'

export type RunExploreDeps = {
  loadConfig: (cwd: string) => Promise<{ config: Config; secrets: Secrets }>
  explore: (root: string, opts: ExploreOpts, deps: ExploreDeps) => Promise<ExploreResult>
  createLlm: (apiKey: string, models: Config['models']) => import('../../services/llm/client.js').Llm
  createDbAdapter: (conn: Config['databases'][number], password: string) => import('../../services/db/adapter.js').DbAdapter
  createGithubClient: (token: string) => import('../../services/github/client.js').GithubClient
  launchBrowser: () => Promise<{ browser: BrowserLike }>
}

function resolveCreds(secrets: Secrets, auth: NonNullable<Config['targets'][number]['auth']>): { username: string; password: string } | null {
  const username = auth.usernameEnv ? secrets.targetAuth[auth.usernameEnv] : undefined
  const password = auth.passwordEnv ? secrets.targetAuth[auth.passwordEnv] : undefined
  if (!username || !password) return null
  return { username, password }
}

/** Resolve config/target/creds/db and invoke the explore pipeline with real deps. */
export async function runExplore(cwd: string, opts: ExploreOpts, deps: RunExploreDeps): Promise<ExploreResult> {
  const { config, secrets } = await deps.loadConfig(cwd)

  const selected = opts.target
    ? config.targets.find((t) => t.name === opts.target)
    : config.targets[0]
  if (!selected) throw new Error(`explore: no matching target${opts.target ? ` "${opts.target}"` : ''} configured`)
  if (!selected.auth || selected.auth.strategy === 'none') throw new Error('explore: target has no form auth configured')

  const creds = resolveCreds(secrets, selected.auth)
  if (!creds) throw new Error('explore: target credentials not configured (usernameEnv/passwordEnv)')

  const target: TargetEnv = {
    name: selected.name,
    baseUrl: selected.baseUrl,
    auth: {
      strategy: selected.auth.strategy,
      loginPath: selected.auth.loginPath,
      username: creds.username,
      password: creds.password,
      twoFactor: selected.auth.twoFactor,
    },
  }

  const allSecrets: string[] = [
    secrets.anthropicApiKey,
    secrets.githubToken,
    ...Object.values(secrets.db),
    ...Object.values(secrets.targetAuth),
  ].filter(Boolean) as string[]

  const llm = deps.createLlm(secrets.anthropicApiKey, config.models)

  const dbConf = config.databases[0]
  const dbType: 'postgres' | 'mysql' = (dbConf?.type as 'postgres' | 'mysql') ?? 'postgres'
  const db = dbConf ? deps.createDbAdapter(dbConf, secrets.db[dbConf.passwordEnv] ?? '') : undefined

  const githubClient = secrets.githubToken ? deps.createGithubClient(secrets.githubToken) : null
  const repoUrl = config.repositories[0]?.url

  // lazily import the heavy/real implementations
  const { authenticate } = await import('../../services/browser/login.js')
  const { discoverForms } = await import('../../services/explore/discover.js')
  const { inferCandidateTables, modelConstraints } = await import('../../services/explore/constraintModel.js')
  const { introspectTable } = await import('../../services/explore/dbIntrospect.js')
  const { generateCases, buildBaseline } = await import('../../services/explore/caseGen.js')
  const { runCase } = await import('../../services/explore/execute.js')
  const { classifyGap, classifyErrorQuality } = await import('../../services/explore/oracle.js')
  const { wasValueSaved } = await import('../../services/explore/dbProbe.js')
  const { writeReport } = await import('../../pipeline/report.js')
  const { prepare } = await import('../../pipeline/prepare.js')
  const { seedDatabase } = await import('../../services/seed/seed.js')
  const { adjudicate } = await import('../../services/llm/refute.js')
  const { upsertIssue } = await import('../../services/github/issues.js')
  const { parseRepoUrl } = await import('../../services/github/labels.js')
  const { defaultComposeRunner } = await import('../../services/compose/compose.js')

  const repo = githubClient && repoUrl ? parseRepoUrl(repoUrl) : null

  const browserCtx = await deps.launchBrowser()
  try {
    const ctx = {
      root: cwd,
      runId: '',
      config,
      secrets,
    }
    const result = await deps.explore(cwd, opts, {
      target,
      creds,
      dbType,
      seed: config.launch?.seed,
      config,
      secrets: allSecrets,
      createPage: () => browserCtx.browser.newPage(),
      authenticate: (page, t, c) => authenticate(page, t, c, { pinRunner: defaultComposeRunner, secrets: allSecrets }),
      discoverForms: (page, t, screens) => discoverForms(page, t, screens),
      inferCandidateTables,
      introspectTable,
      modelConstraints,
      generateCases,
      buildBaseline,
      runCase,
      classifyGap,
      classifyErrorQuality,
      wasValueSaved,
      db,
      llm,
      writeReport,
      reportDeps: {
        ctx,
        llm,
        adjudicate,
        upsertIssue: (client, r, finding, label) => upsertIssue(client, r, finding, label, allSecrets),
        // No-op baseline save: explore must NOT clobber the crawl baseline.
        store: { saveBaseline: async () => {} },
        githubClient,
        repo,
      },
      prepare,
      seedDatabase: (seed, root, _runner, s) => seedDatabase(seed, root, defaultComposeRunner, s),
    })
    logger.info({ result: { forms: result.forms, cases: result.cases } }, 'explore complete')
    return result
  } finally {
    await browserCtx.browser.close().catch(() => {})
  }
}
```

- [ ] **Step 4: Register the command in `src/cli/index.ts`**

Immediately before the final `program.parse()` line, add:

```typescript
program
  .command('explore')
  .description('Exploratory input-validation testing: drive forms with invalid/boundary values, detect validation gaps + poor error messages')
  .option('--target <name>', 'Target name to run against')
  .option('--screen <path...>', 'Screen path(s) to explore (repeatable)')
  .option('--skip-prepare', 'Skip the pre-run prepare phase (repo refresh + setup hooks)')
  .option('--no-reseed', 'Do not re-seed the database after the run (skips the dev-guard)')
  .action(async (opts: { target?: string; screen?: string[]; skipPrepare?: boolean; reseed?: boolean }) => {
    const cwd = process.cwd()
    const { runExplore } = await import('./commands/explore.js')
    const { explore } = await import('../pipeline/explore.js')
    const { createDbAdapter } = await import('../services/db/index.js')
    try {
      const result = await runExplore(
        cwd,
        { target: opts.target, screens: opts.screen ?? [], skipPrepare: opts.skipPrepare, noReseed: opts.reseed === false },
        { loadConfig, explore, createLlm, createDbAdapter, createGithubClient, launchBrowser: async () => {
          const { launchBrowser } = await import('../services/browser/browser.js')
          return launchBrowser()
        } },
      )
      process.stdout.write(
        `explore: forms ${result.forms} / cases ${result.cases} / ` +
          `gaps ${result.gapsHigh + result.gapsMedium} (high ${result.gapsHigh}/medium ${result.gapsMedium}) / ` +
          `message-issues ${result.messageIssues} → report .loop-e2e/reports/\n`,
      )
    } catch (err) {
      process.stderr.write(`explore failed: ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }
  })

program.parse()
```

Note: Commander's `--no-reseed` populates `opts.reseed === false`; map it to `noReseed: opts.reseed === false`. Verify `createGithubClient` and `createLlm` are already imported at the top of `index.ts` (they are — used by `run`/`grow`). Remove the now-duplicate trailing `program.parse()` so only one remains.

- [ ] **Step 5: Run tests + typecheck + full suite**

Run: `pnpm vitest run src/cli/commands/explore.test.ts && pnpm build`
Then full suite: `pnpm vitest run`
Expected: explore test PASS, build PASS, full suite still 450+ pass / 4 skip (now higher pass count), 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/explore.ts src/cli/commands/explore.test.ts src/cli/index.ts
git commit -m "feat(explore): wire explore CLI command (no-op baseline save, real deps)"
```

---

### Task 10: Docs + real-machine E2E

**Files:**
- Modify: `README.md` (add an `explore` section)
- Create: `src/pipeline/explore.e2e.test.ts` (gated behind `RUN_E2E=1`)

**Interfaces:**
- Consumes: the public CLI behavior only. No new exports.

- [ ] **Step 1: Add the README section**

In `README.md`, after the `grow`/scenario sections (find the command reference area), add:

```markdown
## `explore` — 探索的入力検証

各画面のフォームに、わざと不正/境界の値を入力して何が起きるかを探索的に検証し、
(1) バリデーションギャップ（不正値が拒否されず DB に保存される）と
(2) エラーメッセージ品質（1つにまとめられて分かりにくい等）を検出します。

```bash
loop-e2e explore --screen /user/create --screen /coupon/create
loop-e2e explore --target spotly --screen /hotel/create
loop-e2e explore --screen /user/create --no-reseed   # 再シードしない（dev ガードを外す）
```

- 制約（必須/型/長さ/最小最大/形式）は **DB テーブル定義 ＋ ソースのバリデーションルール** から Opus が割り出します。
- gap 判定は **UI/ネットワーク信号 → DB 照会で裏取り**（保存確認できれば high、できなければ medium）。
- 結果は既存のレポート（`report.md`/`report.json`）＋反証ゲート経由で GitHub Issue 化されます。
- **安全性**: dev/local 前提。実行後に `launch.seed` で DB を初期化します。`launch.seed` 未設定かつ `--no-reseed` でもない場合は破壊防止のため中断します。
```

- [ ] **Step 2: Add the gated real-machine E2E test**

Create `src/pipeline/explore.e2e.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'

const RUN = process.env.RUN_E2E === '1'

describe.skipIf(!RUN)('explore real-machine E2E', () => {
  it('runs explore against a configured create form and produces a result', async () => {
    const { runExplore } = await import('../cli/commands/explore.js')
    const { explore } = await import('./explore.js')
    const { loadConfig } = await import('../config/load.js')
    const { createLlm } = await import('../services/llm/client.js')
    const { createDbAdapter } = await import('../services/db/index.js')
    const { createGithubClient } = await import('../services/github/client.js')
    const { launchBrowser } = await import('../services/browser/browser.js')

    const screen = process.env.EXPLORE_SCREEN ?? '/user/create'
    const result = await runExplore(process.cwd(), { screens: [screen] }, {
      loadConfig, explore, createLlm, createDbAdapter, createGithubClient, launchBrowser,
    })
    expect(result.forms).toBeGreaterThanOrEqual(0)
    expect(result.cases).toBeGreaterThanOrEqual(0)
  }, 180_000)
})
```

Note: confirm the real `loadConfig` import path is `../config/load.js` (match the path used by `src/cli/index.ts`); adjust if the project exports it elsewhere. If `createGithubClient`'s import path differs, match `src/cli/index.ts`.

- [ ] **Step 3: Verify the gated test is skipped by default**

Run: `pnpm vitest run src/pipeline/explore.e2e.test.ts`
Expected: 1 skipped, 0 failed.

- [ ] **Step 4: Full suite + build + lint**

Run: `pnpm vitest run && pnpm build && pnpm lint`
Expected: all green; explore E2E skipped.

- [ ] **Step 5: Commit**

```bash
git add README.md src/pipeline/explore.e2e.test.ts
git commit -m "docs(explore): README usage + RUN_E2E real-machine test (skipped by default)"
```

---

## Self-Review

**Spec coverage:**
- §1 goals (gap + message quality) → Tasks 6 (oracle) + 8 (findings). ✅
- §2 flow (prepare→discover→model→generate→execute→classify→findings→report→re-seed) → Task 8. ✅
- §3 discover → Task 7. ✅
- §4 constraint modeling (Opus) + §4.1 DB introspection + §4.2 source rules → Tasks 3 + 2 (sourceRules threaded as a string into `modelConstraints`; supplied by CLI as `''` for v1, with a hook to populate from ingestion later). ✅
- §5 case generation (rule + optional LLM, valid baseline) → Task 4. ✅
- §6 execution (target field + baseline, SPA wait, observe errors/status/nav, mask) + §6.1 single auth → Tasks 5 + 8. ✅
- §7 oracle (gap high/medium/none, message quality) + §7.3 dbProbe → Task 6. ✅
- §8 VerifyFinding category 'input-validation' (high/medium/quality) → Tasks 1 + 8. ✅
- §9 report reuse → Task 8 (writeReport) + Task 9 (real adjudicate/upsertIssue, no-op baseline). ✅
- §10 safety/guard + re-seed → Task 8 (guard throws; re-seed) + Task 9 (seed wiring). ✅
- §11 component layout → Tasks 1–9 file paths match exactly. ✅
- §12 CLI → Task 9. ✅
- §13 error handling (skip unreachable forms, abort on auth fail, gap downgrade, per-form/case isolation) → Tasks 7 + 8. ✅
- §14 test strategy → each task's tests + Task 10 E2E. ✅
- §15 staged order → Tasks map 1:1. ✅

**Spec refinement noted:** §4 `FieldConstraint` did not list `table`/`column`, but §5/§7.3 require them on `InputCase` for DB probing. Resolved by having Opus populate `table`/`column` on `FieldConstraint` (it already receives DB columns) and `caseGen` copy them onto each `InputCase`. Documented in Tasks 1, 3, 4.

**Placeholder scan:** No TBD/TODO; every code step contains complete code. The `sourceRules` v1 value is an explicit `''` (with documented future hook), not a placeholder.

**Type consistency:** `DiscoveredForm`, `FieldConstraint`, `InputCase`, `Baseline`, `CaseOutcome`, `GapVerdict`, `QualityFinding`, `ColumnDef` defined once in Task 1 and referenced unchanged. `introspectTable`/`wasValueSaved`/`classifyGap` signatures identical across producing task and Task 8 `ExploreDeps`. `dbType: 'postgres'|'mysql'` threaded consistently. LLM role `'verification'` used uniformly for Opus calls. `writeReport(root, runId, WriteReportDeps)` matches `src/pipeline/report.ts`.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-22-explore-input-validation.md`.
