# OIDC Conformance Test Report

**実行日:** 2025-11-30
**目的:** 4つの代表的なテストを実行し、主要なバグを特定する

---

## エグゼクティブサマリー

| テストプラン | パス率 | 通過 | 失敗 | 警告 | スキップ |
|-------------|--------|------|------|------|----------|
| OIDC Basic OP | 78.95% | 30 | 2 | 1 | 1 |
| OIDC Implicit OP | 91.38% | 53 | 2 | 0 | 0 |
| OIDC Hybrid OP | 81.37% | 83 | 6 | 3 | 0 |
| OIDC Dynamic OP (code) | 17.39% | 4 | 11 | 1 | 1 |

**総合評価:** Basic/Implicit/Hybridフローは高いパス率を達成。Dynamicプロファイルは`private_key_jwt`認証に重大な問題あり。

---

## 1. OIDC Basic OP Certification

**Plan ID:** akkSb8eWeHpwc
**実行時刻:** 2025-11-29T22:11:08.605Z
**テスト数:** 38

### 結果詳細

#### ✅ 通過したテスト (30件)

| テストID | テスト名 |
|----------|----------|
| UWZ79GIPnvhHXua | oidcc-server |
| tK3ov3gMzN9tvzJ | oidcc-idtoken-signature |
| dTRIakTRYR6vDu5 | oidcc-userinfo-get |
| R6bgvTZUMoSXJJA | oidcc-userinfo-post-header |
| KnvBnZbDiyedS3W | oidcc-userinfo-post-body |
| csmL5eZJZqMuAAn | oidcc-ensure-request-without-nonce-succeeds-for-code-flow |
| lyjDqJh2xoU5cRd | oidcc-scope-profile |
| tWFo6Cr13y57JyI | oidcc-scope-email |
| FGwCu438Y9tYCex | oidcc-scope-address |
| HPIQKP2Pj9wfVEk | oidcc-scope-phone |
| NAMqrtS0Mi2wJE2 | oidcc-scope-all |
| CoQq4BIn8oZ5eD0 | oidcc-ensure-other-scope-order-succeeds |
| i5onNfvwtIPuCwc | oidcc-display-page |
| 1TK3YbfNzNa5xYd | oidcc-display-popup |
| JuBNrZkzDvzyaD8 | oidcc-prompt-none-not-logged-in |
| 7sUehB68nbNrmG8 | oidcc-prompt-none-logged-in |
| guxiIEOsDXPkeBS | oidcc-ensure-request-with-unknown-parameter-succeeds |
| fViNyGRBcNKbGzT | oidcc-id-token-hint |
| P0e4GT9y4oBrg22 | oidcc-login-hint |
| qhDqT5ffBpP29GA | oidcc-ui-locales |
| wRUCL4ZkbPeh9sQ | oidcc-claims-locales |
| 5MNy1jolRjUrV8m | oidcc-ensure-request-with-acr-values-succeeds |
| QXO43965PHEDaG1 | oidcc-codereuse |
| yEw5EYWljNfUgCB | oidcc-ensure-post-request-succeeds |
| eG1uVVtdmxJTEZW | oidcc-server-client-secret-post |
| FmkrQJos4nn0S74 | oidcc-request-uri-unsigned-supported-correctly-or-rejected-as-unsupported |
| 6ukltCOUtmWNuxB | oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported |
| JZh83GwGpGL6yuY | oidcc-claims-essential |
| eqYaY1CA7Zcjn0r | oidcc-refresh-token |
| lfmB8n2Avg29s42 | oidcc-ensure-request-with-valid-pkce-succeeds |

#### ❌ 失敗したテスト (2件)

| テストID | テスト名 | 原因 | 分類 |
|----------|----------|------|------|
| oidcc-max-age-10000 | oidcc-max-age-10000 | 不明 | 要調査 |
| kH5IQ6nb5aLSY9d | oidcc-ensure-request-object-with-redirect-uri | runInBackground called after runFinalisation | テストランナーエラー |

#### ⚠️ 警告 (1件)

| テストID | テスト名 | 条件 | メッセージ |
|----------|----------|------|-----------|
| o0rI8RcLTMh6BMT | oidcc-codereuse-30seconds | EnsureHttpStatusCodeIs4xx | resourceendpoint returned a different http status than expected |

#### 👀 レビュー待ち (4件)

- nPk7T54CrhGTmXr: oidcc-response-type-missing
- u6lj4kypX6WU2nV: oidcc-prompt-login
- Zdymv5JGXfhiqxh: oidcc-max-age-1
- uipSYwAkGCNNafH: oidcc-ensure-registered-redirect-uri

---

## 2. OIDC Implicit OP Certification

**Plan ID:** 5ytteGe8lJWEj
**実行時刻:** 2025-11-29T22:37:00.877Z
**テスト数:** 58

### 結果詳細

#### ✅ 通過したテスト (53件)

