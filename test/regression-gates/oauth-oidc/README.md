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

## Regression inventory

This suite is finding-driven rather than a covering array. Each manifest row names a confirmed
security failure and one or more exact test targets; the matrix below shows the attack boundaries that
must remain represented.

| Root-cause group                                  | Finding IDs                       | Conditions varied by the regression targets                                                          | Secure expectation                                                                               |
| ------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| RC-01: client authentication and identity binding | AO-02, AO-03, AO-04, AO-17, AO-18 | PAR/JAR identity, registered versus presented authentication, CIBA/Admin Agent/Device grant surfaces | registered authentication cannot be downgraded and request-object identity cannot be substituted |
| RC-02: conflicting request sources                | AO-07                             | simultaneous `request` and `request_uri`                                                             | reject before either request container is trusted                                                |
| RC-03: authorization-code lifecycle ordering      | AO-01, AO-08, AO-09, AO-11        | concurrent redemption, redirect URI and DPoP binding, expiry cleanup                                 | validate bindings before irreversible consumption and allow only one successful redemption       |
| RC-04: issuer, tenant, and SID namespaces         | AO-10, AO-12, AO-19               | public SID versus internal session ID, issuer aliases, legacy namespace state                        | keep tenant/issuer/session namespaces distinct and reject legacy ambiguity                       |
| RC-05: protocol input validation                  | AO-06, AO-14                      | response type/mode and PKCE verifier syntax                                                          | reject unsafe query-token responses and non-ABNF PKCE verifiers                                  |
| RC-06: browser-originated input                   | AO-15, AO-16                      | generated flow HTML and logout method/origin                                                         | escape reflected data and require CSRF-safe logout behavior                                      |

The gate requires all 17 finding IDs to remain present, resolves every target, runs the tagged secure
expectation, and fails closed when the manifest and executable inventory diverge. It does not claim
pairwise or 3-wise coverage; those guarantees belong to the authorization and token matrices.

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
