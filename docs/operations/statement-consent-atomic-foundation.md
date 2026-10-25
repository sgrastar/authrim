# Statement consent atomic foundation

This library foundation is unused by production consent handlers and maintenance. It does not fix statement-consent storage ownership, install tables, activate a mode, migrate/copy existing consent, or change current grant/read/withdraw/delete/retention behavior. Schema integration and runtime callsites require a separate change.

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

## Test schema provenance and remaining integration boundaries

The three SQL/statement-list assets under `src/services/__tests__/fixtures/statement-consent-step-a/` are test fixtures copied from the reviewed unpublished draft. Production modules must not read them. They are not numbered migrations, baseline changes, or an installed schema contract. Production migration manifests, dataset inventory, restore/discard policies, and barrel exports remain unchanged.

Later integration must connect all consent and maintenance writers, trusted target/restore identity, tenant ownership and co-location, generation/admission enforcement, and a proved rollback floor. Existing Flow `consent_records` stays separate. No new retention period, source-hold producer, DR catalog, copy, cleanup job, or activation is included here. Existing consent data/history and artifact/upload/operation/hold retention remain unchanged. The full portability and storage correction remains unimplemented by this foundation.
