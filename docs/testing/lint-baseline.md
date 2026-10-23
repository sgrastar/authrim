---
title: 'Lint Baseline (ESLint bulk suppressions)'
project: Authrim
lang: en
date: 2026-10-24
status: draft
---

# Lint Baseline (ESLint bulk suppressions)

Sixteen Worker and library packages had a `lint` script that only printed
"lint skipped". They now run the root `eslint.config.js` on `src/`. The errors
that existed when lint was turned on are recorded, per package, in
`packages/<package>/eslint-suppressions.json` (ESLint's
[bulk suppressions](https://eslint.org/docs/latest/use/suppressions)).

Packages with a baseline: ar-agent-access, ar-async, ar-auth, ar-bridge,
ar-discovery, ar-lib-core, ar-lib-field-mapping, ar-lib-logging, ar-lib-policy,
ar-lib-scim, ar-management, ar-policy, ar-router, ar-saml, ar-token,
ar-userinfo.

## How the baseline behaves

- The file stores a count per file and rule. Lint fails when a file has more
  errors for a rule than its count, so existing files are still held to the
  rules: new code in an old file cannot add violations.
- New files have no entry, so the full rules apply.
- Warnings (for example `no-non-null-assertion`) are not suppressed; they are
  printed as before and do not fail lint.
- `pnpm run lint` passes `--pass-on-unpruned-suppressions`, so fixing a
  suppressed error does not fail CI. The count is left too high until the next
  prune.

## Commands

Run these from the repository root (or the same script inside one package):

```bash
pnpm run lint                    # check; fails only on errors beyond the baseline
pnpm run lint:prune-suppressions # lower counts to what is left after fixes
```

Never regenerate a baseline with `eslint --suppress-all` to make a new error go
away. Fix the error, or add a narrow `eslint-disable-next-line <rule> -- <reason>`
when the code is right and the rule is wrong for it.

## When to prune

- Whoever fixes suppressed errors runs `pnpm run lint:prune-suppressions` in the
  same PR and commits the changed `eslint-suppressions.json` files.
- When a feature branch merges develop and a suppressions file conflicts, keep
  the larger count for each entry, then run the prune: it lowers the counts to
  what the merged code has.
- Before a release (develop → main), run the prune and commit the result if
  anything changed, so the baseline does not drift above the real counts.

A prune only removes or lowers entries. If lint fails after a merge, the merged
code has a new error. Fix it; do not raise the count.

## Rule exceptions in the root config

These are documented exceptions, not part of the baseline:

| Where                                                                     | Rule                                                                                                 | Reason                                                                                                                 |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| all TypeScript                                                            | `no-undef`, `no-redeclare` off                                                                       | typescript-eslint recommends this. tsc reports both, and the core rules misreport ambient Workers types and overloads. |
| `ar-lib-core/src/utils/logger.ts`, `ar-lib-core/src/migrations/runner.ts` | `no-console` off                                                                                     | the structured logger's console sink, and a Node CLI whose output is its console report                                |
| inline, with `--` reason                                                  | `no-control-regex`, `no-console` (Logpush sink), `no-unnecessary-type-assertion` (ar-saml key-utils) | the code is intentional; the reason is on the comment                                                                  |
