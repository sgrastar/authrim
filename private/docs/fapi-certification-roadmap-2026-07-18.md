---
project: Authrim
lang: ja
date: 2026-07-18
description: "AuthrimでmTLSを除くFAPI 2.0 OP/RPおよびFAPI-CIBA OP認定を最短で取得するためのロードマップ。"
type: plan
tags:
  - authrim
  - internal-docs
  - fapi
  - oidc
  - ciba
  - conformance
  - certification
---

# FAPI 2.0 OP / RP・FAPI-CIBA OP 認定取得ロードマップ

## 1. 目的

Authrimについて、OIDF Conformance Suiteを使用し、取得可能なFAPI 2.0 OP/RPおよび
FAPI-CIBA OP認定を、実装の再利用性と試験コストを考慮した最短順序で取得する。

この文書は以下を管理する。

- 認定対象と除外対象
- 現在の試験状況
- 実装・試験の依存関係
- 推奨実施順序
- 各フェーズの完了条件
- ブラウザー操作の要否
- 試験結果と証跡の保存方法

## 2. 前提とスコープ

### 2.1 前提

- クライアント認証は `private_key_jwt` を使用する。
- アクセストークンのsender-constrainingにはDPoPを使用する。
- Cloudflare edgeでのクライアント証明書制御の制約により、mTLS認定列は対象外とする。
- Conformance環境のminimum TLS versionはTLS 1.3とする。
- OP、Client Credentials、Message Signing、CIBAは用途ごとに専用テナントを使用する。
- RP認定対象は原則として `ar-bridge` を基盤とする独立したAuthrim FAPI RP実装とする。
- 認定申請前に、使用したAuthrimバージョン、設定、テストプラン、ログを固定する。

### 2.2 認定系列

FAPI 2.0 Security Profileの評価軸は、OIDCかOAuth 2.1かという二者択一ではない。
主に次の独立した軸を組み合わせて評価する。

| 評価軸 | 内容 |
|---|---|
| Client authentication | mTLSまたは`private_key_jwt` |
| Sender-constraining | mTLS certificate-bound tokenまたはDPoP |
| Protocol payload | plain OAuthまたはOpenID Connect |
| Message signing | JAR、JARM、その他の署名対象 |

`private key + DPoP`はクライアント認証とsender-constrainingの組み合わせ、
`OpenID Connect`はID Token、nonce、UserInfo、OIDC claimsなどを評価する別の認定列である。

また、FAPI-CIBAはFAPI 2.0 Security Profile Finalの認定列ではなく、既存の
FAPI-CIBAプロファイルを対象とする別系列の認定である。

## 3. 取得対象

mTLSを除外した場合、取得対象は合計11列である。

| No. | 区分 | 認定列 | 現在の状態 |
|---:|---|---|---|
| 1 | FAPI2SP OP | private key + DPoP | OIDFテスト実行済み、0 failure |
| 2 | FAPI2SP OP | OpenID Connect | No. 1と同じOIDC variantで実行済み、0 failure |
| 3 | FAPI2SP OP Client Credentials | private key + DPoP | OIDFテスト実行済み、0 failure |
| 4 | FAPI2MS OP | JAR | 実装基盤あり、Finalテスト未実行 |
| 5 | FAPI2MS OP | JARM | 実装基盤あり、Finalテスト未実行 |
| 6 | FAPI-CIBA OP | Poll w/ Private Key | 実装基盤・テスト定義あり、未実行 |
| 7 | FAPI-CIBA OP | Ping w/ Private Key | 実装基盤・テスト定義あり、未実行 |
| 8 | FAPI2SP RP | private key + DPoP | RP共通基盤の追加実装が必要 |
| 9 | FAPI2SP RP | OpenID Connect | 通常OIDC基盤あり、FAPI RP共通基盤が必要 |
| 10 | FAPI2MS RP | JAR | JAR生成の部分実装あり、FAPI対応が必要 |
| 11 | FAPI2MS RP | JARM | JARM検証を追加実装する必要あり |

### 3.1 除外する認定列

以下はCloudflare構成上の制約により、本ロードマップでは取得対象外とする。

- OP MTLS + MTLS
- OP MTLS + DPoP
- OP private key + MTLS
- OP Client CredentialsのmTLSを含む3列
- RP MTLS + MTLS
- RP MTLS + DPoP
- RP private key + MTLS
- CIBA Poll w/ MTLS
- CIBA Ping w/ MTLS

将来、mTLSを終端からOP/RPまで安全に伝達できる専用経路を用意した場合は別計画として扱う。

