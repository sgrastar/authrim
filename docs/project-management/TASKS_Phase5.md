## Phase 5: UI/UX Implementation (May 1-31, 2026) 🎨

### ステージ1: インフラ基盤構築 (Week 26, Day 1-4: May 1-4)

#### 26.1 D1データベースセットアップ
- [x] Create D1 database via Wrangler CLI
  ```bash
  wrangler d1 create enrai-production
  ```
- [x] Configure D1 binding in `wrangler.toml`
- [x] Test D1 connectivity from Workers
- [x] Document D1 setup process (setup-d1.sh script created)

#### 26.2 D1 マイグレーション実行
- [x] Create migration files in `migrations/` directory
  - [x] `001_initial_schema.sql` - Core tables (users, oauth_clients, sessions) - All 11 tables in single file
  - [x] `002_seed_default_data.sql` - Seed data with default roles, scope mappings, test users
  - [ ] `003_add_passkeys.sql` - passkeys table (included in 001)
  - [ ] `004_add_roles.sql` - roles, user_roles tables (included in 001)
  - [ ] `005_add_scope_mappings.sql` - scope_mappings table (included in 001)
  - [ ] `006_add_branding.sql` - branding_settings table (included in 001)
  - [ ] `007_add_identity_providers.sql` - identity_providers table (included in 001)
  - [ ] `008_add_audit_log.sql` - audit_log table (included in 001)
- [x] Execute migrations locally: `wrangler d1 execute DB --local --file=./migrations/001_initial_schema.sql` (via setup-d1.sh)
- [x] Execute migrations in production: `wrangler d1 execute DB --file=./migrations/001_initial_schema.sql` (via setup-d1.sh)
- [x] Verify all tables created: `wrangler d1 execute DB --command "SELECT name FROM sqlite_master WHERE type='table'"` (via setup-d1.sh)
- [ ] Create rollback scripts for each migration (optional - can recreate from scratch)
- [ ] Test migration rollback process (optional)
- [x] Document migration workflow (setup-d1.sh handles full workflow)

#### 26.3 シードデータ投入
- [x] Create seed data script `migrations/seed_default_data.sql`:
  - [x] Insert default roles (super_admin, admin, viewer, support)
  - [x] Insert default branding settings
  - [x] Insert test admin user (for development)
  - [x] Insert test OAuth client (for testing)
- [x] Execute seed data locally (via setup-d1.sh)
- [x] Execute seed data in production (optional test data) (via setup-d1.sh)
- [x] Document seed data structure (comments in SQL file)
- [ ] Create script to generate test data (1000+ users for testing) (deferred to later)

#### 26.4 Durable Objects実装 - SessionStore
- [x] Create `src/durable-objects/SessionStore.ts`
- [x] Implement SessionStore class:
  - [x] `constructor()` - Initialize in-memory session map
  - [x] `fetch()` - Handle HTTP requests
  - [x] `getSession(sessionId)` - Get session from memory or D1 fallback
  - [x] `createSession(userId, ttl, data)` - Create new session
  - [x] `invalidateSession(sessionId)` - Delete session immediately
  - [x] `listUserSessions(userId)` - Get all sessions for user
  - [x] `cleanup()` - Remove expired sessions from memory
- [x] Implement hot/cold pattern (in-memory → D1 fallback)
- [x] Configure SessionStore in `wrangler.toml`
  ```toml
  [[durable_objects.bindings]]
  name = "SESSION_STORE"
  class_name = "SessionStore"
  script_name = "enrai-shared"
  ```
- [x] Add unit tests for SessionStore (20+ tests)
- [x] Test session creation and retrieval
- [x] Test session expiration and cleanup
- [x] Test D1 fallback for cold sessions
- [x] Document SessionStore API (docs/api/durable-objects/SessionStore.md)

