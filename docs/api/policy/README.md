# Policy Service API Guide

**Version**: 0.1.0
**Last Updated**: 2025-12-01

---

## Overview

Policy Service は、Authrim のアクセス制御を担当する独立したマイクロサービスです。
RBAC (Role-Based Access Control) と ABAC (Attribute-Based Access Control) を統合した柔軟なポリシー評価を提供します。

### 現在の機能

| 機能 | 状態 | 説明 |
|------|------|------|
| **RBAC (Role-Based)** | ✅ 実装済み | ロールベースのアクセス制御 |
| **ABAC (Attribute-Based)** | ✅ 実装済み | 属性ベースのアクセス制御 |
| **ReBAC (Relationship-Based)** | 🔜 プレースホルダー | Zanzibar スタイルの関係ベース制御 (将来実装) |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Client Applications                   │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│                   Policy Service API                     │
│  ┌─────────────────────────────────────────────────────┐│
│  │  /policy/evaluate  │  /policy/check-role  │ ...     ││
│  └─────────────────────────────────────────────────────┘│
│                          │                               │
│                          ▼                               │
│  ┌─────────────────────────────────────────────────────┐│
│  │              Policy Engine (@authrim/policy-core)    ││
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ││
│  │  │ RBAC Rules  │  │ ABAC Conds  │  │ Ownership   │  ││
│  │  └─────────────┘  └─────────────┘  └─────────────┘  ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

---

## Authentication

Policy Service の全エンドポイント（`/policy/health` と `/api/rebac/health` を除く）は Bearer トークン認証が必要です。

```http
Authorization: Bearer <POLICY_API_SECRET>
```

`POLICY_API_SECRET` は Cloudflare Workers の環境変数として設定されます。

---

## Endpoints

### Health Check

#### `GET /policy/health`

認証不要。サービスの稼働状態を確認します。

**Response:**
```json
{
  "status": "ok",
  "service": "policy-service",
  "version": "0.1.0",
  "timestamp": "2025-12-01T10:00:00.000Z"
}
```

---

### Policy Evaluation

#### `POST /policy/evaluate`

フルポリシー評価を実行します。最も柔軟なエンドポイントで、subject、resource、action の完全な情報を指定できます。

**Request:**
```json
{
  "subject": {
    "id": "user_123",
    "roles": [
      { "name": "org_admin", "scope": "organization", "scopeTarget": "org_456" }
    ],
    "orgId": "org_456"
  },
  "resource": {
    "type": "document",
    "id": "doc_789",
    "orgId": "org_456"
  },
  "action": {
    "name": "read"
  }
}
```

**Response:**
```json
{
  "allowed": true,
  "reason": "Organization administrators can manage resources in their organization",
  "decidedBy": "org_admin_same_org"
}
```

**Subject Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✅ | ユーザーID |
| `roles` | SubjectRole[] | ✅ | 割り当てられたロール |
| `orgId` | string | - | 所属組織ID |
| `userType` | string | - | ユーザー種別 |
| `plan` | string | - | 契約プラン |
| `relationships` | SubjectRelationship[] | - | 他ユーザーとの関係 |
| `verifiedAttributes` | VerifiedAttribute[] | - | 検証済み属性 (ABAC) |

**Role Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | ロール名 (`system_admin`, `org_admin`, `end_user` など) |
| `scope` | string | ✅ | スコープ (`global`, `organization`, `resource`) |
| `scopeTarget` | string | - | スコープ対象 (例: `org:org_123`) |
| `expiresAt` | number | - | 有効期限 (UNIX ms) |

---

#### `POST /policy/check-role`

ユーザーが特定のロールを持っているかを簡易チェックします。

**Single Role Check:**
```json
{
  "subject": {
    "id": "user_123",
    "roles": [{ "name": "admin", "scope": "global" }]
  },
  "role": "admin"
}
```

**Multiple Roles Check (any mode):**
```json
{
  "subject": {
    "id": "user_123",
    "roles": [{ "name": "editor", "scope": "global" }]
  },
  "roles": ["admin", "editor"],
  "mode": "any"
}
```

