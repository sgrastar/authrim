# PII/Non-PII 分離アーキテクチャ設計書

## 目次

1. [背景と動機](#1-背景と動機)
2. [現状分析](#2-現状分析)
3. [設計原則](#3-設計原則)
4. [アーキテクチャ全体像](#4-アーキテクチャ全体像)
5. [レイヤー設計](#5-レイヤー設計)
6. [改良ポイント詳細](#6-改良ポイント詳細)
7. [実装計画](#7-実装計画)
8. [将来の拡張性](#8-将来の拡張性)

---

## 1. 背景と動機

### 1.1 発端: WebAuthn user_handle の PII 検証

WebAuthn 仕様では `user_handle`（authenticator に保存されるユーザー識別子）は「任意のバイト列」として許可されている。もしここに以下を入れた場合、PII（個人識別情報）となり、GDPR 等の規制対象となる：

- email アドレス
- 内部 ID（`user12345` など推測可能な形式）

**現在の Authrim 実装の検証結果:**

```typescript
// packages/op-auth/src/passkey.ts:179
userID: encoder.encode(user.id as string)  // user.id は UUID

// packages/op-auth/src/passkey.ts:129
const newUserId = crypto.randomUUID();  // UUID v4 で生成
```

**結論**: `user_handle` には `crypto.randomUUID()` で生成された UUID が使用されており、**PII は含まれていない**。これは正しい実装である。

### 1.2 より広い課題: PII の散在

WebAuthn の検証を契機に、システム全体での PII 分布を調査した結果、以下の課題が明らかになった：

1. **データベース**: PII を含むテーブルと含まないテーブルが同一 D1 インスタンスに混在
2. **キャッシュ**: `USER_CACHE` KV に完全なユーザープロファイル（PII）が保存されている
3. **地域要件**: GDPR（EU）、APPI（日本）等の規制により、PII は特定地域内に保存する必要がある
4. **分離の欠如**: アプリケーションコードから PII への直接アクセスを制限する仕組みがない

### 1.3 設計目標

1. **PII と Non-PII の物理的分離**: 異なるデータベース/ストレージに配置
2. **地域対応**: PII を各地域のデータベースに保存可能にする
3. **抽象化**: データベースバックエンドを交換可能にする（D1, Postgres, DynamoDB 等）
4. **型安全性**: TypeScript の型システムで PII アクセスを制御
5. **Auth0/Okta を超える**: ReBAC 内蔵 + PII 分離という差別化

---

## 2. 現状分析

### 2.1 トークンの PII 分析

#### Access Token

```typescript
// packages/op-token/src/token.ts:862-885
const accessTokenClaims = {
  iss: c.env.ISSUER_URL,        // ✅ 非PII
  sub: authCodeData.sub,         // ✅ UUID（非PII）
  aud: c.env.ISSUER_URL,        // ✅ 非PII
  scope: authCodeData.scope,     // ✅ 非PII
  client_id: client_id,          // ✅ 非PII
  // RBAC Claims
  authrim_roles: [...],          // ✅ 非PII
  authrim_org_id: "...",         // ✅ UUID（非PII）
  authrim_org_type: "...",       // ✅ 非PII
};
```

**結論**: Access Token に PII は含まれない。`sub` は UUID、email/name 等は UserInfo エンドポイント経由でのみ取得。

#### ID Token

```typescript
// packages/op-token/src/token.ts:938-949
const idTokenClaims = {
  iss, sub, aud, nonce, at_hash, auth_time, sid,  // ✅ すべて非PII
  // RBAC Claims（環境変数で制御可能）
  authrim_roles, authrim_user_type, authrim_org_id,  // ✅ 非PII
  authrim_org_name,  // ⚠️ 準PII（企業名）- デフォルトでは含まれない
  authrim_orgs,      // ⚠️ 準PII（組織名を含む）- デフォルトでは含まれない
};
```

**結論**: ID Token も基本的に PII を含まない。`org_name` は環境変数 `RBAC_ID_TOKEN_CLAIMS` で制御可能（デフォルト: 含まれない）。

#### Refresh Token

```typescript
// packages/op-token/src/token.ts:1057-1063
const refreshTokenClaims = {
  iss, sub, aud, scope, client_id  // ✅ すべて非PII
};
```

**結論**: Refresh Token に PII は含まれない。

### 2.2 データベーステーブルの PII 分類

#### PII を含むテーブル（分離が必要）

| テーブル名 | PII フィールド | リスクレベル |
|-----------|---------------|-------------|
| `users` | email, name, given_name, family_name, middle_name, nickname, preferred_username, phone_number, address_json, birthdate, gender, picture, profile, website, password_hash | **Critical** |
| `user_custom_fields` | field_value（任意の PII が入る可能性） | **High** |
| `subject_identifiers` | identifier_value（email, phone, DID 等） | **High** |
| `verified_attributes` | attribute_value（医療ライセンス番号等） | **High** |
| `linked_identities` | provider_email, raw_claims, profile_data | **High** |
| `audit_log` | ip_address, user_agent | **Medium** |

#### Non-PII テーブル（分離不要）

| カテゴリ | テーブル名 | 説明 |
|---------|-----------|------|
| **認証インフラ** | passkeys | 公開鍵、credential_id（UUID 参照） |
| | sessions | セッション ID（UUID 参照） |
| | password_reset_tokens | トークンハッシュのみ |
| | user_token_families | JTI、UUID 参照 |
| | external_idp_auth_states | OAuth state、PKCE verifier |
| **認可・RBAC** | roles | ロール定義 |
| | user_roles | UUID 参照のみ |
| | role_assignments | UUID 参照のみ |
| | organizations | 組織名（※準 PII、要検討） |
| | subject_org_membership | UUID 参照のみ |
| | relationships | ReBAC 関係（UUID 参照） |
| | relation_definitions | 関係定義 |
| | relationship_closure | 推移的閉包 |
| **設定・マスタ** | oauth_clients | クライアント設定 |
| | oauth_client_consents | UUID 参照のみ |
| | upstream_providers | IdP 設定 |
| | scope_mappings | スコープ定義 |
| | branding_settings | UI 設定 |
| | identity_providers | IdP 設定 |
| | refresh_token_shard_configs | シャーディング設定 |

### 2.3 KV キャッシュの PII 分類

| KV Namespace | PII | 分離対象 |
|--------------|-----|---------|
| **USER_CACHE** | ✅ フルプロファイル（email, name, phone 等） | 🔴 要分離 |
| CONSENT_CACHE | ❌ scope, granted_at のみ | ✅ 分離不要 |
| STATE_STORE | ❌ state → client_id | ✅ 分離不要 |
| NONCE_STORE | ❌ nonce → client_id | ✅ 分離不要 |
| CLIENTS_CACHE | ❌ クライアント設定 | ✅ 分離不要 |
| REBAC_CACHE | ❌ ロール、権限 | ✅ 分離不要 |

---

## 3. 設計原則

### 3.1 三層 Repository パターン

Repository を以下の 3 層に分割する：

| 層 | 特性 | 用途 |
|---|------|------|
| **CacheRepository** | 最速・揮発性・安い | UserInfo 高速化、RBAC クレームキャッシュ |
| **CoreRepository** | 耐久性・整合性・グローバル | 認証・認可の真実のソース |
| **PIIRepository** | 地域縛り・GDPR 対応・暗号化 | 個人情報のみ |

**設計思想**:
- キャッシュ層は「最速・安い・揮発性」— 消えても再構築可能
- Core 層は「耐久性・一意性・整合性」— 認証の根幹
- PII 層は「地域縛り・復旧可能性」— 法的要件に対応

### 3.2 Application Layer からの PII 直接アクセス禁止

各エンドポイントがアクセスできる Repository を明確に制限する：

| エンドポイント | Core | Cache | PII |
|---------------|------|-------|-----|
| `/authorize` | ✅ | ✅ | ❌ |
| `/token` | ✅ | ✅ | ❌ |
| `/userinfo` | ✅ | ✅ | ✅ |
| `/signup` | ✅ | ❌ | ✅ |
| `/admin/users` | ✅ | ✅ | ✅ |

**設計思想**: 認証・認可フロー（`/authorize`, `/token`）は PII を必要としない。PII が必要なのは `/userinfo` やユーザー管理 API のみ。このルールを TypeScript の型レベルで強制する。

### 3.3 Database Adapter による抽象化

将来の移植性を確保するため、データベースアクセスを抽象化する：

| Cloudflare | AWS 相当 |
|------------|---------|
| D1 | Aurora Serverless / DynamoDB |
| Durable Objects | DynamoDB + Item Locking |
| KV | ElastiCache / DynamoDB |
| Workers | Lambda@Edge |

**設計思想**: Authrim は「Auth0 を超える」ことを目指す。インフラに依存しない設計により、Cloudflare でも AWS でも動作可能にする。

### 3.4 ReBAC と Durable Objects の相性

ReBAC（Relationship-Based Access Control）は Durable Objects と非常に相性が良い：

- **単一スレッド整合性モデル**: DO の特性が「graph consistency」と一致
- **高速 append-only**: 関係の追加が高速
- **shard by tenant_id or group_id**: テナント単位でのシャーディングが容易
- **ReBAC evaluation は KV/D1 だけで瞬時にできる**

**差別化ポイント**: Auth0 や Okta には ReBAC が内蔵されておらず、外部サービス（OpenFGA 等）が必要。Authrim は ReBAC を内蔵することで差別化を図る。

---

## 4. アーキテクチャ全体像

```
┌───────────────────────────────────────────────────────────────┐
│                      Application Layer                         │
│               (Hono handlers, services, flows)                 │
│                                                                 │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐              │
│  │ /authorize  │ │ /token      │ │ /userinfo   │              │
│  │ Core+Cache  │ │ Core+Cache  │ │ Core+Cache  │              │
│  │ only        │ │ only        │ │ +PII        │              │
│  └─────────────┘ └─────────────┘ └─────────────┘              │
└───────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────┐
│                       Repository Layer                         │
│                                                                 │
│  ┌──────────────────┐ ┌──────────────────┐ ┌────────────────┐ │
│  │  CoreRepository  │ │  PIIRepository   │ │ CacheRepository│ │
│  │                  │ │                  │ │                │ │
│  │ • UserCore       │ │ • UserProfile    │ │ • UserCache    │ │
│  │ • Passkey        │ │ • Identifiers    │ │ • ConsentCache │ │
│  │ • Session        │ │ • LinkedIdentity │ │ • RBACCache    │ │
│  │ • Role           │ │ • AuditLog(PII)  │ │ • ClientCache  │ │
│  │ • Relationship   │ │                  │ │                │ │
│  │ • OAuthClient    │ │                  │ │                │ │
│  │ • Organization   │ │                  │ │                │ │
│  └──────────────────┘ └──────────────────┘ └────────────────┘ │
└───────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────┐
│                   Database Adapter Layer                       │
│                                                                 │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐  │
│  │ D1Adapter  │ │ DOAdapter  │ │ KVAdapter  │ │ PGAdapter  │  │
│  │            │ │            │ │            │ │ (Regional) │  │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘  │
│                                                                 │
│  Future: DynamoDBAdapter, AuroraAdapter, ElastiCacheAdapter   │
└───────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ Global Non-PII  │ │  Global Cache   │ │  Regional PII   │
│     (D1/DO)     │ │     (KV/DO)     │ │   (Postgres)    │
│                 │ │                 │ │                 │
│ • users_core    │ │ • USER_CACHE    │ │ EU: users_pii   │
│ • passkeys      │ │ • REBAC_CACHE   │ │ JP: users_pii   │
│ • sessions      │ │ • CONSENT_CACHE │ │ US: users_pii   │
│ • roles         │ │ • CLIENTS_CACHE │ │                 │
│ • relationships │ │ • STATE_STORE   │ │ • identifiers   │
│ • oauth_clients │ │                 │ │ • linked_ids    │
│ • organizations │ │                 │ │ • audit_log_pii │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

---

## 5. レイヤー設計

### 5.1 Database Adapter Layer

#### Interface 定義

```typescript
// packages/shared/src/db/adapter.ts

export interface DatabaseAdapter {
  // Query execution
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>;

  // Transaction support
  transaction<T>(fn: (tx: TransactionAdapter) => Promise<T>): Promise<T>;

  // Batch operations
  batch(statements: PreparedStatement[]): Promise<void>;
}

export interface TransactionAdapter extends DatabaseAdapter {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
```

#### D1 Adapter

```typescript
// packages/shared/src/db/adapters/d1-adapter.ts

export class D1Adapter implements DatabaseAdapter {
  constructor(private db: D1Database) {}

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    if (params) stmt.bind(...params);
    const result = await stmt.all<T>();
    return result.results;
  }

  async queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    const stmt = this.db.prepare(sql);
    if (params) stmt.bind(...params);
    return await stmt.first<T>();
  }

  // ... other methods
}
```

#### Postgres Adapter（Regional PII 用）

```typescript
// packages/shared/src/db/adapters/postgres-adapter.ts

import { Pool } from 'pg'; // or @neondatabase/serverless

export class PostgresAdapter implements DatabaseAdapter {
  constructor(private pool: Pool) {}

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    // Note: Postgres uses $1, $2 placeholders instead of ?
    const result = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  // ... other methods
}
```

### 5.2 Repository Layer

#### CoreRepository

```typescript
// packages/shared/src/repositories/core/index.ts

export class CoreRepository {
  constructor(private db: DatabaseAdapter) {}

  // User Core (Non-PII)
  async getUserCore(userId: string): Promise<UserCore | null>;
  async createUserCore(data: CreateUserCoreInput): Promise<UserCore>;
  async updateUserCore(userId: string, data: UpdateUserCoreInput): Promise<void>;

  // Passkeys
  async getPasskeysByUserId(userId: string): Promise<Passkey[]>;
  async createPasskey(data: CreatePasskeyInput): Promise<Passkey>;

  // Sessions
  async getSession(sessionId: string): Promise<Session | null>;
  async createSession(data: CreateSessionInput): Promise<Session>;

  // Roles & Permissions
  async getUserRoles(userId: string): Promise<Role[]>;
  async assignRole(userId: string, roleId: string): Promise<void>;

  // Relationships (ReBAC)
  async getRelationships(subjectId: string): Promise<Relationship[]>;
  async createRelationship(data: CreateRelationshipInput): Promise<void>;

  // OAuth Clients
  async getClient(clientId: string): Promise<OAuthClient | null>;

  // Organizations
  async getOrganization(orgId: string): Promise<Organization | null>;
  async getUserOrganizations(userId: string): Promise<Organization[]>;
}
```

#### PIIRepository

```typescript
// packages/shared/src/repositories/pii/index.ts

export class PIIRepository {
  constructor(
    private db: DatabaseAdapter,
    private encryption: EncryptionService  // Field-level encryption
  ) {}

  // User Profile (PII)
  async getUserProfile(userId: string): Promise<UserProfile | null>;
  async createUserProfile(data: CreateUserProfileInput): Promise<UserProfile>;
  async updateUserProfile(userId: string, data: UpdateUserProfileInput): Promise<void>;
  async deleteUserProfile(userId: string): Promise<void>;  // GDPR deletion
  async anonymizeUserProfile(userId: string): Promise<void>;  // GDPR anonymization

  // Identifiers
  async getIdentifiersByUserId(userId: string): Promise<Identifier[]>;
  async findUserByEmail(email: string): Promise<string | null>;  // Returns userId via blind index

  // Linked Identities
  async getLinkedIdentities(userId: string): Promise<LinkedIdentity[]>;

  // Audit Log (PII portion)
  async createAuditLogPII(auditId: string, data: AuditLogPIIInput): Promise<void>;
}
```

#### CacheRepository

```typescript
// packages/shared/src/repositories/cache/index.ts

export class CacheRepository {
  constructor(
    private userCache: KVNamespace,
    private consentCache: KVNamespace,
    private rbacCache: KVNamespace,
    private clientsCache: KVNamespace
  ) {}

  // User Cache
  async getCachedUser(userId: string): Promise<CachedUser | null>;
  async setCachedUser(userId: string, user: CachedUser, ttl?: number): Promise<void>;
  async invalidateUser(userId: string): Promise<void>;

  // Consent Cache
  async getCachedConsent(userId: string, clientId: string): Promise<CachedConsent | null>;
  async setCachedConsent(userId: string, clientId: string, consent: CachedConsent): Promise<void>;
  async invalidateConsent(userId: string, clientId?: string): Promise<void>;

  // RBAC Cache
  async getCachedRBAC(userId: string): Promise<CompositeRBACCache | null>;
  async setCachedRBAC(userId: string, rbac: CompositeRBACCache, ttl?: number): Promise<void>;
  async invalidateRBAC(userId: string): Promise<void>;

  // Client Cache
  async getCachedClient(clientId: string): Promise<OAuthClient | null>;
  async setCachedClient(clientId: string, client: OAuthClient): Promise<void>;
  async invalidateClient(clientId: string): Promise<void>;
}
```

### 5.3 Service Layer

```typescript
// packages/shared/src/services/user.service.ts

export class UserService {
  constructor(
    private core: CoreRepository,
    private pii: PIIRepository,
    private cache: CacheRepository
  ) {}

  async getUser(userId: string): Promise<User | null> {
    // 1. Try cache first
    const cached = await this.cache.getCachedUser(userId);
    if (cached) return this.toCachedUser(cached);

    // 2. Fetch from both DBs in parallel
    const [core, profile] = await Promise.all([
      this.core.getUserCore(userId),
      this.pii.getUserProfile(userId),
    ]);

    if (!core) return null;

    const user = { ...core, ...profile };

    // 3. Populate cache
    await this.cache.setCachedUser(userId, user);

    return user;
  }

  async createUser(input: CreateUserInput): Promise<User> {
    const userId = crypto.randomUUID();

    // Core DB first (if this fails, no PII is stored)
    await this.core.createUserCore({
      id: userId,
      pii_region: input.region || 'eu',
      email_verified: false,
      user_type: 'end_user',
    });

    // Then PII DB
    await this.pii.createUserProfile({
      id: userId,
      email: input.email,
      name: input.name,
    });

    return this.getUser(userId);
  }

  async deleteUser(userId: string): Promise<void> {
    // 1. Hard delete from PII
    await this.pii.deleteUserProfile(userId);

    // 2. Soft delete in Core
    await this.core.updateUserCore(userId, { is_deleted: true });

    // 3. Invalidate cache
    await this.cache.invalidateUser(userId);
  }
}
```

### 5.4 Region Router

```typescript
// packages/shared/src/db/region-router.ts

export type Region = 'eu' | 'us' | 'jp' | 'global';

export interface RegionConfig {
  eu: string;   // EU Postgres connection string
  us: string;   // US Postgres connection string
  jp: string;   // JP Postgres connection string
}

export class RegionRouter {
  private adapters: Map<Region, DatabaseAdapter> = new Map();

  constructor(private config: RegionConfig) {}

  async getPIIAdapter(userId: string, coreDb: DatabaseAdapter): Promise<DatabaseAdapter> {
    // Get user's region from Core DB
    const user = await coreDb.queryOne<{ pii_region: Region }>(
      'SELECT pii_region FROM users_core WHERE id = ?',
      [userId]
    );

    const region = user?.pii_region || 'eu';
    return this.getAdapter(region);
  }

  getAdapterForRegion(region: Region): DatabaseAdapter {
    return this.getAdapter(region);
  }

  private getAdapter(region: Region): DatabaseAdapter {
    if (!this.adapters.has(region)) {
      const connectionString = this.config[region];
      this.adapters.set(region, new PostgresAdapter(connectionString));
    }
    return this.adapters.get(region)!;
  }
}
```

### 5.5 Type-safe PII Access Control

```typescript
// packages/shared/src/context/types.ts

// PII にアクセスできない Context（/authorize, /token 用）
export interface AuthContext {
  core: CoreRepository;
  cache: CacheRepository;
  // pii プロパティなし → PII にアクセス不可能
}

// PII にアクセスできる Context（/userinfo, /admin/users 用）
export interface UserInfoContext extends AuthContext {
  pii: PIIRepository;
}

// Handler の型定義
export type AuthHandler = (c: HonoContext, ctx: AuthContext) => Promise<Response>;
export type UserInfoHandler = (c: HonoContext, ctx: UserInfoContext) => Promise<Response>;

// 使用例
// authorize.ts - AuthHandler なので ctx.pii にアクセスするとコンパイルエラー
export const authorizeHandler: AuthHandler = async (c, ctx) => {
  const user = await ctx.core.getUserCore(userId);  // ✅ OK
  // ctx.pii.getUserProfile(userId);  // ❌ コンパイルエラー: Property 'pii' does not exist
};

// userinfo.ts - UserInfoHandler なので ctx.pii にアクセス可能
export const userinfoHandler: UserInfoHandler = async (c, ctx) => {
  const [core, profile] = await Promise.all([
    ctx.core.getUserCore(userId),   // ✅ OK
    ctx.pii.getUserProfile(userId), // ✅ OK
  ]);
};
```

---

## 6. 改良ポイント詳細

### 6.1 PII 暗号化戦略（Field-level + TDE）

#### 概要

PII を保護するために、複数層の暗号化を実装する：

```
┌─────────────────────────────────────────────────┐
│              Encryption Strategy                │
├─────────────────────────────────────────────────┤
│ Layer 1: Database-level encryption (TDE)        │
│          → Postgres の透過的暗号化              │
│          → ディスク紛失/スナップショット流出対策│
│                                                 │
│ Layer 2: Field-level encryption (AES-256-GCM)  │
│          → email, phone, address を個別暗号化  │
│          → DBA や誤設定からの漏洩対策          │
│                                                 │
│ Layer 3: Key Management (KMS + DEK)            │
│          → Master Key は KMS (AWS/GCP)         │
│          → Per-tenant DEK (Data Encryption Key)│
│          → Workers 側の鍵は Cloudflare Secrets │
└─────────────────────────────────────────────────┘
```

#### Blind Index（検索可能暗号化）

email などの暗号化フィールドを検索可能にするため、Blind Index を実装する：

```typescript
// Blind Index の生成
function createBlindIndex(value: string, masterIndexKey: string): string {
  const normalized = value.toLowerCase().trim();
  return crypto.createHmac('sha256', masterIndexKey)
    .update(normalized)
    .digest('base64url');
}

// テーブル設計
// users_pii
//   id: TEXT PRIMARY KEY
//   email_encrypted: TEXT       -- AES-256-GCM で暗号化された email
//   email_blind_index: TEXT     -- HMAC(masterIndexKey, normalized_email)
//   ...
```

**制限事項**:
- 前方一致検索や部分一致検索は不可（やる場合は別の検索専用ストアが必要）
- 完全一致検索のみサポート

#### Key Management アーキテクチャ

```
┌─────────────────────────────────────────────────┐
│                 Key Hierarchy                   │
├─────────────────────────────────────────────────┤
│ KMS (AWS KMS / GCP KMS)                         │
│   └── Master Key (KEK: Key Encryption Key)     │
│         │                                       │
│         ├── Tenant A DEK (wrapped)             │
│         ├── Tenant B DEK (wrapped)             │
│         └── Tenant C DEK (wrapped)             │
│                                                 │
│ Cloudflare Secrets                              │
│   └── Index Key (for Blind Index HMAC)         │
│   └── Session Key (for Workers-side ops)       │
└─────────────────────────────────────────────────┘
```

**運用フロー**:
1. アプリケーション起動時に KMS から Tenant DEK を取得（wrapped）
2. KMS で DEK を unwrap してメモリに保持
3. PII の暗号化/復号に DEK を使用
4. DEK は定期的にローテーション（後述）

### 6.2 Audit Log 分離設計

#### 概要

Audit Log を Core（非 PII）と PII の二層構造に分離する：

```
┌─────────────────────────────────────────────────┐
│              Audit Log Strategy                 │
├─────────────────────────────────────────────────┤
│ audit_log_core (Global D1)                      │
│   • id                                          │
│   • action                                      │
│   • resource_type, resource_id                 │
│   • user_id (UUID only)                        │
│   • geo_country (country level only)           │
│   • timestamp                                   │
│   • metadata_json (non-PII only)               │
│                                                 │
│ audit_log_pii (Regional Postgres)              │
│   • audit_id (FK to core)                      │
│   • ip_address_encrypted                       │
│   • user_agent_hash (salted)                   │
│   • request_headers_encrypted (if needed)      │
└─────────────────────────────────────────────────┘
```

#### 設計思想

- **通常の監査・トラブルシュート**: `audit_log_core` だけで 8〜9 割の用途を満たす
- **法的要請・詳細調査時のみ**: PII 側を参照
- **プライバシー配慮**:
  - IP アドレスは暗号化
  - User-Agent は salt 付きハッシュ（追跡耐性向上）
  - Geo は country レベルのみ Core に持つ

#### スキーマ

```sql
-- Global D1: audit_log_core
CREATE TABLE audit_log_core (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT,  -- UUID only, no PII
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  geo_country TEXT,  -- Country code only (e.g., 'JP', 'US')
  metadata_json TEXT,  -- Non-PII metadata only
  created_at INTEGER NOT NULL
);

-- Regional Postgres: audit_log_pii
CREATE TABLE audit_log_pii (
  audit_id TEXT PRIMARY KEY REFERENCES audit_log_core(id),
  ip_address_encrypted TEXT,
  user_agent_hash TEXT,  -- Salted hash
  request_headers_encrypted TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

#### 保持期間（Retention）

コンプライアンス対応のため、保持期間を明確に定義する：

| 種類 | 保持期間 | 根拠 |
|------|---------|------|
| audit_log_core | 7 年 | 一般的な法的要件 |
| audit_log_pii | 1 年 | GDPR の最小化原則 |

### 6.3 Cache Invalidation 戦略

#### 概要

キャッシュ無効化の戦略として、Event-driven + Version の併用を採用する：

```
┌─────────────────────────────────────────────────┐
│          Cache Invalidation Strategy            │
├─────────────────────────────────────────────────┤
│ Option A: Event-driven（採用）                  │
│   PIIRepository.update() →                      │
│     → CacheRepository.invalidate(userId)        │
│                                                 │
│ Option C: Version（併用）                       │
│   Core DB に user_version カラム追加            │
│   Cache に version 埋め込み                     │
│   → version mismatch で自動 invalidate          │
└─────────────────────────────────────────────────┘
```

#### 実装

```typescript
// PIIRepository での更新時
class PIIRepository {
  async updateUserProfile(userId: string, data: UpdateUserProfileInput): Promise<void> {
    // 1. PII DB を更新
    await this.db.execute(
      'UPDATE users_pii SET name = $1, updated_at = NOW() WHERE id = $2',
      [data.name, userId]
    );

    // 2. Core DB の version をインクリメント
    await this.coreDb.execute(
      'UPDATE users_core SET user_version = user_version + 1, updated_at = ? WHERE id = ?',
      [Date.now(), userId]
    );

    // 3. Cache を無効化（Event-driven）
    await this.cache.invalidateUser(userId);
  }
}

// CacheRepository での読み取り時（Version チェック）
class CacheRepository {
  async getCachedUser(userId: string): Promise<CachedUser | null> {
    const cached = await this.userCache.get(`user:${userId}`);
    if (!cached) return null;

    const parsed = JSON.parse(cached) as CachedUser & { version: number };

    // Version チェック
    const currentVersion = await this.coreDb.queryOne<{ user_version: number }>(
      'SELECT user_version FROM users_core WHERE id = ?',
      [userId]
    );

    if (currentVersion && parsed.version !== currentVersion.user_version) {
      // Version mismatch → invalidate
      await this.invalidateUser(userId);
      return null;
    }

    return parsed;
  }
}
```

#### スキーマ追加

```sql
-- users_core に version カラムを追加
ALTER TABLE users_core ADD COLUMN user_version INTEGER NOT NULL DEFAULT 1;
```

### 6.4 Fallback / Circuit Breaker

#### 概要

Regional PII DB の障害時にも認証フローが完全に停止しないよう、Circuit Breaker と Graceful Degradation を実装する：

```
┌─────────────────────────────────────────────────┐
│            Resilience Strategy                  │
├─────────────────────────────────────────────────┤
│ 1. Circuit Breaker                              │
│    PII DB 障害検知 → 自動で degraded mode       │
│    • 連続 N 回失敗 → Open 状態                  │
│    • M 秒後に Half-Open → 再試行               │
│    • 成功したら Closed 状態に戻る               │
│                                                 │
│ 2. Graceful Degradation                         │
│    /userinfo → PII 取得失敗時は Core のみ返す  │
│    { sub: "uuid", email: null, name: null }    │
│                                                 │
│ 3. Fallback Region（オプション、デフォルト OFF）│
│    EU DB down → US replica から読み取り         │
│    ※ GDPR 例外条項適用、テナント単位 opt-in    │
│                                                 │
│ 4. Health Check Endpoint                        │
│    /health/pii-eu, /health/pii-us, /health/pii-jp│
└─────────────────────────────────────────────────┘
```

#### Circuit Breaker 実装

```typescript
// packages/shared/src/utils/circuit-breaker.ts

export interface CircuitBreakerConfig {
  failureThreshold: number;    // Open になる失敗回数（デフォルト: 5）
  resetTimeoutMs: number;      // Half-Open に移行する時間（デフォルト: 30000）
  halfOpenSuccessThreshold: number;  // Closed に戻る成功回数（デフォルト: 2）
}

export class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failures = 0;
  private lastFailureTime = 0;
  private halfOpenSuccesses = 0;

  constructor(
    private name: string,
    private config: CircuitBreakerConfig = {
      failureThreshold: 5,
      resetTimeoutMs: 30000,
      halfOpenSuccessThreshold: 2,
    }
  ) {}

  async execute<T>(fn: () => Promise<T>, fallback?: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.config.resetTimeoutMs) {
        this.state = 'half-open';
        this.halfOpenSuccesses = 0;
      } else if (fallback) {
        return fallback();
      } else {
        throw new CircuitOpenError(this.name);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      if (fallback) {
        return fallback();
      }
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.config.halfOpenSuccessThreshold) {
        this.state = 'closed';
        this.failures = 0;
      }
    } else {
      this.failures = 0;
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.config.failureThreshold) {
      this.state = 'open';
    }
  }
}
```

#### Graceful Degradation 実装

```typescript
// packages/op-userinfo/src/userinfo.ts

export const userinfoHandler: UserInfoHandler = async (c, ctx) => {
  const userId = getAuthenticatedUserId(c);

  // Core は必須
  const core = await ctx.core.getUserCore(userId);
  if (!core) {
    return c.json({ error: 'invalid_token' }, 401);
  }

  // PII は Circuit Breaker 経由で取得
  const profile = await piiCircuitBreaker.execute(
    () => ctx.pii.getUserProfile(userId),
    // Fallback: null を返す
    () => Promise.resolve(null)
  );

  // Degraded response if PII unavailable
  return c.json({
    sub: core.id,
    email: profile?.email ?? null,
    email_verified: core.email_verified,
    name: profile?.name ?? null,
    // ... other claims
    _degraded: profile === null,  // クライアントに degraded 状態を通知
  });
};
```

#### Fallback Region の注意事項

Fallback Region（EU DB down → US replica）は以下の理由から**デフォルト OFF**とする：

- **GDPR リスク**: 恒常運用は規制違反の可能性
- **例外措置の定義が必要**: 「一時的な技術的障害」としての位置づけ
- **テナント単位 opt-in**: 明示的に有効化したテナントのみ利用可能

```typescript
// テナント設定
interface TenantConfig {
  pii_region: Region;
  enable_fallback_region: boolean;  // デフォルト: false
  fallback_region?: Region;
}
```

### 6.5 Type-safe PII Access Control

#### 概要

TypeScript の型システムを活用して、認証フロー（`/authorize`, `/token`）から PII への直接アクセスをコンパイル時に防止する。

#### 実装

```typescript
// packages/shared/src/context/types.ts

/**
 * PII にアクセスできない Context
 * /authorize, /token, /introspect, /revoke 等で使用
 */
export interface AuthContext {
  core: CoreRepository;
  cache: CacheRepository;
  env: Env;
}

/**
 * PII にアクセスできる Context
 * /userinfo, /admin/users, /signup 等で使用
 */
export interface PIIContext extends AuthContext {
  pii: PIIRepository;
}

/**
 * Handler の型定義
 */
export type AuthHandler<E extends Env = Env> = (
  c: Context<{ Bindings: E }>,
  ctx: AuthContext
) => Promise<Response>;

export type PIIHandler<E extends Env = Env> = (
  c: Context<{ Bindings: E }>,
  ctx: PIIContext
) => Promise<Response>;
```

#### Context Factory

```typescript
// packages/shared/src/context/factory.ts

export function createAuthContext(env: Env): AuthContext {
  return {
    core: new CoreRepository(new D1Adapter(env.DB)),
    cache: new CacheRepository(env.USER_CACHE, env.CONSENT_CACHE, env.REBAC_CACHE, env.CLIENTS_CACHE),
    env,
  };
}

export async function createPIIContext(env: Env, userId?: string): Promise<PIIContext> {
  const authCtx = createAuthContext(env);

  // Region Router で適切な PII DB を取得
  const piiAdapter = userId
    ? await regionRouter.getPIIAdapter(userId, authCtx.core.db)
    : regionRouter.getAdapterForRegion(env.DEFAULT_PII_REGION);

  return {
    ...authCtx,
    pii: new PIIRepository(piiAdapter, encryptionService),
  };
}
```

#### Handler での使用

```typescript
// packages/op-auth/src/authorize.ts

// AuthHandler 型を使用 → ctx.pii にアクセスするとコンパイルエラー
export const authorizeHandler: AuthHandler = async (c, ctx) => {
  // ✅ OK: Core と Cache のみアクセス可能
  const client = await ctx.cache.getCachedClient(clientId);
  const session = await ctx.core.getSession(sessionId);

  // ❌ コンパイルエラー: Property 'pii' does not exist on type 'AuthContext'
  // const profile = await ctx.pii.getUserProfile(userId);

  return c.redirect(redirectUri);
};

// packages/op-userinfo/src/userinfo.ts

// PIIHandler 型を使用 → ctx.pii にアクセス可能
export const userinfoHandler: PIIHandler = async (c, ctx) => {
  // ✅ OK: すべてにアクセス可能
  const core = await ctx.core.getUserCore(userId);
  const profile = await ctx.pii.getUserProfile(userId);
  const cached = await ctx.cache.getCachedUser(userId);

  return c.json({ sub: core.id, email: profile.email });
};
```

#### ESLint ルールでの補強（オプション）

さらに強固にするため、ESLint ルールで PIIRepository の import を制限する：

```javascript
// .eslintrc.js
module.exports = {
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '@authrim/shared',
            importNames: ['PIIRepository'],
            message: 'PIIRepository is not allowed in this package. Use AuthContext instead.',
          },
        ],
      },
    ],
  },
  overrides: [
    {
      // PII を扱うパッケージでは許可
      files: ['packages/op-userinfo/**/*', 'packages/op-management/**/*'],
      rules: {
        'no-restricted-imports': 'off',
      },
    },
  ],
};
```

### 6.6 Multi-tenant Isolation 強化

#### 概要

テナント分離を 3 段階で提供する：

```
┌─────────────────────────────────────────────────┐
│         Multi-tenant Isolation Levels           │
├─────────────────────────────────────────────────┤
│ Level 1: Row-level（デフォルト）                │
│   WHERE tenant_id = ?                           │
│   → すべてのテナントが同じ DB を共有           │
│   → 最もコスト効率が良い                       │
│                                                 │
│ Level 2: Schema-level（Enterprise）             │
│   tenant_abc.users_pii                          │
│   tenant_xyz.users_pii                          │
│   → 同じ DB インスタンス、異なるスキーマ       │
│   → バックアップを個別に取得可能               │
│                                                 │
│ Level 3: Database-level（最高分離）             │
│   tenant_abc → dedicated Postgres instance     │
│   → 完全な物理分離                             │
│   → 「このテナントは EU 専用」が容易           │
└─────────────────────────────────────────────────┘
```

#### 実装: Repository での抽象化

```typescript
// packages/shared/src/repositories/pii/index.ts

export class PIIRepository {
  static forTenant(
    tenantId: string,
    tenantConfig: TenantConfig,
    regionRouter: RegionRouter
  ): PIIRepository {
    const isolation = tenantConfig.isolation_level || 'row';

    switch (isolation) {
      case 'database':
        // Level 3: 専用 DB インスタンス
        const dedicatedDb = regionRouter.getDedicatedAdapter(tenantId);
        return new PIIRepository(dedicatedDb, tenantId, 'public');

      case 'schema':
        // Level 2: 専用スキーマ
        const sharedDb = regionRouter.getAdapterForRegion(tenantConfig.pii_region);
        return new PIIRepository(sharedDb, tenantId, `tenant_${tenantId}`);

      case 'row':
      default:
        // Level 1: 行レベル分離
        const defaultDb = regionRouter.getAdapterForRegion(tenantConfig.pii_region);
        return new PIIRepository(defaultDb, tenantId, 'public');
    }
  }

  constructor(
    private db: DatabaseAdapter,
    private tenantId: string,
    private schema: string
  ) {}

  async getUserProfile(userId: string): Promise<UserProfile | null> {
    // Level 1 & 2: tenant_id を WHERE 句に含める
    // Level 3: tenant_id チェックは不要（専用 DB のため）
    const query = this.schema === 'public'
      ? 'SELECT * FROM users_pii WHERE id = $1 AND tenant_id = $2'
      : `SELECT * FROM ${this.schema}.users_pii WHERE id = $1`;

    const params = this.schema === 'public'
      ? [userId, this.tenantId]
      : [userId];

    return this.db.queryOne<UserProfile>(query, params);
  }
}
```

#### プラン別の提供

| プラン | 分離レベル | 追加料金 |
|-------|-----------|---------|
| Free | Row-level | - |
| Professional | Row-level | - |
| Enterprise | Schema-level | + |
| Enterprise Plus | Database-level | ++ |

### 6.7 Soft Delete + Anonymization

#### 概要

GDPR「忘れられる権利」に対応するため、削除戦略を以下のように設計する：

```
┌─────────────────────────────────────────────────┐
│              Deletion Strategy                  │
├─────────────────────────────────────────────────┤
│ PII Layer:                                      │
│   • Hard delete（物理削除）                    │
│   • または anonymize:                          │
│     email → "deleted_{userId}@anonymized.local"│
│     name → NULL                                 │
│     phone → NULL                                │
│                                                 │
│ Core Layer:                                     │
│   • Soft delete (is_deleted = 1)               │
│   • user_id は残す（監査ログ参照用）           │
│   • relationships は CASCADE DELETE             │
│                                                 │
│ Cache Layer:                                    │
│   • 即時 invalidate                            │
│                                                 │
│ Audit Log:                                      │
│   • Core 側は保持（法的要件）                  │
│   • PII 側は anonymize                         │
└─────────────────────────────────────────────────┘
```

#### 実装

```typescript
// packages/shared/src/services/user.service.ts

export class UserService {
  /**
   * GDPR 削除リクエストを処理
   * @param userId - 削除対象のユーザー ID
   * @param mode - 'hard_delete' or 'anonymize'
   */
  async deleteUser(userId: string, mode: 'hard_delete' | 'anonymize' = 'anonymize'): Promise<void> {
    // 1. Cache を即時 invalidate
    await this.cache.invalidateUser(userId);
    await this.cache.invalidateRBAC(userId);

    // 2. PII 処理
    if (mode === 'hard_delete') {
      await this.pii.deleteUserProfile(userId);
    } else {
      await this.pii.anonymizeUserProfile(userId);
    }

    // 3. Core を soft delete
    await this.core.updateUserCore(userId, {
      is_deleted: true,
      deleted_at: Date.now(),
    });

    // 4. Relationships を削除（CASCADE）
    await this.core.deleteUserRelationships(userId);

    // 5. Sessions を削除
    await this.core.deleteUserSessions(userId);

    // 6. Passkeys を削除
    await this.core.deleteUserPasskeys(userId);

    // 7. Audit Log (PII) を anonymize
    await this.pii.anonymizeAuditLogs(userId);
  }
}

// packages/shared/src/repositories/pii/index.ts

export class PIIRepository {
  async anonymizeUserProfile(userId: string): Promise<void> {
    await this.db.execute(
      `UPDATE users_pii SET
        email_encrypted = $1,
        email_blind_index = $2,
        name = NULL,
        given_name = NULL,
        family_name = NULL,
        phone_number_encrypted = NULL,
        address_encrypted = NULL,
        anonymized_at = NOW()
      WHERE id = $3`,
      [
        this.encryption.encrypt(`deleted_${userId}@anonymized.local`),
        createBlindIndex(`deleted_${userId}@anonymized.local`, this.indexKey),
        userId,
      ]
    );
  }

  async anonymizeAuditLogs(userId: string): Promise<void> {
    // PII 側の監査ログを anonymize
    await this.db.execute(
      `UPDATE audit_log_pii SET
        ip_address_encrypted = NULL,
        user_agent_hash = NULL,
        anonymized_at = NOW()
      WHERE audit_id IN (
        SELECT id FROM audit_log_core WHERE user_id = $1
      )`,
      [userId]
    );
  }
}
```

#### スキーマ

```sql
-- users_core に削除関連カラムを追加
ALTER TABLE users_core ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users_core ADD COLUMN deleted_at INTEGER;

CREATE INDEX idx_users_core_is_deleted ON users_core(is_deleted);

-- users_pii に匿名化関連カラムを追加
ALTER TABLE users_pii ADD COLUMN anonymized_at TIMESTAMPTZ;
```

### 6.8 Key Rotation 戦略

#### 概要

暗号化キーのライフサイクル管理として、定期的なキーローテーションを実装する：

```
┌─────────────────────────────────────────────────┐
│            Key Rotation Strategy                │
├─────────────────────────────────────────────────┤
│ Rotation Schedule:                              │
│   • Master Key (KEK): 年 1 回                  │
│   • Tenant DEK: 年 1 回 or オンデマンド        │
│   • Index Key (Blind Index): 原則ローテートなし│
│                                                 │
│ Rotation Process:                               │
│   1. 新 DEK を生成                             │
│   2. 旧 DEK を "decrypt only" モードに         │
│   3. バックグラウンドで再暗号化                │
│   4. 完了後、旧 DEK を削除                     │
│                                                 │
│ Key Versioning:                                 │
│   encrypted_value = version:iv:ciphertext      │
│   例: v2:abc123...:encrypted_email...          │
└─────────────────────────────────────────────────┘
```

#### 実装

```typescript
// packages/shared/src/encryption/key-manager.ts

export interface EncryptedValue {
  version: number;
  iv: string;
  ciphertext: string;
}

export class KeyManager {
  private keys: Map<number, CryptoKey> = new Map();
  private currentVersion: number;

  constructor(private kms: KMSClient, private tenantId: string) {}

  async initialize(): Promise<void> {
    // KMS から現在のキーバージョンを取得
    const keyMetadata = await this.kms.getKeyMetadata(this.tenantId);
    this.currentVersion = keyMetadata.currentVersion;

    // 現在のキーと 1 つ前のキー（ローテーション中用）をロード
    for (const version of [this.currentVersion, this.currentVersion - 1]) {
      if (version > 0) {
        const wrappedKey = await this.kms.getWrappedKey(this.tenantId, version);
        const unwrappedKey = await this.kms.unwrapKey(wrappedKey);
        this.keys.set(version, unwrappedKey);
      }
    }
  }

  async encrypt(plaintext: string): Promise<string> {
    const key = this.keys.get(this.currentVersion);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plaintext)
    );

    return `v${this.currentVersion}:${base64url(iv)}:${base64url(ciphertext)}`;
  }

  async decrypt(encrypted: string): Promise<string> {
    const [versionStr, ivStr, ciphertextStr] = encrypted.split(':');
    const version = parseInt(versionStr.slice(1), 10);
    const iv = base64urlDecode(ivStr);
    const ciphertext = base64urlDecode(ciphertextStr);

    const key = this.keys.get(version);
    if (!key) {
      throw new Error(`Key version ${version} not available`);
    }

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );

    return new TextDecoder().decode(plaintext);
  }

  async rotateKey(): Promise<void> {
    // 1. 新キーを生成
    const newVersion = this.currentVersion + 1;
    const newKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    // 2. KMS でラップして保存
    const wrappedKey = await this.kms.wrapKey(newKey);
    await this.kms.storeWrappedKey(this.tenantId, newVersion, wrappedKey);

    // 3. 現在のキーを更新
    this.keys.set(newVersion, newKey);
    this.currentVersion = newVersion;

    // 4. バックグラウンドで再暗号化をスケジュール
    await this.scheduleReEncryption(newVersion);
  }
}
```

### 6.9 Monitoring / Observability

#### 概要

PII 層と Non-PII 層を分けてモニタリングし、認証フローに PII が影響しないことを保証する：

```
┌─────────────────────────────────────────────────┐
│         Monitoring Strategy                     │
├─────────────────────────────────────────────────┤
│ Metrics by Layer:                               │
│   • Core Layer: /authorize, /token の p50/p99  │
│   • PII Layer: /userinfo, /admin の p50/p99    │
│   • Cache Layer: hit rate, miss rate           │
│                                                 │
│ Alerts:                                         │
│   • PII DB latency > 500ms → warning           │
│   • PII DB latency > 2000ms → critical         │
│   • Core DB latency > 100ms → warning          │
│   • Circuit Breaker open → critical            │
│                                                 │
│ Dashboards:                                     │
│   • "Auth Performance" (Core only)             │
│   • "User Data Access" (PII metrics)           │
│   • "Cache Efficiency" (hit rates)             │
└─────────────────────────────────────────────────┘
```

#### 実装

```typescript
// packages/shared/src/monitoring/metrics.ts

export interface Metrics {
  // Latency histograms
  recordLatency(layer: 'core' | 'pii' | 'cache', operation: string, durationMs: number): void;

  // Counters
  incrementCounter(name: string, tags?: Record<string, string>): void;

  // Gauges
  setGauge(name: string, value: number, tags?: Record<string, string>): void;
}

// Repository でのメトリクス記録
class PIIRepository {
  constructor(private db: DatabaseAdapter, private metrics: Metrics) {}

  async getUserProfile(userId: string): Promise<UserProfile | null> {
    const start = Date.now();
    try {
      const result = await this.db.queryOne<UserProfile>(
        'SELECT * FROM users_pii WHERE id = $1',
        [userId]
      );
      this.metrics.recordLatency('pii', 'getUserProfile', Date.now() - start);
      return result;
    } catch (error) {
      this.metrics.incrementCounter('pii_errors', { operation: 'getUserProfile' });
      throw error;
    }
  }
}
```

---

## 7. 実装計画

### Phase 1: Database Adapter Layer

| タスク | 優先度 | 複雑度 |
|--------|--------|--------|
| DatabaseAdapter interface 定義 | 高 | 低 |
| D1Adapter 実装 | 高 | 低 |
| KVAdapter 実装 | 高 | 低 |
| DOAdapter 実装 | 高 | 中 |
| PostgresAdapter 実装 | 高 | 中 |
| 基本テスト | 高 | 低 |

### Phase 2: Repository Layer

| タスク | 優先度 | 複雑度 |
|--------|--------|--------|
| CoreRepository 実装 | 高 | 中 |
| PIIRepository 実装 | 高 | 中 |
| CacheRepository 実装 | 高 | 低 |
| RegionRouter 実装 | 高 | 中 |
| Type-safe Context 実装 | 高 | 低 |

### Phase 3: 暗号化 & セキュリティ

| タスク | 優先度 | 複雑度 |
|--------|--------|--------|
| Field-level encryption 実装 | 高 | 中 |
| Blind Index 実装 | 高 | 中 |
| Key Management (KMS 連携) | 高 | 高 |
| Key Rotation 実装 | 中 | 高 |

### Phase 4: 既存コード移行

| タスク | 優先度 | 複雑度 |
|--------|--------|--------|
| Handler を Repository パターンに移行 | 高 | 高 |
| DB スキーマ分割マイグレーション | 高 | 高 |
| Cache 層の分離 | 中 | 中 |
| Audit Log 分離 | 中 | 中 |

### Phase 5: Resilience & Observability

| タスク | 優先度 | 複雑度 |
|--------|--------|--------|
| Circuit Breaker 実装 | 中 | 中 |
| Graceful Degradation 実装 | 中 | 低 |
| Metrics / Monitoring 実装 | 中 | 中 |
| Health Check エンドポイント | 低 | 低 |

### Phase 6: Multi-tenant & GDPR

| タスク | 優先度 | 複雑度 |
|--------|--------|--------|
| Multi-tenant Isolation (Level 2, 3) | 中 | 中 |
| Soft Delete + Anonymization | 高 | 低 |
| Data Export (GDPR ポータビリティ) | 中 | 中 |

---

## 8. 将来の拡張性

### 8.1 AWS 移行パス

この設計により、将来 AWS への移行が容易になる：

| Cloudflare | AWS |
|------------|-----|
| D1 | Aurora Serverless v2 |
| Durable Objects | DynamoDB + Item Locking |
| KV | ElastiCache (Redis) or DynamoDB |
| Workers | Lambda@Edge |
| Regional Postgres | RDS (Postgres) |

移行時は DatabaseAdapter の実装を追加するだけで、Repository 層以上のコードは変更不要。

### 8.2 追加の認証方式

Repository パターンにより、新しい認証方式の追加が容易：

- **FIDO2/WebAuthn**: 既に対応済み（Passkey は CoreRepository）
- **mTLS**: 証明書は CoreRepository に保存
- **SAML**: Assertion は一時的、メタデータは CoreRepository

### 8.3 追加の PII 種別

PIIRepository を拡張して新しい PII 種別に対応：

- **生体情報**: 顔認証テンプレート等（最高レベルの暗号化が必要）
- **決済情報**: PCI DSS 対応が必要（別の専用サービスを検討）
- **医療情報**: HIPAA 対応が必要（Level 3 分離必須）

---

## 付録

### A. ファイル構成

```
packages/shared/src/
├── db/
│   ├── adapter.ts              # DatabaseAdapter interface
│   ├── adapters/
│   │   ├── d1-adapter.ts       # Cloudflare D1
│   │   ├── kv-adapter.ts       # Cloudflare KV
│   │   ├── do-adapter.ts       # Durable Objects
│   │   └── postgres-adapter.ts # Regional Postgres
│   └── region-router.ts        # PII region routing
├── repositories/
│   ├── core/
│   │   ├── user-core.repository.ts
│   │   ├── passkey.repository.ts
│   │   ├── session.repository.ts
│   │   ├── role.repository.ts
│   │   ├── relationship.repository.ts
│   │   └── index.ts            # CoreRepository facade
│   ├── pii/
│   │   ├── user-profile.repository.ts
│   │   ├── identifier.repository.ts
│   │   ├── audit-log-pii.repository.ts
│   │   └── index.ts            # PIIRepository facade
│   ├── cache/
│   │   ├── user-cache.repository.ts
│   │   ├── rbac-cache.repository.ts
│   │   ├── consent-cache.repository.ts
│   │   └── index.ts            # CacheRepository facade
│   └── index.ts                # Export all repositories
├── services/
│   ├── user.service.ts         # Combines Core+PII+Cache
│   └── encryption.service.ts   # Field-level encryption
├── context/
│   ├── types.ts                # AuthContext, PIIContext
│   └── factory.ts              # Context factories
├── encryption/
│   ├── key-manager.ts          # Key management
│   ├── blind-index.ts          # Blind index utilities
│   └── field-encryption.ts     # Field-level encryption
├── resilience/
│   ├── circuit-breaker.ts      # Circuit breaker
│   └── fallback.ts             # Fallback strategies
└── monitoring/
    └── metrics.ts              # Metrics utilities
```

### B. スキーマ分割

#### Global D1: users_core

```sql
CREATE TABLE users_core (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  pii_region TEXT NOT NULL DEFAULT 'eu',
  email_verified INTEGER DEFAULT 0,
  user_type TEXT NOT NULL DEFAULT 'end_user',
  user_version INTEGER NOT NULL DEFAULT 1,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE INDEX idx_users_core_tenant_id ON users_core(tenant_id);
CREATE INDEX idx_users_core_is_deleted ON users_core(is_deleted);
```

#### Regional Postgres: users_pii

```sql
CREATE TABLE users_pii (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  email_encrypted TEXT NOT NULL,
  email_blind_index TEXT NOT NULL,
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
  phone_number_encrypted TEXT,
  address_encrypted TEXT,
  anonymized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_pii_tenant_id ON users_pii(tenant_id);
CREATE UNIQUE INDEX idx_users_pii_email_blind_index ON users_pii(tenant_id, email_blind_index);
```

---

## 変更履歴

| 日付 | バージョン | 変更内容 |
|------|-----------|---------|
| 2025-12-12 | 1.0 | 初版作成 |