#### 26.5 Durable Objects実装 - AuthorizationCodeStore
- [x] Create `src/durable-objects/AuthorizationCodeStore.ts`
- [x] Implement AuthorizationCodeStore class:
  - [x] `constructor()` - Initialize in-memory code map
  - [x] `fetch()` - Handle HTTP requests
  - [x] `store(code, metadata)` - Store authorization code (TTL: 60s)
  - [x] `consume(code, clientId, codeVerifier)` - Consume code (one-time use)
  - [x] `cleanup()` - Remove expired codes
- [x] Implement replay attack prevention (mark as used)
- [x] Implement PKCE validation (code_challenge, code_verifier)
- [x] Configure AuthorizationCodeStore in `wrangler.toml`
  ```toml
  [[durable_objects.bindings]]
  name = "AUTH_CODE_STORE"
  class_name = "AuthorizationCodeStore"
  script_name = "enrai-shared"
  ```
- [x] Add unit tests for AuthorizationCodeStore (15+ tests)
- [x] Test code storage and consumption
- [x] Test replay attack detection
- [x] Test PKCE validation
- [x] Document AuthorizationCodeStore API (docs/api/durable-objects/AuthorizationCodeStore.md)

#### 26.6 Durable Objects実装 - RefreshTokenRotator
- [x] Create `src/durable-objects/RefreshTokenRotator.ts`
- [x] Implement RefreshTokenRotator class:
  - [x] `constructor()` - Initialize token family map
  - [x] `fetch()` - Handle HTTP requests
  - [x] `rotate(currentToken, userId, clientId)` - Rotate token atomically
  - [x] `revokeFamilyTokens(familyId)` - Revoke all tokens in family
  - [x] `logToD1(action, familyId, userId, metadata)` - Audit log
- [x] Implement token family tracking (detect token theft)
- [x] Implement theft detection (old token reuse → revoke all)
- [x] Configure RefreshTokenRotator in `wrangler.toml`
  ```toml
  [[durable_objects.bindings]]
  name = "REFRESH_TOKEN_ROTATOR"
  class_name = "RefreshTokenRotator"
  script_name = "enrai-shared"
  ```
- [x] Add unit tests for RefreshTokenRotator (18+ tests)
- [x] Test token rotation
- [x] Test theft detection
- [x] Test D1 audit logging
- [x] Document RefreshTokenRotator API (docs/api/durable-objects/RefreshTokenRotator.md)

#### 26.6a Durable Objects - Unit Tests
- [x] Create test files for each Durable Object:
  - [x] `packages/shared/src/durable-objects/__tests__/SessionStore.test.ts`
  - [x] `packages/shared/src/durable-objects/__tests__/AuthorizationCodeStore.test.ts`
  - [x] `packages/shared/src/durable-objects/__tests__/RefreshTokenRotator.test.ts`
- [x] SessionStore unit tests (20+ tests):
  - [x] Test session creation and storage
  - [x] Test session retrieval (hot and cold)
  - [x] Test session invalidation
  - [x] Test session expiration and cleanup
  - [x] Test multi-device session listing
  - [x] Test session extension (Active TTL)
  - [x] Test D1 fallback on memory miss
  - [x] Test concurrent session access
- [x] AuthorizationCodeStore unit tests (15+ tests):
  - [x] Test code storage and retrieval
  - [x] Test code consumption (one-time use)
  - [x] Test replay attack detection
  - [x] Test PKCE validation (S256 and plain)
  - [x] Test code expiration (60 seconds TTL)
  - [x] Test client validation
  - [x] Test DDoS protection (max 5 codes per user)
  - [x] Test automatic cleanup
- [x] RefreshTokenRotator unit tests (18+ tests):
  - [x] Test token family creation
  - [x] Test atomic token rotation
  - [x] Test theft detection (old token reuse)
  - [x] Test family revocation
  - [x] Test rotation count tracking
  - [x] Test D1 audit logging
  - [x] Test token expiration
  - [x] Test concurrent rotation attempts
- [x] Run all tests: `pnpm test`
- [x] Ensure test coverage ≥ 80% for Durable Objects

