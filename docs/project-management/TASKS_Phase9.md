# Phase 9: SDK & API

**Timeline:** 2027-Q2
**Status:** 🔜 Planned

---

## Overview

Phase 9 focuses on developer experience by creating client SDKs and comprehensive API documentation. The goal is to enable easy integration of Authrim into various applications, with a special focus on web applications that need SSO capabilities.

---

## WebSDK Architecture

Following the successful patterns of SAP CDC and similar identity platforms, Authrim will provide a modular SDK architecture.

### @authrim/sdk-core (Headless) 🔜

A framework-agnostic core library implementing OIDC/PKCE logic:

#### Core Functionality

- [ ] Design SDK interface
  ```typescript
  interface AuthrimClient {
    // Configuration
    init(config: AuthrimConfig): void;

    // Authentication
    login(options?: LoginOptions): Promise<void>;
    logout(options?: LogoutOptions): Promise<void>;

    // Token management
    getAccessToken(): Promise<string | null>;
    getIdToken(): Promise<string | null>;
    refreshToken(): Promise<void>;

    // User info
    getUserInfo(): Promise<UserInfo | null>;
    isAuthenticated(): boolean;

    // Events
    onAuthStateChange(callback: AuthStateCallback): void;
  }
  ```
- [ ] Implement PKCE flow (code_challenge, code_verifier)
- [ ] Implement state parameter generation and validation
- [ ] Add nonce generation for ID Token validation
- [ ] Implement secure token storage (sessionStorage, localStorage options)
- [ ] Add automatic token refresh
- [ ] Implement silent authentication (iframe)
- [ ] Add popup login support
- [ ] Implement redirect login support

#### Configuration Options

- [ ] Issuer URL
- [ ] Client ID
- [ ] Redirect URIs
- [ ] Scopes
- [ ] Response type
- [ ] Storage options (memory, localStorage, sessionStorage)
- [ ] Token refresh settings

#### Error Handling

- [ ] Define error types (AuthError, TokenError, etc.)
- [ ] Implement retry logic for network failures
- [ ] Add timeout handling
- [ ] Create error callbacks

#### Testing

- [ ] Unit tests for PKCE generation
- [ ] Unit tests for token parsing
- [ ] Unit tests for storage
- [ ] Integration tests with mock server
- [ ] Browser compatibility tests

---

### @authrim/sdk-web (Web Components) 🔜

UI components for login/logout using modern Web Components:

#### Technology Choice

- [ ] Evaluate Lit vs Stencil for Web Components
- [ ] Set up component build pipeline
- [ ] Configure CSS encapsulation (Shadow DOM)

#### Components

- [ ] `<authrim-login-button>` - Login button
  ```html
  <authrim-login-button
    label="Sign In"
    theme="primary"
    size="medium"
    @click="handleLogin">
  </authrim-login-button>
  ```
- [ ] `<authrim-logout-button>` - Logout button
- [ ] `<authrim-user-menu>` - User dropdown menu
- [ ] `<authrim-login-form>` - Embedded login form
- [ ] `<authrim-social-buttons>` - Social login button group

#### Theming

- [ ] CSS custom properties for theming
- [ ] Light/dark mode support
- [ ] Size variants (small, medium, large)
- [ ] Brand color customization

#### Events

- [ ] `authrim-login-start` - Login initiated
- [ ] `authrim-login-success` - Login successful
- [ ] `authrim-login-error` - Login failed
- [ ] `authrim-logout` - Logout completed
- [ ] `authrim-token-refreshed` - Token refreshed

#### Testing

- [ ] Component unit tests
- [ ] Visual regression tests
- [ ] Accessibility tests (a11y)
- [ ] Browser compatibility tests

---

### CDN Bundle 🔜

Single-file distribution for `<script>` tag usage:

#### Build Configuration

- [ ] Configure bundler (esbuild/rollup)
- [ ] Implement tree-shaking
- [ ] Create minified bundle
- [ ] Generate source maps
- [ ] Add UMD format support

#### Usage Pattern

