# Enrai Task Breakdown

This document provides a comprehensive, week-by-week breakdown of all tasks required to build and certify the Enrai OpenID Connect Provider.

**Related Documents:**
- [Project Schedule](./SCHEDULE.md) - High-level timeline and milestones
- [Kickoff Checklist](./KICKOFF.md) - Week 1 immediate actions
- [Technical Specifications](../architecture/technical-specs.md) - What we're building
- [Conformance Test Plan](../conformance/test-plan.md) - How we'll validate compliance

---

## Phase 1: Foundation (Nov 10 - Dec 15, 2025)

### Week 1: Project Structure & Environment Setup (Nov 10-16)

#### 1.1 Project Initialization
- [x] Initialize Git repository structure
- [x] Create `.gitignore` file for Node.js/TypeScript
- [x] Create directory structure:
  - [x] `src/` - Source code
  - [x] `src/handlers/` - Endpoint handlers
  - [x] `src/utils/` - Utility functions
  - [x] `src/types/` - TypeScript type definitions
  - [x] `test/` - Test files
  - [x] `docs/` - Documentation
  - [x] `.github/workflows/` - GitHub Actions

#### 1.2 Package Management
- [x] Create `package.json` with project metadata
- [x] Install dependencies:
  - [x] `hono` - Web framework
  - [x] `jose` - JWT/JWK library
  - [x] `@cloudflare/workers-types` - TypeScript types
  - [x] `wrangler` - Cloudflare Workers CLI
- [x] Install dev dependencies:
  - [x] `typescript`
  - [x] `vitest` - Testing framework
  - [x] `@types/node`
  - [x] `prettier` - Code formatting
  - [x] `eslint` - Linting

#### 1.3 TypeScript Configuration
- [x] Create `tsconfig.json` with appropriate settings:
  - [x] Target: ES2022
  - [x] Module: ESNext
  - [x] Strict mode enabled
  - [x] Path aliases configured
- [x] Configure build output to `dist/`

#### 1.4 Cloudflare Workers Configuration
- [x] Create `wrangler.toml` configuration:
  - [x] Set worker name: `enrai`
  - [x] Configure compatibility date
  - [x] Set main entry point
  - [x] Define KV namespace bindings
  - [x] Configure environment variables
- [x] Set up local development environment
- [x] Test `wrangler dev` command

#### 1.5 Code Quality Tools
- [x] Create `.prettierrc` configuration
- [x] Create `.eslintrc.json` configuration
- [ ] Add pre-commit hooks with Husky (optional)
- [x] Configure VSCode settings (`.vscode/settings.json`)

---

### Week 2: Hono Framework Integration (Nov 17-23)

#### 2.1 Basic Hono Application
- [x] Create `src/index.ts` as main entry point
- [x] Initialize Hono app with TypeScript generics for Cloudflare Workers
- [x] Configure CORS middleware (disabled by default)
- [x] Add security headers middleware
- [x] Add request logging middleware

#### 2.2 Health Check Endpoint
- [x] Implement `GET /health` endpoint
- [x] Return JSON with status and version
- [x] Add timestamp to health check response

#### 2.3 Basic Routing Structure
- [x] Create route handlers in `src/handlers/`:
  - [x] `discovery.ts` - Discovery endpoint handler
  - [x] `jwks.ts` - JWKS endpoint handler
  - [x] `authorize.ts` - Authorization endpoint handler
  - [x] `token.ts` - Token endpoint handler
  - [x] `userinfo.ts` - UserInfo endpoint handler
- [x] Register routes in main app
- [x] Add 404 handler
- [x] Add error handling middleware

#### 2.4 Environment Types
- [x] Define `Env` interface for Cloudflare bindings:
  - [x] KV namespace type
  - [x] Environment variables
  - [x] Secrets
- [x] Create type definitions for request/response objects

---

### Week 3: Cloudflare Services Integration (Nov 24-30)

#### 3.1 KV Storage Setup
- [x] Create KV namespace via Wrangler CLI
- [x] Configure KV bindings in `wrangler.toml`
- [x] Create KV utility functions:
  - [x] `storeAuthCode()` - Store authorization code
  - [x] `getAuthCode()` - Retrieve authorization code
  - [x] `deleteAuthCode()` - Delete used code
  - [x] `storeState()` - Store state parameter
  - [x] `storeNonce()` - Store nonce parameter
- [x] Add TTL configuration (120s for codes, 300s for state/nonce)
- [x] Test KV operations locally

#### 3.2 JOSE Library Integration
- [x] Install and configure `jose` library
- [x] Create key generation utilities:
  - [x] `generateRSAKeyPair()` - Generate RS256 key pair
  - [x] `exportPublicJWK()` - Export public key as JWK
  - [x] `exportPrivateKey()` - Export private key (PEM format)
- [x] Test JWT signing and verification
- [x] Test JWK export format

#### 3.3 Durable Objects Planning
- [x] Design Durable Object schema for key storage
- [x] Create `KeyManager` Durable Object class
- [x] Implement key rotation logic (planned for Phase 4)
- [x] Document Durable Objects architecture

#### 3.4 Secret Management
- [x] Generate RSA key pair for development
- [x] Store private key in Wrangler secrets
- [x] Create script to rotate keys
- [x] Document secret management process

---

### Week 4: Authentication & Testing Framework (Dec 1-7)

#### 4.1 JWT Token Utilities
- [x] Create `src/utils/jwt.ts`:
  - [x] `createIDToken()` - Generate ID token with claims
  - [x] `createAccessToken()` - Generate access token
  - [x] `verifyToken()` - Verify JWT signature
  - [x] `parseToken()` - Parse JWT without verification
- [x] Add proper error handling for JWT operations
- [x] Test with different claim sets

#### 4.2 Validation Utilities
- [x] Create `src/utils/validation.ts`:
  - [x] `validateClientId()` - Validate client_id format
  - [x] `validateRedirectUri()` - Validate redirect_uri
  - [x] `validateScope()` - Validate scope parameter
  - [x] `validateState()` - Validate state parameter
  - [x] `validateNonce()` - Validate nonce parameter
  - [x] `validateGrantType()` - Validate grant_type
- [x] Add regex patterns for validation
- [x] Test edge cases

#### 4.3 Testing Framework Setup
- [x] Configure Vitest for unit testing
- [x] Create test utilities:
  - [x] Mock Cloudflare Workers environment
  - [x] Mock KV storage
  - [x] Test data generators
- [x] Write sample tests for utilities
- [x] Set up test coverage reporting

#### 4.4 Integration Test Setup
- [x] Install testing dependencies for e2e tests
- [x] Create test fixtures (mock RP)
- [x] Set up local Cloudflare Workers testing environment
- [x] Create integration test skeleton

---

### Week 5: CI/CD & Documentation (Dec 8-15)

#### 5.1 GitHub Actions CI/CD
- [x] Create `.github/workflows/ci.yml`:
  - [x] Run on push and pull requests
  - [x] Install dependencies
  - [x] Run linter
  - [x] Run type checking
  - [x] Run tests
  - [x] Build project
- [x] Create `.github/workflows/deploy.yml`:
  - [x] Deploy to Cloudflare Workers on merge to main
  - [x] Use Wrangler action
  - [x] Configure secrets

#### 5.2 Development Documentation
- [x] Create `CONTRIBUTING.md` guide
- [x] Create `DEVELOPMENT.md` with setup instructions
- [x] Document environment variable setup
- [x] Create API documentation template
- [x] Add code examples for common operations

#### 5.3 Code Review & Refactoring
- [x] Review all code from Weeks 1-4
- [x] Refactor for consistency
- [x] Ensure proper TypeScript typing
- [x] Add inline documentation (JSDoc)
- [x] Update README with current status

#### 5.4 Milestone 1 Review
- [x] Verify `wrangler dev` works
- [x] Test basic routing
- [x] Verify TypeScript builds
- [x] Check all linting passes
- [x] Ensure tests pass
- [x] Document any blockers or issues

---

## Phase 2: Core Implementation (Dec 16, 2025 - Jan 31, 2026) ✅ COMPLETE

### Week 6: Discovery & JWKS Endpoints (Dec 16-22) ✅

#### 6.1 Discovery Endpoint Implementation ✅
- [x] Implement `GET /.well-known/openid-configuration`
- [x] Return metadata JSON:
  - [x] `issuer` - From environment variable
  - [x] `authorization_endpoint`
  - [x] `token_endpoint`
  - [x] `userinfo_endpoint`
  - [x] `jwks_uri`
  - [x] `response_types_supported`: `["code"]`
  - [x] `grant_types_supported`: `["authorization_code"]`
  - [x] `id_token_signing_alg_values_supported`: `["RS256"]`
  - [x] `subject_types_supported`: `["public"]`
  - [x] `scopes_supported`: `["openid", "profile", "email"]`
  - [x] `claims_supported`
- [x] Add proper content-type header
- [x] Test with curl and browser

#### 6.2 JWKS Endpoint Implementation ✅
- [x] Implement `GET /.well-known/jwks.json`
- [x] Load public key from environment/Durable Object
- [x] Convert RSA public key to JWK format
- [x] Return JWKS JSON with:
  - [x] `kty`: "RSA"
  - [x] `alg`: "RS256"
  - [x] `use`: "sig"
  - [x] `kid`: from environment variable
  - [x] `n`: modulus (base64url)
  - [x] `e`: exponent (base64url)
- [x] Add cache headers
- [x] Test JWK format with validators

#### 6.3 Testing ✅
- [x] Unit tests for discovery endpoint (14 tests)
- [x] Unit tests for JWKS endpoint (15 tests)
- [x] Verify metadata format compliance
- [x] Verify JWK format compliance
- [x] Test with OpenID Connect validators

---

### Week 7: Authorization Endpoint (Dec 23-29) ✅

#### 7.1 Authorization Request Handling ✅
- [x] Implement `GET /authorize` and `POST /authorize`
- [x] Parse query parameters:
  - [x] `response_type` (required)
  - [x] `client_id` (required)
  - [x] `redirect_uri` (required)
  - [x] `scope` (required)
  - [x] `state` (optional but recommended)
  - [x] `nonce` (optional)
- [x] Validate all parameters
- [x] Return errors for invalid requests

#### 7.2 Authorization Code Generation ✅
- [x] Generate secure random authorization code (UUID v4)
- [x] Store code in KV with metadata:
  - [x] `client_id`
  - [x] `redirect_uri`
  - [x] `scope`
  - [x] `nonce`
  - [x] `timestamp`
- [x] Set TTL to 120 seconds
- [x] Test code generation and storage

#### 7.3 State & Nonce Management ✅
- [x] Store state parameter in KV
- [x] Store nonce parameter if provided
- [x] Link state/nonce to authorization code
- [x] Add replay protection (PKCE support)

#### 7.4 Redirect Response ✅
- [x] Build redirect URL with:
  - [x] `code` parameter
  - [x] `state` parameter (if provided in request)
- [x] Return 302 redirect
- [x] Handle error cases with proper error responses
- [x] Test redirect flow

#### 7.5 Testing ✅
- [x] Unit tests for parameter validation (21 tests)
- [x] Integration tests for authorization flow
- [x] Test error scenarios:
  - [x] Missing required parameters
  - [x] Invalid client_id
  - [x] Invalid redirect_uri
  - [x] Unsupported response_type

---

### Week 8: Token Endpoint (Dec 30 - Jan 5) ✅

#### 8.1 Token Request Handling ✅
- [x] Implement `POST /token`
- [x] Parse form-encoded body:
  - [x] `grant_type` (required, must be "authorization_code")
  - [x] `code` (required)
  - [x] `client_id` (required)
  - [x] `redirect_uri` (required)
  - [x] `client_secret` (if applicable)
- [x] Validate content-type header
- [x] Validate all parameters

#### 8.2 Authorization Code Validation ✅
- [x] Retrieve code from KV
- [x] Verify code exists and not expired
- [x] Validate client_id matches
- [x] Validate redirect_uri matches
- [x] Mark code as used (single use, with reuse detection)
- [x] Return error if validation fails

#### 8.3 ID Token Generation ✅
- [x] Load private key from secrets
- [x] Create ID token claims:
  - [x] `iss` - Issuer URL
  - [x] `aud` - client_id
  - [x] `sub` - User identifier
  - [x] `iat` - Issued at timestamp
  - [x] `exp` - Expiration timestamp (iat + TTL)
  - [x] `nonce` - If provided in auth request
  - [x] `at_hash` - Access token hash (OIDC requirement)
- [x] Sign token with RS256
- [x] Set proper kid in header

#### 8.4 Access Token Generation ✅
- [x] Generate access token (JWT)
- [x] Include necessary claims (iss, sub, aud, scope, jti)
- [x] Sign token with RS256
- [x] Set expiration

#### 8.5 Token Response ✅
- [x] Return JSON response:
  - [x] `access_token`
  - [x] `id_token`
  - [x] `token_type`: "Bearer"
  - [x] `expires_in`: TTL in seconds
- [x] Add proper headers (content-type, no-cache)
- [x] Test response format

#### 8.6 Testing ✅
- [x] Unit tests for token generation (JWT tests: 16 tests)
- [x] Integration tests for token exchange
- [x] Test error scenarios:
  - [x] Invalid grant_type
  - [x] Invalid or expired code
  - [x] Mismatched client_id
  - [x] Mismatched redirect_uri
  - [x] Authorization code reuse attack detection
- [x] Verify JWT format and signature
- [x] PKCE verification tests

---

### Week 9: UserInfo Endpoint (Jan 6-12) ✅

#### 9.1 UserInfo Request Handling ✅
- [x] Implement `GET /userinfo` and `POST /userinfo`
- [x] Parse Authorization header
- [x] Extract Bearer token
- [x] Validate token format

#### 9.2 Access Token Validation ✅
- [x] Verify JWT signature
- [x] Check token expiration
- [x] Extract subject (sub) claim
- [x] Handle validation errors
- [x] Check token revocation status