#### 26.6b Durable Objects - Integration Tests
- [x] Create integration test suite:
  - [x] `test/integration/durable-objects.test.ts`
- [x] Test SessionStore + D1 integration:
  - [x] Session persistence across DO restarts
  - [x] D1 fallback on cold start
  - [x] Multi-user session isolation
- [x] Test AuthCodeStore + Token endpoint integration:
  - [x] Code generation → consumption flow
  - [x] Replay attack → token revocation
- [x] Test RefreshTokenRotator + Token endpoint:
  - [x] Token rotation flow
  - [x] Theft detection → family revocation
  - [x] Audit log verification
- [x] Test Durable Objects + wrangler.toml bindings:
  - [x] Verify bindings are correctly configured
  - [x] Test DO instantiation from Workers
- [x] Document integration test setup

#### 26.6c Durable Objects - API Documentation
- [x] Update `docs/architecture/durable-objects.md`:
  - [x] Mark SessionStore as ✅ Implemented
  - [x] Mark AuthorizationCodeStore as ✅ Implemented
  - [x] Mark RefreshTokenRotator as ✅ Implemented
  - [x] Add implementation notes and lessons learned
- [x] Create API reference documentation:
  - [x] `docs/api/durable-objects/SessionStore.md`
  - [x] `docs/api/durable-objects/AuthorizationCodeStore.md`
  - [x] `docs/api/durable-objects/RefreshTokenRotator.md`
  - [x] `docs/api/durable-objects/KeyManager.md` (added 2025-11-13)
- [x] Document each HTTP endpoint with:
  - [x] Request format (JSON schema)
  - [x] Response format (JSON schema)
  - [x] Error responses
  - [x] Example curl commands
  - [x] Usage examples in TypeScript
- [ ] Add OpenAPI/Swagger specs (optional):
  - [ ] Generate from TypeScript interfaces
  - [ ] Integrate with existing `docs/api/openapi.yaml`
- [x] Update README.md with Durable Objects section

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

### ステージ2: バックエンドAPI実装 (Week 26-27: May 5-14) ✅

#### 27.1 WebAuthn/Passkey実装 ✅
- [x] Install `@simplewebauthn/server` and `@simplewebauthn/browser`
- [x] Create `src/handlers/auth/passkey.ts`
- [x] Implement `POST /auth/passkey/register/options` - Generate registration options
- [x] Implement `POST /auth/passkey/register/verify` - Verify registration
- [x] Implement `POST /auth/passkey/login/options` - Generate authentication options
- [x] Implement `POST /auth/passkey/login/verify` - Verify authentication
- [x] Store passkeys in D1 `passkeys` table
- [x] Implement counter management (replay attack prevention)
- [x] Add unit tests for Passkey endpoints (placeholder tests created)
- [ ] Test Passkey registration flow (deferred to integration testing)
- [ ] Test Passkey authentication flow (deferred to integration testing)
- [x] Document Passkey API - `docs/api/auth/passkey.md`

#### 27.2 Magic Link実装 ✅
- [x] Choose email provider (Resend recommended)
- [x] Create `src/utils/email/` directory:
  - [x] `interfaces.ts` - `IEmailProvider` interface
  - [x] `resend-provider.ts` - Resend implementation
  - [ ] `cloudflare-email-provider.ts` - Cloudflare Email Workers (Phase 7)
  - [ ] `smtp-provider.ts` - SMTP implementation (Phase 7)
- [x] Implement `POST /auth/magic-link/send` endpoint:
  - [x] Generate secure token (UUID v4)
  - [x] Store token in KV with TTL (15 minutes)
  - [x] Send email with magic link
  - [x] Return success response
- [x] Implement `GET /auth/magic-link/verify` endpoint:
  - [x] Validate token from URL parameter
  - [x] Check token expiration
  - [x] Create session
  - [x] Delete used token
  - [x] Redirect to client application
