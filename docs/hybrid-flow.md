# Hybrid Flow - OIDC Core 3.3

## 概要

Authrimは、OpenID Connect Core 1.0仕様の3.3節で定義されているHybrid Flowを完全にサポートしています。Hybrid Flowは、Authorization Code FlowとImplicit Flowの利点を組み合わせたフローで、以下の3つのresponse_typeをサポートします：

1. **`code id_token`** - Authorization Codeと ID Tokenを返す
2. **`code token`** - Authorization Codeと Access Tokenを返す
3. **`code id_token token`** - Authorization Code、ID Token、Access Tokenを返す

## 仕様準拠

- **OIDC Core 3.3**: Hybrid Flow
- **OIDC Core 3.3.2.11**: ID Token validation (c_hash, at_hash)
- **OAuth 2.0 Multiple Response Type Encoding Practices**: Fragment encoding

## 使用方法

### 基本的なHybrid Flowリクエスト

```http
GET /authorize?
  response_type=code%20id_token&
  client_id=YOUR_CLIENT_ID&
  redirect_uri=https://example.com/callback&
  scope=openid%20profile%20email&
  state=xyz&
  nonce=abc123
```

### レスポンス

Hybrid Flowでは、レスポンスはデフォルトでfragmentエンコーディングを使用してリダイレクトURIに返されます：

```
https://example.com/callback#
  code=SplxlOBeZQQYbYS6WxSbIA&
  id_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...&
  state=xyz
```

## Response Typeの詳細

### 1. `code id_token`

Authorization Codeと ID Tokenの両方を返します。

**リクエスト例：**
```http
GET /authorize?
  response_type=code%20id_token&
  client_id=YOUR_CLIENT_ID&
  redirect_uri=https://example.com/callback&
  scope=openid%20profile&
  state=xyz&
  nonce=abc123
```

**レスポンス例：**
```
https://example.com/callback#
  code=SplxlOBeZQQYbYS6WxSbIA&
  id_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...&
  state=xyz
```

**ID Tokenのクレーム：**
```json
{
  "iss": "https://your-issuer.com",
  "sub": "user123",
  "aud": "YOUR_CLIENT_ID",
  "exp": 1516239022,
  "iat": 1516235422,
  "auth_time": 1516235400,
  "nonce": "abc123",
  "c_hash": "LDktKdoQak3Pk0cnXxCltA"
}
```

`c_hash`は、Authorization Codeのハッシュ値で、ID Tokenとcodeが同じ発行元であることを検証するために使用されます。

**使用ケース：**
- フロントエンドでユーザー情報をすぐに表示したい場合
- バックエンドでアクセストークンとリフレッシュトークンを取得したい場合

### 2. `code token`

Authorization Codeと Access Tokenの両方を返します。

**リクエスト例：**
```http
GET /authorize?
  response_type=code%20token&
  client_id=YOUR_CLIENT_ID&
  redirect_uri=https://example.com/callback&
  scope=openid%20profile&
  state=xyz&
  nonce=abc123
```

**レスポンス例：**
```
https://example.com/callback#
  code=SplxlOBeZQQYbYS6WxSbIA&
  access_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...&
  token_type=Bearer&
  expires_in=3600&
  state=xyz
```

**使用ケース：**
- フロントエンドでAPIにすぐにアクセスしたい場合
- バックエンドで長期的なアクセス（リフレッシュトークン）が必要な場合

### 3. `code id_token token`

Authorization Code、ID Token、Access Tokenのすべてを返します。

**リクエスト例：**
```http
GET /authorize?
  response_type=code%20id_token%20token&
  client_id=YOUR_CLIENT_ID&
  redirect_uri=https://example.com/callback&
  scope=openid%20profile&
  state=xyz&
  nonce=abc123
```

**レスポンス例：**
```
https://example.com/callback#
  code=SplxlOBeZQQYbYS6WxSbIA&
  id_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...&
  access_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...&
  token_type=Bearer&
  expires_in=3600&
  state=xyz
```

**ID Tokenのクレーム：**
```json
{
  "iss": "https://your-issuer.com",
  "sub": "user123",
  "aud": "YOUR_CLIENT_ID",
  "exp": 1516239022,
  "iat": 1516235422,
  "auth_time": 1516235400,
  "nonce": "abc123",
  "c_hash": "LDktKdoQak3Pk0cnXxCltA",
  "at_hash": "77QmUPtjPfzWtF2AnpK9RQ"
}
```

`at_hash`は、Access Tokenのハッシュ値で、ID TokenとAccess Tokenが同じ発行元であることを検証するために使用されます。

**使用ケース：**
- フロントエンドでユーザー情報を表示し、APIにアクセスしたい場合
- バックエンドで長期的なアクセスが必要な場合
- 最も包括的なHybrid Flow

## Response Mode

Hybrid Flowでは、以下のresponse_modeがサポートされています：

### Fragment (デフォルト)

デフォルトでは、Hybrid FlowはfragmentエンコーディングでレスポンスパラメータをURLフラグメントに含めます。

