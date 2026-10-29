# Statement consent atomic foundation

Consent POST and per-user admin withdrawal now use the account-local atomic transition. Definitions
are read from tenant metadata; records, history, key states and operation receipts are written only
to the resolved account store. Flow `consent_records` remains a separate contract.

Core D1 036 / PostgreSQL 019 install the additive step-B tables, including metadata-owned durable
`statement_consent_projection_jobs`. **They install no production trigger.** D1's record foreign keys
remain until PR7: routed D1 writes must not be deployed before that rebuild and trigger installation.
This PR is a foundation for that rollout, not proof that the cutover is ready.

The transition preparer and receipt decoder require an explicitly supplied atomic capability. D1 uses actual prepared/bound batch execution and primary-required receipt reads. PostgreSQL opens a fresh owned connection for each reader/writer; ordinary adapter operations retain their cached connection. Readers require an authoritative primary read-only transaction. Both factories synchronously reserve received objects before crossing another await boundary. An ordinary factory cannot lend its reserved object to an owned operation; an owned object cannot return to ordinary use, whether active or ended. Rejected borrowers do not close the other owner's connection. Unknown connection/transaction/close results remain errors; recovery requires a matching primary receipt.

New owned-writer cleanup attempts termination after a connect failure and rollback after an ambiguous BEGIN response. A secondary rollback/close failure does not replace an earlier failure; close failure after an otherwise successful call remains an error. The ordinary query/transaction/cache/close method bodies are retained. The ordinary factory wrapper preserves its receiver and arguments and only rejects an object already reserved for an owned operation. This does not establish transaction semantics through a fake client test.

## Default local tests

The standard Core Vitest configuration discovers the SQLite transition, receipt decoder, installed local Miniflare transport, deterministic PostgreSQL lifetime tests, and the existing ordinary PostgreSQL adapter tests. No PostgreSQL server, private schema path, or repository environment variable is required. Miniflare fixes compatibility date `2026-07-08`, matching the existing local D1 test fixture; it does not follow today's date or a runtime maximum automatically. It uses installed dependencies and local loopback only; tests do not download a runtime or contact a remote D1 service.

```sh
AUTHRIM_SECURITY_REGRESSION_SUITE=true pnpm --filter @authrim/ar-lib-core exec vitest run src/services/__tests__/statement-consent-transitions.test.ts src/services/__tests__/statement-consent-receipt-decoder.test.ts src/services/__tests__/statement-consent-d1-transport.test.ts src/db/__tests__/statement-consent-atomic-lifetime.test.ts src/db/__tests__/postgres-adapter.test.ts
```

Fake PostgreSQL clients establish connection ownership, SQL dispatch order, error preservation, and cleanup. They do not prove PostgreSQL foreign keys, triggers, isolation, int8 decoding, or business effects.

## Explicit disposable local PostgreSQL integration

The real PostgreSQL suite is `src/test/integration/statement-consent-postgres.integration.ts`. It is intentionally outside the default `src/**/*.test.ts` discovery and runs only with its explicit configuration:

```sh
AUTHRIM_SECURITY_REGRESSION_SUITE=true pnpm --filter @authrim/ar-lib-core exec vitest run --config vitest.statement-consent-postgres.config.ts
```

Provide `AUTHRIM_STATEMENT_CONSENT_TEST_PG_URL` through a protected environment for an explicitly disposable loopback PostgreSQL database. A missing, invalid, or non-loopback URL fails; the suite never silently skips. It creates random per-test schemas and drops those schemas on cleanup. It must not target a live or shared database. No endpoint or credential should be added to source or logs.

The explicit suite separately checks actual SQL closure, replay, default node-postgres int8 values, read-only enforcement, independent backend connections, and ambiguous results. Default test success and standalone DDL parser acceptance are not evidence that this suite passed.

## Step-B snapshot and generation contract

The application reads one trusted metadata snapshot containing tenant, statement, version ID,
version, content hash, active status and definition generation, together with retention settings.
Account admission checks that snapshot against the projected guard and its physical identity; it
never joins the account store's empty definition tables. `content_hash` and `content_hash_after`
participate in payload hashes, before/after projections and the SQL fixture's trigger comparisons.
Legacy NULL hashes are preserved on withdrawal. Each statement key is atomic independently; a
multi-item HTTP request is not a transaction across statement keys.

Existing records bootstrap their key state with revision zero using insert-on-conflict, followed by
a primary read. Revision and withdrawal generation, all timestamps and PostgreSQL BIGINT settings
are normalized with `Number()` before arithmetic or JSON projection. A retry after a lost native
batch acknowledgement recovers only through a matching primary operation receipt.

