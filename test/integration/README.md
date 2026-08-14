# Canonical integration tests

`AUTHRIM_SECURITY_REGRESSION_SUITE=true pnpm exec vitest run --config
vitest.integration.config.ts` is the required, maintained integration gate. Its files are explicitly
listed in `vitest.integration.config.ts`; adding a test to `test/integration` does not silently make it
release evidence.

`AUTHRIM_SECURITY_REGRESSION_SUITE=true pnpm exec vitest run --config
vitest.integration-legacy.config.ts` collects the broader historical integration suite. The legacy
command is expected to remain red while old direct-handler fixtures are rebuilt around current tenant
context, runtime bindings, and settings normalization. Do not weaken an assertion merely to make this
command green. Move a repaired file into the canonical config only after the full file passes and still
asserts current observable behavior plus important side effects.

The live hybrid-flow probe requires a separately started multi-worker server and is excluded from both
local configs until it has a deterministic runtime-backed replacement.

High-volume authorization, token, runtime-topology, and state-transition combinations live under
`test/security-matrices/`. They use `vitest.security-matrices.config.ts` so their deterministic
clock, fixed cryptographic fixtures, and serialized execution do not affect this integration gate.