```html
<!-- Include the SDK -->
<script src="https://cdn.authrim.com/sdk/authrim-sdk.min.js"></script>

<!-- Initialize -->
<script>
  const authrim = new Authrim({
    issuer: 'https://auth.example.com',
    clientId: 'my-app',
    redirectUri: window.location.origin + '/callback'
  });

  // Check authentication
  if (authrim.isAuthenticated()) {
    console.log('User:', authrim.getUserInfo());
  }
</script>

<!-- Use components -->
<authrim-login-button></authrim-login-button>
```

#### CDN Hosting

- [ ] Set up CDN distribution
- [ ] Version URL structure (`/sdk/v1/authrim-sdk.min.js`)
- [ ] Add integrity hash (SRI)
- [ ] Configure caching headers
- [ ] Add gzip/brotli compression

---

## SSO Integration

### Single Sign-On Support 🔜

- [ ] Implement session checking
- [ ] Add silent token refresh via iframe
- [ ] Support cross-domain SSO
- [ ] Implement session storage sharing
- [ ] Add logout propagation

### Session Management

- [ ] Track active sessions
- [ ] Implement session timeout handling
- [ ] Add session keep-alive
- [ ] Support single logout (SLO)

---

## API Documentation

### OpenAPI Specification 🔜

Complete the OpenAPI 3.1 specification:

- [ ] Review existing `openapi.yaml`
- [ ] Add missing endpoints
- [ ] Complete request/response schemas
- [ ] Add authentication schemas
- [ ] Document error responses
- [ ] Add examples for all endpoints
- [ ] Validate against spec

### API Documentation Portal 🔜

Create interactive documentation:

- [ ] Set up documentation site (e.g., Redoc, Stoplight)
- [ ] Generate API reference from OpenAPI
- [ ] Add "Try it" functionality
- [ ] Create getting started guide
- [ ] Add authentication tutorial
- [ ] Create use case examples
- [ ] Add FAQ section

### SDK Documentation 🔜

- [ ] SDK installation guide
- [ ] Quick start tutorial
- [ ] API reference (generated from TypeScript)
- [ ] Framework integration guides
  - [ ] React integration
  - [ ] Vue integration
  - [ ] Angular integration
  - [ ] Svelte integration
  - [ ] Vanilla JS examples
- [ ] Troubleshooting guide

---

## Framework Examples

### React Example 🔜

- [ ] Create React example app
- [ ] Implement hooks (`useAuth`, `useUser`)
- [ ] Add protected route example
- [ ] Document React integration

### Vue Example 🔜

- [ ] Create Vue example app
- [ ] Implement composables
- [ ] Add route guard example
- [ ] Document Vue integration

### Vanilla JS Example 🔜

- [ ] Create plain HTML/JS example
- [ ] Show CDN usage
- [ ] Demonstrate Web Components
- [ ] Document basic usage

---

## Testing Requirements

### Unit Tests

- [ ] sdk-core: 50+ tests
- [ ] sdk-web: 30+ tests
- [ ] CDN bundle: integration tests

### Integration Tests

- [ ] Full SSO flow test
- [ ] Token refresh flow test
- [ ] Logout flow test
- [ ] Error handling tests

### Browser Compatibility

Test on:
- [ ] Chrome (latest 2 versions)
- [ ] Firefox (latest 2 versions)
- [ ] Safari (latest 2 versions)
- [ ] Edge (latest 2 versions)

---

## Success Metrics

| Metric | Target | Current |
|--------|--------|---------|
| sdk-core size | <10KB gzipped | - |
| sdk-web components | 5+ | - |
| CDN bundle size | <20KB gzipped | - |
| API doc coverage | 100% | - |
| Framework examples | 3+ | - |

---

## Package Publishing

### NPM Packages

- [ ] `@authrim/sdk-core` - Core SDK
- [ ] `@authrim/sdk-web` - Web Components
- [ ] `authrim` - Meta package (includes both)

### CDN Distribution

- [ ] Host on Cloudflare CDN
- [ ] Versioned URLs
- [ ] Integrity hashes
- [ ] Release automation

---

## Dependencies

- Phase 7: Policy Service for authorization
- Phase 8: Login UI for hosted login page
- Cloudflare Workers: Backend API
- jose library: JWT handling

---

## Related Documents

- [API README](../api/README.md)
- [OpenAPI Specification](../api/openapi.yaml)
- [ROADMAP](../ROADMAP.md)

---

> **Last Update**: 2025-12-02