#### 9.3 User Claims Response ✅
- [x] Return user claims JSON:
  - [x] `sub` - User identifier
  - [x] `name` - User name (if requested)
  - [x] `email` - User email (if requested)
  - [x] `email_verified` - Boolean
  - [x] Additional claims based on scope (profile, email, address, phone)
- [x] Static user data for MVP
- [x] Plan for dynamic user data (future)
- [x] Support for claims parameter (OIDC Core 5.5)

#### 9.4 Testing ✅
- [x] Unit tests for token validation
- [x] Integration tests for userinfo flow
- [x] Test with valid tokens
- [x] Test with invalid/expired tokens
- [x] Test with missing Authorization header
- [x] Test scope-based claim filtering

---

### Week 10: Error Handling & Validation (Jan 13-19) ✅

#### 10.1 OAuth 2.0 Error Responses ✅
- [x] Implement standard error responses:
  - [x] `invalid_request`
  - [x] `invalid_client`
  - [x] `invalid_grant`
  - [x] `unauthorized_client`
  - [x] `unsupported_grant_type`
  - [x] `invalid_scope`
  - [x] `server_error`
  - [x] `invalid_token`
  - [x] `access_denied`
  - [x] `unsupported_response_type`
- [x] Add error descriptions
- [x] Test all error scenarios
- [x] Error factory functions (errors.ts)

#### 10.2 OIDC Error Responses ✅
- [x] Implement OIDC-specific errors:
  - [x] `login_required`
  - [x] `interaction_required`
  - [x] `invalid_request_uri`
  - [x] `invalid_request_object`
- [x] Return errors via redirect when appropriate
- [x] Return errors as JSON for token endpoint
- [x] OIDCError class with proper structure

#### 10.3 Input Validation Hardening ✅
- [x] Add strict URL validation
- [x] Validate all string lengths
- [x] Sanitize inputs (validation.ts - 49 tests)
- [x] Add rate limiting (Phase 4 - 44 tests)
- [x] Test injection attacks (SQL, XSS, etc.)
- [x] PKCE validation (code_challenge, code_verifier)

#### 10.4 Logging & Monitoring ✅
- [x] Add structured logging (console.error with context)
- [x] Log authentication attempts
- [x] Log errors and exceptions
- [x] Plan monitoring strategy (security headers, CORS)
- [x] Test logging output

---

### Week 11: Integration Testing (Jan 20-26) ✅

#### 11.1 End-to-End Test Scenarios ✅
- [x] Create mock Relying Party application
- [x] Test complete authorization code flow:
  - [x] Discovery
  - [x] Authorization request
  - [x] Token exchange
  - [x] UserInfo request
- [x] Verify ID token validation
- [x] Test with multiple clients
- [x] Integration test file: authorization-flow.test.ts

#### 11.2 Negative Test Cases ✅
- [x] Test with expired codes
- [x] Test with invalid signatures
- [x] Test with mismatched parameters
- [x] Test with malformed requests
- [x] Test concurrent requests
- [x] Authorization code reuse attack tests

#### 11.3 Performance Testing ✅
- [x] Measure endpoint latency
- [x] Test under load (basic)
- [x] Identify bottlenecks
- [x] Document performance metrics (README: <100ms p95)
- [x] Cache optimization (Discovery, JWKS endpoints)

#### 11.4 Bug Fixes ✅
- [x] Fix issues found in testing
- [x] Regression testing
- [x] Update documentation

---

### Week 12: Code Review & Refactoring (Jan 27-31) ✅

#### 12.1 Code Quality Review ✅
- [x] Review all code for consistency
- [x] Ensure TypeScript types are complete
- [x] Remove dead code
- [x] Optimize imports
- [x] Check for security issues
- [x] Zero TypeScript errors

#### 12.2 Documentation Update ✅
- [x] Update API documentation
- [x] Add sequence diagrams (docs/)
- [x] Document error codes (errors.ts)
- [x] Add troubleshooting guide (DEVELOPMENT.md)
- [x] Update README (comprehensive)

#### 12.3 Refactoring ✅
- [x] Extract common logic to utilities
- [x] Improve error handling (OIDCError class)
- [x] Optimize performance (caching, key reuse)
- [x] Add code comments where needed (JSDoc)

#### 12.4 Milestone 2 Review ✅
- [x] Verify all endpoints work
- [x] Run full test suite (263 tests passing)
- [x] Test manual authorization flow
- [x] Verify JWT signatures
- [x] Check spec compliance (OIDC Core 1.0)
- [x] Document any remaining issues
- [x] Phase 3 Conformance testing: 23/24 tests passed (95.8%)

---

## Phase 3: Testing & Validation (Feb 1 - Mar 15, 2026) ✅ COMPLETE

### Week 13: Conformance Suite Setup (Feb 1-7) ✅

#### 13.1 Environment Setup ✅
- [x] ~~Install Docker and Docker Compose~~ - Used online version instead
- [x] Access OpenID Conformance Suite online
- [x] Configure conformance suite for Basic OP profile
- [x] Deploy to production environment (Cloudflare Workers)

#### 13.2 Configuration ✅
- [x] Configure OP metadata:
  - [x] Issuer URL: https://enrai.sgrastar.workers.dev
  - [x] Client registration: static_client
  - [x] Test credentials
- [x] Configure test plan (oidcc-basic-certification-test-plan)
- [x] Document setup process (docs/conformance/testing-guide.md)

#### 13.3 Initial Test Run ✅
- [x] Run conformance suite (Plan ID: e90FqMh4xG2mg)
- [x] Collect test results (33 tests total)
- [x] Identify failing tests (4 failed, 4 interrupted)
- [x] Prioritize fixes

---

### Week 14-17: Conformance Test Fixes (Feb 8 - Mar 7) ✅

#### 14.1 Discovery & Metadata Tests ✅
- [x] Fix any discovery endpoint issues
- [x] Ensure metadata format compliance
- [x] Test issuer consistency
- [x] Fix JWKS format issues

#### 14.2 Core Flow Tests ✅
- [x] Fix authorization endpoint issues (23 tests PASSED)
- [x] Fix token endpoint issues
- [x] Fix userinfo endpoint issues (GET/POST both methods)
- [x] Ensure proper state handling

#### 14.3 JWT/JWK Tests ✅
- [x] Fix signature verification issues
- [x] Ensure proper kid handling
- [x] Fix claim format issues
- [x] Test token expiration

#### 14.4 OAuth 2.0 Tests ✅
- [x] Fix grant type handling
- [x] Fix error response format
- [x] Test redirect handling
- [x] Fix parameter validation
- [x] Authorization code reuse detection & token revocation

#### 14.5 Edge Cases ✅
- [x] Test clock skew tolerance
- [x] Test nonce verification
- [x] Test replay protection
- [x] Test concurrent flows
- [x] PKCE full support (all unreserved characters)

---

### Week 18: Final Validation (Mar 8-15) ✅

#### 18.1 Complete Test Run ✅
- [x] Run full conformance suite
- [x] Verify core tests pass (23/24 Phase 3 tests)
- [x] Document warnings (1 ACR test - Phase 6)
- [x] Calculate conformance score (72.7% overall, 95.8% Phase 3)

#### 18.2 Test Report ✅
- [x] Create detailed test report (report-20251112.md)
- [x] Document test environment (Cloudflare Workers production)
- [x] List all passing tests (23 tests detailed)
- [x] Explain failing tests (Phase 5-6 requirements)
- [x] Create action plan for remaining issues (Phases 4-6 roadmap)

#### 18.3 Milestone 3 Review ✅
- [x] Verify conformance score: 95.8% for Phase 3 scope (target met)
- [x] Review all test results (33 tests analyzed)
- [x] Document certification readiness (Phase 5 target: ≥85%)
- [x] Plan for extended features (Phases 4-6 detailed)

---

### Phase 3 Test Results Summary ✅

**OpenID Conformance Suite:**
- Plan ID: e90FqMh4xG2mg
- Test Version: 5.1.36
- Test Date: 2025-11-12
- Issuer: https://enrai.sgrastar.workers.dev

| Status | Count | Percentage |
|--------|-------|------------|
| ✅ PASSED | 23 | 69.7% |
| 📋 REVIEW | 1 | 3.0% |
| ⚠️ WARNING | 1 | 3.0% |
| ❌ FAILED | 4 | 12.1% |
| 🔸 INTERRUPTED | 4 | 12.1% |
| ⏭️ SKIPPED | 1 | 3.0% |

**Achievements:**
- ✅ Phase 3 Scope: 23/24 tests = **95.8%** 🎯
- ✅ Overall Score: 24/33 tests = **72.7%**
- ✅ All core OIDC features validated
- ✅ All standard scopes working (openid, profile, email, address, phone)
- ✅ Token revocation on code reuse (RFC 6749 Section 4.1.2)
- ✅ Claims parameter support (OIDC Core 5.5)
- ✅ PKCE full support (RFC 7636)
- ✅ 263 unit/integration tests passing

**Deferred to Future Phases:**
- Phase 4: Refresh token (1 test)
- Phase 5: Request Object/JAR, Dynamic Registration (3 tests)
- Phase 6: Session management, Login UI (8 tests)

---

## Phase 4: Extended Features (Mar 16 - Apr 30, 2026) ⏳ IN PROGRESS

### Week 19-20: Dynamic Client Registration (Mar 16-29) ✅

#### 19.1 Registration Endpoint ✅
- [x] Implement `POST /register`
- [x] Parse registration request
- [x] Validate client metadata
- [x] Generate client_id and client_secret

#### 19.2 Client Storage ✅
- [x] Store client metadata in KV/Durable Objects
- [x] Implement client lookup
- [x] Support client updates
- [x] Test registration flow

#### 19.3 Testing ✅
- [x] Unit tests for registration (56 tests)
- [x] Integration tests
- [x] Conformance suite tests (if applicable)

---

### Week 21-22: Key Rotation & Extended Claims (Mar 30 - Apr 12) ✅

#### 21.1 Key Rotation ✅
- [x] Implement KeyManager Durable Object
- [x] Add key rotation logic
- [x] Support multiple active keys
- [x] Update JWKS endpoint for multiple keys

#### 21.2 Extended Claims ✅
- [x] Add support for `email` claim
- [x] Add support for `profile` claims
- [x] Add support for custom claims
- [x] Test claim handling

#### 21.3 Nonce Enforcement ✅
- [x] Make nonce mandatory (configurable)
- [x] Strengthen nonce validation
- [x] Add replay protection
- [x] Test nonce handling

---

### Week 23-24: Security & Performance (Apr 13-26) ✅

#### 23.1 Security Audit ✅
- [x] Review authentication logic
- [x] Check for injection vulnerabilities
- [x] Review token handling
- [x] Check for timing attacks
- [x] Test CORS configuration (41 tests)
- [x] Review secret management

#### 23.2 Performance Optimization ✅
- [x] Profile endpoint performance
- [x] Optimize KV operations
- [x] Add caching where appropriate (Discovery endpoint)
- [x] Test under load
- [x] Measure edge latency

#### 23.3 Rate Limiting ✅
- [x] Implement basic rate limiting (44 tests)
- [x] Use Cloudflare rate limiting features
- [x] Test rate limiting
- [x] Document limits

---

### Week 25: Review & Documentation (Apr 27-30) ✅

#### 25.1 Final Review ✅
- [x] Code review
- [x] Security review
- [x] Performance review
- [x] Documentation review

#### 25.2 Milestone 4 Review ✅
- [x] Verify all extended features work
- [x] Run conformance tests (263 tests passing)
- [x] Update documentation
- [x] Prepare for production deployment

**Phase 4 Completed Features:**
- ✅ Dynamic Client Registration (RFC 7591) - 56 tests
- ✅ Rate Limiting Middleware - 44 tests
- ✅ Security Headers & CORS - 41 tests
- ✅ Extended Claims Support - Full OIDC profile
- ✅ KeyManager Durable Object - Multi-key rotation
- ✅ Token Management (Refresh Token, Introspection, Revocation) - 47+ tests, RFC 6749/7662/7009
- ✅ PAR (Pushed Authorization Requests) - 15+ tests, RFC 9126
- ✅ Form Post Response Mode - 19 tests, OAuth 2.0 Form Post
- ✅ **DPoP (Demonstrating Proof of Possession)** - 12 tests, RFC 9449
- ✅ **Pairwise Subject Identifiers** - 22 tests, OIDC Core 8.1
- ✅ **Storage Foundation** - Abstract interfaces for Phase 6
- ✅ **Total: 378+ tests passing** (200+ new Phase 4 tests)

**Phase 4 Documentation:**
- ✅ Token Management Guide (docs/features/token-management.md)
- ✅ PAR Implementation Guide (docs/features/par.md)
- ✅ Form Post Response Mode Guide (docs/features/form-post-response-mode.md)
- ✅ DPoP Implementation (inline code documentation)
- ✅ Pairwise Subject Identifiers (inline code documentation)
- ✅ Storage Abstraction Layer (comprehensive interface documentation)

---

### Phase 4 Remaining Tasks ✅ COMPLETE

#### Advanced Security Extensions

##### PAR (Pushed Authorization Requests) - RFC 9126 ✅
- [x] Implement `POST /as/par` endpoint
- [x] Request object validation
- [x] Request URI generation and storage
- [x] Authorization endpoint PAR support
- [x] Tests & conformance validation (15+ tests)
- [x] Documentation (comprehensive guide)

##### DPoP (Demonstrating Proof of Possession) - RFC 9449 ✅
- [x] DPoP token validation middleware
- [x] DPoP-bound access token generation
- [x] Token endpoint DPoP support
- [x] UserInfo endpoint DPoP support
- [x] Replay attack prevention
- [x] Tests & conformance validation (12 tests)
- [x] Documentation (inline code documentation)

##### Pairwise Subject Identifiers - OIDC Core 8.1 ✅
- [x] Subject type configuration (public/pairwise)
- [x] Pairwise identifier generation (per client)
- [x] Sector identifier validation
- [x] Storage for pairwise mappings
- [x] Tests & conformance validation (22 tests)
- [x] Documentation (inline code documentation)

