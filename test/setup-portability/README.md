# Setup Portability Check

`test/setup-portability/validate-generated-env.ts` は、setup ツールが生成した `.authrim/{env}/config.json`,
`.authrim/{env}/lock.json`, `.authrim/{env}/wrangler/*.toml`, `packages/*/wrangler.toml`
を読み、fresh setup 後の環境が current portability 前提に沿っているかを確認します。

主な確認項目:

- `config.json` / `lock.json` が読める
- `DB` / `DB_PII` / `DB_ADMIN` が lock に揃っている
- default profile が builtin または seeded profile として解決できる
- active default profile が setup 出力だけで実行可能
- deploy `wrangler.toml` が lock resource と active profile vars に一致する
- `.authrim/{env}/wrangler` の master copy が package deploy copy と同期している

使い方:

```bash
pnpm exec tsx test/setup-portability/validate-generated-env.ts --env single
pnpm exec tsx test/setup-portability/validate-generated-env.ts --config /path/to/.authrim/single/config.json
```

JSON で取りたい場合:

```bash
pnpm exec tsx test/setup-portability/validate-generated-env.ts --env single --json
```

実際のデプロイ先に API を叩く smoke check:

```bash
pnpm exec tsx test/setup-portability/smoke-generated-api.ts --env single
pnpm exec tsx test/setup-portability/smoke-generated-api.ts --config /path/to/.authrim/single/config.json
```

確認対象:

- `GET /api/health`
- `GET /.well-known/openid-configuration`
- `GET /.well-known/jwks.json`
- `GET /api/auth/health`
- `GET /api/auth/login-methods`

管理 API の deeper smoke:

```bash
pnpm exec tsx test/setup-portability/smoke-generated-admin-api.ts --env single
pnpm exec tsx test/setup-portability/smoke-generated-admin-api.ts --config /path/to/.authrim/single/config.json
```

主な確認対象:

- `GET /api/admin/stats`
- `GET /api/admin/runtime-profiles/defaults`
- `POST/GET/DELETE /api/admin/token-claim-rules`
- `POST/check/DELETE /api/admin/resource-permissions`
- `POST/GET/DELETE /api/admin/webhooks`
- `POST/GET/rotate/DELETE /api/admin/check-api-keys`

補足:

- `ADMIN_API_SECRET` は原則として generated keys から自動で読みます
- `check-api-keys` 用の `client_id` が無ければ、一時 DCR client を作って後で削除します

認証・client lifecycle の deeper smoke:

```bash
pnpm exec tsx test/setup-portability/smoke-generated-auth-flow.ts --env single
pnpm exec tsx test/setup-portability/smoke-generated-auth-flow.ts --config /path/to/.authrim/single/config.json
```

主な確認対象:

- `POST /register`
- `GET /clients/:client_id`
- `PUT /clients/:client_id`
- `DELETE /clients/:client_id`
- `POST /token` (`client_credentials`, mode=`auto|on|off`)
- `POST /introspect`
- `POST /revoke`

補足:

- `client_credentials` は tenant/profile や feature flag で無効な場合があります
- `--client-credentials auto` では、その場合を warning 扱いにして DCR lifecycle だけ確認します
