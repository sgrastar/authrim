# Enrai スクリプト改良実装仕様書

**作成日:** 2025-01-17
**バージョン:** 1.0.0
**目的:** スクリプト改良のための技術仕様書（改良完了後に削除）

---

## 目次

1. [概要](#概要)
2. [設定ファイルスキーマ](#設定ファイルスキーマ)
3. [設定ファイル作成スクリプト仕様](#設定ファイル作成スクリプト仕様)
4. [構築スクリプト仕様](#構築スクリプト仕様)
5. [アーキテクチャパターン対応](#アーキテクチャパターン対応)
6. [コンフリクトチェック](#コンフリクトチェック)
7. [エラーハンドリング](#エラーハンドリング)
8. [既存スクリプトとの統合](#既存スクリプトとの統合)

---

## 概要

### 目標

ユーザーが実行するスクリプトを**2つ**に集約：

1. **`setup-config.sh`** - 設定ファイル作成スクリプト
2. **`build.sh`** - 構築スクリプト

### 実装方針

- ARCHITECTURE_PATTERNS.mdの4パターン（A-D）すべてに対応
- 設定ファイルベースの宣言的セットアップ
- 既存スクリプトのロジックを内部的に統合または再利用
- インタラクティブなユーザー体験
- バージョン管理と段階的アップグレード対応

---

## 設定ファイルスキーマ

### ファイル形式

- **フォーマット:** JSON
- **ファイル名:** `enrai-config-{version}.json`
- **保存場所:** プロジェクトルート（`.gitignore`に追加）

### スキーマ定義

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["version", "created_at", "environment", "pattern", "cloudflare"],
  "properties": {
    "version": {
      "type": "string",
      "description": "設定ファイルのバージョン（例: 1.0.0）"
    },
    "created_at": {
      "type": "string",
      "format": "date-time",
      "description": "設定ファイルの作成日時（ISO 8601形式）"
    },
    "updated_at": {
      "type": "string",
      "format": "date-time",
      "description": "設定ファイルの更新日時（ISO 8601形式）"
    },
    "environment": {
      "type": "string",
      "enum": ["local", "remote"],
      "description": "ローカル開発環境かリモート環境か"
    },
    "operation_mode": {
      "type": "string",
      "enum": ["new", "update", "version_upgrade"],
      "description": "新規作成、既存設定の変更、バージョンアップ"
    },
    "pattern": {
      "type": "string",
      "enum": ["pattern-a", "pattern-b", "pattern-c", "pattern-d"],
      "description": "デプロイメントパターン"
    },
    "components": {
      "type": "object",
      "description": "各コンポーネントの設定",
      "properties": {
        "api": {
          "type": "object",
          "required": ["enabled"],
          "properties": {
            "enabled": {
              "type": "boolean",
              "description": "APIを有効にするか"
            },
            "custom_domain": {
              "type": "boolean",
              "description": "カスタムドメインを使用するか"
            },
            "domain": {
              "type": "string",
              "description": "ドメイン名（例: https://id.example.com）",
              "format": "uri"
            },
            "worker_name": {
              "type": "string",
              "description": "Workerの名前（カスタムドメイン不使用時）"
            }
          }
        },
        "login_page": {
          "type": "object",
          "required": ["enabled"],
          "properties": {
            "enabled": {
              "type": "boolean",
              "description": "Login Pageを有効にするか"
            },
            "hosting": {
              "type": "string",
              "enum": ["cloudflare-pages", "external"],
              "description": "ホスティング方法"
            },
            "custom_domain": {
              "type": "boolean",
              "description": "カスタムドメインを使用するか"
            },
            "domain": {
              "type": "string",
              "description": "ドメイン名（例: https://login.example.com）",
              "format": "uri"
            },
            "pages_project_name": {
              "type": "string",
              "description": "Pagesプロジェクト名（カスタムドメイン不使用時）"
            }
          }
        },
        "admin_page": {
          "type": "object",
          "required": ["enabled"],
          "properties": {
            "enabled": {
              "type": "boolean",
              "description": "Admin Pageを有効にするか"
            },
            "hosting": {
              "type": "string",
              "enum": ["cloudflare-pages", "external"],
              "description": "ホスティング方法"
            },
            "custom_domain": {
              "type": "boolean",
              "description": "カスタムドメインを使用するか"
            },
            "domain": {
              "type": "string",
              "description": "ドメイン名（例: https://admin.example.com）",
              "format": "uri"
            },
            "pages_project_name": {
              "type": "string",
              "description": "Pagesプロジェクト名（カスタムドメイン不使用時）"
            }
          }
        }
      }
    },
    "cloudflare": {
      "type": "object",
      "required": ["account_name"],
      "properties": {
        "account_name": {
          "type": "string",
          "description": "Cloudflareアカウント名（workers.dev使用時）"
        },
        "account_id": {
          "type": "string",
          "description": "CloudflareアカウントID（自動取得または手動入力）"
        },
        "use_router": {
          "type": "boolean",
          "description": "Router Workerを使用するか（テスト環境用）",
          "default": true
        }
      }
    },
    "secrets": {
      "type": "object",
      "properties": {
        "generate_keys": {
          "type": "boolean",
          "description": "秘密鍵を生成するか",
          "default": true
        },
        "reuse_existing": {
          "type": "boolean",
          "description": "既存の鍵を再利用するか",
          "default": false
        },
        "key_locations": {
          "type": "object",
          "properties": {
            "local": {
              "type": "string",
              "description": "ローカルの鍵保存パス",
              "default": ".keys/"
            },
            "remote_checked": {
              "type": "boolean",
              "description": "リモートの鍵をチェックしたか"
            }
          }
        }
      }
    },
    "resources": {
      "type": "object",
      "description": "Cloudflareリソースの設定",
      "properties": {
        "kv_namespaces": {
          "type": "array",
          "description": "KV Namespace一覧",
          "items": {
            "type": "object",
            "properties": {
              "binding": {"type": "string"},
              "id": {"type": "string"},
              "preview_id": {"type": "string"}
            }
          }
        },
        "durable_objects": {
          "type": "array",
          "description": "Durable Objects一覧",
          "items": {
            "type": "object",
            "properties": {
              "name": {"type": "string"},
              "class_name": {"type": "string"},
              "script_name": {"type": "string"}
            }
          }
        },
        "d1_databases": {
          "type": "array",
          "description": "D1 Database一覧",
          "items": {
            "type": "object",
            "properties": {
              "binding": {"type": "string"},
              "database_name": {"type": "string"},
              "database_id": {"type": "string"}
            }
          }
        }
      }
    },
    "cors": {
      "type": "object",
      "description": "CORS設定（Pattern B, C用）",
      "properties": {
        "enabled": {
          "type": "boolean",
          "description": "CORSを有効にするか"
        },
        "allowed_origins": {
          "type": "array",
          "items": {"type": "string"},
          "description": "許可するオリジン一覧"
        },
        "allowed_patterns": {
          "type": "array",
          "items": {"type": "string"},
          "description": "許可するオリジンのパターン（正規表現）"
        }
      }
    }
  }
}
```

### 設定ファイル例

#### Pattern A（統合ドメイン - カスタムドメイン使用）

```json
{
  "version": "1.0.0",
  "created_at": "2025-01-17T10:00:00Z",
  "environment": "remote",
  "operation_mode": "new",
  "pattern": "pattern-a",
  "components": {
    "api": {
      "enabled": true,
      "custom_domain": true,
      "domain": "https://id.example.com"
    },
    "login_page": {
      "enabled": true,
      "hosting": "cloudflare-pages",
      "custom_domain": true,
      "domain": "https://id.example.com"
    },
    "admin_page": {
      "enabled": true,
      "hosting": "cloudflare-pages",
      "custom_domain": true,
      "domain": "https://id.example.com"
    }
  },
  "cloudflare": {
    "account_name": "sgrastar",
    "use_router": true
  },
  "secrets": {
    "generate_keys": true,
    "reuse_existing": false
  },
  "cors": {
    "enabled": false
  }
}
```

#### Pattern A（統合ドメイン - workers.dev使用、開発環境）

```json
{
  "version": "1.0.0",
  "created_at": "2025-01-17T10:00:00Z",
  "environment": "local",
  "operation_mode": "new",
  "pattern": "pattern-a",
  "components": {
    "api": {
      "enabled": true,
      "custom_domain": false,
      "worker_name": "enrai"
    },
    "login_page": {
      "enabled": true,
      "hosting": "cloudflare-pages",
      "custom_domain": false,
      "pages_project_name": "enrai-login"
    },
    "admin_page": {
      "enabled": true,
      "hosting": "cloudflare-pages",
      "custom_domain": false,
      "pages_project_name": "enrai-admin"
    }
  },
  "cloudflare": {
    "account_name": "sgrastar",
    "use_router": true
  },
  "secrets": {
    "generate_keys": true,
    "reuse_existing": false
  },
  "cors": {
    "enabled": true,
    "allowed_origins": [
      "http://localhost:5173",
      "https://enrai-login.pages.dev",
      "https://enrai-admin.pages.dev"
    ]
  }
}
```

#### Pattern B（分離Admin UI）

```json
{
  "version": "1.0.0",
  "created_at": "2025-01-17T10:00:00Z",
  "environment": "remote",
  "operation_mode": "new",
  "pattern": "pattern-b",
  "components": {
    "api": {
      "enabled": true,
      "custom_domain": true,
      "domain": "https://id.example.com"
    },
    "login_page": {
      "enabled": true,
      "hosting": "cloudflare-pages",
      "custom_domain": true,
      "domain": "https://id.example.com"
    },
    "admin_page": {
      "enabled": true,
      "hosting": "cloudflare-pages",
      "custom_domain": true,
      "domain": "https://admin.example.com"
    }
  },
  "cloudflare": {
    "account_name": "sgrastar",
    "use_router": true
  },
  "secrets": {
    "generate_keys": true,
    "reuse_existing": false
  },
  "cors": {
    "enabled": true,
    "allowed_origins": [
      "https://admin.example.com",
      "http://localhost:5173"
    ]
  }
}
```

#### Pattern C（マルチドメインSSO）

```json
{
  "version": "1.0.0",
  "created_at": "2025-01-17T10:00:00Z",
  "environment": "remote",
  "operation_mode": "new",
  "pattern": "pattern-c",
  "components": {
    "api": {
      "enabled": true,
      "custom_domain": true,
      "domain": "https://api.example.com"
    },
    "login_page": {
      "enabled": true,
      "hosting": "cloudflare-pages",
      "custom_domain": true,
      "domain": "https://login.example.com"
    },
    "admin_page": {
      "enabled": true,
      "hosting": "cloudflare-pages",
      "custom_domain": true,
      "domain": "https://admin.example.com"
    }
  },
  "cloudflare": {
    "account_name": "sgrastar",
    "use_router": true
  },
  "secrets": {
    "generate_keys": true,
    "reuse_existing": false
  },
  "cors": {
    "enabled": true,
    "allowed_origins": [
      "https://login.example.com",
      "https://admin.example.com",
      "http://localhost:5173"
    ],
    "allowed_patterns": [
      "^https://.*\\.example\\.com$"
    ]
  }
}
```

#### Pattern D（ヘッドレス）

```json
{
  "version": "1.0.0",
  "created_at": "2025-01-17T10:00:00Z",
  "environment": "remote",
  "operation_mode": "new",
  "pattern": "pattern-d",
  "components": {
    "api": {
      "enabled": true,
      "custom_domain": false,
      "worker_name": "enrai"
    },
    "login_page": {
      "enabled": false
    },
    "admin_page": {
      "enabled": false
    }
  },
  "cloudflare": {
    "account_name": "sgrastar",
    "use_router": true
  },
  "secrets": {
    "generate_keys": true,
    "reuse_existing": false
  },
  "cors": {
    "enabled": true,
    "allowed_origins": ["*"]
  }
}
```

---

## 設定ファイル作成スクリプト仕様

### スクリプト名

`scripts/setup-config.sh`

### 処理フロー

```
開始
  ↓
[1] 前提条件チェック
  ├─ Wranglerインストール済み？
  ├─ Cloudflareログイン済み？
  └─ エラーの場合：終了
  ↓
[2] 環境選択
  ├─ ローカル環境（local）
  └─ リモート環境（remote）
  ↓
[3] 操作モード選択
  ├─ 新規作成（new）
  ├─ 既存設定の変更（update）
  └─ バージョンアップ（version_upgrade）
  ↓
[4] パターン選択
  ├─ Pattern A（統合ドメイン）
  ├─ Pattern B（分離Admin UI）
  ├─ Pattern C（マルチドメインSSO）
  └─ Pattern D（ヘッドレス）
  ↓
[5] コンポーネント選択
  ├─ API（有効/無効）
  ├─ Login Page（有効/無効）
  └─ Admin Page（有効/無効）
  ↓
[6] ドメイン設定（remote環境の場合）
  ├─ カスタムドメイン使用？
  ├─ 各コンポーネントのドメイン設定
  │   ├─ API: カスタムドメイン or worker_name
  │   ├─ Login Page: カスタムドメイン or pages_project_name
  │   └─ Admin Page: カスタムドメイン or pages_project_name
  └─ Cloudflareアカウント名の入力
  ↓
[7] ホスティング設定
  ├─ Login Page: Cloudflare Pages or 外部
  └─ Admin Page: Cloudflare Pages or 外部
  ↓
[8] 秘密鍵設定
  └─ 秘密鍵を生成するか？
  ↓
[9] CORS設定（Pattern B, C, D の場合）
  ├─ 許可するオリジンの入力
  └─ パターンマッチング（正規表現）
  ↓
[10] 設定内容の確認
  └─ 入力内容を表示
  ↓
[11] 設定ファイルの生成
  ├─ ファイル名: enrai-config-{version}.json
  ├─ バージョン: セマンティックバージョニング
  └─ .gitignore に追加
  ↓
[12] 構築実行の確認
  ├─ はい → build.sh を実行
  └─ いいえ → 終了
```

### 機能詳細

#### [1] 前提条件チェック

```bash
# Wranglerのインストール確認
if ! command -v wrangler &> /dev/null; then
  echo "エラー: Wranglerがインストールされていません"
  echo "インストール: npm install -g wrangler"
  exit 1
fi

# Cloudflareログイン確認
if ! wrangler whoami &> /dev/null; then
  echo "エラー: Cloudflareにログインしていません"
  echo "ログイン: wrangler login"
  exit 1
fi
```

#### [2] 環境選択

```bash
echo "環境を選択してください："
echo "1) ローカル開発環境（local）"
echo "2) リモート環境（remote）"
read -p "選択 [1-2]: " env_choice

case $env_choice in
  1) ENVIRONMENT="local" ;;
  2) ENVIRONMENT="remote" ;;
  *) echo "無効な選択"; exit 1 ;;
esac
```

#### [3] 操作モード選択

```bash
echo "操作モードを選択してください："
echo "1) 新規作成"
echo "2) 既存設定の変更"
echo "3) バージョンアップ（既存設定を保持）"
read -p "選択 [1-3]: " mode_choice

case $mode_choice in
  1) OPERATION_MODE="new" ;;
  2) OPERATION_MODE="update" ;;
  3) OPERATION_MODE="version_upgrade" ;;
  *) echo "無効な選択"; exit 1 ;;
