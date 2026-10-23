# Failed sign-in attempt records

Authrim records failed sign-in attempts so that an operator can find out why a person cannot sign
in, without reading their personal data. The records are read by the status-only investigation
read (`GET /api/admin/investigations/subjects/{handle}/status`, its `recent_attempts`).

## What is recorded

- A failed attempt is recorded in the tenant's Core `flow_audit_events`, with the Flow interaction
  it belongs to (event `flow.sign_in_attempt.failed`). Attempts made outside a Flow interaction
  (direct API sign-in, IdP-initiated SAML, re-authentication pages) are not recorded; the read
  says so with `coverage: "flow_interactions"`.
- Recorded today: passkey, TOTP and email code sign-ins started from the Login UI within a Flow.
- A record holds the method, a reason from a closed vocabulary (never error text), the Flow node
  (kept with the record, never returned by the read: node IDs are chosen by a Flow's author), the
  time and a random inquiry number unique in the tenant. It holds no user ID, IP address or
  user agent. Once the attempt knows the account, the record carries the account's **subject
  hash** instead: an HMAC of the tenant and the account under the investigation keyring.
- The interaction is named by the Login UI at the start step (`X-Authrim-Interaction-Id`, or the
  email code's `runtime_interaction_id`). It is kept with the challenge only after the server has
  checked it is a live (not completed, not expired) interaction of the tenant; the client is not
  compared, since the Login UI signs in as its own client for any relying party's interaction.
  Interaction IDs are random and unguessable. The verify step uses only that stored value.
- Recording runs after the response and never fails a sign-in.
- Retention follows the other log tables: rows older than the D1 retention window move to R2
  (`log_row_archive`). The investigation read looks at D1 only.

## The investigation keyring

`INVESTIGATION_SUBJECT_HMAC_KEYRING` is a Worker secret (file
`investigation_subject_hmac_keyring.json` in the keys directory) given to ar-auth, ar-management,
ar-bridge and ar-saml. It has the tombstone keyring's shape:

```json
{ "current": 1, "keys": { "1": "<32-byte base64url>" } }
```

- **New and existing installs.** `setup init` writes it with the other keys. An install from
  before it gets it on its next `setup update` or `setup deploy` (`ensureSupplementalKeyFiles`
  creates a missing file, keeps an existing one, and refuses a malformed one), which also uploads
  it. `scripts/setup-keys.sh` writes it too.
- **Without it** attempts are still recorded, without the subject hash, and the investigation
  read reports `recent_attempts` as `{ "available": false, "reason": "key_unavailable" }`.
- **Rotating** (only if the key may have been exposed). Keys are added, never replaced in place,
  and it takes two deploys so that no Worker is asked about a generation it cannot read:
  1. add the new generation to `keys`, leaving `current` as it is; deploy;
  2. set `current` to the new generation; deploy.
- **Retiring a key.** Every generation in the keyring is tried when the read looks for an
  account's attempts. Remove a generation once the D1 retention window has passed since it stopped
  being current; until then, attempts made with it are still found only through it.
