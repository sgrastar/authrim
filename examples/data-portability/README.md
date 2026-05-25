# Authrim Data Portability Example

This example validates Authrim portable data artifacts. It is not an Authrim runtime and is not production-ready.

The initial flow reads a DR bundle, validates the portable schema, checks that private key/token material is not present, and writes a local replica copy.

## Commands

```bash
pnpm validate -- --bundle ./fixtures/saml-dr-bundle.example.json
pnpm replicate -- --bundle ./fixtures/saml-dr-bundle.example.json --target local --out ./replica
pnpm test
```

## Scope

Included:

- SAML DR bundle fixture
- bundle validator
- local filesystem replica writer

Not included:

- AWS port of Authrim
- production identity runtime
- active session migration
- production signing keys
- refresh token / authorization code replication
- real publisher login

Private signing keys are not included in the bundle. Use a separate key-management process for break-glass signing keys.