esac

# 既存設定の変更・バージョンアップの場合、既存ファイルを読み込む
if [[ "$OPERATION_MODE" != "new" ]]; then
  echo "既存の設定ファイルを選択してください："
  select config_file in enrai-config-*.json; do
    if [[ -f "$config_file" ]]; then
      EXISTING_CONFIG="$config_file"
      break
    else
      echo "ファイルが見つかりません"
    fi
  done
fi
```

#### [4] パターン選択

```bash
echo "デプロイメントパターンを選択してください："
echo "1) Pattern A - 統合ドメイン（推奨、シンプル）"
echo "2) Pattern B - 分離Admin UI（セキュリティ強化）"
echo "3) Pattern C - マルチドメインSSO（エンタープライズ）"
echo "4) Pattern D - ヘッドレス（API のみ）"
read -p "選択 [1-4]: " pattern_choice

case $pattern_choice in
  1) PATTERN="pattern-a" ;;
  2) PATTERN="pattern-b" ;;
  3) PATTERN="pattern-c" ;;
  4) PATTERN="pattern-d" ;;
  *) echo "無効な選択"; exit 1 ;;
esac
```

#### [5] コンポーネント選択

```bash
# Pattern Dの場合、APIのみ有効
if [[ "$PATTERN" == "pattern-d" ]]; then
  ENABLE_API=true
  ENABLE_LOGIN_PAGE=false
  ENABLE_ADMIN_PAGE=false
