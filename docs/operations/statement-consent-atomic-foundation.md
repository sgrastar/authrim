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
a durable metadata projection job. Localization mutations co-commit a monotone version `updated_at`
revision. Activation compares the revision read before hashing and reserves the version row with a
transaction-local random `current_statement_guard` token before changing the old current. The token
conditions the generation bump and enqueue; the final update publishes the hash and restores
`current_statement_guard=statement_id`. A raced draft edit leaves the previous current and generation
unchanged and returns 409. This also locks the version row before PostgreSQL localization writes;
its concurrency semantics still require real PostgreSQL validation. Statement updates also increment the definition generation;
disabling increments the closed generation. Retirement follows the rules below. Projection
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
still retains the document hash. Localizations of active or archived versions are immutable; change the document by creating a new draft version.

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

## Retirement and evidence retention

`DELETE /api/admin/consent-statements/:id` now returns
`{ "success": true, "disposition": "retired" }` for published definitions. This replaces the former
cascade that erased all users' records and history. Retirement retains versions, localizations,
requirements, records and history. `retired_at` is set once; retries do not increment generations
again. A retired statement cannot be reactivated with PUT.

The order is:

1. In one metadata batch, set `is_active=0` and `retired_at`, increment both definition and closed
   generations, and enqueue the **closed** projection.
2. Project that generation to all account shards through the durable projection job. Failed shards
   remain pending. A pending projection is not proof of complete closure.
3. A submission of the previous screen returns `409 document_changed` through the existing consent
   POST contract. Metadata revalidation closes new grants immediately; after projection even a
   prepared old grant is rejected by the account guard. The already documented short interval
   between metadata revalidation and projection remains.
4. After each evidence row's retention deadline, the retention job removes eligible terminal records
   and unprotected history. Granted records still protect their history. Published definition
   tombstones, versions and bodies remain available; this job does not physically delete them.

Physical DELETE is restricted further to definitions whose never-active state can be proved:
`is_active=0`, `definition_generation=0`, no retirement marker, and only draft, unhashed versions.
The handler visits the registry's bounded account-store inventory and counts at most one matching
record and history row per store (also checking legacy metadata evidence). Only zero everywhere
permits a metadata-only atomic deletion; count/routing errors abort the request. Nonzero counts or
an unprovable activation history cause retirement. The deletion batch locks the parent statement before touching bodies and rechecks the draft proof
for every deletion. Activation must pass its parent-generation update before publishing a version.
A PostgreSQL parent/version lock conflict may abort a batch; retry the request after rollback. This conservative rule can retain unused drafts that have already been edited. There is no
API for erasing all users' consent evidence.

Version DELETE remains draft-only. Localization PUT and DELETE require a draft version of the
statement and tenant in the path; active and archived versions return 409. The write predicates
recheck draft status, including the compatibility SQL for older localization columns. Existing
localization tenant isolation remains in place. A body change requires a new version.

## Reference audit and retention shard traversal

The scheduler runs a recurring read-only reference audit. Use
`GET /api/admin/consent-statements/reference-audit` with the normal tenant consent settings read
permission. It returns `status` (`not_started`, `processing`, or `completed`), the current pass in
`current`, and the previous complete report in `last_completed` (NULL until the first completion).
The API never starts a destructive repair. There is no automatic deletion of unresolved references.

Each report counts `scanned` records and `unresolved` records, and includes bounded `samples` with
account `binding_ref`, `record_id`, `statement_id`, `version_id`, `missing_statement`, and
`missing_version`. A version that exists under a different statement or tenant is unresolved.
`samples_truncated` reports that the total exceeds the stored sample limit. Missing definitions may
be a restore/order problem: verify settings and users were restored with their original IDs, resolve
the referenced definitions, and inspect the next completed pass. **Run this audit to completion after
DR before releasing the target for use.** A sample list is a diagnostic subset, not a repair list.

Both maintenance jobs store their per-tenant targets, physical-route identities, shard/page cursor
and run ID in the existing metadata `admin_jobs` rows (`consent/reference-audit` and
`consent/retention`). A compare-and-swap acknowledges each successful page. An account or metadata
failure leaves that page pending and preserves completed shards. A changed target inventory or
physical route resets the pass. Tenant rotation uses AUTHRIM_CONFIG (KV fallback); failed tenants
are revisited on a later rotation. Explicit nonrouted deployments scan tenants in their single Core
binding and use that same database for definitions and records. No schema or DR column contract
changes are required. Restored cursors are reset when the trusted target identities change; PR7's
physical identity rebinding remains a separate prerequisite.

Retention scans bounded history pages before record pages on each account shard. Snapshot rows
use `retain_until` independently of current or missing definitions. Only rows with
`consent_settings_snapshot_at IS NULL` use current metadata `record_retention_days`, normalized from
PostgreSQL BIGINT strings. Unknown legacy policy keeps those rows. NULL deadlines remain unlimited;
strictly expired terminal statuses (`withdrawn`, `denied`, `expired`) and the granted-history
protection follow the existing rules. No migration of old rows is performed.

Each pass is a rolling keyset scan rather than a cross-database snapshot. Inserts below a saved row
ID and concurrent definition changes may be observed on the next pass. Keep a restored target
quiescent while obtaining its initial complete audit. The previous complete report remains readable
while a new pass runs. Page settings follow environment, then lowercase KV key, then code defaults:

| Environment key (KV uses lowercase)        | Default | Maximum |
| ------------------------------------------ | ------- | ------- |
| `CONSENT_REFERENCE_AUDIT_TENANT_PAGE_SIZE` | 4       | 32      |
| `CONSENT_REFERENCE_AUDIT_ROW_PAGE_SIZE`    | 64      | 90      |
| `CONSENT_REFERENCE_AUDIT_SHARD_PAGE_SIZE`  | 1       | 32      |
| `CONSENT_REFERENCE_AUDIT_SAMPLE_LIMIT`     | 32      | 100     |
| `CONSENT_RETENTION_TENANT_PAGE_SIZE`       | 4       | 32      |
| `CONSENT_RETENTION_ROW_PAGE_SIZE`          | 64      | 90      |
| `CONSENT_RETENTION_SHARD_PAGE_SIZE`        | 1       | 32      |

The shard page setting bounds pages per tenant tick, including the separate history and record
phases for retention. Invalid values fail closed. PostgreSQL maintenance SQL is statically reviewed
only in this environment; no real PostgreSQL execution has been performed.

The test-only step-B delete guards currently reject direct evidence deletion when a tenant guard
is enforced. PR7 must provide and verify an authorized retention deletion path before installing
those production triggers. PR5 leaves trigger fixtures and published migrations unchanged; a
blocked deletion remains pending rather than bypassing guards.