#### Token Management

##### Refresh Token Flow - RFC 6749 Section 6 ✅
- [x] Refresh token generation
- [x] Refresh token validation
- [x] Token rotation (refresh token)
- [x] Refresh token revocation
- [x] Storage implementation
- [x] Tests & conformance validation (47+ tests)
- [x] Documentation (comprehensive guide)

##### Token Introspection & Revocation - RFC 7662, RFC 7009 ✅
- [x] Implement `POST /introspect` endpoint
- [x] Implement `POST /revoke` endpoint
- [x] Token metadata response
- [x] Client authentication for introspection
- [x] Tests & conformance validation (47+ tests)
- [x] Documentation (comprehensive guide)

#### Response Modes

##### Form Post Response Mode - OAuth 2.0 Form Post ✅
- [x] `response_mode=form_post` support
- [x] Auto-submit HTML form generation
- [x] Authorization endpoint enhancement
- [x] Tests & conformance validation (19 tests)
- [x] Documentation (comprehensive guide)
- [x] XSS prevention with HTML escaping
- [x] User-friendly loading UI with spinner

#### Storage Foundation (Preparation for Phase 6) ✅
- [x] Abstract storage interface design
- [x] D1 schema design (users, clients, sessions)
- [x] Migration system foundation (interfaces defined)
- [x] Storage adapter selection logic (KV adapter implemented)
- [x] Documentation (comprehensive inline documentation)

---

## Ongoing Tasks (Throughout All Phases)

### Documentation Maintenance
- [ ] Keep README up to date
- [ ] Update API docs as features are added
- [ ] Document all configuration options
- [ ] Maintain changelog

### Testing
- [ ] Write tests for all new features
- [ ] Maintain test coverage > 80%
- [ ] Run tests before commits
- [ ] Update tests when refactoring

### Code Quality
- [ ] Run linter regularly
- [ ] Fix type errors immediately
- [ ] Review PRs thoroughly
- [ ] Keep dependencies updated

### Security
- [ ] Monitor security advisories
- [ ] Update dependencies for security patches
- [ ] Review code for vulnerabilities
- [ ] Follow security best practices

---

## Success Metrics

### Code Quality ✅ (Phase 1-4 Complete)
- [x] Test coverage ≥ 80% (Current: ~88%)
- [x] Zero TypeScript errors
- [x] Zero linting errors
- [x] All tests passing (263/263 tests ✅)

### Performance ✅ (Phase 1-4 Complete)
- [x] Endpoint latency < 100ms (p95)
- [x] JWT signing < 10ms
- [x] KV operations < 5ms

### Compliance 🔄 (In Progress - Phase 3)
- [ ] OpenID Conformance Suite ≥ 85% passing (Phase 3)
- [x] All required OIDC endpoints functional
- [x] All required claims supported
- [x] Proper error handling

### Documentation ✅ (Phase 1-4 Complete)
- [x] All endpoints documented
- [x] Setup guide complete
- [x] API reference complete
- [x] Troubleshooting guide complete

### Security ✅ (Phase 4 Complete)
- [x] Rate limiting implemented (3 profiles: strict/moderate/lenient)
- [x] CORS properly configured
- [x] CSP headers configured
- [x] HSTS enabled (2-year max-age)
- [x] XSS protection enabled
- [x] Clickjacking protection (X-Frame-Options: DENY)

### Phase 4 Achievements ✅
- [x] Dynamic Client Registration (RFC 7591) - 56 tests
- [x] Rate Limiting Middleware - 44 tests
- [x] Security Headers & CORS - 41 tests
- [x] Extended Claims (profile, email, address, phone)
- [x] KeyManager Durable Object with rotation
- [x] 85 new comprehensive tests added
- [x] Total: 263 tests passing (0 failures)

---

## Phase 5: UI/UX Implementation (May 1-31, 2026) 🎨

### ステージ1: インフラ基盤構築 (Week 26, Day 1-4: May 1-4)

#### 26.1 D1データベースセットアップ
- [ ] Create D1 database via Wrangler CLI
  ```bash
  wrangler d1 create enrai-production
  ```
- [ ] Configure D1 binding in `wrangler.toml`
- [ ] Test D1 connectivity from Workers
- [ ] Document D1 setup process

#### 26.2 D1 マイグレーション実行
- [ ] Create migration files in `migrations/` directory
  - [ ] `001_initial_schema.sql` - Core tables (users, oauth_clients, sessions)
  - [ ] `002_add_custom_fields.sql` - user_custom_fields, parent_user_id
  - [ ] `003_add_passkeys.sql` - passkeys table
  - [ ] `004_add_roles.sql` - roles, user_roles tables
  - [ ] `005_add_scope_mappings.sql` - scope_mappings table
  - [ ] `006_add_branding.sql` - branding_settings table
  - [ ] `007_add_identity_providers.sql` - identity_providers table (Phase 7用)
  - [ ] `008_add_audit_log.sql` - audit_log table
- [ ] Execute migrations locally: `wrangler d1 execute DB --local --file=./migrations/001_initial_schema.sql`
- [ ] Execute migrations in production: `wrangler d1 execute DB --file=./migrations/001_initial_schema.sql`
- [ ] Verify all tables created: `wrangler d1 execute DB --command "SELECT name FROM sqlite_master WHERE type='table'"`
- [ ] Create rollback scripts for each migration
- [ ] Test migration rollback process
- [ ] Document migration workflow

#### 26.3 シードデータ投入
- [ ] Create seed data script `migrations/seed_default_data.sql`:
  - [ ] Insert default roles (super_admin, admin, viewer, support)
  - [ ] Insert default branding settings
  - [ ] Insert test admin user (for development)
  - [ ] Insert test OAuth client (for testing)
- [ ] Execute seed data locally
- [ ] Execute seed data in production (optional test data)
- [ ] Document seed data structure
- [ ] Create script to generate test data (1000+ users for testing)

#### 26.4 Durable Objects実装 - SessionStore
- [ ] Create `src/durable-objects/SessionStore.ts`
- [ ] Implement SessionStore class:
  - [ ] `constructor()` - Initialize in-memory session map
  - [ ] `fetch()` - Handle HTTP requests
  - [ ] `getSession(sessionId)` - Get session from memory or D1 fallback
  - [ ] `createSession(userId, ttl, data)` - Create new session
  - [ ] `invalidateSession(sessionId)` - Delete session immediately
  - [ ] `listUserSessions(userId)` - Get all sessions for user
  - [ ] `cleanup()` - Remove expired sessions from memory
- [ ] Implement hot/cold pattern (in-memory → D1 fallback)
- [ ] Configure SessionStore in `wrangler.toml`
  ```toml
  [[durable_objects.bindings]]
  name = "SESSION_STORE"
  class_name = "SessionStore"
  script_name = "enrai"
  ```
- [ ] Add unit tests for SessionStore (20+ tests)
- [ ] Test session creation and retrieval
- [ ] Test session expiration and cleanup
- [ ] Test D1 fallback for cold sessions
- [ ] Document SessionStore API

#### 26.5 Durable Objects実装 - AuthorizationCodeStore
- [ ] Create `src/durable-objects/AuthorizationCodeStore.ts`
- [ ] Implement AuthorizationCodeStore class:
  - [ ] `constructor()` - Initialize in-memory code map
  - [ ] `fetch()` - Handle HTTP requests
  - [ ] `store(code, metadata)` - Store authorization code (TTL: 60s)
  - [ ] `consume(code, clientId, codeVerifier)` - Consume code (one-time use)
  - [ ] `cleanup()` - Remove expired codes
- [ ] Implement replay attack prevention (mark as used)
- [ ] Implement PKCE validation (code_challenge, code_verifier)
- [ ] Configure AuthorizationCodeStore in `wrangler.toml`
  ```toml
  [[durable_objects.bindings]]
  name = "AUTH_CODE_STORE"
  class_name = "AuthorizationCodeStore"
  script_name = "enrai"
  ```
- [ ] Add unit tests for AuthorizationCodeStore (15+ tests)
- [ ] Test code storage and consumption
- [ ] Test replay attack detection
- [ ] Test PKCE validation
- [ ] Document AuthorizationCodeStore API

#### 26.6 Durable Objects実装 - RefreshTokenRotator
- [ ] Create `src/durable-objects/RefreshTokenRotator.ts`
- [ ] Implement RefreshTokenRotator class:
  - [ ] `constructor()` - Initialize token family map
  - [ ] `fetch()` - Handle HTTP requests
  - [ ] `rotate(currentToken, userId, clientId)` - Rotate token atomically
  - [ ] `revokeFamilyTokens(familyId)` - Revoke all tokens in family
  - [ ] `logToD1(action, familyId, userId, metadata)` - Audit log
- [ ] Implement token family tracking (detect token theft)
- [ ] Implement theft detection (old token reuse → revoke all)
- [ ] Configure RefreshTokenRotator in `wrangler.toml`
  ```toml
  [[durable_objects.bindings]]
  name = "REFRESH_TOKEN_ROTATOR"
  class_name = "RefreshTokenRotator"
  script_name = "enrai"
  ```
- [ ] Add unit tests for RefreshTokenRotator (18+ tests)
- [ ] Test token rotation
- [ ] Test theft detection
- [ ] Test D1 audit logging
- [ ] Document RefreshTokenRotator API

#### 26.6a Durable Objects - Unit Tests
- [ ] Create test files for each Durable Object:
  - [ ] `packages/shared/src/durable-objects/__tests__/SessionStore.test.ts`
  - [ ] `packages/shared/src/durable-objects/__tests__/AuthorizationCodeStore.test.ts`
  - [ ] `packages/shared/src/durable-objects/__tests__/RefreshTokenRotator.test.ts`
- [ ] SessionStore unit tests (20+ tests):
  - [ ] Test session creation and storage
  - [ ] Test session retrieval (hot and cold)
  - [ ] Test session invalidation
  - [ ] Test session expiration and cleanup
  - [ ] Test multi-device session listing
  - [ ] Test session extension (Active TTL)
  - [ ] Test D1 fallback on memory miss
  - [ ] Test concurrent session access
- [ ] AuthorizationCodeStore unit tests (15+ tests):
  - [ ] Test code storage and retrieval
  - [ ] Test code consumption (one-time use)
  - [ ] Test replay attack detection
  - [ ] Test PKCE validation (S256 and plain)
  - [ ] Test code expiration (60 seconds TTL)
  - [ ] Test client validation
  - [ ] Test DDoS protection (max 5 codes per user)
  - [ ] Test automatic cleanup
- [ ] RefreshTokenRotator unit tests (18+ tests):
  - [ ] Test token family creation
  - [ ] Test atomic token rotation
  - [ ] Test theft detection (old token reuse)
  - [ ] Test family revocation
  - [ ] Test rotation count tracking
  - [ ] Test D1 audit logging
  - [ ] Test token expiration
  - [ ] Test concurrent rotation attempts
- [ ] Run all tests: `pnpm test`
- [ ] Ensure test coverage ≥ 80% for Durable Objects

#### 26.6b Durable Objects - Integration Tests
- [ ] Create integration test suite:
  - [ ] `test/integration/durable-objects.test.ts`
- [ ] Test SessionStore + D1 integration:
  - [ ] Session persistence across DO restarts
  - [ ] D1 fallback on cold start
  - [ ] Multi-user session isolation
- [ ] Test AuthCodeStore + Token endpoint integration:
  - [ ] Code generation → consumption flow
  - [ ] Replay attack → token revocation
- [ ] Test RefreshTokenRotator + Token endpoint:
  - [ ] Token rotation flow
  - [ ] Theft detection → family revocation
  - [ ] Audit log verification
- [ ] Test Durable Objects + wrangler.toml bindings:
  - [ ] Verify bindings are correctly configured
  - [ ] Test DO instantiation from Workers
- [ ] Document integration test setup

#### 26.6c Durable Objects - API Documentation
- [ ] Update `docs/architecture/durable-objects.md`:
  - [ ] Mark SessionStore as ✅ Implemented
  - [ ] Mark AuthorizationCodeStore as ✅ Implemented
  - [ ] Mark RefreshTokenRotator as ✅ Implemented
  - [ ] Add implementation notes and lessons learned
- [ ] Create API reference documentation:
  - [ ] `docs/api/durable-objects/SessionStore.md`
  - [ ] `docs/api/durable-objects/AuthorizationCodeStore.md`
  - [ ] `docs/api/durable-objects/RefreshTokenRotator.md`
- [ ] Document each HTTP endpoint with:
  - [ ] Request format (JSON schema)
  - [ ] Response format (JSON schema)
  - [ ] Error responses
  - [ ] Example curl commands
  - [ ] Usage examples in TypeScript
- [ ] Add OpenAPI/Swagger specs (optional):
  - [ ] Generate from TypeScript interfaces
  - [ ] Integrate with existing `docs/api/openapi.yaml`
- [ ] Update README.md with Durable Objects section

#### 26.7 ストレージ抽象化層実装
- [x] Create `packages/shared/src/storage/interfaces.ts`:
  - [x] Define `IStorageAdapter` interface
  - [x] Define `IUserStore` interface
  - [x] Define `IClientStore` interface
  - [x] Define `ISessionStore` interface
  - [x] Define `IPasskeyStore` interface
- [x] Create `packages/shared/src/storage/cloudflare-adapter.ts`:
  - [x] Implement `CloudflareStorageAdapter` class
  - [x] Integrate D1, KV, and Durable Objects
  - [x] Implement routing logic (session: → DO, client: → D1+KV cache)
- [x] Create factory function `createStorageAdapter(env: Env)`
- [x] Add unit tests for storage adapter (37 tests - exceeds requirement of 25+)
- [x] Test adapter routing logic
- [x] Document storage abstraction layer

---

### ステージ2: バックエンドAPI実装 (Week 26-27: May 5-14)