else
  read -p "API を有効にしますか？ [Y/n]: " enable_api
  ENABLE_API=${enable_api:-Y}

  read -p "Login Page を有効にしますか？ [Y/n]: " enable_login
  ENABLE_LOGIN_PAGE=${enable_login:-Y}

  read -p "Admin Page を有効にしますか？ [Y/n]: " enable_admin
  ENABLE_ADMIN_PAGE=${enable_admin:-Y}
fi
```

#### [6] ドメイン設定

```bash
if [[ "$ENVIRONMENT" == "remote" ]]; then
  read -p "カスタムドメインを使用しますか？ [y/N]: " use_custom_domain

  if [[ "$use_custom_domain" =~ ^[Yy]$ ]]; then
    # 各コンポーネントのカスタムドメイン設定
    if [[ "$ENABLE_API" == "Y" ]]; then
      read -p "API のカスタムドメインを入力 (例: https://id.example.com): " api_domain
      API_CUSTOM_DOMAIN=true
      API_DOMAIN="$api_domain"
    fi

    if [[ "$ENABLE_LOGIN_PAGE" == "Y" ]]; then
      read -p "Login Page のカスタムドメインを入力 (例: https://login.example.com): " login_domain
      LOGIN_CUSTOM_DOMAIN=true
      LOGIN_DOMAIN="$login_domain"
    fi

    if [[ "$ENABLE_ADMIN_PAGE" == "Y" ]]; then
      read -p "Admin Page のカスタムドメインを入力 (例: https://admin.example.com): " admin_domain
      ADMIN_CUSTOM_DOMAIN=true
      ADMIN_DOMAIN="$admin_domain"
    fi
  else
    # workers.dev / pages.dev 使用
    read -p "Cloudflareアカウント名を入力: " account_name
    ACCOUNT_NAME="$account_name"

    if [[ "$ENABLE_API" == "Y" ]]; then
      read -p "API Worker名を入力 [デフォルト: enrai]: " worker_name
      WORKER_NAME="${worker_name:-enrai}"
      API_DOMAIN="https://${WORKER_NAME}.${ACCOUNT_NAME}.workers.dev"
    fi

    if [[ "$ENABLE_LOGIN_PAGE" == "Y" ]]; then
      read -p "Login Page プロジェクト名を入力 [デフォルト: enrai-${ACCOUNT_NAME}-login]: " login_project
      LOGIN_PROJECT="${login_project:-enrai-${ACCOUNT_NAME}-login}"
      LOGIN_DOMAIN="https://${LOGIN_PROJECT}.pages.dev"
    fi

    if [[ "$ENABLE_ADMIN_PAGE" == "Y" ]]; then
      read -p "Admin Page プロジェクト名を入力 [デフォルト: enrai-${ACCOUNT_NAME}-admin]: " admin_project
      ADMIN_PROJECT="${admin_project:-enrai-${ACCOUNT_NAME}-admin}"
      ADMIN_DOMAIN="https://${ADMIN_PROJECT}.pages.dev"
    fi
  fi
fi
```

#### [7] ホスティング設定

```bash
if [[ "$ENABLE_LOGIN_PAGE" == "Y" ]]; then
  echo "Login Page のホスティング方法を選択してください："
  echo "1) Cloudflare Pages"
  echo "2) 外部ホスティング"
  read -p "選択 [1-2]: " login_hosting_choice

  case $login_hosting_choice in
    1) LOGIN_HOSTING="cloudflare-pages" ;;
    2) LOGIN_HOSTING="external" ;;
    *) echo "無効な選択"; exit 1 ;;
  esac
fi

if [[ "$ENABLE_ADMIN_PAGE" == "Y" ]]; then
  echo "Admin Page のホスティング方法を選択してください："
  echo "1) Cloudflare Pages"
  echo "2) 外部ホスティング"
  read -p "選択 [1-2]: " admin_hosting_choice

  case $admin_hosting_choice in
    1) ADMIN_HOSTING="cloudflare-pages" ;;
    2) ADMIN_HOSTING="external" ;;
    *) echo "無効な選択"; exit 1 ;;
  esac
