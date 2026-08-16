# Token matrix

This suite exercises the production token endpoint across constrained combinations of client
authentication, authorization-code state, grant binding, and issuance outcomes. Independent meta-tests
verify all legal pairs and selected security-critical 3-wise combinations.

## Covered behavior

- Matrix T-A covers public, confidential, unknown, and wrong-tenant clients; registered and presented
  authentication methods; authorization-code ownership, expiry, replay, and concurrent redemption.
- Matrix T-B covers redirect URI, PKCE, DPoP, resource and tenant binding, token issuance, downstream
  failures, and postcondition cleanup.
- Assertions observe endpoint responses, code consumption ordering, token claims and bindings,
  revocation or replay state, and whether failure paths leave reusable or partially issued artifacts.
- Mutation witnesses demonstrate detection of authentication downgrade, validation reordering,
  cross-tenant acceptance, incorrect claims, and incomplete cleanup.

The suite does not cover SAML or SCIM. Those protocols are part of the
[canonical integration suite](../../integration/README.md). Detailed overlap, combination guarantees,
and known runtime boundaries are recorded in [COVERAGE.md](./COVERAGE.md) and
[FINDINGS.md](./FINDINGS.md).

## Running the suite

```sh
pnpm exec vitest run --config vitest.security-matrices.config.ts \
  test/security-matrices/token-matrix
```
