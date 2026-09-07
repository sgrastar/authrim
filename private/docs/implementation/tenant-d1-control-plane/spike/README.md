# Phase 0 live API spike evidence

The reproducible harness is `scripts/control-plane/phase0-live-spike.ts`. It permits only the `test`
environment and defaults to dry-run:

```sh
pnpm control-plane:phase0-spike --env test
```

Split-token live execution requires `CLOUDFLARE_ACCOUNT_ID` and distinct
`CLOUDFLARE_D1_API_TOKEN` / `CLOUDFLARE_WORKERS_API_TOKEN` values. Optional KV and R2 rows in that mode
require their own `CLOUDFLARE_KV_API_TOKEN` / `CLOUDFLARE_R2_API_TOKEN`. Missing optional tokens fail
closed for that operation and are recorded without exposing token values. Every created resource uses
the `authrim-cp-spike-test` prefix and cleanup runs from `finally`.

The same provider matrix can be run through the setup operator credential provider with
`--operator-oauth`. That mode uses the current Wrangler OAuth credential only in process for D1,
Workers, KV, and R2 operations and proves the operator executor path, but it does not satisfy the
separate split-token least-privilege exit criterion. Evidence records the credential mode so the two
proofs cannot be confused.

These records are private implementation evidence. Account identifiers and local temporary paths are redacted.

| Record | Status | Use |
| --- | --- | --- |
| `phase0-live-api-spike-20260727t194026.json` | incomplete | setup/cleanup evidence only; do not use for API conclusions |
| `phase0-live-api-spike-20260727t194130.json` | failed validation | records an intermediate run where final D1 reachability was false |
| `phase0-live-api-spike-20260727t194241.json` | successful | authoritative evidence for multipart settings PATCH and immediate deployment activation |
| `phase0-live-api-matrix-20260731045718-debadc.json` | expected provider rejection | immutable inherit version IDs were rejected with provider code `10057`; all disposable resources were deleted |
| `phase0-live-api-matrix-20260731050602-b1d776.json` | successful operator matrix | authoritative evidence for deployment-fenced `latest` inheritance, exact one-active-deployment verification, RPC/JWS smoke, reflected settings preservation, and cleanup |
| `phase0-live-api-matrix-20260801021746-94e881.json` | expected rollback characterization failure | proved response-loss adoption, then showed that deploying the previous Worker version does not remove a settings-added D1 binding; all disposable resources were deleted |
| `phase0-live-api-matrix-20260801021928-f2eac9.json` | repeated rollback characterization failure | captured the surviving `SPIKE_APPENDED_DB` binding after previous-version deployment without recording binding values or secrets; all disposable resources were deleted |
| `phase0-live-api-matrix-20260801022207-72da39.json` | expected provider rejection | previous-version deployment followed by `/settings` PATCH failed with provider code `10214` because the latest uploaded version was no longer deployed; all disposable resources were deleted |
| `phase0-live-api-matrix-20260801022536-926b97.json` | successful response-loss and rollback matrix | authoritative evidence for reflected response-loss adoption and settings-only rollback while the patched version remains fenced; the added D1 binding disappeared, all preserved settings matched, and all disposable resources were deleted |
| `phase0-live-api-matrix-20260801023345-fb1eb9.json` | successful complete optional operator matrix | authoritative operator-OAuth evidence preserving KV, R2, Worker Loader, secret, Service Binding, Durable Object, D1, tail consumer, and non-binding settings through append and saved-settings rollback; all four Workers, two D1 databases, one KV namespace, and one R2 bucket were deleted |

The initial successful run covered only an existing `plain_text` binding plus a newly added D1
binding. The expanded provider matrix found that immutable version IDs in `inherit` entries are
rejected with provider code `10057`. Production therefore uses `version_id = latest` only under an
immutable expected-source deployment lease/fence, then requires exactly one new deployment and a
reflected settings diff. Later records complete the secret, Service Binding, KV, R2, Durable Object,
Worker Loader, tail consumer, observability, and non-binding settings matrix.

The successful operator matrix preserved D1, plain text, secret text, Service Binding, Durable Object,
tail consumer, placement, compatibility, observability, annotation, and related settings. It used the
Wrangler OAuth operator credential and therefore does not prove split-token least privilege. The
2026-08-01 complete optional operator matrix additionally proved KV, R2, and Worker Loader creation,
runtime access, deployment-fenced inheritance, saved-settings rollback, and cleanup. Only the
resource-class-separated token proof remains open.

The 2026-08-01 rollback characterization corrected an unsafe assumption in the original Control
reconciler. Cloudflare documents that resources connected to a Worker are not changed by a Worker
version rollback. Live evidence confirmed that the settings-added D1 binding remained present. It
also confirmed provider code `10214` when attempting a version-settings PATCH after rolling back to a
non-latest version. The binding reconciler therefore performs its compensating saved-settings PATCH
directly while the patched deployment remains fenced; it does not deploy the previous code version.
The successful record verifies exactly one compensating deployment, no residual appended binding,
full settings preservation, runtime smoke, and cleanup.
