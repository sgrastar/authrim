# Last-resort recovery of an admin's step-up second factors

Sensitive admin operations need L2: the admin's passkey and a second factor (a device-bound
security key, or the holder key of their Keyring admin credential). An admin who loses every
second factor normally files a **recovery request** in the Admin console: it waits 24 hours,
during which any other administrator can cancel it.

That path is refused when the admin is the only active administrator in the whole system
(`recovery_requires_last_resort`): nobody could cancel a request filed by someone who only stole
the passkey. The way back then is the **last-resort recovery**, which rests on the environment
owner's Cloudflare access instead of another administrator.

## What it does

In one database batch, for the admin it names:

1. Revokes every active second factor. The rows stay (`revoked_at` is set): a revoked factor is
   never registered again, and a restore does not bring one back.
2. Ends all of the admin's sessions. Step-up requirements, receipts and Keyring presentations are
   bound to a session, so they stop counting with it.
3. Cancels an open recovery request (`cancel_reason = 'last_resort'`), which would otherwise
   replace the factor registered next.
4. Opens a **re-enrolment window** (`admin_users.second_factor_reenroll_until`). Until it closes,
   the admin, with no active second factor, may register one after signing in with their passkey
   alone, once: the first registration closes the window.

It is written to the audit log (`admin.second_factor.last_resort_recovery`, severity critical),
emailed to the admin and to every active administrator, and shown as console notices (platform,
and the admin's tenant). Those notices are sent after the change and are best effort; the command
reports any that did not go out.

The window lasts 24 hours by default. It is the platform setting
`security.admin_last_resort_reenroll_window_seconds` (environment variable
`ADMIN_LAST_RESORT_REENROLL_WINDOW_SECONDS`), from 900 to 259200 seconds.

## With the setup tool (environments with a lock file)

On the machine that deployed the environment (it has the environment's `lock.json` and keys):

```bash
npx @authrim/setup admin recover-second-factor --env <env> --admin <email>
```

- `--tenant <id>` when administrators of several tenants share the email.
- `--reason <text>` is kept in the audit log.
- The command asks you to type the email again. `--yes` skips that.

The Setup UI has the same action in the environment's **Overview**, under _Admin second-factor
recovery_.

Under the environment lock, the tool writes its short-lived machine principal into the
environment's admin database with only the `admin:last_resort_recovery` permission, calls
`POST /api/admin/platform/last-resort-recovery/second-factors`, and removes the principal again.
No wildcard carries that permission, and granting it to any other machine principal needs an L2
step-up.

Afterwards the admin signs in to the Admin console with their passkey and registers a new
security key or Keyring credential under _My account → Security keys_ before the window closes.

## Without a lock file (manual procedure)

An environment deployed from another machine, or whose lock file is gone, cannot use the command.
Someone with Cloudflare access to the account can do the same directly in the admin D1 database
(normally `<env>-authrim-admin-db`). Each step below matches one of the API's; do them all, in this
order, and record that you did.

1. Find the admin:

   ```bash
   wrangler d1 execute <env>-authrim-admin-db --remote --command \
     "SELECT id, tenant_id, email, status FROM admin_users WHERE lower(email) = lower('<email>');"
   ```

2. Revoke the factors, end the sessions, cancel an open recovery request and open the window
   (24 hours here). Run it as one command so it is applied as one batch:

   ```bash
   wrangler d1 execute <env>-authrim-admin-db --remote --command "
     UPDATE admin_second_factors
        SET revoked_at = CAST(strftime('%s','now') AS INTEGER) * 1000
      WHERE admin_user_id = '<admin id>' AND revoked_at IS NULL;
     DELETE FROM admin_sessions WHERE admin_user_id = '<admin id>';
     UPDATE admin_second_factor_recoveries
        SET status = 'cancelled', cancelled_at = CAST(strftime('%s','now') AS INTEGER) * 1000,
            cancelled_by = 'manual-last-resort', cancel_reason = 'last_resort'
      WHERE admin_user_id = '<admin id>' AND status = 'pending';
     UPDATE admin_users
        SET second_factor_reenroll_until = (CAST(strftime('%s','now') AS INTEGER) + 86400) * 1000
      WHERE id = '<admin id>';"
   ```

3. Tell the admin and every other administrator yourself: the manual procedure sends no email and
   writes no audit log entry or console notice.

Never delete rows from `admin_second_factors`. A deleted row lets the same key be registered
again as if it had never been revoked, and leaves no trace of what happened. The column
`second_factor_reenroll_until` needs admin database migration
`011_admin_second_factor_reenroll_window.sql`; on an older release, update first.