```
https://example.com/callback#
  code=...&
  id_token=...&
  state=xyz
```

### Form Post

`response_mode=form_post`を指定すると、レスポンスパラメータはPOSTリクエストでクライアントに送信されます。

**リクエスト例：**
```http
GET /authorize?
  response_type=code%20id_token&
  client_id=YOUR_CLIENT_ID&
  redirect_uri=https://example.com/callback&
  scope=openid&
  state=xyz&
  nonce=abc123&
  response_mode=form_post
```

**レスポンス：**
クライアントのredirect_uriに、以下のパラメータを含むHTML formが自動的にPOSTされます：

```html
<form method="post" action="https://example.com/callback">
  <input type="hidden" name="code" value="..." />
  <input type="hidden" name="id_token" value="..." />
  <input type="hidden" name="state" value="xyz" />
</form>
```

### Query (非推奨)

`response_mode=query`は、Hybrid Flowでは推奨されません。セキュリティ上の理由から、トークンはURLクエリパラメータに含めるべきではありません。

## Nonce検証

**重要**: Hybrid FlowおよびImplicit Flowでは、`nonce`パラメータが**必須**です。

```http
GET /authorize?
  response_type=code%20id_token&
  client_id=YOUR_CLIENT_ID&
  redirect_uri=https://example.com/callback&
  scope=openid&
  state=xyz&
  nonce=abc123  ← 必須
```

nonceは、リプレイアタックを防ぐために使用されます。クライアントは、ランダムな値を生成し、リクエストに含める必要があります。ID Tokenのnonceクレームがリクエストのnonceと一致することを確認してください。

### Nonceの生成

```javascript
// ランダムなnonceを生成
const nonce = crypto.randomUUID() + '-' + Date.now();

// Authorization requestに含める
const authUrl = `https://your-issuer.com/authorize?` +
  `response_type=code+id_token&` +
  `client_id=${clientId}&` +
  `redirect_uri=${redirectUri}&` +
  `scope=openid&` +
  `state=${state}&` +
  `nonce=${nonce}`;

// nonceをセッションに保存
sessionStorage.setItem('oauth_nonce', nonce);
```

### Nonceの検証

```javascript
// Callbackでnonceを検証
const idToken = parseJwt(params.id_token);
const savedNonce = sessionStorage.getItem('oauth_nonce');

if (idToken.nonce !== savedNonce) {
  throw new Error('Nonce mismatch');
}

// 検証後、nonceを削除
sessionStorage.removeItem('oauth_nonce');
```

## ハッシュクレーム検証

### c_hash (Code Hash)

`c_hash`は、ID Tokenに含まれるAuthorization Codeのハッシュ値です。以下の場合に含まれます：
- `response_type=code id_token`
- `response_type=code id_token token`

**検証方法：**

```javascript
import { createHash } from 'crypto';

function verifyCHash(code, cHash) {
  // SHA-256でコードをハッシュ化
  const hash = createHash('sha256').update(code).digest();

  // 左半分を取得
  const leftHalf = hash.slice(0, hash.length / 2);

  // Base64url エンコード
  const computed = base64UrlEncode(leftHalf);

  return computed === cHash;
}
```

### at_hash (Access Token Hash)

`at_hash`は、ID Tokenに含まれるAccess Tokenのハッシュ値です。以下の場合に含まれます：
- `response_type=id_token token` (Implicit Flow)
- `response_type=code id_token token` (Hybrid Flow)

**検証方法：**

```javascript
function verifyAtHash(accessToken, atHash) {
  // SHA-256でトークンをハッシュ化
  const hash = createHash('sha256').update(accessToken).digest();

  // 左半分を取得
  const leftHalf = hash.slice(0, hash.length / 2);

  // Base64url エンコード
  const computed = base64UrlEncode(leftHalf);

  return computed === atHash;
}
```

## Token Exchange

Hybrid Flowで取得したAuthorization Codeは、Token Endpointで交換してアクセストークンとリフレッシュトークンを取得できます。

**リクエスト例：**

```http
POST /token
Content-Type: application/x-www-form-urlencoded
Authorization: Basic BASE64(client_id:client_secret)

grant_type=authorization_code&
code=SplxlOBeZQQYbYS6WxSbIA&
redirect_uri=https://example.com/callback
```

**レスポンス例：**

```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "tGzv3JOkF0XG5Qx2TlKWIA",
  "id_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

このトークンは、Authorization Endpointで取得したトークンとは異なる場合がありますが、同じユーザーに対して発行されます。

## セキュリティ考慮事項

### 1. Nonceの使用

Hybrid FlowおよびImplicit Flowでは、nonceが必須です。これにより、リプレイアタックを防ぎます。

### 2. State パラメータ

CSRFアタックを防ぐために、常に`state`パラメータを使用してください。

### 3. ハッシュクレームの検証

`c_hash`と`at_hash`を検証して、ID Tokenと他のトークンが同じ発行元であることを確認してください。

### 4. HTTPS必須

本番環境では、必ずHTTPSを使用してください。トークンがURLフラグメントに含まれるため、TLSによる保護が重要です。

