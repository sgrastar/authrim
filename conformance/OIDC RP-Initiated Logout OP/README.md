# authrim – OpenID Connect RP-Initiated Logout OP Conformance

## Vision & Objectives

**OIDC RP-Initiated Logout OP プロファイル**は、OpenID Connect RP-Initiated Logout 1.0仕様に準拠したログアウト機能を検証する認証プロファイルです。Relying Party（クライアント）が開始するログアウトフローをサポートします。

### 目的
- ✅ RP-Initiated Logout（クライアント開始のログアウト）のサポート
- 🔒 セキュアなセッション終了
- ✅ シングルログアウト（SLO）の基盤
- 🔐 `id_token_hint` による認証済みログアウト
- ✅ `post_logout_redirect_uri` によるログアウト後のリダイレクト

### Use Cases
- **エンタープライズSSO**: 従業員が1つのアプリからログアウトしたら、全アプリからログアウト
- **セキュリティ要件**: ユーザーが明示的にログアウトした場合、すべてのセッションを終了
- **コンプライアンス**: GDPR等の規制に対応するためのセッション管理

---

## Required Features & Behavior

### 1. RP-Initiated Logout (OIDC RP-Initiated Logout 1.0)

| 要件 | 説明 | 仕様参照 |
|:--|:--|:--|
| **Logout Endpoint** | `GET /logout` でログアウトリクエストを受け付ける | RP-Initiated Logout Section 2 |
| **id_token_hint** | ログアウト対象のユーザーを特定するID Token | RP-Initiated Logout Section 2 |
| **post_logout_redirect_uri** | ログアウト後のリダイレクト先URI | RP-Initiated Logout Section 2 |
| **state** | CSRF保護用のstate（オプション） | RP-Initiated Logout Section 2 |
| **Session Termination** | OPのセッションを終了 | RP-Initiated Logout Section 2.1 |
| **Redirect** | ログアウト後、`post_logout_redirect_uri` にリダイレクト | RP-Initiated Logout Section 2.2 |

### 2. Logout Request Parameters

**Query Parameters:**

| Parameter | Required | 説明 |
|:--|:--|:--|
| `id_token_hint` | **Recommended** | ログアウト対象ユーザーのID Token（JWT） |
| `post_logout_redirect_uri` | Optional | ログアウト後のリダイレクト先（事前登録必須） |
| `state` | Optional | CSRF保護用のstate値 |
| `client_id` | Optional | クライアントID（`id_token_hint`がない場合に使用） |
| `logout_hint` | Optional | ユーザー識別のヒント（`id_token_hint`の代替） |
| `ui_locales` | Optional | ログアウトUIの言語設定 |

**Example Request:**
```
GET /logout?
  id_token_hint=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...&
  post_logout_redirect_uri=https://client.example.com/logged-out&
  state=STATE_VALUE
```

### 3. Logout Response

**Successful Logout:**
- OPセッションを終了
- `post_logout_redirect_uri` が指定されている場合、そこにリダイレクト
- `state` パラメータがあれば、リダイレクト先に引き継ぐ

**Redirect Example:**
```
HTTP/1.1 302 Found
Location: https://client.example.com/logged-out?state=STATE_VALUE
```

**No redirect_uri:**
- OPのデフォルトログアウトページを表示

### 4. Validation Rules

| 検証項目 | ルール | 仕様参照 |
|:--|:--|:--|
| **id_token_hint** | 有効なJWT署名を検証 | RP-Initiated Logout Section 2 |
| **id_token_hint - iss** | Issuerが自OPと一致 | JWT Validation |
| **id_token_hint - aud** | 対象クライアントが登録済み | JWT Validation |
| **id_token_hint - exp** | 有効期限内（または許容範囲） | JWT Validation |
| **post_logout_redirect_uri** | クライアントの登録URIと一致 | RP-Initiated Logout Section 2 |
| **client_id** | `id_token_hint`のaud/client_idと一致 | RP-Initiated Logout Section 2 |

### 5. Session Management

| 要件 | 説明 | 仕様参照 |
|:--|:--|:--|
| **Session Cookie Deletion** | OPのセッションCookieを削除 | RP-Initiated Logout Section 2.1 |
| **Session Store Cleanup** | Durable Objectsのセッションを削除 | - |
| **Token Revocation** | 関連するAccess/Refresh Tokenを無効化（オプション） | RFC 7009 |

### 6. Discovery Metadata

