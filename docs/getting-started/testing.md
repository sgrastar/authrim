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

| Test Type         | Tool            | Purpose                       | Location            |
| ----------------- | --------------- | ----------------------------- | ------------------- |
| **Unit**          | Vitest          | Backend API, DOs, Components  | `packages/*/test/`  |
| **Integration**   | Vitest          | Authorization flows, security | `test/integration/` |
| **E2E**           | Playwright      | User flows, UI functionality  | `test-e2e/`         |
| **Accessibility** | axe-core        | WCAG 2.1 AA compliance        | `test-e2e/`         |
| **Performance**   | Lighthouse CI   | Core Web Vitals               | `lighthouserc.json` |
| **Load**          | k6              | Performance at scale          | `load-testing/`     |
| **Conformance**   | OIDC Foundation | OpenID certification          | (separate setup)    |

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
CLIENT_ID=xxx CLIENT_SECRET=yyy ADMIN_API_SECRET=zzz \
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
