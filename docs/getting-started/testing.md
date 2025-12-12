# Testing Guide

This guide covers Authrim's comprehensive testing strategy including unit tests, integration tests, E2E tests, conformance tests, and load testing.

## Table of Contents

- [Test Overview](#test-overview)
- [Unit Tests](#unit-tests)
- [Integration Tests](#integration-tests)
- [E2E Tests](#e2e-tests)
- [Accessibility Tests](#accessibility-tests)
- [Performance Tests](#performance-tests)
- [OIDC Conformance Tests](#oidc-conformance-tests)
- [Load Testing](#load-testing)
- [CI/CD Integration](#cicd-integration)
- [Running All Tests](#running-all-tests)

---

## Test Overview

| Test Type | Tool | Purpose | Location |
|-----------|------|---------|----------|
| **Unit** | Vitest | Backend API, DOs, Components | `packages/*/test/` |
| **Integration** | Vitest | Authorization flows, security | `test/integration/` |
| **E2E** | Playwright | User flows, UI functionality | `test-e2e/` |
| **Accessibility** | axe-core | WCAG 2.1 AA compliance | `test-e2e/` |
| **Performance** | Lighthouse CI | Core Web Vitals | `lighthouserc.json` |
| **Conformance** | OIDC Foundation | OpenID certification | `conformance/` |
| **Load** | k6 | Performance at scale | `load-testing/` |

---

## Unit Tests

### Running Unit Tests

```bash
# Run all unit tests
pnpm test

# Run with coverage
pnpm test --coverage

# Run specific package tests
pnpm --filter=shared test
pnpm --filter=op-token test

# Run in watch mode
pnpm --filter=shared test -- --watch
```

### Test Structure

```
packages/
├── shared/test/
│   ├── durable-objects/     # DO unit tests
│   │   ├── AuthorizationCodeStore.test.ts
│   │   ├── SessionStore.test.ts
│   │   └── RefreshTokenRotator.test.ts
│   └── utils/               # Utility function tests
├── op-auth/test/            # Authorization endpoint tests
├── op-token/test/           # Token endpoint tests
├── op-userinfo/test/        # UserInfo endpoint tests
└── op-management/test/      # Admin API tests
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

| Suite | Description |
|-------|-------------|
| `authorization-flow.test.ts` | Complete OAuth 2.0/OIDC flows with PKCE |
| `durable-objects.test.ts` | Cross-DO communication, state consistency |
| `security-headers.test.ts` | CSP, HSTS, X-Frame-Options, CORS |

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

| Metric | Target |
|--------|--------|
| Performance | 90+ |
| Accessibility | 90+ |
| Best Practices | 90+ |
| SEO | 90+ |

### Core Web Vitals

| Metric | Target |
|--------|--------|
| First Contentful Paint (FCP) | < 2000ms |
| Largest Contentful Paint (LCP) | < 2500ms |
| Cumulative Layout Shift (CLS) | < 0.1 |
| Total Blocking Time (TBT) | < 300ms |

---

## OIDC Conformance Tests

Run OpenID Foundation certification tests against Authrim.

### Running Conformance Tests

```bash
# Run specific test plan
pnpm conformance:basic     # Basic OP tests
pnpm conformance:config    # Config OP tests
pnpm conformance:dynamic   # Dynamic OP tests
pnpm conformance:fapi2     # FAPI 2.0 tests

# Run all plans
pnpm conformance:all

# View test details
pnpm conformance:details
pnpm conformance:errors    # Failed tests only
```

### Test Plans

| Plan | Description | Module Count |
|------|-------------|--------------|
| `basic-op` | Standard OIDC Provider | ~60 modules |
| `config-op` | Configuration endpoint | ~30 modules |
| `dynamic-op` | Dynamic client registration | ~40 modules |
| `fapi2-op` | Financial-grade API 2.0 | ~50 modules |

### How It Works

1. Creates test plan on OIDC Conformance Suite
2. Registers test client dynamically
3. Runs each test module with browser automation
4. Handles user interactions (login, consent)
5. Collects and reports results

### Configuration

**Files**:
- `conformance/config/*.json` - Test plan configurations
- `conformance/scripts/` - Automation scripts

**Environment Variables** (optional):
```bash
CONFORMANCE_SUITE_URL=https://www.certification.openid.net
```

---

## Load Testing

Test Authrim's performance under realistic load using k6.

### Quick Start

```bash
cd load-testing

# 1. Setup test environment
node scripts/setup-test-clients.js

# 2. Seed test data
node scripts/seed-authcodes.js

# 3. Run load test
k6 run test2-light-10vu.js
```

### Test Scenarios

| Scenario | Description | VUs | Duration |
|----------|-------------|-----|----------|
| Light | Basic functionality | 10 | 1min |
| Medium | Moderate load | 50 | 5min |
| Heavy | Stress testing | 100+ | 10min |
| Distributed | Multi-client simulation | 30+ | 15min |

### Key Metrics

| Metric | Target |
|--------|--------|
| p95 Latency | < 500ms |
| p99 Latency | < 1000ms |
| Success Rate | > 99.9% |
| Token Rotation | > 99% |

### Scripts

```
load-testing/scripts/
├── setup-test-clients.js     # Create OAuth test clients
├── seed-authcodes.js         # Generate auth codes
├── seed-refresh-tokens.js    # Generate refresh tokens
├── test-refresh.js           # Token rotation test
├── report-cf-analytics.js    # Cloudflare metrics
└── report-generate.js        # Generate reports
```

### Cloudflare Analytics

```bash
# Get performance metrics after load test
CF_API_TOKEN="your_token" node scripts/report-cf-analytics.js \
  --start "2025-01-01T00:00:00Z" \
  --end "2025-01-01T01:00:00Z"
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
# All tests (except conformance and load)
pnpm test                  # Unit tests
pnpm test:e2e              # E2E + Accessibility
pnpm test:lighthouse       # Performance
```

### Comprehensive Testing

```bash
# Run everything
pnpm test && \
pnpm test:e2e && \
pnpm test:lighthouse && \
pnpm conformance:basic
```

---

## Test Coverage Goals

| Category | Target |
|----------|--------|
| Unit Test Coverage | 80%+ |
| E2E Coverage | All critical flows |
| Accessibility | 100% WCAG 2.1 AA |
| Performance | 90+ Lighthouse |
| Conformance | All plans passing |

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

### Conformance Test Failures

```bash
# Check detailed errors
pnpm conformance:errors

# View specific test
pnpm conformance:details --test-id=xxx
```

---

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [Playwright Documentation](https://playwright.dev/)
- [Lighthouse CI](https://github.com/GoogleChrome/lighthouse-ci)
- [k6 Documentation](https://k6.io/docs/)
- [OpenID Conformance Suite](https://www.certification.openid.net/)