| Field | Value | 説明 |
|:--|:--|:--|
| `end_session_endpoint` | `/logout` | RP-Initiated Logout endpoint |
| `post_logout_redirect_uris_supported` | `true` (implied) | post_logout_redirect_uriのサポート |

---

## Authrim Implementation Status

### ✅ RP-Initiated Logout (Phase 5)

| 機能 | Status | Implementation |
|:--|:--|:--|
| Logout Endpoint | ✅ | `GET /logout` in `op-auth` Worker |
| id_token_hint validation | ✅ | JWT signature verification |
| post_logout_redirect_uri | ✅ | Validation against client metadata |
| state parameter | ✅ | CSRF protection |
| Session termination | ✅ | SessionStore Durable Object cleanup |
| Cookie deletion | ✅ | Set-Cookie with Max-Age=0 |
| Token revocation | ⚙️ | Partial (can be enhanced) |
| Discovery metadata | ✅ | `end_session_endpoint` in `.well-known/openid-configuration` |

### Request Parameter Support

| Parameter | Status | Validation |
|:--|:--|:--|
| `id_token_hint` | ✅ | JWT verification, iss/aud/exp validation |
| `post_logout_redirect_uri` | ✅ | Must match client's registered URIs |
| `state` | ✅ | Passed through to redirect |
| `client_id` | ✅ | Used if id_token_hint absent |
| `logout_hint` | ⚙️ | Partial support |
| `ui_locales` | ⚙️ | Planned (UI localization) |

### Session Management

| 機能 | Status | Implementation |
|:--|:--|:--|
| Session Cookie deletion | ✅ | Set-Cookie: session=; Max-Age=0 |
| Durable Objects cleanup | ✅ | SessionStore.deleteSession() |
| Active token tracking | ✅ | KV-based token storage |
| Token revocation | ⚙️ | Can call /revoke endpoint |
| Multi-device logout | ⚙️ | Planned (Phase 6) |

### Error Handling

| Error Case | Response | Status |
|:--|:--|:--|
| Invalid id_token_hint | 400 Bad Request | ✅ |
| Invalid post_logout_redirect_uri | 400 Bad Request | ✅ |
| Client not found | 400 Bad Request | ✅ |
| Session not found | Success (idempotent) | ✅ |

### Implementation Details

**Phase 5: RP-Initiated Logout** (Completed)
- ✅ `op-auth` Worker
- ✅ `GET /logout` endpoint
- ✅ id_token_hint validation
- ✅ SessionStore Durable Object integration
- ✅ post_logout_redirect_uri validation
- ✅ Discovery metadata update

**Workers:**
- `packages/op-auth/src/index.ts` - Logout endpoint
- `packages/shared/src/durable-objects/SessionStore.ts` - Session cleanup

**KV Namespaces:**
- `SESSIONS` - User session tracking (Durable Objects)
- `ACCESS_TOKENS` - Active token tracking
- `REFRESH_TOKENS` - Refresh token tracking

**Discovery Metadata:**
```json
{
  "end_session_endpoint": "https://authrim.YOUR_SUBDOMAIN.workers.dev/logout"
}
```

---

## Related Specifications

| Specification | Title | Status |
|:--|:--|:--|
| **OIDC RP-Initiated Logout 1.0** | OpenID Connect RP-Initiated Logout 1.0 | ✅ Implemented |
| **RFC 7009** | OAuth 2.0 Token Revocation | ⚙️ Partial (can be integrated) |
| **OIDC Session Management 1.0** | OpenID Connect Session Management 1.0 | ⚙️ Partial (basic session support) |