- [x] Create email templates (HTML + plain text):
  - [x] Magic Link email template
  - [ ] Email verification template (Phase 6)
  - [ ] Password reset template (Phase 6)
- [x] Add rate limiting for Magic Link (3 req/15min per email)
- [x] Add unit tests for Magic Link (placeholder tests created)
- [ ] Test email delivery (requires RESEND_API_KEY configuration)
- [ ] Test token expiration (deferred to integration testing)
- [x] Document Magic Link API - `docs/api/auth/magic-link.md`

#### 27.3 OAuth同意画面API ✅
- [x] Implement `GET /auth/consent` endpoint:
  - [x] Retrieve authorization request from session
  - [x] Load client metadata from D1
  - [x] Convert scopes to human-readable format
  - [x] Return consent screen data (client name, logo, scopes, user info)
- [x] Implement `POST /auth/consent` endpoint:
  - [x] Validate consent decision (allow/deny)
  - [ ] Store consent decision in D1 (optional: remember choice) - Phase 6
  - [x] Generate authorization code if allowed
  - [x] Redirect to client with code or error
- [ ] Implement consent persistence (skip consent if previously granted) - Phase 6
- [ ] Add Audit Log for consent decisions - Phase 6
- [x] Add unit tests for consent endpoints (placeholder tests created)
- [ ] Test consent approval flow (deferred to integration testing)
- [ ] Test consent denial flow (deferred to integration testing)
- [x] Document consent API - `docs/api/auth/consent.md`

#### 27.4 ITP対応セッション管理API ✅
- [x] Implement `POST /auth/session/token` - Issue short-lived token (5min TTL, single-use)
  - [x] Generate secure token (UUID)
  - [x] Store in KV with TTL (5 minutes)
  - [x] Link to user session
  - [x] Return token
- [x] Implement `POST /auth/session/verify` - Verify token & create RP session
  - [x] Validate token
  - [x] Check single-use flag
  - [x] Mark token as used
  - [x] Create new session for RP domain
  - [x] Return session cookie
- [x] Implement `GET /session/status` - Check session validity (iframe alternative)
  - [x] Validate session from cookie
  - [x] Check expiration
  - [x] Return session status
- [x] Implement `POST /session/refresh` - Extend session (Active TTL)
  - [x] Validate current session
  - [x] Extend expiration time
  - [x] Update session in SessionStore DO
  - [x] Return new expiration time
- [ ] Add unit tests for session management (25+ tests)
- [ ] Test cross-domain SSO flow
- [ ] Test ITP compatibility (Safari)
- [x] Document session management API - `docs/api/auth/session-management.md`

#### 27.5 Logout機能API ✅
- [x] Implement `GET /logout` - Front-channel Logout
  - [x] Parse `id_token_hint` parameter
  - [x] Validate ID token
  - [x] Invalidate session in SessionStore DO
  - [x] Clear session cookie
  - [x] Redirect to `post_logout_redirect_uri`
- [x] Implement `POST /logout/backchannel` - Back-channel Logout (RFC 8725)
  - [x] Validate client authentication
  - [x] Parse `logout_token` (JWT)
  - [x] Validate logout token signature
  - [x] Invalidate sessions for user (all or specific session via `sid`)
  - [x] Return 200 OK
- [ ] Add unit tests for logout endpoints (12+ tests)
- [ ] Test front-channel logout
- [ ] Test back-channel logout
- [x] Document logout API - `docs/api/auth/logout.md`

#### 27.6 管理者API - ユーザー管理 ✅
- [x] Implement `GET /admin/users` - List users with pagination
  - [x] Query parameters: `q` (search), `filter` (status), `sort`, `page`, `limit`
  - [x] Search by email, name
  - [x] Filter by verified, unverified, active, inactive
  - [ ] Sort by created_at, last_login_at, email, name (basic sorting implemented)
  - [x] Return paginated results with total count
- [x] Implement `GET /admin/users/:id` - Get user details
  - [x] Load user from D1
  - [x] Load custom fields
  - [x] Load passkeys
  - [ ] Load sessions (deferred to Stage 2.8)
  - [x] Return user object
