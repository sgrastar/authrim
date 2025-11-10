# Hibana Task Breakdown

This document provides a comprehensive, week-by-week breakdown of all tasks required to build and certify the Hibana OpenID Connect Provider.

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
  - [x] Set worker name: `hibana`
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
- [ ] Create KV namespace via Wrangler CLI
- [ ] Configure KV bindings in `wrangler.toml`
- [ ] Create KV utility functions:
  - [ ] `storeAuthCode()` - Store authorization code
  - [ ] `getAuthCode()` - Retrieve authorization code
  - [ ] `deleteAuthCode()` - Delete used code
  - [ ] `storeState()` - Store state parameter
  - [ ] `storeNonce()` - Store nonce parameter
- [ ] Add TTL configuration (120s for codes, 300s for state/nonce)
- [ ] Test KV operations locally

#### 3.2 JOSE Library Integration
- [ ] Install and configure `jose` library
- [ ] Create key generation utilities:
  - [ ] `generateRSAKeyPair()` - Generate RS256 key pair
  - [ ] `exportPublicJWK()` - Export public key as JWK
  - [ ] `exportPrivateKey()` - Export private key (PEM format)
- [ ] Test JWT signing and verification
- [ ] Test JWK export format

#### 3.3 Durable Objects Planning
- [ ] Design Durable Object schema for key storage
- [ ] Create `KeyManager` Durable Object class
- [ ] Implement key rotation logic (planned for Phase 4)
- [ ] Document Durable Objects architecture

#### 3.4 Secret Management
- [ ] Generate RSA key pair for development
- [ ] Store private key in Wrangler secrets
- [ ] Create script to rotate keys
- [ ] Document secret management process

---

### Week 4: Authentication & Testing Framework (Dec 1-7)

#### 4.1 JWT Token Utilities
- [ ] Create `src/utils/jwt.ts`:
  - [ ] `createIDToken()` - Generate ID token with claims
  - [ ] `createAccessToken()` - Generate access token
  - [ ] `verifyToken()` - Verify JWT signature
  - [ ] `parseToken()` - Parse JWT without verification
- [ ] Add proper error handling for JWT operations
- [ ] Test with different claim sets

#### 4.2 Validation Utilities
- [ ] Create `src/utils/validation.ts`:
  - [ ] `validateClientId()` - Validate client_id format
  - [ ] `validateRedirectUri()` - Validate redirect_uri
  - [ ] `validateScope()` - Validate scope parameter
  - [ ] `validateState()` - Validate state parameter
  - [ ] `validateNonce()` - Validate nonce parameter
  - [ ] `validateGrantType()` - Validate grant_type
- [ ] Add regex patterns for validation
- [ ] Test edge cases

#### 4.3 Testing Framework Setup
- [ ] Configure Vitest for unit testing
- [ ] Create test utilities:
  - [ ] Mock Cloudflare Workers environment
  - [ ] Mock KV storage
  - [ ] Test data generators
- [ ] Write sample tests for utilities
- [ ] Set up test coverage reporting

#### 4.4 Integration Test Setup
- [ ] Install testing dependencies for e2e tests
- [ ] Create test fixtures (mock RP)
- [ ] Set up local Cloudflare Workers testing environment
- [ ] Create integration test skeleton

---

### Week 5: CI/CD & Documentation (Dec 8-15)

#### 5.1 GitHub Actions CI/CD
- [ ] Create `.github/workflows/ci.yml`:
  - [ ] Run on push and pull requests
  - [ ] Install dependencies
  - [ ] Run linter
  - [ ] Run type checking
  - [ ] Run tests
  - [ ] Build project
- [ ] Create `.github/workflows/deploy.yml`:
  - [ ] Deploy to Cloudflare Workers on merge to main
  - [ ] Use Wrangler action
  - [ ] Configure secrets

#### 5.2 Development Documentation
- [ ] Create `CONTRIBUTING.md` guide
- [ ] Create `DEVELOPMENT.md` with setup instructions
- [ ] Document environment variable setup
- [ ] Create API documentation template
- [ ] Add code examples for common operations

#### 5.3 Code Review & Refactoring
- [ ] Review all code from Weeks 1-4
- [ ] Refactor for consistency
- [ ] Ensure proper TypeScript typing
- [ ] Add inline documentation (JSDoc)
- [ ] Update README with current status

