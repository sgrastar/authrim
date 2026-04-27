# Storage Portability Phases

最終更新: 2026-04-24

このフォルダは、`is_required` の意味整理から始まり、custom claims の DB portability、storage profile、audit routing までを段階的に進めるためのフェーズ資料をまとめる。

現状:

- Phase 0 完了
- Phase 1 完了
- Phase 2 完了
- Phase 3 完了
- Phase 4 完了
  - canonical rule model
  - managed audit profile
  - queue fan-out
  - runtime delivery plan
  - generic HTTP sink
  - PostgreSQL / MySQL audit primary
  - canonical log format `authrim.audit.v1`
    まで実装済み
- Phase 5 開始
  - repo-wide storage portability の残骸整理
  - Phase 5a: inventory / classification 開始
  - Phase 5b: security-sensitive stores 開始
  - Phase 5c: broader runtime wiring / cache invalidation
- Phase 6 予定
  - audit 運用強化
  - profile registry 運用強化
  - Firehose sink
  - sink UI 改善
  - import runner
  - archive-only 検索

## ファイル一覧

- [00-overview.md](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/storage-portability-phases/00-overview.md)
- [deferred-items.md](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/storage-portability-phases/deferred-items.md)
- [phase-0-requirement-semantics.md](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/storage-portability-phases/phase-0-requirement-semantics.md)
- [phase-1-registration-validation.md](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/storage-portability-phases/phase-1-registration-validation.md)
- [phase-2-custom-claims-db-portability.md](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/storage-portability-phases/phase-2-custom-claims-db-portability.md)
- [phase-3-storage-audit-residency-profiles.md](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/storage-portability-phases/phase-3-storage-audit-residency-profiles.md)
- [phase-4-audit-routing-and-sinks.md](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/storage-portability-phases/phase-4-audit-routing-and-sinks.md)
- [phase-5-repo-wide-storage-portability-cleanup.md](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/storage-portability-phases/phase-5-repo-wide-storage-portability-cleanup.md)
- [phase-5a-inventory-and-classification.md](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/storage-portability-phases/phase-5a-inventory-and-classification.md)
- [phase-5b-security-sensitive-store-portability.md](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/storage-portability-phases/phase-5b-security-sensitive-store-portability.md)
- [phase-5c-runtime-wiring-and-cache.md](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/storage-portability-phases/phase-5c-runtime-wiring-and-cache.md)
- [phase-6-ops-and-followups.md](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/storage-portability-phases/phase-6-ops-and-followups.md)
- [storage-portability-current-spec.md](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/storage-portability-current-spec.md)

## 関連ドキュメント

- [tenant-issuer-db-boundaries.md](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/tenant-issuer-db-boundaries.md)
- [storage-profile-and-db-portability-plan.md](/Users/yuta/Documents/Authrim/authrim/private/docs/architecture/storage-profile-and-db-portability-plan.md)
- [custom-claims-registration-requirements.md](/Users/yuta/Documents/Authrim/authrim/private/docs/features/custom-claims-registration-requirements.md)
