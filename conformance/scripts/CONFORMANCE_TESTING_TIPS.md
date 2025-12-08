# OIDC Conformance Testing Tips

このドキュメントは、OIDC適合テスト自動化スクリプトの開発・デバッグ時に役立つ知見をまとめたものです。
LLMやエンジニアが後で参照できるように作成しています。

## 目次

1. [テストスイートのアーキテクチャ](#テストスイートのアーキテクチャ)
2. [RP-Initiated Logout テストの仕組み](#rp-initiated-logout-テストの仕組み)
3. [よくある問題とデバッグ方法](#よくある問題とデバッグ方法)
4. [タイミング問題への対処](#タイミング問題への対処)

---

## テストスイートのアーキテクチャ

### OpenID Conformance Suite

- **ソースコード**: https://gitlab.com/openid/conformance-suite
- Javaで実装されたWebアプリケーション
- テストはステートマシンとして実装されており、状態遷移を追跡

### テストの状態遷移

```
CREATED → WAITING → (ブラウザ操作) → WAITING → ... → FINISHED
```

- `CREATED`: テストが作成された直後
- `WAITING`: ブラウザ操作を待機中
- `FINISHED`: テスト完了（成功/失敗）

### 重要なログエントリ（src フィールド）

| src | 説明 |
|-----|------|
| `BuildPlainRedirectToAuthorizationEndpoint` | 認可URLを生成 |
| `BuildRedirectToEndSessionEndpoint` | ログアウトURLを生成 |
| `CallTokenEndpoint` | トークンエンドポイントを呼び出し |
| `EnsureErrorFromAuthorizationEndpointResponse` | エラーレスポンスを期待 |

---

## RP-Initiated Logout テストの仕組み

### ソースコード参照

Conformance Suite のソースコードは GitLab で公開されています：
- **リポジトリ**: https://gitlab.com/openid/conformance-suite
- **主要ファイル**:
  - `AbstractOIDCCRpInitiatedLogout.java` - 基底クラス（テストフロー全体を定義）
  - `OIDCCRpInitiatedLogout.java` - 基本テスト
  - `condition/as/logout/` - ログアウト関連の条件クラス

### 標準的なテストフロー（成功ケース）

```
1. Round 1: Authorization (firstTime = true)
   - configureClient() - post_logout_redirect_uriを登録
   - BuildPlainRedirectToAuthorizationEndpoint
   - ブラウザ: 認可URL → ログイン → callback
   - onAuthorizationCallbackResponse() → トークン交換、id_token取得
   - onPostAuthorizationFlowComplete() → ログアウトフェーズへ

2. Round 2: Logout
   - CreateRandomEndSessionState - stateパラメータ生成
   - CreateEndSessionEndpointRequest - end_sessionリクエスト作成
   - customiseEndSessionEndpointRequest() - サブクラスでカスタマイズ可能
   - BuildRedirectToEndSessionEndpoint - リダイレクトURL生成
   - performRedirectToEndSessionEndpoint() - ステータスをWAITINGに設定
   - ブラウザ: ログアウトURL → post_logout_redirect_uri
   - handlePostLogoutRedirect() - OPからのリダイレクト受信
   - validateLogoutResults() - 結果検証

3. Round 3: Verification (firstTime = false, prompt=none)
   - createAuthorizationRequest() - prompt=noneを追加
   - ブラウザ: 認可URL → エラー（login_required）期待
   - onAuthorizationCallbackResponse() → エラーを確認
   - fireTestFinished() - テスト完了
```

### テストカテゴリの分類

#### **Type A: リダイレクト期待テスト**
post_logout_redirect_uri へのリダイレクトを期待し、その後 prompt=none で検証

| テスト名 | Javaクラス | 説明 |
|---------|------------|------|
| `oidcc-rp-initiated-logout` | `OIDCCRpInitiatedLogout` | 基本テスト |
| `oidcc-rp-initiated-logout-no-state` | `OIDCCRpInitiatedLogoutNoState` | stateなしでリダイレクト |
| `oidcc-rp-initiated-logout-no-post-logout-redirect-uri` | `OIDCCRpInitiatedLogoutNoPostLogoutRedirectUri` | post_logout_redirect_uriなし |
| `oidcc-rp-initiated-logout-only-state` | `OIDCCRpInitiatedLogoutOnlyState` | stateのみ |

#### **Type B: スクリーンショット待機テスト**
post_logout_redirect_uri へリダイレクトしてはいけない。エラーページのスクリーンショットを待機。

| テスト名 | Javaクラス | 説明 | プレースホルダー |
|---------|------------|------|----------------|
| `bad-post-logout-redirect-uri` | `OIDCCRpInitiatedLogoutBadLogoutRedirectUri` | 未登録のURI | `ExpectPostLogoutRedirectUriNotRegisteredErrorPage` |
| `modified-id-token-hint` | `OIDCCRpInitiatedLogoutModifiedIdTokenHint` | 改ざんされたid_token_hint | `ExpectInvalidIdTokenHintErrorPage` |
| `no-id-token-hint` | `OIDCCRpInitiatedLogoutNoIdTokenHint` | id_token_hintなし + URIあり | `ExpectIdTokenHintRequiredErrorPage` |
| `bad-id-token-hint` | `OIDCCRpInitiatedLogoutBadIdTokenHint` | 無効なid_token_hint | `ExpectInvalidIdTokenHintErrorPage` |
| `query-added-to-post-logout-redirect-uri` | `OIDCCRpInitiatedLogoutQueryAddedToLogoutRedirectUri` | クエリパラメータ追加 | `ExpectPostLogoutRedirectUriNotRegisteredErrorPage` |
| `no-params` | `OIDCCRpInitiatedLogoutNoParams` | パラメータなし | `ExpectSuccessfulLogoutPage` |

### スクリーンショット待機テストの実装詳細

Javaソースコードから判明した重要な仕組み：

```java
// handleHttp メソッドのオーバーライドパターン
@Override
public Object handleHttp(String path, ...) {
    if (path.equals("post_logout_redirect")) {
        // リダイレクトが来たら即座にテスト失敗
        throw new TestFailureException(getId(),
            "OP has incorrectly called the registered post_logout_redirect_uri...");
    }
    return super.handleHttp(path, ...);
}

// createLogoutPlaceholder メソッドのオーバーライド
@Override
protected String createLogoutPlaceholder() {
    // スクリーンショット待機プレースホルダーを作成
    callAndStopOnFailure(ExpectPostLogoutRedirectUriNotRegisteredErrorPage.class);
    return env.getString("post_logout_redirect_uri_not_registered_error");
}
```

**重要**: これらのテストでは：
1. テストスイートは `WAITING` 状態でスクリーンショットアップロードを待機
2. OPがpost_logout_redirect_uriにリダイレクトすると**テスト失敗**
3. 自動化スクリプトは「次のURL」を探してもコールバックがないため、タイムアウトする可能性

### プレースホルダーの仕組み

`createBrowserInteractionPlaceholder()` が使用され、ユーザーにスクリーンショットのアップロードを促します：

```java
// ExpectPostLogoutRedirectUriNotRegisteredErrorPage.java
String placeholder = createBrowserInteractionPlaceholder(
    "The server must show an error page saying the request is invalid " +
    "as the post_logout_redirect_uri is not a registered one - " +
    "upload a screenshot of the error page."
);
```

---

## Backchannel / Frontchannel ログアウトテスト

### テストの仕組み（共通パターン）

BackchannelとFrontchannelのログアウトテストは、**2つのリクエスト**を待機する特殊な仕組みを持っています。

```java
// 両方のリクエストを保持
private JsonObject postLogoutRedirectRequestParts = null;
private JsonObject backchannelLogoutRequestParts = null;  // or frontchannelLogoutRequestParts

// どちらかが来ても、もう片方を待つ
if (postLogoutRedirectRequestParts == null) {
    eventLog.log(getName(), "Received backchannel request; waiting for front channel redirect");
} else {
    validateLogoutResultsInBackground();
}
```

### Backchannel Logout テストフロー

```
1. Round 1: Authorization
   - 通常の認可フロー
   - id_token取得（sidクレーム含む）

2. Round 2: Logout
   - end_session_endpointにリダイレクト
   - **OPがback-channelでlogout_tokenをPOST（backchannel_logout_uri）**
   - ブラウザ: post_logout_redirect_uriへリダイレクト
   - テストスイート: 両方のリクエストを検証

3. Round 3: Verification (prompt=none)
   - セッション無効化を確認
```

**検証項目**:
- `logout_token`の署名検証
- `logout_token`のクレーム検証（iss, aud, iat, jti, events, sid/sub）
- id_tokenのsid/subとlogout_tokenの一致確認
- nonceが含まれていないこと

### Frontchannel Logout テストフロー

```
1. Round 1: Authorization
   - 通常の認可フロー
   - id_token取得（sidクレーム含む）

2. Round 2: Logout
   - end_session_endpointにリダイレクト
   - **OPがfrontchannel_logout_uriをiframe等でロード**
   - ブラウザ: post_logout_redirect_uriへリダイレクト
   - テストスイート: 両方のリクエストを検証

3. Round 3: Verification (prompt=none)
   - セッション無効化を確認
```

**検証項目**:
- `iss`パラメータの検証
- `sid`パラメータがid_tokenのsidと一致

### よくある失敗原因

| 問題 | 原因 | 対処 |
|------|------|------|
| テストがWAITINGのまま | OPがbackchannel/frontchannel_logout_uriを呼んでいない | OP側でlogout通知を実装 |
| sid不一致エラー | id_tokenにsidがない、またはlogoutリクエストに含まれていない | sidクレームをid_tokenとlogout通知に含める |
| post_logout_redirectが来ない | ブラウザ自動化がエラーページで止まっている | URL遷移を確認 |

### OPが実装すべきこと

1. **Backchannelログアウト**:
   - end_session時に登録された`backchannel_logout_uri`へlogout_tokenをPOST
   - logout_tokenにはiss, aud, iat, jti, events, sidを含める
   - logout_tokenはOPのJWKで署名

2. **Frontchannelログアウト**:
   - end_session時にログアウト確認ページで`frontchannel_logout_uri`をiframeでロード
   - URLパラメータに`iss`と`sid`を含める

---

## よくある問題とデバッグ方法

### 問題1: ログアウトURLが検出されない

**症状**: round 1が完了した後、round 2（logout）が実行されずにテストが終了する

**原因**:
- テストスイートがログアウトURLをログに追加するまでに時間がかかる
- `waitForState`が`FINISHED`を返してwhileループを抜ける

**デバッグ方法**:
```bash
# debug.logでBuildRedirectToEndSessionEndpointを検索
grep "BuildRedirectToEndSessionEndpoint" debug.log

# テストIDでログをフィルタリング
grep "テストID" debug.log | head -50
```

**解決策**:
1. ブラウザ操作後に待機時間を追加
2. `waitForState`の前にログを確認
3. `FINISHED`でもログアウトURLがあれば処理続行

### 問題2: テストがすぐにFINISHEDになる

**症状**: round 1の後、テストがすぐに`FINISHED`状態になる

**原因**:
- テストスイートがブラウザ操作を待っている間にタイムアウト
- 認可エンドポイントでエラーが発生

**デバッグ方法**:
```bash
# run.logでラウンド数を確認
grep "Browser action required" run.log

# 成功テストと比較
# 成功: round 1 → round 2 → round 3
# 失敗: round 1 のみ
```

### 問題3: id_tokenにsidクレームがない

**症状**: ログアウト時にセッションが無効化されない

**原因**: id_tokenに`sid`（Session ID）クレームが含まれていない

**確認方法**:
```bash
# id_token_hintをデコード（jwt.ioなど）
# sidクレームの有無を確認
```

**解決策**:
- `IDTokenClaims`インターフェースに`sid`を追加
- authorize.ts/token.tsでsidを含める

---

## タイミング問題への対処

### 重要な原則

1. **テストスイートの処理には時間がかかる**
   - ブラウザからのcallback受信
   - トークン交換
   - ログエントリの追加
   - 次のリダイレクトURLの生成

2. **ログのポーリングには遅延がある**
   - APIレスポンスにはキャッシュがある可能性
   - 新しいログエントリが即座に反映されない場合がある

3. **状態遷移は非同期**
   - `WAITING` → `FINISHED`の遷移は予測困難
   - テストがタイムアウトする可能性

### 推奨パターン

```typescript
// パターン1: ブラウザ操作後の待機
await browserAutomator.handleUserInteraction(authUrl, testUser);
await new Promise((resolve) => setTimeout(resolve, 2000)); // 2秒待機

// パターン2: リトライ付きログ確認
const maxRetries = 5;
for (let i = 0; i < maxRetries; i++) {
  const logs = await conformanceClient.getTestLog(moduleId);
  const logoutUrl = findLogoutUrl(logs);
  if (logoutUrl) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

// パターン3: FINISHEDでも最終確認
status = await waitForState(moduleId, ['WAITING', 'FINISHED']);
if (status === 'FINISHED') {
  // ログを最終確認してURLがあれば処理
  const logs = await conformanceClient.getTestLog(moduleId);
  if (hasUnprocessedLogoutUrl(logs)) {
    // 強制的にもう1回ループ
  }
}
```

---

## ファイル構成

```
conformance/scripts/
├── run-conformance.ts       # メインスクリプト
├── lib/
│   ├── browser-automator.ts # ブラウザ自動化
│   ├── conformance-client.ts # APIクライアント
│   └── types.ts             # 型定義
├── expected/
│   └── expected-failures.json # 期待される失敗
└── CONFORMANCE_TESTING_TIPS.md # このファイル
```

---

## 参考リンク

- [OpenID Conformance Suite (GitLab)](https://gitlab.com/openid/conformance-suite)
- [RP-Initiated Logout 仕様](https://openid.net/specs/openid-connect-rpinitiated-1_0.html)
- [Issue #1090: id_token_hint requirement](https://gitlab.com/openid/conformance-suite/-/issues/1090)

---

*Last updated: 2025-12-08*
