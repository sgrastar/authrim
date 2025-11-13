# Enrai Project Kickoff Checklist

## Overview
This checklist covers all immediate tasks needed to kickoff the Enrai project and complete Week 1 deliverables.

**Target Completion**: November 16, 2025
**Milestone**: M1 - Foundation Complete (Dec 15, 2025)

**Related Documents:**
- [Project Schedule](./SCHEDULE.md) - Complete 6-month timeline
- [Task Breakdown](./TASKS.md) - Detailed week-by-week tasks (440+ items)
- [GitHub Workflow](./GITHUB_WORKFLOW.md) - Issue tracking setup
- [Technical Specifications](../architecture/technical-specs.md) - Architecture overview

---

## Prerequisites

### Development Environment
- [ ] Node.js 18+ installed
- [ ] pnpm or pnpm installed
- [ ] Git configured
- [ ] Code editor installed (VS Code recommended)
- [ ] Cloudflare account created
- [ ] Wrangler CLI installed globally (`pnpm install -g wrangler`)

### Accounts & Access
- [ ] GitHub repository access configured
- [ ] Cloudflare account set up
- [ ] Cloudflare API token generated
- [ ] Git branch created: `claude/enrai-project-setup-011CUzP18xDrPBpH2wQgouqJ`

---

## Phase 1: Project Structure Setup

### Directory Structure
Create the following directory structure:

```
enrai/
├── .github/
│   └── workflows/          # CI/CD workflows
├── src/
│   ├── handlers/           # Endpoint handlers
│   ├── utils/              # Utility functions
│   ├── types/              # TypeScript type definitions
│   └── index.ts            # Main entry point
├── test/
│   ├── unit/               # Unit tests
│   └── integration/        # Integration tests
├── docs/                   # Existing documentation
├── dist/                   # Build output (gitignored)
└── node_modules/           # Dependencies (gitignored)
```

**Tasks:**
- [ ] Create `src/` directory
- [ ] Create `src/handlers/` directory
- [ ] Create `src/utils/` directory
- [ ] Create `src/types/` directory
- [ ] Create `test/` directory
- [ ] Create `test/unit/` directory
- [ ] Create `test/integration/` directory
- [ ] Create `.github/workflows/` directory

---

## Phase 2: Configuration Files

### 1. Package Configuration

**File**: `package.json`

- [ ] Create `package.json` with:
  - [ ] Project name: `enrai`
  - [ ] Version: `0.1.0`
  - [ ] Description: OpenID Connect Provider on Cloudflare Workers
  - [ ] Main entry point: `src/index.ts`
  - [ ] Scripts:
    - `dev`: Run local development server
    - `build`: Build TypeScript
    - `deploy`: Deploy to Cloudflare
    - `test`: Run tests
    - `lint`: Run linter
    - `format`: Run formatter
  - [ ] Dependencies:
    - `hono`: `^4.0.0`
    - `jose`: `^5.0.0`
  - [ ] DevDependencies:
    - `@cloudflare/workers-types`: `^4.0.0`
    - `wrangler`: `^3.0.0`
    - `typescript`: `^5.0.0`
    - `vitest`: `^1.0.0`
    - `prettier`: `^3.0.0`
    - `eslint`: `^8.0.0`
    - `@typescript-eslint/eslint-plugin`: `^6.0.0`
    - `@typescript-eslint/parser`: `^6.0.0`

### 2. TypeScript Configuration

**File**: `tsconfig.json`

- [ ] Create `tsconfig.json` with:
  - [ ] `target`: "ES2022"
  - [ ] `module`: "ESNext"
  - [ ] `moduleResolution`: "bundler"
  - [ ] `strict`: true
  - [ ] `esModuleInterop`: true
  - [ ] `skipLibCheck`: true
  - [ ] `types`: `["@cloudflare/workers-types"]`
  - [ ] `outDir`: "./dist"
  - [ ] `rootDir`: "./src"
  - [ ] Path aliases: `"@/*": ["./src/*"]`

### 3. Cloudflare Workers Configuration

**File**: `wrangler.toml`

- [ ] Create `wrangler.toml` with:
  - [ ] `name`: "enrai"
  - [ ] `main`: "src/index.ts"
  - [ ] `compatibility_date`: "2024-11-01"
  - [ ] KV namespace bindings:
    ```toml
    [[kv_namespaces]]
    binding = "STATE_KV"
    id = "<to-be-created>"
    preview_id = "<to-be-created>"
    ```
  - [ ] Environment variables:
    ```toml
    [vars]
    ISSUER_DOMAIN = "localhost:8787"  # For local dev
    JWKS_KID = "edge-key-1"
    TOKEN_TTL = "600"
    ```

### 4. Code Quality Configuration

**File**: `.prettierrc`

