# OpenID Foundation conformance evidence gate

These tracked scripts validate immutable test-plan evidence produced by the official OpenID
Foundation Conformance Suite. They do not create plans or store suite credentials in the
repository. The root `conformance/` directory is intentionally ignored for generated reports and
must not contain executable gate code. The directory name intentionally avoids a `conformance/`
path segment because the repository ignores generated conformance directories at every depth.

Required environment variables:

- `OIDF_CONFORMANCE_API_TOKEN`: API token or private-share token with read access to private plans;
  optional only when all evidence is public.
- `OIDF_CONFORMANCE_BASIC_PLAN_ID`
- `OIDF_CONFORMANCE_CONFIG_PLAN_ID`
- `OIDF_CONFORMANCE_DYNAMIC_PLAN_ID`
- `OIDF_CONFORMANCE_EXPECTED_DISCOVERY_URL`: exact Discovery URL used by all three plans.
- `OIDF_CONFORMANCE_MIN_STARTED_AT`: ISO-8601 deployment timestamp; older plans are rejected.
- `OIDF_CONFORMANCE_FAPI2_PLAN_ID` only for the optional `pnpm conformance:fapi2` profile.
- `OIDF_CONFORMANCE_BASE_URL`: optional HTTPS origin; defaults to
  `https://www.certification.openid.net`. Paths, credentials, query strings, fragments, and HTTP
  are rejected so a suite token cannot be redirected to another kind of endpoint.

Run `pnpm conformance:basic`, `pnpm conformance:config`, or `pnpm conformance:dynamic` after the
corresponding plan has completed. A gate passes only when every module in the plan has an executed
instance, the plan name exactly matches the requested Basic/Config/Dynamic certification profile,
the plan targets the expected Authrim Discovery URL and was created after the tested deployment,
every module belongs to that plan and started after it, and every instance is `FINISHED` with a
certification-acceptable Suite result: `PASSED`, `WARNING`, `SKIPPED`, or `REVIEW` with an uploaded
image embedded in the official module log. `WARNING`, `SKIPPED`, and accepted `REVIEW` entries
remain visible in the evidence output; unfinished, `FAILED`, `REVIEW` without uploaded evidence,
missing, and unknown results fail closed. Plan IDs are evidence references, not secrets, but
deployment-specific values should remain in CI environment variables rather than source control.

`pnpm conformance:test` covers the evidence parser and fail-closed cases. The root
`pnpm typecheck` also runs `pnpm conformance:typecheck`; gate code must not rely only on Vitest's
transpile step for type safety.

`openid4vc-profiles.ts` pins the official Suite plan names and exact Final/HAIP variants used for
OpenID4VCI 1.0 and OpenID4VP 1.0 gap analysis. Its tests deliberately fail if HAIP is weakened to a
plain profile (for example, `direct_post.jwt` to `direct_post`, `x509_hash` to `redirect_uri`, or
client attestation to `private_key_jwt`). Suite credentials, client private keys, tenant admin
tokens, and generated evidence remain outside the repository.