Version activation co-commits both current-version changes, the definition generation increment and
a durable metadata projection job. Statement updates also increment the definition generation;
disabling increments the closed generation. Retire/delete policy itself belongs to PR5. Projection
acknowledges each account shard in the job row, uses the registry's existing store-count bound, and
resumes from the last acknowledged shard after failure. A changed target inventory or physical route
resets its cursor. A newer definition generation resets the job and cannot be acknowledged or deleted
by an older worker. Guard updates never decrease either generation. Closed statement guards reject
grants but continue to admit withdrawals. Re-enabling a statement requires a newer definition
generation and preserves its closed generation; a closed tenant guard remains terminal and blocks
every write. Guard account bindings remain immutable alongside physical identity and restore epoch.

The scheduler awaits its durable work and records failures without clearing pending jobs. Pending
statements and tenants rotate through bounded pages. Configuration uses environment, then KV, then
safe code defaults:

| Environment / KV key                                                                              | Default | Meaning                                                                                                      |
| ------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `STATEMENT_CONSENT_OPERATION_TTL_MS` / `statement_consent_operation_ttl_ms`                       | 60000   | Internal transition deadline after preparation, also the bounded allowance for clock skew before preparation |
| `STATEMENT_CONSENT_PROJECTION_PAGE_SIZE` / `statement_consent_projection_page_size`               | 4       | Jobs and account shards per page, at most 32                                                                 |
| `STATEMENT_CONSENT_PROJECTION_TENANT_PAGE_SIZE` / `statement_consent_projection_tenant_page_size` | 32      | Tenants per scheduler page, at most 32                                                                       |

DSQL has no statement-consent atomic capability. Consent POST and admin withdrawal return 503 for
that unsupported writer, including optional items. There is no sequential fallback. Existing login
handling when definition reads fail is unchanged.

## Browser submission contract

Every displayed consent item includes `version_id` and `content_hash` (possibly NULL on a legacy
version). `/auth/consent` POST requires `consent_item_versions`, keyed by statement ID, containing
those two values for **all displayed items**, independently of decisions. The server reloads the
items and compares their exact set, version IDs and hashes. Missing or changed snapshots, removed
items and account generation conflicts return `409 document_changed` before authorization proceeds.
The Login UI echoes this snapshot. An omitted optional decision still means withdrawal/refusal.

Snapshot mismatches found before consumption leave the original challenge reusable; the UI reloads
its current documents and resets decisions. A later generation conflict issues a fresh consent
challenge bound to the same user/session and capped by the original expiry, returned in
`error_details.consent_challenge_id`. The UI reloads that challenge. If the original has expired,
`error_details.restart_required` asks the user to restart from the app. No approval is automatically
replayed and a consumed challenge is never reused. A change after metadata
revalidation and before guard projection has the documented short cross-database window; evidence
still retains the document hash. Localization immutability and statement retirement are PR5 work.

## Physical identity and disaster recovery

The already resolved account store's tenant guard supplies `account_id`, `physical_id` and
`restore_epoch`; the first trusted writer/projection creates a random binding when none exists.
Here `account_id` is the stable tenant/account-store binding namespace; `user_id` remains part of
every consent key. HTTP bodies never supply these identities. A pre-existing key or receipt without
a tenant guard fails with `statement_consent_restore_rebind_required`, as does a mismatched key or
statement-guard binding. A guard is never silently rebound by normal writes or projection.

Guards and projection jobs are rebuild state and excluded from portable rows. Key states, terminal
operations and admissions are users datasets. SQLite restore holds source admissions and executing
operations. The direct PostgreSQL importer rejects nonempty source guards/admissions before opening
a target; their column contracts alone do not authorize importing live source authority. `core.consent_item_history` remains history (including its created-at log window) but is
exported/restored on `tenant_core/users`. PostgreSQL restore contracts pin every column and numeric
column of the four atomic tables; guards' optional schema contract remains explicitly excluded from live PostgreSQL projection.

**A restore to a different physical database requires explicit rebinding before any writer runs.**
PR7 implements rebinding and rebuilds guards/projection work. Keep the target quiescent until it
finishes; copying an entire database including its old guards cannot be distinguished from the
source solely by reading those guards. This PR does not claim automatic physical identity discovery.
Existing multi-users-shard restore limitations, source/target audits, and a proved rollback floor
remain rollout prerequisites. There are no existing routed environments requiring a data move;
no relocation or cleanup job is included.

## Fixture provenance and verification limits

The three assets under `src/services/__tests__/fixtures/statement-consent-step-a/` retain their
historical filenames, but now describe step B. Their triggers/functions are test-only; production
modules never load these assets. The D1 SQL, statement list, PostgreSQL SQL and TypeScript preparer
must be changed together. Numbered migrations 036/019 contain tables only.

Local SQLite tests exercise separate stores, rollback on history/enqueue failure, lost batch
acknowledgements, revision-zero bootstrap, string BIGINT boundaries and durable fan-out races.
The local schema-contract suite compares D1 and PostgreSQL column lists statically. PostgreSQL was
**not executed in this environment** (no disposable server and no network). Static parity and passing
SQLite tests do not establish PostgreSQL trigger, lock, isolation or restore execution behavior.
The explicit PostgreSQL integration suite above must still run before a PostgreSQL rollout.
