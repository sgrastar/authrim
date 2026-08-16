# OAuth/OIDC regression gate

This suite is the manifest-driven release gate for confirmed OAuth/OIDC security findings. It runs
the exact regression test associated with every entry in `manifest.json` and fails if a finding is no
longer represented, a test cannot be executed, or the secure expectation regresses.

## Covered behavior

- Atomic authorization-code redemption, expiry cleanup, ownership, redirect URI, PKCE, and DPoP
  binding.
- PAR and JAR client authentication, request-object identity, issuer aliases, and conflicting request
  sources.
- Token endpoint authentication downgrade prevention for standard, CIBA, Device, and Admin Agent
  flows.
- OIDC session and SID namespace separation, logout CSRF protection, and authorization response-mode
  safety.
- Input validation for PKCE verifier syntax and generated authorization-flow HTML.

The manifest is the source of truth for finding IDs, titles, root-cause groups, treatment categories,
and one or more concrete test targets. The runner invokes only the tagged test for each finding and
produces a JSON summary for the PR coverage comment when `AUTHRIM_TEST_REPORT` is set.

This is a focused regression gate, not a complete protocol conformance suite. SAML and SCIM are covered
by the [canonical integration suite](../../integration/README.md), while broader OAuth/OIDC
combinations are covered by the authorization and token matrices.

## Running the suite

```sh
pnpm test:oauth-oidc-regressions
node test/regression-gates/oauth-oidc/run.mjs --list
```

The first command requires every listed finding to remain secure. The list command prints the stable
finding inventory without executing tests.