#### 27.1 WebAuthn/Passkey実装
- [ ] Install `@simplewebauthn/server` and `@simplewebauthn/browser`
- [ ] Create `src/handlers/auth/passkey.ts`
- [ ] Implement `POST /auth/passkey/register/options` - Generate registration options
- [ ] Implement `POST /auth/passkey/register/verify` - Verify registration
- [ ] Implement `POST /auth/passkey/login/options` - Generate authentication options
- [ ] Implement `POST /auth/passkey/login/verify` - Verify authentication
- [ ] Store passkeys in D1 `passkeys` table
- [ ] Implement counter management (replay attack prevention)
- [ ] Add unit tests for Passkey endpoints (30+ tests)
- [ ] Test Passkey registration flow
- [ ] Test Passkey authentication flow
- [ ] Document Passkey API

#### 27.2 Magic Link実装
- [ ] Choose email provider (Resend recommended)
- [ ] Create `src/utils/email/` directory:
  - [ ] `interfaces.ts` - `IEmailProvider` interface
  - [ ] `resend-provider.ts` - Resend implementation
  - [ ] `cloudflare-email-provider.ts` - Cloudflare Email Workers (Phase 7)
  - [ ] `smtp-provider.ts` - SMTP implementation (Phase 7)
- [ ] Implement `POST /auth/magic-link/send` endpoint:
  - [ ] Generate secure token (UUID v4)
  - [ ] Store token in KV with TTL (15 minutes)
  - [ ] Send email with magic link
  - [ ] Return success response
- [ ] Implement `GET /auth/magic-link/verify` endpoint:
  - [ ] Validate token from URL parameter
  - [ ] Check token expiration
  - [ ] Create session
  - [ ] Delete used token
  - [ ] Redirect to client application
- [ ] Create email templates (HTML + plain text):
  - [ ] Magic Link email template
  - [ ] Email verification template (Phase 6)
  - [ ] Password reset template (Phase 6)
- [ ] Add rate limiting for Magic Link (3 req/15min per email)
- [ ] Add unit tests for Magic Link (20+ tests)
- [ ] Test email delivery
- [ ] Test token expiration
- [ ] Document Magic Link API

#### 27.3 OAuth同意画面API
- [ ] Implement `GET /auth/consent` endpoint:
  - [ ] Retrieve authorization request from session
  - [ ] Load client metadata from D1
  - [ ] Convert scopes to human-readable format
  - [ ] Return consent screen data (client name, logo, scopes, user info)
- [ ] Implement `POST /auth/consent` endpoint:
  - [ ] Validate consent decision (allow/deny)
  - [ ] Store consent decision in D1 (optional: remember choice)
  - [ ] Generate authorization code if allowed
  - [ ] Redirect to client with code or error
- [ ] Implement consent persistence (skip consent if previously granted)
- [ ] Add Audit Log for consent decisions
- [ ] Add unit tests for consent endpoints (15+ tests)
- [ ] Test consent approval flow
- [ ] Test consent denial flow
- [ ] Document consent API

#### 27.4 ITP対応セッション管理API
- [ ] Implement `POST /auth/session/token` - Issue short-lived token (5min TTL, single-use)
  - [ ] Generate secure token
  - [ ] Store in KV with TTL (5 minutes)
  - [ ] Link to user session
  - [ ] Return token
- [ ] Implement `POST /auth/session/verify` - Verify token & create RP session
  - [ ] Validate token
  - [ ] Check single-use flag
  - [ ] Mark token as used
  - [ ] Create new session for RP domain
  - [ ] Return session cookie
- [ ] Implement `GET /session/status` - Check session validity (iframe alternative)
  - [ ] Validate session from cookie
  - [ ] Check expiration
  - [ ] Return session status
- [ ] Implement `POST /session/refresh` - Extend session (Active TTL)
  - [ ] Validate current session
  - [ ] Extend expiration time
  - [ ] Update session in SessionStore DO
  - [ ] Return new expiration time
- [ ] Add unit tests for session management (25+ tests)
- [ ] Test cross-domain SSO flow
- [ ] Test ITP compatibility (Safari)
- [ ] Document session management API

#### 27.5 Logout機能API
- [ ] Implement `GET /logout` - Front-channel Logout
  - [ ] Parse `id_token_hint` parameter
  - [ ] Validate ID token
  - [ ] Invalidate session in SessionStore DO
  - [ ] Clear session cookie
  - [ ] Redirect to `post_logout_redirect_uri`
- [ ] Implement `POST /logout/backchannel` - Back-channel Logout (RFC 8725)
  - [ ] Validate client authentication
  - [ ] Parse `logout_token` (JWT)
  - [ ] Validate logout token signature
  - [ ] Invalidate sessions for user
  - [ ] Return 200 OK
- [ ] Add unit tests for logout endpoints (12+ tests)
- [ ] Test front-channel logout
- [ ] Test back-channel logout
- [ ] Document logout API

#### 27.6 管理者API - ユーザー管理
- [ ] Implement `GET /admin/users` - List users with pagination
  - [ ] Query parameters: `q` (search), `filter` (status), `sort`, `page`, `limit`
  - [ ] Search by email, name
  - [ ] Filter by verified, unverified, active, inactive
  - [ ] Sort by created_at, last_login_at, email, name
  - [ ] Return paginated results with total count
- [ ] Implement `GET /admin/users/:id` - Get user details
  - [ ] Load user from D1
  - [ ] Load custom fields
  - [ ] Load passkeys
  - [ ] Load sessions
  - [ ] Return user object
- [ ] Implement `POST /admin/users` - Create user
  - [ ] Validate email uniqueness
  - [ ] Hash password (if provided)
  - [ ] Insert into D1 users table
  - [ ] Create Audit Log entry
  - [ ] Return created user
- [ ] Implement `PUT /admin/users/:id` - Update user
  - [ ] Validate user exists
  - [ ] Update user fields
  - [ ] Update custom fields if provided
  - [ ] Create Audit Log entry
  - [ ] Return updated user
- [ ] Implement `DELETE /admin/users/:id` - Delete user (cascade)
  - [ ] Delete user from D1 (cascade to custom_fields, passkeys, sessions)
  - [ ] Invalidate all user sessions
  - [ ] Create Audit Log entry
  - [ ] Return success response
- [ ] Add admin authentication middleware (Bearer token)
- [ ] Add RBAC permission checks (users:read, users:write, users:delete)
- [ ] Add unit tests for user management API (35+ tests)
- [ ] Test user CRUD operations
- [ ] Test search and filtering
- [ ] Document admin user API

#### 27.7 管理者API - クライアント管理
- [ ] Implement `GET /admin/clients` - List OAuth clients
  - [ ] Query parameters: `q` (search), `sort`, `page`, `limit`
  - [ ] Search by client_name, client_id
  - [ ] Sort by created_at, client_name
  - [ ] Return paginated results
- [ ] Implement `GET /admin/clients/:id` - Get client details
  - [ ] Load client from D1
  - [ ] Return client object (mask client_secret)
- [ ] Implement `POST /admin/clients` - Register new client (extend existing DCR)
  - [ ] Use existing DCR endpoint internally
  - [ ] Add admin-specific metadata
  - [ ] Create Audit Log entry
  - [ ] Return created client
- [ ] Implement `PUT /admin/clients/:id` - Update client
  - [ ] Validate client exists
  - [ ] Update client metadata
  - [ ] Create Audit Log entry
  - [ ] Invalidate KV cache
  - [ ] Return updated client
- [ ] Implement `POST /admin/clients/:id/regenerate-secret` - Regenerate client secret
  - [ ] Generate new client_secret
  - [ ] Hash and store new secret
  - [ ] Create Audit Log entry
  - [ ] Return new secret (one-time display)
- [ ] Implement `DELETE /admin/clients/:id` - Delete client
  - [ ] Delete client from D1
  - [ ] Invalidate KV cache
  - [ ] Revoke all tokens for client
  - [ ] Create Audit Log entry
  - [ ] Return success response
- [ ] Add unit tests for client management API (30+ tests)
- [ ] Test client CRUD operations
- [ ] Test secret regeneration
- [ ] Document admin client API

#### 27.8 管理者API - セッション管理
- [ ] Implement `GET /admin/sessions` - List sessions
  - [ ] Query parameters: `user_id`, `status` (active/expired), `page`, `limit`
  - [ ] Load sessions from SessionStore DO + D1
  - [ ] Return paginated session list with metadata (user, device, IP)
- [ ] Implement `GET /admin/sessions/:id` - Get session details
  - [ ] Load session from SessionStore DO or D1
  - [ ] Return session data (anonymized)
- [ ] Implement `POST /admin/sessions/:id/revoke` - Force logout individual session
  - [ ] Validate session exists
  - [ ] Invalidate session in SessionStore DO
  - [ ] Delete session from D1
  - [ ] Create Audit Log entry
  - [ ] Return success response
- [ ] Implement `POST /admin/users/:id/revoke-all-sessions` - Revoke all user sessions
  - [ ] Get all sessions for user
  - [ ] Invalidate all sessions in SessionStore DO
  - [ ] Delete all sessions from D1
  - [ ] Create Audit Log entry
  - [ ] Return success response
- [ ] Add unit tests for session management API (20+ tests)
- [ ] Test session listing and filtering
- [ ] Test session revocation
- [ ] Document admin session API

---

### ステージ3: フロントエンド基盤 (Week 27-28: May 11-18)

#### 28.1 SvelteKit環境構築
- [ ] Initialize new SvelteKit project:
  ```bash
  npm create svelte@latest packages/ui
  ```
- [ ] Select options:
  - [ ] Template: Skeleton project
  - [ ] TypeScript: Yes
  - [ ] ESLint: Yes
  - [ ] Prettier: Yes
- [ ] Install dependencies:
  ```bash
  cd packages/ui && npm install
  ```
- [ ] Configure `svelte.config.js` for Cloudflare Pages adapter:
  ```javascript
  import adapter from '@sveltejs/adapter-cloudflare';
  ```
- [ ] Test development server: `npm run dev`
- [ ] Test production build: `npm run build`
- [ ] Document SvelteKit setup

#### 28.2 UnoCSS設定
- [ ] Install UnoCSS:
  ```bash
  npm install -D unocss @unocss/reset
  ```
- [ ] Create `uno.config.ts`:
  - [ ] Configure presets (uno, attributify, icons)
  - [ ] Define custom theme colors
  - [ ] Add shortcuts for common patterns
- [ ] Create `src/app.css` with UnoCSS imports
- [ ] Import in `src/routes/+layout.svelte`
- [ ] Test UnoCSS classes in development
- [ ] Document UnoCSS configuration

#### 28.3 Melt UI導入
- [ ] Install Melt UI:
  ```bash
  npm install @melt-ui/svelte @melt-ui/pp
  ```
- [ ] Configure Melt UI preprocessor in `svelte.config.js`
- [ ] Create sample components using Melt UI:
  - [ ] Button component
  - [ ] Input component
  - [ ] Dialog component
- [ ] Test Melt UI components
- [ ] Document Melt UI usage

#### 28.4 Paraglide (i18n) 設定
- [ ] Install Paraglide:
  ```bash
  npm install @inlang/paraglide-js @inlang/paraglide-sveltekit
  ```
- [ ] Create `project.inlang/settings.json`:
  - [ ] Configure source language: "en"
  - [ ] Configure target languages: ["ja"]
- [ ] Create translation files:
  - [ ] `messages/en.json` - English translations
  - [ ] `messages/ja.json` - Japanese translations
- [ ] Configure Paraglide in `svelte.config.js`
- [ ] Create language switcher component
- [ ] Test i18n in development
- [ ] Document Paraglide setup

#### 28.5 Cloudflare Pages連携
- [ ] Create `packages/ui/wrangler.toml` for Pages Functions
- [ ] Configure Pages build settings:
  - [ ] Build command: `npm run build`
  - [ ] Build output directory: `build/`
  - [ ] Node version: 18
- [ ] Create `.github/workflows/deploy-ui.yml`:
  - [ ] Build SvelteKit app
  - [ ] Deploy to Cloudflare Pages
- [ ] Test local build
- [ ] Test Pages deployment (preview)
- [ ] Document Pages deployment

#### 28.6 デザインシステム実装
- [ ] Create `packages/ui/src/lib/design-system/` directory
- [ ] Define design tokens:
  - [ ] `tokens/colors.ts` - Color palette (primary, secondary, neutral, semantic)
  - [ ] `tokens/typography.ts` - Font families, sizes, weights, line heights
  - [ ] `tokens/spacing.ts` - Spacing scale (0.25rem - 4rem)
  - [ ] `tokens/shadows.ts` - Box shadows (sm, md, lg)
  - [ ] `tokens/radius.ts` - Border radius (sm, md, lg, full)
- [ ] Create base components:
  - [ ] `Button.svelte` - Primary, secondary, outline, ghost variants
  - [ ] `Input.svelte` - Text, email, password types with label and error
  - [ ] `Card.svelte` - Container with header, body, footer slots
  - [ ] `Modal.svelte` - Dialog with backdrop and close button
  - [ ] `Spinner.svelte` - Loading indicator
  - [ ] `Alert.svelte` - Info, success, warning, error variants
- [ ] Create layout components:
  - [ ] `Container.svelte` - Max-width container
  - [ ] `Stack.svelte` - Vertical stacking with gap
  - [ ] `Grid.svelte` - Responsive grid layout
- [ ] Test all components in isolation
- [ ] Create Storybook for component showcase (optional)
- [ ] Document design system

---

### ステージ4: 認証UI実装 (Week 28-29: May 15-25)

#### 29.1 ログイン画面 (`/login`)
- [ ] Create `packages/ui/src/routes/login/+page.svelte`
- [ ] Design login layout:
  - [ ] Enrai logo at top
  - [ ] Email input field
  - [ ] "Continue with Passkey" button (primary)
  - [ ] "Send Magic Link" button (secondary)
  - [ ] "Create Account" link
  - [ ] Language switcher (en/ja)
