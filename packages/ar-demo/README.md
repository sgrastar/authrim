# @authrim/ar-demo

The start portal of a public demo environment: a small, standalone Cloudflare Worker that lets an
anonymous visitor start a temporary tenant and lands them in the admin console's join page.

It is an **external machine client of the Admin API, over HTTP only**. It imports nothing from the
other packages and has no binding to the platform's databases. Its only storage is its own D1
registry (`demo_tenants`). It holds the strongest secret of the environment (a global machine key)
and is reachable anonymously, so it is deliberately small.

**This package is not deployed by the setup tool.** It is not in the setup tool's worker list or the
generated wrangler configuration, and has no `deploy` script. It is deployed by hand with the steps
below.

## Flow

1. `GET /` shows the notices and a Turnstile widget. It renders even when the demo is full.
2. `POST /start` checks, in order: the `Origin` header (must equal `PORTAL_ORIGIN`) and the form
   content type; the client address (`CF-Connecting-IP`, required unless `ENVIRONMENT=development`);
   the Turnstile token (fails closed); then ONE `INSERT ... SELECT ... WHERE` statement that decides
   the per-IP limit and the capacity together. It then asks the Admin API to create the tenant
   (`shared_pool`) and answers `303 /wait` with the cookie `__Host-demo_ticket` (HttpOnly, 30 min).
3. `GET /wait` loads `/assets/wait.js`, which polls `GET /status` every 2 seconds for up to about
   3 minutes.
4. `GET /status` looks the row up by the SHA-256 of the ticket. When provisioning has succeeded,
   exactly one request claims the hand-off (`provisioning` to `inviting`), creates the admin
   invitation with `code_delivery: "response"` and returns
   `{state: "ready", join: "<console>/admin/join#code=...&email=..."}`. The code is returned once
   and is never stored or logged.

Only hashes are stored: the ticket as SHA-256, the client address as an HMAC-SHA-256 keyed with
`IP_HASH_SECRET`. Raw addresses, tickets, tokens and codes are never written to the database or the
logs. A registry row alone never authorises a write to the Admin API. The row records when the core
accepted the creation (`create_accepted_at`); the cleanup deletes a tenant only when that is set, or
when the tenant still carries the portal's exact name and description. Otherwise (for example the
core refused the creation because the id belongs to someone else) the row is released as `deleted`,
no write call is made and `cleanup_not_ours` is logged. A row without that record is never polled by
`/status`. Rows that end `failed` keep counting toward capacity until the cleanup (below) removes
their tenant.

## Configuration

`wrangler.jsonc` vars (validated together by `loadConfig`; an invalid configuration answers 503):

| Name                        | Meaning                                                                                                                                  | Default / range       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `ADMIN_API_ORIGIN`          | Origin of the Authrim API (token endpoint and Admin API). Must equal the issuer origin the token endpoint expects as assertion audience. | https, no path        |
| `CONSOLE_ORIGIN`            | Origin of the admin console. The join link must be on it.                                                                                | https, no path        |
| `PORTAL_ORIGIN`             | Origin of this portal.                                                                                                                   | https, no path        |
| `TURNSTILE_SITE_KEY`        | Public Turnstile key.                                                                                                                    |                       |
| `MAX_ACTIVE_TENANTS`        | Rows not `deleted`.                                                                                                                      | 75, clamped to 1..500 |
| `MAX_STARTS_PER_IP_PER_DAY` | Rows per address hash in 24 hours.                                                                                                       | 3, clamped to 1..20   |
| `TENANT_TTL_HOURS`          | `expires_at` of a row; also shown on the start page.                                                                                     | 24, clamped to 1..24  |
| `ENVIRONMENT`               | `development` allows loopback http origins and a missing client address.                                                                 |                       |

Secrets (`wrangler secret put`): `TURNSTILE_SECRET_KEY`, `MACHINE_CLIENT_ID`, `MACHINE_KEY_ID`,
`MACHINE_PRIVATE_JWK` (the private ES256 key as JSON; other key types are refused), `IP_HASH_SECRET`
(at least 16 characters).

## Manual operator steps

1. **Machine principal.** In the Authrim environment, create a _global_ machine principal and an
   ES256 credential (key id = `MACHINE_KEY_ID`, client id = `MACHINE_CLIENT_ID`). Give it exactly
   these permissions by exact name (no wildcard carries the exemption or the hand-off):
   - web path (the token requested by `/start` and `/status`): `admin:tenants:provision`,
     `admin:admin_users:read`, `admin:admin_users:write`, `admin:admin_roles:write`,
     `admin:admin_invitations:code_handoff`;
   - scheduled cleanup (a separate token): `admin:tenants:delete`,
     `admin:step_up_exempt:tenant.delete`, `admin:tenants:provision`.

   The two paths request different scope sets and keep separate token caches, so the web path never
   holds delete rights and the cleanup never holds the hand-off right. Each path checks that the
   granted scope of its token contains every scope it asked for and refuses to run otherwise.