## 4. 最短実施順序

| 順番 | フェーズ | 取得を狙う認定列 | 選定理由 |
|---:|---|---|---|
| 1 | 既存OP Security Profile結果の確定 | OP private key + DPoP、OP OpenID Connect | すでに0 failureで、最短で確定できる |
| 2 | Client Credentials結果の確定 | OP CC private key + DPoP | すでに0 failureで、ブラウザー不要 |
| 3 | OP Message Signing JAR | FAPI2MS OP JAR | 既存のPAR・request object検証を再利用できる |
| 4 | OP Message Signing JARM | FAPI2MS OP JARM | 既存JARM生成処理とMessage Signing presetを再利用できる |
| 5 | CIBA共通修正とPoll | CIBA OP Poll w/ Private Key | Pingより構成が単純で、共通処理を先に固められる |
| 6 | CIBA Ping | CIBA OP Ping w/ Private Key | Poll完成後は通知処理を中心に追加できる |
| 7 | RP共通FAPI基盤 | RP private key + DPoP、RP OpenID Connect | 2列を同じ実装フェーズで取得可能 |
| 8 | RP JAR | FAPI2MS RP JAR | RPのPAR処理に署名request objectを追加できる |
| 9 | RP JARM | FAPI2MS RP JARM | RP共通基盤完成後に署名レスポンス検証を追加する |

依存関係は次のとおり。

```text
既存OP Security Profile
  ├─ OP private key + DPoP
  ├─ OP OpenID Connect
  └─ OP Client Credentials private key + DPoP
        ↓
OP Message Signing
  ├─ JAR
  └─ JARM
        ↓
CIBA共通JWT検証
  ├─ Poll w/ Private Key
  └─ Ping w/ Private Key
        ↓
RP共通FAPI基盤
  ├─ private key + DPoP
  ├─ OpenID Connect
  ├─ JAR
  └─ JARM
```

## 5. フェーズ別計画

### 5.1 フェーズ1: 既存OP Security Profileの確定

対象:

- FAPI2SP OP private key + DPoP
- FAPI2SP OP OpenID Connect
- FAPI2SP OP Client Credentials private key + DPoP

通常OPの実行済みplan:

- Plan ID: `GeiiofWyJ91hC`
- Variant: `private_key_jwt + dpop + openid_connect + plain_fapi`
- 結果: 50 passed、0 failed、1 warning、1 skipped
- 保存先: `private/conformance/OIDC OP FAPI2.0 Security Profile Final private_key_jwt dpop openid_connect plain_fapi/results/2026-07-17_1817/`

Client Credentialsの実行済みplan:

- Plan ID: `nGz8r7w97hg59`
- Variant: `private_key_jwt + dpop + plain_oauth + fapi_client_credentials_grant`
- 結果: 13 passed、0 failed、0 warning、1 skipped
- 保存先: `private/conformance/OIDC OP FAPI2.0 Security Profile Final Client Credentials private_key_jwt dpop plain_oauth/results/2026-07-18_0511/`

完了条件:

- [ ] warningの内容を確認し、認定に影響しないか記録する
- [ ] eye-checkまたは手動レビュー対象を完了する
- [ ] 必要なら同じバージョン・設定でクリーン再実行する
- [ ] OIDF Conformance Suite上で認定用resultをpublishする
- [ ] 公開result URL、Authrim version、tenant設定snapshotを保存する
- [ ] 認定申請に使用する3列を対応表に記録する

### 5.2 フェーズ2: FAPI2MS OP JAR

既存のPAR、JAR/request object検証、クライアントJWKS処理を利用し、
FAPI 2.0 Message Signing Final固有の制約を確認する。

主要確認事項:

- PAR endpointで署名request objectを必須化できる
- 登録クライアントJWKSで署名を検証する
- `aud`がissuerを含む
- `nbf`が必須で、許容期間内である
- `exp`と`nbf`の差が60分以内である
- `typ=oauth-authz-req+jwt`を受理する
- 未署名、`alg=none`、不許可alg、別クライアント鍵を拒否する
- request object内外の重複・不一致parameterを仕様どおり処理する
- issuer、client、tenantを跨いだ鍵利用を拒否する

完了条件:

- [ ] `fapi2-message-signing-final-test-plan`のJAR variantをテスト設定へ追加する
- [ ] `fapi2-message-signing` presetを使用した専用テナントを作成する
- [ ] テストspec snapshotを保存する
- [ ] 全必須moduleがPASSEDまたは認定上許容される状態になる
- [ ] report、summary、module logs、review証跡を保存する