#### 5.4 Milestone 1 Review
- [ ] Verify `wrangler dev` works
- [ ] Test basic routing
- [ ] Verify TypeScript builds
- [ ] Check all linting passes
- [ ] Ensure tests pass
- [ ] Document any blockers or issues

---

## Phase 2: Core Implementation (Dec 16, 2025 - Jan 31, 2026)

### Week 6: Discovery & JWKS Endpoints (Dec 16-22)

#### 6.1 Discovery Endpoint Implementation
- [ ] Implement `GET /.well-known/openid-configuration`
- [ ] Return metadata JSON:
  - [ ] `issuer` - From environment variable
  - [ ] `authorization_endpoint`
  - [ ] `token_endpoint`
  - [ ] `userinfo_endpoint`
  - [ ] `jwks_uri`
  - [ ] `response_types_supported`: `["code"]`
  - [ ] `grant_types_supported`: `["authorization_code"]`
  - [ ] `id_token_signing_alg_values_supported`: `["RS256"]`
  - [ ] `subject_types_supported`: `["public"]`
  - [ ] `scopes_supported`: `["openid", "profile", "email"]`
  - [ ] `claims_supported`
- [ ] Add proper content-type header
- [ ] Test with curl and browser

#### 6.2 JWKS Endpoint Implementation
- [ ] Implement `GET /.well-known/jwks.json`
- [ ] Load public key from environment/Durable Object
- [ ] Convert RSA public key to JWK format
- [ ] Return JWKS JSON with:
  - [ ] `kty`: "RSA"
  - [ ] `alg`: "RS256"
  - [ ] `use`: "sig"
  - [ ] `kid`: from environment variable
  - [ ] `n`: modulus (base64url)
  - [ ] `e`: exponent (base64url)
- [ ] Add cache headers
- [ ] Test JWK format with validators

#### 6.3 Testing
- [ ] Unit tests for discovery endpoint
- [ ] Unit tests for JWKS endpoint
- [ ] Verify metadata format compliance
- [ ] Verify JWK format compliance
- [ ] Test with OpenID Connect validators

---

### Week 7: Authorization Endpoint (Dec 23-29)

#### 7.1 Authorization Request Handling
- [ ] Implement `GET /authorize`
- [ ] Parse query parameters:
  - [ ] `response_type` (required)
  - [ ] `client_id` (required)
  - [ ] `redirect_uri` (required)
  - [ ] `scope` (required)
  - [ ] `state` (optional but recommended)
  - [ ] `nonce` (optional)
- [ ] Validate all parameters
- [ ] Return errors for invalid requests

#### 7.2 Authorization Code Generation
- [ ] Generate secure random authorization code (UUID v4)
- [ ] Store code in KV with metadata:
  - [ ] `client_id`
  - [ ] `redirect_uri`
  - [ ] `scope`
  - [ ] `nonce`
  - [ ] `timestamp`
- [ ] Set TTL to 120 seconds
- [ ] Test code generation and storage

#### 7.3 State & Nonce Management
- [ ] Store state parameter in KV
- [ ] Store nonce parameter if provided
- [ ] Link state/nonce to authorization code
- [ ] Add replay protection

#### 7.4 Redirect Response
- [ ] Build redirect URL with:
  - [ ] `code` parameter
  - [ ] `state` parameter (if provided in request)
- [ ] Return 302 redirect
- [ ] Handle error cases with proper error responses
- [ ] Test redirect flow

#### 7.5 Testing
- [ ] Unit tests for parameter validation
- [ ] Integration tests for authorization flow
- [ ] Test error scenarios:
  - [ ] Missing required parameters
  - [ ] Invalid client_id
  - [ ] Invalid redirect_uri
  - [ ] Unsupported response_type

---

### Week 8: Token Endpoint (Dec 30 - Jan 5)

#### 8.1 Token Request Handling
- [ ] Implement `POST /token`
- [ ] Parse form-encoded body:
  - [ ] `grant_type` (required, must be "authorization_code")
  - [ ] `code` (required)
  - [ ] `client_id` (required)
  - [ ] `redirect_uri` (required)
  - [ ] `client_secret` (if applicable)
- [ ] Validate content-type header
- [ ] Validate all parameters