- [ ] Implement form validation (Zod)
- [ ] Implement Passkey detection (check browser support)
- [ ] Integrate with `/auth/passkey/login` API
- [ ] Integrate with `/auth/magic-link/send` API
- [ ] Add error message display
- [ ] Add loading states
- [ ] Add Cloudflare Turnstile (Captcha)
- [ ] Test responsive design (320px - 1920px)
- [ ] Test keyboard navigation
- [ ] Test screen reader compatibility
- [ ] Document login page

#### 29.2 アカウント登録画面 (`/register`)
- [ ] Create `packages/ui/src/routes/register/+page.svelte`
- [ ] Design registration layout:
  - [ ] Email input field
  - [ ] Name input field (optional)
  - [ ] "Create Account with Passkey" button
  - [ ] "Sign up with Magic Link" button
  - [ ] Terms of Service & Privacy Policy checkboxes
  - [ ] "Already have an account?" link
- [ ] Implement form validation
- [ ] Check email uniqueness (debounced)
- [ ] Integrate with `/auth/passkey/register` API
- [ ] Integrate with `/auth/magic-link/send` API
- [ ] Add Cloudflare Turnstile
- [ ] Test registration flow
- [ ] Document registration page

#### 29.3 Magic Link送信完了画面 (`/magic-link-sent`)
- [ ] Create `packages/ui/src/routes/magic-link-sent/+page.svelte`
- [ ] Design success message:
  - [ ] "Check your email" heading
  - [ ] Email address display
  - [ ] "Resend email" button (with timer countdown)
  - [ ] "Back to login" link
- [ ] Implement resend timer (60 seconds)
- [ ] Integrate with resend API
- [ ] Test resend flow
- [ ] Document magic link sent page

#### 29.4 Magic Link検証画面 (`/verify-magic-link`)
- [ ] Create `packages/ui/src/routes/verify-magic-link/+page.svelte`
- [ ] Show loading spinner immediately
- [ ] Extract token from URL query parameter
- [ ] Call `/auth/magic-link/verify` API
- [ ] Handle success: redirect to client app or dashboard
- [ ] Handle error: show error message with "Request new link" button
- [ ] Test verification flow
- [ ] Document verification page

#### 29.5 OAuth同意画面 (`/consent`)
- [ ] Create `packages/ui/src/routes/consent/+page.svelte`
- [ ] Design consent layout:
  - [ ] Client logo and name
  - [ ] "{Client Name} wants to access your Enrai account" heading
  - [ ] Scope list with icons (human-readable)
  - [ ] User information display (email, name, avatar)
  - [ ] "Allow" button (primary)
  - [ ] "Deny" button (secondary)
  - [ ] "Not you? Switch account" link
  - [ ] Privacy Policy and Terms of Service links
- [ ] Load consent data from `/auth/consent` API
- [ ] Implement scope translation (technical → human-readable)
- [ ] Integrate with `POST /auth/consent` API
- [ ] Handle allow: redirect with authorization code
- [ ] Handle deny: redirect with error
- [ ] Test consent flow with various scopes
- [ ] Document consent page

#### 29.6 エラーページ (`/error`)
- [ ] Create `packages/ui/src/routes/error/+page.svelte`
- [ ] Design error layout:
  - [ ] Error icon
  - [ ] Error message (user-friendly)
  - [ ] Error code (technical, small font)
  - [ ] "Back to login" button
  - [ ] Support contact link
- [ ] Handle various error types:
  - [ ] invalid_request
  - [ ] access_denied
  - [ ] server_error
  - [ ] temporarily_unavailable
- [ ] Log errors to console (development) or monitoring service (production)
- [ ] Test error page with different error codes
- [ ] Document error page

---

### ステージ5: 管理画面実装 (Week 29-30: May 22-31)

#### 30.1 管理者ダッシュボード (`/admin`)
- [ ] Create `packages/ui/src/routes/admin/+layout.svelte`:
  - [ ] Sidebar navigation
  - [ ] Top bar (logo, search, notifications, profile menu)
  - [ ] Main content area
- [ ] Create `packages/ui/src/routes/admin/+page.svelte`:
  - [ ] Statistics cards:
    - [ ] Active users count
    - [ ] Total logins today
    - [ ] Registered clients count
    - [ ] Active sessions count
  - [ ] Activity feed (latest logins, registrations, errors)
  - [ ] Login trend chart (Chart.js or ECharts)
  - [ ] Quick actions panel (Create user, Register client)
- [ ] Integrate with `/admin/stats` API (create API if needed)
- [ ] Add real-time updates (optional: WebSockets or polling)
- [ ] Test dashboard layout and responsiveness
- [ ] Document admin dashboard

#### 30.2 ユーザー管理 (`/admin/users`)
- [ ] Create `packages/ui/src/routes/admin/users/+page.svelte`:
  - [ ] User list table with pagination
  - [ ] Search bar (search by email, name)
  - [ ] Filter dropdowns (verified/unverified, active/inactive)
  - [ ] Sort by columns (email, name, created_at, last_login_at)
  - [ ] "Add User" button
  - [ ] Action buttons (Edit, Delete) per row
- [ ] Integrate with `GET /admin/users` API
- [ ] Implement client-side pagination
- [ ] Implement debounced search
- [ ] Add delete confirmation dialog
- [ ] Test with large datasets (1000+ users)
- [ ] Document user list page

#### 30.3 ユーザー詳細/編集 (`/admin/users/:id`)
- [ ] Create `packages/ui/src/routes/admin/users/[id]/+page.svelte`:
  - [ ] User information form (email, name, phone, address, etc.)
  - [ ] Custom fields section (dynamic based on user_custom_fields)
  - [ ] Passkey list (registered devices)
  - [ ] Session list (active sessions)
  - [ ] Audit Log (user actions)
  - [ ] "Save Changes" button
  - [ ] "Delete User" button (danger zone)
- [ ] Integrate with `GET /admin/users/:id` API
- [ ] Integrate with `PUT /admin/users/:id` API
- [ ] Integrate with `DELETE /admin/users/:id` API
- [ ] Implement form validation
- [ ] Add "Delete Passkey" button for each device
- [ ] Add "Revoke Session" button for each session
- [ ] Test user editing and deletion
- [ ] Document user detail page

#### 30.4 クライアント管理 (`/admin/clients`)
- [ ] Create `packages/ui/src/routes/admin/clients/+page.svelte`:
  - [ ] Client list table (client_id, client_name, created_at, grant_types)
  - [ ] Search bar
  - [ ] "Register Client" button
  - [ ] Action buttons (Edit, Delete, View Secret) per row
- [ ] Integrate with `GET /admin/clients` API
- [ ] Implement client search
- [ ] Add delete confirmation dialog
- [ ] Test client list page
- [ ] Document client list page

#### 30.5 クライアント詳細/編集 (`/admin/clients/:id`)
- [ ] Create `packages/ui/src/routes/admin/clients/[id]/+page.svelte`:
  - [ ] Client information form (client_name, redirect_uris, grant_types, scope)
  - [ ] Redirect URIs management (add/remove)
  - [ ] Grant Types selection (checkboxes)
  - [ ] Scope configuration (multi-select or checkboxes)
  - [ ] Logo URI input
  - [ ] Client URI, Policy URI, ToS URI inputs
  - [ ] "Save Changes" button
  - [ ] "Regenerate Secret" button (show confirmation)
  - [ ] "Delete Client" button (danger zone)
- [ ] Integrate with `GET /admin/clients/:id` API
- [ ] Integrate with `PUT /admin/clients/:id` API
- [ ] Integrate with `POST /admin/clients/:id/regenerate-secret` API
- [ ] Integrate with `DELETE /admin/clients/:id` API
- [ ] Show client_secret only once after regeneration
- [ ] Add form validation (URL validation, etc.)
- [ ] Test client editing and deletion
- [ ] Document client detail page

#### 30.6 設定 (`/admin/settings`)
- [ ] Create `packages/ui/src/routes/admin/settings/+page.svelte`:
  - [ ] Tabs: General, Appearance, Security, Email, Advanced
  - [ ] General tab:
    - [ ] Site name input
    - [ ] Logo upload
    - [ ] Language selection
    - [ ] Timezone selection
  - [ ] Appearance tab:
    - [ ] Theme selection (light/dark/auto)
    - [ ] Primary color picker
    - [ ] Secondary color picker
    - [ ] Font family selection
    - [ ] Login page preview (iframe)
  - [ ] Security tab:
    - [ ] Password policy configuration
    - [ ] Session timeout setting
    - [ ] MFA enforcement toggle
    - [ ] Rate limiting configuration
  - [ ] Email tab:
    - [ ] Email provider selection (Resend/Cloudflare/SMTP)
    - [ ] SMTP configuration (host, port, username, password)
    - [ ] Test email button
    - [ ] Email template editor (basic)
  - [ ] Advanced tab:
    - [ ] Token TTL settings (access, ID, refresh)
    - [ ] Enable/disable features (Passkey, Magic Link, Social Login)
- [ ] Integrate with `GET /admin/settings` API (create API if needed)
- [ ] Integrate with `PUT /admin/settings` API
- [ ] Implement live preview for appearance changes
- [ ] Add test email functionality
- [ ] Test all settings
- [ ] Document settings page

#### 30.7 Audit Log (`/admin/audit-log`)
- [ ] Create `packages/ui/src/routes/admin/audit-log/+page.svelte`:
  - [ ] Audit log table (timestamp, user, action, resource, IP, status)
  - [ ] Filter by date range (date picker)
  - [ ] Filter by action type (dropdown)
  - [ ] Filter by user (autocomplete)
  - [ ] Search by resource ID
  - [ ] Export to CSV button
  - [ ] Export to JSON button
- [ ] Integrate with `GET /admin/audit-log` API (create API if needed)
- [ ] Implement date range filtering
- [ ] Implement CSV export (client-side)
- [ ] Implement JSON export (client-side)
- [ ] Test audit log display and filtering
- [ ] Document audit log page

---

### ステージ6: 統合・テスト (Week 30-31: May 26-31)

#### 31.1 E2Eテスト (Playwright)
- [ ] Install Playwright:
  ```bash
  npm install -D @playwright/test
  ```
- [ ] Configure `playwright.config.ts`
- [ ] Create test suite `packages/ui/tests/`:
  - [ ] `auth.spec.ts` - Login, registration, magic link flow
  - [ ] `consent.spec.ts` - OAuth consent flow
  - [ ] `admin.spec.ts` - Admin dashboard, user/client management
- [ ] Write E2E tests:
  - [ ] Test login with Passkey (mock WebAuthn)
  - [ ] Test login with Magic Link
  - [ ] Test registration with Passkey
  - [ ] Test OAuth consent approval
  - [ ] Test OAuth consent denial
  - [ ] Test admin user CRUD
  - [ ] Test admin client CRUD
- [ ] Run tests: `npm run test`
- [ ] Generate test report
- [ ] Document E2E testing

#### 31.2 セキュリティテスト
- [ ] Test CSRF protection:
  - [ ] Verify CSRF token on all POST endpoints
  - [ ] Test CSRF token validation
- [ ] Test XSS prevention:
  - [ ] Inject XSS payloads in input fields
  - [ ] Verify HTML escaping
  - [ ] Check CSP headers
- [ ] Test SQL injection prevention:
  - [ ] Inject SQL payloads in search queries
  - [ ] Verify parameterized queries
- [ ] Test authentication bypass:
  - [ ] Try accessing admin pages without auth
  - [ ] Try accessing other users' data
- [ ] Document security test results

#### 31.3 パフォーマンス最適化
- [ ] Run Lighthouse audit on all pages:
  - [ ] Login page target: >90 Performance
  - [ ] Admin dashboard target: >85 Performance
- [ ] Optimize images:
  - [ ] Convert to WebP format
  - [ ] Add lazy loading
- [ ] Optimize JavaScript bundle:
  - [ ] Code splitting by route
  - [ ] Tree shaking
  - [ ] Minification
- [ ] Optimize CSS:
  - [ ] Purge unused UnoCSS classes
  - [ ] Minification
- [ ] Add caching headers for static assets
- [ ] Measure page load time (p95 < 2 seconds)
- [ ] Document performance improvements

#### 31.4 アクセシビリティ改善 (WCAG 2.1 AA)
- [ ] Run axe DevTools on all pages
- [ ] Fix accessibility issues:
  - [ ] Add proper ARIA labels
  - [ ] Ensure keyboard navigation works
  - [ ] Add focus indicators
  - [ ] Improve color contrast (4.5:1 minimum)
  - [ ] Add alt text for images
  - [ ] Ensure form labels are properly associated
- [ ] Test with screen reader (NVDA or JAWS)
- [ ] Test keyboard-only navigation (Tab, Enter, Esc)
- [ ] Document accessibility compliance

#### 31.5 デプロイ準備
- [ ] Create production environment variables
- [ ] Configure Cloudflare Pages production deployment
- [ ] Set up custom domain (if applicable)
- [ ] Configure SSL/TLS
- [ ] Set up monitoring (Sentry for errors)
- [ ] Create deployment runbook
- [ ] Test production deployment (preview)
- [ ] Document deployment process

#### 31.6 Milestone 5 Review
- [ ] Verify all Phase 5 features work:
  - [ ] Login with Passkey
  - [ ] Login with Magic Link
  - [ ] OAuth consent flow
  - [ ] Admin dashboard
  - [ ] User management
  - [ ] Client management
  - [ ] Settings management
- [ ] Run full test suite (unit + integration + E2E)
- [ ] Check test coverage (target: >80%)
- [ ] Review Lighthouse scores (target: >90)
- [ ] Review accessibility (WCAG 2.1 AA compliance)
- [ ] Update documentation
- [ ] Create Phase 5 completion report
- [ ] Plan Phase 6 kickoff

---

### Phase 5 Success Metrics 🎯

#### Code Quality
- [ ] Test coverage ≥ 80% (UI + API)
- [ ] Zero TypeScript errors
- [ ] Zero linting errors
- [ ] All tests passing (unit + integration + E2E)

#### Performance
- [ ] Login page load time < 2 seconds (p95)
- [ ] Admin dashboard load time < 3 seconds (p95)
- [ ] Lighthouse Performance score > 90
- [ ] Lighthouse Best Practices score > 90

