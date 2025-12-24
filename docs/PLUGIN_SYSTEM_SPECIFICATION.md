# Authrim Plugin System Specification

**Version:** 1.0.0
**Status:** Implemented (Phase 1-3)
**Last Updated:** 2024-12-24

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Core Interfaces](#3-core-interfaces)
4. [Infrastructure Layer](#4-infrastructure-layer)
5. [Plugin Layer](#5-plugin-layer)
6. [Capability System](#6-capability-system)
7. [Configuration Management](#7-configuration-management)
8. [Security Considerations](#8-security-considerations)
9. [API Reference](#9-api-reference)

---

## 1. Overview

### 1.1 Purpose

The Authrim Plugin System provides a modular, extensible architecture for integrating external services and custom functionality into the Authrim identity platform. It enables:

- **Notification Services**: Email, SMS, Push notifications via multiple providers
- **Identity Providers**: Google, SAML, OIDC federation
- **Authenticators**: Passkey, OTP, custom MFA methods
- **Flow Extensions**: Custom authentication flow nodes (future)

### 1.2 Design Principles

| Principle | Description |
|-----------|-------------|
| **Hybrid Configuration** | Static code bundling with dynamic KV-based configuration |
| **Layer Separation** | Clear separation between Application, Plugin, and Infrastructure layers |
| **Type Safety** | Full TypeScript support with Zod schema validation |
| **Cloudflare Native** | Optimized for Cloudflare Workers (no dynamic imports) |
| **Multi-Tenant** | Tenant-specific plugin configurations supported |

### 1.3 Constraints

- **No Dynamic Imports**: Cloudflare Workers don't support dynamic `import()`
- **Code Bundling**: All plugins must be statically bundled at deploy time
- **Configuration Only**: Only configuration changes are dynamic (via KV)

---

## 2. Architecture

### 2.1 Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Application Layer                       │
│           (op-auth, op-token, op-management, vc, ...)        │
└──────────────────────────┬──────────────────────────────────┘
                           │ Uses PluginContext
┌──────────────────────────▼──────────────────────────────────┐
│                       Plugin Layer                           │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐ │
│  │  Notifier   │ │    IdP      │ │    Authenticator        │ │
│  │ email, sms  │ │ google,saml │ │    passkey, otp         │ │
│  └─────────────┘ └─────────────┘ └─────────────────────────┘ │
│                                                              │
│  Characteristics: Dynamic enable/disable, per-tenant config  │
└──────────────────────────┬──────────────────────────────────┘
                           │ Accesses via PluginContext
┌──────────────────────────▼──────────────────────────────────┐
│                   Infrastructure Layer                       │
│  ┌──────────────────────────┐ ┌────────────────────────────┐ │
│  │        Storage           │ │      Policy Engine         │ │
│  │  (KV, D1, DO, R2)        │ │  (builtin ReBAC, OpenFGA)  │ │
│  └──────────────────────────┘ └────────────────────────────┘ │
│                                                              │
│  Characteristics: Deploy-time selection, shared across all   │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Layer Comparison

| Aspect | Infrastructure Layer | Plugin Layer |
|--------|---------------------|--------------|
| **Dependencies** | All components depend on it | Independent operation |
| **Switching** | Deploy-time (restart required) | Dynamic (KV config) |
| **Failure Impact** | Full system outage | Only affected feature |
| **Regulatory** | GDPR, data localization | Generally unaffected |
| **Tenant Variance** | Usually shared | Can differ per tenant |

### 2.3 Package Structure

```
packages/ar-lib-plugin/
├── src/
│   ├── core/                    # Plugin Foundation
│   │   ├── types.ts             # AuthrimPlugin, PluginCapability
│   │   ├── registry.ts          # CapabilityRegistry
│   │   ├── loader.ts            # PluginLoader
│   │   ├── context.ts           # PluginContext implementation
│   │   ├── schema.ts            # Zod → JSON Schema conversion
│   │   └── index.ts
│   │
│   ├── infra/                   # Infrastructure Layer
│   │   ├── types.ts             # IStorageInfra, IPolicyInfra
│   │   ├── storage/
│   │   │   ├── cloudflare/      # Cloudflare implementation
│   │   │   ├── factory.ts       # createStorageInfra()
│   │   │   └── index.ts
│   │   ├── policy/
│   │   │   ├── builtin/         # Built-in ReBAC engine
│   │   │   ├── factory.ts       # createPolicyInfra()
│   │   │   └── index.ts
│   │   └── index.ts
│   │
│   ├── builtin/                 # Official Plugins
│   │   ├── notifier/
│   │   │   ├── console.ts       # Development logger
│   │   │   ├── resend.ts        # Resend Email
│   │   │   └── index.ts
│   │   └── index.ts
│   │
│   └── index.ts                 # Public API
│
├── docs/                        # Documentation
└── package.json
```

---

## 3. Core Interfaces

### 3.1 AuthrimPlugin Interface

The base interface that all plugins must implement:

```typescript
interface AuthrimPlugin<TConfig = unknown> {
  /** Unique plugin ID (e.g., 'notifier-resend') */
  readonly id: string;

  /** Semantic version (e.g., '1.0.0') */
  readonly version: string;

  /** Capabilities this plugin provides */
  readonly capabilities: PluginCapability[];

  /** Whether this is an official Authrim plugin */
  readonly official?: boolean;

  /** Zod schema for configuration validation */
  readonly configSchema: z.ZodType<TConfig, z.ZodTypeDef, unknown>;

  /** UI metadata for Admin dashboard */
  readonly meta?: PluginMeta;

  /**
   * Register capabilities with the registry
   * Called after initialize() completes successfully
   * Must be synchronous with no side effects
   */
  register(registry: CapabilityRegistry, config: TConfig): void;

  /**
   * Initialize the plugin (optional)
   * Called before register() for:
   * - External service connection/warmup
   * - Dependency validation
   * - Configuration verification
   */
  initialize?(ctx: PluginContext, config: TConfig): Promise<void>;

  /** Cleanup on unload (optional) */
  shutdown?(): Promise<void>;

  /** Health check for monitoring (optional) */
  healthCheck?(ctx?: PluginContext, config?: TConfig): Promise<HealthStatus>;
}
```

### 3.2 PluginContext Interface

Provides plugins with access to infrastructure and services:

```typescript
interface PluginContext {
  /** Storage infrastructure (users, sessions, etc.) */
  readonly storage: IStorageInfra;

  /** Policy/authorization infrastructure */
  readonly policy: IPolicyInfra;

  /** Plugin configuration store */
  readonly config: PluginConfigStore;

  /** Structured logger */
  readonly logger: Logger;

  /** Audit event logger */
  readonly audit: AuditLogger;

  /** Current tenant ID */
  readonly tenantId: string;

  /** Environment bindings (KV, D1, DO) */
  readonly env: Env;
}
```

### 3.3 PluginCapability Type

Format: `{category}.{name}`

```typescript
type PluginCapability =
  | `notifier.${string}`      // notifier.email, notifier.sms, notifier.push
  | `idp.${string}`           // idp.google, idp.saml, idp.oidc
  | `authenticator.${string}` // authenticator.passkey, authenticator.otp
  | `flow.${string}`;         // flow.otp-send (future: Flow UI nodes)
```

### 3.4 PluginMeta Interface

UI display metadata:

```typescript
interface PluginMeta {
  name: string;              // Display name
  description: string;       // Description
  icon?: string;             // Icon identifier
  category: PluginCategory;  // 'notification' | 'identity' | 'authentication' | 'flow'
  documentationUrl?: string; // Link to docs
}
```

---

## 4. Infrastructure Layer

### 4.1 IStorageInfra Interface

Unified storage abstraction supporting multiple cloud providers:

```typescript
interface IStorageInfra {
  readonly provider: 'cloudflare' | 'aws' | 'gcp' | 'azure' | 'custom';

  // Core adapter
  readonly adapter: IStorageAdapter;

  // Entity stores
  readonly user: IUserStore;
  readonly client: IClientStore;
  readonly session: ISessionStore;
  readonly passkey: IPasskeyStore;

  // RBAC stores
  readonly organization: IOrganizationStore;
  readonly role: IRoleStore;
  readonly roleAssignment: IRoleAssignmentStore;
  readonly relationship: IRelationshipStore;

  // Lifecycle
  initialize(env: Env): Promise<void>;
  healthCheck(): Promise<InfraHealthStatus>;
}
```

### 4.2 Store Interfaces

Each store provides CRUD operations:

```typescript
// Example: IUserStore
interface IUserStore {
  get(userId: string): Promise<User | null>;
  getByEmail(email: string): Promise<User | null>;
  create(user: Omit<User, 'id' | 'created_at' | 'updated_at'>): Promise<User>;
  update(userId: string, updates: Partial<User>): Promise<User | null>;
  delete(userId: string): Promise<boolean>;
  list(options?: ListOptions): Promise<User[]>;
}
```

### 4.3 IPolicyInfra Interface

Zanzibar-style ReBAC (Relationship-Based Access Control):

```typescript
interface IPolicyInfra {
  readonly provider: 'builtin' | 'openfga' | 'opa' | 'custom';

  // Authorization checks
  check(request: CheckRequest): Promise<CheckResponse>;
  batchCheck(request: BatchCheckRequest): Promise<BatchCheckResponse>;

  // Relationship queries
  listObjects(request: ListObjectsRequest): Promise<ListObjectsResponse>;
  listUsers(request: ListUsersRequest): Promise<ListUsersResponse>;

  // Rule evaluation (JIT provisioning)
  evaluateRules(context: RuleEvaluationContext): Promise<RuleEvaluationResult>;

  // Lifecycle
  initialize(env: Env, storage: IStorageInfra): Promise<void>;
  invalidateCache(request: CacheInvalidationRequest): Promise<void>;
}
```

### 4.4 Check Request/Response

```typescript
interface CheckRequest {
  subject: string;    // e.g., "user:123"
  relation: string;   // e.g., "viewer"
  object: string;     // e.g., "document:456"
  context?: Record<string, unknown>;
}

interface CheckResponse {
  allowed: boolean;
  resolution_method: 'direct' | 'inherited' | 'rule';
  cached: boolean;
  resolution_path?: string[];
}
```

---

## 5. Plugin Layer

### 5.1 CapabilityRegistry

Central registry for plugin capabilities:

```typescript
class CapabilityRegistry {
  // Registration
  registerNotifier(channel: string, handler: NotifierHandler): void;
  registerIdP(providerId: string, handler: IdPHandler): void;
  registerAuthenticator(type: string, handler: AuthenticatorHandler): void;

  // Retrieval
  getNotifier(channel: string): NotifierHandler | undefined;
  getIdP(providerId: string): IdPHandler | undefined;
  getAuthenticator(type: string): AuthenticatorHandler | undefined;

  // Discovery
  listCapabilities(): PluginCapability[];
}
```

### 5.2 NotifierHandler Interface

```typescript
interface NotifierHandler {
  send(notification: Notification): Promise<SendResult>;
  supports?(options: NotificationOptions): boolean;
}

interface Notification {
  channel: string;           // 'email', 'sms', 'push'
  to: string;                // Recipient
  from?: string;             // Sender (optional)
  subject?: string;          // For email
  body: string;              // Content
  replyTo?: string;          // For email
  cc?: string[];             // For email
  bcc?: string[];            // For email
  templateId?: string;       // Template ID
  templateVars?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface SendResult {
  success: boolean;
  messageId?: string;        // Provider message ID
  error?: string;            // Error message
  errorCode?: string;        // Provider error code
  retryable?: boolean;       // Can retry?
  providerResponse?: unknown;
}
```

### 5.3 IdPHandler Interface

```typescript
interface IdPHandler {
  getAuthorizationUrl(params: IdPAuthParams): Promise<string>;
  exchangeCode(params: IdPExchangeParams): Promise<IdPTokenResult>;
  getUserInfo(accessToken: string): Promise<IdPUserInfo>;
  validateIdToken?(idToken: string): Promise<IdPClaims>;
}
```

### 5.4 AuthenticatorHandler Interface

```typescript
interface AuthenticatorHandler {
  createChallenge(params: AuthChallengeParams): Promise<AuthChallengeResult>;
  verifyResponse(params: AuthVerifyParams): Promise<AuthVerifyResult>;
  supports?(options: AuthOptions): boolean;
}
```

### 5.5 PluginLoader

Manages plugin lifecycle:

```typescript
class PluginLoader {
  constructor(registry: CapabilityRegistry, options?: PluginLoaderOptions);

  /**
   * Load and initialize a plugin
   * Order: 1. initialize() → 2. register()
   */
  async loadPlugin<T>(
    plugin: AuthrimPlugin<T>,
    ctx: PluginContext,
    config: T
  ): Promise<PluginLoadResult>;

  /** Get plugin status */
  getStatus(pluginId: string): PluginStatus | undefined;

  /** List all loaded plugins */
  listPlugins(): PluginStatus[];

  /** Unload a plugin */
  async unloadPlugin(pluginId: string): Promise<void>;

  /** Health check all plugins */
  async healthCheck(): Promise<Map<string, HealthStatus>>;
}
```

---

## 6. Capability System

### 6.1 Capability Categories

| Category | Prefix | Examples |
|----------|--------|----------|
| Notification | `notifier.` | `notifier.email`, `notifier.sms`, `notifier.push` |
| Identity Provider | `idp.` | `idp.google`, `idp.saml`, `idp.oidc` |
| Authenticator | `authenticator.` | `authenticator.passkey`, `authenticator.otp` |
| Flow Node | `flow.` | `flow.otp-send`, `flow.email-verify` |

### 6.2 Registration Rules

1. **Uniqueness**: Same capability channel can only have one handler
2. **First-wins**: First registration takes precedence
3. **Error on conflict**: Attempting to re-register throws an error

```typescript
// Example: This will throw
registry.registerNotifier('email', handler1);
registry.registerNotifier('email', handler2); // Error!
```

### 6.3 Resolution Priority

When multiple plugins could handle a request:

1. Tenant-specific configuration takes precedence
2. Global configuration as fallback
3. Default handler (if defined)

---

## 7. Configuration Management

### 7.1 Configuration Priority

```
┌─────────────────────────────────────────┐
│ 1. In-Memory Cache (60s TTL)           │ ← Fastest
├─────────────────────────────────────────┤
│ 2. KV Storage (per-tenant override)    │
├─────────────────────────────────────────┤
│ 3. KV Storage (global config)          │
├─────────────────────────────────────────┤
│ 4. Environment Variables               │
├─────────────────────────────────────────┤
│ 5. Zod Schema Default Values           │ ← Fallback
└─────────────────────────────────────────┘
```

### 7.2 KV Key Structure

```
plugins:registry                           # Registered plugins list
plugins:config:{pluginId}                  # Global configuration
plugins:config:{pluginId}:tenant:{tenantId} # Tenant override
plugins:enabled:{pluginId}                 # Global enable/disable
plugins:enabled:{pluginId}:tenant:{tenantId} # Tenant enable/disable
```

### 7.3 Environment Variable Convention

```
PLUGIN_{PLUGIN_ID}_CONFIG={"apiKey":"...","defaultFrom":"..."}

# Example for notifier-resend:
PLUGIN_NOTIFIER_RESEND_CONFIG={"apiKey":"re_xxx","defaultFrom":"noreply@example.com"}
```

### 7.4 PluginConfigStore Interface

```typescript
interface PluginConfigStore {
  /** Get global configuration */
  get<T>(pluginId: string, schema: z.ZodSchema<T>): Promise<T>;

  /** Get tenant-specific configuration (merges with global) */
  getForTenant<T>(
    pluginId: string,
    tenantId: string,
    schema: z.ZodSchema<T>
  ): Promise<T>;

  /** Update configuration (Admin API) */
  set<T>(pluginId: string, config: T): Promise<void>;
}
```

---

## 8. Security Considerations

### 8.1 Security Model

| Risk | Mitigation |
|------|------------|
| API Key Exposure | Store in KV with encryption, Admin API auth required |
| Config Tampering | Admin RBAC (`system_admin` role required) |
| SSRF | Apply existing `validateUrl()` pattern |
| Timeout Attacks | All external requests have configurable timeouts |
| Error Information Leak | Apply existing error masking pattern |

### 8.2 Secure Defaults

All plugins should use these secure defaults:

```typescript
const SECURITY_DEFAULTS = {
  // External API calls
  defaultTimeoutMs: 10000,
  maxRetries: 3,

  // Rate limiting
  maxRequestsPerMinute: 60,

  // Payload limits
  maxPayloadBytes: 1024 * 1024, // 1MB

  // Network security
  allowLocalhost: false, // Always false in production
};
```

### 8.3 Audit Logging

All plugin operations are logged:

```typescript
interface PluginAuditEvent {
  event_type: 'plugin.enabled' | 'plugin.disabled' | 'plugin.config_updated';
  plugin_id: string;
  actor_id: string;
  actor_type: 'admin' | 'system';
  tenant_id: string;
  timestamp: number;
  changes?: {
    before: unknown;
    after: unknown;
  };
}
```

### 8.4 Sensitive Field Handling

Configuration schemas should mark sensitive fields:

```typescript
const configSchema = z.object({
  apiKey: z.string().min(1).describe('API key for authentication'),
  // Sensitive fields should not be logged or returned in full
});
```

---

## 9. API Reference

### 9.1 Factory Functions

#### createStorageInfra

```typescript
async function createStorageInfra(
  env: InfraEnv,
  options?: StorageInfraOptions
): Promise<IStorageInfra>;

interface StorageInfraOptions {
  provider?: StorageProvider; // Default: from env.STORAGE_PROVIDER or 'cloudflare'
}
```

#### createPolicyInfra

```typescript
async function createPolicyInfra(
  env: InfraEnv,
  storage: IStorageInfra,
  options?: PolicyInfraOptions
): Promise<IPolicyInfra>;

interface PolicyInfraOptions {
  provider?: PolicyProvider; // Default: from env.POLICY_PROVIDER or 'builtin'
}
```

#### createPluginContext

```typescript
async function createPluginContext(
  env: InfraEnv & Env,
  options: CreatePluginContextOptions
): Promise<PluginContext>;

interface CreatePluginContextOptions {
  tenantId: string;
  logger?: Logger;
  auditLogger?: AuditLogger;
  enableAudit?: boolean; // Default: true
}
```

#### createPluginLoader

```typescript
function createPluginLoader(
  registry?: CapabilityRegistry,
  options?: PluginLoaderOptions
): PluginLoader;

interface PluginLoaderOptions {
  logger?: Logger;
}
```

### 9.2 Schema Utilities

#### zodToJSONSchema

```typescript
function zodToJSONSchema(
  schema: z.ZodSchema,
  options?: SchemaConversionOptions
): JSONSchema7;
```

#### extractPluginSchema

```typescript
function extractPluginSchema(plugin: AuthrimPlugin): PluginSchemaInfo;

interface PluginSchemaInfo {
  pluginId: string;
  version: string;
  configSchema: JSONSchema7;
  meta?: PluginMeta;
}
```

#### validatePluginConfig

```typescript
function validatePluginConfig<T>(
  config: unknown,
  schema: z.ZodSchema<T>
): ValidationResult<T>;

interface ValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: ValidationError[];
}
```

### 9.3 Global Instances

```typescript
// Global capability registry
export const globalRegistry: CapabilityRegistry;

// Global schema registry (for Admin UI)
export const globalSchemaRegistry: PluginSchemaRegistry;
```

---

## Appendix A: FlowNode Extension Point (Future)

Reserved for future Flow x UI separation architecture:

```typescript
interface FlowNodeDefinition {
  type: string;           // e.g., 'notifier-resend:send'
  label: string;          // UI label
  icon?: string;          // Icon ID
  inputs: FlowPortDefinition[];
  outputs: FlowPortDefinition[];
  configSchema?: z.ZodSchema;
  category: 'authentication' | 'notification' | 'condition' | 'action';
}

interface FlowPortDefinition {
  id: string;
  label: string;
  type: 'trigger' | 'data' | 'boolean';
}
```

---

## Appendix B: Supported Providers

### Storage Providers

| Provider | Status | Notes |
|----------|--------|-------|
| `cloudflare` | ✅ Implemented | KV, D1, Durable Objects |
| `aws` | 🔜 Planned | DynamoDB, Aurora Serverless |
| `gcp` | 🔜 Planned | Firestore, Cloud SQL |
| `azure` | 🔜 Planned | Cosmos DB, Azure SQL |
| `custom` | ✅ Available | Manual instantiation |

### Policy Providers

| Provider | Status | Notes |
|----------|--------|-------|
| `builtin` | ✅ Implemented | Zanzibar-style ReBAC |
| `openfga` | 🔜 Planned | OpenFGA integration |
| `opa` | 🔜 Planned | Open Policy Agent |
| `custom` | ✅ Available | Manual instantiation |

---

## Appendix C: Migration from ar-lib-core

For applications currently using `ar-lib-core`:

```typescript
// Before (ar-lib-core)
import { CloudflareStorageAdapter, UserStore } from '@authrim/ar-lib-core';

const adapter = new CloudflareStorageAdapter(env);
const userStore = new UserStore(adapter);

// After (ar-lib-plugin)
import { createPluginContext } from '@authrim/ar-lib-plugin';

const ctx = await createPluginContext(env, { tenantId: 'default' });
const user = await ctx.storage.user.get(userId);
```

The old exports remain available but are deprecated:

```typescript
// Deprecated - will be removed in v2.0
import { CloudflareStorageAdapter } from '@authrim/ar-lib-core';
// ⚠️ Deprecation warning will be logged
```
