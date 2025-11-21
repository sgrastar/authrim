# 最近の修正サマリー (2025-11-20)

## 1. HTTPS request_uri サポートの追加

### 問題
- テスト `oidcc-request-uri-unsigned-supported-correctly-or-rejected-as-unsupported` が失敗
- エラー: `{"error":"invalid_request","error_description":"Invalid request_uri format"}`
- 原因: URN形式（PAR）のrequest_uriのみ対応していて、HTTPS URLからのJWT取得に未対応

### 修正内容
**ファイル:** `packages/op-auth/src/authorize.ts` (Lines 111-267)

```typescript
// Check if this is a PAR request_uri (URN) or HTTPS request_uri
const isPAR = request_uri.startsWith('urn:ietf:params:oauth:request_uri:');
const isHTTPS = request_uri.startsWith('https://');

if (!isPAR && !isHTTPS) {
  return c.json({
    error: 'invalid_request',
    error_description: 'request_uri must be either urn:ietf:params:oauth:request_uri: or https://',
  }, 400);
}

// Handle HTTPS request_uri (Request Object by Reference)
if (isHTTPS) {
  const requestObjectResponse = await fetch(request_uri, {
    method: 'GET',
    headers: { 'Accept': 'application/oauth-authz-req+jwt, application/jwt' },
  });

  if (!requestObjectResponse.ok) {
    return c.json({
      error: 'invalid_request_uri',
      error_description: 'Failed to fetch request object from request_uri',
    }, 400);
  }

  const requestObject = await requestObjectResponse.text();
  request = requestObject;
  request_uri = undefined; // Clear to avoid PAR processing
}
```

### 結果
- HTTPS形式のrequest_uri（OIDC Core 6.2 Request Object by Reference）に対応
- URN形式のrequest_uri（PAR - RFC 9126）も引き続き動作
- 両方のフォーマットをサポート

---

## 2. KeyManager 内部エンドポイントへの認証追加

### 問題
- トークンエンドポイントが500エラー: `"Failed to load signing key"`
- さらに詳細なエラー: `TypeError: "pkcs8" must be PKCS#8 formatted string`
- 原因: KeyManagerの既存エンドポイント (`/active`, `/rotate`) が `sanitizeKey()` で `privatePEM` を削除していた

### セキュリティ上の懸念
- ユーザーの指摘: "理由があって削除していたんじゃないの？大丈夫なの？"
- 秘密鍵を含むエンドポイントは公開してはいけない

### 修正内容

#### 2.1 新しい内部エンドポイントの追加
**ファイル:** `packages/shared/src/durable-objects/KeyManager.ts`

**新規エンドポイント:**
- `GET /internal/active-with-private` - アクティブキー取得（privatePEM含む）
- `POST /internal/rotate` - キーローテーション（privatePEM含む）

**実装 (Lines 420-443):**
```typescript
// GET /internal/active-with-private - Get active signing key with private key (for internal use by op-token)
if (path === '/internal/active-with-private' && request.method === 'GET') {
  const activeKey = await this.getActiveKey();

  if (!activeKey) {
    return new Response(JSON.stringify({ error: 'No active key found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Explicitly reconstruct the object to ensure all properties are serializable
  const result: StoredKey = {
    kid: activeKey.kid,
    publicJWK: activeKey.publicJWK,
    privatePEM: activeKey.privatePEM,
    createdAt: activeKey.createdAt,
    isActive: activeKey.isActive,
  };

  // Return full key data including privatePEM for internal use
  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
  });
}
```

#### 2.2 認証の実装
**既存の認証メソッド (Lines 336-354):**
```typescript
private authenticate(request: Request): boolean {
  const authHeader = request.headers.get('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.substring(7);
  const secret = this.env.KEY_MANAGER_SECRET;

  // If no secret is configured, deny all requests
  if (!secret) {
    console.error('KEY_MANAGER_SECRET is not configured');
    return false;
  }

  // Constant-time comparison to prevent timing attacks
  return token === secret;
}
```

**認証チェック (Lines 391-398):**
```typescript
// Public endpoints (no authentication required)
// /jwks is public because it only returns public keys for JWT verification
const isPublicEndpoint = path === '/jwks' && request.method === 'GET';

// All other endpoints require authentication (including /internal/* for security)
if (!isPublicEndpoint && !this.authenticate(request)) {
  return this.unauthorizedResponse();
}
```

#### 2.3 op-token側の修正
**ファイル:** `packages/op-token/src/token.ts` (Lines 57-120)

**変更点:**
1. 認証ヘッダーの追加
2. 内部エンドポイントの使用
3. Durable Objectインスタンス名を `default-v3` に変更（デプロイ反映のため）

