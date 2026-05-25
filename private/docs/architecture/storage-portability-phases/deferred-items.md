# Deferred Items Across Phases

最終更新: 2026-04-24

## 目的

Phase 0 と Phase 1 で決めたもの、実装したもののうち、Phase 2 から Phase 4 以降へ持ち越す項目を 1 箇所に集約する。

このメモは「未着手」を列挙するだけではなく、どの phase で拾う前提か、なぜ後回しにしたかも残す。

## Phase 0 からの持ち越し

### Phase 1 で一部だけ着手し、後段でも継続して扱うもの

- `is_required` の canonical semantics を全 write path へ広げる作業
  - signup / admin / SCIM / federation / upgrade は Phase 1 で揃えた
  - import runner、将来の sync / bulk / background provisioning は後続 phase でも同じ helper を使う
- `lifecycle_state` の拡張
  - Phase 1 では `active / incomplete` の materialization まで
  - `invited / pending_verification / provisioning / dormant / archived / deprovisioned` の本格運用は後段で行う
- Admin UI 文言と導線の完全整理
  - semantics は docs 上で固定済み
  - UI の最終的な説明文、補完導線、profile completion UX は後段で詰める

## Phase 1 からの持ち越し

### Phase 2 へ持ち越すもの

- custom claims / registration fields の DB portability
  - shared helper は `DatabaseAdapter` / `DatabaseSource` に寄せ始めた
  - route layer と runtime wiring の concrete backend 依存はまだ残る
- custom claims 周辺の SQL portability inventory
  - `ON CONFLICT`, JSON 参照、bind 数対策、migration 差分の棚卸しが必要
- `users/import` 実処理
  - 現状は import job 作成 API のみ
  - runner 実装時に `validateCustomClaimWrite(...)` と `syncUserLifecycleState(...)` を共通利用する

### Phase 3 へ持ち越すもの

- completion ticket / missing reason の materialization
  - Phase 1 では `missing_required_fields` を動的に返すところまで
  - tenant / environment ごとの storage profile を持つ段階で、どこへ保存するかを決める
- profile completion flow の保存先整理
  - `storage profile`
  - `audit profile`
  - `residency profile`
  と矛盾しない形で state を formalize する

### Phase 4 へ持ち越すもの

- required 違反 detector の監査連携
  - 現在は admin endpoint による on-demand detection
  - 将来は audit sink / forwarding sink へ流すかを設計する
- federation / provisioning の incomplete 遷移イベント
  - 現在の JIT / federation は hard-fail が基本
  - incomplete mode に切り替えるなら audit routing 設計とも接続する

## Phase 2 完了後に残る wider portability items

- custom claims route layer の backend wiring 統一
  - shared helper の `DatabaseSource` 化は先行済み
  - ただし `admin.ts` など broader runtime path の `D1Adapter` 直結は段階的に寄せる
- repo-wide PostgreSQL / MySQL backend 実装
  - audit scope の adapter と primary wiring は実装済み
  - custom claims / users / wider runtime path への展開はまだ
- registration / custom-claims cache invalidation helper の共通化
  - cache invalidation 自体は既に修正済み
  - backend 切替前提の抽象はまだない

### Phase 5 にまとめて扱うもの

- repo-wide storage portability の残骸整理
- raw `new D1Adapter(...)` 残骸
- broader runtime path の profile-aware 化
- custom claims route wiring の統一
- repo-wide PostgreSQL / MySQL backend 展開の土台整理
- backend-agnostic cache invalidation helper
- storage boundary policy の code-level enforcement
  - current spec の boundary class を machine-readable に持つ
  - runtime-profile / admin path で
    auth core plane の tenant override を reject する
  - 実装が `users_core` slice 名だけを見て誤解しないよう、
    `auth_core` alias または同等の明示的表現を検討する
- `RefreshTokenRotator` family state の cold persistence / recovery 再導入要否
  - 5b reevaluation では見送った
  - current `user_token_families` / `refresh_token_shard_configs` だけでは
    `version` / `last_jti` / `allowed_scope` を
    canonical に再構成できない
  - portable な family-state persistence 契約と schema を追加する場合だけ再検討する
  - `5a`: inventory / classification
  - `5b`: security-sensitive stores
  - `5c`: broader runtime wiring / cache

#### Phase 5 boundary enforcement の実行順

新しい current spec に合わせて、Phase 5 の実装順は次を基準にする。

1. tenant override guard
   - `tenant.storage_profile_id` 更新時に、
     environment default と比べて auth core plane が変わらないことを強制する
   - 最初の enforcement point は admin settings update path に置く