- [x] Implement `POST /admin/users` - Create user
  - [x] Validate email uniqueness
  - [ ] Hash password (if provided) - Phase 6
  - [x] Insert into D1 users table
  - [ ] Create Audit Log entry - Phase 6
  - [x] Return created user
- [x] Implement `PUT /admin/users/:id` - Update user
  - [x] Validate user exists
  - [x] Update user fields
  - [ ] Update custom fields if provided - Phase 6
  - [ ] Create Audit Log entry - Phase 6
  - [x] Return updated user
- [x] Implement `DELETE /admin/users/:id` - Delete user (cascade)
  - [x] Delete user from D1 (cascade to custom_fields, passkeys, sessions)
  - [ ] Invalidate all user sessions (deferred to Stage 2.8)
  - [ ] Create Audit Log entry - Phase 6
  - [x] Return success response
- [ ] Add admin authentication middleware (Bearer token) - Phase 6
- [ ] Add RBAC permission checks (users:read, users:write, users:delete) - Phase 6
- [x] Add unit tests for user management API (placeholder tests created)
- [ ] Test user CRUD operations (deferred to integration testing)
- [ ] Test search and filtering (deferred to integration testing)
- [x] Document admin user API - `docs/api/admin/users.md`

#### 27.6.1 管理者API - 統計情報 ✅
- [x] Implement `GET /admin/stats` - System statistics and analytics
  - [x] Count active users (logged in within last 30 days)
  - [x] Count total users
  - [x] Count registered OAuth clients
  - [x] Count new users today (since midnight)
  - [x] Count logins today (since midnight)
  - [x] Return recent activity feed (last 10 user registrations)
- [x] Optimize queries with database indexes
- [x] Add error handling for statistics endpoint
- [x] Document admin statistics API - `docs/api/admin/statistics.md`
- [ ] Add unit tests for statistics API (deferred to integration testing)
- [ ] Add caching for statistics (5 min TTL) - Phase 6
- [ ] Add advanced analytics (user growth trends, auth method breakdown) - Phase 6

#### 27.7 管理者API - クライアント管理 ✅
- [x] Implement `GET /admin/clients` - List OAuth clients
  - [x] Query parameters: `q` (search), `sort`, `page`, `limit`
  - [x] Search by client_name, client_id
  - [ ] Sort by created_at, client_name (basic sorting implemented)
  - [x] Return paginated results
- [x] Implement `GET /admin/clients/:id` - Get client details
  - [x] Load client from D1
  - [x] Return client object (mask client_secret)
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
- [x] Document admin client API - `docs/api/admin/clients.md`

#### 27.8 管理者API - セッション管理 ✅
- [x] Implement `GET /admin/sessions` - List sessions
  - [x] Query parameters: `user_id`, `status` (active/expired), `page`, `limit`
  - [x] Load sessions from SessionStore DO + D1
  - [x] Return paginated session list with metadata (user email, name)
- [x] Implement `GET /admin/sessions/:id` - Get session details
  - [x] Load session from SessionStore DO or D1
  - [x] Return session data with source tracking (memory/database)
- [x] Implement `POST /admin/sessions/:id/revoke` - Force logout individual session
  - [x] Validate session exists
  - [x] Invalidate session in SessionStore DO
  - [x] Delete session from D1
  - [ ] Create Audit Log entry (Phase 6)
  - [x] Return success response
- [x] Implement `POST /admin/users/:id/revoke-all-sessions` - Revoke all user sessions
  - [x] Get all sessions for user
  - [x] Invalidate all sessions in SessionStore DO
  - [x] Delete all sessions from D1
  - [ ] Create Audit Log entry (Phase 6)
  - [x] Return success response with revoked count
