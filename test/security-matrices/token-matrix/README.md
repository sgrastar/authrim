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

## Matrix definition

`Generated rows` counts covering-array rows, including dedicated success rows. Boundary, claim-oracle,
mutation, and coverage meta-tests bring the complete suite to 239 tests.

| Matrix                                      | Generated rows | Dimensions and value domains                                                                                                                                                                                                                                                                                    | Reachability constraints                                                                                                               | Production observations                                                                                                                               |
| ------------------------------------------- | -------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-A: client authentication × code state     |            115 | registered method: none, secret basic/post/JWT, private-key JWT; presented credentials: none, basic, post, JWT, malformed, conflicting; client: public, confidential, unknown, wrong-tenant; code: fresh, consumed, replayed, expired, malformed, wrong-client, wrong-tenant; request tenant: matching, foreign | failed authentication precedes code reads; public/confidential client kind must match its registered authentication method             | authentication result, code read/consume, exact replay revocations, tenant access, success issuance                                                   |
| T-B: grant binding × issuance/postcondition |             96 | code binding: none, PKCE, DPoP, both; PKCE verifier; redirect URI; resource/audience; DPoP proof; downstream failure: signing, family, registration, revocation; replay and registered-JTI state                                                                                                                | downstream failures are injected only after valid bindings reach their production branch; registered JTIs require an already-used code | response/error, code consumption, DPoP `cnf.jkt`, signed claims, refresh family, token registration, replay revocations, absence of partial artifacts |

## Required combination groups

Both matrices cover 100% of legal 2-way tuples. Meta-tests independently require these 3-way or
derived combination sets.

| Matrix | Required group                                              | Property exercised                                                                 |
| ------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| T-A    | registered method × presented credentials × client kind     | registered authentication cannot be downgraded or applied to the wrong client type |
| T-A    | code state × derived authentication result × request tenant | code ownership/state is examined only after successful tenant-bound authentication |
| T-B    | code binding × PKCE verifier × DPoP proof                   | PKCE and DPoP bindings compose without either check being skipped                  |
| T-B    | redirect URI × resource/audience × replay state             | pre-consumption request binding and replay classification remain correctly ordered |
| T-B    | replay state × registered JTI state × revocation outcome    | authenticated replay revokes exactly the durable token identifiers available       |

The suite does not cover SAML or SCIM. Those protocols are part of the
[canonical integration suite](../../integration/README.md). Detailed overlap, combination guarantees,
and known runtime boundaries are recorded in [COVERAGE.md](./COVERAGE.md) and
[FINDINGS.md](./FINDINGS.md).

## Running the suite

```sh
pnpm exec vitest run --config vitest.security-matrices.config.ts \
  test/security-matrices/token-matrix
```
