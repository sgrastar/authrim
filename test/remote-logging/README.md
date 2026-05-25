# Remote Logging Smoke Tests

These checks are intentionally separate from local Vitest suites. They touch a generated remote
Authrim environment, create temporary Machine Access through the setup validation flow, create a
temporary OAuth client, verify logging outputs, and clean up the temporary client and principal.

## Run

```bash
pnpm run test:remote:logging -- --env test
```

Equivalent direct command:

```bash
pnpm exec tsx test/remote-logging/smoke-remote-logging-output.ts --env test
```

Use `--json` for machine-readable output.

## What It Checks

| Output             | Verification                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Admin audit        | Creates a temporary client, then verifies `client.created` appears through `/api/admin/admin-audit-log`.                            |
| Admin audit archive | Polls `AUDIT_ARCHIVE` for the canonical D-format `admin_audit` archive chunk under `logs/v1/`.                                    |
| Admin DB audit row | Queries remote `DB_ADMIN` with Wrangler and checks `admin_audit_log`.                                                               |
| Sensitive detail   | Confirms `SENSITIVE_DETAILS` exists. If logging delivery queues are configured, polls for an `admin_audit` sensitive-detail object. |
| B-format export    | Queues a ZIP export projection from canonical D-format archive records and reports completion if the maintenance worker finishes.   |
| Diagnostic logging | Sends one SDK diagnostic ingest record and polls `DIAGNOSTIC_LOGS` for the JSONL chunk.                                             |

## Notes

- This is not part of `pnpm test` or CI by default.
- The test requires a logged-in Wrangler session with access to the target Cloudflare account.
- Admin/API calls use the tenant issuer origin from generated config, for example
  `https://first.test.authrim.com` in the generated `test` environment.
- It does not print client secrets or generated access tokens.
- Use `--skip-r2` when only HTTP/Admin DB behavior should be checked.