2. **Code hand-off.** Switch on the platform setting `admin_invitations.code_handoff_enabled`
   (default off; a human with a step-up does this in the admin console).
3. **Database.** Create the portal's own D1 database, put its id into `wrangler.jsonc`, and apply
   the migrations (`0001` and `0002`): `wrangler d1 migrations apply ar-demo-registry --remote` (from this directory).
4. **Turnstile.** Create a Turnstile widget for the portal's hostname.
5. **Secrets and vars.** Set the secrets and replace the placeholder vars.
6. **Deploy.** `wrangler deploy` from this directory, then route the portal's hostname to it.

## Cleanup

A cron trigger (`*/10 * * * *`) runs `src/cleanup.ts`. Each run does a bounded amount of work (at
most 10 rows per phase, oldest first):

1. Rows that are expired, `failed` for 5 minutes, or still `provisioning`/`inviting` 32 minutes after
   creation (30 minutes of ticket life plus a 2 minute margin for an in-flight hand-off) are
   claimed by a guarded move to `deleting`.
2. For each, the tenant is looked up (`GET /api/admin/tenants/:id`) and then: absent (404) or already
   `deleted` means gone; still provisioning means the provisioning cleanup; an operator-deletable
   state means `DELETE /api/admin/tenants/:id` (202 queues the deletion job).
3. Rows in `deleting` that were not asked about for 9 minutes (least recently asked first) are asked again the same way. A
   tenant whose deletion job failed (it is left `suspended`) gets a new DELETE.
4. `cleanup_not_ours` is logged as an error for a row released without any write, and `cleanup_stuck` is logged as an error when rows have been `deleting` for 3 hours or more.
5. `deleted` rows older than 7 days are removed (they are kept only for the per-IP 24 hour look-back).

A row counts toward capacity until it is `deleted`. A tenant is only ever treated as gone after a
404 carrying the not-found error code (`AR060004`) or a lifecycle state of `deleted`; any other
answer or error leaves the row in `deleting`. A purged tenant leaves a tombstone row with the
lifecycle `deleted` in the platform, so a repeated DELETE would answer 400 (same as while it is
still deleting): that is why the cleanup reads the lifecycle with `GET /api/admin/tenants/{id}`,
which a global machine principal holding `admin:tenants:provision` may call (it returns the tenant's
id, code, name, description, isolation policy and lifecycle state). A configuration error (a scope
that was not granted, or a 401/403 on the lookup, delete or provisioning cleanup such as a missing
exemption) stops the run and is logged as `cleanup_config_error`.

### Timing and recovery

- **Creation** can take up to about a minute: the core's provisioning job starts on its next
  one-minute tick. A shared pool that has not served a tenant yet is slower the first time, so
  create (and delete) one tenant after a fresh deployment before opening the portal.
- **Deletion** takes about 45 minutes from the first DELETE: a backup, a fixed 30 minute quarantine
  in which the tenant no longer serves requests, then the purge. The row stays `deleting` (and counts
  toward capacity) for that whole time, so size `MAX_ACTIVE_TENANTS` for tenants that are on their way out as
  well as live ones.
- **A deletion job that fails** leaves the tenant `suspended` and quarantined. The core has no
  cancel: the next DELETE for the same tenant continues the failed deletion from where it stopped.
  Step 3 above issues that DELETE on its own, so no operator action is needed; `cleanup_stuck` is
  the signal that it is not converging.
- **A human deleting a tenant by hand** needs a second factor on their admin account (the core asks
  for a step-up). The cleanup's machine principal does not, because it holds
  `admin:step_up_exempt:tenant.delete`; keep that scope on the cleanup token only.

## Operational notes

Apply migration `0002` before the portal creates its first tenant. Rows that already exist when it
is applied have no acceptance record, so the cleanup treats them by the name-and-description rule
above: a tenant whose administrator renamed it would be released as not the portal's and left in
the core for an operator to delete.

Calls to the Admin API are subrequests of the visitor's request. When the portal and the API are on
the same Cloudflare zone, the core records the visitor's address in its own audit trail and in its
credential last-use fields. The portal's own storage keeps only the keyed hash.

## Development

```
pnpm --filter @authrim/ar-demo run build
pnpm --filter @authrim/ar-demo run typecheck
pnpm --filter @authrim/ar-demo run test
pnpm --filter @authrim/ar-demo run lint
```

The tests run the registry against real SQLite (`node:sqlite`) behind a small D1-like adapter and
replace Turnstile and the Admin API with in-process fakes.
