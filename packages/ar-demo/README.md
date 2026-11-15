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
   the per-IP limit and the capacity together. It then answers `303 /wait` with the cookie
   `__Host-demo_ticket` (HttpOnly, 30 min) at once. It makes **no call to the Admin API**: the row is
   only queued.
3. `GET /wait` is the gate page (see "Pages"). Its script, `/assets/wait.js`, sends an independent
   `GET /status` every 2 seconds without waiting for the previous answer (the request that carries
   the creation can take 16 s or more, the others answer at once) and gives up after 360 s, which
   covers a lost creation attempt (120 s lease) plus the 90 s call.
4. `GET /status` looks the row up by the SHA-256 of the ticket and drives the whole creation:
   - **Create.** The core answers `POST /api/admin/tenants` (202) only after it has finished the
     deferred work of that request (about 16 s), so the call is made here, while the visitor is on
     the waiting page. A queued row is claimed by ONE guarded `UPDATE` (`claimCreate`); only the
     request that wins it calls `createTenant` (90 s timeout, idempotent by tenant id through
     `Idempotency-Key`) and then records `create_accepted_at`. Every other `/status` request for the
     row answers immediately with `stage: "provisioning"` and does not wait for it. A non-202 answer
     marks the row `failed`. A call that ended without any answer (timeout, broken connection)
     leaves the row alone.
   - **Dead claim.** If the claimant dies (tab closed, Worker cancelled) or its call timed out, the
     row has `create_started_at` set but no `create_accepted_at`. After a 120 s lease (longer than
     the 90 s call timeout) the next `/status` re-claims it and repeats the SAME call with the same
     tenant id and idempotency key. Repeating is safe because the core creates a tenant at most once
     per `Idempotency-Key`: a second call after a first one that did succeed returns that outcome
     instead of making another tenant. At most 2 attempts are made; when the second lease has run
     out without an acceptance the row is marked `failed` (`create_exhausted`).
   - **Provision.** Once accepted, the Admin API is asked about the provisioning at most once per
     2 seconds and row. When it has succeeded, exactly one request claims the hand-off
     (`provisioning` to `inviting`), creates the admin invitation with `code_delivery: "response"`
     and returns the join link. The code is returned once and is never stored or logged.

`GET /status` answers JSON (`Cache-Control: no-store`):

| Situation                                       | Body                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| creation queued, in flight or tenant being made | `{"state":"provisioning","stage":"provisioning"}`                                                                         |
| tenant exists, invitation being prepared        | `{"state":"provisioning","stage":"inviting"}` (only a poll that arrives while another request holds the hand-off sees it) |
| ready (cookie cleared)                          | `{"state":"ready","stage":"ready","join":"<console>/admin/join#code=...&email=...","join_expires_in":900}`                |
| already handed over                             | `{"state":"handed_off"}`                                                                                                  |
| failed, expired, being deleted                  | `{"state":"failed"}`                                                                                                      |
| no or unknown cookie                            | `404 {"error":"not_found"}`                                                                                               |

