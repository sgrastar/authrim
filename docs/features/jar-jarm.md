# JAR (JWT-Secured Authorization Request) と JARM (JWT-Secured Authorization Response Mode)

このドキュメントでは、Authrim の JAR と JARM の実装について説明します。

## 概要

### JAR (JWT-Secured Authorization Request) - RFC 9101

JAR は、Authorization Request のパラメータを JWT として署名・暗号化することで、セキュリティを強化する仕様です。

### JARM (JWT-Secured Authorization Response Mode)

JARM は、Authorization Response を JWT として署名・暗号化することで、レスポンスの完全性と機密性を保証する仕様です。

## JAR (JWT-Secured Authorization Request)

### 実装済み機能

#### 1. `request` パラメータ (RFC 9101)

Authorization Request に JWT 形式の Request Object を含めることができます。

```http
GET /authorize?
  client_id=client123&
  response_type=code&
  request=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
```

**サポートされる署名アルゴリズム:**
- `RS256` - RSA 署名（推奨）
- `none` - 署名なし（開発環境のみ）

#### 2. `request_uri` パラメータ (RFC 9101)

Request Object を URL 経由で取得できます。

**PAR (Pushed Authorization Request) の場合:**
```http
GET /authorize?
  client_id=client123&
  request_uri=urn:ietf:params:oauth:request_uri:abc123
```

**HTTPS URL の場合:**
```http
GET /authorize?
  client_id=client123&
  request_uri=https://client.example.com/request/xyz789
```

#### 3. Request Object の JWE 暗号化

Request Object を JWE 形式で暗号化できます（5 パート形式）。

**サポートされる暗号化アルゴリズム:**
- **alg (鍵管理):** RSA-OAEP, RSA-OAEP-256, ECDH-ES, ECDH-ES+A128KW, ECDH-ES+A192KW, ECDH-ES+A256KW
- **enc (コンテンツ暗号化):** A128GCM, A192GCM, A256GCM, A128CBC-HS256, A192CBC-HS384, A256CBC-HS512

**処理フロー:**
1. JWE を検出（5 パート形式）
2. サーバーの秘密鍵で復号化
3. 内部の JWT を検証（ネストされている場合）
4. パラメータを抽出

#### 4. クライアント公開鍵による署名検証

Request Object の署名は、クライアントが登録した公開鍵で検証されます。

**公開鍵の取得方法:**

1. **クライアント登録時の `jwks` フィールド:**
```json
{
  "client_id": "client123",
  "jwks": {
    "keys": [
      {
        "kty": "RSA",
        "use": "sig",
        "kid": "key1",
        "n": "...",
        "e": "AQAB"
      }
    ]
  }
}
```

2. **`jwks_uri` からの動的取得:**
```json
{
  "client_id": "client123",
  "jwks_uri": "https://client.example.com/.well-known/jwks.json"
}
```

### Request Object の例

**JWT ヘッダー:**
```json
{
  "alg": "RS256",
  "typ": "JWT"
}
```

**JWT ペイロード:**
```json
{
  "iss": "https://op.example.com",
  "aud": "client123",
  "response_type": "code",
  "client_id": "client123",
  "redirect_uri": "https://client.example.com/callback",
  "scope": "openid profile email",
  "state": "abc123",
  "nonce": "xyz789",
  "code_challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  "code_challenge_method": "S256"
}
```

## JARM (JWT-Secured Authorization Response Mode)

### 実装済み機能

#### 1. JWT 形式の Response Mode

**サポートされる Response Mode:**
- `query.jwt` - URL クエリパラメータとして JWT を返す
- `fragment.jwt` - URL フラグメントとして JWT を返す
- `form_post.jwt` - HTML フォーム POST として JWT を返す
- `jwt` - ジェネリック JWT モード（flow に応じて自動選択）

**使用例:**
```http
GET /authorize?
  response_type=code&
  client_id=client123&
  redirect_uri=https://client.example.com/callback&
  scope=openid&
  response_mode=query.jwt
```

#### 2. Response JWT の署名

Authorization Response は、サーバーの秘密鍵で署名された JWT として返されます。

**JWT ペイロード例:**
```json
{
  "iss": "https://op.example.com",
  "aud": "client123",
  "exp": 1234567890,
  "iat": 1234567290,
  "code": "abc123...",
  "state": "xyz789"
}
```

