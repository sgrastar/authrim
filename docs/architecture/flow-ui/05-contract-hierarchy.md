# Contract Hierarchy Architecture

## Overview

Authrim IAM implements a **three-layer Contract hierarchy** that provides a structured, policy-driven approach to authentication configuration. This architecture enables tenant-level governance while allowing client-specific customization within defined constraints.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Tenant Policy (TenantContract)                       │
│  Defines the maximum allowable range for all settings at the tenant level   │
├─────────────────────────────────────────────────────────────────────────────┤
│                       Client Profile (ClientContract)                       │
│  Selects specific values within tenant policy bounds (restriction only)     │
├─────────────────────────────────────────────────────────────────────────────┤
│                     Effective Policy (ResolvedPolicy)                       │
│  Runtime-resolved policy pinned to session for flow execution               │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Design Principles

### 1. Restriction Only, No Relaxation

Clients can only **restrict** settings within tenant policy bounds, never **relax** them:

```typescript
// Tenant Policy defines the maximum
TenantContract.oauth.maxAccessTokenExpiry = 3600; // 1 hour max

// Client Profile can only choose equal or lower
ClientContract.oauth.accessTokenExpiry = 1800;   // 30 minutes (OK)
ClientContract.oauth.accessTokenExpiry = 7200;   // 2 hours (REJECTED)
```

### 2. All Settings are Contract-Based

All 15 existing settings categories are unified into the Contract hierarchy:

| Category | Scope | Contract Layer |
|----------|-------|----------------|
| oauth | tenant | TenantContract.oauth |
| session | tenant | TenantContract.session |
| security | tenant | TenantContract.security |
| consent | both | TenantContract.consent → ClientContract.consent |
| ciba | tenant | TenantContract.ciba |
| rate-limit | tenant | TenantContract.rateLimit |
| device-flow | tenant | TenantContract.deviceFlow |
| tokens | tenant | TenantContract.tokens |
| external-idp | tenant | TenantContract.externalIdp |
| credentials | tenant | TenantContract.credentials |
| federation | tenant | TenantContract.federation |
| scim | tenant | TenantContract.scim |
| client | client | ClientContract.* |
| infrastructure | platform | Read-only |
| encryption | platform | TenantContract.encryption (selection only) |

### 3. Preset-Based Configuration

Both Tenant Policy and Client Profile start from presets:

**Tenant Policy Presets:**
- `startup-minimal` - Minimal configuration for MVPs
- `b2c-standard` - Standard B2C (consumer-facing)
- `b2b-standard` - Standard B2B (business)
- `b2b-enterprise` - Enterprise B2B (large organizations)
- `regulated-finance` - Financial regulations (PCI-DSS, SOX)
- `regulated-healthcare` - Healthcare regulations (HIPAA)
- `high-security` - High security (government, defense)
- `custom` - Fully custom configuration

**Client Profile Presets:**
- `spa-public` - Single Page Application (public client)
- `mobile-native` - Native mobile app
- `server-confidential` - Server-side application
- `first-party-web` - First-party web application
- `first-party-mobile` - First-party mobile application
- `m2m-service` - Machine-to-machine (client_credentials)
- `iot-device` - IoT device
- `custom` - Fully custom configuration

### 4. Version Pinning

Policies are versioned and pinned to sessions:

```typescript
interface ResolvedPolicy {
  resolutionId: string;           // Hash of tenant.version + client.version
  tenantPolicyVersion: number;    // Pinned tenant version
  clientProfileVersion: number;   // Pinned client version
  resolvedAt: string;             // Resolution timestamp
}
```

This ensures consistency during authentication flows even if policies change mid-session.

## Type Hierarchy

### TenantContract

The tenant-level policy defining maximum allowable settings:

```typescript
interface TenantContract {
  tenantId: string;
  version: number;
  preset: TenantPolicyPreset;

  // All 15 categories as sub-policies
  oauth: TenantOAuthPolicy;
  session: TenantSessionPolicy;
  security: TenantSecurityPolicy;
  encryption: TenantEncryptionPolicy;
  scopes: TenantScopePolicy;
  authMethods: TenantAuthMethodPolicy;
  consent: TenantConsentPolicy;
  ciba: TenantCibaPolicy;
  deviceFlow: TenantDeviceFlowPolicy;
  externalIdp: TenantExternalIdpPolicy;
  federation: TenantFederationPolicy;
  scim: TenantScimPolicy;
  rateLimit: TenantRateLimitPolicy;
  tokens: TenantTokensPolicy;
  credentials: TenantCredentialsPolicy;
  dataResidency: TenantDataResidencyPolicy;
  audit: TenantAuditPolicy;

  metadata: ContractMetadata;
}
```

### ClientContract

The client-level profile selecting specific values within tenant bounds:

```typescript
interface ClientContract {
  clientId: string;
  version: number;
  tenantContractVersion: number;  // Referenced tenant version
  preset: ClientProfilePreset;

  clientType: ClientTypeConfig;
  oauth: ClientOAuthConfig;
  encryption: ClientEncryptionConfig;
  scopes: ClientScopeConfig;
  authMethods: ClientAuthMethodConfig;
  consent: ClientConsentConfig;
  redirect: ClientRedirectConfig;
  tokens: ClientTokenConfig;

  metadata: ContractMetadata;
}
```

### ResolvedPolicy

The runtime-resolved effective policy:

```typescript
interface ResolvedPolicy {
  resolutionId: string;
  resolvedAt: string;
  tenantPolicyVersion: number;
  clientProfileVersion: number;
  tenantId: string;
  clientId: string;

  // Effective settings (merged from tenant + client)
  oauth: EffectiveOAuthSettings;
  encryption: EffectiveEncryptionSettings;
  session: EffectiveSessionSettings;
  consent: EffectiveConsentSettings;
  authMethods: EffectiveAuthMethodSettings;
  mfa: EffectiveMfaSettings;
  scopes: EffectiveScopeSettings;
  security: EffectiveSecuritySettings;

  // Flow designer constraints
  flowConstraints: FlowConstraints;
  clientInfo: ResolvedClientInfo;
}
```

## Flow Designer Integration

### Policy-Based Node Filtering

The Flow Designer receives available nodes filtered by policy:

```typescript
interface AvailableNodesResponse {
  capabilities: AvailableNode[];
  customNodes: AvailableNode[];

  // Policy-filtered palette
  palette?: FlowNodePalette;
  activePolicy?: {
    tenantPolicyVersion: number;
    clientProfileVersion?: number;
    effectiveSecurityTier: SecurityTier;
  };
}
```

### Node Display States

Nodes are displayed with policy-aware states:

```typescript
interface FlowNodeDisplayState {
  type: string;
  displayName: string;
  available: boolean;        // Can be used
  disabledReason?: string;   // Why unavailable
  required: boolean;         // Must be in flow
  requiredReason?: string;   // Why required
  readonly: boolean;         // OIDC core (not editable)
  category: NodeCategory;
  badge?: NodeBadge;         // "推奨", "必須", etc.
}
```

### Policy Violations

Flow validation includes policy violation checks:

```typescript
interface FlowValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  policyViolations?: PolicyViolation[];
}

interface PolicyViolation {
  type: PolicyViolationType;
  nodeId?: string;
  message: string;
  source: 'tenant' | 'client';
  suggestion?: string;
}

type PolicyViolationType =
  | 'forbidden_auth_method'
  | 'forbidden_capability'
  | 'missing_mfa'
  | 'missing_consent'
  | 'security_tier_mismatch'
  | 'scope_not_allowed';
```

## UI Display Support

### Term Mapping

Technical terms are mapped to user-friendly labels:

```typescript
const UI_TERM_MAPPING = {
  passkey: 'パスキー（指紋・顔認証）',
  email_code: 'メール認証コード',
  mfa: '二段階認証',
  pkce: 'セキュリティ強化',
  // ...
};
```