#### Accessibility
- [ ] WCAG 2.1 AA compliance
- [ ] axe DevTools score: 0 violations
- [ ] Keyboard navigation functional
- [ ] Screen reader compatible

#### User Experience
- [ ] Responsive design (320px - 1920px)
- [ ] Cross-browser compatibility (Chrome, Firefox, Safari, Edge)
- [ ] Internationalization (en, ja)
- [ ] Dark mode support (optional)

#### Security
- [ ] CSRF protection enabled
- [ ] XSS prevention verified
- [ ] CSP headers configured
- [ ] Authentication required for admin pages
- [ ] RBAC implemented

---

### Phase 5 Deliverables 📦

- [ ] ✅ D1 database with 11 tables
- [ ] ✅ 3 Durable Objects (SessionStore, AuthCodeStore, RefreshTokenRotator)
- [ ] ✅ Storage abstraction layer
- [ ] ✅ 14+ backend API endpoints (auth + admin)
- [ ] ✅ SvelteKit frontend application
- [ ] ✅ 6 user-facing pages (login, register, magic link, consent, error)
- [ ] ✅ 7 admin pages (dashboard, users, clients, settings, audit log)
- [ ] ✅ E2E test suite (Playwright)
- [ ] ✅ Design system with reusable components
- [ ] ✅ Internationalization (en, ja)
- [ ] ✅ Deployment to Cloudflare Pages

---

---

## Phase 6: CLI & Automation (Jun 12 - Aug 10, 2026)

### Week 32-33: CLI Tool Development (Jun 12-25)

#### 32.1 `create-enrai` Package Setup
- [ ] Initialize NPM package
- [ ] Set up TypeScript configuration
- [ ] Configure build system (tsup/esbuild)
- [ ] Add shebang for executable
- [ ] Set up package.json bin field
- [ ] Configure ESLint for CLI
- [ ] Add CLI dependencies (Commander.js, Inquirer, Ora, Chalk)

#### 32.2 Project Scaffolding
- [ ] Create project template structure
- [ ] Design file generation system
- [ ] Implement template variable replacement
- [ ] Add configuration file generation
- [ ] Create .env.example template
- [ ] Add wrangler.toml template
- [ ] Create package.json template
- [ ] Test project generation

#### 32.3 Interactive Setup Wizard
- [ ] Implement welcome screen
- [ ] Add project name prompt
- [ ] Add Cloudflare Account ID prompt (with auto-detect)
- [ ] Add admin email prompt (with validation)
- [ ] Add password policy selection (strong/medium/basic)
- [ ] Add storage backend selection (D1/KV/DO)
- [ ] Add region selection (auto/manual)
- [ ] Add feature toggles (MFA, social login)
- [ ] Implement progress indicators
- [ ] Add error handling

#### 32.4 Deployment Commands
- [ ] Implement `enrai deploy` command
- [ ] Add `enrai deploy --production` flag
- [ ] Implement `enrai rollback` command
- [ ] Add `enrai status` command
- [ ] Implement `enrai logs` command
- [ ] Add deployment progress tracking
- [ ] Implement error recovery
- [ ] Test deployment flow

#### 32.5 Management Commands
- [ ] Implement `enrai user create <email>`
- [ ] Add `enrai user delete <email>`
- [ ] Implement `enrai user reset-password <email>`
- [ ] Add `enrai user list`
- [ ] Implement `enrai client create <name>`
- [ ] Add `enrai client list`
- [ ] Implement `enrai client delete <id>`
- [ ] Add `enrai keys rotate`
- [ ] Implement `enrai backup`
- [ ] Add `enrai restore <file>`
- [ ] Implement `enrai config get <key>`
- [ ] Add `enrai config set <key> <value>`
- [ ] Test all commands

#### 32.6 CLI Testing
- [ ] Write unit tests for commands
- [ ] Add integration tests
- [ ] Test error scenarios
- [ ] Test with different configurations
- [ ] Verify help text
- [ ] Test auto-completion (optional)

---

### Week 34-35: Cloudflare Integration (Jun 26 - Jul 9)

#### 34.1 Cloudflare API Client
- [ ] Set up Cloudflare API SDK
- [ ] Implement authentication (API token)
- [ ] Create API wrapper functions
- [ ] Add retry logic
- [ ] Implement rate limiting
- [ ] Add error handling
- [ ] Test API client

#### 34.2 Worker Deployment API
- [ ] Implement Worker creation
- [ ] Add Worker update
- [ ] Implement Worker deletion
- [ ] Add Worker script upload
- [ ] Implement environment variable injection
- [ ] Add route configuration
- [ ] Test Worker deployment

#### 34.3 KV Namespace Management
- [ ] Implement KV namespace creation
- [ ] Add KV namespace listing
- [ ] Implement KV namespace deletion
- [ ] Add KV binding to Worker
- [ ] Test KV operations

#### 34.4 D1 Database Management
- [ ] Implement D1 database creation
- [ ] Add schema migration execution
- [ ] Implement D1 binding to Worker
- [ ] Add database backup
- [ ] Implement database restore
- [ ] Test D1 operations

#### 34.5 Durable Objects Configuration
- [ ] Implement DO class registration
- [ ] Add DO binding to Worker
- [ ] Test DO deployment

#### 34.6 DNS & Custom Domain
- [ ] Implement DNS record creation (CNAME)
- [ ] Add custom domain verification
- [ ] Implement SSL/TLS certificate provisioning
- [ ] Add domain validation
- [ ] Test custom domain setup

#### 34.7 Resource Provisioning Workflow
- [ ] Implement resource detection
- [ ] Add resource creation workflow
- [ ] Implement cleanup on failure
- [ ] Add cost estimation
- [ ] Implement resource tagging
- [ ] Test provisioning end-to-end

---

### Week 36-37: Setup Automation (Jul 10-23)

#### 36.1 Initial Setup Wizard
- [ ] Create welcome screen with ASCII art
- [ ] Add prerequisites check:
  - [ ] Node.js version
  - [ ] npm version
  - [ ] Cloudflare account
- [ ] Implement Cloudflare authentication flow
- [ ] Add configuration collection
- [ ] Implement resource provisioning
- [ ] Add admin account creation
- [ ] Implement email configuration (Resend/SendGrid)
- [ ] Add test email sending
- [ ] Create success screen with URLs
- [ ] Add QR code for mobile (optional)

#### 36.2 Health Checks
- [ ] Implement endpoint availability tests
- [ ] Add JWT signing verification
- [ ] Implement database connectivity check
- [ ] Add email delivery test
- [ ] Implement configuration validation
- [ ] Add performance baseline measurement
- [ ] Create health check report
- [ ] Test health checks

#### 36.3 Integration Examples
- [ ] Create Next.js integration template
- [ ] Add React SPA example
- [ ] Create Vue.js example
- [ ] Add Svelte example
- [ ] Create Express.js backend example
- [ ] Add Python Flask example
- [ ] Create documentation for each example
- [ ] Test all examples

#### 36.4 Environment Management
- [ ] Implement secret generation (RSA keys)
- [ ] Add environment variable injection
- [ ] Implement secret rotation workflow
- [ ] Add .env file management
- [ ] Create environment variable validation
- [ ] Test secret management

---

### Week 38-39: Production Readiness (Jul 24 - Aug 10)

#### 38.1 Error Handling Enhancement
- [ ] Implement global error handler
- [ ] Add user-friendly error messages
- [ ] Integrate error logging (Sentry)
- [ ] Implement error recovery strategies
- [ ] Add automatic retry logic
- [ ] Create error documentation
- [ ] Test error scenarios

#### 38.2 Performance Optimization
- [ ] Implement edge caching strategy
- [ ] Optimize static assets (images, CSS, JS)
- [ ] Add database query optimization
- [ ] Implement connection pooling
- [ ] Add request batching
- [ ] Measure performance improvements
- [ ] Create performance report

#### 38.3 Security Hardening
- [ ] Implement Content Security Policy (CSP)
- [ ] Add CSRF token generation & validation
- [ ] Implement XSS prevention (sanitization)
- [ ] Add SQL injection prevention
- [ ] Implement per-endpoint rate limiting
- [ ] Add IP blocking/allowlisting
- [ ] Implement comprehensive audit logging
- [ ] Conduct security audit
- [ ] Test security measures

#### 38.4 Monitoring & Observability
- [ ] Implement metrics collection (Prometheus format)
- [ ] Enhance health check endpoint
- [ ] Add logging aggregation (Cloudflare Logs)
- [ ] Implement alerting (PagerDuty/Slack)
- [ ] Create Grafana dashboard templates
- [ ] Add distributed tracing (optional)
- [ ] Test monitoring setup

#### 38.5 CLI Documentation
- [ ] Write CLI reference documentation
- [ ] Create deployment guide (step-by-step)
- [ ] Add troubleshooting guide
- [ ] Create migration guide (from Auth0, Keycloak, etc.)
- [ ] Record video tutorials
- [ ] Expand FAQ
- [ ] Test documentation accuracy

#### 38.6 NPM Package Publishing
- [ ] Prepare package for publishing
- [ ] Add README for NPM
- [ ] Create CHANGELOG
- [ ] Add LICENSE file
- [ ] Set up GitHub Actions for publishing
- [ ] Test package installation
- [ ] Publish to NPM registry
- [ ] Announce release

---

## Updated Success Metrics

### Phase 6: UI/UX
- [ ] Login page loads in <5 seconds
- [ ] Mobile Lighthouse score >90
- [ ] WCAG 2.1 AA compliance
- [ ] <3 clicks to any admin function
- [ ] Responsive on all screen sizes (320px+)

### Phase 7: CLI & Automation
- [ ] <5 minutes from `npx create-enrai` to running IdP
- [ ] <1 minute deployment time
- [ ] 100% automated setup (zero manual config)
- [ ] CLI with 20+ commands
- [ ] NPM package downloads >100/week

---

## Phase 7: Enterprise Flows & Advanced Features 🏢 (Aug 11 - Oct 31, 2026)

### Week 40-42: Advanced OAuth Flows (Aug 11-31)

#### 40.1 Hybrid Flow Implementation - OIDC Core 3.3
- [ ] Implement `response_type=code id_token` support
- [ ] Add `response_type=code token` support
- [ ] Implement `response_type=code id_token token` support
- [ ] Update authorization endpoint to handle hybrid flows
- [ ] Implement fragment encoding for tokens in response
- [ ] Add nonce validation for hybrid flow
- [ ] Update ID token generation for hybrid flow
- [ ] Implement access token validation in hybrid context
- [ ] Create unit tests for hybrid flow
- [ ] Create integration tests for all hybrid response types
- [ ] Test with conformance suite
- [ ] Document hybrid flow implementation

#### 40.2 Device Authorization Flow - RFC 8628
- [ ] Implement `POST /device_authorization` endpoint
- [ ] Create device code generation logic (UUID v4)
- [ ] Create user code generation (8-char alphanumeric, human-readable)
- [ ] Store device code with metadata in KV/D1
- [ ] Set appropriate TTL (300-600 seconds)
- [ ] Implement `POST /device/verify` endpoint (user-facing)
- [ ] Create device verification UI page
- [ ] Add user code input validation
- [ ] Implement device code validation logic
- [ ] Add polling mechanism support in token endpoint
- [ ] Implement interval and slow_down responses
- [ ] Create QR code generation for device URL
- [ ] Add rate limiting for polling requests
- [ ] Test device flow end-to-end (CLI, TV, IoT)
- [ ] Create device flow documentation
- [ ] Add device flow examples

#### 40.3 JWT Bearer Flow - RFC 7523
- [ ] Implement `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` support
- [ ] Create JWT assertion validation logic
- [ ] Implement signature verification for assertions
- [ ] Add issuer trust configuration
- [ ] Implement subject trust validation
- [ ] Create service account support
- [ ] Add scope-based access control for service accounts
- [ ] Implement token issuance for JWT bearer flow
- [ ] Create admin UI for trusted issuers management
- [ ] Add unit tests for JWT bearer flow
- [ ] Create integration tests
- [ ] Test with service-to-service scenarios
- [ ] Document JWT bearer flow setup
- [ ] Add examples for common use cases

---

### Week 43-44: CIBA & Advanced Encryption (Sep 1-14)

#### 43.1 CIBA (Client Initiated Backchannel Authentication) - CIBA Spec
- [ ] Implement `POST /bc-authorize` endpoint
- [ ] Create authentication request parsing
- [ ] Implement `login_hint` processing
- [ ] Add `binding_message` support
- [ ] Create user notification system (push/SMS integration)
- [ ] Implement polling mode support
- [ ] Add ping mode support (callback URL)
- [ ] Implement push mode support (callback with token)
- [ ] Create user approval UI (mobile/web)
- [ ] Implement authentication request storage
- [ ] Add user consent handling
- [ ] Implement token issuance for CIBA
- [ ] Create CIBA-specific error responses
- [ ] Add unit tests for CIBA flows
- [ ] Test all three modes (poll, ping, push)
- [ ] Document CIBA implementation
- [ ] Add mobile app integration example

#### 43.2 JWE (JSON Web Encryption) - RFC 7516
- [ ] Install and configure JWE libraries (jose)
- [ ] Implement ID Token encryption support
- [ ] Add `id_token_encrypted_response_alg` to client metadata
- [ ] Add `id_token_encrypted_response_enc` to client metadata
- [ ] Implement UserInfo response encryption
- [ ] Add `userinfo_encrypted_response_alg` to client metadata
- [ ] Add `userinfo_encrypted_response_enc` to client metadata
- [ ] Implement request object encryption (JAR with JWE)
- [ ] Create key management for client public keys
- [ ] Implement RSA-OAEP algorithm support
- [ ] Add A256GCM encryption support
- [ ] Add A128CBC-HS256 encryption support
- [ ] Create encryption utilities
- [ ] Add unit tests for encryption/decryption
- [ ] Test encrypted ID token flow
- [ ] Test encrypted UserInfo response
- [ ] Document JWE configuration
- [ ] Add examples for encrypted flows

