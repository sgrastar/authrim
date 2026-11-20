---
project: Authrim
lang: en
date: 2025-12-27
description: "This guide covers Authrim's comprehensive testing strategy including unit tests, integration tests, E2E tests, conformance tests, and load testing."
type: guide
tags:
  - authrim
  - testing
---

# Testing Guide

This guide covers Authrim's comprehensive testing strategy including unit tests, integration tests, E2E tests, conformance tests, and load testing.

## Table of Contents

- [Test Overview](#test-overview)
- [Unit Tests](#unit-tests)
- [Integration Tests](#integration-tests)
- [Mutation Tests](#mutation-tests)
- [E2E Tests](#e2e-tests)
- [Accessibility Tests](#accessibility-tests)
- [Performance Tests](#performance-tests)
- [OIDC Conformance Tests](#oidc-conformance-tests)
- [Load Testing](#load-testing)
- [CI/CD Integration](#cicd-integration)
- [Running All Tests](#running-all-tests)

---

## Test Overview

| Test Type                 | Tool            | Purpose                                         | Location                      |
| ------------------------- | --------------- | ----------------------------------------------- | ----------------------------- |
| **Unit**                  | Vitest          | Backend API, Durable Objects, and components    | `packages/*/src/__tests__/`   |
| **Integration**           | Vitest          | Maintained cross-package protocol flows         | `test/integration/`           |
| **Security matrices**     | Vitest          | High-volume protocol, topology, and state cases | `test/security-matrices/`     |
| **Generated environment** | TypeScript CLI  | Generated-file and deployed-environment smoke   | `test/generated-environment/` |
| **E2E**                   | Playwright      | User flows and UI functionality                 | `test-e2e/`                   |
| **Accessibility**         | axe-core        | WCAG 2.1 AA compliance                          | `test-e2e/`                   |
| **Performance**           | Lighthouse CI   | Core Web Vitals                                 | `lighthouserc.json`           |
| **Load**                  | k6              | Performance at scale                            | `load-testing/`               |
| **Conformance**           | OIDC Foundation | OpenID certification                            | separate conformance setup    |

---

## Unit Tests

### Running Unit Tests

```bash
# Run all unit tests
pnpm test

# Run with coverage
pnpm test --coverage

# Run specific package tests
pnpm --filter=@authrim/ar-lib-core test
pnpm --filter=@authrim/ar-token test

# Run in watch mode
pnpm --filter=@authrim/ar-lib-core test -- --watch
```

### Test Structure

```
packages/
├── ar-lib-core/src/__tests__/
│   ├── durable-objects/     # DO unit tests
│   │   ├── AuthorizationCodeStore.test.ts
│   │   ├── SessionStore.test.ts
│   │   └── RefreshTokenRotator.test.ts
│   └── utils/               # Utility function tests
├── ar-auth/src/__tests__/   # Authorization endpoint tests
├── ar-token/src/__tests__/  # Token endpoint tests
├── ar-userinfo/src/__tests__/ # UserInfo endpoint tests
└── ar-management/src/__tests__/ # Admin API tests
```

### Key Test Suites

**Durable Objects** (~50+ tests):

- `AuthorizationCodeStore`: Code issuance, validation, replay prevention
- `SessionStore`: Session lifecycle, hot/cold storage, multi-device
- `RefreshTokenRotator`: Token rotation, theft detection, audit logging
- `KeyManager`: JWK management, key rotation

**Handlers** (~300+ tests):

- Authorization endpoint flows
- Token endpoint (all grant types)
- UserInfo claims handling
- Client registration
- Token introspection/revocation

---

## Integration Tests

```bash
# Run integration tests
pnpm test -- --filter=integration
```

**Key Test Suites**:

| Suite                        | Description                               |
| ---------------------------- | ----------------------------------------- |
| `authorization-flow.test.ts` | Complete OAuth 2.0/OIDC flows with PKCE   |
| `durable-objects.test.ts`    | Cross-DO communication, state consistency |
| `security-headers.test.ts`   | CSP, HSTS, X-Frame-Options, CORS          |

---

## Mutation Tests

Mutation testing checks how well the unit tests detect behaviour changes: the tool makes small
edits ("mutants") to the production code, runs the tests that cover each edit, and reports every
mutant the tests failed to notice. The primary tool is [mutator](https://github.com/mizchi/mutator)
(`@mizchi/mutator`); StrykerJS is kept in `ar-saml` as a reference run (see below). Mutation tests
are not part of `pnpm test`; CI runs them on the changed packages of a pull request as an
informational job.

**Requirements**: Node.js 24 or later (the rest of the repository runs on Node 22; `pnpm install`
on Node 22 only warns about the engine, but the `mutator` command needs 24). On a fresh checkout
build the dependencies first, because the tests import their `dist/`:

```bash
pnpm turbo run build --filter='@authrim/ar-saml^...'   # or `pnpm build:api` for everything
```

**Running**

```bash
cd packages/ar-saml
pnpm test:mutation                                   # whole package; writes .mutator/report/
pnpm test:mutation:diff                              # mutants in `git diff origin/develop`, plus the
                                                     # code covered by added or changed tests
npx mutator --include 'src/common/key-utils.ts'      # one file
npx mutator --only <key>                             # re-check one mutant after adding a test
mkdir -p .mutator && npx mutator --reporter agent --since origin/develop --include-test-changes > .mutator/agent.json

# From the repository root: every opted-in package, then one merged HTML report
cd ../..
pnpm test:mutation:diff                              # or `pnpm test:mutation -- --time-budget 3600`
pnpm test:mutation:summary                           # -> reports/mutation/index.html + a Markdown table
```

Per-package reports go to `.mutator/report/` (`index.html`, `mutation.json`); the merged report
to `reports/mutation/` at the root (self-contained: the viewer component is copied next to it;
to keep it loadable it omits the per-mutant list of covering tests and keeps the killing test,
so its test list shows only tests that detected a mutant). A report that cannot be parsed is
listed in the summary and left out; mutant and test ids are prefixed with the package path.
Both are git-ignored. The merged page and table are a package-wide snapshot of each package's last
report: every mutant with a verdict counts, whether run this time or reused from the cache;
Pending mutants (outside `--since`, or beyond the time budget) and invalid ones (compile or
runtime error, ignored) do not. The score is (killed + timeout) / (killed + timeout + survived +
no coverage), as in the mutation-testing-elements report. Results are cached per function in
`.mutator/snapshot.json`: a rerun with no change takes seconds, and after an edit only the
affected functions and their tests run. Editing a `package.json` or the lockfile invalidates the
whole cache of that package.

**Reading the result**

The score is (killed + timeout) / (killed + timeout + survived + no coverage). Undetected mutants
are grouped by where the tests stopped short:

- _not reached_: no test runs the code. Add a test case.
- _not infected_: tests run it, but never with an input that changes the value (for example a
  boundary). Add that input.
- _not detected_: tests run it, nothing fails. Assert on the value that differs (an exact error
  message, a persisted value, an emitted event or a header rather than only an HTTP status).

Sort each survivor into one of three buckets: **add a test**, **delete the code** (no observable
behaviour changes, so the branch is dead), or **accept it** as an equivalent mutant with
`npx mutator accept <key> --reason "..."`, which records it in `mutator.accepted.json` at the
package root (committed and reviewed like code). Do not write brittle tests just to kill one.

**How it works in this repository**

- The shared configuration lives in `mutator.base.mjs` at the repository root (excludes for tests,
  fixtures and `*.d.ts`; `src/index.ts` is mutated because the API packages wire middleware and
  routes there; text, JSON and HTML reporters; thresholds 80/60, no break). A package opts in with a two-line `mutator.config.mjs` and the two scripts
  `test:mutation` (`mutator`) and `test:mutation:diff`
  (`mutator --since origin/develop --include-test-changes`). The turbo tasks `test:mutation` and
  `test:mutation:diff` build the dependencies first.
- Every API package and library is opted in, except: the UI packages (`ar-admin-ui`,
  `ar-admin-console`, `ar-login-ui`), whose Svelte components are not instrumented and whose
  Storybook projects need a different runner setup; and `setup`, whose Wrangler command mocks
  fail under mutator's shared Vitest session even though `pnpm test` passes (to be investigated).
  `ar-lib-core` and `ar-management` run a narrowed scope (one mutant per line, and for
  `ar-lib-core` `src/test/` excluded; see their `mutator.config.mjs`). Even so, a whole-package
  run of either still fails when mutator writes its JSON report (`RangeError: Invalid string
length`: the report lists all ~200k mutants, Pending ones included). Diff runs (`--since`,
  the default of the manual workflow) have worked so far, but the report still lists every
  mutant, so a diff touching widely covered code can hit the same limit; for a full baseline, run
  them in parts with `--include`.
- `ar-runtime-aws` needs a real PostgreSQL 17 with TLS for its `*.postgres.test.ts` files; without
  it they are skipped and their code reports as NoCoverage. Start the CI database with
  `AUTHRIM_CI_PG_PORT=55432 scripts/ci-postgres-tls.sh <dir>` and export the variables the CI
  job sets (`NODE_EXTRA_CA_CERTS`, `AUTHRIM_TEST_DATABASE_CA`, `AUTHRIM_AWS_TEST_DATABASE_URL`,
  `AUTHRIM_AWS_MAINTENANCE_TEST_DATABASE_URL`) before running `mutator`. Its
  `mutator.config.mjs` selects `vitest.mutation.config.ts` (no parallel test files, without the
  replication initialization tests that need a different URL) and runs one session at a time. The
  first run spends about 45 minutes type-checking (cached afterwards), and the package has
  ~26,000 mutants, so a whole-package run takes several `--time-budget` chunks.
- mutator runs everything in one process and its heap grows with each mutant executed: with the
  default heap, a package of more than roughly 10k mutants dies with `heap out of memory` before
  it writes its snapshot, and the whole run is lost. For a full first pass of a large package,
  give Node more heap and run in chunks that each finish, since the next run continues from the
  cache:
  `NODE_OPTIONS=--max-old-space-size=12288 npx mutator --time-budget 1200` (repeat until no
  mutants are "not run"). The manual workflow sets `NODE_OPTIONS` for the same reason.
- `scripts/ci-mutation-summary.mjs` merges `packages/*/.mutator/report/mutation.json` into one
  mutation-testing-elements report and prints a Markdown table (appended to the workflow step
  summary).
- Mutation tests are **not part of the pull-request CI** (a run takes up to an hour per package).
  The workflow **Mutation Tests** (`.github/workflows/mutation-tests.yml`) is started by hand from
  the Actions tab on the branch of your choice, with three inputs: `base` (a commit or ref to diff
  against, default `origin/develop`; empty runs whole packages), `packages` (comma-separated
  package directory names; empty means the packages changed since `base`, or every opted-in
  package when there is no base) and `time_budget` (seconds of mutant execution per package,
  default 3600). It restores the `.mutator` caches of the latest run on the same branch, saves
  them whatever happened, writes the score table to the step summary and uploads the merged
  report as the `mutation-report` artifact. Mutants that did not fit in the budget stay Pending
  and are not counted; a later run on the same branch continues them from the cache. Packages
  run one after another, so a whole-repository run does not fit in GitHub's 6 h job limit: pick
  the packages. mutator officially targets Vitest 5; it currently runs on this repository's
  Vitest 4.1.

Opting another package in:

```bash
cd packages/<name>
printf "import { createMutatorConfig } from '../../mutator.base.mjs';\n\nexport default createMutatorConfig();\n" > mutator.config.mjs
# add to the package's scripts:
#   "test:mutation": "mutator",
#   "test:mutation:diff": "mutator --since origin/develop --include-test-changes"
pnpm test:mutation --time-budget 60   # first run; verifies the suite runs under mutator
```

**StrykerJS reference run (ar-saml only)**

`ar-saml` keeps a StrykerJS 10 configuration (`stryker.base.mjs` at the root, `stryker.config.mjs`
in the package, script `test:mutation:stryker`) as a second opinion while mutator is new. Stryker
mutates the sources **in place** (tests read sibling resources such as `../../migrations`), so do
not edit the package or run another watcher while it runs. It restores the files on exit or
Ctrl+C; after a hard kill copy them back from the backup directory it announced at start
(`.stryker-tmp/backup-*`) and check `git diff`. Do not use `git checkout -- <package>`, which would
also discard your own uncommitted edits. Reports go to `reports/mutation/` inside the package;
runs are incremental (`reports/mutation/incremental.json`), add `--force` after changing shared
helpers, fixtures or dependencies, or to get a comparable score. pnpm 9 forwards flags as-is:
`pnpm test:mutation:stryker --mutate src/sp/acs.ts`, no `--`.

---

## E2E Tests

### Running E2E Tests

```bash
# Run E2E tests
pnpm test:e2e

# Interactive UI mode
pnpm test:e2e:ui

# Headed mode (see browser)
pnpm test:e2e:headed

# Debug mode
pnpm test:e2e:debug
```

### Configuration

**File**: `playwright.config.ts`

- **Browser**: Chromium (extendable to Firefox, WebKit)
- **Base URL**: `http://localhost:4173` (preview server)
- **Auto Server**: Starts via `webServer` option
- **Artifacts**: Screenshots/videos on failure, traces on retry

### Test Files

```
test-e2e/
├── homepage.spec.ts       # Homepage load, navigation
├── accessibility.spec.ts  # WCAG 2.1 AA compliance
└── login.spec.ts          # Login flow tests
```

---

## Accessibility Tests

**Standard**: WCAG 2.1 Level A & AA

```bash
# Run accessibility tests
pnpm test:e2e test-e2e/accessibility.spec.ts
```

**Coverage**:

- Color contrast (4.5:1 normal, 3:1 large text)
- Keyboard navigation (tab order, focus indicators)
- ARIA attributes validation
- Form labels and associations

---

## Performance Tests

### Running Lighthouse

```bash
# Full Lighthouse CI run
pnpm test:lighthouse

# Collect only
pnpm test:lighthouse:collect

# Assert only
pnpm test:lighthouse:assert
```

### Target Scores

| Metric         | Target |
| -------------- | ------ |
| Performance    | 90+    |
| Accessibility  | 90+    |
| Best Practices | 90+    |
| SEO            | 90+    |

### Core Web Vitals

| Metric                         | Target   |
| ------------------------------ | -------- |
| First Contentful Paint (FCP)   | < 2000ms |
| Largest Contentful Paint (LCP) | < 2500ms |
| Cumulative Layout Shift (CLS)  | < 0.1    |
| Total Blocking Time (TBT)      | < 300ms  |

---

## OIDC Conformance Tests

Authrim supports running against the OpenID Foundation certification tests.

### Test Plans

| Plan       | Description                 | Status  |
| ---------- | --------------------------- | ------- |
| Basic OP   | Standard OIDC Provider      | ✓       |
| Config OP  | Configuration endpoint      | ✓       |
| Dynamic OP | Dynamic client registration | ✓       |
| FAPI 2.0   | Financial-grade API 2.0     | Testing |

### Running Conformance Tests

1. Deploy Authrim to a public endpoint
2. Register at [OpenID Conformance Suite](https://www.certification.openid.net)
3. Configure your test plan with your Authrim endpoints
4. Run tests through the web interface

See the OpenID Foundation's documentation for detailed instructions.

---

## Load Testing

Test Authrim's performance under realistic load using K6.

> **Full documentation**: See `load-testing/README.md` in the repository root for complete setup and benchmark guides.

### Quick Start

```bash
cd load-testing

# 1. Seed test data (example: access tokens)
BASE_URL=https://your-authrim.example.com \
CLIENT_ID=xxx CLIENT_SECRET=yyy ADMIN_MACHINE_ACCESS_TOKEN=zzz \
TOKEN_COUNT=1000 \
node scripts/seeds/seed-access-tokens.js

# 2. Run benchmark
k6 run \
  --env BASE_URL=https://your-authrim.example.com \
  --env CLIENT_ID=xxx --env CLIENT_SECRET=yyy \
  --env PRESET=rps100 \
  scripts/benchmarks/test-introspect-benchmark.js
```

### Available Benchmarks

| Benchmark           | Endpoint                     | Seed Script             |
| ------------------- | ---------------------------- | ----------------------- |
| Token Introspection | `POST /introspect`           | `seed-access-tokens.js` |
| Token Exchange      | `POST /token`                | `seed-access-tokens.js` |
| UserInfo            | `GET /userinfo`              | `seed-access-tokens.js` |
| Silent Auth         | `GET /authorize?prompt=none` | `seed-otp-users.js`     |
| Mail OTP Login      | 5-step OAuth flow            | `seed-otp-users.js`     |
| Passkey Login       | 6-step OAuth flow            | `seed-passkey-users.js` |

### Performance Highlights

| Endpoint                        | Recommended RPS | Peak RPS |
| ------------------------------- | --------------- | -------- |
| Silent Auth (128 shards)        | 2,500           | 3,500    |
| Refresh Token (48 shards)       | 2,500           | 3,000    |
| UserInfo                        | 2,000           | 2,500    |
| Token Introspection (32 shards) | 300             | 500      |

### Scripts

```
load-testing/scripts/
├── benchmarks/               # K6 benchmark scripts
│   ├── test-introspect-benchmark.js
│   ├── test-userinfo-benchmark.js
│   └── ...
├── seeds/                    # Seed data generation
│   ├── seed-access-tokens.js
│   ├── seed-otp-users.js
│   └── ...
└── utils/
    └── report-cf-analytics.js  # Cloudflare metrics
```

### Cloudflare Analytics

```bash
# Fetch metrics for last 10 minutes
CF_API_TOKEN=xxx node scripts/utils/report-cf-analytics.js --minutes 10

# Fetch metrics for specific time range
CF_API_TOKEN=xxx node scripts/utils/report-cf-analytics.js \
  --start "2025-12-17T10:00:00Z" --end "2025-12-17T10:30:00Z"
```

---

## CI/CD Integration

### GitHub Actions

**Workflow**: `.github/workflows/ci.yml`

**Jobs**:

1. **lint-and-test**: Lint, TypeCheck, Unit Tests, Build
2. **e2e-and-accessibility**: E2E tests with accessibility
3. **lighthouse**: Performance tests

### Pre-commit Hooks

```bash
# Run before committing
pnpm run lint
pnpm run typecheck
pnpm run format:check
```

---

## Running All Tests

### Quick Validation

```bash
# Essential checks before PR
pnpm run lint && pnpm run typecheck && pnpm test
```

### Full Test Suite

```bash
# All tests (except load tests)
pnpm test                  # Unit tests
pnpm test:e2e              # E2E + Accessibility
pnpm test:lighthouse       # Performance
```

### Comprehensive Testing

```bash
# Run everything
pnpm test && \
pnpm test:e2e && \
pnpm test:lighthouse
```

---

## Test Coverage Goals

| Category           | Target             |
| ------------------ | ------------------ |
| Unit Test Coverage | 80%+               |
| E2E Coverage       | All critical flows |
| Accessibility      | 100% WCAG 2.1 AA   |
| Performance        | 90+ Lighthouse     |

---

## Troubleshooting

### Tests Hanging

```bash
# Kill stale processes
pkill -f wrangler
pkill -f playwright
```

### E2E Server Not Starting

```bash
# Build UI first
pnpm --filter=ui build

# Then run E2E
pnpm test:e2e
```

---

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [Playwright Documentation](https://playwright.dev/)
- [Lighthouse CI](https://github.com/GoogleChrome/lighthouse-ci)
- [k6 Documentation](https://k6.io/docs/)
- [OpenID Conformance Suite](https://www.certification.openid.net/)
