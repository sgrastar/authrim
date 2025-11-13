#!/bin/bash
# Create Phase 1 (Foundation) issues for Enrai project

set -e

echo "🔥 Creating Phase 1 issues..."
echo ""

# Get milestone number for M1
MILESTONE=$(gh api repos/:owner/:repo/milestones --jq '.[] | select(.title=="M1: Foundation Complete") | .number')

if [ -z "$MILESTONE" ]; then
    echo "❌ Error: Milestone 'M1: Foundation Complete' not found"
    echo "Run ./scripts/setup-github.sh first"
    exit 1
fi

echo "✅ Found M1 milestone (number: $MILESTONE)"
echo ""

# =============================================================================
# Week 1: Project Structure & Environment Setup
# =============================================================================

echo "📝 Creating Week 1 issues..."

gh issue create \
    --title "Week 1: Project Structure & Environment Setup" \
    --milestone "$MILESTONE" \
    --label "phase:1-foundation,type:task,priority:high" \
    --body "$(cat <<'EOF'
## Overview
Complete initial project setup including directory structure, configuration files, and development environment.

**Timeline**: Nov 10-16, 2025

## Tasks

### Project Initialization
- [ ] Initialize Git repository structure
- [ ] Create `.gitignore` file
- [ ] Create directory structure (src/, test/, docs/, etc.)

### Package Management
- [ ] Create `package.json` with metadata
- [ ] Install dependencies (hono, jose, @cloudflare/workers-types)
- [ ] Install dev dependencies (typescript, vitest, prettier, eslint)

### TypeScript Configuration
- [ ] Create `tsconfig.json`
- [ ] Configure strict mode and ES2022 target
- [ ] Set up path aliases

### Cloudflare Workers Configuration
- [ ] Create `wrangler.toml`
- [ ] Configure KV namespace bindings
- [ ] Set environment variables
- [ ] Test `wrangler dev`

### Code Quality Tools
- [ ] Create `.prettierrc` configuration
- [ ] Create `.eslintrc.json` configuration
- [ ] Configure VSCode settings

## Acceptance Criteria
- [ ] `wrangler dev` launches successfully
- [ ] TypeScript compiles without errors
- [ ] All configuration files are in place
- [ ] Project structure matches specification

## Related
See: KICKOFF_CHECKLIST.md Phase 1
EOF
)"

gh issue create \
    --title "Week 2: Hono Framework Integration" \
    --milestone "$MILESTONE" \
    --label "phase:1-foundation,type:feature,priority:high,component:auth" \
    --body "$(cat <<'EOF'
## Overview
Integrate Hono web framework and implement basic routing structure.

**Timeline**: Nov 17-23, 2025

## Tasks

### Basic Hono Application
- [ ] Create `src/index.ts` entry point
- [ ] Initialize Hono app with Cloudflare Workers types
- [ ] Configure CORS middleware
- [ ] Add security headers middleware
- [ ] Add request logging middleware

### Health Check Endpoint
- [ ] Implement `GET /health` endpoint
- [ ] Return JSON with status, version, timestamp
- [ ] Test endpoint locally

### Basic Routing Structure
- [ ] Create handler files in `src/handlers/`:
  - [ ] `discovery.ts`
  - [ ] `jwks.ts`
  - [ ] `authorize.ts`
  - [ ] `token.ts`
  - [ ] `userinfo.ts`
- [ ] Register routes in main app
- [ ] Add 404 handler
- [ ] Add error handling middleware

### Environment Types
- [ ] Define `Env` interface for Cloudflare bindings
- [ ] Create type definitions for request/response objects

## Acceptance Criteria
- [ ] `/health` endpoint returns valid JSON
- [ ] All route handlers are registered
- [ ] Error handling works correctly
- [ ] TypeScript types are complete

## Related
See: TASK_BREAKDOWN.md Week 2
EOF
)"

gh issue create \
    --title "Week 3: Cloudflare Services Integration" \
    --milestone "$MILESTONE" \
    --label "phase:1-foundation,type:feature,priority:high,component:kv" \
    --body "$(cat <<'EOF'
## Overview
Integrate Cloudflare KV storage and JOSE library for JWT operations.

**Timeline**: Nov 24-30, 2025

## Tasks