- [ ] Create `.prettierrc` with:
  - [ ] `semi`: true
  - [ ] `singleQuote`: true
  - [ ] `tabWidth`: 2
  - [ ] `trailingComma`: "es5"
  - [ ] `printWidth`: 80

**File**: `.eslintrc.json`

- [ ] Create `.eslintrc.json` with:
  - [ ] Parser: `@typescript-eslint/parser`
  - [ ] Plugins: `@typescript-eslint`
  - [ ] Extends: `eslint:recommended`, `plugin:@typescript-eslint/recommended`
  - [ ] Rules configured

**File**: `.gitignore`

- [ ] Create `.gitignore` with:
  - [ ] `node_modules/`
  - [ ] `dist/`
  - [ ] `.env`
  - [ ] `.wrangler/`
  - [ ] `*.log`
  - [ ] `.DS_Store`
  - [ ] `coverage/`

**File**: `.editorconfig`

- [ ] Create `.editorconfig` for consistent coding style

### 5. VS Code Configuration (Optional)

**File**: `.vscode/settings.json`

- [ ] Create workspace settings:
  - [ ] Format on save
  - [ ] TypeScript SDK path
  - [ ] Recommended extensions

**File**: `.vscode/extensions.json`

- [ ] Recommend extensions:
  - [ ] ESLint
  - [ ] Prettier
  - [ ] TypeScript

---

## Phase 3: Initial Code Implementation

### 1. Type Definitions

**File**: `src/types/env.ts`

- [ ] Create `Env` interface:
  ```typescript
  export interface Env {
    STATE_KV: KVNamespace;
    ISSUER_DOMAIN: string;
    JWKS_KID: string;
    TOKEN_TTL: string;
    PRIVATE_KEY: string;
  }
  ```

**File**: `src/types/oidc.ts`

- [ ] Define OIDC-related types:
  - [ ] `AuthorizationRequest`
  - [ ] `TokenRequest`
  - [ ] `IDTokenClaims`
  - [ ] `DiscoveryMetadata`
  - [ ] `JWKSet`

### 2. Main Application

**File**: `src/index.ts`

- [ ] Create basic Hono application:
  ```typescript
  import { Hono } from 'hono';
  import type { Env } from './types/env';

  const app = new Hono<{ Bindings: Env }>();

  // Health check endpoint
  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    });
  });

  // 404 handler
  app.notFound((c) => {
    return c.json({ error: 'Not Found' }, 404);
  });

  // Error handler
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'Internal Server Error' }, 500);
  });

  export default app;
  ```

### 3. Placeholder Handlers

**File**: `src/handlers/discovery.ts`

- [ ] Create placeholder for discovery endpoint handler

**File**: `src/handlers/jwks.ts`

- [ ] Create placeholder for JWKS endpoint handler

**File**: `src/handlers/authorize.ts`

- [ ] Create placeholder for authorization endpoint handler

**File**: `src/handlers/token.ts`

- [ ] Create placeholder for token endpoint handler

**File**: `src/handlers/userinfo.ts`

- [ ] Create placeholder for userinfo endpoint handler

### 4. Utility Functions

**File**: `src/utils/logger.ts`

- [ ] Create basic logger utility

**File**: `src/utils/errors.ts`

- [ ] Create error classes for OIDC errors:
  - [ ] `OAuthError`
  - [ ] `InvalidRequestError`
  - [ ] `InvalidGrantError`
  - [ ] etc.

---

## Phase 4: Cloudflare Setup

### KV Namespace Creation

- [ ] Login to Wrangler: `wrangler login`
- [ ] Create KV namespace for development:
  ```bash
  wrangler kv namespace create STATE_KV
  ```
- [ ] Create KV namespace for preview:
  ```bash
  wrangler kv namespace create STATE_KV --preview
  ```
- [ ] Copy namespace IDs to `wrangler.toml`

### Secret Management

- [ ] Generate RSA key pair for development:
  ```bash
  openssl genrsa -out private-key.pem 2048
  openssl rsa -in private-key.pem -pubout -out public-key.pem
  ```
- [ ] Store private key as secret:
  ```bash
  wrangler secret put PRIVATE_KEY
  ```
  (Paste the content of `private-key.pem`)
- [ ] Store public key for JWKS endpoint (in code or KV)

---

## Phase 5: Dependency Installation & Build

### Install Dependencies

- [ ] Run: `ppnpm install` (or `pnpm install`)
- [ ] Verify all dependencies installed successfully
- [ ] Check for any security vulnerabilities: `pnpm audit`

### Build & Test

- [ ] Run TypeScript compiler: `pnpm build`
- [ ] Verify build succeeds with no errors
- [ ] Run linter: `pnpm lint`
- [ ] Run formatter: `pnpm format`

---

## Phase 6: Local Development

### Start Development Server