#### 8.2 Authorization Code Validation
- [ ] Retrieve code from KV
- [ ] Verify code exists and not expired
- [ ] Validate client_id matches
- [ ] Validate redirect_uri matches
- [ ] Delete code from KV (single use)
- [ ] Return error if validation fails

#### 8.3 ID Token Generation
- [ ] Load private key from secrets
- [ ] Create ID token claims:
  - [ ] `iss` - Issuer URL
  - [ ] `aud` - client_id
  - [ ] `sub` - User identifier
  - [ ] `iat` - Issued at timestamp
  - [ ] `exp` - Expiration timestamp (iat + TTL)
  - [ ] `nonce` - If provided in auth request
- [ ] Sign token with RS256
- [ ] Set proper kid in header

#### 8.4 Access Token Generation
- [ ] Generate access token (JWT or opaque string)
- [ ] Include necessary claims
- [ ] Sign token with RS256
- [ ] Set expiration

#### 8.5 Token Response
- [ ] Return JSON response:
  - [ ] `access_token`
  - [ ] `id_token`
  - [ ] `token_type`: "Bearer"
  - [ ] `expires_in`: TTL in seconds
- [ ] Add proper headers (content-type, no-cache)
- [ ] Test response format

#### 8.6 Testing
- [ ] Unit tests for token generation
- [ ] Integration tests for token exchange
- [ ] Test error scenarios:
  - [ ] Invalid grant_type
  - [ ] Invalid or expired code
  - [ ] Mismatched client_id
  - [ ] Mismatched redirect_uri
- [ ] Verify JWT format and signature

---

### Week 9: UserInfo Endpoint (Jan 6-12)

#### 9.1 UserInfo Request Handling
- [ ] Implement `GET /userinfo` and `POST /userinfo`
- [ ] Parse Authorization header
- [ ] Extract Bearer token
- [ ] Validate token format

#### 9.2 Access Token Validation
- [ ] Verify JWT signature
- [ ] Check token expiration
- [ ] Extract subject (sub) claim
- [ ] Handle validation errors

#### 9.3 User Claims Response
- [ ] Return user claims JSON:
  - [ ] `sub` - User identifier
  - [ ] `name` - User name (if requested)
  - [ ] `email` - User email (if requested)
  - [ ] `email_verified` - Boolean
  - [ ] Additional claims based on scope
- [ ] Static user data for MVP
- [ ] Plan for dynamic user data (future)

#### 9.4 Testing
- [ ] Unit tests for token validation
- [ ] Integration tests for userinfo flow
- [ ] Test with valid tokens
- [ ] Test with invalid/expired tokens
- [ ] Test with missing Authorization header

---

### Week 10: Error Handling & Validation (Jan 13-19)

#### 10.1 OAuth 2.0 Error Responses
- [ ] Implement standard error responses:
  - [ ] `invalid_request`
  - [ ] `invalid_client`
  - [ ] `invalid_grant`
  - [ ] `unauthorized_client`
  - [ ] `unsupported_grant_type`
  - [ ] `invalid_scope`
  - [ ] `server_error`
- [ ] Add error descriptions
- [ ] Test all error scenarios

#### 10.2 OIDC Error Responses
- [ ] Implement OIDC-specific errors:
  - [ ] `login_required`
  - [ ] `interaction_required`
  - [ ] `invalid_request_uri`
  - [ ] `invalid_request_object`
- [ ] Return errors via redirect when appropriate
- [ ] Return errors as JSON for token endpoint

#### 10.3 Input Validation Hardening
- [ ] Add strict URL validation
- [ ] Validate all string lengths
- [ ] Sanitize inputs
- [ ] Add rate limiting (future)
- [ ] Test injection attacks (SQL, XSS, etc.)

#### 10.4 Logging & Monitoring
- [ ] Add structured logging
- [ ] Log authentication attempts
- [ ] Log errors and exceptions
- [ ] Plan monitoring strategy
- [ ] Test logging output

---

### Week 11: Integration Testing (Jan 20-26)

#### 11.1 End-to-End Test Scenarios
- [ ] Create mock Relying Party application
- [ ] Test complete authorization code flow:
  - [ ] Discovery
  - [ ] Authorization request
  - [ ] Token exchange
  - [ ] UserInfo request
- [ ] Verify ID token validation
- [ ] Test with multiple clients

