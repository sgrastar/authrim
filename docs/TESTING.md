# Testing Strategy

This document describes the comprehensive testing strategy for Authrim, covering unit tests, integration tests, E2E tests, accessibility tests, and performance tests.

## Test Coverage Overview

| Test Type | Tool | Coverage | Status |
|-----------|------|----------|--------|
| Unit Tests | Vitest | Backend API, Durable Objects, UI Components | ✅ Implemented |
| Integration Tests | Vitest | Authorization flows, security headers | ✅ Implemented |
| E2E Tests | Playwright | User flows, UI functionality | ✅ Implemented |
| Accessibility Tests | axe-core + Playwright | WCAG 2.1 AA compliance | ✅ Implemented |
| Performance Tests | Lighthouse CI | Core Web Vitals, page speed | ✅ Implemented |

## Unit Tests

### Backend & Durable Objects

**Location**: `test/`, `packages/shared/src/durable-objects/__tests__/`

**Test Count**: 400+ tests across 25+ files

**Key Test Suites**:
- **Durable Objects** (54 tests):
  - `AuthorizationCodeStore`: Code issuance, validation, replay attack prevention (16 tests)
  - `SessionStore`: Session creation, hot/cold storage, multi-device support (17 tests)
  - `RefreshTokenRotator`: Token rotation, theft detection, audit logging (21 tests)
  - `KeyManager`: JWK management, key rotation
- **Handlers** (378 tests):
  - Authorization endpoint
  - Token endpoint
  - UserInfo endpoint
  - Client registration
  - Token refresh/introspection/revocation
- **Storage Adapters** (74 tests):
  - Cloudflare D1/KV adapters

**Running Unit Tests**:
```bash
# Run all unit tests
pnpm test

# Run tests with coverage
pnpm test --coverage

# Run specific package tests
pnpm --filter=shared test
```

### UI Components

**Location**: `packages/ui/src/lib/components/`

**Framework**: Vitest + Svelte Testing Library

**Coverage**:
- Spinner component (11 tests)
- Other components covered by E2E tests

**Running UI Tests**:
```bash
pnpm --filter=ui test
pnpm --filter=ui test:coverage
```

## Integration Tests

**Location**: `test/integration/`

**Key Test Suites**:
- **Authorization Flow** (`authorization-flow.test.ts`):
  - Complete OAuth 2.0/OIDC flow
  - PKCE verification
  - Token issuance and validation
- **Durable Objects** (`durable-objects.test.ts`):
  - Cross-DO communication
  - State consistency
- **Security Headers** (`security-headers.test.ts`):
  - CSP, HSTS, X-Frame-Options
  - CORS configuration

## E2E Tests

**Location**: `test-e2e/`

**Framework**: Playwright

**Browser**: Chromium (can be extended to Firefox, WebKit)

**Test Suites**:
- `homepage.spec.ts`: Homepage load, title, keyboard navigation, language switcher (4 tests)
- `accessibility.spec.ts`: WCAG 2.1 AA compliance for all pages (15+ tests)

**Running E2E Tests**:
```bash
# Run E2E tests
pnpm test:e2e

# Run with UI mode (interactive)
pnpm test:e2e:ui

# Run in headed mode (see browser)
pnpm test:e2e:headed

# Debug mode
pnpm test:e2e:debug
```

**Playwright Configuration**:
- Base URL: `http://localhost:4173` (preview server)
- Automatic server startup via `webServer` option
- Screenshots on failure
- Video recording on failure
- Trace on first retry

## Accessibility Tests

**Framework**: axe-core + Playwright

**Standards**: WCAG 2.1 Level A & AA

**Test Coverage**:
- **5 Pages**: Homepage, Login, Register, Consent, Error
- **Color Contrast**: WCAG 2.1 AA (4.5:1 for normal text, 3:1 for large text)
- **Keyboard Navigation**: Tab order, focus indicators, focus management
- **ARIA Labels**: Valid attributes, required attributes, allowed attributes
- **Form Labels**: All form inputs have associated labels

**Accessibility Rules Tested**:
- `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` tags
- Color contrast requirements
- ARIA attribute validation
- Form label validation
- Focus order semantics

**Running Accessibility Tests**:
```bash
# E2E tests include accessibility checks
pnpm test:e2e test-e2e/accessibility.spec.ts
```

## Performance Tests

**Framework**: Lighthouse CI

**Configuration**: `lighthouserc.json`

**Target Scores** (minimum):
- **Performance**: 90+
- **Accessibility**: 90+
- **Best Practices**: 90+
- **SEO**: 90+

**Core Web Vitals Targets**:
- **First Contentful Paint (FCP)**: < 2000ms
- **Largest Contentful Paint (LCP)**: < 2500ms
- **Cumulative Layout Shift (CLS)**: < 0.1
- **Total Blocking Time (TBT)**: < 300ms

**Pages Tested**:
- Homepage (`/`)
- Login page (`/login`)
- Register page (`/register`)
- Error page (`/error`)

**Running Performance Tests**:
```bash
# Run Lighthouse CI
pnpm test:lighthouse

# Collect only
pnpm test:lighthouse:collect

# Assert only (after collect)
pnpm test:lighthouse:assert
```

## CI/CD Integration

**GitHub Actions Workflow**: `.github/workflows/ci.yml`

**Jobs**:
1. **lint-and-test**: Lint, TypeCheck, Unit Tests, Build, Format Check
2. **e2e-and-accessibility**: E2E tests with accessibility checks
3. **lighthouse**: Performance tests

**Artifacts**:
- Playwright test reports (30-day retention)
- Lighthouse CI reports (30-day retention)

## Test Coverage Goals

- **Unit Test Coverage**: 80%+ (measured with Vitest coverage)
- **E2E Coverage**: All critical user flows
- **Accessibility Compliance**: 100% WCAG 2.1 AA (zero violations)
- **Performance**: 90+ Lighthouse scores across all categories

## Running All Tests

```bash
# Unit tests only
pnpm test

# E2E tests only
pnpm test:e2e

# Performance tests only
pnpm test:lighthouse

# All tests (sequentially)
pnpm test && pnpm test:e2e && pnpm test:lighthouse
```

## Continuous Monitoring

- **GitHub Actions**: Automated testing on every push and PR
- **Pre-commit Hooks**: Lint and type checking (optional)
- **Performance Monitoring**: Lighthouse CI tracks performance regressions

## Future Enhancements

- [ ] Visual regression testing (Percy, Chromatic)
- [ ] Load testing (k6, Artillery)
- [ ] Security scanning (OWASP ZAP)
- [ ] Mutation testing (Stryker)
- [ ] Contract testing (Pact)
