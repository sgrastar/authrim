# Phase 3: Storage / Audit / Residency Profiles

最終更新: 2026-04-23

## 目的

以下の 3 種類の profile を formalize する。

- storage profile
- audit profile
- residency profile

## 方針

- environment に default profile を持つ
- tenant ごとに override pointer を持てるようにする
- tenant には full JSON ではなく `profile_id` を持たせる
- profile registry backend は deployment profile ごとに選べる

## Phase 3 着手前の前提整理

- custom claims / registration fields の portability slice は Phase 2 で完了
- shared service のうち、Phase 3 の注入点になりやすいものは `DatabaseSource` 化した
  - `settings-history`
  - `tenant-domain-resolver`
  - `org-domain-resolver`
- 残る D1 依存の主戦場は route / runtime wiring と concrete backend 実装

この段階で profile abstraction に進む理由は、shared service の入口は先に薄くできても、
tenant / environment ごとの backend 選択は profile model がないと最終形に寄せられないため。

## 実施内容

- profile domain model を定義する
- tenant から profile を参照する方式を決める
- registry abstraction を定義する
- lightweight / standard / external DB install での registry backend を整理する
- setup と runtime の責務分担を決める

## 実装済み slice

- `storage / audit / residency` profile の型を追加
- built-in profile ID と built-in profile 定義を追加
- tenant settings に override pointer を追加
  - `tenant.storage_profile_id`
  - `tenant.audit_profile_id`
  - `tenant.residency_profile_id`
- environment default pointer を infrastructure settings に追加
  - `infra.default_storage_profile_id`
  - `infra.default_audit_profile_id`
  - `infra.default_residency_profile_id`
- `ProfileRegistryBackend` abstraction を追加
- `KVProfileRegistryBackend` を追加
- `DatabaseProfileRegistryBackend` を追加
- `RuntimeProfileRegistry` と effective profile resolver を追加
- setup config に `profiles.defaults` / `profiles.registry.backend` を追加
- runtime resolver を追加
  - env / SETTINGS / AUTHRIM_CONFIG から effective profile refs を解決
  - `kv` / `database` registry backend を runtime で選択
- setup wrangler env vars に profile defaults / registry backend を追加
- `profile_registry` table migration を追加
- tenant info API に effective runtime profile summary を追加
- runtime profile の admin API を追加
  - global registry CRUD
  - tenant ごとの effective profile view
- custom-claims / registration-fields 系の runtime source resolver を追加
  - `schemaDb`
  - `nonPiiDb`
  - `piiDb`
- runtime source resolver を以下の主要 path に接続
  - signup / registration fields
  - admin user create / update / detail
  - SCIM user create / replace / patch / bulk
  - custom-claim required violation detector
  - SAML ACS JIT provisioning
  - external IdP JIT provisioning
  - anonymous upgrade completion / status
- custom-claim helper を `schema metadata / custom field data / lifecycle state` の 3 役割に分離
  - `validateCustomClaimWrite(..., schemaDb?)`
  - `getRequiredCustomClaimViolationStatuses(..., schemaDb?, stateDb?)`
  - `syncUserLifecycleState(..., schemaDb?, stateDb?)`
- unit test を追加して、schema DB と lifecycle state DB の分離を固定
- `users_core / users_pii` を storage profile の slice に追加
- request context middleware で user store runtime sources を先読みし、
  `createAuthContextFromHono` / `createPIIContextFromHono` が profile-aware に動くようにした
- profile registry backend 未設定時は built-in profile のみで soft fallback するようにした
- `builtin:storage:single-db` を選んだ environment では、setup migration 実行時に
  `migrations/pii/*` も core DB に mirror 適用するようにした
  - runtime で `DB` に寄せても `users_pii` 系 schema が欠けないようにするため
- `ar-management/src/admin.ts` の user CRUD / stats を `admin-users.ts` に分離した
  - runtime profile 対応の user path を独立させ、以後の user-store portability 作業を追いやすくするため