主要なテストカテゴリ:
- **サーバー基本機能:** oidcc-server (2回)
- **ID Token署名:** oidcc-idtoken-signature (2回)
- **スコープ処理:** profile, email, address, phone, all (各2回)
- **表示モード:** page, popup (各2回)
- **プロンプト処理:** login, none-not-logged-in, none-logged-in
- **max-age処理:** max-age-1, max-age-10000
- **UserInfo:** get, post-header, post-body
- **その他:** claims-essential, request-object, request-uri

#### ❌ 失敗したテスト (2件)

| テストID | テスト名 | 原因 | 分類 |
|----------|----------|------|------|
| e1NBtltKGChqSeR | oidcc-ensure-request-without-nonce-fails | Illegal test state change: FINISHED -> RUNNING | テストランナーエラー |
| nq8Mq7C2LJ7HMnS | oidcc-ensure-request-without-nonce-fails | Illegal test state change: FINISHED -> RUNNING | テストランナーエラー |

**注:** これらはOPのバグではなく、Conformance Suiteのテストランナーの問題です。OPは正しくnonceなしリクエストを拒否しています。

---

## 3. OIDC Hybrid OP Certification

**Plan ID:** qc6eaFCIL8Ifu
**実行時刻:** 2025-11-29T23:11:54.952Z
**テスト数:** 102

### 結果詳細

#### ✅ 通過したテスト (83件)

3つのresponse_type (`code id_token`, `code token`, `code id_token token`) に対して:
- サーバー基本機能
- ID Token署名
- UserInfo (GET/POST header/POST body)
- スコープ処理 (profile, email, address, phone, all)
- 表示モード (page, popup)
- プロンプト処理 (none-not-logged-in, none-logged-in)
- max-age処理 (10000)
- claims-essential
- request-uri, request-object
- refresh-token
- client-secret-post

#### ❌ 失敗したテスト (6件)

| テストID | テスト名 | 原因 | 分類 |
|----------|----------|------|------|
| pLhiFdjfKhm2X5K | oidcc-ensure-request-without-nonce-fails | Illegal test state change: FINISHED -> RUNNING | テストランナーエラー |
| RqY4529HA441R1I | oidcc-ensure-request-without-nonce-fails | Illegal test state change: FINISHED -> RUNNING | テストランナーエラー |
| Fkxs92Hm3JAg5n0 | oidcc-ensure-request-object-with-redirect-uri | runInBackground called after runFinalisation | テストランナーエラー |
| sijskpiZ3KvmUwd | oidcc-ensure-request-object-with-redirect-uri | runInBackground called after runFinalisation | テストランナーエラー |
| zyVfdmTCTFbqbS5 | oidcc-ensure-request-object-with-redirect-uri | runInBackground called after runFinalisation | テストランナーエラー |
| **13Q5a2Qj9eQwPKk** | **oidcc-ensure-request-without-nonce-succeeds-for-code-flow** | **The authorization was expected to succeed** | **🐛 OPバグ** |

#### ⚠️ 警告 (3件)

| テストID | テスト名 | 条件 | メッセージ |
|----------|----------|------|-----------|
| 8iuj8OuY4ROzi5W | oidcc-codereuse-30seconds | EnsureHttpStatusCodeIs4xx | resourceendpoint returned a different http status than expected |
| pi2UGpi2x2cH8O9 | oidcc-codereuse-30seconds | EnsureHttpStatusCodeIs4xx | resourceendpoint returned a different http status than expected |
| iiTKZEdicMo5N10 | oidcc-codereuse-30seconds | EnsureHttpStatusCodeIs4xx | resourceendpoint returned a different http status than expected |

### 🐛 特定されたバグ: Nonce Validation

**テスト:** `oidcc-ensure-request-without-nonce-succeeds-for-code-flow`
**response_type:** `code token`

**問題:** OPが`response_type=code token`の場合でもnonceを要求している

**OIDC仕様:** nonceは認可レスポンスに`id_token`が含まれる場合のみ必須
- `code` → nonce不要
- `code token` → nonce不要 ← **現在のOPは誤ってnonceを要求**
- `code id_token` → nonce必須
- `code id_token token` → nonce必須

---

## 4. OIDC Dynamic OP (code)

**Plan ID:** M6HFFZG9CBCqf
**実行時刻:** 2025-11-30T00:35:36.732Z
**テスト数:** 23

### 結果詳細

#### ✅ 通過したテスト (4件)

| テストID | テスト名 |
|----------|----------|
| Ml8vPaQUo9cDvf2 | oidcc-redirect-uri-regfrag |
| 12qSF3GsSYctlDS | oidcc-registration-sector-uri |
| C7lNXAz8YPQ3mV7 | oidcc-server-rotate-keys |
| JyvXCoaf5FczhAW | oidcc-request-uri-signed-rs256 |

#### ❌ 失敗したテスト (11件)

