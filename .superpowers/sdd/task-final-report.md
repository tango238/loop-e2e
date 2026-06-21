# Final Review Fix Report

## Changes per finding

### CRITICAL 1+2 — Wire `loop-e2e run` with real deps + remove no-op keystone deps

**`src/cli/index.ts`**
- Replaced stub throws with full real wiring mirroring the `feedback` command pattern:
  `loadConfig(cwd)` → `{ config, secrets }` → `createLlm(secrets.anthropicApiKey, config.models)`
- Dynamic imports: `loadScenarios`, `launchBrowser`, `crawl`, `extractPageInfo`, `collect`,
  `detectDiffs`, `runVerify`, `writeReport`, `adjudicate`, `upsertIssue`, `parseRepoUrl`, `storeModule`
- Target selection: `config.targets.find(t => t.name === opts.target) ?? config.targets[0]`;
  logs selected target name; exits 1 with clear message if no targets configured
- `githubClient` and `repo` wired from secrets/config; null if not available (no issue filing)
- All secrets assembled as `allSecrets[]` and passed to `upsertIssue` wrapper
- Browser closed in `finally` block; config errors produce clean stderr message (no secret leak)

**`src/cli/commands/run.ts`**
- `RunDeps` extended with optional `adjudicate`, `upsertIssue`, `store`, `githubClient`, `repo` fields
- Stage 2 (diff): `scenarios: deps.scenarios ?? []` instead of hardcoded `[]`
- Stage 4 (report): `deps.adjudicate`, `deps.upsertIssue`, `deps.store` threaded through to
  `writeReport` — no-op fallbacks only for tests that don't exercise those paths;
  production wiring always supplies real deps

**`src/pipeline/collect.ts`**
- `CollectDeps` gains optional `scenarios?: Scenario[]` field
- `crawl` call now passes `deps.scenarios ?? []` instead of `[]`
- `Scenario` import changed from `domain/types.js` (minimal stub) to `scenario/schema.js` (full type)
- `Transition[]` built from consecutive visit-sequence pairs in `rawPages`

**5 new tests added to `run.test.ts`**: scenarios threading, adjudicate threading, store threading

### IMPORTANT 3 — Close secret-masking gaps

**`src/services/github/issues.ts`**
- `maskedTitle = maskSecrets(finding.title, secrets)` before `client.issues.create`
  (previously only body was masked)

**`src/pipeline/report.ts`**
- Imported `maskSecrets` from `../util/mask.js`
- Full secret set built: `[anthropicApiKey, githubToken, ...Object.values(db), ...Object.values(targetAuth)].filter(Boolean)`
- `rawReportBody` from `llm.complete` masked → `reportBody` (stops LLM from leaking secrets in summary)
- `upsertIssue` now receives `allSecrets` instead of only `[anthropicApiKey, githubToken]`
- `safeMd = maskSecrets(mdContent, allSecrets)` and `safeJson = maskSecrets(JSON.stringify(report), allSecrets)`
  written to disk instead of unmasked content

**`src/util/logger.ts`**
- Added pino `redact` paths: `['password', 'token', 'apiKey', '*.password', '*.token', '*.apiKey']`
  with censor `'***'` (defense-in-depth for structured log fields)

**2 new tests**: `issues.test.ts` (title masking), `report.test.ts` (secrets absent in report.md/json)

### IMPORTANT 4 — Fix DB connection leak

**`src/services/db/adapter.ts`**
- Added `close(): Promise<void>` to `DbAdapter` interface

**`src/services/db/postgres.ts`**
- Implemented `close()` via `pool.end()`

**`src/services/db/mysql.ts`**
- Implemented `close()` via `connection.end()`

**`src/pipeline/verify/registeredData.ts`**
- Restructured to group `{ scenario, dbExpect }` by `connectionName` using a `Map`
- Creates ONE adapter per unique connection name (not one per `dbExpect` entry)
- Wraps all expectations for a connection in `try { ... } finally { adapter.close() }`
- Missing connection findings pushed for all items in that group (unchanged behavior)

**3 new tests**: `adapter.test.ts` (postgres close, mysql close), `registeredData.test.ts` (close called on success)

### IMPORTANT 5 — Crawler resource + scenario transitions

**`src/services/browser/crawler.ts`**
- Added optional `close?: () => Promise<void>` to `PageLike` type
- Extracted `capturePage(page, url, screenshotDir)` helper for reuse
- Extracted `isNavigationTarget(t)` and `resolveUrl(stepTarget, baseUrl)` helpers
- `crawlWithBrowser` restructured: opens one page, captures base URL, then iterates
  scenario steps — if `step.target` is URL-like, resolves to absolute URL, deduplicates
  by `visitedUrls` Set, captures page, logs transition; errors on individual step
  navigation are caught and warned (not thrown)
- Page closed in `finally` block via `page.close?.()` (optional chaining for test compat)
- `_scenarios` parameter renamed to `scenarios` (now actively used)
- Import changed from `domain/types.js::Scenario` to `scenario/schema.js::Scenario`

**`src/pipeline/collect.ts`** (also in CRITICAL 1+2 section above)
- `Transition[]` built from consecutive `rawPages` visit sequence

**1 new test**: `crawler.test.ts` — 2-step scenario → ≥2 pages

## RED → GREEN evidence

| Check | Before | After |
|-------|--------|-------|
| Secret in issue title | RED (title unmasked) | GREEN (title masked via `maskSecrets`) |
| Secret in report.md | RED (LLM output unmasked) | GREEN (masked before `writeFile`) |
| Secret in report.json | RED (unmasked JSON) | GREEN (masked before `writeFile`) |
| DB adapter `.close()` exists | RED (`close is not a function`) | GREEN (implemented in pg + mysql) |
| DB connection closed after query | RED (no close call) | GREEN (called in `finally`) |
| Transition crawl | RED (transitions always `[]`) | GREEN (scenario steps followed) |
| Scenarios threaded to detectDiffs | RED (hardcoded `[]`) | GREEN (`deps.scenarios ?? []`) |
| `run` command executes real pipeline | RED (all stages throw) | GREEN (full real deps wired) |

## Gate results

- `pnpm build`: exit 0
- `pnpm test`: 245 passed, 2 skipped (247 total)
- `pnpm lint`: exit 0

## Commit SHAs

- `7f92cf1` feat: wire run command with real deps; thread scenarios/adjudicate/store through runRun
- `d2318b7` fix: close secret-masking gaps in issue title, report files, and logger redact
- `324e0c5` fix: add DbAdapter.close(); close connection per-group in verifyRegisteredData
- `56608d0` feat: crawler follows scenario step transitions; collect threads transitions into SiteStructure

## DONE_WITH_CONCERNS

None — all five findings implemented with tests. No gaps deferred.

Transition trigger label is `'navigate'` (a generic constant) rather than the actual `step.action`
string, because `crawlWithBrowser` returns `RawPage[]` (not typed transitions) and the caller
(`collect.ts`) reconstructs transitions from the visit sequence. This is intentional — the
trigger could be made more precise by threading step action metadata, but that would require a
richer return type from the crawler. The current approach correctly builds `Transition` objects
that satisfy the `diff.ts` detection logic.