- `ar-management/src/admin.ts` の avatar / session handlers を `admin-user-sessions.ts` に分離した
  - profile-aware な user/session path をさらに閉じた単位で追えるようにするため
- single-db profile でも PII path が素通りせず動くよう、主要な auth / management routes の
  `if (env.DB_PII)` 分岐を request-aware な PII availability 判定へ寄せた
  - passkey
  - direct-auth
  - DID auth / DID link
  - session-management
  - invitation use
  - SCIM
  - handoff verify
  - admin RBAC user lookups
- Phase 3 review 後の仕上げとして、以前 env-level fallback でつないでいた read path も
  runtime-resolved user-store source に寄せた
  - SAML SP / IdP logout / SSO の email / NameID lookup
  - consent user info
  - discovery exact-email lookup
  - tombstone admin routes
  - admin user anonymize
  - admin user send-email
- 追加の schema review で、`users_pii.user_id` 前提が残っていた軽量 utility も追従させた
  - data export profile collection
  - consent rule 用 user claims helper

## built-in profile 案

Phase 3 の現時点では、以下の built-in storage profile を持つ。

- `builtin:storage:standard`
  - 既定値
  - `users_core`, `custom_claims`, `registration_fields` は `DB`
  - `users_pii`, `custom_pii` は `DB_PII`
- `builtin:storage:single-db`
  - lightweight install 向け
  - `users_core / users_pii / custom_claims / custom_pii` をすべて `DB` に載せる
- `builtin:storage:eu-pii-split`
  - EU residency を強めたい install 向けの基準案
  - core 系は `DB`、PII 系は `DB_PII`
  - residency profile は `builtin:residency:eu`
- `builtin:storage:external-postgres`
  - 外部 DB install の基準案
  - `core-primary` / `pii-primary` connectionRef を参照する

この built-in 群を先に持つ理由は、runtime profile の仕組みを導入しても
「最初の 1 インストールが profile 定義なしで動くこと」を優先したいため。
custom profile はこの built-in を起点にして増やす。

## この slice を先に入れた理由

いきなり runtime wiring 全体の backend 切替に入ると、route ごとの D1 依存と profile model の議論が混ざる。  
先に `profile_id + registry` を型として固定しておくことで、以後の wiring は「どの profile を読むか」に集中できる。

## 完了扱いにした範囲

- Phase 3 の完了条件である
  - profile の型と参照方法
  - registry backend abstraction
  - setup/runtime の profile-aware wiring
  は満たした
- review で見つかった schema drift も、この phase を閉じる前に修正した
  - admin anonymize / send-email
  - SAML email / NameID lookup
  - discovery / consent / tombstones user-store lookup
  - admin-rbac の `subject_org_membership` 追従

## Phase 3 完了後の follow-up

- setup CLI / web UI に profile registry backend 選択 UI を追加する
- `builtin:storage:single-db` で未使用になる `DB_PII` / `DB_ADMIN` を provisioning 上どう扱うかは未整理
  - 当面は将来の tenant override 余地を残すため作成継続
- repo 全体の wider portability
  - context/repository 入口は profile-aware になった
  - ただし raw `DB` / `DB_PII` を直接触る non-user-store path はまだ残る
- Phase 4 の audit routing 拡張で `audit profile` の中身を fan-out モデルへ接続する

## residency をここで入れる理由

setup にすでに location / jurisdiction の概念があり、storage から切り離せないため。  
後から足すより、この段階で `storage + audit + residency` の 3 つを並べた方が設計が安定する。

## 完了条件

- profile の型と参照方法が決まる
- registry backend abstraction の設計が決まる
- setup に必要な入力項目が整理される

## 後日メモ

- backup profile
- export profile
- retention profile
- Phase 0 / Phase 1 の持ち越し一覧
  - [deferred-items.md](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/storage-portability-phases/deferred-items.md)
