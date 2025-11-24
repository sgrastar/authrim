# OpenID Certification テストガイド

このガイドでは、[OpenID Certification](https://www.certification.openid.net/)でAuthrimをテストする方法を説明します。

**⚠️ 重要**: 現在Admin APIは認証なしでアクセス可能です。将来的にABACベースの認証機構が実装される予定です。

## 📋 目次

1. [概要](#概要)
2. [モード切り替え方法](#モード切り替え方法)
3. [プロファイル一覧](#プロファイル一覧)
4. [API使用例](#api使用例)
5. [Certification用の推奨設定](#certification用の推奨設定)

## 概要

Authrimは、設定を変更することで以下のOpenID Connectプロファイルをサポートできます：

- **Basic OP**: 標準的なAuthorization Code Flow
- **Implicit OP**: Implicit Flow（SPA向け）
- **Hybrid OP**: Hybrid Flow
- **FAPI 1.0 Advanced**: 金融機関向けセキュリティプロファイル（MTLS）
- **FAPI 2.0**: 次世代金融機関向けセキュリティプロファイル（PAR + private_key_jwt）
- **FAPI 2.0 + DPoP**: FAPI 2.0 + 送信者制約トークン

## モード切り替え方法

### 方法1: Admin API経由（推奨）

**注意**: Admin APIは現在認証不要です。以下のコマンドはそのまま実行できます。

#### プロファイル一覧の取得

```bash
curl -X GET https://your-authrim.com/api/admin/settings/profiles
```

**レスポンス例:**
```json
{
  "profiles": [
    {
      "name": "Basic OP",
      "description": "Standard OpenID Connect Provider (Authorization Code Flow)"
    },
    {
      "name": "FAPI 2.0",
      "description": "Financial-grade API Security Profile 2.0"
    },
    ...
  ]
}
```

#### プロファイルの適用

```bash
# Basic OP モードに切り替え
curl -X PUT https://your-authrim.com/api/admin/settings/profile/basic-op \
  -H "Content-Type: application/json"

# FAPI 2.0 モードに切り替え
curl -X PUT https://your-authrim.com/api/admin/settings/profile/fapi-2 \
  -H "Content-Type: application/json"

# FAPI 2.0 + DPoP モードに切り替え
curl -X PUT https://your-authrim.com/api/admin/settings/profile/fapi-2-dpop \
  -H "Content-Type: application/json"
```

**レスポンス例:**
```json
{
  "success": true,
  "message": "Applied certification profile: FAPI 2.0",
  "profile": {
    "name": "FAPI 2.0",
    "description": "Financial-grade API Security Profile 2.0"
  },
  "settings": {
    "fapi": {
      "enabled": true,
      "requireDpop": false,
      "allowPublicClients": false
    },
    "oidc": {
      "requirePar": true,
      "responseTypesSupported": ["code"],
      "tokenEndpointAuthMethodsSupported": ["private_key_jwt", "client_secret_jwt"]
    }
  }
}
```

### 方法2: 手動設定

より細かい制御が必要な場合は、設定を直接更新できます：

```bash
curl -X PUT https://your-authrim.com/api/admin/settings \
  -H "Content-Type: application/json" \
  -d '{
    "settings": {
      "fapi": {
        "enabled": true,
        "requireDpop": false,
        "allowPublicClients": false
      },
      "oidc": {
        "requirePar": true,
        "tokenEndpointAuthMethodsSupported": ["private_key_jwt"]
      }
    }
  }'
```

## プロファイル一覧

### basic-op (Basic OP)

**説明**: 標準的なOpenID Connect Provider（Authorization Code Flow）

**設定**:
```json
{
  "fapi": {
    "enabled": false,
    "requireDpop": false,
    "allowPublicClients": true
  },
  "oidc": {
    "requirePar": false,
    "responseTypesSupported": ["code"],
    "tokenEndpointAuthMethodsSupported": [
      "client_secret_basic",
      "client_secret_post",
      "client_secret_jwt",
      "private_key_jwt",
      "none"
    ]
  }
}
```

**適用方法**:
```bash
curl -X PUT https://your-authrim.com/api/admin/settings/profile/basic-op \
  -H "Content-Type: application/json"
```

---

### implicit-op (Implicit OP)

**説明**: Implicit Flowをサポート（SPA向け）

**設定**:
```json
{
  "fapi": {
    "enabled": false,
    "requireDpop": false,
    "allowPublicClients": true
  },
  "oidc": {
    "requirePar": false,
    "responseTypesSupported": ["code", "id_token", "id_token token"],
    "tokenEndpointAuthMethodsSupported": [
      "client_secret_basic",
      "client_secret_post",
      "none"
    ]
  }
}
```

**適用方法**:
```bash
curl -X PUT https://your-authrim.com/api/admin/settings/profile/implicit-op \
  -H "Content-Type: application/json"
```

---

### hybrid-op (Hybrid OP)

**説明**: Hybrid Flowをサポート

**設定**:
```json
{
  "fapi": {
    "enabled": false,
    "requireDpop": false,
    "allowPublicClients": true
  },
  "oidc": {
    "requirePar": false,
    "responseTypesSupported": [
      "code",
      "code id_token",
      "code token",
      "code id_token token"
    ],
    "tokenEndpointAuthMethodsSupported": [
      "client_secret_basic",
      "client_secret_post",
      "client_secret_jwt",
      "private_key_jwt",
      "none"
    ]
  }
}
```

**適用方法**:
```bash
curl -X PUT https://your-authrim.com/api/admin/settings/profile/hybrid-op \
  -H "Content-Type: application/json"
```

---

### fapi-1-advanced (FAPI 1.0 Advanced)

**説明**: Financial-grade API Security Profile 1.0 - Advanced（MTLS使用）

**設定**:
```json
{
  "fapi": {
    "enabled": false,
    "requireDpop": false,
    "allowPublicClients": false
  },
  "oidc": {
    "requirePar": false,
    "responseTypesSupported": ["code", "code id_token"],
    "tokenEndpointAuthMethodsSupported": [
      "private_key_jwt",
      "tls_client_auth"
    ]
  }
}
```

**適用方法**:
```bash
curl -X PUT https://your-authrim.com/api/admin/settings/profile/fapi-1-advanced \
  -H "Content-Type: application/json"
```

**注意**: FAPI 1.0ではMTLS（Mutual TLS）が必要です。Cloudflare Workersでのサポート状況を確認してください。

---

### fapi-2 (FAPI 2.0)

**説明**: Financial-grade API Security Profile 2.0（最新版）

**設定**:
```json
{
  "fapi": {
    "enabled": true,
    "requireDpop": false,
    "allowPublicClients": false
  },
  "oidc": {
    "requirePar": true,
    "responseTypesSupported": ["code"],
    "tokenEndpointAuthMethodsSupported": [
      "private_key_jwt",
      "client_secret_jwt"
    ]
  }
}
```

**適用方法**:
```bash
curl -X PUT https://your-authrim.com/api/admin/settings/profile/fapi-2 \
  -H "Content-Type: application/json"
```

**必須要件**:
- ✅ PAR (Pushed Authorization Requests) 必須
- ✅ Confidential Clients のみ
- ✅ PKCE S256 必須
- ✅ `iss` パラメータ（RFC 9207）
- ✅ private_key_jwt または client_secret_jwt

---

### fapi-2-dpop (FAPI 2.0 + DPoP)

**説明**: FAPI 2.0 + DPoP（送信者制約トークン）

**設定**:
```json
{
  "fapi": {
    "enabled": true,
    "requireDpop": true,
    "allowPublicClients": false
  },
  "oidc": {
    "requirePar": true,
    "responseTypesSupported": ["code"],
    "tokenEndpointAuthMethodsSupported": ["private_key_jwt"]
  }
}
```

**適用方法**:
```bash
curl -X PUT https://your-authrim.com/api/admin/settings/profile/fapi-2-dpop \
  -H "Content-Type: application/json"
```

**追加要件**:
- ✅ DPoP proof 必須（RFC 9449）
- ✅ すべてのトークンリクエストでDPoPヘッダーが必要

---

### development (開発用)

**説明**: ローカル開発向けの緩和された設定

**設定**:
```json
{
  "fapi": {
    "enabled": false,
    "requireDpop": false,
    "allowPublicClients": true
  },
  "oidc": {
    "requirePar": false,
    "responseTypesSupported": ["code"],
    "tokenEndpointAuthMethodsSupported": [
      "client_secret_basic",
      "client_secret_post",
      "none"
    ]
  }
}
```

**適用方法**:
```bash
curl -X PUT https://your-authrim.com/api/admin/settings/profile/development \
  -H "Content-Type: application/json"
```

## API使用例

**注意**: 以下の例では認証ヘッダーは不要です（現在Admin APIは認証なしでアクセス可能）。

### TypeScript/JavaScript

```typescript
// プロファイル一覧の取得
async function listProfiles() {
  const response = await fetch('https://your-authrim.com/api/admin/settings/profiles');
  const data = await response.json();
  console.log('Available profiles:', data.profiles);
}

// プロファイルの適用
async function applyProfile(profileName: string) {
  const response = await fetch(
    `https://your-authrim.com/api/admin/settings/profile/${profileName}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      }
    }
  );
  const data = await response.json();
  console.log('Applied profile:', data);
}

// 使用例
await applyProfile('fapi-2');  // FAPI 2.0モードに切り替え
```

### Python

```python
import requests

BASE_URL = "https://your-authrim.com"

# プロファイル一覧の取得
def list_profiles():
    response = requests.get(f"{BASE_URL}/api/admin/settings/profiles")
    return response.json()

# プロファイルの適用
def apply_profile(profile_name):
    response = requests.put(
        f"{BASE_URL}/api/admin/settings/profile/{profile_name}",
        headers={"Content-Type": "application/json"}
    )
    return response.json()

# 使用例
profiles = list_profiles()
print(f"Available profiles: {profiles}")

result = apply_profile("fapi-2")
print(f"Applied profile: {result}")
```

## Certification用の推奨設定

### 1. Basic OP Certification

```bash
# Step 1: Basic OPプロファイルを適用
curl -X PUT https://your-authrim.com/api/admin/settings/profile/basic-op \
  -H "Content-Type: application/json"

# Step 2: Discovery URLを確認
# https://your-authrim.com/.well-known/openid-configuration

# Step 3: OpenID CertificationツールでURLを登録
# https://www.certification.openid.net/
```

### 2. FAPI 2.0 Certification

```bash
# Step 1: FAPI 2.0プロファイルを適用
curl -X PUT https://your-authrim.com/api/admin/settings/profile/fapi-2 \
  -H "Content-Type: application/json"

# Step 2: クライアント登録
# - private_key_jwt認証用の公開鍵（JWKS）を準備
# - クライアント登録時にjwks_uriまたはjwksを提供

# Step 3: 設定確認
curl https://your-authrim.com/.well-known/openid-configuration | jq '{
  require_pushed_authorization_requests,
  token_endpoint_auth_methods_supported,
  code_challenge_methods_supported,
  dpop_signing_alg_values_supported
}'

# 期待される出力:
# {
#   "require_pushed_authorization_requests": true,
#   "token_endpoint_auth_methods_supported": ["private_key_jwt", "client_secret_jwt"],
#   "code_challenge_methods_supported": ["S256"],
#   "dpop_signing_alg_values_supported": ["RS256", "ES256"]
# }

# Step 4: OpenID CertificationツールでFAPI 2.0テストを実行
```

### 3. FAPI 2.0 + DPoP Certification

```bash
# Step 1: FAPI 2.0 + DPoPプロファイルを適用
curl -X PUT https://your-authrim.com/api/admin/settings/profile/fapi-2-dpop \
  -H "Content-Type: application/json"

# Step 2: DPoP検証
# - DPoP proof生成ライブラリを使用
# - すべてのトークンリクエストにDPoPヘッダーを含める

# Step 3: テスト実行前の確認
curl https://your-authrim.com/.well-known/openid-configuration | jq '.dpop_signing_alg_values_supported'

# Step 4: OpenID CertificationツールでFAPI 2.0 + DPoPテストを実行
```

## トラブルシューティング

### 設定が反映されない場合

1. **キャッシュのクリア**: Discovery endpointは5分間キャッシュされます
   ```bash
   # 5分待つか、ワーカーを再デプロイ
   wrangler deploy
   ```

2. **設定の確認**:
   ```bash
   curl -X GET https://your-authrim.com/api/admin/settings
   ```

3. **Discovery metadataの確認**:
   ```bash
   curl https://your-authrim.com/.well-known/openid-configuration | jq .
   ```

### Certificationテストが失敗する場合

#### PAR Required エラー

```bash
# 設定確認
curl https://your-authrim.com/.well-known/openid-configuration | \
  jq '.require_pushed_authorization_requests'

# true になっていることを確認
# false の場合はプロファイルを再適用
curl -X PUT https://your-authrim.com/api/admin/settings/profile/fapi-2 \
  -H "Content-Type: application/json"
```

#### DPoP Required エラー

```bash
# FAPI設定を確認
curl -X GET https://your-authrim.com/api/admin/settings | \
  jq '.settings.fapi'

# requireDpop が true になっていることを確認
```

#### Public Client Rejected エラー

```bash
# FAPI設定を確認
curl -X GET https://your-authrim.com/api/admin/settings | \
  jq '.settings.fapi.allowPublicClients'

# false になっていることを確認（FAPI 2.0では必須）
```

## 参考リンク

- [OpenID Certification](https://www.certification.openid.net/)
- [FAPI 2.0 Specification](https://openid.net/specs/fapi-security-profile-2_0-final.html)
- [RFC 9126: OAuth 2.0 Pushed Authorization Requests](https://www.rfc-editor.org/rfc/rfc9126.html)
- [RFC 9449: OAuth 2.0 Demonstrating Proof of Possession](https://www.rfc-editor.org/rfc/rfc9449.html)
- [RFC 9207: OAuth 2.0 Authorization Server Issuer Identification](https://www.rfc-editor.org/rfc/rfc9207.html)
- [RFC 7636: Proof Key for Code Exchange (PKCE)](https://www.rfc-editor.org/rfc/rfc7636.html)

## まとめ

Authrimは、Admin API経由で簡単にOpenID Connectプロファイルを切り替えることができます：

1. **プロファイル一覧を取得**: `GET /api/admin/settings/profiles`
2. **プロファイルを適用**: `PUT /api/admin/settings/profile/:profileName`
3. **設定を確認**: `GET /.well-known/openid-configuration`
4. **Certificationテストを実行**: https://www.certification.openid.net/

各プロファイルは、対応するOpenID Connect仕様に準拠するように事前設定されており、手動での設定調整は不要です。