fi
```

#### [8] 秘密鍵設定

```bash
read -p "秘密鍵を生成しますか？ [Y/n]: " generate_keys
GENERATE_KEYS=${generate_keys:-Y}
```

#### [9] CORS設定

```bash
# Pattern B, C, D の場合、CORS設定が必要
if [[ "$PATTERN" == "pattern-b" ]] || [[ "$PATTERN" == "pattern-c" ]] || [[ "$PATTERN" == "pattern-d" ]]; then
  echo "CORS設定を行います"
  echo "許可するオリジンを入力してください（カンマ区切り）："
  echo "例: https://admin.example.com,http://localhost:5173"
  read -p "オリジン: " cors_origins

  IFS=',' read -ra CORS_ORIGINS <<< "$cors_origins"

  read -p "パターンマッチング（正規表現）を追加しますか？ [y/N]: " add_cors_patterns
  if [[ "$add_cors_patterns" =~ ^[Yy]$ ]]; then
    echo "正規表現パターンを入力してください（カンマ区切り）："
    echo "例: ^https://.*\\.example\\.com$"
    read -p "パターン: " cors_patterns
    IFS=',' read -ra CORS_PATTERNS <<< "$cors_patterns"
  fi
fi
```

#### [10] 設定内容の確認

```bash
echo "========================================="
echo "設定内容の確認"
echo "========================================="
echo "環境: $ENVIRONMENT"
echo "操作モード: $OPERATION_MODE"
echo "パターン: $PATTERN"
echo ""
echo "コンポーネント:"
echo "  API: $ENABLE_API"
[[ "$ENABLE_API" == "Y" ]] && echo "    ドメイン: $API_DOMAIN"
echo "  Login Page: $ENABLE_LOGIN_PAGE"
[[ "$ENABLE_LOGIN_PAGE" == "Y" ]] && echo "    ドメイン: $LOGIN_DOMAIN"
echo "  Admin Page: $ENABLE_ADMIN_PAGE"
[[ "$ENABLE_ADMIN_PAGE" == "Y" ]] && echo "    ドメイン: $ADMIN_DOMAIN"
echo ""
echo "Cloudflareアカウント名: $ACCOUNT_NAME"
echo "秘密鍵生成: $GENERATE_KEYS"
echo "========================================="
read -p "この設定でよろしいですか？ [Y/n]: " confirm
if [[ ! "$confirm" =~ ^[Yy]?$ ]]; then
  echo "中止しました"
  exit 0
fi
```

#### [11] 設定ファイルの生成

```bash
# バージョンの決定
VERSION="1.0.0"
if [[ "$OPERATION_MODE" != "new" ]]; then
  # 既存設定からバージョンを取得してインクリメント
  EXISTING_VERSION=$(jq -r '.version' "$EXISTING_CONFIG")
  # セマンティックバージョニング: マイナーバージョンをインクリメント
  VERSION=$(echo "$EXISTING_VERSION" | awk -F. '{$2 = $2 + 1; print $1"."$2"."$3}')
fi

CONFIG_FILE="enrai-config-${VERSION}.json"

# JSON生成
cat > "$CONFIG_FILE" <<EOF
{
  "version": "$VERSION",
  "created_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "environment": "$ENVIRONMENT",
  "operation_mode": "$OPERATION_MODE",
  "pattern": "$PATTERN",
  "components": {
    "api": {
      "enabled": $([ "$ENABLE_API" == "Y" ] && echo "true" || echo "false"),
      "custom_domain": $([ "$API_CUSTOM_DOMAIN" == "true" ] && echo "true" || echo "false"),
      "domain": "$API_DOMAIN",
      "worker_name": "$WORKER_NAME"
    },
    "login_page": {
      "enabled": $([ "$ENABLE_LOGIN_PAGE" == "Y" ] && echo "true" || echo "false"),
      "hosting": "$LOGIN_HOSTING",
      "custom_domain": $([ "$LOGIN_CUSTOM_DOMAIN" == "true" ] && echo "true" || echo "false"),
      "domain": "$LOGIN_DOMAIN",
      "pages_project_name": "$LOGIN_PROJECT"
    },
    "admin_page": {
      "enabled": $([ "$ENABLE_ADMIN_PAGE" == "Y" ] && echo "true" || echo "false"),
      "hosting": "$ADMIN_HOSTING",
      "custom_domain": $([ "$ADMIN_CUSTOM_DOMAIN" == "true" ] && echo "true" || echo "false"),
      "domain": "$ADMIN_DOMAIN",
      "pages_project_name": "$ADMIN_PROJECT"
    }
  },
  "cloudflare": {
    "account_name": "$ACCOUNT_NAME",
    "use_router": true
  },
  "secrets": {
    "generate_keys": $([ "$GENERATE_KEYS" == "Y" ] && echo "true" || echo "false"),
    "reuse_existing": false
  },
  "cors": {
    "enabled": $([ "$PATTERN" != "pattern-a" ] && echo "true" || echo "false"),
    "allowed_origins": $(printf '%s\n' "${CORS_ORIGINS[@]}" | jq -R . | jq -s .),
    "allowed_patterns": $(printf '%s\n' "${CORS_PATTERNS[@]}" | jq -R . | jq -s .)
  }
}
EOF

# jqでフォーマット
jq . "$CONFIG_FILE" > "$CONFIG_FILE.tmp" && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"

echo "設定ファイルを生成しました: $CONFIG_FILE"

# .gitignoreに追加
if ! grep -q "enrai-config-*.json" .gitignore 2>/dev/null; then
  echo "enrai-config-*.json" >> .gitignore
  echo ".gitignoreに追加しました"
fi
```

#### [12] 構築実行の確認

```bash
read -p "構築を実行しますか？ [Y/n]: " run_build
if [[ "$run_build" =~ ^[Yy]?$ ]]; then
  ./scripts/build.sh --config "$CONFIG_FILE"
else
  echo "構築は後で実行できます: ./scripts/build.sh --config $CONFIG_FILE"
fi
```

---

## 構築スクリプト仕様

### スクリプト名

`scripts/build.sh`

### 処理フロー

```
開始
  ↓
[1] 引数解析
  ├─ --config <file>: 設定ファイル指定
  ├─ --mode <new|update|delete>: 操作モード
  └─ --skip-deploy: デプロイをスキップ
  ↓
[2] 設定ファイルの読み込み
  ├─ 引数から指定されている場合: 使用
  ├─ 設定ファイル作成スクリプトから呼ばれた場合: 使用
  └─ いずれでもない場合: ユーザーに選択させる
  ↓
[3] 操作モードの確認
  ├─ 新規構築（new）
  ├─ 既存設定の変更（update）
  └─ データ削除・初期化（delete）
  ↓
[4] 設定内容の表示
  └─ 設定ファイルの内容を整形して表示
  ↓
[5] コンフリクトチェック（new/updateの場合）
  ├─ リモートのWorker一覧を取得
  ├─ リモートのPages一覧を取得
  ├─ リモートのKV一覧を取得
  ├─ リモートのDO一覧を取得
  ├─ リモートのD1一覧を取得
  └─ コンフリクトがある場合: 警告表示
  ↓
