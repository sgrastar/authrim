# Phase 2: LoginUI SDK Convergence and Workers-native UI Deployment

## Goal

Phase 2 の最終形は、LoginUI を Authrim SDK の built-in consumer に近づけることです。

- LoginUI は UX、branding、i18n、built-in 固有の画面遷移に集中する。
- auth protocol、PKCE、callback、error mapping、session handling、diagnostic logging は SDK 側の共通実装を使う。
- built-in UI では OAuth/OIDC token material を browser JS に返さず、server-mediated / HttpOnly cookie session を正準にする。
- AdminUI と LoginUI は Cloudflare Pages ではなく Workers static assets / SSR deployment を正準にする。
- setup tool / setup CLI / CI / docs も Workers-native UI deployment を正準として扱う。

## Scope

Phase 2 は LoginUI/SDK 統合だけではなく、UI deployment の正準変更も含みます。

In scope:

- LoginUI と SDK の Direct Auth / session / callback contract 統一。
- LoginUI の API client を SDK adapter boundary 経由に段階移行。
- AdminUI と LoginUI の Cloudflare Workers static assets / SSR deployment 移行。
- setup package の UI provisioning、deploy、update、source download、environment config の Workers 対応。
- setup CLI の `wrangler pages *` 前提を `wrangler deploy` / Workers builds 前提へ移行。
- CI/CD、getting-started、environment variables、deployment docs の Pages 記述を Workers 正準に更新。
- Pages deployment は legacy/compat path として残すか、明示的に非推奨化する。

Out of scope:

- Authrim core Workers の runtime 変更。
- UI の大規模 redesign。
- SDK public API の不要な breaking change。

## Current Assessment

LoginUI と SDK は概念としては近いが、実装はまだ独自です。

| Area | Current distance | Notes |
| --- | --- | --- |
| Login methods / branding / discovery | Medium | LoginUI 独自の薄い API 層。SDK 化しやすい。 |
| Passkey | Low-Medium | LoginUI は旧 `/api/auth/passkeys/*`、SDK は `/api/v1/auth/direct/passkey/*`。 |
| Email code | Low-Medium | LoginUI は旧 `/api/auth/email-codes/*`、SDK は PKCE + `direct_auth_artifact`。 |
| Social login | Medium | PKCE/state の思想は近いが callback/token exchange contract が異なる。 |
| Session | Medium | LoginUI は cookie session store。SvelteKit SDK の server-mediated session に寄せられる。 |
| Consent / login challenge | Medium-High | SDK に thin wrapper があるが endpoint aliases が未統一。 |
| Handoff | Medium | LoginUI は `/handoff/finalize` cookie-only、SDK は `/handoff/verify` token/session path。built-in では cookie-only を維持する。 |
| Error / diagnostics / storage | Medium | 重複実装が多く、SDK へ集約する価値が高い。 |

## Workers Migration Timing

推奨タイミングは、LoginUI の P0 contract 統一後です。

理由:

- LoginUI は callback、cookie、proxy、route ownership の影響が大きく、SDK 統合前に runtime を変えると問題の切り分けが難しくなる。
- Cloudflare の公式 Pages-to-Workers migration guide は Workers で static assets、backend APIs、SSR を扱えるとしているため、移行自体は方向性として正しい。
- Workers では static assets が Worker script より先に返るのが default で、認証チェックや logging を先に通す場合は `assets.run_worker_first` が必要になる。LoginUI/AdminUI の route/proxy 設計を固めてから移行した方が安全。
- Pages の runtime/build variables と Workers の variables/bindings は扱いが違うため、setup CLI と deploy docs も同時に直す必要がある。

実施順:

1. LoginUI SDK contract を先に統一する。
2. setup tool / setup CLI に Workers UI deployment の新しい deploy primitive を追加する。
3. AdminUI を Workers deployment の pilot にする。
4. LoginUI を Workers deployment に移す。
5. docs / CI / release workflow を Pages から Workers に切り替える。

References:

- Cloudflare Workers docs: [Migrate from Pages to Workers](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/)
- Cloudflare Workers docs: [Static Assets migration guides](https://developers.cloudflare.com/workers/static-assets/migration-guides/)

## Task List

### P0: Contract Freeze and Tests

- [ ] LoginUI が使う endpoint を棚卸しし、SDK canonical endpoint との差分表を作る。
- [ ] built-in LoginUI の session model を `server-mediated HttpOnly cookie session` として明文化する。
- [ ] `/api/v1/auth/direct/token` の legacy path を LoginUI から排除する。
- [ ] passkey / email code / social callback / handoff / consent / login challenge の contract tests を追加する。
- [ ] LoginUI callback が token material を browser JS に受け取らないことをテストする。
- [ ] SDK 側に必要な endpoint alias または built-in adapter の不足を洗い出す。

### P1: SDK Adapter Foundation

- [ ] LoginUI 内に SDK-facing adapter boundary を作る。
- [ ] `passkeyAPI`, `emailCodeAPI`, `externalIdpAPI`, `loginChallengeAPI`, `consentAPI` を段階的に SDK adapter 経由にする。
- [ ] PKCE generation/storage key/callback cleanup を SDK 実装に寄せる。
- [ ] SDK error mapping を LoginUI i18n message に投影する mapper を作る。
- [ ] diagnostic logging を SDK の auth decision events に寄せる。
- [ ] LoginUI 固有の branding、method display、client metadata display は UI layer に残す。

### P2: LoginUI Flow Migration

- [ ] Passkey login/signup/register を `/api/v1/auth/direct/passkey/*` に移行する。
- [ ] Email code send/verify を `/api/v1/auth/direct/email-code/*` + `direct_auth_artifact` に移行する。
- [ ] Direct Auth finish は canonical `/token` + `urn:authrim:params:oauth:grant-type:direct-auth-finish` を使う。
- [ ] built-in mode では Direct Auth finish を server-mediated handler で redeem し、HttpOnly cookie session を確立する。
- [ ] Social redirect callback を SDK-compatible state/PKCE handling に移行する。
- [ ] Handoff は token-returning verify path ではなく cookie-only finalize path を built-in adapter として明示する。
- [ ] Session store を SDK session namespace / server-mediated session に寄せる。
- [ ] Consent / login challenge wrapper の endpoint を `/auth/consent`、`/auth/login-challenge` と `/api/auth/*` の互換を整理する。

### P3: Workers-native UI Deployment

- [ ] AdminUI/LoginUI の current Pages adapter config と route exclusions を棚卸しする。
- [ ] setup package に UI Workers deployment model を追加する。
- [ ] setup CLI の UI deploy/update command が Workers scripts/static assets を作成・更新できるようにする。
- [ ] setup CLI の environment config を Pages project/env vars から Workers vars/secrets/bindings に対応させる。
- [ ] setup CLI の source/download/upgrade flow が Workers UI artifacts を扱えるようにする。
- [ ] setup CLI に Pages legacy deploy と Workers deploy の compatibility/migration messaging を追加する。
- [ ] AdminUI を Workers deployment pilot として `wrangler deploy` ベースに移行する。
- [ ] LoginUI を Workers deployment に移行し、auth callback/proxy/session routes を検証する。
- [ ] `wrangler pages deploy` scripts を `wrangler deploy` scripts に置き換える。
- [ ] Workers static assets config、`assets.directory`、必要なら `assets.run_worker_first` を設定する。
- [ ] Preview URLs、custom domains、routes、workers.dev replacement を整理する。
- [ ] Pages env vars と Workers vars/secrets/bindings の差分を setup CLI に反映する。
- [ ] setup CLI の deploy/update/source flows を UI Workers deployment に対応させる。
- [ ] CI/CD docs と getting-started docs の Pages 記述を Workers 正準に更新する。

### P3a: Documentation and Operator Experience

- [ ] `docs/getting-started/deployment.md` を Workers UI deployment 正準に更新する。
- [ ] `docs/getting-started/development.md` の local dev / preview / deploy commands を Workers 前提に更新する。
- [ ] `docs/ENVIRONMENT_VARIABLES.md` に Workers UI vars/secrets/bindings と Pages legacy variables の対応表を追加する。
- [ ] `docs/ci-cd-deployment.md` の Cloudflare permissions、deploy command、preview strategy を Workers 前提に更新する。
- [ ] README の deployment matrix から Pages 正準表記を外し、Workers static assets / SSR に更新する。
- [ ] setup CLI help text、interactive prompts、error messages を Workers 正準に更新する。
- [ ] migration guide を追加し、既存 Pages project から Workers UI deployment への手順を示す。

### P4: Cleanup and Removal

- [ ] LoginUI の旧 `/api/auth/passkeys/*`、`/api/auth/email-codes/*` 依存を削除する。
- [ ] LoginUI の独自 PKCE helper を SDK に不要な範囲で削除する。
- [ ] callback/debug/sessionStorage key の legacy names を移行または削除する。
- [ ] SDK/LoginUI の重複 type definitions を削減する。
- [ ] Pages deployment docs/scripts を互換扱いに降格する。
- [ ] AdminUI/LoginUI Workers deployment の smoke test を追加する。

## Behavior Changes to Announce Before Implementation

- LoginUI の passkey/email-code flow は旧 built-in endpoint から canonical Direct Auth endpoint に変わる。
- LoginUI callback は `/api/v1/auth/direct/token` を使わなくなる。
- built-in LoginUI は browser token storage ではなく HttpOnly cookie session を維持する。
- Workers migration 後、preview URL、custom domain、route precedence、env var/secrets の管理方法が変わる。
- Workers static assets は default で static asset が Worker script より先に返るため、認証や proxy を先に通す route は明示設定が必要になる。
- setup CLI の UI deployment は Pages project ではなく Workers script/static assets を作成・更新する。
- CI/CD の Cloudflare permission scope と deploy command が変わる。

## Acceptance Criteria

- LoginUI の primary flows が SDK adapter 経由で動く。
- LoginUI は OAuth/OIDC token material を browser JS に返さない。
- LoginUI と SDK の Direct Auth contract tests が同じ canonical semantics を検証する。
- AdminUI/LoginUI が Workers deployment で preview/prod ともに動く。
- setup tool / setup CLI が UI Workers deployment を作成・更新・移行できる。
- deployment docs、environment docs、CI/CD docs が Workers 正準になっている。
- Pages deployment は legacy/compat path として文書化される。