- [ ] Add unit tests for session management API (20+ tests)
- [ ] Test session listing and filtering
- [ ] Test session revocation
- [x] Document admin session API - `docs/api/admin/sessions.md`

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
- [x] Create `packages/ui/src/routes/login/+page.svelte`
- [x] Design login layout:
  - [x] Enrai logo at top
  - [x] Email input field
  - [x] "Continue with Passkey" button (primary)
  - [x] "Send Magic Link" button (secondary)
  - [x] "Create Account" link
  - [x] Language switcher (en/ja)
- [x] Implement form validation (email validation)
- [x] Implement Passkey detection (check browser support)
- [ ] Integrate with `/auth/passkey/login` API (placeholder implemented, API integration pending)
- [ ] Integrate with `/auth/magic-link/send` API (placeholder implemented, API integration pending)
- [x] Add error message display
- [x] Add loading states
- [ ] Add Cloudflare Turnstile (Captcha) (deferred to backend API integration)
- [x] Test responsive design (320px - 1920px) (basic implementation)
- [x] Test keyboard navigation (Enter key support)
- [ ] Test screen reader compatibility (deferred to accessibility review)
- [x] Document login page (code comments)

#### 29.2 アカウント登録画面 (`/register`)
- [x] Create `packages/ui/src/routes/register/+page.svelte`
- [x] Design registration layout:
  - [x] Email input field
  - [x] Name input field (required)
  - [x] "Create Account with Passkey" button
  - [x] "Sign up with Magic Link" button
  - [x] Terms of Service & Privacy Policy agreement text
  - [x] "Already have an account?" link
- [x] Implement form validation (email and name validation)
- [ ] Check email uniqueness (debounced) (deferred to API integration)
- [ ] Integrate with `/auth/passkey/register` API (placeholder implemented, API integration pending)
- [ ] Integrate with `/auth/magic-link/send` API (placeholder implemented, API integration pending)
- [ ] Add Cloudflare Turnstile (deferred to backend API integration)
- [x] Test registration flow (basic UI testing)
- [x] Document registration page (code comments)

#### 29.3 Magic Link送信完了画面 (`/magic-link-sent`)
- [x] Create `packages/ui/src/routes/magic-link-sent/+page.svelte`
- [x] Design success message:
  - [x] "Check your email" heading
  - [x] Email address display
  - [x] "Resend email" button (with timer countdown)
  - [x] "Back to login" link
- [x] Implement resend timer (60 seconds)
- [ ] Integrate with resend API (placeholder implemented, API integration pending)
- [x] Test resend flow (basic UI testing)
- [x] Document magic link sent page (code comments)

#### 29.4 Magic Link検証画面 (`/verify-magic-link`)
- [x] Create `packages/ui/src/routes/verify-magic-link/+page.svelte`
- [x] Show loading spinner immediately
- [x] Extract token from URL query parameter
- [ ] Call `/auth/magic-link/verify` API (placeholder implemented, API integration pending)
- [x] Handle success: redirect to client app or dashboard (placeholder logic)
- [x] Handle error: show error message with "Request new link" button
- [x] Test verification flow (basic UI testing)
- [x] Document verification page (code comments)

#### 29.5 OAuth同意画面 (`/consent`)
- [x] Create `packages/ui/src/routes/consent/+page.svelte`
- [x] Design consent layout:
  - [x] Client logo and name
  - [x] "{Client Name} wants to access your Enrai account" heading
  - [x] Scope list with icons (human-readable)
  - [x] User information display (email, name, avatar)
  - [x] "Allow" button (primary)
  - [x] "Deny" button (secondary)
  - [x] "Not you? Switch account" link
  - [x] Privacy Policy and Terms of Service links
- [ ] Load consent data from `/auth/consent` API (placeholder implemented, API integration pending)
- [x] Implement scope translation (technical → human-readable)
- [ ] Integrate with `POST /auth/consent` API (placeholder implemented, API integration pending)
- [x] Handle allow: redirect with authorization code (placeholder logic)
- [x] Handle deny: redirect with error (placeholder logic)
- [x] Test consent flow with various scopes (mock data testing)
- [x] Document consent page (code comments)