[6] packages生成・更新
  ├─ wrangler.toml生成（各worker用）
  ├─ .dev.vars生成（ローカル環境）
  └─ 環境変数の設定
  ↓
[7] Cloudflareリソースの設定
  ├─ KV Namespaceの作成・更新
  ├─ Durable Objectsの設定
  ├─ D1 Databaseの作成・更新
  └─ 設定ファイルにリソースIDを記録
  ↓
[8] 秘密鍵の管理
  ├─ ローカルの既存鍵をチェック
  ├─ リモートの既存鍵をチェック
  ├─ 既存鍵がある場合: 再利用確認
  └─ 新規生成またはアップロード
  ↓
[9] CORS設定（Pattern B, C, Dの場合）
  └─ KVに CORS_SETTINGS を保存
  ↓
[10] デプロイ確認
  ├─ --skip-deploy フラグがある場合: スキップ
  └─ ない場合: デプロイ実行確認
  ↓
[11] デプロイ実行
  ├─ Shared packageのビルド
  ├─ 各Workerのデプロイ（順次）
  ├─ UIのビルドとデプロイ
  └─ エラー時はリトライ
  ↓
[12] 結果表示
  └─ デプロイ完了、URLを表示
```

### 機能詳細

#### [1] 引数解析

```bash
#!/bin/bash

CONFIG_FILE=""
MODE=""
SKIP_DEPLOY=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --config)
      CONFIG_FILE="$2"
      shift 2
      ;;
    --mode)
      MODE="$2"
      shift 2
      ;;
    --skip-deploy)
      SKIP_DEPLOY=true
      shift
      ;;
    *)
      echo "不明なオプション: $1"
      exit 1
      ;;
  esac
done
```

#### [2] 設定ファイルの読み込み

```bash
if [[ -z "$CONFIG_FILE" ]]; then
  echo "設定ファイルを選択してください："
  select config_file in enrai-config-*.json; do
    if [[ -f "$config_file" ]]; then
      CONFIG_FILE="$config_file"
      break
    else
      echo "ファイルが見つかりません"
    fi
  done
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "エラー: 設定ファイルが見つかりません: $CONFIG_FILE"
  exit 1
fi

echo "設定ファイルを読み込みました: $CONFIG_FILE"

# jqで設定値を読み取る
ENVIRONMENT=$(jq -r '.environment' "$CONFIG_FILE")
PATTERN=$(jq -r '.pattern' "$CONFIG_FILE")
OPERATION_MODE=$(jq -r '.operation_mode' "$CONFIG_FILE")
# ... 以下、必要な値をすべて読み取る
```

#### [3] 操作モードの確認

```bash
if [[ -z "$MODE" ]]; then
  echo "操作モードを選択してください："
  echo "1) 新規構築（追加）"
  echo "2) 既存設定の変更"
  echo "3) データ削除・初期化"
  read -p "選択 [1-3]: " mode_choice

  case $mode_choice in
    1) MODE="new" ;;
    2) MODE="update" ;;
    3) MODE="delete" ;;
    *) echo "無効な選択"; exit 1 ;;
  esac
fi

# deleteモードの場合、確認
if [[ "$MODE" == "delete" ]]; then
  echo "警告: すべてのリソースとデータが削除されます"
  read -p "本当に削除しますか？ [yes/no]: " confirm_delete
  if [[ "$confirm_delete" != "yes" ]]; then
    echo "中止しました"
    exit 0
  fi
fi
```

#### [4] 設定内容の表示

```bash
echo "========================================="
echo "設定内容"
echo "========================================="
echo "環境: $ENVIRONMENT"
echo "パターン: $PATTERN"
echo "操作モード: $MODE"
echo ""

jq -r '
  "コンポーネント:",
  "  API: \(.components.api.enabled)",
  (if .components.api.enabled then "    ドメイン: \(.components.api.domain)" else "" end),
  "  Login Page: \(.components.login_page.enabled)",
  (if .components.login_page.enabled then "    ドメイン: \(.components.login_page.domain)" else "" end),
  "  Admin Page: \(.components.admin_page.enabled)",
  (if .components.admin_page.enabled then "    ドメイン: \(.components.admin_page.domain)" else "" end),
  "",
  "Cloudflareアカウント名: \(.cloudflare.account_name)",
  "秘密鍵生成: \(.secrets.generate_keys)"
' "$CONFIG_FILE"

echo "========================================="
```

#### [5] コンフリクトチェック

```bash
check_conflicts() {
  echo "リモートリソースをチェック中..."

  # Workerのチェック
  if jq -e '.components.api.enabled' "$CONFIG_FILE" &>/dev/null; then
    WORKER_NAME=$(jq -r '.components.api.worker_name // ""' "$CONFIG_FILE")
    if [[ -n "$WORKER_NAME" ]]; then
      if wrangler deployments list --name="$WORKER_NAME" &>/dev/null; then
        echo "警告: Worker '$WORKER_NAME' は既に存在します"
        CONFLICTS=true
      fi
    fi
  fi

  # KV Namespaceのチェック
  EXISTING_KV=$(wrangler kv namespace list --json 2>/dev/null)
  # KV一覧と比較
  # ...

  # Durable Objectsのチェック
  # ...

  # D1 Databaseのチェック
  EXISTING_D1=$(wrangler d1 list --json 2>/dev/null)
  # D1一覧と比較
  # ...

  if [[ "$CONFLICTS" == "true" ]]; then
    echo ""
    echo "警告: 既存のリソースとコンフリクトが検出されました"
    read -p "続行しますか？ [y/N]: " continue_confirm
    if [[ ! "$continue_confirm" =~ ^[Yy]$ ]]; then
      echo "中止しました"
      exit 0
    fi
  else
    echo "コンフリクトは検出されませんでした"
  fi
}

if [[ "$MODE" != "delete" ]]; then
  check_conflicts
fi
```

#### [6] packages生成・更新

```bash
generate_packages() {
  echo "packages設定を生成中..."

  # 各workerのwrangler.toml生成
  # Pattern別に適切な設定を生成

  case "$PATTERN" in
    pattern-a)
      generate_pattern_a_config
      ;;
    pattern-b)
      generate_pattern_b_config
      ;;
    pattern-c)
      generate_pattern_c_config
      ;;
    pattern-d)
      generate_pattern_d_config
      ;;
  esac

  # .dev.vars生成（ローカル環境）
  if [[ "$ENVIRONMENT" == "local" ]]; then
    generate_dev_vars
  fi
}

generate_pattern_a_config() {
  # Pattern A用のwrangler.toml生成
  # 統合ドメイン設定

  API_DOMAIN=$(jq -r '.components.api.domain' "$CONFIG_FILE")
  ACCOUNT_NAME=$(jq -r '.cloudflare.account_name' "$CONFIG_FILE")

  # router worker
  cat > packages/router/wrangler.toml <<EOF
name = "enrai-router"
main = "src/index.ts"
compatibility_date = "2025-01-01"

[env.production]
name = "enrai-router"
route = { pattern = "$API_DOMAIN/*", custom_domain = true }
EOF

  # 各専用worker
  # ...
}