### Setting State Visualization

Each setting shows its state relative to policy:

```typescript
interface SettingState {
  available: boolean;
  disabledReason?: string;
  constrainedBy?: ConstraintSource;  // 'tenant' | 'client' | 'security_tier' | etc.
  currentValue: unknown;
  allowedValues?: unknown[];
  recommendedValue?: unknown;
  differsFromRecommended: boolean;
}
```

### Change Impact Preview

Setting changes show their impact before applying:

```typescript
interface SettingChangeImpact {
  setting: string;
  displayName: string;
  oldValue: unknown;
  newValue: unknown;
  affectedAreas: AffectedArea[];
  overallSeverity: 'info' | 'warning' | 'breaking';
  requiresConfirmation: boolean;
}
```

## API Endpoints

### Tenant Policy API

```
GET    /api/admin/tenant-policy              # Get current policy
PUT    /api/admin/tenant-policy              # Update policy
GET    /api/admin/tenant-policy/presets      # List presets
POST   /api/admin/tenant-policy/apply-preset # Apply preset
GET    /api/admin/tenant-policy/diff         # Preview changes
```

### Client Profile API

```
GET    /api/admin/clients/:id/profile           # Get profile
PUT    /api/admin/clients/:id/profile           # Update profile
GET    /api/admin/client-profile-presets        # List presets
POST   /api/admin/clients/:id/apply-preset      # Apply preset
GET    /api/admin/clients/:id/profile/validate  # Validate against policy
```

### Effective Policy API (Runtime)

```
GET    /api/flow/effective-policy?client_id=xxx&challenge_id=xxx
```

## Naming Conventions

| Context | Tenant | Client | Resolved |
|---------|--------|--------|----------|
| Internal Type | `TenantContract` | `ClientContract` | `ResolvedPolicy` |
| External API | `TenantPolicy` | `ClientProfile` | `EffectivePolicy` |
| Endpoint | `/tenant-policy` | `/clients/:id/profile` | `/effective-policy` |

## OIDC Core Nodes

OIDC Core nodes are fixed and cannot be customized:

```typescript
const OIDC_CORE_NODES = [
  'oidc.authorize',      // Authorization endpoint processing
  'oidc.token',          // Token issuance
  'oidc.refresh',        // Token refresh
  'oidc.logout',         // Logout processing
  'oidc.introspection',  // Token introspection
  'oidc.revocation',     // Token revocation
] as const;

// Only consent is configurable
const CONFIGURABLE_OIDC_NODES = [
  'oidc.consent',        // Consent screen (policy-configurable)
] as const;
```

These nodes are displayed in the Flow Designer but grayed out and marked as read-only.

## File Structure

```
packages/ar-lib-core/src/
├── types/contracts/
│   ├── index.ts         # Main exports + external type aliases
│   ├── common.ts        # Shared types (algorithms, etc.)
│   ├── tenant.ts        # TenantContract + all sub-policies
│   ├── client.ts        # ClientContract + all sub-configs
│   ├── resolved.ts      # ResolvedPolicy + effective settings
│   ├── presets.ts       # Preset definitions + type guards
│   └── ui-display.ts    # UI display types + term mapping
├── schemas/
│   ├── flow-ui/index.ts       # FlowContext.policy added
│   ├── flow-design/index.ts   # AuthenticationFlow policy refs + PolicyViolation
│   └── flow-api/index.ts      # FlowContractResponse.policy added
```

## Migration Strategy

1. **Phase 1**: Add Contract types (non-breaking)
2. **Phase 2**: Default existing flows to `constraintSource: { type: 'tenant' }`
3. **Phase 3**: Add Admin API endpoints for policy management
4. **Phase 4**: Implement policy filtering in Flow Designer UI
5. **Phase 5**: Deprecate legacy Settings API endpoints

## References

- [Flow × UI Separation Architecture](./02-architecture-principles.md)
- [API Specification](./04-api-specification.md)
- [Settings Management](../configuration.md)