**レスポンス形式 (query.jwt の場合):**
```http
HTTP/1.1 302 Found
Location: https://client.example.com/callback?response=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### 3. Response JWT の暗号化（オプション）

クライアントが暗号化を要求した場合、署名済み JWT をさらに暗号化します。

**クライアント設定:**
```json
{
  "client_id": "client123",
  "authorization_signed_response_alg": "RS256",
  "authorization_encrypted_response_alg": "RSA-OAEP",
  "authorization_encrypted_response_enc": "A256GCM"
}
```

**処理フロー:**
1. Authorization Response パラメータを JWT ペイロードとして構築
2. サーバーの秘密鍵で JWT を署名
3. クライアントが暗号化を要求している場合、クライアントの公開鍵で JWE に暗号化
4. `response` パラメータとして返す

### JARM レスポンスの検証（クライアント側）

```javascript
// 1. response パラメータを取得
const params = new URLSearchParams(window.location.search);
const responseJWT = params.get('response');

// 2. JWT の検証
const publicKey = await getOPPublicKey(); // OP の公開鍵を取得
const verified = await jose.jwtVerify(responseJWT, publicKey, {
  issuer: 'https://op.example.com',
  audience: 'client123'
});

// 3. 暗号化されている場合は復号化
if (isJWE(responseJWT)) {
  const privateKey = await getClientPrivateKey();
  const decrypted = await jose.compactDecrypt(responseJWT, privateKey);
  // ... デコードと検証
}

// 4. Authorization Code を取得
const code = verified.payload.code;
const state = verified.payload.state;
```

## Discovery メタデータ

JAR/JARM のサポートは、Discovery エンドポイントで確認できます。

```http
GET /.well-known/openid-configuration
```

**レスポンス例:**
```json
{
  "issuer": "https://op.example.com",
  "request_parameter_supported": true,
  "request_uri_parameter_supported": true,
  "request_object_signing_alg_values_supported": ["RS256", "none"],
  "request_object_encryption_alg_values_supported": ["RSA-OAEP", "RSA-OAEP-256", ...],
  "request_object_encryption_enc_values_supported": ["A128GCM", "A256GCM", ...],
  "response_modes_supported": [
    "query",
    "fragment",
    "form_post",
    "query.jwt",
    "fragment.jwt",
    "form_post.jwt",
    "jwt"
  ],
  "authorization_signing_alg_values_supported": ["RS256"],
  "authorization_encryption_alg_values_supported": ["RSA-OAEP", "RSA-OAEP-256", ...],
  "authorization_encryption_enc_values_supported": ["A128GCM", "A256GCM", ...]
}
```

## セキュリティ考慮事項

### JAR

1. **署名検証:** 本番環境では、必ずクライアントの公開鍵で Request Object の署名を検証してください
2. **暗号化の推奨:** 機密性の高いパラメータを含む場合は、JWE 暗号化を使用してください
3. **request_uri の検証:** HTTPS URL からの Request Object 取得時は、TLS 証明書を検証してください
4. **再生攻撃対策:** Request Object に `exp` (有効期限) を含めることを推奨します

### JARM

1. **署名の必須化:** すべての Authorization Response は署名されます
2. **暗号化の推奨:** 機密性の高いレスポンス（アクセストークンを含む）には暗号化を使用してください
3. **JWT の検証:** クライアント側で必ず `iss` (issuer) と `aud` (audience) を検証してください
4. **短い有効期限:** Response JWT は 10 分の有効期限を持ちます（デフォルト）

## エラーハンドリング

### JAR エラー

| エラーコード | 説明 |
|------------|------|
| `invalid_request_object` | Request Object の形式が不正 |
| `invalid_request_object` | JWT の検証に失敗 |
| `invalid_request_uri` | request_uri の取得に失敗 |
| `server_error` | サーバー設定エラー（秘密鍵未設定など） |

### JARM エラー

| エラーコード | 説明 |
|------------|------|
| `server_error` | Response JWT の生成に失敗 |
| `invalid_client` | クライアント情報の取得に失敗 |

## 実装ファイル

### JAR 関連

- `/packages/op-auth/src/authorize.ts` - Request Object 処理（行 281-505）
- `/packages/shared/src/utils/jwt.ts` - JWT ユーティリティ
- `/packages/shared/src/utils/jwe.ts` - JWE ユーティリティ

### JARM 関連

- `/packages/op-auth/src/authorize.ts` - JARM レスポンス生成（行 1610-1641, 1804-1924）
- `/packages/op-discovery/src/discovery.ts` - Discovery メタデータ（行 88-106）

### 型定義

- `/packages/shared/src/types/oidc.ts` - ClientMetadata, OIDCProviderMetadata

## 参考資料

- [RFC 9101: The OAuth 2.0 Authorization Framework: JWT-Secured Authorization Request (JAR)](https://datatracker.ietf.org/doc/html/rfc9101)
- [JARM: JWT-Secured Authorization Response Mode for OAuth 2.0](https://openid.net/specs/oauth-v2-jarm.html)
- [RFC 7516: JSON Web Encryption (JWE)](https://datatracker.ietf.org/doc/html/rfc7516)
- [RFC 7519: JSON Web Token (JWT)](https://datatracker.ietf.org/doc/html/rfc7519)