`state` keeps the values the first wait script understands; `stage` is added for the real stages
(a script that ignores it keeps working). `join_expires_in` is the number of seconds the join link
stays usable: the core's `expires_at` of the invitation (epoch milliseconds, in the 201 answer) minus
now; without a usable value (missing, in the past, or more than the core's 60 minute maximum) the
15 minutes the portal asked for with `expires_in_minutes`.

### Registry states

| State          | Meaning                                                                                                                                                                                                                                                                                               | Moved there by                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `provisioning` | Row exists. Sub-situations, told apart by two columns: **queued** (`create_started_at` and `create_accepted_at` empty: no tenant exists), **creating** (`create_started_at` set, no acceptance: tenant may exist, call in flight or lost), **provisioning** (`create_accepted_at` set: core accepted) | `POST /start` (the single INSERT)                             |
| `inviting`     | Provisioning succeeded; one request holds the hand-off                                                                                                                                                                                                                                                | `/status`: `provisioning` to `inviting`, one guarded `UPDATE` |
| `handed_off`   | The join link was returned                                                                                                                                                                                                                                                                            | `/status`: `inviting` to `handed_off`                         |
| `failed`       | Refused, blocked, expired or exhausted; waits for the cleanup                                                                                                                                                                                                                                         | `/status` or the ticket lifetime check                        |
| `deleting`     | The cleanup claimed the row                                                                                                                                                                                                                                                                           | cleanup: guarded `UPDATE` from the state it read              |
| `deleted`      | The tenant is gone (or never was the portal's); the row only serves the 24 h per-IP count                                                                                                                                                                                                             | cleanup                                                       |

Only hashes are stored: the ticket as SHA-256, the client address as an HMAC-SHA-256 keyed with
`IP_HASH_SECRET`. Raw addresses, tickets, tokens and codes are never written to the database or the
logs. A registry row alone never authorises a write to the Admin API. The row records when the core
accepted the creation (`create_accepted_at`); the cleanup deletes a tenant only when that is set, or
when the tenant still carries the portal's exact name and description. Otherwise (for example the
core refused the creation because the id belongs to someone else) the row is released as `deleted`,
no write call is made and `cleanup_not_ours` is logged. A row without that record is never polled about its provisioning by
`/status`: it is only created or re-claimed as described above. Rows that end `failed` keep counting toward capacity until the cleanup (below) removes
their tenant.

## Configuration

`wrangler.jsonc` vars (validated together by `loadConfig`; an invalid configuration answers 503):

| Name                        | Meaning                                                                                                                                  | Default / range  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `ADMIN_API_ORIGIN`          | Origin of the Authrim API (token endpoint and Admin API). Must equal the issuer origin the token endpoint expects as assertion audience. | https, no path   |
| `CONSOLE_ORIGIN`            | Origin of the admin console. The join link must be on it.                                                                                | https, no path   |
| `PORTAL_ORIGIN`             | Origin of this portal.                                                                                                                   | https, no path   |
| `TURNSTILE_SITE_KEY`        | Public Turnstile key.                                                                                                                    |                  |
| `MAX_ACTIVE_TENANTS`        | Rows not `deleted`.                                                                                                                      | 75, range 1..500 |
| `MAX_STARTS_PER_IP_PER_DAY` | Rows per address hash in 24 hours.                                                                                                       | 3, range 1..1000 |
| `TENANT_TTL_HOURS`          | `expires_at` of a row; also shown on the start page.                                                                                     | 24, range 1..24  |
| `ENVIRONMENT`               | `development` allows loopback http origins and a missing client address.                                                                 |                  |

Values of `MAX_ACTIVE_TENANTS`, `MAX_STARTS_PER_IP_PER_DAY` and `TENANT_TTL_HOURS` outside their
range are not rejected: they are clamped to the nearest limit (for example, 5000 starts per address
becomes 1000). A value that is not an integer makes the portal refuse to run (HTTP 503).

Secrets (`wrangler secret put`): `TURNSTILE_SECRET_KEY`, `MACHINE_CLIENT_ID`, `MACHINE_KEY_ID`,
`MACHINE_PRIVATE_JWK` (the private ES256 key as JSON; other key types are refused), `IP_HASH_SECRET`
(at least 16 characters).

## Service binding to the Authrim router

When the portal Worker and the Authrim router Worker are in the same Cloudflare zone and the router
is bound to the tenant hostnames by zone routes (a wildcard such as `*.<base-domain>/*`), a plain
`fetch()` from the portal to a hostname of its own zone does not run the router's route. It goes to
the DNS origin of that hostname and the portal gets HTTP 522. Add an optional service binding to the
router and the portal sends every Authrim API request (token endpoint and Admin API, including the
cleanup cron's calls) through it:

```jsonc
"services": [{ "binding": "AUTHRIM_API", "service": "<env>-ar-router" }]
```

The request keeps the same absolute URL, so the router still resolves the tenant from the host and
the client assertion's `aud` stays the token endpoint URL. Without the binding the portal uses a
plain `fetch()`. Turnstile verification never uses the binding, and the binding only accepts URLs
whose origin equals `ADMIN_API_ORIGIN`.

In a multi-tenant deployment without a naked domain, `ADMIN_API_ORIGIN` must be the tenant issuer
host (for example `https://<tenant>.<base-domain>`): the token endpoint lives on the tenant host and
the bare base domain answers "Tenant not found".

## Pages

The photographic scene (a far view of a mountain causeway with a gatehouse at its end) fills the whole
viewport on every page; there is no side panel. The text sits in one translucent dark window over it
(`rgba(8,12,18,.78)` with a fine gold border and `backdrop-filter: blur` where supported). The wording
is plain product language: the gate is only a visual metaphor and no text mentions it. Four languages,
a language switcher in the window.

| Page            | Route   | What it is                                                                                                                                                                            |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start           | `/`     | Centred window: heading, a two-sentence introduction, the three notices (demo environment, no real data, automatic deletion after the configured hours), Turnstile (dark), one button |
| Gate            | `/wait` | Small window at the top (heading and one `role="status"` line, "skip the animation" once ready); the scene shows the progress; the button on the door opens the admin console         |
| Error / refusal | any     | Centred window over the dark scene: one sentence and a link back                                                                                                                      |

The scene keeps the measured cover fit, except on tall screens (aspect below 4:5), where the far view
is never magnified beyond 53 % visible width, so the fires stay in view and its top and bottom edges
fade out; at the door the near view always covers the screen. Typefaces are system serif stacks only
(Trajan Pro, Cinzel, Palatino and similar for Latin headings; Hiragino Mincho and Yu Mincho for
Japanese; Geeza Pro and Noto Naskh Arabic for Arabic); capitals with wide letter-spacing only for
en/de (set per `lang`). Japanese breaks only at hand-marked phrase boundaries (a zero width space, written `|` in `src/i18n.ts`) with `word-break: keep-all`, `overflow-wrap: anywhere` and `line-break: strict` (works in every browser, unlike `auto-phrase`); headings
and status lines use `text-wrap: balance`, paragraphs `text-wrap: pretty`. One gold focus ring for
the whole site.

The gate follows the server's real stages (`provisioning`, `inviting`, `ready` from `/status`). A
stage sequence is always played in full and in order, so the picture may lag the real state but never
runs ahead of it; the status text follows the real state at once; the door button appears only after a
real `ready`. After `ready` a "skip the animation" control moves straight to the door. The press
deadline is `join_expires_in - 30` seconds (at most 300) counted from the moment `ready` was received;
below 90 s the sequences are skipped automatically. On the gate page the language links are hidden
while a run is in progress (a reload would lose the one-time join link); the script shows them only
after an end state without a usable link (failed, lost, handed off, timeout, deadline expired).
Without JavaScript they are offered inside `<noscript>`.

Degradation, each step working on its own: full (canvas 2D, fires lit one by one through feathered
masks, flame flipbook, camera moves) -> `prefers-reduced-motion` (no travel, states switch at once)
-> no canvas or failed composition images (four stacked photographs switched by `data-station`) ->
text only (the texts, the door button and the retry link never depend on an image).

The decision logic is in `src/gate-logic.ts` as plain JavaScript source that is shipped unchanged
and unit-tested (`src/__tests__/gate-logic.test.ts`). The canvas renderer is `src/gate-render.ts`,
the DOM code `src/gate-ui.ts`, the stylesheet `src/site-css.ts`, the geometry `src/gate-geometry.ts`
(measured on the finished photographs).

## Languages

Exactly the languages of the admin console (`ar-admin-console/src/lib/i18n/locales.ts`), in its order:
Japanese, English, German and Arabic (right-to-left: `dir="rtl"` on `<html>`, logical CSS for the
window; the scene and the door button are never mirrored). The texts are one typed table
(`src/i18n.ts`; a missing key fails the typecheck). The language is chosen in this order: a valid
`?lang=` (remembered in the cookie `demo_lang`, which only ever holds an allowlisted code), the
cookie, `Accept-Language`, English; any other value (for example an old `fr` cookie) is ignored like
any invalid one. HTML responses carry `Vary: Accept-Language, Cookie` and stay `no-store`.

In-progress status lines are written without a final full stop; the page appends three animated dots
(a separate `aria-hidden` element animated in CSS, width reserved, three static dots with reduced
motion), so the live-region text is announced once. The product wording is "demo environment"
throughout.

## Static assets

The photographs live in `public/assets/gate/` and are served by Workers Static Assets
(`"assets": { "directory": "./public" }` in `wrangler.jsonc`): a request that matches a file there is
answered by the platform before the Worker runs, every other path (including `/assets/site.css` and
`/assets/wait.js`, which are generated by the Worker) reaches the Worker. Keep `public/` free of
files that would shadow a Worker route (a test checks it). The file names carry a content hash, and
`public/robots.txt` asks crawlers to stay away from the whole portal (the pages also carry
`noindex`). `public/_headers` gives the photographs `Cache-Control: public, max-age=31536000, immutable`; the HTML stays
`no-store`. The static files do not pass through the Worker, so they do not carry the page's
security headers (they are images only).

The images are original, generated photographs (no existing artwork). Only what the pages use is
shipped: far and near view in dark and lit versions (AVIF and WebP, two sizes each), the two door
leaves, the passage behind the door, the seal and the flame flipbook. The hashed names and the
measured geometry are generated into `src/gate-assets.ts` and `src/gate-geometry.ts`
(`scripts/sync-gate-assets.ts`); the pages and the script read only those two modules.

## Preview

`pnpm exec tsx scripts/preview.ts` writes a static copy of every page in every language into
`preview/` (git-ignored) together with a fake `/status` (`preview/preview-shim.js`, loaded only by
the preview files). Serve it with any static server, for example
`python3 -m http.server 8811 --directory preview`, and open `/`. The index lists scenarios: normal run,
instant ready, real timing (a 16 s creation request), slow, failure, early failure, deadline expiry,
reduced motion, image-only (`&canvas=off`), 404, handed off and server errors.

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
   the migrations (`0001` to `0003`): `wrangler d1 migrations apply ar-demo-registry --remote` (from this directory).
   **Migration `0003` must be applied before the Worker version that uses it is deployed.**
4. **Turnstile.** Create a Turnstile widget for the portal's hostname.
5. **Secrets and vars.** Set the secrets and replace the placeholder vars.
6. **Deploy.** `wrangler deploy` from this directory, then route the portal's hostname to it.

   If the portal's hostname is in the same zone as an Authrim deployment whose router owns a
   wildcard route (`*.<base-domain>/*`), a custom domain is not enough: the wildcard route is
   matched first. Bind the portal with a zone route for its exact host instead, which is more
   specific and wins:
   `{ "pattern": "<portal-host>/*", "zone_name": "<zone>" }` (for example
   `start.example.invalid/*` in zone `example.invalid`).

## Cleanup

A cron trigger (`*/10 * * * *`) runs `src/cleanup.ts`. Each run does a bounded amount of work (at
most 10 rows per phase, oldest first):

1. Rows that are expired, `failed` for 5 minutes, or still `provisioning`/`inviting` 32 minutes after
   creation (30 minutes of ticket life plus a 2 minute margin for an in-flight creation or hand-off)
   are claimed by a guarded move to `deleting`. This covers the creation states without change:
   a **queued** row never reached the core, so the lookup answers 404 and it is simply released
   as `deleted` (no write); a row whose creation was **in flight or lost** has no acceptance record,
   so a tenant that exists is touched only if it carries the portal's exact name and description,
   otherwise it is released as not ours. A row that never started counts toward capacity and the
   per-address limit until then, like every row that is not `deleted`. No creation can start after
   the 30 minute ticket life, and a call lasts at most 90 s, so no creation outlives the 32 minutes.
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

- **Start** answers at once. **Creation** is the first `/status` request (about 16 s measured, up to
  about a minute: the core's provisioning job starts on its next one-minute tick); the invitation
  adds about 3 s. A dead creation call is repeated after 120 s, twice at most (then `failed`). A shared pool that has not served a tenant yet is slower the first time, so
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

Apply migrations `0002` and `0003` before the portal creates its first tenant (`0003` must be applied before the Worker version that uses it is deployed: it only adds two columns, `create_started_at` and `create_attempts`, and rewrites no table). Migration `0002` records the acceptance for
rows that already reached the invitation step. Rows that were still `provisioning`, `failed` or
`deleting` when it is applied have no acceptance record, so the cleanup treats them by the
name-and-description rule above. Migration `0003` treats a `provisioning` row without acceptance as one attempt already made (it is repeated at most once more, idempotently).

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