2. machine-readable boundary policy
   - boundary class と tenant override policy を code helper にする
   - `users_core` slice が auth core plane shorthand であることを
     helper 側で明示する
3. runtime-profile/admin surface の整合
   - runtime-profile API / UI で
     auth core plane が tenant override 対象外であることを明示する
4. naming cleanup
   - `users_core` の ambiguity を減らすため、
     `auth_core` alias または同等の metadata を検討する
5. setup / external backend wiring の debt 整理
   - `connectionRef` 解決
   - D1-biased な env/setup の整理
   - external backend の end-to-end 現実装化

この execution pass の non-goal:

- auth core plane の tenant-specific backend switching
- canonical store placement の変更
- DO/KV sharding / cache responsibility の再設計
- full PostgreSQL/MySQL parity

## Phase 3 完了後の follow-up

- repo-wide user-store portability
  - Phase 3 では profile model と主要 user-store path の wiring まで完了
  - raw `new D1Adapter(...)` 残骸や non-user-store 領域の portability は後続で整理する
- profile registry backend の運用強化
  - `kv` / `database` backend 自体は実装済み
  - setup UI、secret/reference lifecycle、migration/rollback の運用は未整備
- residency policy の runtime/sharding 接続
  - residency profile の型と pointer は入った
  - 実際の shard placement や region-specific provisioning は後続

## Phase 4 で残している持ち越し

- external primary backend の拡張順
  - まずは `audit + PostgreSQL + Hyperdrive + pg`
  - PostgreSQL primary の request-path write と admin hot query は実装済み
  - MySQL primary も audit scope では実装済み
  - `users_core / users_pii / custom claims` など repo-wide storage portability はさらに後段
- PostgreSQL client の追加選択肢
  - 最初の基準実装は `pg`
  - `postgres.js` など別 client の評価・切替は後段
- Cloudflare 非依存 sink 実装
  - generic HTTP sink は実装済み
  - 例: Firehose 相当
- sink backend config UI / registry の改善
  - audit profile API と setup seed は正本化した
  - Admin UI からも JSON editor で変更できる
  - ただし sink ごとのフォーム UI、接続確認、registry lifecycle はまだ薄い
- target ごとの failure mode
  - 現在は audit profile 単位
  - `archiveFailureMode / sinkFailureMode` を target override したい場合は後段
- canonical ログフォーマットの拡張
  - `authrim.audit.v1` は実装済み
  - version negotiation
  - sink ごとの formatter 選択 UI
  - Firehose 専用 formatter
  は後段
- mirror / dual-write / temporary capture の高度化
  - `targets.primaryStore / archiveStores / forwardingSinks` は実装済み
  - ただし time-window capture や admin UI での高度な rule 編集は後段
- archive scan / hot query
  - archive-only profile での検索は未実装
  - R2/S3 上の log reader か外部製品連携で扱う
- retention / retry / backpressure / delivery guarantee の backend 別設計
  - retention の canonical source は audit profile に寄せた
  - backend/sink ごとの運用 policy はまだ分離していない

### Phase 6 にまとめて扱うもの

- audit の運用強化
  - retention / retry / backpressure / delivery guarantee
- profile registry の運用強化
- Firehose sink
- sink UI 改善
- `users/import` 実処理
- archive-only 検索系

## テスト調整メモ

- `ar-token` package の test script は `op-token: tests skipped` のまま
  - 5b 完了後に package-local test 実行へ戻し、
    Native SSO / security-critical / token-family 系の focused suite を実際に走らせる
- `ar-auth/src/__tests__/authorize-hybrid-flow.test.ts` には `describe.skip` が残る
  - token / session / consent の stateful path 整理後に有効化可否を再評価する
- `direct-auth` の focused suite はまだ薄い
  - logout 時の `revoke_tokens`
  - refresh token family index
  - session invalidation / device secret revoke
  を重点回帰に追加する

## 後段でも意識する前提

- user は `tenant-scoped`
- tenant は environment に閉じる
- environment 間連携は OIDC / Federation で解く
- storage profile は `environment default + tenant override`
- tenant には full JSON ではなく pointer を持たせる
- profile registry backend は deployment profile ごとに選べる
- DB portability は `portable SQL subset` を原則とする
- audit は `primary store / archive store / forwarding sink`
- tenant override の初期対象は `PII / custom / audit`
- auth core plane は current spec では tenant override 対象にしない
- PII plane は製品アーキテクチャとして non-D1 option を必須とする
