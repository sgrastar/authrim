# Authrim v1.0.0 リリース準備チェックリスト

**作成日:** 2026-01-18
**現在バージョン:** 0.1.5
**ターゲット:** 2026-Q1 (1月〜3月)

---

## 概要

このチェックリストは、Authrim v1.0.0リリースに向けて必要な作業を整理したものです。
機能要件、非機能要件、ドキュメント、認証・リリース準備の4カテゴリに分類しています。

**進捗サマリー:**
- Phase 1-9: ✅ Complete
- Phase 10 (SDK & API): 🔜 Planned (0%)
- Phase 11 (Security & QA): ⏳ ~30%
- Phase 12 (Certification & Release): 🔜 Planned

---

## 1. 機能要件 (Functional Requirements)

### 1.1 Phase 10: SDK & API (未着手)

| 項目 | 状態 | 優先度 | 備考 |
|------|------|--------|------|
| @authrim/sdk-core | ⬜ 未着手 | 高 | Headless OIDC/PKCE クライアント |
| @authrim/sdk-web | ⬜ 未着手 | 中 | Web Components (Lit/Stencil) |
| @authrim/sdk-react | ⬜ 未着手 | 高 | React hooks and components |
| CDN Bundle | ⬜ 未着手 | 中 | `authrim-sdk.min.js` for `<script>` usage |
| OpenAPI Spec | ⬜ 未着手 | 高 | 完全なAPI仕様書 |
| API Portal | ⬜ 未着手 | 中 | インタラクティブドキュメント |
| Login Flow Designer | ⬜ 未着手 | 低 | ビジュアルログインページ設定 |
| Policy Admin Console | ⬜ 未着手 | 中 | Role Editor, Policy Editor, ReBAC Graph |

### 1.2 コード内TODO (技術的負債)

| ファイル | 内容 | 優先度 | 備考 |
|----------|------|--------|------|
| `ar-token/src/token.ts:3762` | External JWKS fetching for ID-JAG validation | 中 | ID-JAG完全対応に必要 |
| `ar-management/src/admin-stats.ts:225` | Timezone conversion with luxon | 低 | UI改善 |
| `ar-saml/src/idp/slo.ts:191` | Multiple SP logout propagation | 中 | SAML SLO完全対応 |
| `ar-lib-scim/src/utils/scim-mapper.ts:228` | Groups support | 高 | エンタープライズ必須 |
| `ar-lib-plugin/src/core/loader.ts:271` | Plugin enabled status from config store | 低 | プラグイン管理改善 |
| `ar-lib-core/src/services/backchannel-logout-sender.ts:541` | Alerting mechanism | 中 | 運用監視に必要 |
| `ar-lib-core/src/utils/ciba.ts:422,521` | CIBA signature verification (JWKS) | 中 | セキュリティ強化 |
| `ar-auth/src/flow-engine/flow-executor.ts:237,282,304` | Flow type persistence, redirect URL | 低 | Flow Engine改善 |
| `ar-management/src/routes/settings/*.ts` | created_by / granted_by context tracking | 低 | 監査ログ改善 |
| `ar-ui/src/routes/ciba/+page.svelte:31` | Get user info from session | 低 | CIBA UI改善 |
| `ar-ui/src/routes/error/+page.svelte:41` | Add support email or link | 低 | UX改善 |
| `ar-async/src/ciba-*.ts` | Rate limiting, JWKS, user notification | 中 | CIBA完全対応 |

### 1.3 Admin UI未完了機能

| 項目 | 状態 | 優先度 | 備考 |
|------|------|--------|------|
| Attribute Mapping UI | ⚠️ 部分実装 | 中 | ビジュアルclaim mapping editor |
| Login Flow Designer | ⬜ 未着手 | 低 | 認証フロー順序設定 |
| Credential Status (VCI) | ⬜ 未着手 | 中 | Revocation/suspension support |

---

## 2. 非機能要件 (Non-Functional Requirements)

### 2.1 セキュリティ (Phase 11: ~30% 完了)

| 項目 | 状態 | 優先度 | 備考 |
|------|------|--------|------|
| External Security Audit | ⬜ 未実施 | **最高** | 第三者によるセキュリティ監査 |
| Penetration Testing | ⬜ 未実施 | **最高** | 第三者によるペネトレーションテスト |
| Security Hardening | ⏳ ~30% | 高 | DPoP ath ✅, JWT alg consistency ✅ |
| OWASP Top 10 対策確認 | ⬜ 未確認 | 高 | 包括的なセキュリティチェック |
| Rate Limiting 完全実装 | ⬜ 要確認 | 高 | 全エンドポイントでの制限 |
| Secret/Key Management Review | ⬜ 未実施 | 高 | 鍵管理のベストプラクティス確認 |

