# @authrim/ar-lib-field-mapping

Pure core package for the Field Mapping Control Plane PR1 contract.

## Boundary

This package contains only in-memory mapping, validation, dry-run, trace, and fixture
support. It must not import Worker runtime bindings, Hono, D1, KV, Durable Objects,
Admin API modules, queues, network clients, storage adapters, or repository code.

## Exports

- `@authrim/ar-lib-field-mapping/contract`: stable domain types only.
- `@authrim/ar-lib-field-mapping/runtime`: hot-path mapping execution and catalog lookup.
- `@authrim/ar-lib-field-mapping/authoring`: validation, dry-run, policy merge, and CSV
  authoring helpers.
- `@authrim/ar-lib-field-mapping/experimental`: draft preview types.
- `@authrim/ar-lib-field-mapping/test-support`: fixture builders and deterministic test helpers.

Stable authoring APIs include:

- `resolveEffectiveFieldMappingSet()`
- `validateMappingInput()`
- `dryRunMapping()`
- `dryRunMappingBatch()`
- `buildTraceEntry()`
- `validateCatalogBundle()`
- `validateTransformStep()`
- `executeTransformStep()`
- reason registry helpers and safe metadata helpers

Preview adapters are intentionally exported only from `./experimental`.

## Fixtures

Static protocol and negative fixtures live in `fixtures/`. Runtime code should not import
sample payloads from a production subpath. Tests and integration previews should use the
`./test-support` subpath when builder behavior is needed.

Fixture coverage includes:

- CSV user import shape
- SCIM User shape
- SAML attribute shape
- OIDC claims request shape
- malformed input shape
- regulated field shape
- conflict field mapping set shape

`./test-support` provides fixture builders, deterministic ID helpers through the stable
`./authoring` API, a test-only fingerprint provider, and static fixture validation helpers.

## Safety Contract

- Trace metadata and source metadata use the same safe metadata allowlist.
- Raw PII, secrets, raw protocol objects, and raw fixture payloads must not be included in
  trace metadata or deterministic ID hash inputs.
- Fingerprints are optional, non-reversible summaries. Production salt or key management is
  outside PR1 and must be supplied by a caller through `FingerprintProvider`.
- `src/adapters/*` is fixture / preview only. It must not connect to runtime services or storage.

## Tests

PR1 tests are split by purpose:

- `src/__tests__/unit`: pure engine behavior.
- `src/__tests__/registry`: reason, transform, metadata, and docs snapshot gates.
- `src/__tests__/fixtures`: static fixture and preview adapter gates.
- `src/__tests__/boundary`: no-runtime dependency and export boundary gates.

Useful checks:

```sh
pnpm --filter @authrim/ar-lib-field-mapping typecheck
pnpm --filter @authrim/ar-lib-field-mapping test
pnpm --filter @authrim/ar-lib-field-mapping build
pnpm exec prettier --check 'packages/ar-lib-field-mapping/**/*.ts'
```

## Compatibility

Breaking changes to reason codes, public contract types, catalog bundle identity, or fixture
contracts require a decision note, compatibility or registry test update, and PR changelog note.
