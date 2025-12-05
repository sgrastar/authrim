# Phase 5: UI/UX Implementation - Planning Document 🎨

**Status:** Planning
**Timeline:** May 1-31, 2026 (4 weeks)
**Goal:** Best Passwordless and User Experience

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Decision Items List](#decision-items-list)
3. [Architecture Design](#architecture-design)
4. [UI/UX Page List](#uiux-page-list)
5. [Admin Features](#admin-features)
6. [Technology Stack Selection](#technology-stack-selection)
7. [Data Storage Design](#data-storage-design)
8. [Authentication Flow Design](#authentication-flow-design)
9. [Timeline](#timeline)

---

## Overview

Phase 5 implements the following features in Authrim:

- **🔐 Passwordless Authentication UI** (Passkey + Magic Link)
- **📝 User Registration & Login Flow**
- **✅ OAuth Consent Screen**
- **👥 Admin Dashboard**
- **💾 Data Storage Abstraction Layer**

### Key Goals

1. **Intuitive & Fast UI** - Prioritize user experience
2. **Passwordless First** - Passkey/WebAuthn as primary option
3. **Edge Native** - Optimized for Cloudflare Workers
4. **Accessibility** - WCAG 2.1 AA compliant
5. **Internationalization** - Prepare for multilingual support

---

## Decision Items List

The following items will be reviewed and decided in order:

### 1️⃣ Frontend Technology Stack

#### 1.1 UI Framework Selection
- [ ] **Comparison of Options**
  - **React + Next.js** - Most popular, rich ecosystem, SSR support
  - **Vue 3 + Nuxt 3** - Simple, low learning cost, SSR support
  - **Svelte + SvelteKit** - Fast, small bundle size, modern
  - **Solid.js + SolidStart** - React-like, high performance, new
  - **Vanilla TS + Lit** - Lightweight, Web Components, few dependencies

- [ ] **Evaluation Criteria**
  - Build size (constraints in edge environment)
  - Development speed & productivity
  - TypeScript support
  - SSR/SSG support
  - Ecosystem (libraries, tools)
  - Cloudflare Pages integration

- [ ] **Recommendation**: Svelte + SvelteKit or Solid.js
  - Reason: Lightweight, fast, modern, edge-optimized

- Comment: We'll use Svelte + SvelteKit Ver.5.

#### 1.2 CSS Framework Selection
- [ ] **Comparison of Options**
  - **Tailwind CSS** - Utility-first, easy to customize
  - **UnoCSS** - Tailwind-compatible, fast, lightweight
  - **Panda CSS** - Zero-runtime, type-safe, fast
  - **Vanilla Extract** - CSS-in-TypeScript, type-safe
  - **shadcn/ui + Tailwind** - With component library

- [ ] **Evaluation Criteria**
  - Bundle size
  - Developer experience (DX)
  - Dark mode support
  - Customizability
  - Performance

- [ ] **Recommendation**: Tailwind CSS or UnoCSS
  - Reason: Proven track record, ecosystem, fast

- Comment: We'll use UnoCSS

#### 1.3 UI Component Library
- [ ] **Comparison of Options**
  - **shadcn/ui** (React) - Copy-paste type, easy to customize
  - **Melt UI** (Svelte) - Headless, accessible
  - **Kobalte** (Solid.js) - Headless, accessible
  - **Radix UI** (React) - Headless, accessible
  - **Custom** - Full control, lightweight

- [ ] **Evaluation Criteria**
  - Accessibility (ARIA support)
  - Customizability
  - Bundle size
  - Documentation quality
  - Number of required components

- [ ] **Recommendation**: Melt UI (Svelte) or Kobalte (Solid.js)
  - Reason: Headless, lightweight, accessible

- Comment: We'll use Melt UI.

### 2️⃣ Backend Architecture

#### 2.1 UI Hosting Method
- [ ] **Comparison of Options**
  - **Option A: Cloudflare Pages** (Separate deployment)
    - Pros: CDN optimization, independent deployment, fast static asset delivery
    - Cons: Separate management, CORS configuration required

  - **Option B: Serve from Workers** (Same Worker)
    - Pros: Unified management, no CORS needed, simple
    - Cons: Worker size limits, inefficient static asset delivery

  - **Option C: Hybrid** (API=Workers, UI=Pages)
    - Pros: Leverage strengths of each technology, optimal performance
    - Cons: Complex, deployment management

- [ ] **Evaluation Criteria**
  - Performance
  - Ease of management
  - Cost
  - Scalability

- [ ] **Recommendation**: Option C (Hybrid)
  - Reason: Optimal performance, clean separation

- Comment: We'll use Option C

#### 2.2 API Design
- [ ] **Additional Endpoints Required**
  - `POST /auth/passkey/register` - Start Passkey registration
  - `POST /auth/passkey/verify` - Verify Passkey
  - `POST /auth/magic-link/send` - Send Magic Link
  - `POST /auth/magic-link/verify` - Verify Magic Link
  - `GET /auth/consent` - Get consent screen data
  - `POST /auth/consent` - Confirm consent
  - `GET /admin/users` - List users
  - `POST /admin/users` - Create user
  - `PUT /admin/users/:id` - Update user
  - `DELETE /admin/users/:id` - Delete user
  - `GET /admin/clients` - List clients
  - `POST /admin/clients` - Create client (extend existing DCR)
  - `PUT /admin/clients/:id` - Update client
  - `DELETE /admin/clients/:id` - Delete client
  - `GET /admin/stats` - Statistics

  **ITP-Compatible Cross-Domain SSO (Added 2025-11-12)**
  - `POST /auth/session/token` - Issue short-lived token (5min TTL, single-use)
  - `POST /auth/session/verify` - Verify short-lived token & establish RP session
  - `GET /session/status` - Check IdP session validity (iframe check_session_iframe alternative)
  - `POST /session/refresh` - Extend session (Active TTL-based session)

  **Logout Functionality (Added 2025-11-12)**
  - `GET /logout` - Front-channel Logout (Browser → OP)
  - `POST /logout/backchannel` - Back-channel Logout (OP → RP, RFC recommended)

  **Admin Session Management (Added 2025-11-12)**
  - `GET /admin/sessions` - List sessions (by User/Device)
  - `POST /admin/sessions/:id/revoke` - Force logout individual session

- Comment: What about user search?
  - **Answer**: Add the following endpoint
    - `GET /admin/users?q={query}&filter={status}&sort={field}&page={n}&limit={limit}`
      - `q`: Search query (search by email, name)
      - `filter`: `verified`, `unverified`, `active`, `inactive`
      - `sort`: `created_at`, `last_login_at`, `email`, `name` (default: `-created_at`)
      - `page`: Page number (default: 1)
      - `limit`: Items per page (default: 50, max: 100)

- [ ] **Authentication Methods**
  - Admin API: Bearer Token (dedicated admin token)
  - Session management: Cookie + CSRF Token

- Comment: Good, but leave room for SAML/LDAP authentication later.
  - **Answer**: Phase 5 implements Bearer Token + Cookie + CSRF. Add the following for future extensibility:
    - `identity_providers` table (store SAML/LDAP configurations)
    - `users.identity_provider_id` column (link to external authentication)
    - SAML/LDAP implementation planned for Phase 7

- [ ] **Token Exchange APIs (Under Consideration - Added 2025-11-12)**
  - **Current Implementation Status**:
    - `POST /token` (grant_type=authorization_code) ✅ Implemented
    - `POST /token` (grant_type=refresh_token) ✅ Implemented
  - **Future Token Exchange Mechanisms to Consider**:
    - **RFC 8693 Token Exchange** - Standard token exchange protocol (most flexible)
      - Session token → Access token (for ITP-compliant SSO)
      - Access token → Access token (scope change)
      - ID token → Access token (token conversion)
      - Delegation, Impersonation support
    - **Dedicated Session Exchange API** - Simple API specialized for ITP-compliant SSO
      - `POST /auth/session/exchange` - Exchange session token for access token
    - **Hybrid Approach** - Support both RFC 8693 (general purpose) + dedicated API (ease of use)
  - **Decision**: Finalize requirements during Phase 5 implementation
  - **Note**: The above `/auth/session/token` and `/auth/session/verify` can be implemented as a form of Token Exchange

#### 2.3 Session Management
- [ ] **Implementation Method Selection**
  - **Option A: Cookie-based Sessions**
    - Store session data in KV/D1/DO
    - HttpOnly, Secure, SameSite=Lax Cookie

  - **Option B: JWT Sessions**
    - Stateless
    - Store on client side

  - **Option C: Hybrid**
    - Session ID (Cookie) + Data (KV/DO)

- [ ] **Recommended**: Option C (Hybrid)
  - Reason: Balance of security and performance

- Comment: Want to support SSO across different domains. Needs consideration.
  - **Decision**: **Server-side session + Token exchange approach**
    - Same domain: Session management with HttpOnly Cookie
    - Cross-domain SSO: Token exchange approach
      1. IdP maintains session (KV/DO)
      2. Client app redirects to `/auth/session/token`
      3. IdP issues short-lived token (5min TTL) and redirects to client
      4. Client verifies token and issues session Cookie
    - **Benefits**: Full ITP compliance (no third-party cookies), immediate session invalidation, high security
    - Session data: KV (short-term) + DO (when strong consistency required)

### 3️⃣ Data Storage Design

#### 3.1 Storage Selection - Hybrid Configuration
- [x] **Usage determination for each storage** - ✅ Completed (2025-11-13)

Detailed design: [storage-strategy.md](../architecture/storage-strategy.md)

  **🔷 Durable Objects (Strong Consistency・Real-time State Management)**
  - Use: One-time guarantees, mutual exclusion, real-time data
  - Data examples:
    - **Authorization Code Store** (TTL: 60s, replay attack prevention)
    - **Refresh Token Rotator** (atomic token rotation, conflict control)
    - **Session Store** (active sessions, in-memory + persistent fallback)
    - **KeyManager** (existing implementation, RSA key management/rotation)
  - Cost: $0.02/1M CPU-ms (authz code processing: 300K req/month = $0.03)

  **🔶 Cloudflare D1 (SQLite) (Persistent Data・Relational)**
  - Use: Persistent data, complex queries, Audit Log
  - Data examples:
    - **users** (master records)
    - **oauth_clients** (registered clients)
    - **sessions** (session history log, DO fallback)
    - **passkeys** (WebAuthn credentials)
    - **audit_log** (audit log for all operations)
    - **refresh_token_log** (persistent log for audit)
    - **roles** / **user_roles** (RBAC)
    - **scope_mappings** (custom scope definitions)
    - **branding_settings** (UI settings)
    - **identity_providers** (SAML/LDAP settings, for Phase 7)
  - Cost: Within free tier (5M rows read/day, 100K rows write/day)

  **🔵 Cloudflare KV (Global Edge Cache・Static Metadata)**
  - Use: Read-only cache, global CDN, short-lived tokens
  - Data examples:
    - **JWKs** (public keys, cached from DO KeyManager, TTL: 1h)
    - **Discovery info** (/.well-known/openid-configuration, TTL: 1h)
    - **Client metadata cache** (read-through cache from D1, TTL: 5min)
    - **Magic Link tokens** (TTL: 15min)
    - **CSRF Token** (TTL: 1 hour)
    - **Rate Limiting** (existing implementation, IP-based counter)
  - Cost: $0.50/1M reads (mainly cache hits)

#### Hybrid Configuration Benefits
1. **Cost Optimization**: Short-lived transaction data uses DO (15x cheaper than KV)
2. **Strong Consistency**: Essential for authorization codes and token rotation
3. **Global Performance**: Static data uses KV for edge caching
4. **Multi-cloud Support**: Storage abstraction layer already implemented

- Comment: Haven't thought about it much yet, but want abstraction so it can be deployed to Azure or AWS.
  - **Answer**: Already implemented with adapter pattern ([storage/interfaces.ts](../../packages/shared/src/storage/interfaces.ts))
    ```typescript
    interface IStorageAdapter {
      // KV-like operations
      get(key: string): Promise<any>
      set(key: string, value: any, ttl?: number): Promise<void>
      delete(key: string): Promise<void>

      // SQL-like operations
      query(sql: string, params: any[]): Promise<any[]>
      execute(sql: string, params: any[]): Promise<void>
    }

    // Implementation examples
    class CloudflareAdapter implements IStorageAdapter { ... }
    class AzureCosmosAdapter implements IStorageAdapter { ... }
    class AWSRDSAdapter implements IStorageAdapter { ... }
    class PostgreSQLAdapter implements IStorageAdapter { ... }
    ```

- [ ] **Data Model Design**
  - Create ER diagram
  - Define tables
  - Design indexes
  - Migration strategy

#### 3.2 D1 Database Schema

```sql
-- Users Table
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  email_verified INTEGER DEFAULT 0,
  name TEXT,
  given_name TEXT,
  family_name TEXT,
  middle_name TEXT,
  nickname TEXT,
  preferred_username TEXT,
  profile TEXT,
  picture TEXT,
  website TEXT,
  gender TEXT,
  birthdate TEXT,
  zoneinfo TEXT,
  locale TEXT,
  phone_number TEXT,
  phone_number_verified INTEGER DEFAULT 0,
  address_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_created_at ON users(created_at);

- Comment: Want admins to be able to add custom columns. For example, barcode numbers. Also want to support parent-child relationships between accounts.
  - **Decision**: **Hybrid approach** (dedicated table + JSON column)
    ```sql
    -- Parent-child relationships
    ALTER TABLE users ADD COLUMN parent_user_id TEXT REFERENCES users(id);
    CREATE INDEX idx_users_parent_user_id ON users(parent_user_id);

    -- Custom fields (for non-searchable data)
    ALTER TABLE users ADD COLUMN custom_attributes_json TEXT;
    -- Example: '{"social_provider_data": {...}, "preferences": {...}}'

    -- Custom fields (for searchable data)
    CREATE TABLE user_custom_fields (
      user_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      field_value TEXT,
      field_type TEXT, -- 'string', 'number', 'date', 'boolean'
      searchable INTEGER DEFAULT 1,
      PRIMARY KEY (user_id, field_name),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_user_custom_fields_search ON user_custom_fields(field_name, field_value);
    ```
  - **Usage**:
    - JSON: Raw data from social providers, metadata that doesn't need searching
    - Dedicated table: Fields that need to be searchable (barcode, employee_id, etc.)
  - **Cost**: Roughly the same (D1 charges by row count, optimize by using dedicated table only for necessary parts)

-- Passkeys/WebAuthn Credentials Table
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credential_id TEXT UNIQUE NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER DEFAULT 0,
  transports TEXT,
  device_name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_passkeys_user_id ON passkeys(user_id);
CREATE INDEX idx_passkeys_credential_id ON passkeys(credential_id);

-- OAuth Clients Table (extends existing DCR)
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret TEXT,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  grant_types TEXT NOT NULL,
  response_types TEXT NOT NULL,
  scope TEXT,
  logo_uri TEXT,
  client_uri TEXT,
  policy_uri TEXT,
  tos_uri TEXT,
  contacts TEXT,
  subject_type TEXT DEFAULT 'public',
  sector_identifier_uri TEXT,
  token_endpoint_auth_method TEXT DEFAULT 'client_secret_basic',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_clients_created_at ON oauth_clients(created_at);

-- User Sessions Table
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- Audit Log Table
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at);
CREATE INDEX idx_audit_log_action ON audit_log(action);
```

- Comment: Can these schemas be changed later? What are the constraints for adding, deleting, and modifying?
  - **Answer**: D1 (SQLite) schema change constraints
    - ✅ **Add**: Adding new columns is possible (`ALTER TABLE ADD COLUMN`)
    - ✅ **Delete**: Column deletion has restrictions (SQLite 3.35.0+ supports `DROP COLUMN`, D1 support planned)
    - ⚠️ **Modify**: Direct column type change not possible (create new column→copy data→delete old column)
    - ✅ **Indexes**: Add/delete freely (`CREATE INDEX`, `DROP INDEX`)
  - **Migration Strategy**:
    - Version-controlled SQL migration files (`migrations/001_initial.sql`, etc.)
    - Down migrations for rollback
    - Pre-validation in test environment
    - Zero-downtime migration (Blue-Green Deployment)

- [ ] **Schema Review**
- [ ] **Create Migration Scripts**
- [ ] **Create Seed Data**

#### 3.3 Storage Abstraction Layer
- [ ] **Interface Design** (basics completed in Phase 4)
  - `IUserStore` - User CRUD
  - `IClientStore` - Client CRUD (extends existing DCR)
  - `ISessionStore` - Session management
  - `IPasskeyStore` - Passkey management

- [ ] **Adapter Implementation**
  - `D1Adapter` - D1 implementation
  - `KVAdapter` - KV implementation (extend existing)
  - `DOAdapter` - Durable Objects implementation

### 4️⃣ Authentication Flow Design

#### 4.1 WebAuthn/Passkey Implementation
- [ ] **Implementation Requirements**
  - Use WebAuthn API (navigator.credentials)
  - Relying Party (RP) configuration
  - Attestation verification
  - Assertion verification
  - Counter management (replay attack prevention)

- [ ] **Required Library Selection**
  - **@simplewebauthn/server** - Server-side verification
  - **@simplewebauthn/browser** - Client-side API

- [ ] **Flow**
  1. Registration
     - User enters email address
     - Server generates challenge
     - Browser creates Passkey
     - Server verifies and stores

  2. Authentication
     - User enters email address (or selects Passkey)
     - Server generates challenge
     - Browser uses Passkey
     - Server verifies and creates session

#### 4.2 Magic Link Implementation
- [ ] **Implementation Requirements**
  - Token generation (cryptographically secure)
  - Email sending (Cloudflare Email Routing or API)
  - Token verification (one-time, TTL: 15 minutes)
  - Session creation

- [ ] **Email Sending Method Selection**
  - **Option A: Cloudflare Email Workers**
  - **Option B: External API (SendGrid, Postmark, Resend)**
  - **Option C: SMTP (Nodemailer)**

- [ ] **Recommended**: Option B (Resend or Postmark)
  - Reason: Simple, reliable, high delivery rate

- Comment: Basically B is fine, but want to be able to use Option A as well.
  - **Decision**: Implement with adapter pattern
    ```typescript
    interface IEmailProvider {
      send(to: string, subject: string, html: string, from?: string): Promise<void>
    }

    class ResendProvider implements IEmailProvider { ... }
    class PostmarkProvider implements IEmailProvider { ... }
    class CloudflareEmailProvider implements IEmailProvider { ... }
    class SMTPProvider implements IEmailProvider { ... }
    ```
  - Switch via environment variable: `EMAIL_PROVIDER=resend|cloudflare|smtp`
  - Phase 5 implements Resend as default, other providers configurable from admin panel

#### 4.3 OAuth Consent Screen Flow
- [ ] **Display Information**
  - Client name and logo
  - Requested scopes (human-readable format)
  - User information (currently logged-in user)
  - Privacy policy and terms of service links

- [ ] **Buttons**
  - "Allow" - Consent and redirect
  - "Cancel" - Error redirect
  - "Logout" - Login with different user

- [ ] **Data Persistence**
  - Save consent history (auto-approve next time?)
  - Record in Audit Log

### 5️⃣ UI Page Design

#### 5.1 End-User Pages

##### Page 1: Login Screen (`/login`)
- [ ] **Design Requirements**
  - Clean and modern design
  - Display Authrim logo
  - Email address input field
  - "Continue with Passkey" button (primary)
  - "Send Magic Link" button (secondary)
  - "Create Account" link
  - Language switcher (future)

- [ ] **Functional Requirements**
  - Email address validation
  - Passkey-capable browser detection
  - Error message display
  - Loading state
  - Accessibility (keyboard navigation, screen reader)

- [ ] **Responsive Support**
  - Mobile (320px~)
  - Tablet (768px~)
  - Desktop (1024px~)

- Comment: Want multi-language support from the start. Templates are fine but I hear Auth0 has limited freedom with backgrounds and design. Want an environment where links, images, videos, CSS, Javascript can be freely written. Same for other screens. What offers modern yet flexible options? Needs consideration. Use Cloudflare's reCaptcha.
  - **Decision**:
    - **Phase 5 Implementation**: Theme system (basic customization)
      ```sql
      CREATE TABLE branding_settings (
        id TEXT PRIMARY KEY DEFAULT 'default',
        custom_css TEXT,
        custom_html_header TEXT,
        custom_html_footer TEXT,
        logo_url TEXT,
        background_image_url TEXT,
        primary_color TEXT DEFAULT '#3B82F6',
        secondary_color TEXT DEFAULT '#10B981',
        font_family TEXT DEFAULT 'Inter',
        updated_at INTEGER NOT NULL
      );
      ```
    - **Phase 7 Implementation**: WebSDK (advanced customization)
      - Provided as Web Components
      - Customizable placeholders (`<$$$LoginEmailInput$$$>`, etc.)
      - Fully stylable
      - Event handler support
    - **Captcha**: Use Cloudflare Turnstile (reCAPTCHA compatible, privacy-focused)
    - **Multi-language**: Implement from Phase 5 (English/Japanese), use Paraglide (type-safe, lightweight)

##### Page 2: Account Registration Screen (`/register`)
- [ ] **Design Requirements**
  - Email address input
  - Name input (optional)
  - "Create Account with Passkey" button
  - "Sign up with Magic Link" button
  - "Already have an account?" link

- [ ] **Functional Requirements**
  - Form validation
  - Duplicate email detection
  - Passkey registration flow
  - Terms of service and privacy policy consent checkbox

##### Page 3: Magic Link Sent Screen (`/magic-link-sent`)
- [ ] **Design Requirements**
  - Success message
  - "Check your email"
  - Display email address
  - "Resend email" button
  - "Back to login" link

- [ ] **Functional Requirements**
  - Timer (resend restriction)
  - Email resend functionality

##### Page 4: Magic Link Verification Screen (`/verify-magic-link`)
- [ ] **Design Requirements**
  - Loading spinner
  - "Verifying..." message
  - On error: Error message + "Request new link" button

- [ ] **Functional Requirements**
  - Get token from URL parameters
  - Token verification
  - Session creation
  - Redirect to original page

##### Page 5: OAuth Consent Screen (`/consent`)
- [ ] **Design Requirements**
  - Client logo and name
  - "{Client Name} wants to access your Authrim account"
  - Scope list (with icons)
  - Display user information (email, name)
  - "Allow" button (primary)
  - "Deny" button (secondary)
  - "Not you? Switch account" link

- [ ] **Functional Requirements**
  - Human-readable scope conversion
  - Get client information
  - Consent/denial processing
  - Redirect processing

- Comment: Want to be able to display terms of service and privacy policy.
  - **Answer**: Already defined in `oauth_clients` table:
    - `policy_uri` - Privacy policy URL
    - `tos_uri` - Terms of service URL
  - Display these on consent screen as clickable links

##### Page 6: Error Page (`/error`)
- [ ] **Design Requirements**
  - Error message
  - Error code
  - "Back to login" button
  - Support contact information

- [ ] **Functional Requirements**
  - Support for various error types
  - User-friendly messages

#### 5.2 Admin Pages

##### Page 7: Admin Dashboard (`/admin`)
- [ ] **Design Requirements**
  - Sidebar navigation
  - Top bar (logo, search, notifications, profile)
  - Statistics cards (user count, active sessions, today's logins, client count)
  - Activity feed (latest logins, registrations, errors)
  - Charts (login trends, user registration trends)

- Comment: Just an idea, but how about a SimCity-like UI? Have entry and exit points, choose which components (authentication methods) as buildings. Show external auth like RP/SAML as ports or airports. Which path to take, optional actions, click buildings for details. Like SimCity 2000 UI.
  - **Answer**: Excellent idea! Phase 5 implements standard dashboard UI, Phase 7 experiments with visual approach.
  - **Phase 7 Planned Implementation**:
    - Visual authentication flow builder (SimCity-style UI)
    - Drag & drop to build authentication flows
    - Place each component (Passkey, Magic Link, Social Login, etc.) as "buildings"
    - Visualize entire flow (entry→authentication→exit)
  - **Added to Roadmap**: As advanced admin feature in Phase 7

- [ ] **Functional Requirements**
  - Real-time statistics (or periodic updates)
  - Activity filtering
  - Responsive design

##### Page 8: User Management (`/admin/users`)
- [ ] **Design Requirements**
  - User list table (email, name, created_at, last_login_at, status)
  - Search bar
  - Filters (verified/unverified, active/inactive)
  - Sort functionality
  - Pagination
  - "Add User" button
  - Actions (Edit, Delete, View)

- [ ] **Functional Requirements**
  - User search (email, name)
  - User creation form
  - User edit form
  - User deletion (confirmation dialog)
  - Detail display (modal or separate page)

- Comment: Want data import from external sources, ETL functionality. Can be later though.
  - **Answer**: Planned for Phase 6 or 7
    - CSV/JSON import/export
    - SCIM 2.0 protocol support (Phase 7)
    - Webhook integration
    - Bulk user operations API
  - **Added to Roadmap**: As enterprise feature in Phase 7

##### Page 9: User Detail/Edit (`/admin/users/:id`)
- [ ] **Design Requirements**
  - User information form (all OIDC standard claims)
  - Passkey list (registered devices)
  - Session list
  - Audit Log
  - "Save Changes" button
  - "Delete User" button (danger zone)

- [ ] **Functional Requirements**
  - Form validation
  - Update processing
  - Passkey deletion
  - Session invalidation

##### Page 10: Client Management (`/admin/clients`)
- [ ] **Design Requirements**
  - Client list table (client_id, client_name, created_at, grant_types)
  - Search bar
  - "Register Client" button
  - Actions (Edit, Delete, View Secret)

- [ ] **Functional Requirements**
  - Client search
  - Client registration form (using DCR API)
  - Client editing
  - Client deletion
  - Client Secret display (mask/show toggle)

##### Page 11: Client Detail/Edit (`/admin/clients/:id`)
- [ ] **Design Requirements**
  - Client information form (RFC 7591 compliant)
  - Redirect URIs management
  - Grant Types selection
  - Scope configuration
  - "Save Changes" button
  - "Regenerate Secret" button
  - "Delete Client" button

- [ ] **Functional Requirements**
  - Form validation
  - Update processing
  - Secret regeneration
  - Deletion processing

- Comment: Want scopes to be able to fetch any schema from DB and create claims.
  - **Decision**:
    ```sql
    CREATE TABLE scope_mappings (
      scope TEXT PRIMARY KEY,
      claim_name TEXT NOT NULL,
      source_table TEXT NOT NULL, -- 'users', 'user_custom_fields'
      source_column TEXT NOT NULL, -- 'email', 'custom_attributes_json.employee_id'
      transformation TEXT, -- 'uppercase', 'lowercase', 'hash', 'mask'
      condition TEXT, -- SQL WHERE condition (optional)
      created_at INTEGER NOT NULL
    );
    ```
  - **Examples**:
    - `scope=employee_id` → `claim: { employee_id: users.custom_attributes_json.employee_id }`
    - `scope=department` → `claim: { department: user_custom_fields[department] }`
  - Admin panel can configure scope-to-claim mappings

##### Page 12: Settings (`/admin/settings`)
- [ ] **Design Requirements**
  - Tabs (General, Appearance, Security, Email, Advanced)
  - General: Site name, logo, language, timezone
  - Appearance: Theme, colors, login page customization
  - Security: Password policy, session timeout, MFA settings
  - Email: SMTP settings, email templates
  - Advanced: Token TTL, Rate Limiting settings

- [ ] **Functional Requirements**
  - Save settings (environment variables or D1)
  - Preview functionality (login page customization)
  - Test email sending

- Comment: Want data to be exportable.
  - **Answer**: Add to admin panel:
    - CSV/JSON export (all tables)
    - GDPR compliance (personal data export, right to erasure)
    - Backup/restore functionality
    - Automatic backup configuration
  - **Phase 5 Implementation**: Basic export functionality
  - **Phase 7 Extension**: GDPR automation, compliance tools
  - **Added to Roadmap**: As compliance feature in Phase 7

##### Page 13: Audit Log (`/admin/audit-log`)
- [ ] **Design Requirements**
  - Log table (timestamp, user, action, resource, IP, status)
  - Filters (date range, action, user)
  - Search
  - Export (CSV, JSON)

- [ ] **Functional Requirements**
  - Log display and search
  - Filtering
  - Export functionality

### 6️⃣ Admin Authentication & Permission Management

#### 6.1 Admin Account Management
- [ ] **Admin Definition**
  - Add `user_roles` table to D1?
  - Or `users.is_admin` flag?
  - Or dedicated `admins` table?

- [ ] **Recommended**: `user_roles` table (extensibility)
  ```sql
  CREATE TABLE user_roles (
    user_id TEXT NOT NULL,
    role TEXT NOT NULL, -- 'admin', 'user'
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, role),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  ```

- Comment: Want to be able to configure admin roles.
  - **Decision**: RBAC (Role-Based Access Control) implementation
    ```sql
    CREATE TABLE roles (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      permissions_json TEXT NOT NULL, -- ['users:read', 'users:write', 'clients:read', 'clients:write', 'settings:write']
      created_at INTEGER NOT NULL
    );

    CREATE TABLE user_roles (
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, role_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
    );
    ```
  - **Default Roles**:
    - **Super Admin**: All permissions
    - **Admin**: User and client management only
    - **Viewer**: Read-only
    - **Support**: User support (password reset, etc.)
  - Phase 5 implements simple RBAC, Phase 7 extends to ABAC (Attribute-Based Access Control)

#### 6.2 Admin Authentication Flow
- [ ] **Authentication Method**
  - Normal login flow + role check
  - Permission verification when accessing admin dashboard
  - Implement `requireAdmin()` middleware

#### 6.3 Permission Levels
- [ ] **Role Definitions**
  - **Super Admin**: All permissions (users, clients, settings)
  - **Admin**: User and client management only
  - **Viewer**: Read-only

  (Phase 5 implements simple Admin/User only, Phase 7 implements full RBAC)

### 7️⃣ Security Requirements

#### 7.1 CSRF Protection
- [ ] **Implementation Method**
  - Double Submit Cookie
  - Or synchronizer token (session storage)
  - Verify on all POST requests

#### 7.2 XSS Protection
- [ ] **Implementation Method**
  - CSP Header (extend existing implementation)
  - HTML escaping (framework default feature)
  - Input sanitization

#### 7.3 Session Security
- [ ] **Requirements**
  - HttpOnly Cookie
  - Secure Cookie (HTTPS)
  - SameSite=Lax
  - Session timeout (default: 24 hours)
  - Absolute timeout (default: 7 days)

#### 7.4 Rate Limiting (leverage existing implementation)
- [ ] **Target Endpoints**
  - `/login` - 5 req/min per IP
  - `/register` - 3 req/min per IP
  - `/auth/magic-link/send` - 3 req/15min per email
  - `/admin/*` - 100 req/min per session

- Comment: What and whom is this rate limiting protecting?
  - **Answer**: Protection purpose for each endpoint
    - `/login`, `/register`: Protect from **brute force attacks** (prevent account takeover)
    - `/auth/magic-link/send`: Protect from **email bombing (spam)** (reduce email sending costs, prevent service abuse)
    - `/admin/*`: Protect from **DDoS attacks** and resource consumption (maintain service availability)
    - `/token`, `/userinfo`: Protect from **API abuse** (prevent excessive token issuance and information retrieval)
  - **Admin Panel Implementation**: Visualize Rate Limit statistics and logs in admin panel in Phase 5
    - List of blocked IP addresses
    - Request count graphs per endpoint
    - Anomaly detection alerts

### 8️⃣ Internationalization (i18n) Support

#### 8.1 Supported Languages (Phase 5)
- [ ] **Initial Support**
  - English (en) - Default
  - Japanese (ja)

- [ ] **Future Additions** (Phase 6 onwards)
  - Chinese (zh)
  - Spanish (es)
  - French (fr)
  - German (de)

#### 8.2 Implementation Method
- [ ] **Library Selection**
  - **i18next** - Standard, feature-rich
  - **Paraglide** - Type-safe, lightweight
  - **Framework Standard** - SvelteKit/SolidStart built-in features

- [ ] **Translation File Management**
  - JSON format
  - `locales/en.json`, `locales/ja.json`
  - Nested structure

#### 8.3 Language Switching
- [ ] **Detection Method**
  - `ui_locales` parameter (OIDC standard)
  - Cookie
  - Accept-Language Header
  - Manual switching in UI

### 9️⃣ Performance Requirements

#### 9.1 Target Metrics
- [ ] **Page Load Time**
  - Login page: < 1 second (First Contentful Paint)
  - Admin dashboard: < 2 seconds
  - User list: < 1.5 seconds (displaying 100 items)

- [ ] **Bundle Size**
  - Initial JS: < 100KB (gzip)
  - Initial CSS: < 20KB (gzip)

- [ ] **Lighthouse Scores**
  - Performance: > 90
  - Accessibility: > 95
  - Best Practices: > 90
  - SEO: > 90

#### 9.2 Optimization Strategy
- [ ] **Frontend**
  - Code splitting (route-based)
  - Lazy loading (images, components)
  - Tree Shaking
  - CDN delivery (Cloudflare Pages)
  - Service Worker (future)

- [ ] **Backend**
  - KV caching
  - Database query optimization
  - Batch processing (statistics data)

### 🔟 Accessibility Requirements

#### 10.1 WCAG 2.1 AA Compliance
- [ ] **Required Items**
  - Keyboard navigation support (Tab, Enter, Esc)
  - Screen reader support (ARIA attributes)
  - Color contrast ratio 4.5:1 or higher
  - Focus indicators
  - Clear error messages
  - Proper form label associations

#### 10.2 Testing Methods
- [ ] **Tools**
  - axe DevTools
  - Lighthouse Accessibility Audit
  - NVDA/JAWS screen reader testing
  - Keyboard-only navigation testing

---

## Timeline (4 weeks)

### Week 1 (May 1-7): Foundation
- **Day 1-2**: Finalize technology stack
  - Framework selection meeting
  - Create prototype
- **Day 3-4**: Project setup
  - Frontend environment setup
  - D1 database creation and migration
  - Storage abstraction layer implementation
- **Day 5-7**: WebAuthn basic implementation
  - Server-side implementation
  - Client-side implementation
  - Basic registration and authentication flow

### Week 2 (May 8-14): Authentication UI Implementation
- **Day 8-10**: Login and registration pages
  - Design implementation
  - Passkey integration
  - Magic Link integration
- **Day 11-12**: OAuth consent screen
  - Design implementation
  - Consent flow integration
- **Day 13-14**: Error handling, testing

### Week 3 (May 15-21): Admin Dashboard
- **Day 15-17**: Dashboard layout
  - Sidebar, top bar
  - Statistics cards
  - Activity feed
- **Day 18-19**: User management
  - List, search, CRUD
- **Day 20-21**: Client management
  - List, search, CRUD

### Week 4 (May 22-28): Finishing & Testing
- **Day 22-23**: Settings page, Audit Log
- **Day 24-25**: Accessibility improvements
- **Day 26-27**: Performance optimization
- **Day 28**: Comprehensive testing, documentation updates

### Buffer (May 29-31): Reserve days

---

## Checklist

### Decisions
- [ ] Frontend framework decision
- [ ] CSS framework decision
- [ ] UI component library decision
- [ ] UI hosting method decision
- [ ] Session management method decision
- [ ] Email sending service decision
- [ ] D1 schema approval
- [ ] Admin permission model decision
- [ ] i18n library decision
- [ ] Performance targets agreement

### Design Completion
- [ ] Finalize D1 schema
- [ ] API endpoint specifications
- [ ] Authentication flow diagrams
- [ ] UI/UX wireframes (all 13 pages)
- [ ] Design system (colors, typography, spacing)
- [ ] Error handling strategy
- [ ] Security checklist

### Implementation Preparation
- [ ] Install required libraries
- [ ] Create D1 database
- [ ] Create migration scripts
- [ ] Create seed data
- [ ] Update development environment setup guide
- [ ] Update CI/CD pipeline (add UI build)

---

## Next Steps

1. **Review this Document**
   - Review each section in order
   - Check off decisions
   - Comment on questions or additions

2. **Technology Selection Meeting**
   - Finalize frontend stack
   - Create prototype (2-3 days)

3. **Detailed Design**
   - ✅ Create ER diagram → [database-schema.md](../architecture/database-schema.md)
   - ✅ Create API specifications → [OpenAPI 3.1](../api/openapi.yaml) | [API Guide](../api/README.md)
   - ✅ Establish design system → [design-system.md](../design/design-system.md)
   - ✅ Create wireframes → [wireframes.md](../design/wireframes.md)

4. **Begin Implementation**
   - Proceed according to timeline from Week 1

---

## Reference Materials

### Authrim Documentation
- **Design Documents** (✅ Completed)
  - [database-schema.md](../architecture/database-schema.md) - Database schema and ER diagram
  - [openapi.yaml](../api/openapi.yaml) - OpenAPI 3.1 specification
  - [API README](../api/README.md) - API guide and quick start
  - [API_INVENTORY.md](./API_INVENTORY.md) - API inventory
  - [design-system.md](../design/design-system.md) - Design system
  - [wireframes.md](../design/wireframes.md) - UI wireframes (all 13 pages)
- **Project Information**
  - [ROADMAP.md](../ROADMAP.md) - Overall roadmap
  - [VISION.md](../VISION.md) - Project vision

### Competitive Analysis
- [Auth0 Login Experience](https://auth0.com/)
- [Clerk UI Components](https://clerk.com/)
- [Supabase Auth UI](https://supabase.com/docs/guides/auth/auth-ui)

### WebAuthn/Passkey
- [SimpleWebAuthn Documentation](https://simplewebauthn.dev/)
- [WebAuthn Guide (web.dev)](https://web.dev/passkey-registration/)
- [FIDO2 Specifications](https://fidoalliance.org/fido2/)

### Design Inspiration
- [Tailwind UI](https://tailwindui.com/)
- [shadcn/ui](https://ui.shadcn.com/)
- [Refactoring UI](https://www.refactoringui.com/)

---

**Last Updated**: 2025-11-12
**Status**: Planning Complete - Ready for Implementation
**Next Review**: 2026-05-01 (Phase 5 Start)

---

## 📝 Decision Summary

### Technology Stack
- ✅ **Frontend**: Svelte + SvelteKit v5
- ✅ **CSS**: UnoCSS
- ✅ **Components**: Melt UI
- ✅ **Hosting**: Hybrid (Cloudflare Pages + Workers)
- ✅ **Captcha**: Cloudflare Turnstile
- ✅ **i18n**: Paraglide
- ✅ **Email**: Resend (default), adapter pattern for others

### Architecture
- ✅ **Session Management**: Server-side session + token exchange (full ITP compliance)
- ✅ **Storage Abstraction**: IStorageAdapter interface (multi-cloud support)
- ✅ **Custom Fields**: Hybrid (dedicated table + JSON)
- ✅ **RBAC**: roles + user_roles tables
- ✅ **Scope Mapping**: scope_mappings table

### API Additions (2025-11-12)
- 📝 **ITP-Compliant SSO APIs** (4)
  - `POST /auth/session/token` - Issue short-lived token
  - `POST /auth/session/verify` - Verify short-lived token
  - `GET /session/status` - Check session validity
  - `POST /session/refresh` - Extend session
- 📝 **Logout APIs** (2)
  - `GET /logout` - Front-channel Logout
  - `POST /logout/backchannel` - Back-channel Logout
- 📝 **Admin Session Management APIs** (2)
  - `GET /admin/sessions` - List sessions
  - `POST /admin/sessions/:id/revoke` - Invalidate session
- 🔄 **Token Exchange APIs** (Under Consideration)
  - RFC 8693 Token Exchange (standard, most flexible)
  - Dedicated session exchange API (simple, ITP SSO focused)
  - Hybrid approach (support both)
  - Decision: Finalize requirements during Phase 5 implementation

### Database Schema
- ✅ Users (with custom_attributes_json, parent_user_id)
- ✅ user_custom_fields (searchable)
- ✅ Passkeys
- ✅ Sessions
- ✅ Roles & user_roles
- ✅ scope_mappings
- ✅ branding_settings
- ✅ identity_providers (future SAML/LDAP)

### Future Extensions (Phase 7)
- 📝 WebSDK (advanced customization)
- 📝 Visual Flow Builder (SimCity-style UI)
- 📝 GDPR automation
- 📝 CSV/JSON import/export
- 📝 SCIM 2.0
