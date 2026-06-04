# Admin UI Session Tool

This tool issues a short-lived Admin UI session for generated Authrim environments without adding
any authentication bypass to product code.

It creates temporary rows in `DB_ADMIN`:

- `admin_users`
- `admin_role_assignments`
- `admin_sessions`

The resulting `authrim_admin_session` cookie can be used for manual Admin UI checks or Playwright
contexts. Clean up the session after the check.

## Issue a Session

```bash
pnpm run admin-ui:issue-session -- --env single --ui-origin http://127.0.0.1:5177
```

The command prints:

- generated environment
- Admin API base URL
- UI origin
- run ID
- session cookie value
- cleanup command

Use the printed cookie value in the browser or in a Playwright context.

## Cleanup

```bash
pnpm run admin-ui:issue-session -- --env single --cleanup <run-id>
```

Expired tool-created sessions can also be removed:

```bash
pnpm run admin-ui:issue-session -- --env single --cleanup-expired
```

## Local D1

The default target is remote D1, matching generated-environment smoke checks. Use `--local` for a
local Wrangler D1 database:

```bash
pnpm run admin-ui:issue-session -- --env single --local --ui-origin http://127.0.0.1:5177
```

## Notes

- The default TTL is 30 minutes.
- The default role is `super_admin`.
- The tool does not create or verify passkeys.
- The tool does not modify Admin UI authentication code.
- The generated account uses an `example.invalid` email address and ID prefixes reserved for this
  tool.
