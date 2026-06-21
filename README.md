# loop-e2e

AI-driven E2E verification loop. Crawls your web app, detects regressions against a baseline, verifies security/layout/data integrity with an LLM panel, and learns from your feedback.

## Install

```sh
npm install -g loop-e2e
# or use without global install
npx loop-e2e <command>
```

Requires Node 20+.

## Quick start

```sh
# 1. Initialise a project (creates .loop-e2e.yaml and .loop-e2e/ state dir)
loop-e2e init

# 2. Generate test scenarios from your repository requirements
loop-e2e scenario

# 3. Run the verification loop
loop-e2e run

# 4. Submit feedback on a finding
loop-e2e feedback --run <runId> --finding 0 --comment "False positive — token is in meta tag" --scenario my-scenario
```

## Subcommands

### `init`

Scaffolds `.loop-e2e.yaml` (project config) and `.loop-e2e/` (state directory) in the current working directory. Prompts interactively for target URL, GitHub repo, and database connection.

### `scenario`

Reads your repository source code and requirement files, then uses Claude to generate `*.scenario.yaml` files in the configured `scenarioDir`. Pass `--from <file...>` to merge additional requirement files.

```sh
loop-e2e scenario --from docs/requirements.md docs/api.md
```

### `run`

Runs the 4-stage pipeline:

1. **collect** — Crawls the target app with Playwright, extracts structured page info with Claude.
2. **diff** — Compares current structure against baseline; detects missing transitions, changed items, expectation gaps.
3. **verify** — Runs 5 verify categories: layout, security, conditional rendering, registered data, error handling.
4. **report** — Adjudicates each finding with an Opus refutation panel; files GitHub issues for high-confidence bugs; writes `report.json` + `report.md` under `.loop-e2e/reports/<runId>/`.

```sh
loop-e2e run --target staging
```

### `feedback`

Submits a correction on a finding from a previous run. The LLM (Opus) judges whether the comment is a valid correction or a misunderstanding.

- **Valid feedback:** registers the finding as known-state (suppresses future re-detection) and updates the referenced scenario's `expectedResults`.
- **Invalid feedback:** recorded for audit but no state is mutated.

```sh
loop-e2e feedback \
  --run 2024-01-15T10-00-00-000Z \
  --finding 0 \
  --comment "CSRF token is served via meta tag, not form field — false positive" \
  --scenario login-flow
```

Options:

| Flag | Description |
|------|-------------|
| `--run <runId>` | Run ID (required) |
| `--finding <n>` | Zero-based index into `verifyFindings` (default: 0) |
| `--comment <text>` | Free-text correction (required) |
| `--scenario <id>` | Scenario ID to update on valid feedback |
| `--scenario-dir <dir>` | Scenario directory (default: `<cwd>/scenarios`) |

## Config file

`.loop-e2e.yaml` in the project root:

```yaml
repositories:
  - name: frontend
    label: Frontend
    url: https://github.com/org/frontend
    role: frontend
    audience: user

targets:
  - name: staging
    baseUrl: https://staging.example.com
    auth:
      strategy: form          # form | basic | none
      loginPath: /login
      usernameEnv: APP_USER
      passwordEnv: APP_PASS

databases:
  - name: main
    type: postgres            # postgres | mysql
    host: localhost
    port: 5432
    database: myapp
    user: postgres
    passwordEnv: DB_PASSWORD

schedule:
  intervalMinutes: 60

scenarioDir: scenarios

github:
  owner: org
  repo: frontend
  labels:
    ready: Ready
    autoDetect: Auto-Detect

baseline:
  commit: false               # true = pin baseline to a specific git commit

models:
  planning: claude-opus-4-8
  report: claude-sonnet-4-6
  verification: claude-opus-4-8

ingestion:
  cloneDepth: 50
  tokenBudgetPerRepo: 120000
  gitLogCount: 50

refutation:
  panelSize: 3
  confidenceThreshold: 0.8
  lenses:
    - correctness
    - security
    - intentionality
```

## Environment variables (`.env`)

```dotenv
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=ghp_...

# Database passwords (names match passwordEnv in config)
DB_PASSWORD=secret

# Target auth (names match usernameEnv/passwordEnv in config)
APP_USER=admin
APP_PASS=pass
```

## Scheduling with cron

`loop-e2e` has no built-in scheduler. Use your OS cron or any job runner:

```cron
# Run every 30 minutes
*/30 * * * * cd /path/to/project && loop-e2e run >> /var/log/loop-e2e.log 2>&1
```

Docker / CI example:

```yaml
# GitHub Actions — scheduled run
on:
  schedule:
    - cron: '0 */2 * * *'   # every 2 hours
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx loop-e2e run
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          DB_PASSWORD: ${{ secrets.DB_PASSWORD }}
```

## State files

All state lives under `.loop-e2e/` (add to `.gitignore` unless you want to commit the baseline):

```
.loop-e2e/
  baseline/baseline.yaml          # Site structure baseline
  runs/<runId>.yaml               # Per-run site structure snapshots
  reports/<runId>/report.json     # Machine-readable report
  reports/<runId>/report.md       # Human-readable report
  feedback/<id>.feedback.yaml     # Per-feedback-item files
  known-findings/<fp>.yaml        # Acknowledged false-positives (suppressed in future runs)
  scenarios/                      # Generated scenario files (*.scenario.yaml)
```