| テストID | テスト名 | 原因 | 分類 |
|----------|----------|------|------|
| ftBqA1O5aImYYcj | oidcc-idtoken-rs256 | Error from the token endpoint | 🐛 Token Endpoint |
| mj4GwF06ioyiTW8 | oidcc-userinfo-rs256 | userinfo_signing_alg_values_supported: not found | 🐛 Discovery |
| 9wxI0InZJHYScrV | oidcc-redirect-uri-query-OK | Error from the token endpoint | 🐛 Token Endpoint |
| RkDK2NwbHXMSMIs | oidcc-discovery-endpoint-verification | response_types/grant_types不足 | 🐛 Discovery |
| gGx0wRIMlSlOaSP | oidcc-server | Error from the token endpoint | 🐛 Token Endpoint |
| fi1C386GyXJ0nyJ | oidcc-registration-jwks-uri | Error from the token endpoint | 🐛 Token Endpoint |
| 2jvMvswUYxkKD5R | oidcc-registration-sector-bad | unexpected http status | 🐛 Registration |
| 0AbeReYmXTuQBRW | oidcc-refresh-token-rp-key-rotation | Error from the token endpoint | 🐛 Token Endpoint |
| hpSEq2V43vdCLFg | oidcc-request-uri-unsigned | Error from the token endpoint | 🐛 Token Endpoint |
| oS95qTG6wnS72mR | oidcc-ensure-request-object-with-redirect-uri | Error from the token endpoint | 🐛 Token Endpoint |
| L1MREWmd1qWpYrP | oidcc-refresh-token | Error from the token endpoint | 🐛 Token Endpoint |

#### ⚠️ 警告 (1件)

| テストID | テスト名 | 条件 | メッセージ |
|----------|----------|------|-----------|
| 4coXRMqGYp4buv0 | oidcc-ensure-client-assertion-with-iss-aud-succeeds | CheckIfTokenEndpointResponseError | token endpoint call was expected to succeed, but returned error |

---

## 特定されたバグ一覧

### 🔴 Critical (修正必須)

#### 1. Token Endpoint - private_key_jwt認証失敗

**影響:** Dynamic OPテストの大部分 (8/11 失敗)
**症状:** 動的登録されたクライアントからのトークンリクエストがすべて失敗
**推定原因:** `private_key_jwt`クライアント認証の実装に問題

**調査ポイント:**
- `client_assertion`のJWT検証ロジック
- `client_assertion_type`の処理
- 動的登録されたクライアントのJWKS取得

#### 2. Discovery Endpoint - 必須フィールド不足

**影響:** `oidcc-discovery-endpoint-verification`, `oidcc-userinfo-rs256`
**不足フィールド:**
- `userinfo_signing_alg_values_supported` (存在しない)
- `response_types_supported` (必須タイプが不足)
- `grant_types_supported` (必須タイプが不足)

### 🟡 High (修正推奨)

#### 3. Nonce Validation - code tokenフロー

**影響:** `oidcc-ensure-request-without-nonce-succeeds-for-code-flow`
**症状:** `response_type=code token`でnonceを誤って要求
**修正:** nonceを必須とする条件を「id_tokenが認可レスポンスに含まれる場合」に限定

#### 4. Dynamic Registration - エラーレスポンス

**影響:** `oidcc-registration-sector-bad`
**症状:**
- 無効な`sector_identifier_uri`に対して400以外のステータスを返している
- エラーレスポンスに`error`フィールドがない

### 🟢 Low (調査必要)

#### 5. codereuse-30seconds 警告

**影響:** Basic, Hybrid OP (警告のみ)
**症状:** 30秒後のcode再利用テストでUserInfoエンドポイントが4xxを返さない
**備考:** テスト仕様の解釈に依存する可能性あり

---

## テストランナー起因の問題

以下はOPのバグではなく、Conformance Suiteの問題:

| 問題 | 発生テスト |
|------|-----------|
| Illegal test state change: FINISHED -> RUNNING | oidcc-ensure-request-without-nonce-fails (複数) |
| runInBackground called after runFinalisation | oidcc-ensure-request-object-with-redirect-uri (複数) |

---

## 修正優先順位

1. **Token Endpoint (private_key_jwt)** - Dynamic OPの大部分に影響
2. **Discovery Endpoint (userinfo_signing_alg_values_supported)** - 簡単な修正
3. **Nonce Validation (code token)** - OIDC仕様準拠
4. **Registration Error Response** - エラーハンドリング改善

---

## 次のステップ

### Phase 1: Critical Bug修正
1. private_key_jwt認証の調査・修正
2. Discovery Endpointへのフィールド追加

### Phase 2: High Priority修正
3. Nonce validationロジックの修正
4. Registration エラーレスポンスの修正

### Phase 3: 再テスト
5. 4つの代表的テストを再実行
6. 残りのテストプランを実行:
   - formpost-* シリーズ
   - logout関連 (rp-logout, frontchannel, backchannel)
   - session-management
   - 3rdparty-login
   - fapi-2, fapi-ciba

---

## 付録: テスト実行コマンド

```bash
# Basic OP
npx tsx run-conformance.ts --spec specs/basic-op.json

# Implicit OP
npx tsx run-conformance.ts --spec specs/implicit-op.json

# Hybrid OP
npx tsx run-conformance.ts --spec specs/hybrid-op.json

# Dynamic OP (code)
npx tsx run-conformance.ts --spec specs/dynamic-op-code.json
```

---

**レポート作成:** Authrim Conformance Test Automation
**作成日時:** 2025-11-30
