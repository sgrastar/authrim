# Failed sign-in attempt records

Authrim records failed sign-in attempts so that an operator can find out why a person cannot sign
in, without reading their personal data. The records are read by the status-only investigation
read (`GET /api/admin/investigations/subjects/{handle}/status`, its `recent_attempts`).

## What is recorded

- A failed attempt is recorded in the tenant's Core `flow_audit_events`, with the Flow interaction
  it belongs to (event `flow.sign_in_attempt.failed`). Attempts made outside a Flow interaction
  (direct API sign-in, IdP-initiated SAML, re-authentication pages) are not recorded; the read
  says so with `coverage: "flow_interactions"`.
- Recorded today: passkey, TOTP, email code and directory password sign-ins, and sign-ins at an
  external OpenID Connect/OAuth provider or a SAML IdP, started from the Login UI within a Flow.
  A failure before the attempt could be tied to its interaction (an unknown state, a SAML Response
  whose signature fails before its request is found, an IdP-initiated SAML Response) is not
  recorded.
- A record holds the method, a reason from a closed vocabulary (never error text), the Flow node
  (kept with the record, never returned by the read: node IDs are chosen by a Flow's author), the
  time and a random inquiry number unique in the tenant. It holds no user ID, IP address or
  user agent. Once the attempt knows the account, the record carries the account's **subject
  hash** instead: an HMAC of the tenant and the account under the investigation keyring.
- The interaction is named by the Login UI at the start step: the `X-Authrim-Interaction-Id`
  header (passkey, TOTP, directory password), the email code's `runtime_interaction_id`, or a
  `runtime_interaction_id` query parameter of the external provider or SAML start (kept with its
  state or request). It is kept with the challenge only after the server has
  checked it is a live (not completed, not expired) interaction of the tenant; the client is not
  compared, since the Login UI signs in as its own client for any relying party's interaction.
  Interaction IDs are random and unguessable. The verify step uses only that stored value.
- Recording runs after the response and never fails a sign-in.
- Retention follows the existing log-table policy. D1-to-R2 movement remains disabled when its
  configured period is zero; when enabled, older rows may move through `log_row_archive`. The
  investigation read looks at D1 only.

## Delivery and duplicate suppression

External-provider callbacks and verified provisioning status/resume requests reuse the persisted,
validated authentication-state ID. SP-initiated SAML callbacks reuse the consumed request ID.
For these requests, a versioned SHA-256 event ID binds that server-side ID to the tenant,
interaction and method. A repeated insert conflicts only on that event ID and returns the
existing inquiry number; it does not store the source ID, token, assertion or subject. Directory
password submissions remain separate attempts; their per-request recorder emits at most once.

This is best-effort recording with duplicate suppression. It is not exactly-once delivery.
In particular, a crash or recording database failure after a state/challenge has been consumed can
leave no record, and the consumed proof cannot be replayed to repair it. Missing or malformed
investigation keyrings remove the optional subject hash without changing the sign-in response.
Unknown states, invalid browser bindings, consumed continuations, pending provisioning and SAML
responses without a validated SP request do not acquire a new attempt context. A concurrent
resume that loses challenge consumption is treated the same way as a replay.

## The investigation keyring

`INVESTIGATION_SUBJECT_HMAC_KEYRING` is a Worker secret (file
`investigation_subject_hmac_keyring.json` in the keys directory) given only to the Workers that
record attempts (ar-auth, ar-bridge, ar-saml) and ar-management, which reads them. It has the tombstone keyring's shape:

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