### 2.2 テスト

| 項目 | 状態 | 優先度 | 備考 |
|------|------|--------|------|
| Unit Test Coverage | ⏳ 部分的 | 高 | 現在 218 test files |
| Integration Test Coverage | ⏳ 部分的 | 高 | - |
| E2E Test Coverage | ⏳ 部分的 | 中 | Playwright 5 test files |
| Load Testing | ✅ 完了 | - | 3,500 RPS達成 |
| OpenID Conformance (Hybrid OP) | ⬜ 未実施 | 高 | 認証取得に必要 |
| OpenID Conformance (Dynamic OP) | ⬜ 未実施 | 高 | 認証取得に必要 |
| OpenID Conformance (RP profiles) | ⬜ 未実施 | 中 | RP機能の検証 |

### 2.3 パフォーマンス・可用性

| 項目 | 状態 | 優先度 | 備考 |
|------|------|--------|------|
| Load Testing | ✅ 完了 | - | Dec 2025実施済み |
| DO Sharding最適化 | ✅ 完了 | - | 128 shards (Silent Auth) |
| Error Recovery / Retry | ⬜ 要確認 | 中 | 障害時の復旧手順 |
| Backup & Restore | ⬜ 要確認 | 中 | D1データのバックアップ |

### 2.4 運用

| 項目 | 状態 | 優先度 | 備考 |
|------|------|--------|------|
| Monitoring & Alerting | ⬜ 要確認 | 高 | 監視・アラート設計 |
| Logging Best Practices | ✅ 完了 | - | docs/logging.md |
| Audit Log完全実装 | ⏳ 部分的 | 中 | created_by tracking等 |

---

## 3. ドキュメント (Documentation)

### 3.1 API ドキュメント

| 項目 | 状態 | 優先度 | 備考 |
|------|------|--------|------|
| OpenAPI Specification | ⬜ 未作成 | **最高** | 全APIの仕様書 |
| API Reference | ⬜ 未作成 | 高 | エンドポイント一覧 |
| Error Code Reference | ⏳ 部分的 | 高 | `private/docs/error-codes-inventory.md`参照 |
| Webhook Reference | ⬜ 未作成 | 中 | Webhook仕様 |

### 3.2 開発者ガイド

| 項目 | 状態 | 優先度 | 備考 |
|------|------|--------|------|
| Getting Started | ✅ 完了 | - | docs/getting-started/ |
| Development Guide | ✅ 完了 | - | docs/getting-started/development.md |
| Deployment Guide | ✅ 完了 | - | docs/getting-started/deployment.md |
| Testing Guide | ✅ 完了 | - | docs/getting-started/testing.md |
| SDK Quick Start | ⬜ 未作成 | 高 | SDK使用方法 (Phase 10) |
| Error Handling Guide | ⬜ 未作成 | 高 | エラー処理ベストプラクティス |
| Security Considerations | ⬜ 未作成 | 高 | セキュリティ実装ガイド |
| Troubleshooting Guide | ⬜ 未作成 | 中 | 問題解決ガイド |
| Advanced Configuration | ⬜ 未作成 | 中 | 高度な設定例 |

### 3.3 運用ガイド

| 項目 | 状態 | 優先度 | 備考 |
|------|------|--------|------|
| Production Deployment Guide | ⬜ 未作成 | 高 | 本番環境構築手順 |
| Scaling Guide | ⬜ 未作成 | 中 | スケーリング設計 |
| Disaster Recovery | ⬜ 未作成 | 中 | 障害復旧手順 |
| Upgrade Guide | ⬜ 未作成 | 高 | バージョンアップ手順 |

### 3.4 移行ガイド

| 項目 | 状態 | 優先度 | 備考 |
|------|------|--------|------|
| Auth0 Migration Guide | ⬜ 未作成 | 高 | Auth0からの移行手順 |
| Keycloak Migration Guide | ⬜ 未作成 | 中 | Keycloakからの移行手順 |
| Okta Migration Guide | ⬜ 未作成 | 中 | Oktaからの移行手順 |
| Generic OIDC Migration | ⬜ 未作成 | 中 | 汎用OIDCからの移行 |

### 3.5 その他ドキュメント

| 項目 | 状態 | 優先度 | 備考 |
|------|------|--------|------|
| README.md | ✅ 完了 | - | 17KB |
| ROADMAP.md | ✅ 完了 | - | 40KB |
| SECURITY.md | ✅ 完了 | - | 責任ある開示 |
| CONTRIBUTING.md | ✅ 完了 | - | 貢献ガイドライン |
| CHANGELOG.md | ⬜ 未作成 | 高 | 変更履歴 |
| LICENSE | ✅ 完了 | - | Apache 2.0 |

---

## 4. 認証・リリース準備 (Phase 12)