#### 29.6 エラーページ (`/error`)
- [x] Create `packages/ui/src/routes/error/+page.svelte`
- [x] Design error layout:
  - [x] Error icon
  - [x] Error message (user-friendly)
  - [x] Error code (technical, small font)
  - [x] "Back to login" button
  - [x] Support contact link
- [x] Handle various error types:
  - [x] invalid_request
  - [x] access_denied
  - [x] server_error
  - [x] temporarily_unavailable
  - [x] unauthorized_client
  - [x] unsupported_response_type
  - [x] invalid_scope
- [x] Log errors to console (development) or monitoring service (production) (console.log implemented)
- [x] Test error page with different error codes (mock testing)
- [x] Document error page (code comments)

---

### ステージ5: 管理画面実装 (Week 29-30: May 22-31) ✅

#### 30.1 管理者ダッシュボード (`/admin`) ✅
- [x] Create `packages/ui/src/routes/admin/+layout.svelte`:
  - [x] Sidebar navigation
  - [x] Top bar (logo, search, notifications, profile menu)
  - [x] Main content area
- [x] Create `packages/ui/src/routes/admin/+page.svelte`:
  - [x] Statistics cards:
    - [x] Active users count
    - [x] Total logins today
    - [x] Registered clients count
    - [x] Total users count (replaces Active sessions count)
  - [x] Activity feed (latest logins, registrations)
  - [ ] Login trend chart (Chart.js or ECharts) - Deferred to Phase 6
  - [x] Quick actions panel (Create user, Register client)
- [ ] Integrate with `/admin/stats` API (mock data implemented, API integration pending)
- [ ] Add real-time updates (optional: WebSockets or polling) - Deferred to Phase 6
- [x] Test dashboard layout and responsiveness
- [x] Document admin dashboard (code comments)

#### 30.2 ユーザー管理 (`/admin/users`) ✅
- [x] Create `packages/ui/src/routes/admin/users/+page.svelte`:
  - [x] User list table with pagination
  - [x] Search bar (search by email, name)
  - [x] Filter dropdowns (verified/unverified, all)
  - [x] Sort by columns (basic implementation)
  - [x] "Add User" button
  - [x] Action buttons (View, Delete) per row
- [ ] Integrate with `GET /admin/users` API (mock data implemented, API integration pending)
- [x] Implement client-side pagination
- [x] Implement debounced search
- [ ] Add delete confirmation dialog (basic alert implemented)
- [ ] Test with large datasets (1000+ users) - Deferred to integration testing
- [x] Document user list page (code comments)

#### 30.3 ユーザー詳細/編集 (`/admin/users/:id`) ✅
- [x] Create `packages/ui/src/routes/admin/users/[id]/+page.svelte`:
  - [x] User information form (email, name, phone, etc.)
  - [ ] Custom fields section (deferred to Phase 6)
  - [x] Passkey list (registered devices)
  - [x] Session list (active sessions)
  - [ ] Audit Log (user actions) - Deferred to Phase 6
  - [x] "Save Changes" button
  - [x] "Delete User" button (danger zone)
- [ ] Integrate with `GET /admin/users/:id` API (mock data implemented, API integration pending)
- [ ] Integrate with `PUT /admin/users/:id` API (mock implementation)
- [ ] Integrate with `DELETE /admin/users/:id` API (mock implementation)
- [x] Implement form validation (basic validation)
- [x] Add "Delete Passkey" button for each device
- [x] Add "Revoke Session" button for each session
- [ ] Test user editing and deletion (deferred to integration testing)
- [x] Document user detail page (code comments)

#### 30.4 クライアント管理 (`/admin/clients`) ✅
- [x] Create `packages/ui/src/routes/admin/clients/+page.svelte`:
  - [x] Client list table (client_id, client_name, created_at, grant_types)
  - [x] Search bar
  - [x] "Register Client" button
  - [x] Action buttons (View, Delete) per row