- [ ] Run: `pnpm dev` or `wrangler dev`
- [ ] Verify server starts on `http://localhost:8787`
- [ ] Test health endpoint: `curl http://localhost:8787/health`
- [ ] Verify response:
  ```json
  {
    "status": "ok",
    "version": "0.1.0",
    "timestamp": "..."
  }
  ```

### Verify Routing

- [ ] Test 404 handler: `curl http://localhost:8787/nonexistent`
- [ ] Verify proper error response
- [ ] Check logs for any errors

---

## Phase 7: Git & Version Control

### Git Configuration

- [ ] Ensure Git is initialized
- [ ] Verify `.gitignore` is working
- [ ] Create initial commit with project structure:
  ```bash
  git add .
  git commit -m "chore: initialize project structure and configuration"
  ```

### Branch Management

- [ ] Verify current branch: `claude/enrai-project-setup-011CUzP18xDrPBpH2wQgouqJ`
- [ ] Push to remote:
  ```bash
  git push -u origin claude/enrai-project-setup-011CUzP18xDrPBpH2wQgouqJ
  ```

---

## Phase 8: CI/CD Setup

### GitHub Actions Workflow

**File**: `.github/workflows/ci.yml`

- [ ] Create CI workflow with jobs:
  - [ ] Install dependencies
  - [ ] Run linter
  - [ ] Run type checking
  - [ ] Run tests
  - [ ] Build project
- [ ] Configure to run on push and PR
- [ ] Test workflow by pushing commit

---

## Phase 9: Documentation

### Update README

- [ ] Update README.md with:
  - [ ] Current project status
  - [ ] Installation instructions
  - [ ] Development setup guide
  - [ ] Available scripts
  - [ ] Project structure overview

### Development Documentation

**File**: `DEVELOPMENT.md`

- [ ] Create development guide with:
  - [ ] Prerequisites
  - [ ] Setup instructions
  - [ ] Local development workflow
  - [ ] Testing guidelines
  - [ ] Debugging tips

**File**: `CONTRIBUTING.md`

- [ ] Create contribution guidelines:
  - [ ] Code style
  - [ ] Commit conventions
  - [ ] PR process
  - [ ] Testing requirements

---

## Phase 10: Week 1 Review

### Checklist Completion

- [ ] All directory structure created
- [ ] All configuration files created
- [ ] All dependencies installed
- [ ] TypeScript compiles successfully
- [ ] Local development server runs
- [ ] Health endpoint works
- [ ] Git repository configured
- [ ] CI/CD workflow configured
- [ ] Documentation updated

### Milestone 1 Progress Check

**Foundation Complete Criteria** (Due Dec 15):
- [ ] Project structure design ✅
- [ ] TypeScript configuration complete ✅
- [ ] Cloudflare Workers environment setup ✅
- [ ] Hono framework integration ✅
- [ ] Basic CI/CD configuration ✅
- [ ] Development documentation ✅

**Completion Criteria**:
- [ ] `wrangler dev` launches local development server ✅
- [ ] Basic routing is functional ✅
- [ ] TypeScript builds successfully ✅

### Next Steps

After completing this checklist, proceed to:
- [ ] Week 2: Hono framework integration and routing (see TASK_BREAKDOWN.md)
- [ ] Begin implementing Discovery and JWKS endpoints
- [ ] Set up comprehensive test suite

---

## Troubleshooting

### Common Issues

**Issue**: `wrangler dev` fails to start
- [ ] Check Node.js version (18+)
- [ ] Verify wrangler is installed: `wrangler --version`
- [ ] Check `wrangler.toml` syntax
- [ ] Review error logs

**Issue**: TypeScript compilation errors
- [ ] Verify `tsconfig.json` configuration
- [ ] Check `@cloudflare/workers-types` is installed
- [ ] Clear dist folder and rebuild

**Issue**: KV namespace errors
- [ ] Verify KV namespace IDs in `wrangler.toml`
- [ ] Check KV namespace exists: `wrangler kv namespace list`
- [ ] Recreate namespace if needed

**Issue**: Authentication/secret errors
- [ ] Verify `wrangler login` successful
- [ ] Check secret is set: `wrangler secret list`
- [ ] Re-upload secret if needed

---

## Resources

### Documentation
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Hono Documentation](https://hono.dev/)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [JOSE Library](https://github.com/panva/jose)

### Tools
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- [JWT.io](https://jwt.io/) - JWT debugger
- [OpenID Conformance Suite](https://openid.net/certification/testing/)

---

## Sign-off

### Week 1 Completion
- [ ] All tasks completed
- [ ] Code reviewed
- [ ] Tests passing
- [ ] Documentation updated
- [ ] Committed and pushed to Git

**Completed By**: _______________
**Date**: _______________
**Notes**: _______________

---

> **Enrai** 🔥 — Starting strong with a solid foundation.