### 5.3 フェーズ3: FAPI2MS OP JARM

既存のJARM生成処理をFinal試験へ接続する。

主要確認事項:

- Message Signing profileではJARMを必須化する
- `response_mode=jwt`を受理する
- authorization success responseを正しいOP鍵で署名する
- error responseも要求されたresponse modeで安全に返す
- `iss`、`aud`、`exp`、`iat`、code、stateを正しく含める
- クライアントごとの`authorization_signed_response_alg`を尊重する
- FAPIで許可されないalgを拒否する
- tenantごとの署名鍵選択とJWKS公開が一致する

関連実装:

- `packages/ar-auth/src/authorize.ts`のJARM生成処理
- `packages/ar-lib-core/src/types/contracts/presets.ts`の`fapi2-message-signing` preset

完了条件:

- [ ] JARM variantをテスト設定へ追加する
- [ ] JARと同じMessage Signingテナントで設定整合性を確認する
- [ ] 全必須moduleがPASSEDまたは認定上許容される状態になる
- [ ] report、summary、module logs、review証跡を保存する

### 5.4 フェーズ4: FAPI-CIBA OP Poll w/ Private Key

先にPollを完成させ、CIBA共通のrequest JWT、client authentication、状態遷移を固める。

必要な実装・修正:

- Dynamic Client RegistrationでCIBA grant typeを受理する
- `backchannel_token_delivery_mode`などのCIBA metadataを検証・保存する
- signed Authentication Request JWTを検証する
- `iss`、`aud`、`exp`、`iat`、`nbf`、`jti`を検証する
- `jti`のリプレイを拒否する
- 登録クライアントJWKSと署名鍵を照合する
- 不許可alg、`none`、RS256など試験対象の禁止パターンを拒否する
- login hint系parameterの排他条件を検証する
- `auth_req_id`の期限、client binding、tenant bindingを検証する
- `authorization_pending`、`slow_down`、`access_denied`、`expired_token`を正しく返す
- token endpointでも`private_key_jwt`を再検証する
- approval/denyの状態遷移と監査証跡を確認する

既存テスト定義:

- Plan key: `fapi-ciba-id1-poll`
- Plan name: `fapi-ciba-id1-test-plan`
- `client_auth_type=private_key_jwt`
- `ciba_mode=poll`
- `client_registration=dynamic_client`

完了条件:

- [ ] DCR、request JWT、Poll状態遷移のunit/integration testを追加する
- [ ] CIBA専用テナントを作成する
- [ ] OIDF Poll planを最後まで実行する
- [ ] approveとdenyの両方のブラウザー操作を確認する
- [ ] 全必須moduleがPASSEDまたは認定上許容される状態になる
- [ ] report、summary、module logs、review証跡を保存する

### 5.5 フェーズ5: FAPI-CIBA OP Ping w/ Private Key

Pollで完成したCIBA共通処理を利用し、Ping通知固有部分を追加する。

主要確認事項:

- 登録済みnotification endpointだけへ通知する
- notification tokenを正しく送信する
- HTTP 401/403を正しく処理する
- redirect responseへ追従しない
- 401など再試行禁止条件で再送しない
- timeout、一時失敗、恒久失敗の再試行方針を分離する
- callback URLをSSRF対策ポリシーで検証する
- 通知body、token、個人情報をログへ漏えいさせない
- cross-tenantのcallback設定を利用できない

既存テスト定義:

- Plan key: `fapi-ciba-id1-ping`
- Plan name: `fapi-ciba-id1-test-plan`
- `client_auth_type=private_key_jwt`
- `ciba_mode=ping`
- `client_registration=dynamic_client`

完了条件:

- [ ] Ping配送のunit/integration testを追加する
- [ ] OIDF Ping planを最後まで実行する
- [ ] 通知失敗系と「再試行しない」条件を確認する
- [ ] 全必須moduleがPASSEDまたは認定上許容される状態になる
- [ ] report、summary、module logs、review証跡を保存する

### 5.6 フェーズ6: FAPI2SP RP private key + DPoP / OpenID Connect

認定対象となるRP実装を明示し、OIDF RP suiteから操作できるFAPI RP harnessを用意する。

RP共通実装:

- Authorization Server discovery
- PAR request生成・送信
- PAR/token endpointでの`private_key_jwt`
- PKCE S256
- DPoP proof生成
- DPoP nonce challenge後の安全な再送
- authorization codeとDPoP keyのbinding
- token endpointでのDPoP
- DPoP access tokenによるUserInfo/resourceアクセス
- issuer、state、nonce、ID Token署名・claims検証
- `c_hash`、`s_hash`、`at_hash`など該当するhash claim検証
- OIDF suiteが利用できるstart、callback、result endpoint
- malformed response、署名不正、nonce不一致、issuer不一致のnegative test
- RP鍵の暗号化保存、rotation、tenant分離

現状の基盤:

- `packages/ar-bridge/src/clients/oidc-client.ts`にPKCE、request object、ID Token検証の基礎がある
- token client authenticationは`client_secret_basic` / `client_secret_post`中心であり、
  `private_key_jwt`とDPoPを追加する必要がある

完了条件:

- [ ] 認定対象RPの名称・version・公開endpointを確定する
- [ ] FAPI RP共通実装と回帰テストを追加する
- [ ] private key + DPoP variantを完走する
- [ ] OpenID Connect variantを完走する
- [ ] 両認定列のreport、summary、module logs、review証跡を保存する

### 5.7 フェーズ7: FAPI2MS RP JAR

RP共通PAR処理に、FAPI 2.0 Message Signing Final準拠の署名request object生成を追加する。

主要確認事項:

- authorization parameterを署名request object内へ格納する
- request objectをPAR endpointへ送信する
- `aud`にAuthorization Server issuerを設定する
- `nbf`を含める
- `exp`のlifetimeを60分以内にする
- `typ=oauth-authz-req+jwt`を使用可能にする
- private signing keyをtenant/clientごとに選択する
- FAPIで許可されたalgのみを使用する

完了条件:

- [ ] JAR生成とPAR送信のunit/integration testを追加する
- [ ] OIDF RP JAR planを完走する
- [ ] report、summary、module logs、review証跡を保存する

### 5.8 フェーズ8: FAPI2MS RP JARM

Authorization Serverから受け取るJARM responseを厳密に検証する。

主要確認事項:

- authorization requestで`response_mode=jwt`を指定する
- OP discovery/JWKSを使って署名を検証する
- `iss`、`aud`、`exp`、`iat`、stateを検証する
- 許可algと登録metadataを照合する
- unknown `kid`時のJWKS refreshを安全に行う
- 署名不正、期限切れ、issuer不一致、audience不一致を拒否する
- JARM検証前にauthorization codeを利用しない
- replayされたJARM responseを拒否する

完了条件:

- [ ] JARM verifierとnegative testを追加する
- [ ] OIDF RP JARM planを完走する
- [ ] report、summary、module logs、review証跡を保存する

## 6. ブラウザー操作

| 認定 | ブラウザー | 主な操作 |
|---|---|---|
| OP Client Credentials | 不要 | 完全自動化可能 |
| OP Security Profile | 必要 | ログイン、同意、拒否、エラー画面確認 |
| OP JAR/JARM | 必要 | 通常認可、拒否、JARMエラー画面確認 |
| CIBA Poll/Ping | 必要 | decoupled approval、deny、必要に応じてユーザー選択 |
| RP Security Profile | 必要 | RP開始、OP側認可、callback確認 |
| RP JAR/JARM | 必要 | RP開始、OP側認可、署名response処理確認 |

ブラウザーが必要なplanでも、plan作成、client登録、実行監視、結果収集、ログ保存は自動化する。
人またはブラウザー自動操作が必要なのは、原則としてログイン、同意、承認、拒否、eye-checkに限定する。

## 7. テスト結果と証跡の保存

各認定planの成果物は、既存の`private/conformance`方式に従い、認定variantごとのディレクトリへ保存する。

最低限保存するもの:

- `summary.json`
- `report.md`
- plan IDとplan URL
- 各moduleのstatusとlog
- warning、skip、review、eye-checkの判断記録
- ブラウザー確認が必要なmoduleのスクリーンショット
- OIDFへpublishしたresult URL
- 実行日時
- Authrim commit SHAまたはrelease version
- issuerとtenant ID。ただしsecretは記録しない
- discovery metadata snapshot
- 公開JWKS snapshot。private keyは保存しない
- client metadata。client secret、private JWK、IATは保存しない
- Cloudflare TLS/security設定の関連snapshot

推奨ディレクトリ名:

```text
private/conformance/
  OIDC OP FAPI2.0 Security Profile Final .../
  OIDC OP FAPI2.0 Message Signing Final JAR .../
  OIDC OP FAPI2.0 Message Signing Final JARM .../
  OIDC OP FAPI-CIBA-ID1 private_key_jwt poll plain_fapi/
  OIDC OP FAPI-CIBA-ID1 private_key_jwt ping plain_fapi/
  OIDC RP FAPI2.0 Security Profile Final .../
  OIDC RP FAPI2.0 Message Signing Final JAR .../
  OIDC RP FAPI2.0 Message Signing Final JARM .../
```

トークン、client assertion、private JWK、cookie、password、IATなどの秘密情報は成果物へ含めない。
ログ収集時にもredactionを確認する。

## 8. 共通品質ゲート

各実装フェーズで、OIDFテストだけでなく次を満たす。

- [ ] 変更対象packageのunit testが通る
- [ ] protocol matrixとnegative caseを追加する
- [ ] cross-tenant、wrong issuer、wrong client、wrong keyを拒否するテストがある
- [ ] expired、replayed、malformed JWTを拒否するテストがある
- [ ] audit eventとログredactionを確認する
- [ ] discovery metadataと実際のruntime設定が一致する
- [ ] OpenAPIに影響するroute/contract変更を反映する
- [ ] `pnpm openapi:validate`が通る
- [ ] `pnpm openapi:routes -- --fail-on-missing`が通る
- [ ] `pnpm typecheck`が通る
- [ ] 関連テストおよび必要範囲の`pnpm test`が通る
- [ ] conformance環境へdeploy後、smoke testを通す
- [ ] OIDF planをクリーン実行する
- [ ] 結果を`private/conformance`へ保存する

## 9. 認定申請前の最終チェック

- [ ] 11列のうち申請対象が明示されている
- [ ] mTLS列を誤って申請対象に含めていない
- [ ] 各列に対応するpublished result URLがある
- [ ] warningとskipについて認定上の扱いを確認済み
- [ ] 手動レビュー項目の証跡がある
- [ ] 試験後に認定対象コードや設定を変更していない
- [ ] implementation nameとversionがOP/RP/CIBAで一貫している
- [ ] 認定対象endpointが外部から安定して到達可能
- [ ] TLS 1.3、証明書、DNS、Cloudflare proxy設定が安定している
- [ ] テスト用secretやprivate keyがrepositoryへ追加されていない
- [ ] OIDFの最新Certification Policyと申請手順を再確認した

## 10. 公式参照

- [Certified FAPI 2.0 OP Security Profile Final & Message Signing Final](https://openid.net/certification/certified-fapi-2-0-op-security-profile-final-message-signing-final/)
- [Certified FAPI 2.0 RP Security Profile Final & Message Signing Final](https://openid.net/certification/certified-fapi-2-0-rp-security-profile-final-message-signing-final/)
- [Certified FAPI CIBA OpenID Providers & Profiles](https://openid.net/certification/certified-fapi-ciba-openid-providers-profiles/)
- [FAPI 2.0 Security Profile Final](https://openid.net/specs/fapi-security-profile-2_0-final.html)
- [FAPI 2.0 Message Signing Final](https://openid.net/specs/fapi-message-signing-2_0-final.html)
- [OpenID Connect Client-Initiated Backchannel Authentication Core 1.0 Final](https://openid.net/specs/openid-client-initiated-backchannel-authentication-core-1_0-final.html)
- [Financial-grade API: Client Initiated Backchannel Authentication Profile](https://openid.net/specs/openid-financial-api-ciba.html)

## 11. ローカル参照

- `private/conformance/scripts/config/test-plans.json`
- `private/conformance/scripts/specs/fapi-ciba-id1-poll.json`
- `private/conformance/scripts/specs/fapi-ciba-id1-ping.json`
- `packages/ar-auth/src/authorize.ts`
- `packages/ar-async/src/ciba-authorization.ts`
- `packages/ar-management/src/register.ts`
- `packages/ar-discovery/src/discovery.ts`
- `packages/ar-bridge/src/clients/oidc-client.ts`
- `packages/ar-lib-core/src/types/contracts/presets.ts`

## 12. 進捗サマリー

| フェーズ | 対象列数 | 状態 |
|---|---:|---|
| 既存OP Security Profile | 3 | テスト実行済み、認定用結果確定待ち |
| OP Message Signing | 2 | Finalテスト設定・実行待ち |
| FAPI-CIBA OP | 2 | 共通JWT/DCR修正とテスト実行待ち |
| FAPI 2.0 RP | 4 | FAPI RP共通基盤の実装待ち |
| 合計 | 11 | 3列はテスト結果あり、8列は未完了 |