generate_dev_vars() {
  # .dev.vars生成
  API_DOMAIN=$(jq -r '.components.api.domain' "$CONFIG_FILE")
  LOGIN_DOMAIN=$(jq -r '.components.login_page.domain' "$CONFIG_FILE")
  ADMIN_DOMAIN=$(jq -r '.components.admin_page.domain' "$CONFIG_FILE")

  cat > .dev.vars <<EOF
ISSUER_URL=$API_DOMAIN
PUBLIC_API_BASE_URL=$API_DOMAIN
ADMIN_UI_ORIGIN=$ADMIN_DOMAIN,$LOGIN_DOMAIN,http://localhost:5173
EOF
}
```

#### [7] Cloudflareリソースの設定

```bash
setup_cloudflare_resources() {
  echo "Cloudflareリソースを設定中..."

  # KV Namespace
  setup_kv_namespaces

  # Durable Objects
  # (wrangler.tomlで定義済み、デプロイ時に自動作成)

  # D1 Database
  setup_d1_databases

  # 設定ファイルにリソースIDを記録
  update_config_with_resource_ids
}

setup_kv_namespaces() {
  echo "KV Namespaceを設定中..."

  # 必要なKV一覧
  KV_BINDINGS=("AUTH_CODES" "CLIENTS" "REFRESH_TOKENS" "SESSIONS" "SETTINGS_KV")

  for binding in "${KV_BINDINGS[@]}"; do
    # 既存チェック
    existing_id=$(jq -r --arg binding "$binding" \
      '.resources.kv_namespaces[] | select(.binding == $binding) | .id' \
      "$CONFIG_FILE" 2>/dev/null)

    if [[ -n "$existing_id" && "$existing_id" != "null" ]]; then
      echo "  $binding: 既存のNamespaceを使用 (ID: $existing_id)"
    else
      # 新規作成
      result=$(wrangler kv namespace create "$binding" --json 2>/dev/null)
      namespace_id=$(echo "$result" | jq -r '.id')

      echo "  $binding: 作成しました (ID: $namespace_id)"

      # 設定ファイルに追加
      # jqを使ってresources.kv_namespacesに追加
      jq --arg binding "$binding" --arg id "$namespace_id" \
        '.resources.kv_namespaces += [{"binding": $binding, "id": $id}]' \
        "$CONFIG_FILE" > "$CONFIG_FILE.tmp" && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
    fi
  done
}

setup_d1_databases() {
  echo "D1 Databaseを設定中..."

  DB_NAME="enrai-users-db"

  existing_id=$(jq -r --arg name "$DB_NAME" \
    '.resources.d1_databases[] | select(.database_name == $name) | .database_id' \
    "$CONFIG_FILE" 2>/dev/null)

  if [[ -n "$existing_id" && "$existing_id" != "null" ]]; then
    echo "  $DB_NAME: 既存のDatabaseを使用 (ID: $existing_id)"
  else
    # 新規作成
    result=$(wrangler d1 create "$DB_NAME" --json 2>/dev/null)
    db_id=$(echo "$result" | jq -r '.database_id')

    echo "  $DB_NAME: 作成しました (ID: $db_id)"

    # マイグレーション実行
    wrangler d1 execute "$DB_NAME" --file=./migrations/0001_initial.sql

    # 設定ファイルに追加
    jq --arg name "$DB_NAME" --arg id "$db_id" \
      '.resources.d1_databases += [{"binding": "USERS_DB", "database_name": $name, "database_id": $id}]' \
      "$CONFIG_FILE" > "$CONFIG_FILE.tmp" && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
  fi
}
```

#### [8] 秘密鍵の管理

```bash
setup_secrets() {
  GENERATE_KEYS=$(jq -r '.secrets.generate_keys' "$CONFIG_FILE")

  if [[ "$GENERATE_KEYS" == "true" ]]; then
    echo "秘密鍵を設定中..."

    # ローカルの既存鍵をチェック
    if [[ -f ".keys/private.pem" && -f ".keys/public.pem" ]]; then
      echo "ローカルに既存の鍵が見つかりました"
      read -p "既存の鍵を使用しますか？ [Y/n]: " use_existing
      if [[ ! "$use_existing" =~ ^[Nn]$ ]]; then
        REUSE_LOCAL_KEYS=true
      fi
    fi

    # リモートの既存鍵をチェック
    if wrangler secret list --name="enrai-shared" 2>/dev/null | grep -q "RSA_PRIVATE_KEY"; then
      echo "リモートに既存の鍵が見つかりました"
      read -p "既存のリモート鍵を使用しますか？ [Y/n]: " use_remote
      if [[ ! "$use_remote" =~ ^[Nn]$ ]]; then
        REUSE_REMOTE_KEYS=true
      fi
    fi

    # 新規生成
    if [[ "$REUSE_LOCAL_KEYS" != "true" && "$REUSE_REMOTE_KEYS" != "true" ]]; then
      echo "新しい鍵を生成します..."
      mkdir -p .keys

      # RSA鍵生成
      openssl genrsa -out .keys/private.pem 2048
      openssl rsa -in .keys/private.pem -pubout -out .keys/public.pem

      echo "鍵を生成しました: .keys/private.pem, .keys/public.pem"
    fi

    # リモートにアップロード
    if [[ "$REUSE_REMOTE_KEYS" != "true" ]]; then
      echo "秘密鍵をCloudflareにアップロード中..."
      cat .keys/private.pem | wrangler secret put RSA_PRIVATE_KEY --name="enrai-shared"
      cat .keys/public.pem | wrangler secret put RSA_PUBLIC_KEY --name="enrai-shared"
      echo "秘密鍵をアップロードしました"
    fi
  fi
}
```

#### [9] CORS設定

```bash
setup_cors() {
  CORS_ENABLED=$(jq -r '.cors.enabled' "$CONFIG_FILE")

  if [[ "$CORS_ENABLED" == "true" ]]; then
    echo "CORS設定を適用中..."

    # KVに保存
    CORS_SETTINGS=$(jq -c '.cors' "$CONFIG_FILE")

    # SETTINGS_KV に保存
    echo "$CORS_SETTINGS" | wrangler kv key put "cors_settings" \
      --binding=SETTINGS_KV \
      --path=/dev/stdin

    echo "CORS設定を保存しました"
  fi
}
```

#### [10-11] デプロイ確認と実行

```bash
deploy() {
  if [[ "$SKIP_DEPLOY" == "true" ]]; then
    echo "デプロイをスキップしました（--skip-deploy）"
    return
  fi

  read -p "デプロイを実行しますか？ [Y/n]: " run_deploy
  if [[ ! "$run_deploy" =~ ^[Yy]?$ ]]; then
    echo "デプロイをスキップしました"
    echo "後で実行できます: pnpm run deploy:with-router"
    return
  fi

  echo "デプロイを開始します..."

  # Sharedパッケージのビルド
  echo "Sharedパッケージをビルド中..."
  pnpm --filter=shared build

  # 各Workerのデプロイ（順次、リトライ付き）
  deploy_workers

  # UIのデプロイ
  deploy_ui

  echo "デプロイが完了しました"
  show_deployment_urls
}

