# Enrai - OpenID Conformance Test Results

このディレクトリには、OpenID Conformance Suiteでのテスト結果を保存します。

## ディレクトリ構造

```
test-results/
├── README.md                 # このファイル
├── result-YYYYMMDD-HHMM.json # テスト結果（JSON形式）
└── report-YYYYMMDD.md        # テストレポート（Markdown形式）
```

## テスト結果の保存方法

### 1. OpenID Conformance Suiteからエクスポート

テスト完了後、以下の手順でJSON形式のテスト結果をダウンロードします：

1. テスト結果画面で「Export」ボタンをクリック
2. JSON形式でダウンロード（`conformance-test-result-*.json`）
3. このディレクトリに移動して保存

```bash
# ダウンロードしたファイルを移動
mv ~/Downloads/conformance-test-result-*.json .

# 日付付きでリネーム
mv conformance-test-result-*.json result-$(date +%Y%m%d-%H%M).json
```

### 2. テストレポートの作成

テスト結果を元に、レポートを作成します。テンプレートは [report-template.md](./report-template.md) を使用してください。

```bash
# テンプレートをコピー
cp report-template.md report-$(date +%Y%m%d).md

# エディタで編集
vim report-$(date +%Y%m%d).md
```

## テスト結果の記録

各テスト実施後、以下の情報を記録してください：

| 日付 | テスター | バージョン | 合格率 | レポート |
|------|----------|------------|--------|----------|
| 2025-11-11 | (あなたの名前) | v0.2.0 | XX% | [report-20251111.md](./report-20251111.md) |

## 目標

**Phase 3の目標:**
- Conformance Score: ≥ 85%
- Critical Failures: 0
- すべてのCore Testsに合格

**Phase 5（認証取得）の目標:**
- Conformance Score: ≥ 95%
- すべてのテストに合格
- 警告（Warnings）を最小化

## リソース

- [Testing Guide](../testing-guide.md) - テスト実施の詳細手順
- [Phase 3 Quickstart](../phase3-quickstart.md) - クイックスタートガイド
- [Manual Checklist](../manual-checklist.md) - 手動テストチェックリスト

---

> 💥 **Enrai** - Test results tracking for OpenID Conformance