**Primary References:**
- [OIDC RP-Initiated Logout 1.0](https://openid.net/specs/openid-connect-rpinitiated-1_0.html)
- [RFC 7009 - Token Revocation](https://datatracker.ietf.org/doc/html/rfc7009)

---

## Testing Plan

### OpenID Conformance Suite

**Test Profile:**
- **Name:** OpenID Connect RP-Initiated Logout OP
- **Purpose:** Verify RP-Initiated Logout functionality

**Test URL:**
https://www.certification.openid.net/

**Configuration:**
```bash
# Test Configuration
Issuer: https://authrim.YOUR_SUBDOMAIN.workers.dev
Logout Endpoint: https://authrim.YOUR_SUBDOMAIN.workers.dev/logout

# Discovery will auto-configure end_session_endpoint
```

### Test Procedure

1. **Deploy Authrim**
   ```bash
   pnpm run deploy
   ```

2. **Verify Logout Endpoint - Basic**
   ```bash
   # 1. First, authenticate and get an ID Token
   # (Use Authorization Code Flow)

   # 2. Logout with id_token_hint
   curl "https://authrim.YOUR_SUBDOMAIN.workers.dev/logout?id_token_hint=ID_TOKEN"

   # 3. Verify session is terminated
   # (Try accessing /userinfo with old access_token - should fail)
   ```

3. **Verify Logout with Redirect**
   ```bash
   # Logout with post_logout_redirect_uri
   curl -i "https://authrim.YOUR_SUBDOMAIN.workers.dev/logout?\
     id_token_hint=ID_TOKEN&\
     post_logout_redirect_uri=https://client.example.com/logged-out&\
     state=STATE_VALUE"

   # Verify 302 redirect to post_logout_redirect_uri with state
   ```

4. **Verify Discovery Metadata**
   ```bash
   curl https://authrim.YOUR_SUBDOMAIN.workers.dev/.well-known/openid-configuration | \
     jq '.end_session_endpoint'

   # Expected: "https://authrim.YOUR_SUBDOMAIN.workers.dev/logout"
   ```

5. **Run Conformance Tests**
   - Access OpenID Conformance Suite
   - Create test plan: **OpenID Connect Provider → RP-Initiated Logout OP**
   - Configure Issuer URL
   - Execute all tests

### Expected Test Coverage

| Test Category | Description | Expected |
|:--|:--|:--|
| Logout Endpoint | /logout availability | ✅ Pass |
| id_token_hint Validation | JWT verification | ✅ Pass |
| post_logout_redirect_uri | Redirect after logout | ✅ Pass |
| state Parameter | CSRF protection | ✅ Pass |
| Session Termination | Session cleanup | ✅ Pass |
| Cookie Deletion | Session cookie removal | ✅ Pass |
| Discovery Metadata | end_session_endpoint | ✅ Pass |
| Invalid id_token_hint | Error handling | ✅ Pass |
| Invalid redirect_uri | Error handling | ✅ Pass |

**Note:** Specific test results will be recorded after individual testing.

---

## Future Enhancements

### Back-Channel Logout (Phase 7)

**Not yet implemented:**
- [ ] Back-Channel Logout endpoint
- [ ] Logout Token generation (JWT)
- [ ] Notification to all RPs with active sessions
- [ ] `backchannel_logout_uri` support

### Front-Channel Logout (Phase 7)

**Not yet implemented:**
- [ ] Front-Channel Logout iframe
- [ ] Logout notification via iframe
- [ ] `frontchannel_logout_uri` support

### Advanced Session Management

**Planned improvements:**
- [ ] Multi-device logout (Phase 6)
- [ ] Automatic token revocation on logout
- [ ] Session activity tracking
- [ ] Forced logout by admin

---

## Certification Roadmap

### Current Status
- ✅ **Phase 5 Complete**: RP-Initiated Logout implemented
- ✅ **Ready for Testing**: Core logout functionality complete

### Next Steps

#### Step 1: Individual Testing
- [ ] Run OpenID RP-Initiated Logout OP conformance tests
- [ ] Record test results in this README
- [ ] Identify any issues or gaps

#### Step 2: Address Issues
- [ ] Fix any conformance test failures
- [ ] Enhance error handling if needed
- [ ] Improve session cleanup if needed

#### Step 3: Certification
- [ ] Submit for OpenID Certified™ RP-Initiated Logout OP
- [ ] Document certification process
- [ ] Publish certification badge

#### Future: Advanced Logout (Phase 7)
- [ ] Implement Back-Channel Logout
- [ ] Implement Front-Channel Logout
- [ ] Multi-RP logout coordination

---

## Related Documents

- [OIDC Basic OP](../OIDC%20Basic%20OP/README.md) - Basic OP profile conformance
- [OIDC Config OP](../OIDC%20Config%20OP/README.md) - Discovery configuration conformance
- [Test Plan](../OIDC%20Basic%20OP/test-plan.md) - Overall conformance testing strategy
- [Project README](../../README.md) - Authrim project overview
- [Session Management Architecture](../../architecture/session-management.md) - Durable Objects session design

---

> **Status:** ✅ Implementation Complete – Ready for Individual Testing
> **Last Updated:** 2025-11-18