**Multiple Roles Check (all mode):**
```json
{
  "subject": {
    "id": "user_123",
    "roles": [
      { "name": "admin", "scope": "global" },
      { "name": "editor", "scope": "global" }
    ]
  },
  "roles": ["admin", "editor"],
  "mode": "all"
}
```

**Response:**
```json
{
  "hasRole": true,
  "activeRoles": ["admin", "editor"]
}
```

---

#### `POST /policy/check-access`

簡易アクセスチェック。`/policy/evaluate` の簡略版です。

**Using Claims (JWT からの変換):**
```json
{
  "claims": {
    "sub": "user_123",
    "authrim_roles": ["system_admin"]
  },
  "resourceType": "document",
  "resourceId": "doc_456",
  "action": "read"
}
```

**Using Direct Roles:**
```json
{
  "subjectId": "user_123",
  "roles": [{ "name": "end_user", "scope": "global" }],
  "resourceType": "document",
  "resourceId": "doc_456",
  "resourceOwnerId": "user_123",
  "action": "read"
}
```

**Response:**
```json
{
  "allowed": true,
  "reason": "Resource owners have full access to their own resources",
  "decidedBy": "owner_full_access"
}
```

---

#### `POST /policy/is-admin`

ユーザーが管理者権限を持つかを判定します。

**Request:**
```json
{
  "roles": ["admin"]
}
```

または claims から:
```json
{
  "claims": {
    "sub": "user_123",
    "authrim_roles": ["org_admin"]
  }
}
```

**Response:**
```json
{
  "isAdmin": true,
  "adminRoles": ["org_admin"]
}
```

**Admin Roles:**
- `system_admin`
- `distributor_admin`
- `org_admin`
- `admin`

---

### ReBAC Endpoints (Placeholder)

#### `GET /api/rebac/health`

ReBAC サービスの稼働状態を確認します。

#### `POST /api/rebac/check`

Zanzibar スタイルの関係チェック（現在はプレースホルダー）。

**Request:**
```json
{
  "subject": "user:user_123",
  "relation": "viewer",
  "object": "document:doc_456"
}
```

**Response:**
```json
{
  "allowed": false,
  "reason": "ReBAC check is not yet implemented"
}
```

---

## Policy Rules

### Default Rules (Built-in)

Policy Engine には以下のデフォルトルールが組み込まれています:

| Priority | Rule ID | Description |
|----------|---------|-------------|
| 1000 | `system_admin_full_access` | システム管理者は全リソースにアクセス可能 |
| 900 | `distributor_admin_access` | ディストリビューター管理者の広範なアクセス |
| 800 | `org_admin_same_org` | 組織管理者は同一組織内リソースを管理可能 |
| 700 | `owner_full_access` | リソース所有者は自身のリソースにフルアクセス |
| 600 | `guardian_access` | 保護者は被保護者のリソースにアクセス可能 |

### Condition Types

ポリシールールで使用可能な条件タイプ:

#### RBAC Conditions

| Type | Description | Params |
|------|-------------|--------|
| `has_role` | 特定ロールを持つか | `role`, `scope?`, `scopeTarget?` |
| `has_any_role` | いずれかのロールを持つか | `roles[]`, `scope?`, `scopeTarget?` |
| `has_all_roles` | 全ロールを持つか | `roles[]`, `scope?`, `scopeTarget?` |

#### Ownership Conditions

| Type | Description | Params |
|------|-------------|--------|
| `is_resource_owner` | リソース所有者か | なし |
| `same_organization` | 同一組織か | なし |

#### Relationship Conditions

| Type | Description | Params |
|------|-------------|--------|
| `has_relationship` | 関係を持つか | `types[]` |
| `user_type_is` | ユーザー種別が一致するか | `types[]` |
| `plan_allows` | プランが許可するか | `plans[]` |

#### ABAC Conditions

