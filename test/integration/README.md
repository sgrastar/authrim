# Canonical integration tests

`AUTHRIM_SECURITY_REGRESSION_SUITE=true pnpm exec vitest run --config
vitest.integration.config.ts` is the required, maintained integration gate. Its files are explicitly
listed in `vitest.integration.config.ts`; adding a test to `test/integration` does not silently make it
release evidence.

The canonical gate includes the maintained tenant/runtime flows plus the repaired FAPI 2.0, token
refresh/introspection/revocation, OIDC session-management, security-header, SAML federation, and SCIM
provisioning contracts. These tests exercise current exported handlers or production boundary
functions and assert negative cases and observable side effects where applicable.

## Protocol coverage

- SAML is covered by `saml-federation-contract.test.ts` and
  `saml-enterprise-academic-profiles.test.ts`. The tests validate SP and IdP contract behavior,
  metadata parsing, ACS and NameID rules, signature and certificate handling, attribute mapping, and
  enterprise and academic federation profiles.
- SCIM is covered by `scim-provisioning-lifecycle.test.ts`. It validates asynchronous user creation
  and operation completion, reads, PATCH deactivation, PUT reactivation, uniqueness and email
  validation, stale ETag rejection, tenant isolation, and the associated persistent side effects.
- OAuth/OIDC is covered by the FAPI, session-management, SID/logout, token lifecycle, and tenant-system
  files listed in `vitest.integration.config.ts`.
- Runtime and tenant coverage includes discovery, issuer and tenant binding, cookie sessions, vanity
  domains, negative routing cases, user flows, and the constrained 308-row settings matrix.

The SAML federation coverage includes contract-shaped Microsoft Entra ID, Okta, and Google Workspace
IdP metadata plus GakuNin/Shibboleth and eduGAIN-style academic aggregate metadata. These are synthetic,
secret-free fixtures that pin commonly deployed metadata, NameID, certificate rollover, ACS, attribute,
and aggregate-trust behavior without making network requests to a live federation or vendor tenant.

`AUTHRIM_SECURITY_REGRESSION_SUITE=true pnpm exec vitest run --config
vitest.integration-legacy.config.ts` collects the broader historical integration suite. The legacy
command is expected to remain red while old direct-handler fixtures are rebuilt around current tenant
context, runtime bindings, and settings normalization. Do not weaken an assertion merely to make this
command green. Move a repaired file into the canonical config only after the full file passes and still
asserts current observable behavior plus important side effects.

The remaining legacy-only files are authorization-flow, durable-objects, form-post-response-mode, and
PAR. They are diagnostic inventory, not release evidence, until repaired and explicitly added to the
canonical config.

The live hybrid-flow probe requires a separately started multi-worker server and is excluded from both
local configs until it has a deterministic runtime-backed replacement.

High-volume authorization, token, runtime-topology, and state-transition combinations live under
`test/security-matrices/`. They use `vitest.security-matrices.config.ts` so their deterministic
clock, fixed cryptographic fixtures, and serialized execution do not affect this integration gate.

## Running the suite

```sh
AUTHRIM_SECURITY_REGRESSION_SUITE=true pnpm exec vitest run --config vitest.integration.config.ts
```

The authoritative file list is the `include` array in `vitest.integration.config.ts`.