#### 11.2 Negative Test Cases
- [ ] Test with expired codes
- [ ] Test with invalid signatures
- [ ] Test with mismatched parameters
- [ ] Test with malformed requests
- [ ] Test concurrent requests

#### 11.3 Performance Testing
- [ ] Measure endpoint latency
- [ ] Test under load (basic)
- [ ] Identify bottlenecks
- [ ] Document performance metrics

#### 11.4 Bug Fixes
- [ ] Fix issues found in testing
- [ ] Regression testing
- [ ] Update documentation

---

### Week 12: Code Review & Refactoring (Jan 27-31)

#### 12.1 Code Quality Review
- [ ] Review all code for consistency
- [ ] Ensure TypeScript types are complete
- [ ] Remove dead code
- [ ] Optimize imports
- [ ] Check for security issues

#### 12.2 Documentation Update
- [ ] Update API documentation
- [ ] Add sequence diagrams
- [ ] Document error codes
- [ ] Add troubleshooting guide
- [ ] Update README

#### 12.3 Refactoring
- [ ] Extract common logic to utilities
- [ ] Improve error handling
- [ ] Optimize performance
- [ ] Add code comments where needed

#### 12.4 Milestone 2 Review
- [ ] Verify all endpoints work
- [ ] Run full test suite
- [ ] Test manual authorization flow
- [ ] Verify JWT signatures
- [ ] Check spec compliance
- [ ] Document any remaining issues

---

## Phase 3: Testing & Validation (Feb 1 - Mar 15, 2026)

### Week 13: Conformance Suite Setup (Feb 1-7)

#### 13.1 Environment Setup
- [ ] Install Docker and Docker Compose
- [ ] Clone OpenID Conformance Suite repository
- [ ] Configure conformance suite for Basic OP profile
- [ ] Set up local test environment

#### 13.2 Configuration
- [ ] Configure OP metadata:
  - [ ] Issuer URL
  - [ ] Client registration (static or dynamic)
  - [ ] Test credentials
- [ ] Configure test plan
- [ ] Document setup process

#### 13.3 Initial Test Run
- [ ] Run conformance suite
- [ ] Collect test results
- [ ] Identify failing tests
- [ ] Prioritize fixes

---

### Week 14-17: Conformance Test Fixes (Feb 8 - Mar 7)

#### 14.1 Discovery & Metadata Tests
- [ ] Fix any discovery endpoint issues
- [ ] Ensure metadata format compliance
- [ ] Test issuer consistency
- [ ] Fix JWKS format issues

#### 14.2 Core Flow Tests
- [ ] Fix authorization endpoint issues
- [ ] Fix token endpoint issues
- [ ] Fix userinfo endpoint issues
- [ ] Ensure proper state handling

#### 14.3 JWT/JWK Tests
- [ ] Fix signature verification issues
- [ ] Ensure proper kid handling
- [ ] Fix claim format issues
- [ ] Test token expiration

#### 14.4 OAuth 2.0 Tests
- [ ] Fix grant type handling
- [ ] Fix error response format
- [ ] Test redirect handling
- [ ] Fix parameter validation

#### 14.5 Edge Cases
- [ ] Test clock skew tolerance
- [ ] Test nonce verification
- [ ] Test replay protection
- [ ] Test concurrent flows

---

### Week 18: Final Validation (Mar 8-15)

#### 18.1 Complete Test Run
- [ ] Run full conformance suite
- [ ] Verify all tests pass
- [ ] Document any warnings
- [ ] Calculate conformance score

#### 18.2 Test Report
- [ ] Create detailed test report
- [ ] Document test environment
- [ ] List all passing tests
- [ ] Explain any failing tests
- [ ] Create action plan for remaining issues

#### 18.3 Milestone 3 Review
- [ ] Verify conformance score ≥ 85%
- [ ] Review all test results
- [ ] Document certification readiness
- [ ] Plan for extended features

---

## Phase 4: Extended Features (Mar 16 - Apr 30, 2026)

### Week 19-20: Dynamic Client Registration (Mar 16-29)

#### 19.1 Registration Endpoint
- [ ] Implement `POST /register`
- [ ] Parse registration request
- [ ] Validate client metadata
- [ ] Generate client_id and client_secret