### KV Storage Setup
- [ ] Create KV namespace via Wrangler CLI
- [ ] Configure KV bindings in `wrangler.toml`
- [ ] Create KV utility functions:
  - [ ] `storeAuthCode()`
  - [ ] `getAuthCode()`
  - [ ] `deleteAuthCode()`
  - [ ] `storeState()`
  - [ ] `storeNonce()`
- [ ] Add TTL configuration (120s for codes)
- [ ] Test KV operations locally

### JOSE Library Integration
- [ ] Install and configure `jose` library
- [ ] Create key generation utilities:
  - [ ] `generateRSAKeyPair()`
  - [ ] `exportPublicJWK()`
  - [ ] `exportPrivateKey()`
- [ ] Test JWT signing and verification
- [ ] Test JWK export format

### Secret Management
- [ ] Generate RSA key pair for development
- [ ] Store private key in Wrangler secrets
- [ ] Create script to rotate keys
- [ ] Document secret management process

## Acceptance Criteria
- [ ] KV operations work in local dev
- [ ] JWT signing/verification works
- [ ] JWK export format is correct
- [ ] Secrets are properly configured

## Related
See: TASK_BREAKDOWN.md Week 3
EOF
)"

gh issue create \
    --title "Week 4: Authentication & Testing Framework" \
    --milestone "$MILESTONE" \
    --label "phase:1-foundation,type:test,priority:high" \
    --body "$(cat <<'EOF'
## Overview
Create JWT utilities, validation functions, and set up testing framework.

**Timeline**: Dec 1-7, 2025

## Tasks

### JWT Token Utilities
- [ ] Create `src/utils/jwt.ts`:
  - [ ] `createIDToken()`
  - [ ] `createAccessToken()`
  - [ ] `verifyToken()`
  - [ ] `parseToken()`
- [ ] Add proper error handling
- [ ] Test with different claim sets

### Validation Utilities
- [ ] Create `src/utils/validation.ts`:
  - [ ] `validateClientId()`
  - [ ] `validateRedirectUri()`
  - [ ] `validateScope()`
  - [ ] `validateState()`
  - [ ] `validateNonce()`
  - [ ] `validateGrantType()`
- [ ] Add regex patterns
- [ ] Test edge cases

### Testing Framework Setup
- [ ] Configure Vitest for unit testing
- [ ] Create test utilities:
  - [ ] Mock Cloudflare Workers environment
  - [ ] Mock KV storage
  - [ ] Test data generators
- [ ] Write sample tests for utilities
- [ ] Set up test coverage reporting

## Acceptance Criteria
- [ ] All JWT utilities working correctly
- [ ] All validation utilities working
- [ ] Test framework configured
- [ ] Sample tests passing
- [ ] Test coverage > 50%

## Related
See: TASK_BREAKDOWN.md Week 4
EOF
)"

gh issue create \
    --title "Week 5: CI/CD & Documentation" \
    --milestone "$MILESTONE" \
    --label "phase:1-foundation,type:task,priority:medium,type:docs" \
    --body "$(cat <<'EOF'
## Overview
Set up CI/CD pipelines and complete development documentation.

**Timeline**: Dec 8-15, 2025

## Tasks

### GitHub Actions CI/CD
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

### Development Documentation
- [ ] Create `CONTRIBUTING.md` guide
- [ ] Create `DEVELOPMENT.md` with setup instructions
- [ ] Document environment variable setup
- [ ] Create API documentation template
- [ ] Add code examples

### Code Review & Refactoring
- [ ] Review all code from Weeks 1-4
- [ ] Refactor for consistency
- [ ] Ensure proper TypeScript typing
- [ ] Add inline documentation (JSDoc)
- [ ] Update README with current status

### Milestone 1 Review
- [ ] Verify `wrangler dev` works
- [ ] Test basic routing
- [ ] Verify TypeScript builds
- [ ] Check all linting passes
- [ ] Ensure tests pass
- [ ] Document any blockers

## Acceptance Criteria
- [ ] CI/CD workflows running
- [ ] All documentation complete
- [ ] Code review completed
- [ ] M1 completion criteria met

## Related
See: TASK_BREAKDOWN.md Week 5, PROJECT_SCHEDULE.md M1
EOF
)"

echo ""
echo "✅ Phase 1 issues created"
echo ""
echo "View issues: gh issue list --milestone \"M1: Foundation Complete\""
echo ""