---

### Week 45-47: Social Login & Identity Federation (Sep 15 - Oct 5)

#### 45.1 Social Login Providers Integration
- [ ] Design social provider abstraction layer
- [ ] Create OAuth client configuration storage
- [ ] Implement Google OAuth integration:
  - [ ] OAuth authorization flow
  - [ ] Token exchange
  - [ ] Profile fetching
  - [ ] Email verification
- [ ] Implement GitHub OAuth integration
- [ ] Implement Microsoft Azure AD / Entra ID integration
- [ ] Implement Apple Sign In:
  - [ ] Handle Apple's specific requirements
  - [ ] Implement Sign in with Apple JS
  - [ ] Handle private email relay
- [ ] Implement Facebook Login
- [ ] Implement Twitter/X Login
- [ ] Implement LinkedIn Login
- [ ] Create generic OIDC provider integration (for any OIDC-compliant provider)
- [ ] Test each provider integration

#### 45.2 Social Login UI
- [ ] Design provider selection screen
- [ ] Create social login buttons (branded)
- [ ] Implement provider icons and styling
- [ ] Add "Or" separator between social and password login
- [ ] Create provider selection UI
- [ ] Implement progressive enhancement
- [ ] Test responsive design
- [ ] Ensure accessibility (WCAG 2.1 AA)
- [ ] Test with various screen sizes

#### 45.3 Identity Federation & Transformation
- [ ] Design identity mapping schema
- [ ] Implement social identity to Enrai user mapping
- [ ] Create account linking logic (same email, multiple providers)
- [ ] Implement first-time social login flow
- [ ] Add profile synchronization from social providers
- [ ] Create provider-specific claim mapping
- [ ] Implement profile update on social login
- [ ] Add conflict resolution (email already exists)
- [ ] Create admin UI for linked accounts
- [ ] Implement unlink social account functionality
- [ ] Add unit tests for identity mapping
- [ ] Test account linking scenarios
- [ ] Test conflict scenarios
- [ ] Document social login architecture

---

### Week 48-50: Enterprise Integration (Oct 6-26)

#### 48.1 SAML 2.0 Bridge (OIDC → SAML)
- [ ] Install and configure SAML libraries
- [ ] Implement SAML 2.0 assertion generation
- [ ] Create `POST /saml/sso` endpoint (SAML SSO)
- [ ] Implement `GET /saml/metadata` endpoint
- [ ] Add SAML attribute mapping (OIDC claims → SAML attributes)
- [ ] Implement signature generation for SAML assertions
- [ ] Add encryption support for SAML assertions
- [ ] Implement SAML request signature validation
- [ ] Create SAML response builder
- [ ] Add RelayState handling
- [ ] Implement NameID format support
- [ ] Add unit tests for SAML generation
- [ ] Test with Okta as SAML SP
- [ ] Test with Azure AD as SAML SP
- [ ] Document SAML bridge configuration
- [ ] Add SAML troubleshooting guide

#### 48.2 LDAP/AD Integration
- [ ] Install and configure LDAP client library
- [ ] Design LDAP configuration schema
- [ ] Implement LDAP connection management
- [ ] Create LDAP authentication backend
- [ ] Implement Active Directory support
- [ ] Add user synchronization (LDAP → D1)
- [ ] Implement scheduled sync job
- [ ] Create group mapping (LDAP groups → OIDC scopes)
- [ ] Implement password validation via LDAP bind
- [ ] Add fallback to local authentication
- [ ] Create LDAP configuration UI (admin dashboard)
- [ ] Implement LDAP connection testing
- [ ] Add unit tests for LDAP operations
- [ ] Test with OpenLDAP
- [ ] Test with Active Directory
- [ ] Document LDAP/AD setup guide
- [ ] Add troubleshooting for common LDAP issues

#### 48.3 SCIM 2.0 User Provisioning - RFC 7643, RFC 7644
- [ ] Implement SCIM server endpoints:
  - [ ] `GET /scim/v2/Users` (list users with pagination)
  - [ ] `GET /scim/v2/Users/{id}` (get user)
  - [ ] `POST /scim/v2/Users` (create user)
  - [ ] `PUT /scim/v2/Users/{id}` (replace user)
  - [ ] `PATCH /scim/v2/Users/{id}` (update user)
  - [ ] `DELETE /scim/v2/Users/{id}` (delete user)
- [ ] Implement SCIM schema for User resource
- [ ] Add support for SCIM filter queries
- [ ] Implement pagination (startIndex, count)
- [ ] Create SCIM error responses
- [ ] Implement group provisioning:
  - [ ] `GET /scim/v2/Groups`
  - [ ] `POST /scim/v2/Groups`
  - [ ] `PUT /scim/v2/Groups/{id}`
  - [ ] `DELETE /scim/v2/Groups/{id}`
- [ ] Add SCIM authentication (Bearer token)
- [ ] Implement resource versioning (etag)
- [ ] Create unit tests for SCIM endpoints
- [ ] Test SCIM compliance with SCIM validator
- [ ] Document SCIM API
- [ ] Add SCIM integration examples (Okta, OneLogin)

---

### Week 51: Advanced Security & RBAC (Oct 27 - Nov 2)

#### 51.1 Risk-Based Authentication
- [ ] Design risk scoring system
- [ ] Implement IP reputation checking (Cloudflare API)
- [ ] Create device fingerprinting analysis
- [ ] Implement geolocation-based risk scoring
- [ ] Add velocity checks (login attempts per time window)
- [ ] Create anomaly detection logic:
  - [ ] Unusual time of login
  - [ ] Unusual location
  - [ ] New device
- [ ] Implement risk score calculation
- [ ] Add step-up authentication trigger (high risk → MFA)
- [ ] Create risk dashboard (admin)
- [ ] Add risk logging and audit trail
- [ ] Implement configurable risk thresholds
- [ ] Test risk-based flows
- [ ] Document risk-based authentication

#### 51.2 RBAC (Role-Based Access Control)
- [ ] Design role schema
- [ ] Create roles table (D1)
- [ ] Implement role definition API
- [ ] Create permission system (resource:action format)
- [ ] Implement role assignment to users
- [ ] Create role-based scope mapping
- [ ] Add role inheritance support
- [ ] Implement permission checking middleware
- [ ] Create admin UI for role management
- [ ] Add unit tests for RBAC
- [ ] Test role hierarchy
- [ ] Document RBAC architecture

#### 51.3 ABAC (Attribute-Based Access Control)
- [ ] Design attribute schema
- [ ] Implement attribute storage
- [ ] Create policy definition language
- [ ] Implement policy evaluation engine
- [ ] Add attribute-based rules (optional, research OPA integration)
- [ ] Create policy management UI
- [ ] Test ABAC policies
- [ ] Document ABAC usage

#### 51.4 Phase 8 Review & Testing
- [ ] Full integration testing of all Phase 8 features
- [ ] Security audit for new features
- [ ] Performance testing
- [ ] Update documentation
- [ ] Create migration guides

---

## Phase 8: Verifiable Credentials & Next-Gen 🚀 (Nov 3, 2026 - Jan 31, 2027)

### Week 52-54: OpenID for Verifiable Credentials (Nov 3-23)

#### 52.1 OpenID4VP (Verifiable Presentations) - OpenID4VP Spec
- [ ] Research W3C Verifiable Credentials data model
- [ ] Install and configure VC libraries
- [ ] Implement presentation request endpoint
- [ ] Create presentation definition schema
- [ ] Implement VP Token validation
- [ ] Add W3C Verifiable Credentials support
- [ ] Implement DID (Decentralized Identifier) resolution:
  - [ ] did:web method
  - [ ] did:key method
  - [ ] Universal resolver integration
- [ ] Add selective disclosure support
- [ ] Implement presentation submission validation
- [ ] Create unit tests for VP validation
- [ ] Test with sample VCs
- [ ] Document OpenID4VP implementation

#### 52.2 OpenID4CI (Credential Issuance) - OpenID4CI Spec
- [ ] Design credential types schema
- [ ] Implement credential offer endpoint
- [ ] Create credential offer generation
- [ ] Implement credential issuance endpoint
- [ ] Add credential format support:
  - [ ] JWT-VC (JSON Web Token VC)
  - [ ] LD-Proof (Linked Data Proofs)
- [ ] Implement batch credential issuance
- [ ] Add deferred credential issuance support
- [ ] Create credential metadata endpoint
- [ ] Implement credential nonce handling
- [ ] Create unit tests for credential issuance
- [ ] Test end-to-end issuance flow
- [ ] Document OpenID4CI setup

#### 52.3 OpenID4IA (Identity Assurance) - OpenID4IA Spec
- [ ] Design verified claims schema
- [ ] Implement verified claims support in ID token
- [ ] Create trust framework configuration
- [ ] Implement evidence attachment
- [ ] Add assurance level support (AL1, AL2, AL3)
- [ ] Create KYC/AML integration hooks
- [ ] Implement claims source references
- [ ] Add time-based verification expiry
- [ ] Create unit tests for identity assurance
- [ ] Test verified claims flow
- [ ] Document OpenID4IA usage

---

### Week 55-57: Federation & OAuth 2.1 (Nov 24 - Dec 14)

#### 55.1 OpenID Federation 1.0 - Federation Spec
- [ ] Research OpenID Federation specification
- [ ] Design entity configuration
- [ ] Implement entity statement generation
- [ ] Create federation metadata endpoint
- [ ] Implement trust chain validation
- [ ] Add automatic trust establishment
- [ ] Create federation registration
- [ ] Implement subordinate statement
- [ ] Add trust anchor configuration
- [ ] Create admin UI for federation management
- [ ] Test federation trust chain
- [ ] Document federation setup

#### 55.2 OAuth 2.1 (draft) - OAuth 2.1 Draft
- [ ] Review OAuth 2.1 specification changes
- [ ] Ensure PKCE is mandatory (already implemented)
- [ ] Verify refresh token rotation (Phase 4)
- [ ] Implement exact redirect URI matching
- [ ] Remove implicit grant support (deprecate)
- [ ] Remove resource owner password credentials grant (deprecate)
- [ ] Update security best practices
- [ ] Add Bearer token usage restrictions
- [ ] Update documentation for OAuth 2.1
- [ ] Run conformance tests
- [ ] Document OAuth 2.1 compliance

---

### Week 58-60: Privacy & Advanced Features (Dec 15, 2026 - Jan 11, 2027)

#### 58.1 Ephemeral Identity
- [ ] Design ephemeral user schema
- [ ] Implement temporary user account generation
- [ ] Create anonymous authentication flow
- [ ] Add zero-knowledge proof integration (research)
- [ ] Implement self-destructing sessions
- [ ] Create privacy-preserving analytics
- [ ] Add ephemeral identity cleanup job
- [ ] Test ephemeral flows
- [ ] Document ephemeral identity usage

#### 58.2 Advanced Privacy Features
- [ ] Implement differential privacy for analytics
- [ ] Create granular consent management
- [ ] Implement right to erasure automation (GDPR Article 17)
- [ ] Add data portability (GDPR Article 20):
  - [ ] Export user data to JSON
  - [ ] Export user data to CSV
- [ ] Create privacy dashboard (user-facing)
- [ ] Add privacy preference center
- [ ] Implement cookie consent management
- [ ] Add privacy audit log
- [ ] Test privacy features
- [ ] Document privacy compliance

#### 58.3 Advanced Analytics & Reporting
- [ ] Enhance analytics dashboard
- [ ] Implement user behavior tracking (privacy-preserving)
- [ ] Create conversion funnels:
  - [ ] Signup funnel
  - [ ] Login funnel
  - [ ] Consent funnel
- [ ] Add geographic distribution heatmap
- [ ] Implement device/browser statistics
- [ ] Create authentication method breakdown chart
- [ ] Build custom reports builder
- [ ] Add export to CSV/PDF/JSON
- [ ] Implement scheduled reports (email delivery)
- [ ] Test analytics accuracy
- [ ] Document analytics features

#### 58.4 Compliance & Governance
- [ ] Create compliance report templates:
  - [ ] GDPR compliance report
  - [ ] SOC 2 compliance report
  - [ ] ISO 27001 compliance report
- [ ] Implement data retention policies
- [ ] Add automated retention enforcement
- [ ] Create user data export tool (GDPR)
- [ ] Implement user data deletion tool (GDPR)
- [ ] Add privacy policy templates (multi-language)
- [ ] Create Terms of Service templates
- [ ] Implement cookie consent management
- [ ] Test compliance features
- [ ] Document compliance processes

---

### Week 61-63: Developer Tools & Ecosystem (Jan 12-31, 2027)

#### 61.1 Mobile SDKs
- [ ] Design SDK architecture
- [ ] Create iOS SDK (Swift):
  - [ ] OIDC client implementation
  - [ ] PKCE support
  - [ ] Biometric authentication integration
  - [ ] Keychain storage
  - [ ] Example iOS app
- [ ] Create Android SDK (Kotlin):
  - [ ] OIDC client implementation
  - [ ] PKCE support
  - [ ] Biometric authentication integration
  - [ ] Keystore storage
  - [ ] Example Android app
- [ ] Create React Native SDK:
  - [ ] Cross-platform OIDC client
  - [ ] Secure storage
  - [ ] Example React Native app
- [ ] Create Flutter SDK:
  - [ ] Dart OIDC client
  - [ ] Secure storage
  - [ ] Example Flutter app
- [ ] Publish SDKs to package managers
- [ ] Document SDK usage
- [ ] Create SDK tutorials

#### 61.2 Infrastructure as Code
- [ ] Create Terraform provider:
  - [ ] Client resource
  - [ ] User resource
  - [ ] Configuration resource
- [ ] Create Kubernetes Helm charts:
  - [ ] Deployment manifests
  - [ ] Service definitions
  - [ ] ConfigMaps and Secrets
  - [ ] Ingress configuration
