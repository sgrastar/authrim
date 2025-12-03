# Phase 10: SDK & API

**Timeline:** 2026-Q4
**Status:** 🔜 Planned

---

## Overview

Phase 10 focuses on developer experience by creating client SDKs and comprehensive API documentation. The goal is to enable easy integration of Authrim into various applications, with support for authentication, authorization, and the new Identity Hub features.

---

## Architecture Vision

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Developer Applications                          │
│   React App    Vue App    Angular App    Vanilla JS    Mobile App       │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Authrim SDK Layer                              │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐  │
│  │  @authrim/      │  │  @authrim/      │  │  authrim-sdk.min.js     │  │
│  │  sdk-core       │  │  sdk-web        │  │  (CDN Bundle)           │  │
│  │  (Headless)     │  │  (Web Comps)    │  │                         │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Authrim Platform                                │
│   OIDC    Policy API    UserInfo    Identity Hub    VC/Wallet           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 10.1 @authrim/sdk-core (Headless)

Framework-agnostic core library implementing OIDC/PKCE logic:

### Core Design 🔜

- [ ] Define SDK architecture
- [ ] Design public API surface
- [ ] Plan bundle size optimization (<10KB gzipped)
- [ ] Set up build pipeline (esbuild/rollup)

### Authentication Interface 🔜

- [ ] Design and implement core interface

  ```typescript
  interface AuthrimClient {
    // Configuration
    init(config: AuthrimConfig): void;

    // Authentication
    login(options?: LoginOptions): Promise<void>;
    logout(options?: LogoutOptions): Promise<void>;
    handleCallback(): Promise<AuthResult>;

    // Token management
    getAccessToken(): Promise<string | null>;
    getIdToken(): Promise<string | null>;
    refreshToken(): Promise<void>;
    isTokenExpired(): boolean;

    // User info
    getUserInfo(): Promise<UserInfo | null>;
    isAuthenticated(): boolean;

    // Policy integration (Phase 8)
    checkPermission(permission: string, resource?: string): Promise<boolean>;
    getPermissions(): Promise<string[]>;

    // Events
    onAuthStateChange(callback: AuthStateCallback): Unsubscribe;
    onTokenRefresh(callback: TokenCallback): Unsubscribe;
  }

  interface AuthrimConfig {
    issuer: string;
    clientId: string;
    redirectUri: string;
    scopes?: string[];
    responseType?: 'code';
    storage?: 'memory' | 'localStorage' | 'sessionStorage';
    autoRefresh?: boolean;
    refreshBuffer?: number; // seconds before expiry
  }
  ```

- [ ] Unit tests for all methods

### PKCE Implementation 🔜

- [ ] Implement code_verifier generation (cryptographically random)
- [ ] Implement code_challenge generation (SHA256, base64url)
- [ ] Implement state parameter generation
- [ ] Implement nonce generation
- [ ] Secure storage of PKCE values during flow
- [ ] Unit tests

### Token Management 🔜

- [ ] Implement secure token storage
  - [ ] Memory storage (most secure, lost on refresh)
  - [ ] localStorage (persistent, XSS vulnerable)
  - [ ] sessionStorage (tab-scoped)
- [ ] Implement automatic token refresh
- [ ] Implement token expiry detection
- [ ] Handle refresh token rotation
- [ ] Unit tests

### Silent Authentication 🔜

- [ ] Implement iframe-based silent auth
- [ ] Handle third-party cookie restrictions
- [ ] Implement fallback to full redirect
- [ ] Add timeout handling
- [ ] Unit tests

### Popup Login 🔜

- [ ] Implement popup window management
- [ ] Handle cross-origin communication
- [ ] Implement popup blocker detection
- [ ] Fallback to redirect flow
- [ ] Unit tests

### Error Handling 🔜

- [ ] Define error types

  ```typescript
  class AuthrimError extends Error {
    code: string;
    description?: string;
  }

  // Error codes
  ('login_required',
    'consent_required',
    'interaction_required',
    'access_denied',
    'invalid_request',
    'token_expired',
    'network_error',
    'popup_blocked',
    'timeout');
  ```

- [ ] Implement retry logic for network failures
- [ ] Add timeout handling
- [ ] Unit tests

---

## 10.2 @authrim/sdk-web (Web Components)

UI components for login/logout using Web Components:

### Technology Setup 🔜

- [ ] Evaluate Lit vs Stencil
- [ ] Set up component build pipeline
- [ ] Configure Shadow DOM styling
- [ ] Plan component bundle size

### Login Button Component 🔜

- [ ] Implement `<authrim-login-button>`
  ```html
  <authrim-login-button
    label="Sign In"
    variant="primary"
    size="medium"
    provider="google"
  ></authrim-login-button>
  ```
- [ ] Style variants (primary, secondary, outline)
- [ ] Size variants (small, medium, large)
- [ ] Loading state
- [ ] Disabled state
- [ ] Unit tests

### Logout Button Component 🔜

- [ ] Implement `<authrim-logout-button>`
- [ ] Confirmation option
- [ ] Loading state
- [ ] Unit tests

### User Menu Component 🔜

- [ ] Implement `<authrim-user-menu>`
  ```html
  <authrim-user-menu show-avatar="true" show-email="true"></authrim-user-menu>
  ```
- [ ] User avatar display
- [ ] Dropdown menu
- [ ] Profile link
- [ ] Logout action
- [ ] Unit tests

### Login Form Component 🔜

- [ ] Implement `<authrim-login-form>`
- [ ] Username/password fields
- [ ] Social login buttons
- [ ] Error display
- [ ] Loading states
- [ ] Accessibility compliance
- [ ] Unit tests

### Social Buttons Component 🔜

- [ ] Implement `<authrim-social-buttons>`
- [ ] Auto-fetch enabled providers
- [ ] Brand-appropriate styling
- [ ] Unit tests

### Theming 🔜

- [ ] CSS custom properties support
  ```css
  authrim-login-button {
    --authrim-primary-color: #0066cc;
    --authrim-border-radius: 8px;
    --authrim-font-family: 'Inter', sans-serif;
  }
  ```
- [ ] Light/dark mode support
- [ ] Custom brand colors
- [ ] Unit tests

### Events 🔜

- [ ] Define custom events
  ```typescript
  // Events emitted by components
  'authrim:login-start';
  'authrim:login-success';
  'authrim:login-error';
  'authrim:logout';
  'authrim:token-refreshed';
  'authrim:session-expired';
  ```
- [ ] Event documentation
- [ ] Unit tests

---

## 10.3 CDN Bundle

Single-file distribution for script tag usage:

### Build Configuration 🔜

- [ ] Configure bundler for CDN build
- [ ] Include core + web components
- [ ] Tree-shaking for minimal size
- [ ] Generate source maps
- [ ] UMD format support

### Usage Pattern 🔜

```html
<!-- Include from CDN -->
<script src="https://cdn.authrim.com/sdk/v1/authrim-sdk.min.js"></script>

<script>
  // Initialize
  const authrim = new Authrim({
    issuer: 'https://auth.example.com',
    clientId: 'my-client-id',
    redirectUri: window.location.origin + '/callback'
  });

  // Check authentication
  if (await authrim.isAuthenticated()) {
    const user = await authrim.getUserInfo();
    console.log('Welcome', user.name);
  }

  // Check permission
  if (await authrim.checkPermission('edit', 'document:123')) {
    // Show edit button
  }
</script>

<!-- Use components -->
<authrim-login-button></authrim-login-button>
```

### CDN Hosting 🔜

- [ ] Host on Cloudflare CDN
- [ ] Version URL structure
  - [ ] `/sdk/v1/authrim-sdk.min.js` (latest v1)
  - [ ] `/sdk/v1.2.3/authrim-sdk.min.js` (specific version)
- [ ] Generate SRI hashes
- [ ] Configure caching headers
- [ ] Enable gzip/brotli compression
- [ ] Set up release automation

---

## 10.4 API Documentation

### OpenAPI Specification 🔜

Complete the OpenAPI 3.1 specification:

- [ ] Audit existing `openapi.yaml`
- [ ] Add missing endpoints:
  - [ ] Policy endpoints
  - [ ] SCIM endpoints
  - [ ] Admin endpoints
  - [ ] Identity Hub endpoints
- [ ] Complete request/response schemas
- [ ] Add authentication schemes
- [ ] Document error responses
- [ ] Add examples for all endpoints
- [ ] Validate against OpenAPI spec

### Documentation Portal 🔜

Create interactive documentation site:

- [ ] Select documentation tool (Redoc, Stoplight, Mintlify)
- [ ] Deploy documentation site
- [ ] Generate API reference from OpenAPI
- [ ] Add "Try it" functionality
- [ ] Create getting started guide
- [ ] Add authentication tutorials
- [ ] Create use case examples
- [ ] Add FAQ section
- [ ] Enable search

### SDK Documentation 🔜

- [ ] SDK installation guide
- [ ] Quick start tutorial
- [ ] API reference (generated from TypeScript)
- [ ] Configuration options
- [ ] Error handling guide
- [ ] Migration guide (from other providers)

---

## 10.5 Framework Integrations

### React Integration 🔜

- [ ] Create `@authrim/react` package
- [ ] Implement hooks

  ```typescript
  // Hooks
  useAuth()          // { isAuthenticated, user, login, logout }
  usePermissions()   // { can, permissions }
  useToken()         // { accessToken, idToken, refresh }

  // Components
  <AuthrimProvider config={...}>
  <RequireAuth fallback={<Login />}>
  <IfPermitted permission="admin">
  ```

- [ ] Create example app
- [ ] Add route protection example
- [ ] Document React integration
- [ ] Unit tests

### Vue Integration 🔜

- [ ] Create `@authrim/vue` package
- [ ] Implement composables
  ```typescript
  useAuth();
  usePermissions();
  ```
- [ ] Create example app
- [ ] Add route guard example
- [ ] Document Vue integration
- [ ] Unit tests

### Next.js Integration 🔜

- [ ] Create `@authrim/next` package
- [ ] Support App Router
- [ ] Support Pages Router
- [ ] Server-side authentication
- [ ] Middleware for protected routes
- [ ] Example app
- [ ] Documentation

### Vanilla JS Examples 🔜

- [ ] Create plain HTML/JS example
- [ ] Show CDN usage
- [ ] Demonstrate Web Components
- [ ] Show permission checking
- [ ] Document basic usage

---

## Testing Requirements

### Unit Tests

- [ ] sdk-core: 60+ tests
- [ ] sdk-web: 40+ tests
- [ ] React hooks: 20+ tests
- [ ] Vue composables: 20+ tests

### Integration Tests

- [ ] Full login flow (redirect)
- [ ] Full login flow (popup)
- [ ] Token refresh flow
- [ ] Logout flow
- [ ] Permission check flow

### Browser Compatibility

Test on:

- [ ] Chrome (latest 2 versions)
- [ ] Firefox (latest 2 versions)
- [ ] Safari (latest 2 versions)
- [ ] Edge (latest 2 versions)
- [ ] Mobile Safari (iOS)
- [ ] Chrome for Android

---

## Package Publishing

### NPM Packages 🔜

- [ ] `@authrim/sdk-core` - Headless SDK
- [ ] `@authrim/sdk-web` - Web Components
- [ ] `@authrim/react` - React integration
- [ ] `@authrim/vue` - Vue integration
- [ ] `@authrim/next` - Next.js integration
- [ ] `authrim` - Meta package

### Publishing Pipeline 🔜

- [ ] Set up npm publishing workflow
- [ ] Semantic versioning
- [ ] Changelog generation
- [ ] Release notes
- [ ] CDN deployment on release

---

## Success Metrics

| Metric                 | Target        | Current |
| ---------------------- | ------------- | ------- |
| sdk-core size          | <10KB gzipped | -       |
| sdk-web size           | <15KB gzipped | -       |
| CDN bundle size        | <25KB gzipped | -       |
| SDK tests              | 150+          | -       |
| API doc coverage       | 100%          | -       |
| Framework integrations | 4             | -       |

---

## Dependencies

- Phase 6: Core OIDC functionality ✅
- Phase 7: Identity Hub endpoints
- Phase 8: Policy API endpoints
- jose library ✅
- Cloudflare CDN ✅

---

## Related Documents

- [ROADMAP](../ROADMAP.md) - Overall product direction
- [API README](../api/README.md) - API overview
- [TASKS_Phase9.md](./TASKS_Phase9.md) - Previous phase (Advanced Identity)
- [TASKS_Phase11.md](./TASKS_Phase11.md) - Next phase (Security & QA)

---

> **Last Update**: 2025-12-03 (Phase 10 definition for SDK & API)