- [ ] Integrate with `GET /admin/clients` API (mock data implemented, API integration pending)
- [x] Implement client search
- [ ] Add delete confirmation dialog (basic alert implemented)
- [x] Test client list page (basic UI testing)
- [x] Document client list page (code comments)

#### 30.5 クライアント詳細/編集 (`/admin/clients/:id`) ✅
- [x] Create `packages/ui/src/routes/admin/clients/[id]/+page.svelte`:
  - [x] Client information form (client_name, redirect_uris, grant_types, scope)
  - [x] Redirect URIs management (add/remove)
  - [x] Grant Types selection (checkboxes)
  - [x] Scope configuration (text input)
  - [x] Logo URI input
  - [x] Client URI, Policy URI, ToS URI inputs
  - [x] "Save Changes" button
  - [x] "Regenerate Secret" button (show confirmation)
  - [x] "Delete Client" button (danger zone)
- [ ] Integrate with `GET /admin/clients/:id` API (mock data implemented, API integration pending)
- [ ] Integrate with `PUT /admin/clients/:id` API (mock implementation)
- [ ] Integrate with `POST /admin/clients/:id/regenerate-secret` API (mock implementation)
- [ ] Integrate with `DELETE /admin/clients/:id` API (mock implementation)
- [x] Show client_secret only once after regeneration (alert placeholder)
- [ ] Add form validation (URL validation deferred to Phase 6)
- [ ] Test client editing and deletion (deferred to integration testing)
- [x] Document client detail page (code comments)

#### 30.6 設定 (`/admin/settings`) ✅
- [x] Create `packages/ui/src/routes/admin/settings/+page.svelte`:
  - [x] Tabs: General, Appearance, Security, Email, Advanced
  - [x] General tab:
    - [x] Site name input
    - [x] Logo upload (URL input)
    - [x] Language selection
    - [x] Timezone selection
  - [x] Appearance tab:
    - [x] Theme selection (deferred - colors only)
    - [x] Primary color picker
    - [x] Secondary color picker
    - [x] Font family selection
    - [ ] Login page preview (iframe) - Deferred to Phase 6
  - [x] Security tab:
    - [x] Password policy configuration
    - [x] Session timeout setting
    - [x] MFA enforcement toggle
    - [ ] Rate limiting configuration - Deferred to Phase 6
  - [x] Email tab:
    - [x] Email provider selection (Resend/Cloudflare/SMTP)
    - [x] SMTP configuration (host, port, username, password)
    - [x] Test email button (placeholder)
    - [ ] Email template editor (basic) - Deferred to Phase 6
  - [x] Advanced tab:
    - [x] Token TTL settings (access, ID, refresh)
    - [x] Enable/disable features (Passkey, Magic Link)
- [ ] Integrate with `GET /admin/settings` API (mock data, API integration pending)
- [ ] Integrate with `PUT /admin/settings` API (mock implementation)
- [ ] Implement live preview for appearance changes - Deferred to Phase 6
- [ ] Add test email functionality - Deferred to API integration
- [x] Test all settings (basic UI testing)
- [x] Document settings page (code comments)

#### 30.7 Audit Log (`/admin/audit-log`) ✅
- [x] Create `packages/ui/src/routes/admin/audit-log/+page.svelte`:
  - [x] Audit log table (timestamp, user, action, resource, IP, status)
  - [x] Filter by date range (date picker)
  - [x] Filter by action type (dropdown)
  - [x] Filter by status (dropdown)
  - [x] Search by user/action/resource
  - [x] Export to CSV button (placeholder)
  - [x] Export to JSON button (placeholder)
- [ ] Integrate with `GET /admin/audit-log` API (mock data, API integration pending)
- [x] Implement date range filtering
- [ ] Implement CSV export (client-side) - Deferred to API integration
- [ ] Implement JSON export (client-side) - Deferred to API integration
- [x] Test audit log display and filtering (basic UI testing)
- [x] Document audit log page (code comments)

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

