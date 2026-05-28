---
title: Unified Identity Mapping Cutover Hardening
date: 2026-05-28
status: draft
---

# Unified Identity Mapping Cutover Hardening

This document is the PR6 verification checklist for the Unified Identity Mapping Control Plane
canonical runtime cutover.

## Automated Gates

| Gate                   | Purpose                                                                             | Command                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Split-brain regression | Verify canonical writes and protocol reads use the same subject/account graph.      | `pnpm --filter @authrim/ar-lib-core test -- src/repositories/__tests__/canonical-runtime-cutover-hardening.test.ts`                                    |
| Source gate            | Keep canonical runtime writer/projection free of unquarantined legacy table access. | `pnpm --filter @authrim/ar-lib-core test -- src/repositories/__tests__/canonical-runtime-cutover-gate.test.ts`                                         |
| Admin / SCIM runtime   | Verify Admin API and SCIM canonical write paths.                                    | `pnpm --filter @authrim/ar-management test -- src/__tests__/admin.test.ts src/__tests__/identity-canonical-runtime.test.ts src/__tests__/scim.test.ts` |
| SAML runtime           | Verify SAML user-store reads prefer canonical projection when enabled.              | `pnpm --filter @authrim/ar-saml test -- src/common/__tests__/user-store.test.ts`                                                                       |
| UserInfo runtime       | Verify UserInfo uses canonical projection while preserving PII status gating.       | `pnpm --filter @authrim/ar-userinfo test -- src/__tests__/userinfo.test.ts`                                                                            |
| Migration freshness    | Verify schema IDs and PR6 readiness snapshot remain aligned.                        | `pnpm --filter @authrim/setup test -- src/__tests__/cloudflare-migrations.test.ts`                                                                     |

The hot-path smoke test reports `canonical-runtime-hot-path-smoke` with `p95Ms` and
`maxReadCount`. PR6 budget is `p95Ms < 50ms` and `maxReadCount <= 6`.

## PR6 Readiness Snapshot

These entries mirror the schema-readiness inventory items that are required for the PR6 canonical
runtime cutover gate.

| ID           | Runtime object                | PR6 evidence                                                        | Status |
| ------------ | ----------------------------- | ------------------------------------------------------------------- | ------ |
| UIM-SCH-001  | `identity_subjects`           | PR #270 repository coverage, PR #271 runtime cutover, PR6 hardening | tested |
| UIM-SCH-002  | `identity_accounts`           | PR #270 repository coverage, PR #271 runtime cutover, PR6 hardening | tested |
| UIM-SCH-003  | `subject_account_links`       | PR #270 repository coverage, PR #271 runtime cutover, PR6 hardening | tested |
| UIM-SCH-004  | `profiles`                    | PR #270 repository coverage, PR #271 runtime cutover, PR6 hardening | tested |
| UIM-SCH-005  | `profile_attribute_values`    | PR #270 repository coverage, PR #271 runtime cutover, PR6 hardening | tested |
| UIM-SCH-006  | `structured_attribute_values` | PR #270 repository coverage, PR #271 runtime cutover, PR6 hardening | tested |
| UIM-SCH-007  | `contact_points`              | PR #270 repository coverage, PR #271 runtime cutover, PR6 hardening | tested |
| UIM-SCH-032A | canonical repository contract | PR #270 repository coverage, PR #271 runtime cutover, PR6 hardening | tested |

## Manual Verification Checklist

Run these checks in a real Cloudflare environment before promoting the cutover to `main`.

- Enable `ENABLE_CANONICAL_IDENTITY_RUNTIME=true` for the target environment.
- Create a user through Admin UI and verify canonical `identity_subjects`, `identity_accounts`,
  `profiles`, and `contact_points` rows are created.
- Update the same user through Admin UI and verify lifecycle state remains consistent between
  account and subject.
- Create a user through SCIM `POST /scim/v2/Users` and verify UserInfo and SAML user lookup return
  the same email/name from canonical projection.
- Deactivate a user through SCIM or Admin API and verify canonical projection no longer returns the
  account as active.
- Delete a user through SCIM or Admin API and verify canonical account and subject transition to
  `deleted`.
- Verify tenant discovery email, tenant code, app hint, and invitation flows keep the existing
  behavior.
- Inspect error logs and audit logs for raw PII, value storage refs, and SAML NameID-derived raw
  values.

## Rollback

- Set `ENABLE_CANONICAL_IDENTITY_RUNTIME=false`.
- Pause Admin API / SCIM writes for affected tenants while investigating.
- Check `identity_accounts` for duplicate active rows for the same `legacy_user_id`.
- Record the failed automated gate or manual checklist item in the release notes or follow-up PR.
