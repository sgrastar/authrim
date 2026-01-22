# マイグレーション修正計画

## 問題の概要

コードはPII分離アーキテクチャを使用していますが、マイグレーションファイルは古い統合スキーマのままです。

## スキーマの不整合

### 1. `users` vs `users_core` (Core DB)

**現在のマイグレーション (`users`):**

- id, email, name, address, ... (PII含む)

**コードが期待する (`users_core`):**

- id
- tenant_id
- email_verified (boolean)
- phone_number_verified (boolean)
- email_domain_hash (blind index)
- password_hash
- is_active
- user_type (end_user | admin | m2m | anonymous)
- pii_partition
- pii_status (none | pending | active | failed | deleted)
- status (active | suspended | locked)
- suspended_at, suspended_until
- locked_at, locked_until
- created_at, updated_at, last_login_at

### 2. `verified_attributes` vs `user_verified_attributes`

テーブル名が異なる

### 3. 完全に欠落しているテーブル

| テーブル名               | 参照数 | 必要なDB |
| ------------------------ | ------ | -------- |
| session_clients          | 20     | Core     |
| device_secrets           | 26     | Core     |
| settings_history         | 10     | Core     |
| org_domain_mappings      | 12     | Core     |
| status_lists             | 9      | Core     |
| trusted_issuers          | 5      | Core     |
| operational_logs         | 6      | Core     |
| webhook_configs          | 9      | Core     |
| issued_credentials       | 9      | Core     |
| did_document_cache       | 9      | Core     |
| event_log                | 18     | Core     |
| consent_policy_versions  | 6      | Core     |
| attribute_verifications  | 7      | Core     |
| pii_log                  | 19     | PII      |
| user_anonymization_map   | 6      | PII      |
| user_verified_attributes | 9      | Core     |

## 修正手順

### Step 1: 新しいマイグレーションファイルを作成

`migrations/002_pii_separation.sql` を作成し、以下を実行:

1. `users` テーブルを `users_core` にリネーム（既存環境用）
2. `users_core` のスキーマを更新
3. 欠落しているテーブルを追加
4. `verified_attributes` を `user_verified_attributes` にリネーム

### Step 2: 統合マイグレーションを更新

`001_consolidated_schema.sql` を新規環境向けに更新:

- `users` → `users_core` (正しいスキーマ)
- 欠落テーブルを追加

### Step 3: PII マイグレーションを更新

`pii/001_pii_initial.sql` に追加:

- `pii_log` テーブル
- `user_anonymization_map` テーブル

### Step 4: 既存環境の修正

- test2環境: ALTER TABLE 実行
- new環境: ALTER TABLE 実行

## 実行順序

1. `001_consolidated_schema.sql` を修正（新規環境用）
2. `002_pii_separation.sql` を作成（既存環境用）
3. 既存環境に002を適用
4. テスト
