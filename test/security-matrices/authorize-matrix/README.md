# Authorization matrix

This suite exercises the production authorization handler across constrained combinations of browser
session, tenant policy, consent, and OAuth/OIDC request inputs. It is divided into two decision
matrices and includes independent meta-tests for legal pair and selected security-critical 3-wise
coverage.

## Covered behavior

- Matrix A covers authentication, session usability and tenant ownership, SSO inheritance, `prompt`,
  `max_age`, and consent lookup and persistence.
- Matrix B covers direct parameters, PAR, JAR, PKCE, response types and modes, redirect URI safety,
  JARM requirements, and cross-tenant client or session rejection.
- Assertions observe responses, redirects, issued authorization-code records, PAR consumption,
  consent writes, and the absence of unsafe side effects on rejected requests.
- Mutation witnesses demonstrate that the matrix detects weakened validation, incorrect ordering, and
  omitted persistence behavior.

## Matrix definition

`Generated rows` counts covering-array rows only. The suite's additional boundary, oracle-sensitivity,
mutation, and coverage meta-tests bring the complete suite to 269 tests.

| Matrix                                   | Generated rows | Dimensions and value domains                                                                                                                                                                                                                                                                                                                                           | Reachability constraints                                                                                                                                                                                 | Production observations                                                                                                                                   |
| ---------------------------------------- | -------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: authentication, session, SSO, consent |            137 | client/tenant SSO: true, false, default, failure; session: missing, active, expired, revoked, legacy, wrong-tenant, store-failure; `prompt`: omitted, none, login, consent, select_account, invalid none-combination; `max_age`: omitted, zero, within, boundary, exceeded, malformed; consent: sufficient, missing, expired, insufficient, auto-grant, lookup-failure | non-active sessions cannot reach consent or meaningful `max_age` bounds; auto-grant requires an active subject                                                                                           | status/redirect/challenge, session-store read, authorization-code record, consent lookup/write, foreign-tenant access ledger                              |
| B: OAuth/OIDC request protocol           |             74 | source: direct, PAR, JAR, conflict; container: valid, expired, replayed, client/tenant mismatch, malformed, bad signature/claims; client type/binding; PKCE; response type/mode; redirect validity; JARM; validation phase; session binding                                                                                                                            | container state must match source; phase is derived; valid PAR restores a registered redirect and response type; pre-redirect failures do not read sessions; foreign clients fail before post-validation | direct versus redirected error, redirect target/mode, PAR read/consume, JAR verification, code issuance, session access, absence of rejected side effects |

## Required 3-wise groups

Every matrix also covers 100% of its legal 2-way tuples. The following security-critical triples are
independently enumerated and checked by the meta-tests.

| Matrix | Required triple                                      | Property exercised                                                         |
| ------ | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| A      | client SSO × tenant SSO × session                    | SSO inheritance never makes an unusable or foreign session active          |
| A      | `prompt` × session × `max_age`                       | reauthentication, non-interactive failure, and exact age-boundary ordering |
| A      | `prompt` × consent × session                         | consent forcing, lookup failure, auto-grant, and persistence behavior      |
| B      | source × client binding × session binding            | direct/PAR/JAR processing remains tenant-bound end to end                  |
| B      | client type × PKCE × response type                   | public and PKCE-required clients cannot bypass S256 requirements           |
| B      | response type × response mode × JARM requirement     | unsafe modes and non-JWT responses cannot bypass the response profile      |
| B      | redirect validity × validation phase × response mode | errors never target an unvalidated redirect URI                            |

The suite does not cover SAML or SCIM. Those protocols are part of the
[canonical integration suite](../../integration/README.md). Detailed overlap, combination guarantees,
and known runtime boundaries are recorded in [COVERAGE.md](./COVERAGE.md) and
[FINDINGS.md](./FINDINGS.md).

## Running the suite

```sh
pnpm exec vitest run --config vitest.security-matrices.config.ts \
  test/security-matrices/authorize-matrix
```
