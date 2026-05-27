# @authrim/ar-lib-identity-mapping

Pure core package for the Unified Identity Mapping Control Plane PR1 contract.

## Boundary

This package contains only in-memory mapping, validation, dry-run, trace, and fixture
support. It must not import Worker runtime bindings, Hono, D1, KV, Durable Objects,
Admin API modules, queues, network clients, storage adapters, or repository code.

## Exports

- `@authrim/ar-lib-identity-mapping`: stable public types and pure functions.
- `@authrim/ar-lib-identity-mapping/experimental`: draft preview types.
- `@authrim/ar-lib-identity-mapping/test-support`: fixture builders and deterministic test helpers.

## Fixtures

Static protocol and negative fixtures live in `fixtures/`. Runtime code should not import
sample payloads from the root export. Tests and integration previews should use the
`./test-support` subpath when builder behavior is needed.

## Compatibility

Breaking changes to reason codes, public root types, catalog bundle identity, or fixture
contracts require a decision note, compatibility or registry test update, and PR changelog note.
