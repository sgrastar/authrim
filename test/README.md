# Test directory map

Repository-level tests are grouped by execution boundary and purpose.

| Directory                | Purpose                                                                                  | Normal `pnpm test` | CI                         |
| ------------------------ | ---------------------------------------------------------------------------------------- | ------------------ | -------------------------- |
| `integration/`           | Cross-package protocol, tenant, and runtime integration tests                            | Canonical config   | Canonical config           |
| `security-matrices/`     | Deterministic high-volume OAuth, OIDC, tenant-topology, and state-transition regressions | Yes                | Yes                        |
| `regression-gates/`      | Small manifest-driven source and contract regression gates                               | No                 | Yes                        |
| `generated-environment/` | Validation and smoke checks for a generated or deployed Authrim environment              | No                 | Selected deployment checks |
| `shared-fixtures/`       | Data shared by package-level and repository-level tests                                  | Indirectly         | Indirectly                 |
| `mocks/`                 | Shared local runtime and framework module replacements                                   | Indirectly         | Indirectly                 |

Fast package-local unit tests remain beside production code under `packages/*/src/__tests__/`.
Suite-specific fixtures stay with the owning suite, for example
`integration/tenant-system/fixtures/` and `security-matrices/fixtures/`.

The maintained integration gate is the explicit file list in `vitest.integration.config.ts`, run by
`pnpm test:integration`. Files documented as legacy in `integration/README.md` are not CI evidence
until they are repaired and added to that canonical configuration.

The generated-environment runners may authenticate to Cloudflare and mutate a disposable target as
part of a smoke flow. They must not be treated as offline unit tests. See
`generated-environment/README.md` and `generated-environment/remote-logging/README.md` for their
individual cleanup and credential requirements.