- [ ] Create Pulumi provider
- [ ] Create Docker Compose templates
- [ ] Create CloudFormation templates (AWS)
- [ ] Document IaC usage
- [ ] Add IaC examples

#### 61.3 Developer APIs & Integrations
- [ ] Design GraphQL schema
- [ ] Implement GraphQL API:
  - [ ] User queries
  - [ ] Client queries
  - [ ] Session queries
  - [ ] Mutations for management
- [ ] Add GraphQL playground
- [ ] Implement webhooks system:
  - [ ] User events (created, updated, deleted)
  - [ ] Auth events (login, logout, token issued)
  - [ ] Client events (registered, updated)
- [ ] Create webhook delivery system
- [ ] Add webhook retry logic
- [ ] Implement event streaming (optional Kafka/NATS)
- [ ] Create CLI plugin system
- [ ] Generate OpenAPI/Swagger spec
- [ ] Create API documentation portal
- [ ] Test all APIs
- [ ] Document GraphQL and webhooks

#### 61.4 Phase 9 Review & Testing
- [ ] Full integration testing
- [ ] Security audit
- [ ] Performance testing
- [ ] Update all documentation
- [ ] Create comprehensive examples

---

## Phase 9: White-Label & SaaS Platform 🌐 (Feb 1, 2027 onwards)

### Week 64-67: Multi-Tenancy Foundation (Feb 1-28)

#### 64.1 Multi-Tenant Architecture
- [ ] Design multi-tenant data model
- [ ] Create tenant schema (D1):
  - [ ] Tenants table
  - [ ] Tenant-user relationship
  - [ ] Tenant-client relationship
  - [ ] Tenant settings
- [ ] Implement tenant isolation:
  - [ ] Database row-level security
  - [ ] KV namespace per tenant
  - [ ] Durable Object per tenant
- [ ] Create tenant context middleware
- [ ] Implement tenant-aware queries
- [ ] Add tenant creation workflow
- [ ] Implement tenant deletion workflow
- [ ] Test data isolation
- [ ] Document multi-tenancy architecture

#### 64.2 Custom Domain per Tenant
- [ ] Implement custom domain configuration
- [ ] Create DNS verification flow
- [ ] Add SSL/TLS certificate provisioning per domain
- [ ] Implement domain routing logic
- [ ] Create domain management UI
- [ ] Add domain verification status tracking
- [ ] Test custom domain setup
- [ ] Document custom domain configuration

#### 64.3 Tenant Management Dashboard
- [ ] Create tenant admin dashboard
- [ ] Implement tenant list view
- [ ] Add tenant creation wizard
- [ ] Create tenant settings page
- [ ] Implement tenant suspension
- [ ] Add tenant deletion (with confirmation)
- [ ] Create tenant usage statistics
- [ ] Test tenant management flows

#### 64.4 Tenant Provisioning API
- [ ] Design tenant provisioning API
- [ ] Implement `POST /api/tenants` (create)
- [ ] Add `GET /api/tenants` (list)
- [ ] Implement `GET /api/tenants/{id}` (get)
- [ ] Add `PUT /api/tenants/{id}` (update)
- [ ] Implement `DELETE /api/tenants/{id}` (delete)
- [ ] Create tenant onboarding automation
- [ ] Test provisioning API

#### 64.5 Resource Quotas per Tenant
- [ ] Design quota system
- [ ] Implement quota tracking:
  - [ ] MAU (Monthly Active Users)
  - [ ] API calls per month
  - [ ] Storage usage
  - [ ] Number of clients
- [ ] Add quota enforcement
- [ ] Create quota exceeded handling
- [ ] Implement quota alerts
- [ ] Create quota dashboard
- [ ] Test quota system

---

### Week 68-71: Billing & Monetization (Mar 1-28, 2027)

#### 68.1 Stripe Integration
- [ ] Set up Stripe account
- [ ] Install Stripe SDK
- [ ] Implement Stripe webhook handling
- [ ] Create customer creation in Stripe
- [ ] Implement payment method collection
- [ ] Add subscription creation
- [ ] Implement subscription updates
- [ ] Add subscription cancellation
- [ ] Test Stripe integration

#### 68.2 Usage Metering
- [ ] Implement MAU tracking
- [ ] Create API call metering
- [ ] Add storage usage tracking
- [ ] Implement metered billing
- [ ] Create usage reporting to Stripe
- [ ] Add usage dashboard (per tenant)
- [ ] Test metering accuracy

#### 68.3 Plan & Pricing Tiers
- [ ] Design pricing tiers:
  - [ ] Free tier (limited MAU, features)
  - [ ] Pro tier (higher limits, advanced features)
  - [ ] Enterprise tier (unlimited, custom)
- [ ] Implement plan configuration
- [ ] Create plan comparison page
- [ ] Add upgrade/downgrade flows
- [ ] Implement feature gating per plan
- [ ] Create pricing calculator
- [ ] Test plan transitions

#### 68.4 Invoice Generation
- [ ] Implement invoice generation via Stripe
- [ ] Create invoice email templates
- [ ] Add invoice download (PDF)
- [ ] Implement invoice history
- [ ] Test invoice generation

#### 68.5 Subscription Management
- [ ] Create subscription dashboard
- [ ] Implement plan selection UI
- [ ] Add payment method management
- [ ] Create subscription status display
- [ ] Implement trial period handling
- [ ] Add promo code support
- [ ] Test subscription flows

---

### Week 72-75: Marketplace (Mar 29 - Apr 25, 2027)

#### 72.1 Plugin System Architecture
- [ ] Design plugin architecture
- [ ] Create plugin manifest schema
- [ ] Implement plugin loader
- [ ] Add plugin lifecycle management (install, activate, deactivate, uninstall)
- [ ] Create plugin API
- [ ] Implement plugin sandboxing
- [ ] Add plugin permissions system
- [ ] Test plugin system

#### 72.2 Plugin Marketplace
- [ ] Design marketplace schema
- [ ] Create plugin submission flow
- [ ] Implement plugin review process
- [ ] Add plugin search and filtering
- [ ] Create plugin detail pages
- [ ] Implement plugin ratings and reviews
- [ ] Add plugin install from marketplace
- [ ] Test marketplace flows

#### 72.3 Third-Party Plugin Submission
- [ ] Create plugin developer documentation
- [ ] Implement plugin SDK
- [ ] Add plugin submission portal
- [ ] Create plugin validation
- [ ] Implement security review process
- [ ] Add plugin approval workflow
- [ ] Test plugin submission

#### 72.4 Plugin Versioning & Updates
- [ ] Implement plugin versioning
- [ ] Create plugin update mechanism
- [ ] Add automatic update option
- [ ] Implement rollback support
- [ ] Add update notifications
- [ ] Test plugin updates

#### 72.5 Plugin Revenue Sharing
- [ ] Design revenue sharing model
- [ ] Implement payment distribution
- [ ] Create developer payouts
- [ ] Add revenue reporting for developers
- [ ] Test revenue sharing

---

### Week 76+: Platform Refinement & Growth (Apr 26, 2027 onwards)

#### 76.1 White-Label Customization
- [ ] Implement full white-label branding
- [ ] Create custom CSS injection
- [ ] Add custom JavaScript support
- [ ] Implement email template customization
- [ ] Create reseller program
- [ ] Test white-label features

#### 76.2 Advanced Monitoring & SLA
- [ ] Implement uptime monitoring
- [ ] Create SLA tracking
- [ ] Add incident management
- [ ] Implement status page
- [ ] Create SLA reports
- [ ] Test monitoring system

#### 76.3 Enterprise Support Features
- [ ] Create dedicated support portal
- [ ] Implement ticketing system
- [ ] Add live chat support
- [ ] Create knowledge base
- [ ] Implement priority support queues
- [ ] Test support features

#### 76.4 Marketing & Growth
- [ ] Create landing page
- [ ] Implement SEO optimization
- [ ] Add blog and content marketing
- [ ] Create case studies
- [ ] Implement referral program
- [ ] Add affiliate program
- [ ] Create marketing automation

---

## Phase 9 Success Metrics

### Multi-Tenancy
- [ ] 100+ active tenants
- [ ] 99.9% data isolation
- [ ] <100ms tenant context switching
- [ ] Zero cross-tenant data leaks

### Billing & Monetization
- [ ] $10k+ MRR (Monthly Recurring Revenue)
- [ ] >80% subscription retention rate
- [ ] <5% churn rate
- [ ] 100% billing accuracy

### Marketplace
- [ ] 20+ published plugins
- [ ] 10+ third-party developers
- [ ] 1000+ plugin installs
- [ ] 4.5+ average plugin rating

### Platform Growth
- [ ] 100+ paying customers
- [ ] 10,000+ end users across all tenants
- [ ] 99.99% uptime SLA
- [ ] <50ms global p95 latency

---

## Phase 10: Certification & Production Launch 🎓 (Final Phase)

### Advanced Security Protocols (Pre-Certification)

#### 10.1 JARM (JWT Secured Authorization Response Mode) - JARM Spec
- [ ] Implement `response_mode=jwt` support
- [ ] Implement `response_mode=query.jwt` support
- [ ] Implement `response_mode=fragment.jwt` support
- [ ] Implement `response_mode=form_post.jwt` support
- [ ] Add authorization response JWT signing
- [ ] Implement response JWT encryption (optional)
- [ ] Add tests & conformance validation
- [ ] Document JARM configuration
- **Why:** OpenID認証で高評価、レスポンス改ざん防止

#### 10.2 MTLS (Mutual TLS Client Authentication) - RFC 8705
- [ ] Implement MTLS client certificate validation
- [ ] Add certificate-bound access tokens
- [ ] Implement `tls_client_auth` method support
- [ ] Implement `self_signed_tls_client_auth` support
- [ ] Add certificate thumbprint validation
- [ ] Implement certificate chain validation
- [ ] Add tests & conformance validation
- [ ] Document MTLS setup & configuration
- **Why:** エンタープライズ必須、最高レベルのセキュリティ、金融業界標準

#### 10.3 JAR (JWT-Secured Authorization Request) - RFC 9101
- [ ] Implement `request` parameter support (JWT)
- [ ] Implement `request_uri` parameter support
- [ ] Add request object validation
- [ ] Implement request object encryption (JWE)
- [ ] Add request object signing validation
- [ ] Implement `request_uri` pre-registration
- [ ] Add tests & conformance validation
- [ ] Document JAR usage & examples
- **Why:** セキュリティ強化、リクエスト改ざん防止、OpenID認証で必須

#### 10.4 Client Credentials Flow - RFC 6749 Section 4.4
- [ ] Implement `grant_type=client_credentials` support
- [ ] Add client authentication (client_secret_basic)
- [ ] Add client authentication (client_secret_post)
- [ ] Add client authentication (private_key_jwt)
- [ ] Implement machine-to-machine token issuance
- [ ] Add scope-based access control
- [ ] Implement token introspection for client credentials
- [ ] Add tests & conformance validation
- [ ] Document client credentials setup
- **Why:** 基本フロー、サーバー間認証で必須、メジャーな実装

---

### Production Deployment

#### 10.5 Production Environment
- [ ] Set up production Cloudflare account
- [ ] Configure custom domain (`id.enrai.org`)
- [ ] Set up DNS records
- [ ] Configure SSL/TLS (with MTLS support)

#### 10.6 Production Configuration
- [ ] Generate production RSA keys
- [ ] Configure production secrets
- [ ] Set up production KV namespaces
- [ ] Configure environment variables
- [ ] Set up production monitoring

#### 10.7 Deployment
- [ ] Deploy to production
- [ ] Verify all endpoints work
- [ ] Test with external clients
- [ ] Load testing & performance validation
- [ ] Monitor for errors

---

### OpenID Certification Submission

#### 10.8 Pre-Submission Testing
- [ ] Full conformance suite run (all tests)
- [ ] PAR, DPoP, JARM, MTLS validation
- [ ] Security audit (external)
- [ ] Performance benchmarks
- [ ] Documentation review

#### 10.9 Documentation
- [ ] Prepare certification application
- [ ] Document deployment architecture
- [ ] Provide test results compilation (all phases)
- [ ] List supported features
- [ ] Security assessment report

#### 10.10 Submission
- [ ] Submit to OpenID Foundation
- [ ] Provide test environment access
- [ ] Respond to questions
- [ ] Track submission status

---

### Final Preparation

#### 10.11 Certification Approval
- [ ] Wait for certification review
- [ ] Address any feedback
- [ ] Re-testing (if needed)
- [ ] Obtain official certification

#### 10.12 Release Preparation
- [ ] Update README with certification mark
- [ ] Prepare release notes
- [ ] Create changelog
- [ ] Migration guide (from Auth0/Keycloak)
- [ ] Video tutorials
- [ ] Blog post & announcement
- [ ] Press kit preparation

#### 10.13 Milestone 10 Achievement
- [ ] Verify certification obtained
- [ ] Publish release
- [ ] Make announcement
- [ ] Celebrate! 🎉

---

**Phase 10 Deliverables:**
- [ ] JARM (JWT Secured Authorization Response) functional
- [ ] MTLS (Mutual TLS) implemented
- [ ] JAR (JWT-Secured Authorization Request) operational
- [ ] Client Credentials Flow working
- [ ] Production deployment live (`https://id.enrai.org`)
- [ ] OpenID Certification obtained ✨
- [ ] Public announcement ready
- [ ] Migration guides published

---

> **Enrai** ⚡️ — Building standards-compliant identity infrastructure, one task at a time.
>
> **Updated:** 2025-11-12 — Phase 4 (Extended Features) ✅ COMPLETE
> - Added Dynamic Client Registration (RFC 7591)
> - Implemented Rate Limiting Middleware
> - Enhanced Security Headers & CORS
> - Added 85 comprehensive tests (263 total tests passing)
> - All Phase 4 milestones achieved
>
> **Phase Order Updated:** 2025-11-12
> - Phase 5-9: Moved up (UI/UX → CLI → Enterprise → VC → SaaS)
> - Phase 10: Certification & Production Launch (moved to final phase)