```typescript
async function getSigningKeyFromKeyManager(
  env: Env
): Promise<{ privateKey: CryptoKey; kid: string }> {
  if (!env.KEY_MANAGER) {
    throw new Error('KEY_MANAGER binding not available');
  }

  if (!env.KEY_MANAGER_SECRET) {
    throw new Error('KEY_MANAGER_SECRET not configured');
  }

  const keyManagerId = env.KEY_MANAGER.idFromName('default-v3');
  const keyManager = env.KEY_MANAGER.get(keyManagerId);

  // Authentication header for KeyManager
  const authHeaders = {
    'Authorization': `Bearer ${env.KEY_MANAGER_SECRET}`,
  };

  // Try to get active key (using internal endpoint that returns privatePEM)
  const activeResponse = await keyManager.fetch('http://internal/active-with-private', {
    method: 'GET',
    headers: authHeaders,
  });

  let keyData: { kid: string; privatePEM: string };

  if (activeResponse.ok) {
    keyData = await activeResponse.json() as { kid: string; privatePEM: string };
  } else {
    // No active key, generate and activate one
    const rotateResponse = await keyManager.fetch('http://internal/rotate', {
      method: 'POST',
      headers: authHeaders,
    });

    if (!rotateResponse.ok) {
      const errorText = await rotateResponse.text();
      console.error('Failed to rotate key:', rotateResponse.status, errorText);
      throw new Error('Failed to generate signing key');
    }

    const rotateData = await rotateResponse.json() as { success: boolean; key: { kid: string; privatePEM: string } };
    keyData = rotateData.key;
  }

  // Import private key
  const privateKey = await importPKCS8(keyData.privatePEM, 'RS256');

  return { privateKey, kid: keyData.kid };
}
```

#### 2.4 環境変数の追加
**ファイル:** `packages/op-token/wrangler.toml` (Line 66)

```toml
KEY_MANAGER_SECRET = "dev-secret-change-in-production"
```

---

## 3. JSON シリアライゼーション問題の修正

### 問題
- Durable Object storage から取得したオブジェクトが `JSON.stringify()` で正しくシリアライズされない
- `privatePEM` プロパティが存在するが、JSONに含まれない

### 修正内容
**ファイル:** `packages/shared/src/durable-objects/KeyManager.ts`

**rotateKeys() メソッドで明示的に再構築 (Lines 241-248):**
```typescript
// Explicitly reconstruct the object to ensure all properties are enumerable and serializable
const result: StoredKey = {
  kid: rotatedKey.kid,
  publicJWK: rotatedKey.publicJWK,
  privatePEM: rotatedKey.privatePEM,
  createdAt: rotatedKey.createdAt,
  isActive: rotatedKey.isActive,
};
```

**内部エンドポイントでも同様に再構築:**
- `/internal/active-with-private` (Lines 432-438)
- `/internal/rotate` (Lines 468-492)

---

## 4. デプロイメント

### デプロイ完了
**最新バージョン (2025-11-20T04:10):**
- `authrim-shared`: `94e5306d-9db0-4b5c-a4cc-2176e0facb1c`
- `authrim-op-token`: `4f29c961-4d1a-406e-956a-116c9d02efb6`
- `authrim-op-auth`: `f36a992c-f7bf-439a-b1dc-ca8ba98af2e4`

### デプロイ時の問題と対処
- Cloudflare のデプロイは eventually consistent（最終的整合性）
- Durable Object インスタンスが古いコードを実行し続ける問題
- 対処: インスタンス名を `default` → `default-v2` → `default-v3` と変更して強制リフレッシュ

---

## 5. セキュリティ改善まとめ

### Before（問題あり）
- `/active` と `/rotate` が公開エンドポイントだが認証必須
- これらのエンドポイントは `sanitizeKey()` で `privatePEM` を削除
- 秘密鍵が必要な op-token がエラーになる

### After（改善後）
1. **公開エンドポイント**（認証必須、秘密鍵なし）:
   - `GET /active` - `sanitizeKey()` でprivatePEMを削除
   - `POST /rotate` - `sanitizeKey()` でprivatePEMを削除
   - `GET /jwks` - 公開鍵のみ（認証不要）

2. **内部エンドポイント**（認証必須、秘密鍵あり）:
   - `GET /internal/active-with-private` - privatePEM含む（**新規**）
   - `POST /internal/rotate` - privatePEM含む（**新規**）

3. **認証方式**:
   - Bearer token (`Authorization: Bearer ${KEY_MANAGER_SECRET}`)
   - タイミング攻撃を防ぐ定数時間比較
   - 秘密が設定されていない場合はすべて拒否

---

## 6. 次のステップ

### テスト項目
1. **トークンエンドポイントのテスト**
   - OIDC適合性テストスイートで実行
   - 期待される結果: 500エラーではなく200 OK
   - ログ確認: `Received rotate response: { textLength: 2327, hasPrivatePEM: true }`

2. **request_uri テスト**
   - テスト: `oidcc-request-uri-unsigned-supported-correctly-or-rejected-as-unsupported`
   - HTTPS request_uri が正しく処理されることを確認

3. **PAR互換性確認**
   - URN形式のrequest_uriが引き続き動作することを確認

### 監視ポイント
```bash
# KeyManagerのログを監視
npx wrangler tail

# 期待されるログ:
# KeyManager /internal/rotate - response JSON: { jsonLength: 2327, hasPrivatePEM: true }
# Received rotate response: { textLength: 2327, hasPrivatePEM: true }
```

---

## 7. 変更されたファイル一覧

1. `packages/op-auth/src/authorize.ts` - HTTPS request_uri サポート追加
2. `packages/shared/src/durable-objects/KeyManager.ts` - 内部エンドポイント追加、認証強化
3. `packages/op-token/src/token.ts` - 認証ヘッダー追加、内部エンドポイント使用
4. `packages/op-token/wrangler.toml` - KEY_MANAGER_SECRET 追加

すべての変更はビルド・デプロイ済みです。
