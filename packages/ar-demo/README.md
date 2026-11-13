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
logs. Rows that end `failed` keep counting toward capacity until a cleanup removes their tenant
(the cleanup is not part of this package yet; rows are only marked, never deleted here).

## Configuration

`wrangler.jsonc` vars (validated together by `loadConfig`; an invalid configuration answers 503):

| Name                        | Meaning                                                                                                                                  | Default / range       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `ADMIN_API_ORIGIN`          | Origin of the Authrim API (token endpoint and Admin API). Must equal the issuer origin the token endpoint expects as assertion audience. | https, no path        |
| `CONSOLE_ORIGIN`            | Origin of the admin console. The join link must be on it.                                                                                | https, no path        |
| `PORTAL_ORIGIN`             | Origin of this portal.                                                                                                                   | https, no path        |
| `TURNSTILE_SITE_KEY`        | Public Turnstile key.                                                                                                                    |                       |
| `MAX_ACTIVE_TENANTS`        | Rows not `deleted`.                                                                                                                      | 50, clamped to 1..500 |
| `MAX_STARTS_PER_IP_PER_DAY` | Rows per address hash in 24 hours.                                                                                                       | 3, clamped to 1..20   |
| `TENANT_TTL_HOURS`          | `expires_at` of a row; also shown on the start page.                                                                                     | 12, clamped to 1..24  |
| `ENVIRONMENT`               | `development` allows loopback http origins and a missing client address.                                                                 |                       |

Secrets (`wrangler secret put`): `TURNSTILE_SECRET_KEY`, `MACHINE_CLIENT_ID`, `MACHINE_KEY_ID`,
`MACHINE_PRIVATE_JWK` (the private ES256 key as JSON; other key types are refused), `IP_HASH_SECRET`
(at least 16 characters).

## Manual operator steps

1. **Machine principal.** In the Authrim environment, create a _global_ machine principal and an
   ES256 credential (key id = `MACHINE_KEY_ID`, client id = `MACHINE_CLIENT_ID`). Give it exactly
   these permissions by exact name (no wildcard carries the last one):
   `admin:tenants:provision`, `admin:admin_users:read`, `admin:admin_users:write`,
   `admin:admin_roles:write`, `admin:admin_invitations:code_handoff`. The portal checks that the
   granted scope of every token contains all five and refuses to run otherwise.
2. **Code hand-off.** Switch on the platform setting `admin_invitations.code_handoff_enabled`
   (default off; a human with a step-up does this in the admin console).
3. **Database.** Create the portal's own D1 database, put its id into `wrangler.jsonc`, and apply
   the migration: `wrangler d1 migrations apply ar-demo-registry --remote` (from this directory).
4. **Turnstile.** Create a Turnstile widget for the portal's hostname.
5. **Secrets and vars.** Set the secrets and replace the placeholder vars.
6. **Deploy.** `wrangler deploy` from this directory, then route the portal's hostname to it.

## Operational notes

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
