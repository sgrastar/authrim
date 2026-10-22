# Deleted accounts and PII read records

Two kinds of record about personal data live on the PII side (the tenant's PII stores, next to
the data they are about), apart from the ordinary audit log:

- **Deletion records** (`users_pii_tombstone`): one per deleted account, or per account whose
  personal data was erased.
- **PII read records** (`audit_log_pii`): one per user whose personal fields an admin response
  returned.

Neither holds a personal value.

## Deletion records

Every deletion path writes one: admin delete (`DELETE /api/admin/users/:id`), anonymize
(`POST /api/admin/users/:id/anonymize`), PII erasure (`DELETE /api/admin/users/:id/pii`) and
SCIM delete (`DELETE /scim/v2/Users/:id`). A record keeps:

| Column              | Content                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `id`                | The deleted user's id                                                  |
| `deleted_at`        | When (ms)                                                              |
| `deleted_by`        | Who (`admin`, the administrator's id, `scim_api`)                      |
| `deletion_reason`   | Why (the request's reason code)                                        |
| `retention_until`   | Until when the record is kept (ms)                                     |
| `email_blind_index` | A keyed fingerprint of the account's email, or `NULL` when it had none |
| `deletion_metadata` | The path that wrote it; for anonymize, a hash of the user id           |

### The email fingerprint

`email_blind_index` is `tombstone_email:v<normalization>:g<key generation>:<hex>`: the
HMAC-SHA256 of the normalized address (trimmed, lower case, as the lookup directory normalizes
it) under the environment's current lookup HMAC key (`LOOKUP_HMAC_KEY_SLOT_A/B`, see
[Lookup key distribution](lookup-key-distribution.md)).

- It answers "was this address deleted?" only by being made again from an address someone
  presents. Read on its own, the column does not give the address back; without the key, a
  dictionary of likely addresses cannot be turned into fingerprints either. The guarantee rests
  on the key staying in Worker secrets, never in a database or a backup next to the records.
- It is made under its own label (`tombstone_email`), so it never equals the lookup directory's
  email index of the same address: the PII stores and the lookup database cannot be joined on it.
- It carries the key generation it was made with, and is made with a key every Worker reads: the
  current key, or the previous one while a rotation writes with both (a Worker may still hold
  the state from before the rotation for up to 30 seconds and read only the previous key).
- Every key generation still read is tried when searching, so a rotation does not hide records
  while the previous key is read. **Known limit:** Control stops reading the previous key 7 days
  after a rotation is verified (`grace`, then `stable`). From then on, records made with it are
  no longer found (the address is gone, so they cannot be re-keyed): the re-registration block
  and the address check stop covering them, though the records stay until their
  `retention_until`. Until this is addressed, rotate the lookup key only when that gap is
  acceptable, or after the records made with the old key have expired.
- **Known limit:** Control can leave the dual-write phase before every Worker's cached key state
  (30 seconds) has caught up. A deletion written with the new key in that window can be missed
  by a Worker still holding the state from before the rotation, for at most that cache lifetime.
  The lookup directory's own reservations share this timing.

The fingerprint is computed before the deletion changes anything. If the keys cannot be loaded
the deletion is refused (and can be retried); it never writes a record without the fingerprint
when the account had an email.

The record with the user's id always describes the user's latest deletion. A retried deletion,
or a later deletion with the same address, refreshes it without shortening its retention. A
later deletion with another address (its PII was erased, it was given a new email, then it was
deleted) moves the earlier address to a record of its own (`<user id>#<…>`, keeping its
deadline), so both addresses stay covered.

### Retention

`account-lifecycle.deletion.tombstone_retention_days` (tenant setting; environment default
`ACCOUNT_TOMBSTONE_RETENTION_DAYS`; built-in default 90; 1 to 3650). It applies to records made
from then on; each record keeps the `retention_until` it was made with. PII erasure
(`DELETE /api/admin/users/:id/pii`) may ask for its own period with `retention_days` (1 to
3650, otherwise 400). The `user_tombstone_retention` maintenance task deletes records past
their `retention_until`; the data retention API reports the setting for the
`user_tombstones` category.

### "Was this address deleted?"

`POST /api/admin/tombstones/email-check` with `{ "email": "..." }` (in the body, never the URL;
permission `users:read`) answers `{ "deleted": false }` or
`{ "deleted": true, "deleted_at": "...", "retention_until": "..." }` for a record within its
retention. It does not say which account it was. Each check is written to the admin audit log
(`tombstone.email_checked`, with the answer, without the address).

### Blocking re-registration

`account-lifecycle.deletion.block_reregistration` (tenant setting; environment default
`ACCOUNT_TOMBSTONE_BLOCK_REREGISTRATION`; built-in default `false`). When on, a new account
whose email has a deletion record within its retention is refused on:

| Path                                   | Refused as                                   |
| -------------------------------------- | -------------------------------------------- |
| Passkey sign-up (`/api/auth/passkeys`) | An address that has an account (409)         |
| Direct-auth passkey sign-up            | An address that has an account (409)         |
| Email code / direct-auth email code    | The usual "code sent" reply; nothing is sent |
| TOTP sign-up (start and activation)    | An address that has an account (409)         |
| External IdP / social JIT              | A policy denial (`policy_access_denied`)     |
| SAML JIT                               | Sign-up turned off for the IdP (403)         |
| Admin create (`POST /api/admin/users`) | The address conflict (409)                   |

No reply says the address was deleted, and no audit entry written for the refusal carries the
address or its hash. On the paths that answer 409, a blocked address goes through the same address
lookups as any other before it is refused (a lookup that fails on a route cached from before the
deletion is passed over for it).

**Known limit (not specific to the block):** for up to 10 minutes after a deletion, a lookup
route cached from before it makes sign-up with that address fail (a server error) on the paths
that look the address up first, including the email code and SAML JIT paths. This happens with
the block off too; it belongs to the account route resolver.

The check searches every PII store of the tenant (as the tombstone admin API does). With the
block off it costs one settings read and searches nothing. With it on, a check that cannot be
made (the settings, keys or stores cannot be read) does not create the account: admin create
answers 503, the email code paths give the usual reply, and the other paths a server error.

Turning the block on applies at once to every record still within its retention, including
records made while it was off: the fingerprint is always written.

## PII read records

Admin responses that return personal fields record, after the response is sent, one row per
user returned:

| Operation             | Fields considered                                                     |
| --------------------- | --------------------------------------------------------------------- |
| `admin.users.list`    | email, name and profile fields, phone, address (as returned per user) |
| `admin.users.get`     | the same                                                              |
| `admin.sessions.list` | `user_email`, `user_name`, `ip_address`, `user_agent`                 |
| `admin.sessions.get`  | `user_email`, `user_name`                                             |

A row (`action = 'pii_accessed'`) keeps the actor (`user_id`: the administrator or machine
actor), the tenant, the user (`target_user_id`), and in `details` the names of the fields that
had a value, the operation, the request id and the actor type. `ip_address` and `user_agent`
are left empty. It is written in the PII store the user's data was read from (for a routed
account, its own shard), batched per store.

Writes happen after the response (`waitUntil`) and do not delay it. A write that fails is logged
(without PII) and the response stands: a read is not refused because its record could not be
written.

Records are kept for the tenant's audit PII retention (the `audit_pii` category of the data
retention API) and deleted by the `audit_retention` maintenance task, in every PII store of the
tenant.

Not yet recorded: the create and update responses (they return the user just written),
guest-user, consent, support-context and compliance listings, and bulk exports (tenant backup,
logging exports). A view of users for investigations that shows state without personal fields
is a separate design.