deploy_workers() {
  # 既存のdeploy-with-retry.shのロジックを統合
  # または直接呼び出し

  if [[ -f "scripts/deploy-with-retry.sh" ]]; then
    ./scripts/deploy-with-retry.sh
  else
    # 順次デプロイ
    WORKERS=("shared" "op-discovery" "op-auth" "op-token" "op-userinfo" "op-management")
    USE_ROUTER=$(jq -r '.cloudflare.use_router' "$CONFIG_FILE")

    if [[ "$USE_ROUTER" == "true" ]]; then
      WORKERS+=("router")
    fi

    for worker in "${WORKERS[@]}"; do
      echo "デプロイ中: $worker"
      pnpm --filter="$worker" deploy
      sleep 10  # Rate limit回避
    done
  fi
}

deploy_ui() {
  ENABLE_LOGIN=$(jq -r '.components.login_page.enabled' "$CONFIG_FILE")
  ENABLE_ADMIN=$(jq -r '.components.admin_page.enabled' "$CONFIG_FILE")

  if [[ "$ENABLE_LOGIN" == "true" ]] || [[ "$ENABLE_ADMIN" == "true" ]]; then
    echo "UIをデプロイ中..."
    pnpm run deploy:ui
  fi
}

show_deployment_urls() {
  echo "========================================="
  echo "デプロイ完了！"
  echo "========================================="

  API_DOMAIN=$(jq -r '.components.api.domain' "$CONFIG_FILE")
  LOGIN_DOMAIN=$(jq -r '.components.login_page.domain' "$CONFIG_FILE")
  ADMIN_DOMAIN=$(jq -r '.components.admin_page.domain' "$CONFIG_FILE")

  echo "API: $API_DOMAIN"
  echo "Login Page: $LOGIN_DOMAIN"
  echo "Admin Page: $ADMIN_DOMAIN"
  echo "========================================="
}
```

#### [12] 削除モード

```bash
delete_all_resources() {
  echo "すべてのリソースを削除中..."

  # 既存のdelete-all.shを呼び出し、または統合
  if [[ -f "scripts/delete-all.sh" ]]; then
    ./scripts/delete-all.sh
  else
    # Workers削除
    # KV削除
    # D1削除
    # DO削除（自動）
    # ...
  fi

  echo "すべてのリソースを削除しました"
}
```

---

## アーキテクチャパターン対応

### Pattern A: 統合ドメイン

#### 環境変数設定

**カスタムドメイン使用時:**

```bash
# .dev.vars (local)
ISSUER_URL=https://id.example.com
PUBLIC_API_BASE_URL=https://id.example.com
CORS_ORIGINS=https://id.example.com
```

**workers.dev使用時:**

```bash
# .dev.vars (local)
ISSUER_URL=https://enrai.sgrastar.workers.dev
PUBLIC_API_BASE_URL=https://enrai.sgrastar.workers.dev
ADMIN_UI_ORIGIN=https://enrai-login.pages.dev,https://enrai-admin.pages.dev,http://localhost:5173
CORS_ORIGINS=https://enrai-login.pages.dev,https://enrai-admin.pages.dev,http://localhost:5173
```

#### wrangler.toml設定

```toml
# カスタムドメイン使用時
[env.production]
name = "enrai-router"
route = { pattern = "id.example.com/*", custom_domain = true }

# workers.dev使用時
name = "enrai"
```

---

### Pattern B: 分離Admin UI

#### 環境変数設定

```bash
# API Worker (.dev.vars)
ISSUER_URL=https://id.example.com
PUBLIC_API_BASE_URL=https://id.example.com
ADMIN_UI_ORIGIN=https://admin.example.com,http://localhost:5173

# Admin UI (Cloudflare Pages環境変数)
PUBLIC_API_BASE_URL=https://id.example.com
PUBLIC_OIDC_BASE_URL=https://id.example.com
```

#### CORS設定（KV）

```json
{
  "admin_origins": [
    "https://admin.example.com",
    "http://localhost:5173"
  ]
}
```

---

### Pattern C: マルチドメインSSO

#### 環境変数設定

```bash
# API Worker (.dev.vars)
ISSUER_URL=https://api.example.com
PUBLIC_API_BASE_URL=https://api.example.com

# Login UI (Cloudflare Pages環境変数)
PUBLIC_API_BASE_URL=https://api.example.com
PUBLIC_OIDC_BASE_URL=https://api.example.com
PUBLIC_REDIRECT_URI=https://service1.com/callback

# Admin UI (Cloudflare Pages環境変数)
PUBLIC_API_BASE_URL=https://api.example.com
PUBLIC_OIDC_BASE_URL=https://api.example.com
```

#### CORS設定（KV）

```json
{
  "allowed_origins": [
    "https://service1.com",
    "https://service2.net",
    "https://login.example.com",
    "https://admin.example.com",
    "http://localhost:5173"
  ],
  "allowed_patterns": [
    "^https://.*\\.example\\.com$",
    "^https://.*\\.pages\\.dev$"
  ]
}
```

---

### Pattern D: ヘッドレス

#### 環境変数設定

```bash
# API Worker (.dev.vars)
ISSUER_URL=https://enrai.sgrastar.workers.dev
PUBLIC_API_BASE_URL=https://enrai.sgrastar.workers.dev
CORS_ORIGINS=*
```

#### wrangler.toml設定

```toml
name = "enrai"
# UIはデプロイしない
```

---

## コンフリクトチェック

### チェック項目

1. **Worker名の重複**
   - `wrangler deployments list --name=<worker_name>`
   - 既存のWorkerと名前が重複していないか

2. **KV Namespace名の重複**
   - `wrangler kv namespace list --json`
   - 既存のNamespaceと名前が重複していないか

3. **D1 Database名の重複**
   - `wrangler d1 list --json`
   - 既存のDatabaseと名前が重複していないか

4. **Durable Objects**
   - Durable Objectsは自動管理されるため、明示的なチェックは不要
   - Workerがデプロイされていれば自動的に利用可能

5. **カスタムドメインの競合**
   - `wrangler domains list`
   - 既存のドメイン設定と重複していないか

### コンフリクト検出時の動作

- **警告を表示**: 既存のリソースと重複していることを通知
- **ユーザーに確認**: 続行するか、中止するかを選択
- **updateモード**: 既存のリソースを更新する場合は続行
- **newモード**: 重複は基本的にエラーとして扱う

### コンフリクト解決戦略

1. **リソース名の変更**
   - ユーザーに異なる名前を入力させる
   - 自動的にサフィックスを追加（例: `enrai-2`）

2. **既存リソースの再利用**
   - 既存のKV、D1を再利用する
   - 設定ファイルにIDを記録

3. **削除と再作成**
   - 既存のリソースを削除してから新規作成
   - データ損失のリスクがあるため、確認必須

---

## エラーハンドリング

### エラーカテゴリ

1. **前提条件エラー**
   - Wrangler未インストール
   - Cloudflare未ログイン
   - 必要なパッケージ（jq、openssl等）が未インストール

2. **設定エラー**
   - 無効な設定ファイル（JSON解析エラー）
   - 必須フィールドの欠落
   - 無効な値（例: 不正なURL）

3. **リソースエラー**
   - KV作成失敗
   - D1作成失敗
   - Worker デプロイ失敗

4. **ネットワークエラー**
   - Cloudflare API接続エラー
   - Rate limit超過

### エラーハンドリング戦略

```bash
# エラートラップ
set -e  # エラー時に即座に終了
trap 'error_handler $? $LINENO' ERR

