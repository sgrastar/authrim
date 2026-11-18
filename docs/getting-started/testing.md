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

Mutation testing ([StrykerJS](https://stryker-mutator.io/)) checks how well the unit tests detect
behaviour changes: Stryker makes small edits ("mutants") to the production code, runs the tests
that cover each edit, and reports every mutant the tests failed to notice. It is a manual,
pre-PR check and is intentionally **not** part of `pnpm test` or CI (a full run of one package
takes minutes to hours).

```bash
# Dependencies must be built first on a fresh checkout (the tests import their dist/)
pnpm turbo run build --filter='@authrim/ar-saml^...'

# Whole package (run from the package directory)
cd packages/ar-saml
pnpm test:mutation

# A single file: much faster, use this while iterating on tests
# (pnpm 9 forwards the flags as-is; do not add `--`)
pnpm test:mutation --mutate src/sp/acs.ts

# Every package that has opted in (from the repository root)
pnpm test:mutation
```

Reports are written to `reports/mutation/` inside the package (`index.html` to browse,
`mutation.json` for tooling); both are git-ignored. Runs are **incremental**: the result of the
previous run is kept in `reports/mutation/incremental.json` and only mutants whose source or
tests changed are re-tested. The incremental check only looks at the mutated file and the test
files: after changing a shared test helper, a fixture, a dependency or an environment variable,
or when you want a score to compare against, add `--force` to re-test everything. The reported
score excludes static mutants (`ignoreStatic`), which is why it is comparable between runs.

**How it works in this repository**

- The shared configuration lives in `stryker.base.mjs` at the repository root. A package opts in
  with a two-line `stryker.config.mjs` and a `"test:mutation": "stryker run"` script.
- Sources are mutated **in place** (not in a copied sandbox) because tests read sibling resources
  such as `../../migrations`. Stryker restores the original files when the run finishes or is
  interrupted with Ctrl+C. Do not edit the package while a run is active, and do not run another
  test watcher or dev server against it. After a hard kill (not Ctrl+C) the run cannot restore
  the files: copy them back from the backup directory the run announced at start
  (`.stryker-tmp/backup-*`) and check `git diff`. Do not use `git checkout -- <package>`, which
  would also discard your own uncommitted edits. A dedicated worktree avoids both problems.
- The TypeScript checker discards mutants that do not compile, so they do not count against the
  score.

**Working through survivors**

A surviving mutant means the current tests cannot tell the mutated code from the original.
Sort each one into one of three buckets:

1. **Add a test** that observes the behaviour (usually by asserting an exact error message, a
   persisted value, an emitted event or a header rather than only an HTTP status).
2. **Delete the code**: if no observable behaviour changes, the branch or expression is dead.
3. **Accept it** as an equivalent mutant (for example `/\s+/` vs `/\s/` after trimming) and move
   on; do not write brittle tests just to kill it.

**Fast reruns with mutator**

[mutator](https://github.com/mizchi/mutator) (`@mizchi/mutator`) is installed alongside Stryker
for the inner loop. It produces the same kind of score and report but instruments sources in
memory (no in-place rewrite, no sandbox) and caches results per function, so a rerun with no
change takes seconds instead of a full dry run. Stryker remains the reference run for a whole
package; use mutator while writing tests.

```bash
cd packages/ar-saml
pnpm test:mutation:diff                              # mutants in `git diff develop`, plus the code
                                                     # covered by added or changed tests
npx mutator --include 'src/common/key-utils.ts'      # one file, whole file
mkdir -p .mutator && npx mutator --reporter agent --since develop --include-test-changes > .mutator/agent.json
npx mutator --only <key>                             # re-check one mutant after adding a test
```

mutator needs Node.js 24 or later (the rest of the repository runs on Node 22). It is a root
devDependency; `pnpm install` on Node 22 only warns about the engine, but the `mutator` command
itself requires Node 24. The excluded paths (`__tests__`, `__fixtures__`, `src/index.ts`) are
kept in step with Stryker in `packages/ar-saml/mutator.config.json`. Note that editing a
`package.json` or the lockfile invalidates the whole mutator cache; source and test edits only
re-run the affected functions.

Undetected mutants are grouped by where the tests stopped short: _not reached_ (no test runs the
code), _not infected_ (tests run it, but never with an input that changes the value, for example
a boundary) and _not detected_ (tests run it, nothing fails). Mutants judged equivalent are
recorded with `npx mutator accept <key> --reason "..."` in `mutator.accepted.json` (committed).
The cache and reports live in `.mutator/` (git-ignored). mutator officially targets Vitest 5;
it currently runs on this repository's Vitest 4.1 as well.

Opting another package in:

```bash
cd packages/<name>
printf "import { createStrykerConfig } from '../../stryker.base.mjs';\n\nexport default createStrykerConfig();\n" > stryker.config.mjs
# add "test:mutation": "stryker run" to the package's scripts, then:
pnpm test:mutation --dryRunOnly   # verifies the test suite runs under Stryker
```

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
