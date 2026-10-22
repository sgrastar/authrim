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
it) under the current key of the **tombstone keyring** (`TOMBSTONE_HMAC_KEYRING`), which is kept
apart from the lookup directory's keys.

- It answers "was this address deleted?" only by being made again from an address someone
  presents. Read on its own, the column does not give the address back; without the key, a
  dictionary of likely addresses cannot be turned into fingerprints either. The guarantee rests
  on the keyring staying in Worker secrets, never in a database or a backup next to the records.
- It is made under its own label (`tombstone_email`) and its own keys, so it never equals the
  lookup directory's email index of the same address: the PII stores and the lookup database
  cannot be joined on it. Lookup key rotations do not touch it.
- It carries the key generation it was made with; every generation in the keyring is tried when
  searching.

### The tombstone keyring

`TOMBSTONE_HMAC_KEYRING` is a Worker secret (file `tombstone_hmac_keyring.json` in the keys
directory) given to ar-auth, ar-management, ar-bridge and ar-saml:

```json
{ "current": 1, "keys": { "1": "<32-byte base64url>" } }
```

- **New and existing installs.** `setup init` writes it with the other keys. An install from
  before it gets it on its next `setup update` or `setup deploy` (`ensureSupplementalKeyFiles`
  creates a missing file, keeps an existing one, and refuses a malformed one), which also uploads
  it. Nothing has to be done by hand. `scripts/setup-keys.sh` writes it too.
- **Rotating** (rare; only if the key may have been exposed). Keys are added, never replaced in
  place, and it takes two deploys so that no Worker is asked about a generation it cannot read:
  1. add the new generation to `keys`, leaving `current` as it is; deploy;
  2. set `current` to the new generation; deploy.
- **Retiring a key.** Remove a generation only once every record made with it is past its
  `retention_until` (at most the longest tombstone retention, 3650 days, after it stopped being
  current). Until then it must stay in the keyring, or those records are no longer found.
- Without a usable keyring, deletions are refused (and can be retried), the address check
  answers a server error, and sign-up with blocking on is not let through.

The fingerprint is computed before the deletion changes anything. If the keyring cannot be read
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
retention. It does not say which account it was. Each check is written to the audit log
before the answer is given (`tombstone.email_checked`: the administrator, the time, and whether
a record was found; never the address). The action is delivered fail-closed: a check that
cannot be recorded is not answered.

### Blocking re-registration

`account-lifecycle.deletion.block_reregistration` (tenant setting; environment default
`ACCOUNT_TOMBSTONE_BLOCK_REREGISTRATION`; built-in default `false`). When on, a new account
whose email has a deletion record within its retention, or a change to such an address, is
refused on:

| Path                                                                      | Refused as                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Passkey sign-up (`/api/auth/passkeys`)                                    | An address that has an account (409)                          |
| Direct-auth passkey sign-up                                               | An address that has an account (409)                          |
| Email code / direct-auth email code                                       | The usual "code sent" reply; nothing is sent                  |
| TOTP sign-up (start and activation)                                       | An address that has an account (409)                          |
| External IdP / social JIT                                                 | A policy denial (`policy_access_denied`)                      |
| SAML JIT                                                                  | Sign-up turned off for the IdP (403)                          |
| Admin create (`POST /api/admin/users`)                                    | The address conflict (409)                                    |
| Guest upgrade with email (complete)                                       | `identity_already_registered` (409), as for an address in use |
| Own email change or addition (complete, after the code to it is verified) | `Email address is already in use` (409)                       |
| Admin retry-PII setting another address                                   | The update conflict (409)                                     |

Not covered: SCIM create and update and user import (a directory that re-provisions a deleted
person is the directory's decision), and accounts without an email (passkey-only, guest, DID).
The administrator's user update does not change an address.

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

### Lookup key rotations

Separately from the tombstone keyring, Control keeps a lookup key rotation in dual-write for at
least 120 seconds after activating it (`LOOKUP_HMAC_DUAL_WRITE_MIN_SECONDS`: a Worker may hold the
key state from before the activation for 30 seconds after reading it from KV, whose copies can
lag by up to a minute). `setup lookup-hmac-rotate` waits that long before leaving dual-write and
asks again while Control answers `CONTROL_PLANE_LOOKUP_HMAC_DUAL_WRITE_DWELL_INCOMPLETE`.

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