### 4.1 OpenID Certification

| 項目 | 状態 | 優先度 | 備考 |
|------|------|--------|------|
| Basic OP Certification | ⬜ 申請前 | **最高** | 現在78.95%通過 |
| Config OP Certification | ⬜ 申請前 | **最高** | 現在100%通過 |
| Hybrid OP Certification | ⬜ 未テスト | 高 | テスト必要 |
| Dynamic OP Certification | ⬜ 未テスト | 高 | テスト必要 |
| FAPI 2.0 Certification | ⬜ 未テスト | 中 | Contract Presets実装済み |
| Test Environment Provision | ⬜ 未準備 | 高 | 認証用テスト環境 |
| OpenID Foundation Submission | ⬜ 未申請 | **最高** | 正式申請 |

### 4.2 パブリックリリース準備

| 項目 | 状態 | 優先度 | 備考 |
|------|------|--------|------|
| GitHub Public Repository | ⬜ 未公開 | **最高** | オープンソース化 |
| create-authrim NPM Package | ⬜ 未作成 | 高 | プロジェクトスキャフォールディング |
| Setup Wizard改善 | ⬜ 要確認 | 中 | インタラクティブ設定 |
| Demo Site | ⬜ 未作成 | 中 | デモ環境 |
| Landing Page | ⬜ 未作成 | 中 | 製品紹介ページ |
| Public Announcement | ⬜ 未準備 | 高 | リリース告知 |

### 4.3 コミュニティ準備

| 項目 | 状態 | 優先度 | 備考 |
|------|------|--------|------|
| Issue Templates | ⬜ 要確認 | 中 | Bug report, Feature request |
| Discussion Forum | ⬜ 未準備 | 低 | GitHub Discussions or Discord |
| Support Channel | ⬜ 未準備 | 中 | サポート窓口 |

---

## 5. リリースブロッカー (Must Have for v1.0.0)

以下は **v1.0.0リリース前に必ず完了が必要** な項目です:

### Critical (P0) - リリース不可

1. ⬜ **External Security Audit** - 第三者セキュリティ監査
2. ⬜ **Penetration Testing** - 第三者ペネトレーションテスト
3. ⬜ **OpenAPI Specification** - API仕様書
4. ⬜ **@authrim/sdk-core** - 基本SDKパッケージ
5. ⬜ **OpenID Foundation Certification** - 正式認証取得
6. ⬜ **GitHub Public Repository** - オープンソース公開
7. ⬜ **CHANGELOG.md** - 変更履歴

### High (P1) - 強く推奨

1. ⬜ **SCIM Groups Support** - エンタープライズ必須機能
2. ⬜ **@authrim/sdk-react** - React開発者向けSDK
3. ⬜ **Error Handling Guide** - 開発者向けドキュメント
4. ⬜ **Production Deployment Guide** - 本番運用ガイド
5. ⬜ **Upgrade Guide** - バージョンアップ手順
6. ⬜ **Auth0 Migration Guide** - 主要な移行パス

### Medium (P2) - あると良い

1. ⬜ Attribute Mapping UI完成
2. ⬜ Policy Admin Console
3. ⬜ Troubleshooting Guide
4. ⬜ Demo Site

---

## 6. 推奨アクションプラン

### 即座に着手すべき項目

1. **セキュリティ監査の手配** - 外部ベンダー選定と契約
2. **OpenAPI Spec作成開始** - 全APIの仕様書化
3. **SDK Core開発開始** - Headless OIDC clientの実装
4. **SCIM Groups実装** - エンタープライズ要件

### 並行して進める項目

- CHANGELOG.md作成
- Error Code Reference完成
- Production Deployment Guide執筆
- OpenID Conformance追加テスト (Hybrid OP, Dynamic OP)

### リリース直前に実施

- ペネトレーションテスト
- OpenID Foundation申請
- GitHub Public化
- リリース告知準備

---

## 7. 参考情報

### 既存ドキュメント

- `/docs/ROADMAP.md` - 詳細なロードマップ
- `/docs/getting-started/` - 開発者向けガイド
- `/docs/ENVIRONMENT_VARIABLES.md` - 環境変数リファレンス
- `/docs/access-control.md` - RBAC/ABAC/ReBAC使用ガイド
- `/load-testing/reports/Dec2025/` - 負荷テストレポート

### 現在の実装状況

- **総パッケージ数:** 18
- **テストファイル数:** 218
- **Svelteコンポーネント:** 87
- **データベースマイグレーション:** 17
- **対応言語:** 11
- **OIDCプロファイル:** 7 (認証済み)
- **ログアウトプロファイル:** 4
- **ソーシャルログインプロバイダー:** 7

---

> **最終更新:** 2026-01-18
> **次回レビュー:** 2026-02-01 (推奨)
