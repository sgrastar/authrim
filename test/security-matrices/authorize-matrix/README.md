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

The suite does not cover SAML or SCIM. Those protocols are part of the
[canonical integration suite](../../integration/README.md). Detailed overlap, combination guarantees,
and known runtime boundaries are recorded in [COVERAGE.md](./COVERAGE.md) and
[FINDINGS.md](./FINDINGS.md).

## Running the suite

```sh
pnpm exec vitest run --config vitest.security-matrices.config.ts \
  test/security-matrices/authorize-matrix
```