error_handler() {
  local exit_code=$1
  local line_number=$2
  echo "エラーが発生しました (行: $line_number, コード: $exit_code)"
  echo "詳細はログを確認してください"
  exit $exit_code
}

# リトライロジック
retry() {
  local max_attempts=3
  local attempt=1
  local delay=5

  while [ $attempt -le $max_attempts ]; do
    if "$@"; then
      return 0
    else
      echo "失敗しました。リトライします... ($attempt/$max_attempts)"
      sleep $delay
      delay=$((delay * 2))  # Exponential backoff
      attempt=$((attempt + 1))
    fi
  done

  echo "最大リトライ回数に達しました"
  return 1
}

# 使用例
retry wrangler kv namespace create AUTH_CODES
```

### ロールバック戦略

デプロイ中にエラーが発生した場合のロールバック:

```bash
rollback() {
  echo "エラーが発生しました。ロールバックを実行します..."

  # 作成したリソースを記録
  # エラー発生時に削除

  if [[ -n "$CREATED_KV_IDS" ]]; then
    for kv_id in $CREATED_KV_IDS; do
      wrangler kv namespace delete --namespace-id="$kv_id"
    done
  fi

  if [[ -n "$CREATED_D1_IDS" ]]; then
    for d1_id in $CREATED_D1_IDS; do
      wrangler d1 delete "$d1_id"
    done
  fi

  echo "ロールバックが完了しました"
}

trap rollback ERR
```

---

## 既存スクリプトとの統合

### 統合方針

既存のスクリプトを**内部的に呼び出す**または**ロジックを統合する**:

1. **setup-kv.sh** → `build.sh`に統合（`setup_kv_namespaces()`）
2. **setup-d1.sh** → `build.sh`に統合（`setup_d1_databases()`）
3. **setup-secrets.sh** → `build.sh`に統合（`setup_secrets()`）
4. **deploy-with-retry.sh** → `build.sh`から呼び出し（`deploy_workers()`）
5. **delete-all.sh** → `build.sh`から呼び出し（deleteモード）

### 既存スクリプトの保持

- **後方互換性**: 既存のスクリプトは削除せず、非推奨として保持
- **ドキュメント更新**: `DEVELOPMENT.md`、`CLAUDE.md`に新しいワークフローを記載
- **移行ガイド**: 既存のユーザー向けに移行手順を提供

### 非推奨化

```bash
# setup-kv.sh の先頭に追加
echo "警告: このスクリプトは非推奨です"
echo "新しいワークフロー: ./scripts/setup-config.sh を使用してください"
read -p "続行しますか？ [y/N]: " continue
if [[ ! "$continue" =~ ^[Yy]$ ]]; then
  exit 0
fi
```

---

## テスト計画

### 単体テスト

- 各関数の動作確認
- エラーハンドリングのテスト
- バリデーションのテスト

### 統合テスト

1. **Pattern A（カスタムドメイン）**
   - 設定ファイル作成
   - 構築実行
   - デプロイ確認

2. **Pattern A（workers.dev）**
   - 設定ファイル作成
   - 構築実行
   - CORS動作確認

3. **Pattern B**
   - 設定ファイル作成
   - 構築実行
   - Admin UI分離確認
   - CORS動作確認

4. **Pattern C**
   - 設定ファイル作成
   - 構築実行
   - マルチドメインCORS確認

5. **Pattern D**
   - 設定ファイル作成
   - 構築実行（API のみ）
   - UIデプロイがスキップされることを確認

### エンドツーエンドテスト

- ローカル環境での動作確認
- リモート環境での動作確認
- 各パターンでのOIDCフロー確認

---

## 実装チェックリスト

### Phase 1: 基本機能

- [ ] 設定ファイルスキーマの定義
- [ ] `setup-config.sh`の実装
  - [ ] 前提条件チェック
  - [ ] 環境選択
  - [ ] 操作モード選択
  - [ ] パターン選択
  - [ ] コンポーネント選択
  - [ ] ドメイン設定
  - [ ] 秘密鍵設定
  - [ ] CORS設定
  - [ ] 設定ファイル生成
- [ ] `build.sh`の実装
  - [ ] 引数解析
  - [ ] 設定ファイル読み込み
  - [ ] 操作モード確認
  - [ ] 設定内容表示
  - [ ] コンフリクトチェック
  - [ ] packages生成
  - [ ] Cloudflareリソース設定
  - [ ] 秘密鍵管理
  - [ ] CORS設定
  - [ ] デプロイ実行

### Phase 2: Pattern対応

- [ ] Pattern A（カスタムドメイン）
- [ ] Pattern A（workers.dev）
- [ ] Pattern B（分離Admin UI）
- [ ] Pattern C（マルチドメインSSO）
- [ ] Pattern D（ヘッドレス）

### Phase 3: エラーハンドリング

- [ ] エラートラップ
- [ ] リトライロジック
- [ ] ロールバック機能
- [ ] ユーザーフレンドリーなエラーメッセージ

### Phase 4: ドキュメント

- [ ] `DEVELOPMENT.md`更新
- [ ] `CLAUDE.md`更新
- [ ] 既存スクリプトの非推奨化
- [ ] 移行ガイドの作成

### Phase 5: テスト

- [ ] 単体テスト
- [ ] 統合テスト（各Pattern）
- [ ] エンドツーエンドテスト

### Phase 6: クリーンアップ

- [ ] このドキュメント（`IMPLEMENTATION_SPEC.md`）の削除
- [ ] 不要なスクリプトの整理（必要に応じて）

---

## まとめ

この仕様書に基づいて、以下の2つのスクリプトを実装します：

1. **`setup-config.sh`** - インタラクティブな設定ファイル作成
2. **`build.sh`** - 設定ファイルベースの自動構築

これにより、ARCHITECTURE_PATTERNS.mdの4つのパターン（A-D）すべてに対応した、柔軟でユーザーフレンドリーなセットアップ環境が実現されます。

---

**作成日:** 2025-01-17
**作成者:** Claude Code
**ステータス:** 実装準備完了