### 5. トークンの保存

- **ID Token**: ローカルストレージまたはセッションストレージに保存可能
- **Access Token**: メモリまたはセッションストレージに保存（できるだけ短時間）
- **Refresh Token**: セキュアなHTTP-onlyクッキーまたはサーバーサイドに保存

### 6. トークンの有効期限

- Authorization Endpointで発行されるAccess Tokenは短命（1時間）
- 長期的なアクセスが必要な場合は、Token Endpointでリフレッシュトークンを取得

## クライアント実装例

### JavaScript/TypeScript

```typescript
// Authorization request
function initiateHybridFlow() {
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();

  // Save state and nonce
  sessionStorage.setItem('oauth_state', state);
  sessionStorage.setItem('oauth_nonce', nonce);

  const params = new URLSearchParams({
    response_type: 'code id_token token',
    client_id: 'YOUR_CLIENT_ID',
    redirect_uri: 'https://example.com/callback',
    scope: 'openid profile email',
    state,
    nonce,
  });

  window.location.href = `https://your-issuer.com/authorize?${params}`;
}

// Callback handler
function handleCallback() {
  // Parse fragment
  const hash = window.location.hash.slice(1);
  const params = new URLSearchParams(hash);

  const code = params.get('code');
  const idToken = params.get('id_token');
  const accessToken = params.get('access_token');
  const state = params.get('state');

  // Validate state
  const savedState = sessionStorage.getItem('oauth_state');
  if (state !== savedState) {
    throw new Error('State mismatch');
  }

  // Validate nonce
  const idTokenPayload = parseJwt(idToken);
  const savedNonce = sessionStorage.getItem('oauth_nonce');
  if (idTokenPayload.nonce !== savedNonce) {
    throw new Error('Nonce mismatch');
  }

  // Validate c_hash
  if (!verifyCHash(code, idTokenPayload.c_hash)) {
    throw new Error('c_hash validation failed');
  }

  // Validate at_hash
  if (accessToken && !verifyAtHash(accessToken, idTokenPayload.at_hash)) {
    throw new Error('at_hash validation failed');
  }

  // Clean up
  sessionStorage.removeItem('oauth_state');
  sessionStorage.removeItem('oauth_nonce');

  // Exchange code for tokens
  exchangeCode(code);
}

// Token exchange
async function exchangeCode(code) {
  const response = await fetch('https://your-issuer.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${btoa('CLIENT_ID:CLIENT_SECRET')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://example.com/callback',
    }),
  });

  const tokens = await response.json();
  // Store tokens securely
  return tokens;
}

// Helper functions
function parseJwt(token) {
  const base64Url = token.split('.')[1];
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const jsonPayload = decodeURIComponent(
    atob(base64)
      .split('')
      .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
      .join('')
  );
  return JSON.parse(jsonPayload);
}
```

## トラブルシューティング

### エラー: "nonce is required for implicit and hybrid flows"

**原因**: Hybrid FlowまたはImplicit Flowのリクエストに`nonce`パラメータが含まれていない。

**解決方法**: リクエストに`nonce`パラメータを追加してください。

```http
GET /authorize?
  response_type=code%20id_token&
  ...
  nonce=YOUR_RANDOM_NONCE
```

### エラー: "Unsupported response_type"

**原因**: サポートされていない`response_type`が指定されている。

**解決方法**: 以下のいずれかを使用してください：
- `code`
- `id_token`
- `id_token token`
- `code id_token`
- `code token`
- `code id_token token`

注意: `response_type`の値はスペース区切りです。URLエンコードすると`+`または`%20`になります。

### c_hash/at_hash の検証失敗

**原因**: ハッシュクレームの計算が正しくない。

**確認事項**:
1. SHA-256アルゴリズムを使用していますか？
2. ハッシュの左半分（16バイト）を取得していますか？
3. Base64url エンコーディング（パディングなし）を使用していますか？

## 参考資料

- [OpenID Connect Core 1.0 - Section 3.3: Hybrid Flow](https://openid.net/specs/openid-connect-core-1_0.html#HybridFlowAuth)
- [OAuth 2.0 Multiple Response Type Encoding Practices](https://openid.net/specs/oauth-v2-multiple-response-types-1_0.html)
- [OpenID Connect Core 1.0 - Section 3.3.2.11: ID Token Validation](https://openid.net/specs/openid-connect-core-1_0.html#HybridIDToken)

## まとめ

Authrimの Hybrid Flow 実装は、OIDC Core 1.0仕様に完全に準拠しており、以下の機能を提供します：

✅ 3つのHybrid Flow response_type (`code id_token`, `code token`, `code id_token token`)
✅ Fragment encoding（デフォルト）
✅ Form Post response mode
✅ Nonce検証（必須）
✅ c_hash および at_hash の生成と検証
✅ セキュアなトークン発行
✅ 包括的なテストカバレッジ

Hybrid Flowを使用することで、フロントエンドでのユーザー情報の即時表示と、バックエンドでの安全なトークン交換の両方を実現できます。
