# private/scripts 運用メモ

## GitHub Actions 用 test 環境 secret の更新

`upload-test-env-secrets.sh` は、ローカルに生成済みの Authrim test 環境設定を GitHub Actions secrets にアップロードするためのスクリプトです。

更新される secret は以下です。

- `AUTHRIM_TEST_CONFIG`
- `AUTHRIM_TEST_LOCK_GZIP_B64`
- `AUTHRIM_TEST_KEYS_TAR_B64`
- `AUTHRIM_TEST_CLOUDFLARE_D1_API_TOKEN`
- `AUTHRIM_TEST_CLOUDFLARE_WORKERS_API_TOKEN`
- `AUTHRIM_TEST_CONTROL_TOKEN_PAIR_READY`

参照元は以下です。

- `.authrim/test/config.json`
- `.authrim/test/lock.json`
- `.authrim-keys/test/`

## 前提

- `gh` CLI で GitHub にログイン済みであること
- `tar`、`gzip`、`base64` が使えること
- repo root から実行すること
- `.authrim/test` と `.authrim-keys/test` が存在すること

アップロード前に、setup CLI本体と同じ補完・検証処理を使い、現行Workerが必要とする
supplemental key一式を確認します。不足している場合のみ生成し、既存値は変更しません。

Control WorkerのD1/Workers用トークンはkey archiveへ混在させず、個別のGitHub Actions
secretとして扱います。両方が既に登録済みなら値を変更しません。片方でも存在しない場合は、
権限を分離した2個のトークンをマスク入力して両方を登録します。
pair markerは2個の書き込みが両方成功した後にだけ作成されます。途中で失敗した場合、次回は
不完全な組み合わせを再利用せず、2個とも再入力して更新します。

ログイン状態は以下で確認できます。

```bash
gh auth status
```

## 実行方法

通常はこれだけで OK です。

```bash
private/scripts/upload-test-env-secrets.sh
```

GitHub secretsを変更せず、入力検証・不足鍵の補完・archiveサイズ確認だけを行う場合:

```bash
private/scripts/upload-test-env-secrets.sh --dry-run
```

Control Worker用トークンを明示的にローテーションする場合:

```bash
private/scripts/upload-test-env-secrets.sh --refresh-control-tokens
```

非対話実行では、権限を`0600`にした一時ファイルを2個指定してください。値をコマンドライン引数へ
直接指定しないでください。

```bash
private/scripts/upload-test-env-secrets.sh \
  --d1-token-file /secure/path/d1-token \
  --workers-token-file /secure/path/workers-token
```

別 repo に対して実行する場合:

```bash
private/scripts/upload-test-env-secrets.sh --repo sgrastar/authrim
```

別環境名を使う場合:

```bash
private/scripts/upload-test-env-secrets.sh --env conformance
```

この場合、secret 名は環境名に合わせて `AUTHRIM_CONFORMANCE_CONFIG` のように変わります。

## 何をしているか

スクリプト内部では以下を実行しています。

1. environment名、repository名、入力ファイル、symlinkの有無を検証
2. setup CLIのcanonicalな処理でsupplemental key一式を検証し、不足分だけ生成
3. `lock.json` と `.authrim-keys/<env>/` をgzip圧縮
4. 圧縮ファイルをbase64化し、GitHub Actions secretのサイズ上限内か確認
5. Control Worker用のD1/Workers token secretが両方存在することを確認し、不足時または明示的な
   rotation時だけ2個を同時に更新
6. `config.json`、圧縮済みlock archive、key archiveをGitHub Actions secretsへ登録

`lock.json` は `AUTHRIM_<ENV>_LOCK_GZIP_B64` として保存され、CIで復元時に
base64 decodeとgunzipを行います。旧形式の `AUTHRIM_ENV_LOCK` は復元スクリプトのみ
移行互換として受け付けますが、アップロードスクリプトは新形式だけを更新します。

一時ファイルは `mktemp` で作った一時ディレクトリに置き、終了時に削除されます。

## よくあるエラー

### `Required command not found: gh`

GitHub CLI が入っていません。

```bash
brew install gh
```

### `gh auth status` で失敗する

GitHub CLI にログインしてください。

```bash
gh auth login
```

### `Missing config file`

対象環境の設定ファイルがありません。例:

```bash
.authrim/test/config.json
```

セットアップツールで対象環境を生成してから再実行してください。

### `Missing keys directory`

対象環境の key ディレクトリがありません。例:

```bash
.authrim-keys/test/
```

対象環境の key 生成が完了しているか確認してください。