| Type | Description | Params |
|------|-------------|--------|
| `attribute_equals` | 属性値が一致するか | `name`, `value`, `checkExpiry?` |
| `attribute_exists` | 属性が存在するか | `name`, `checkExpiry?` |
| `attribute_in` | 属性値がリスト内か | `name`, `values[]`, `checkExpiry?` |

---

## Custom Rules

カスタムルールを追加する場合は、`PolicyEngine.addRule()` を使用します:

```typescript
import { PolicyEngine } from '@authrim/policy-core';

const engine = new PolicyEngine({ defaultDecision: 'deny' });

// Premium ユーザーのみ高度な機能を使用可能
engine.addRule({
  id: 'premium_features',
  name: 'Premium Feature Access',
  description: 'Only premium subscribers can access advanced features',
  priority: 500,
  effect: 'allow',
  conditions: [
    { type: 'attribute_equals', params: { name: 'subscription_tier', value: 'premium' } }
  ],
});

// 同一組織内の編集者のみドキュメント編集可能
engine.addRule({
  id: 'org_editor_write',
  name: 'Organization Editor Write Access',
  description: 'Editors can write documents in their organization',
  priority: 550,
  effect: 'allow',
  conditions: [
    { type: 'has_role', params: { role: 'editor' } },
    { type: 'same_organization', params: {} },
  ],
});
```

---

## Integration Examples

### cURL Examples

**Health Check:**
```bash
curl https://policy.authrim.com/policy/health
```

**Policy Evaluation:**
```bash
curl -X POST https://policy.authrim.com/policy/evaluate \
  -H "Authorization: Bearer $POLICY_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "subject": {
      "id": "user_123",
      "roles": [{ "name": "system_admin", "scope": "global" }]
    },
    "resource": { "type": "document", "id": "doc_456" },
    "action": { "name": "delete" }
  }'
```

**Check Role:**
```bash
curl -X POST https://policy.authrim.com/policy/check-role \
  -H "Authorization: Bearer $POLICY_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "subject": {
      "id": "user_123",
      "roles": [{ "name": "org_admin", "scope": "organization", "scopeTarget": "org_456" }]
    },
    "role": "org_admin"
  }'
```

**Is Admin Check:**
```bash
curl -X POST https://policy.authrim.com/policy/is-admin \
  -H "Authorization: Bearer $POLICY_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"roles": ["system_admin"]}'
```

### TypeScript Integration

```typescript
import type { PolicyContext, PolicyDecision } from '@authrim/policy-core';

async function checkAccess(
  userId: string,
  roles: string[],
  resourceType: string,
  resourceId: string,
  action: string
): Promise<boolean> {
  const response = await fetch('https://policy.authrim.com/policy/check-access', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${POLICY_API_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      subjectId: userId,
      roles: roles.map(name => ({ name, scope: 'global' })),
      resourceType,
      resourceId,
      action,
    }),
  });

  const result = await response.json() as PolicyDecision;
  return result.allowed;
}

// Usage
const canDelete = await checkAccess('user_123', ['org_admin'], 'document', 'doc_456', 'delete');
```

---

## Error Responses

### 401 Unauthorized
```json
{
  "error": "unauthorized",
  "message": "Missing or invalid authorization header"
}
```

### 400 Bad Request
```json
{
  "error": "invalid_request",
  "message": "Missing required field: subject"
}
```

### 404 Not Found
```json
{
  "error": "not_found",
  "path": "/unknown/endpoint"
}
```

---

## Routing Notes

Policy Service は以下の2つのアクセスパターンをサポートします:

### Custom Domain (Production)
- URL: `https://policy.authrim.com/policy/*`
- パスはそのまま Worker に転送されます

### workers.dev (Development/Router)
- URL: `https://router.authrim.workers.dev/policy/*`
- Service Binding 経由でルーティングされます
- パスのプレフィックスは Router が処理します

---

## Related Documents

- [API Inventory](../../project-management/API_INVENTORY.md)
- [RBAC Implementation Plan](../../project-management/RBAC_IMPLEMENTATION_PLAN.md)
- [Database Schema](../../architecture/database-schema.md)

---

> **Last Updated**: 2025-12-01