#### 19.2 Client Storage
- [ ] Store client metadata in KV/Durable Objects
- [ ] Implement client lookup
- [ ] Support client updates
- [ ] Test registration flow

#### 19.3 Testing
- [ ] Unit tests for registration
- [ ] Integration tests
- [ ] Conformance suite tests (if applicable)

---

### Week 21-22: Key Rotation & Extended Claims (Mar 30 - Apr 12)

#### 21.1 Key Rotation
- [ ] Implement KeyManager Durable Object
- [ ] Add key rotation logic
- [ ] Support multiple active keys
- [ ] Update JWKS endpoint for multiple keys

#### 21.2 Extended Claims
- [ ] Add support for `email` claim
- [ ] Add support for `profile` claims
- [ ] Add support for custom claims
- [ ] Test claim handling

#### 21.3 Nonce Enforcement
- [ ] Make nonce mandatory (configurable)
- [ ] Strengthen nonce validation
- [ ] Add replay protection
- [ ] Test nonce handling

---

### Week 23-24: Security & Performance (Apr 13-26)

#### 23.1 Security Audit
- [ ] Review authentication logic
- [ ] Check for injection vulnerabilities
- [ ] Review token handling
- [ ] Check for timing attacks
- [ ] Test CORS configuration
- [ ] Review secret management

#### 23.2 Performance Optimization
- [ ] Profile endpoint performance
- [ ] Optimize KV operations
- [ ] Add caching where appropriate
- [ ] Test under load
- [ ] Measure edge latency

#### 23.3 Rate Limiting
- [ ] Implement basic rate limiting
- [ ] Use Cloudflare rate limiting features
- [ ] Test rate limiting
- [ ] Document limits

---

### Week 25: Review & Documentation (Apr 27-30)

#### 25.1 Final Review
- [ ] Code review
- [ ] Security review
- [ ] Performance review
- [ ] Documentation review

#### 25.2 Milestone 4 Review
- [ ] Verify all extended features work
- [ ] Run conformance tests
- [ ] Update documentation
- [ ] Prepare for production deployment

---

## Phase 5: Certification Preparation (May 1-31, 2026)

### Week 26-27: Production Deployment (May 1-14)

#### 26.1 Production Environment
- [ ] Set up production Cloudflare account
- [ ] Configure custom domain (`id.hibana.dev`)
- [ ] Set up DNS records
- [ ] Configure SSL/TLS

#### 26.2 Production Configuration
- [ ] Generate production RSA keys
- [ ] Configure production secrets
- [ ] Set up production KV namespaces
- [ ] Configure environment variables

#### 26.3 Deployment
- [ ] Deploy to production
- [ ] Verify all endpoints work
- [ ] Test with external clients
- [ ] Monitor for errors

---

### Week 28: Certification Submission (May 15-21)

#### 28.1 Documentation
- [ ] Prepare certification application
- [ ] Document deployment architecture
- [ ] Provide test results
- [ ] List supported features

#### 28.2 Submission
- [ ] Submit to OpenID Foundation
- [ ] Provide test environment access
- [ ] Respond to questions
- [ ] Track submission status

---

### Week 29: Final Preparation (May 22-31)

#### 29.1 Certification Approval
- [ ] Wait for certification review
- [ ] Address any feedback
- [ ] Obtain official certification

#### 29.2 Release Preparation
- [ ] Update README with certification mark
- [ ] Prepare release notes
- [ ] Create changelog
- [ ] Plan announcement

#### 29.3 Milestone 5 Achievement
- [ ] Verify certification obtained
- [ ] Publish release
- [ ] Make announcement
- [ ] Celebrate! 🎉

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

### Code Quality
- [ ] Test coverage ≥ 80%
- [ ] Zero TypeScript errors
- [ ] Zero linting errors
- [ ] All tests passing

### Performance
- [ ] Endpoint latency < 100ms (p95)
- [ ] JWT signing < 10ms
- [ ] KV operations < 5ms

### Compliance
- [ ] OpenID Conformance Suite ≥ 85% passing
- [ ] All required OIDC endpoints functional
- [ ] All required claims supported
- [ ] Proper error handling

### Documentation
- [ ] All endpoints documented
- [ ] Setup guide complete
- [ ] API reference complete
- [ ] Troubleshooting guide complete

---

> **Hibana** 🔥 — Building standards-compliant identity infrastructure, one task at a time.
