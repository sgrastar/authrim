# Authrim エンタープライズコンプライアンス対応ロードマップ

> SOC 2 Type II / ISO 27001:2022 / NIST CSF 2.0 対応のための機能・ドキュメント・仕組みの提案

---

## 目次

1. [エグゼクティブサマリー](#エグゼクティブサマリー)
2. [現状分析](#現状分析)
3. [コンプライアンスフレームワーク要件](#コンプライアンスフレームワーク要件)
4. [ギャップ分析](#ギャップ分析)
5. [必要な機能の提案](#必要な機能の提案)
6. [必要なドキュメント](#必要なドキュメント)
7. [実装優先度と推奨タイムライン](#実装優先度と推奨タイムライン)
8. [参考資料](#参考資料)

---

## エグゼクティブサマリー

Authrimは、認証・認可の基盤機能において多くのセキュリティ機能を既に実装しています。しかし、企業がSOC 2 Type IIやISO 27001:2022の認証取得を目指す際には、**変更管理**、**アクセスレビュー**、**インシデント対応**、**監査レポート生成**などの追加機能とドキュメント整備が必要です。

### 対応状況サマリー

| フレームワーク | 現在のカバー率 | 追加作業見積 |
|---------------|---------------|-------------|
| SOC 2 Type II (Security) | ~60% | 中規模 |
| ISO 27001:2022 | ~55% | 中規模 |
| NIST CSF 2.0 | ~50% | 中規模 |

---

## 現状分析

### Authrimで既に実装されている機能

#### 認証機能 (Authentication)

| 機能 | 実装状況 | コンプライアンス対応 |
|------|---------|---------------------|
| パスキー/WebAuthn | ✅ 完了 | SOC 2 CC6.1, ISO A.5.17 |
| 多要素認証 (MFA) | ✅ 完了 | SOC 2 CC6.6, ISO A.5.17, NIST PR.AC-7 |
| メールOTP | ✅ 完了 | SOC 2 CC6.1 |
| ソーシャルログイン | ✅ 完了 | - |
| SAML 2.0 IdP/SP | ✅ 完了 | SOC 2 CC6.1, ISO A.5.16 |
| セッション管理 | ✅ 完了 | SOC 2 CC6.1, ISO A.5.18 |
| アカウントロックアウト | ✅ 完了 | SOC 2 CC6.1, ISO A.5.17 |

#### 認可機能 (Authorization)

| 機能 | 実装状況 | コンプライアンス対応 |
|------|---------|---------------------|
| RBAC (役割ベース) | ✅ 完了 | SOC 2 CC6.1/CC6.3, ISO A.5.15 |
| ABAC (属性ベース) | ✅ 完了 | SOC 2 CC6.1, ISO A.5.15 |
| ReBAC (関係ベース) | ✅ 完了 | SOC 2 CC6.1, ISO A.5.15 |
| スコープベースアクセス | ✅ 完了 | OAuth 2.0 準拠 |
| ロール有効期限 | ✅ 完了 | SOC 2 CC6.3 |

#### ロギング・監査機能

| 機能 | 実装状況 | コンプライアンス対応 |
|------|---------|---------------------|
| 構造化ログ | ✅ 完了 | SOC 2 CC7.2, ISO A.8.15 |
| PII監査ログ | ✅ 完了 | GDPR, ISO A.5.34 |
| 操作ログ（暗号化） | ✅ 完了 | SOC 2 CC7.2, ISO A.8.15 |
| イベントログ | ✅ 完了 | SOC 2 CC7.2, ISO A.8.15 |
| セキュリティアラート | ✅ 完了 | SOC 2 CC7.3, ISO A.8.16 |
| リクエストID相関 | ✅ 完了 | 分散トレーシング |

#### セキュリティ機能

| 機能 | 実装状況 | コンプライアンス対応 |
|------|---------|---------------------|
| セキュアヘッダー | ✅ 完了 | SOC 2 CC6.7, ISO A.8.9 |
| レート制限 | ✅ 完了 | SOC 2 CC6.6, ISO A.8.6 |
| CORS設定 | ✅ 完了 | Web Security |
| PII分離アーキテクチャ | ✅ 完了 | GDPR, ISO A.5.34 |
| データ暗号化 (AES-256-GCM) | ✅ 完了 | SOC 2 CC6.7, ISO A.8.24 |
| トークンローテーション | ✅ 完了 | SOC 2 CC6.1 |
| PKCE対応 | ✅ 完了 | RFC 7636 |
| DPoP対応 | ✅ 完了 | RFC 9449 |

#### プロビジョニング

| 機能 | 実装状況 | コンプライアンス対応 |
|------|---------|---------------------|
| SCIM 2.0 | ✅ 完了 | SOC 2 CC6.2/CC6.3, ISO A.5.16 |
| ユーザー削除・匿名化 | ✅ 完了 | GDPR Right to Erasure |

---

## コンプライアンスフレームワーク要件

### SOC 2 Type II - Trust Services Criteria

SOC 2はAICPAが定めるフレームワークで、5つのTrust Services Criteria (TSC)から構成されます。

#### Security (必須) - Common Criteria

| カテゴリ | 概要 | Authrim対応 |
|---------|------|-------------|
| **CC1** | 統制環境 | ドキュメント必要 |
| **CC2** | コミュニケーションと情報 | ドキュメント必要 |
| **CC3** | リスクアセスメント | ドキュメント必要 |
| **CC4** | 監視活動 | 部分実装 |
| **CC5** | 統制活動 | 部分実装 |
| **CC6** | 論理的・物理的アクセス制御 | **大部分実装済み** |
| **CC7** | システム運用 | 部分実装 |
| **CC8** | 変更管理 | **未実装** |
| **CC9** | リスク軽減 | ドキュメント必要 |

#### CC6 詳細要件 (論理的・物理的アクセス制御)

| 要件 | 内容 | 現状 |
|------|------|------|
| CC6.1 | 論理アクセスセキュリティ | ✅ 実装済み |
| CC6.2 | ユーザー登録・認可 | ✅ 実装済み |
| CC6.3 | アクセス変更・削除 | ⚠️ 部分的 (自動レビュー機能なし) |
| CC6.6 | 外部脅威対策 | ✅ 実装済み |
| CC6.7 | データ伝送保護 | ✅ 実装済み |
| CC6.8 | マルウェア対策 | N/A (Cloudflare管理) |

#### CC7 詳細要件 (システム運用)

| 要件 | 内容 | 現状 |
|------|------|------|
| CC7.1 | 脆弱性検出・構成管理 | ⚠️ 部分的 |
| CC7.2 | 異常監視 | ✅ 実装済み |
| CC7.3 | セキュリティイベント評価 | ⚠️ 部分的 (インシデント管理未実装) |
| CC7.4 | インシデント対応 | ❌ 未実装 |
| CC7.5 | インシデント復旧 | ❌ 未実装 |

#### CC8 詳細要件 (変更管理)

| 要件 | 内容 | 現状 |
|------|------|------|
| CC8.1 | 変更の承認・設計・テスト・実装 | ❌ 未実装 |

### ISO 27001:2022 - Annex A Controls

ISO 27001:2022は93のコントロールを4つのテーマに分類しています。

#### 組織的コントロール (A.5) - 37件

| コントロール | 内容 | 現状 |
|-------------|------|------|
| A.5.1 | 情報セキュリティポリシー | ドキュメント必要 |
| A.5.7 | 脅威インテリジェンス (新規) | ❌ 未実装 |
| A.5.15 | アクセス制御 | ✅ 実装済み |
| A.5.16 | ID管理 | ✅ 実装済み |
| A.5.17 | 認証情報 | ✅ 実装済み |
| A.5.18 | アクセス権 | ⚠️ 部分的 (レビュー機能なし) |
| A.5.23 | クラウドサービスセキュリティ (新規) | ドキュメント必要 |
| A.5.24 | インシデント管理計画 | ❌ 未実装 |
| A.5.25 | インシデント評価 | ⚠️ 部分的 |
| A.5.26 | インシデント対応 | ❌ 未実装 |
| A.5.27 | インシデントからの学習 | ❌ 未実装 |
| A.5.30 | ICT事業継続準備 (新規) | ❌ 未実装 |

#### 技術的コントロール (A.8) - 34件

| コントロール | 内容 | 現状 |
|-------------|------|------|
| A.8.1 | ユーザーエンドポイントデバイス | N/A |
| A.8.2 | 特権アクセス権 | ✅ 実装済み |
| A.8.3 | 情報アクセス制限 | ✅ 実装済み |
| A.8.5 | セキュア認証 | ✅ 実装済み |
| A.8.6 | キャパシティ管理 | ⚠️ 部分的 |
| A.8.9 | 構成管理 (新規) | ⚠️ 部分的 |
| A.8.15 | ロギング | ✅ 実装済み |
| A.8.16 | 監視活動 (新規) | ⚠️ 部分的 |
| A.8.24 | 暗号化の使用 | ✅ 実装済み |

### NIST Cybersecurity Framework 2.0

NIST CSF 2.0は6つのコア機能から構成されます。

| 機能 | 概要 | 現状 |
|------|------|------|
| **GOVERN (新規)** | ガバナンス・リスク管理 | ドキュメント必要 |
| **IDENTIFY** | 資産・リスク特定 | ⚠️ 部分的 |
| **PROTECT** | 保護措置 | ✅ 大部分実装 |
| **DETECT** | 検知 | ✅ 大部分実装 |
| **RESPOND** | 対応 | ❌ 未実装 |
| **RECOVER** | 復旧 | ❌ 未実装 |

---

## ギャップ分析

### 高優先度ギャップ (必須対応)

#### 1. 変更管理機能 (Change Management)

**対応フレームワーク**: SOC 2 CC8.1, ISO A.8.32

**現状**: 変更管理のシステム的なサポートがない

**必要な機能**:
- 変更リクエスト (Change Request) 管理
- 承認ワークフロー
- 変更履歴の追跡
- ロールバック機能
- 変更影響評価

#### 2. アクセスレビュー機能 (Access Review)

**対応フレームワーク**: SOC 2 CC6.3, ISO A.5.18

**現状**: ユーザーアクセスの定期レビュー機能がない

**必要な機能**:
- 定期的なアクセスレビューキャンペーン
- レビュー担当者へのタスク割り当て
- レビュー結果の記録・証跡
- 自動失効/アラート

#### 3. インシデント対応機能 (Incident Response)

**対応フレームワーク**: SOC 2 CC7.3-7.5, ISO A.5.24-A.5.27, NIST RS

**現状**: セキュリティアラートテーブルはあるが、インシデント管理ワークフローがない

**必要な機能**:
- インシデントライフサイクル管理
- エスカレーション設定
- 対応記録・タイムライン
- Post-mortem テンプレート

### 中優先度ギャップ

#### 4. 監査レポート生成機能

**対応フレームワーク**: SOC 2全般, ISO A.5.36

**現状**: ログは出力されるが、監査用レポート生成機能がない

**必要な機能**:
- コンプライアンスダッシュボード
- 定期レポート自動生成
- 監査証拠エクスポート
- カスタムレポートビルダー

#### 5. 脆弱性管理機能

**対応フレームワーク**: SOC 2 CC7.1, ISO A.8.8, NIST ID.RA

**現状**: 外部脆弱性スキャン結果の管理機能がない

**必要な機能**:
- 脆弱性トラッキング
- 修復期限管理
- SLA監視

#### 6. ビジネス継続性機能

**対応フレームワーク**: ISO A.5.30, NIST RC

**現状**: Cloudflare基盤に依存、明示的なDR計画なし

**必要な機能**:
- 自動バックアップ検証
- 復旧テスト記録
- RTO/RPO監視

### 低優先度ギャップ

#### 7. 脅威インテリジェンス連携

**対応フレームワーク**: ISO A.5.7

**現状**: 外部脅威インテリジェンスフィードの連携なし

#### 8. サプライチェーンセキュリティ

**対応フレームワーク**: NIST CSF 2.0 GV.SC, ISO A.5.19-A.5.22

**現状**: 依存関係の脆弱性監視が限定的

---

## 必要な機能の提案

### Phase 1: 基盤機能 (高優先度)

#### 1.1 変更管理システム

```typescript
// 提案: Change Request API
interface ChangeRequest {
  id: string;
  tenant_id: string;
  title: string;
  description: string;
  type: 'standard' | 'emergency' | 'normal';
  category: 'infrastructure' | 'application' | 'data' | 'configuration' | 'access';
  status: 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'in_progress' | 'completed' | 'rolled_back';

  // 変更詳細
  change_details: {
    affected_systems: string[];
    impact_assessment: string;
    rollback_plan: string;
    test_plan: string;
  };

  // 承認フロー
  approvals: {
    approver_id: string;
    role: string;
    status: 'pending' | 'approved' | 'rejected';
    comment?: string;
    decided_at?: number;
  }[];

  // 監査証跡
  created_by: string;
  created_at: number;
  updated_at: number;
  completed_at?: number;
}
```

**API エンドポイント**:
- `POST /api/changes` - 変更リクエスト作成
- `GET /api/changes` - 変更リクエスト一覧
- `PUT /api/changes/:id/approve` - 承認
- `PUT /api/changes/:id/reject` - 却下
- `PUT /api/changes/:id/complete` - 完了
- `PUT /api/changes/:id/rollback` - ロールバック
- `GET /api/changes/:id/audit-trail` - 監査証跡

#### 1.2 アクセスレビューシステム

```typescript
// 提案: Access Review Campaign API
interface AccessReviewCampaign {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  status: 'draft' | 'active' | 'completed' | 'cancelled';

  // スケジュール
  start_date: number;
  end_date: number;
  reminder_frequency_days: number;

  // スコープ
  scope: {
    type: 'all_users' | 'role' | 'organization' | 'resource';
    filter?: Record<string, unknown>;
  };

  // レビュー対象
  items: AccessReviewItem[];

  // 統計
  statistics: {
    total_items: number;
    reviewed: number;
    approved: number;
    revoked: number;
    pending: number;
  };

  created_by: string;
  created_at: number;
}

interface AccessReviewItem {
  id: string;
  campaign_id: string;
  subject_id: string;
  subject_type: 'user' | 'service';

  // レビュー対象アクセス
  access: {
    type: 'role' | 'permission' | 'relationship';
    name: string;
    scope?: string;
    granted_at: number;
    last_used_at?: number;
  };

  // レビュー結果
  reviewer_id?: string;
  decision?: 'approve' | 'revoke' | 'modify';
  decision_reason?: string;
  reviewed_at?: number;

  // 自動実行
  action_executed: boolean;
  action_executed_at?: number;
}
```

**API エンドポイント**:
- `POST /api/access-reviews` - キャンペーン作成
- `GET /api/access-reviews` - キャンペーン一覧
- `GET /api/access-reviews/:id/items` - レビュー項目取得
- `PUT /api/access-reviews/:id/items/:itemId` - レビュー決定
- `POST /api/access-reviews/:id/execute` - 決定実行
- `GET /api/access-reviews/:id/report` - レポート生成

#### 1.3 インシデント管理システム

```typescript
// 提案: Security Incident Management API
interface SecurityIncident {
  id: string;
  tenant_id: string;

  // 基本情報
  title: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'open' | 'investigating' | 'contained' | 'eradicated' | 'recovered' | 'closed';
  category: 'unauthorized_access' | 'data_breach' | 'malware' | 'phishing' | 'dos' | 'insider_threat' | 'other';

  // 関連アラート
  related_alert_ids: string[];

  // タイムライン
  detected_at: number;
  reported_at: number;
  contained_at?: number;
  resolved_at?: number;
  closed_at?: number;

  // 担当者
  assignee_id?: string;
  escalation_level: number;

  // 影響評価
  impact: {
    affected_users: number;
    affected_systems: string[];
    data_compromised: boolean;
    business_impact: string;
  };

  // 対応記録
  timeline_entries: IncidentTimelineEntry[];

  // Post-mortem
  post_mortem?: {
    root_cause: string;
    lessons_learned: string;
    preventive_actions: string[];
    completed_at: number;
  };
}

interface IncidentTimelineEntry {
  id: string;
  timestamp: number;
  type: 'detection' | 'escalation' | 'action' | 'communication' | 'status_change' | 'note';
  actor_id: string;
  description: string;
  details?: Record<string, unknown>;
}
```

**API エンドポイント**:
- `POST /api/incidents` - インシデント作成
- `GET /api/incidents` - インシデント一覧
- `PUT /api/incidents/:id` - インシデント更新
- `POST /api/incidents/:id/timeline` - タイムラインエントリ追加
- `PUT /api/incidents/:id/escalate` - エスカレーション
- `POST /api/incidents/:id/post-mortem` - Post-mortem記録
- `GET /api/incidents/:id/report` - インシデントレポート

### Phase 2: 監査・レポート機能

#### 2.1 コンプライアンスダッシュボード

```typescript
interface ComplianceDashboard {
  framework: 'soc2' | 'iso27001' | 'nist_csf';

  // コントロール状況
  controls: {
    id: string;
    name: string;
    category: string;
    status: 'compliant' | 'partial' | 'non_compliant' | 'not_applicable';
    evidence_count: number;
    last_review_date?: number;
    next_review_date?: number;
    findings: string[];
  }[];

  // 統計
  statistics: {
    total_controls: number;
    compliant: number;
    partial: number;
    non_compliant: number;
    not_applicable: number;
    compliance_score: number; // 0-100%
  };

  // トレンド
  trends: {
    date: string;
    compliance_score: number;
  }[];
}
```

#### 2.2 監査証拠収集・エクスポート

```typescript
interface AuditEvidenceExport {
  id: string;
  tenant_id: string;

  // エクスポート設定
  framework: 'soc2' | 'iso27001' | 'nist_csf';
  period_start: number;
  period_end: number;
  controls?: string[]; // 特定コントロールのみ

  // 含めるデータ
  include: {
    access_logs: boolean;
    change_logs: boolean;
    user_access_reviews: boolean;
    incident_reports: boolean;
    configuration_snapshots: boolean;
    policy_documents: boolean;
  };

  // エクスポート状態
  status: 'pending' | 'processing' | 'completed' | 'failed';
  file_url?: string;
  file_format: 'zip' | 'pdf';

  created_by: string;
  created_at: number;
  completed_at?: number;
}
```

**API エンドポイント**:
- `GET /api/compliance/dashboard/:framework` - ダッシュボード取得
- `POST /api/compliance/evidence/export` - 証拠エクスポート開始
- `GET /api/compliance/evidence/export/:id` - エクスポート状態確認
- `GET /api/compliance/reports/access` - アクセスレポート
- `GET /api/compliance/reports/changes` - 変更レポート
- `GET /api/compliance/reports/incidents` - インシデントレポート

#### 2.3 自動レポート生成

```typescript
interface ScheduledReport {
  id: string;
  tenant_id: string;
  name: string;

  // スケジュール
  frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly';
  day_of_week?: number;
  day_of_month?: number;
  time: string; // HH:MM

  // レポート内容
  report_type: 'access_summary' | 'change_summary' | 'incident_summary' | 'compliance_status' | 'custom';
  parameters?: Record<string, unknown>;

  // 配信
  recipients: {
    type: 'email' | 'webhook' | 'storage';
    destination: string;
  }[];

  // 履歴
  last_run_at?: number;
  next_run_at: number;

  is_active: boolean;
}
```

### Phase 3: 高度なセキュリティ機能

#### 3.1 脆弱性管理

```typescript
interface VulnerabilityRecord {
  id: string;
  tenant_id: string;

  // 脆弱性情報
  cve_id?: string;
  title: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  cvss_score?: number;

  // 影響範囲
  affected_component: string;
  affected_versions?: string[];

  // ステータス
  status: 'open' | 'in_progress' | 'mitigated' | 'resolved' | 'accepted' | 'false_positive';

  // SLA
  discovered_at: number;
  sla_deadline: number;
  resolved_at?: number;

  // 対応
  assignee_id?: string;
  remediation_plan?: string;
  remediation_notes?: string;
}
```

#### 3.2 設定変更追跡 (Configuration Drift Detection)

```typescript
interface ConfigurationSnapshot {
  id: string;
  tenant_id: string;

  // スナップショット情報
  taken_at: number;
  component: 'oauth_client' | 'idp' | 'policy' | 'role' | 'scope_mapping' | 'tenant_settings';
  component_id: string;

  // 設定値
  configuration_hash: string;
  configuration_json: string;

  // 変更検出
  previous_snapshot_id?: string;
  has_drift: boolean;
  drift_details?: {
    field: string;
    old_value: unknown;
    new_value: unknown;
  }[];
}
```

### Phase 4: 統合・自動化

#### 4.1 Webhook統合

既存のWebhookシステムを拡張し、コンプライアンス関連イベントの通知を追加:

```typescript
type ComplianceWebhookEvent =
  | 'change_request.created'
  | 'change_request.approved'
  | 'change_request.rejected'
  | 'change_request.completed'
  | 'access_review.campaign_started'
  | 'access_review.completed'
  | 'access_review.access_revoked'
  | 'incident.created'
  | 'incident.escalated'
  | 'incident.resolved'
  | 'compliance.score_changed'
  | 'vulnerability.discovered'
  | 'vulnerability.sla_breach';
```

#### 4.2 SIEM連携

```typescript
interface SIEMIntegration {
  id: string;
  tenant_id: string;

  // 連携先
  type: 'splunk' | 'datadog' | 'elastic' | 'azure_sentinel' | 'custom_webhook';

  // 接続設定
  endpoint: string;
  authentication: {
    type: 'api_key' | 'bearer' | 'basic' | 'oauth2';
    credentials_secret_id: string;
  };

  // 送信設定
  events_to_send: string[];
  format: 'cef' | 'leef' | 'json';
  batch_size: number;
  flush_interval_seconds: number;

  is_active: boolean;
}
```

---

## 必要なドキュメント

SOC 2やISO 27001認証取得には、技術実装だけでなく以下のポリシー・手順ドキュメントが必須です。

### 必須ポリシードキュメント

| ドキュメント | SOC 2 | ISO 27001 | 優先度 |
|-------------|-------|-----------|--------|
| 情報セキュリティポリシー | CC1 | A.5.1 | 高 |
| アクセス制御ポリシー | CC6 | A.5.15 | 高 |
| 変更管理ポリシー | CC8 | A.8.32 | 高 |
| インシデント対応計画 | CC7 | A.5.24 | 高 |
| データ分類ポリシー | CC6.7 | A.5.12 | 高 |
| 暗号化ポリシー | CC6.7 | A.8.24 | 中 |
| 事業継続計画 | CC9 | A.5.30 | 中 |
| サプライヤーセキュリティポリシー | CC9 | A.5.19 | 中 |
| 人的セキュリティポリシー | CC1 | A.6 | 中 |
| 物理セキュリティポリシー | CC6.4 | A.7 | 低 |

### 手順ドキュメント

| ドキュメント | 対応コントロール | 優先度 |
|-------------|-----------------|--------|
| ユーザーアクセスプロビジョニング手順 | CC6.2 | 高 |
| アクセス権レビュー手順 | CC6.3 | 高 |
| 変更リクエスト処理手順 | CC8.1 | 高 |
| セキュリティインシデント対応手順 | CC7.3-7.5 | 高 |
| バックアップ・復旧手順 | CC7.5 | 中 |
| ログレビュー手順 | CC7.2 | 中 |
| 脆弱性管理手順 | CC7.1 | 中 |

### Authrim利用企業向けドキュメントテンプレート

Authrimが提供すべきテンプレートドキュメント:

1. **アクセス制御ポリシーテンプレート** (`docs/templates/access-control-policy.md`)
2. **変更管理ポリシーテンプレート** (`docs/templates/change-management-policy.md`)
3. **インシデント対応計画テンプレート** (`docs/templates/incident-response-plan.md`)
4. **Authrim設定ガイド (コンプライアンス向け)** (`docs/compliance-configuration-guide.md`)
5. **監査準備チェックリスト** (`docs/audit-preparation-checklist.md`)

---

## 実装優先度と推奨タイムライン

### Phase 1: 基盤機能 (高優先度)

**推奨実装順序**:

1. **変更管理システム**
   - データベーススキーマ設計
   - API実装
   - 管理UI実装
   - Webhook連携

2. **アクセスレビュー機能**
   - キャンペーン管理
   - レビューワークフロー
   - 自動失効実行
   - レポート機能

3. **インシデント管理**
   - インシデントライフサイクル
   - タイムライン記録
   - エスカレーション
   - Post-mortem

### Phase 2: 監査・レポート機能

**推奨実装順序**:

1. **コンプライアンスダッシュボード**
   - SOC 2マッピング
   - ISO 27001マッピング
   - スコア計算

2. **監査証拠エクスポート**
   - ログ集約
   - レポート生成
   - ZIP/PDFエクスポート

3. **定期レポート**
   - スケジューラー実装
   - 配信機能

### Phase 3: 高度なセキュリティ機能

1. **脆弱性管理**
2. **設定ドリフト検出**
3. **脅威インテリジェンス連携**

### Phase 4: 統合・自動化

1. **SIEM連携**
2. **GRC統合**
3. **自動テスト・検証**

---

## 実装時の技術的考慮事項

### データベース設計

```sql
-- 変更管理テーブル
CREATE TABLE change_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('standard', 'emergency', 'normal')),
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  change_details_json TEXT NOT NULL,
  approvals_json TEXT DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX idx_change_requests_tenant_status ON change_requests(tenant_id, status);
CREATE INDEX idx_change_requests_created_at ON change_requests(created_at);

-- アクセスレビューキャンペーンテーブル
CREATE TABLE access_review_campaigns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  scope_json TEXT NOT NULL,
  start_date INTEGER NOT NULL,
  end_date INTEGER NOT NULL,
  reminder_frequency_days INTEGER DEFAULT 7,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE access_review_items (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  subject_type TEXT NOT NULL DEFAULT 'user',
  access_json TEXT NOT NULL,
  reviewer_id TEXT,
  decision TEXT,
  decision_reason TEXT,
  reviewed_at INTEGER,
  action_executed INTEGER DEFAULT 0,
  action_executed_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (campaign_id) REFERENCES access_review_campaigns(id)
);

CREATE INDEX idx_access_review_items_campaign ON access_review_items(campaign_id);
CREATE INDEX idx_access_review_items_reviewer ON access_review_items(reviewer_id, decision);

-- セキュリティインシデントテーブル
CREATE TABLE security_incidents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  status TEXT NOT NULL DEFAULT 'open',
  category TEXT NOT NULL,
  related_alert_ids_json TEXT DEFAULT '[]',
  impact_json TEXT,
  post_mortem_json TEXT,
  assignee_id TEXT,
  escalation_level INTEGER DEFAULT 0,
  detected_at INTEGER NOT NULL,
  reported_at INTEGER NOT NULL,
  contained_at INTEGER,
  resolved_at INTEGER,
  closed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE incident_timeline_entries (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  description TEXT NOT NULL,
  details_json TEXT,
  FOREIGN KEY (incident_id) REFERENCES security_incidents(id)
);

CREATE INDEX idx_security_incidents_tenant_status ON security_incidents(tenant_id, status);
CREATE INDEX idx_security_incidents_severity ON security_incidents(severity, status);
CREATE INDEX idx_incident_timeline_incident ON incident_timeline_entries(incident_id, timestamp);
```

### API 設計原則

1. **監査証跡の自動記録**: すべてのAPI操作は`audit_log`または`event_log`に記録
2. **承認フローの強制**: 変更管理APIは承認ステータスチェックを必須化
3. **ロールベースアクセス**: コンプライアンス機能は`compliance_admin`ロールを新設
4. **Webhook通知**: 重要な状態変更時に自動通知

### UI/UX設計

管理ダッシュボード (`ar-ui`) への追加画面:

1. **変更管理ダッシュボード** (`/admin/changes`)
2. **アクセスレビュー管理** (`/admin/access-reviews`)
3. **インシデント管理** (`/admin/incidents`)
4. **コンプライアンスダッシュボード** (`/admin/compliance`)
5. **レポート生成** (`/admin/reports`)

---

## 参考資料

### 公式ドキュメント

- [AICPA SOC 2 - Trust Services Criteria](https://www.aicpa-cima.com/topic/audit-assurance/audit-and-assurance-greater-than-soc-2)
- [ISO/IEC 27001:2022 - Information Security Management](https://www.iso.org/standard/27001)
- [NIST Cybersecurity Framework 2.0](https://www.nist.gov/cyberframework)
- [NIST CSF 2.0 PDF](https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf)

### SOC 2 Common Criteria 詳細

- [CC6 - Logical and Physical Access Controls](https://www.isms.online/soc-2/controls/logical-and-physical-access-controls-cc6-1-explained/)
- [CC7 - System Operations](https://www.hicomply.com/hub/soc-2-controls-cc7-system-operations)
- [CC8 - Change Management](https://www.hicomply.com/hub/soc-2-controls-cc8-change-management)

### ISO 27001:2022 コントロール

- [ISO 27001 Annex A Controls Overview](https://www.dataguard.com/iso-27001/annex-a/)
- [ISO 27001 A.8.15 Logging](https://www.isms.online/iso-27001/annex-a-2022/8-15-logging-2022/)
- [ISO 27001 A.8.16 Monitoring Activities](https://www.isms.online/iso-27001/annex-a-2022/8-16-monitoring-activities-2022/)

---

## 結論

Authrimは認証・認可の基盤機能において堅牢な実装を持っていますが、エンタープライズコンプライアンス対応のためには以下の追加が必要です:

### 必須機能追加

1. **変更管理システム** - SOC 2 CC8対応
2. **アクセスレビュー機能** - SOC 2 CC6.3 / ISO A.5.18対応
3. **インシデント管理機能** - SOC 2 CC7 / ISO A.5.24-27対応
4. **監査レポート生成** - 全フレームワーク対応

### 必須ドキュメント

1. ポリシーテンプレート一式
2. コンプライアンス設定ガイド
3. 監査準備チェックリスト

これらの機能とドキュメントを追加することで、Authrimを採用する企業がSOC 2 Type II、ISO 27001:2022、NIST CSF 2.0の認証取得プロセスを大幅に効率化できます。

---

> **Document Version**: 1.0
> **Last Updated**: 2026-01-08
> **Author**: Compliance Analysis Team
