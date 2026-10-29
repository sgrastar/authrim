# Lookup directory: known limits of identifier reservations

The account lookup directory resolves a blind-indexed identifier (an external subject
such as a DID, a passkey credential, or an email address) to an account. One row of
`lookup_identifier_reservations` is the only claim on an identifier: it records the
account, the operation that holds it, its state, and when it was acquired
(`created_at`). It does not record which **link** (the `linked_identities` row, passkey,
or email value in the authoritative database) it belongs to. This page describes what
that costs, how to find the leftovers, how to repair them, and when to close the gap.

Login is not weakened by any of this. Login resolves an identifier through the
directory and then **always** confirms the link in the authoritative database
(`linked_identities` and the other authorities); a stale directory row can only make a
login fail, never let someone into another account. The cost is availability:
a person cannot sign in with an identifier, or an identifier cannot be linked again.

Reservation states (`reservation_state`): `reserved` (held under a lease), `committed`
(published), `releasing`, `released` (free), `repair_required`. A new add takes a row over
only when it is `released` (by an operation other than the one that released it) or
`reserved` with an expired lease. A row in any other state is never taken over by code; a
stuck one is repaired by an operator (below).

## Known limits and their symptoms

Two symptoms cover all of them:

- Linking the identifier again fails with `directory_identifier_reservation_conflict`.
- Signing in with the identifier fails with `identity_not_linked` although the link
  exists in the authoritative database (the route is disabled or missing).

### 1. HMAC reindex racing with an unlink (closed, one leftover)

An HMAC key rotation reindexes every link into the new key generation. If a user unlinks
an identifier while the reindex is between reading the link and writing its new-generation
row, the reindex used to stamp the new reservation with the time of the reindex, so the
removal (which only releases what existed when it was prepared) took it for a later add and
left it. The reindex then found the link gone and set the row to `releasing`, which nothing
advances. The identifier could not be linked again.

Now: the reindex gives the new reservation the `created_at` of the source-generation
reservation, and when it finds the link gone it sets the row it created to `released`
(only a row whose `operation_id` is its own `hmac-reindex:<operation>`; a reservation held
by another operation is left alone, and so is its route). One exception: when the address
that disappeared is an email address with an unfinished email replacement (in the tenant PII
database, `identity_identifier_replacement_operations` not `completed`/`canceled`, with the
address's digest in `identity_identifier_replacement_projections` as the `old` side), the
reindex touches neither the reservation nor the route. The replacement moves that reservation
to `releasing` itself and releases it, and verifies the release by account, when it
completes; releasing it earlier would let another account take the address and leave the
replacement in `blocked_forward_repair`.

The reindex also writes (or re-activates) a route only while the reservation is still
`committed`, checked in the same batch as the write: a reservation released between the
check and the write (by a removal, or by the replacement's completion) leaves no route behind.

Closed retry gap: if a batch checkpoint fails, a retry can read a source row just before
its unlink releases the source or candidate reservation. The reindex now rechecks that
exact link in the primary authority after a source-reservation or candidate-reservation
conflict. If the link is gone, it runs the same guarded stale cleanup and advances the
cursor without counting the row as authoritative. A live link's conflict still fails the
batch; storage errors or an unavailable authority still leave the cursor unchanged.
Other operations' reservations and unfinished email replacements retain the protections above.

Remaining: rows an older build already left in `releasing` with an `operation_id` starting
with `hmac-reindex:`. They are **not** taken over by an add: an email replacement also puts
rows of any operation (reindex rows included) into `releasing` and keeps the operation id, so
a stuck reindex leftover cannot be told apart from a replacement that is still running by
looking at the reservation. Repair them by hand (below). Unlinking the identifier through the
product also releases such a row, if the link still exists.

### 2. Replay of an add from two or more removal cycles ago (mitigated; key-switch retry gap closed)

`reserve()` refuses to re-acquire a released row only from the operation that released it
last. The sequence add X, remove, add Y, remove, replay X used to succeed, and the
coordinator then published a route that nothing owned (an active route and a committed
reservation with no link behind them).

Now: the identifier addition path reads the add's own outbox row first; if it already
`succeeded`, it returns the success without reserving or publishing anything. For DIDs and
external IdPs this replay was practically unreachable anyway (the operation id is derived
from the link row, and the RPC checks that the link exists). This outbox guard does not
cover direct callers of `reserve()`: account creation allocates a new account id, while
guest upgrade uses the existing guest account and its own operation state and pinned
publication. Guest lifecycle cleanup calls `release()`, not `reserve()`. None of these
guards gives the reservation table a history of older operations.

Closed retry gaps: email and external-subject additions now rebuild retries with the HMAC
generations pinned in their own outbox, while those keys remain readable. Previously a key
switch rebuilt the same operation with different digests: it either conflicted with a
reindex reservation or reserved a new-generation identifier before rejecting the changed
outbox payload. The complete payload is recomputed from the caller's identifier, account,
tenant, idempotency key and route projection and compared byte-for-byte with the stored
payload before any reservation write. A mismatched or terminal outbox is rejected before
reserving or extending a lease. A succeeded add still returns success without touching
reservations or routes, including after a key switch or an unlink.

Remaining: a retired pinned key cannot validate the caller's identifier and the retry
fails closed; it does not reserve under a new key instead. A new challenge/operation for
an already-held email is not an exact retry and still conflicts. These changes do not
give `reserve()` per-link ownership or a history of previous operations.

### 3. Removal and re-add within the same second (open)

The removal fence compares whole seconds (`created_at <= prepared_at`). If an unlink is
prepared, completed, and the identifier is linked again, all within one second, while a
second, slow executor of the same removal is still running (the routing-outbox processor
and the unlink scheduler can both run it), the slow run cannot tell the new reservation
from the old one. It can disable the new route and release the new reservation.

Symptom: the user re-links and then cannot sign in (`identity_not_linked`); the
reservation is `released`, the route `disabled`, the link exists. Realistically this needs
an unlink followed by a re-link within a second, which the UI does not offer.

### Damage assessment

- No cross-account access: the authoritative link is always checked at login.
- Affected: one identifier of one account, unusable for sign-in or for linking until
  repaired. Other identifiers and the account itself are unaffected.
- Exposure: low. 1 needs an HMAC rotation, 2 needs a replayed internal call, 3 needs a
  sub-second sequence.

## Workarounds

- After an unlink, wait for the next cron run (every 2 minutes) before linking the same
  identifier again.
- Do not unlink or re-link identifiers while an HMAC key rotation is in progress
  (states `dual_read`, `reindexing`, `verifying`, `grace`).

## Diagnostics (read only)

The Lookup database is addressed by the shard registry; check every Lookup shard
database. Examples use `wrangler d1 execute`; replace the database name and the `:name`
placeholders with literal values (strings in single quotes). The statements below are
exercised against the real Lookup baseline by
`packages/ar-management/src/__tests__/lookup-directory-runbook-sql.integration.test.ts`;
change both together.

Placeholders used below. Two forms of the account identifier appear, and the wrong one
silently matches nothing, so use the form in the right-hand column:

| Placeholder | Meaning                                                                                                       | Used in                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `:user_id`  | the bare user id, as in `linked_identities.user_id`, `passkeys.user_id`, `identity_sensitive_values.owner_id` | authority lists (step 2 table)                                     |
| `:account`  | `account:<user id>`, as stored in the Lookup `account_id` columns and in `account_routing_outbox.account_id`  | Lookup statements, the routing outbox check, the repair statements |
| `:tenant`   | the tenant id                                                                                                 | all                                                                |

(The replacement operations table is checked with both forms, because its `account_id`
column is written either way.)

### Step 1: stuck rows

```sql
-- runbook: stuck-rows
SELECT virtual_bucket, tenant_id, index_kind, normalization_version, hmac_key_generation,
       identifier_blind_digest, account_id, reservation_state, operation_id,
       created_at, updated_at
  FROM lookup_identifier_reservations
 WHERE reservation_state IN ('releasing', 'repair_required')
   AND updated_at < unixepoch() - 7200
 ORDER BY updated_at
 LIMIT 200;
```

```sh
npx wrangler d1 execute <LOOKUP_DATABASE_NAME> --remote --command "<the statement on one line, without the -- comment line>"
```

A row here has stood untouched for two hours. That is a candidate, not yet an orphan:
an email replacement that is blocked or running also leaves `releasing` rows (reindex rows
included), and the code never writes `repair_required`. Before treating a row as stuck,
check the tenant PII database for an unfinished replacement of the same account; if there is
one, do not repair the row, resume or repair the replacement instead:

```sql
-- runbook: unfinished-replacements
SELECT operation_id, identifier_kind, state, updated_at
  FROM identity_identifier_replacement_operations
 WHERE tenant_id = :tenant AND account_id IN (:account, :user_id)
   AND state NOT IN ('completed', 'canceled');
```

(`:account` is `account:<user id>`; `:user_id` is the bare user id.)

### Step 2: does the authority still have the identifier?

The directory stores only blind digests, so the identifier cannot be read back from a row.
A committed reservation without a link is found by comparing digests, and the comparison
has to cover **every** authority that creates reservations, not only `linked_identities`: a
normal account with one passkey and no external IdP link would otherwise look like an orphan.
List what the authority holds for the account (columns as in the reindex source queries,
`lookup-hmac-reindex.ts`):

| Authority (database)                    | Statement                                                                                                                                                                                   | Identifier (kind: issuer, subject)                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| External IdP and DID links (tenant PII) | `SELECT provider_id, provider_user_id FROM linked_identities WHERE tenant_id = :tenant AND user_id = :user_id`                                                                              | `external_subject`: provider_id, provider_user_id                                          |
| Passkeys (tenant core users)            | `SELECT rp_id, credential_id FROM passkeys WHERE tenant_id = :tenant AND user_id = :user_id AND rp_id IS NOT NULL AND rp_id <> ''`                                                          | `external_subject`: `urn:authrim:passkey:` + lowercase rp_id, credential_id                |
| Guest devices (tenant core users)       | `SELECT resume_credential_hash FROM guest_devices WHERE tenant_id = :tenant AND user_id = :user_id AND is_active = 1`                                                                       | `external_subject`: `urn:authrim:guest-resume:v1`, resume_credential_hash                  |
| Email address (tenant PII)              | `SELECT value_json FROM identity_sensitive_values WHERE tenant_id = :tenant AND owner_type = 'runtime_user' AND owner_id = :user_id AND value_key = 'email' AND lifecycle_state = 'active'` | `email_exact`: the address (JSON string)                                                   |
| SCIM user name (tenant PII)             | the same with `value_key = 'preferred_username'`                                                                                                                                            | `external_subject`: `urn:authrim:scim:<tenant>:username`, lowercased and trimmed user name |

Then compute the digest of each identifier under each key generation that has reservation
rows (the current one and, during a rotation, the previous one). This needs the HMAC key
value (the content of the `LOOKUP_HMAC_KEY_SLOT_A` / `_B` secret of that generation), which
`wrangler` cannot read back (Worker secrets are write-only); take it from the place the
environment's key material is kept, never print it, and never pass it as a command-line
argument. The script below has no dependencies and repeats `createLookupBlindIndex`
(`ar-lib-core`, `services/lookup-directory/blind-index.ts`); a test compares its output with
that function. Save it outside the repository (for example `recompute-digest.mjs` in a
temporary directory) and delete it afterwards.

```js
// Usage: LOOKUP_HMAC_GENERATION=2 LOOKUP_HMAC_KEY=... node recompute-digest.mjs < identifiers.jsonl
// One JSON object per input line:
//   {"kind":"email_exact","value":"user@example.com"}
//   {"kind":"external_subject","issuer":"did","subject":"did:key:..."}
const enc = new TextEncoder();
const hex = (bytes) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};
const prefixed = (bytes) => cat(u32(bytes.length), bytes);
const generation = Number(process.env.LOOKUP_HMAC_GENERATION);
const key = await crypto.subtle.importKey(
  'raw',
  enc.encode(process.env.LOOKUP_HMAC_KEY),
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign']
);
let input = '';
for await (const chunk of process.stdin) input += chunk;
for (const line of input.split('\n').filter(Boolean)) {
  const item = JSON.parse(line);
  const normalized =
    item.kind === 'email_exact'
      ? enc.encode(item.value.trim().toLowerCase())
      : cat(prefixed(enc.encode(item.issuer.trim())), prefixed(enc.encode(item.subject.trim())));
  const digest = hex(
    await crypto.subtle.sign(
      'HMAC',
      key,
      cat(enc.encode(item.kind), new Uint8Array([0]), u32(1), prefixed(normalized))
    )
  );
  const secondary = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      cat(
        enc.encode(item.kind),
        new Uint8Array([0]),
        Uint8Array.from(digest.match(/../g).map((b) => parseInt(b, 16)))
      )
    )
  );
  console.log(
    JSON.stringify({ generation, bucket: (secondary[0] << 4) | (secondary[1] >>> 4), digest })
  );
}
```

Run it with the key in the environment of that one command only (keep it out of shell
history). The identifiers are normalised as the directory does: an email address is
trimmed and lowercased; the other fields are trimmed (a SCIM user name is lowercased by
the product before it is indexed, so give it lowercased).

Finally list the account's committed reservations that no authority identifier explains.
Put the digests of every identifier of the account, for every generation, into the list:

```sql
-- runbook: committed-without-link
SELECT virtual_bucket, tenant_id, index_kind, normalization_version, hmac_key_generation,
       identifier_blind_digest, account_id, reservation_state, operation_id,
       created_at, updated_at
  FROM lookup_identifier_reservations
 WHERE tenant_id = :tenant AND account_id = :account
   AND reservation_state = 'committed'
   AND identifier_blind_digest NOT IN ('<digest 1>', '<digest 2>');
```

A row returned is an orphan only if the lists in step 2 are complete for this account.
**If you cannot produce every authority list or the key is unavailable, or you are not sure
a row is unexplained, do not repair it.** An unrepaired orphan costs one identifier; a wrong
repair breaks a working sign-in. Rows from step 1 (`releasing`, `repair_required`) are judged
the same way: the authority must not hold an identifier with that digest.

The add's own outbox row can show where an add-originated reservation came from (in the
tenant core database, `account_routing_outbox.outbox_id = 'account-routing:' || <operation_id>`).
Rows created by a reindex (`operation_id` starting with `hmac-reindex:`) and by a
replacement have no such outbox row; do not use it as a test for them.

For the opposite symptom (the link exists but sign-in fails), the reservation is
`released` (or missing) and the route is `disabled`; do not edit the directory to bring it
back. Unlink and link the identifier again through the product.

## Repair (manual, destructive)

Only for a row that step 2 above showed to be unexplained by the authority, with no
unfinished replacement.

1. **Freeze the identifier.** Until the repair is finished, nobody links or unlinks that
   identifier (tell the user and the tenant administrators; suspend the connector or SCIM
   client that manages the account if there is one). Wait two minutes for the cron to drain
   the account's routing outbox, then confirm in the tenant core database that nothing is
   pending for the account (`:account` is `account:<user id>`, the form the outbox stores).
   Any row returned means an add or a removal of the account has not finished: wait and run it
   again, and do not start the repair until it returns no rows.

   ```sql
   -- runbook: pending-outbox
   SELECT outbox_id, event_kind, status
     FROM account_routing_outbox
    WHERE tenant_id = :tenant AND account_id = :account
      AND status NOT IN ('succeeded', 'dead_letter');
   ```

2. **Record.** Note the point-in-time bookmark of the Lookup database for reference
   (`npx wrangler d1 time-travel info <LOOKUP_DATABASE_NAME>`; it is not a way to undo this
   repair, see the disaster recovery note), and save the step 1 or step 2
   output of the row. Re-run the diagnostic select just before the repair; its values are
   the _observed values_ below.
3. **Release the reservation**, guarded by the observed values. If anything changed since
   the diagnosis (a new add, a re-link, a replacement), the statement changes 0 rows:

   ```sql
   -- runbook: repair-reservation
   UPDATE lookup_identifier_reservations
      SET reservation_state = 'released', lease_expires_at = NULL,
          released_at = COALESCE(released_at, unixepoch()), updated_at = unixepoch()
    WHERE virtual_bucket = :bucket AND tenant_id = :tenant AND index_kind = :kind
      AND normalization_version = :norm AND hmac_key_generation = :generation
      AND identifier_blind_digest = :digest AND account_id = :account
      AND reservation_state = :observed_state AND operation_id = :observed_operation
      AND created_at = :observed_created_at AND updated_at = :observed_updated_at
      AND reservation_state IN ('releasing', 'repair_required', 'committed');
   ```

   The result must say exactly one row changed. Zero: stop, the row is not what you
   diagnosed; start again from step 2 of the diagnostics. Do not retry with relaxed
   conditions.

4. **Disable the route** (only after step 3 changed one row). The statement leaves the route
   alone only if **the same account** holds the identifier again (a `reserved` or `committed`
   reservation of that account exists: it linked the identifier again, and the route is that
   link's). If another account took the freed identifier, this account's route must still be
   disabled, otherwise both accounts answer for the identifier and sign-in becomes ambiguous.
   That correlation is what makes the statement safe without a transaction; whether
   `wrangler d1 execute` runs several statements atomically is not assumed, so run the
   statements one at a time:

   ```sql
   -- runbook: repair-route
   UPDATE lookup_identifiers
      SET lifecycle_state = 'disabled', runtime_route_status = 'disabled',
          disabled_at = COALESCE(disabled_at, unixepoch()), updated_at = unixepoch()
    WHERE virtual_bucket = :bucket AND index_kind = :kind AND normalization_version = :norm
      AND hmac_key_generation = :generation AND identifier_blind_digest = :digest
      AND tenant_id = :tenant AND account_id = :account AND lifecycle_state <> 'disabled'
      AND NOT EXISTS (
        SELECT 1 FROM lookup_identifier_reservations reservation
         WHERE reservation.virtual_bucket = lookup_identifiers.virtual_bucket
           AND reservation.tenant_id = lookup_identifiers.tenant_id
           AND reservation.index_kind = lookup_identifiers.index_kind
           AND reservation.normalization_version = lookup_identifiers.normalization_version
           AND reservation.hmac_key_generation = lookup_identifiers.hmac_key_generation
           AND reservation.identifier_blind_digest = lookup_identifiers.identifier_blind_digest
           AND reservation.account_id = lookup_identifiers.account_id
           AND reservation.reservation_state IN ('reserved', 'committed')
      );
   ```

   One row changed, or zero if the route was already disabled or missing. If it changed zero
   rows because the same account's reservation exists again, that account linked the
   identifier during the repair: leave it, and re-diagnose that link. The route and the
   reservation of the **same key generation** only; repeat steps 3 and 4 for each generation
   the diagnosis lists.

5. **Verify.** Both must hold, and nothing else may have changed:

   ```sql
   -- runbook: verify
   SELECT reservation_state, released_at FROM lookup_identifier_reservations
    WHERE virtual_bucket = :bucket AND tenant_id = :tenant AND index_kind = :kind
      AND normalization_version = :norm AND hmac_key_generation = :generation
      AND identifier_blind_digest = :digest;
   ```

   `released` with a `released_at`; the route select (`lifecycle_state` of the same key in
   `lookup_identifiers`) says `disabled`. Re-run the step 1 and the committed-without-link
   selects: the repaired row is gone.

   Abort rules. Stop at the first of these and do not run further statements:
   - a statement changed more than one row, or changed zero rows where one was expected
     (steps 3 and 4 above: zero means the row is no longer what you diagnosed);
   - the verification does not show `released` and `disabled`;
   - a row other than the one repaired differs from what you saved.

   For the last case the Lookup database is shared with other tenants and accounts, and a
   change in another row is usually somebody else's normal operation (an unlink, a link, a
   reindex step). **Do not restore the database.** Stop and find out:
   1. Record the changed row as it is now (all columns).
   2. Decide whether it is another account's normal operation: compare its `account_id`,
      `operation_id` and times with the routing outbox of that account in the tenant core
      database (`account_routing_outbox`, `outbox_id = 'account-routing:' || <operation id>`
      for adds, `'account-routing-removal:' || <operation id>` for removals).
   3. Only if the change is a result of your own statements (it should not be), put that one
      row back to the old value you saved, with the values you just recorded in the `WHERE`,
      so that the statement changes nothing if the row has moved again:

      ```sql
      -- runbook: restore-reservation-row
      UPDATE lookup_identifier_reservations
         SET account_id = :old_account, reservation_state = :old_state,
             operation_id = :old_operation, lease_expires_at = :old_lease_expires_at,
             committed_at = :old_committed_at, released_at = :old_released_at,
             created_at = :old_created_at, updated_at = :old_updated_at
       WHERE virtual_bucket = :bucket AND tenant_id = :tenant AND index_kind = :kind
         AND normalization_version = :norm AND hmac_key_generation = :generation
         AND identifier_blind_digest = :digest
         AND account_id = :now_account AND reservation_state = :now_state
         AND operation_id = :now_operation AND created_at = :now_created_at
         AND updated_at = :now_updated_at;
      ```

      (Write `NULL` for an old value that was null. A route row is put back the same way with
      its own observed columns; `lifecycle_state` and `runtime_route_status` together.)

   Restoring the whole database from a time-travel bookmark is not part of this repair; see
   the disaster recovery note below.

6. **Unfreeze**, then link the identifier again (or have the user sign in) and confirm.

## HMAC reindex stopped on a reservation

During a key rotation the reindex job can fail a source row with one of three errors:

- `lookup_hmac_reindex_reservation_conflict`: the reservation of the **candidate** (new)
  key generation for the identifier exists and is not committed to the same account;
- `lookup_hmac_reindex_reservation_not_committed`: the reservation was released between
  the reindex's check and its write, while the authority still has the link;
- `lookup_hmac_reindex_source_reservation_invalid`: the reservation of the **source**
  (old) generation is missing, not committed, or held by another account.

While the exact link remains authoritative, the row is not skipped. The job keeps its cursor
and tries the same batch again on every
run (every cron tick), so the rotation waits there and does not reach verification. That is
deliberate: a link without a route in the new generation would otherwise go unnoticed,
because the verification compares counts and a different account's new route can make up for
a missing one.

After `source_reservation_invalid` or `conflict`, the reindex rechecks the exact source
link in the primary authority. If it has gone, the row is treated as stale and finished
with the guarded cleanup from limit 1. An unfinished email replacement keeps its reservation
and route. `not_committed` is also a race: a later scan normally stops selecting an unlinked
row, and an email replacement that is still completing does the same when it switches the
address. None of these paths takes over or re-commits a released reservation for a live
link. Wait a few runs first. If the same
code (or `conflict`) stays, find the row:

1. Confirm the job's last error (read only):

   ```sql
   -- runbook: reindex-job-error
   SELECT job_class, last_error_code, last_started_at, last_completed_at, updated_at
     FROM lookup_directory_job_cursors
    WHERE job_class = 'hmac_reindex';
   ```

   The error names no identifier (error codes are kept free of identifiers).

2. **The failing row is somewhere in the unsettled batch, not necessarily the first row.**
   A batch is at most 50 source rows (`hmac_reindex`: `rowLimit` 50, 6 seconds of wall
   clock; fewer if the time ran out), processed in order. The source checkpoint (in Control:
   the rotation operation's source shard `cursor`, `after_created_at` and `after_id`) is
   saved only after the whole batch, so a failure on row 2 leaves the checkpoint before row
   1, and row 1's success is redone on the next run. Examine every row of the batch.
3. List the batch from the authority with the same query and order the reindex uses
   (`sourceQuery` in `lookup-hmac-reindex.ts`; `:cutoff_at` is the source shard's
   `cutoffAt`, `:after_created_at` / `:after_id` are its cursor). Use the one that matches
   the source shard that is being reindexed:

   ```sql
   -- email addresses (tenant PII)
   SELECT id, tenant_id, owner_id, value_json, created_at FROM identity_sensitive_values
    WHERE owner_type = 'runtime_user' AND value_key = 'email' AND lifecycle_state = 'active'
      AND created_at < :cutoff_at
      AND (created_at > :after_created_at OR (created_at = :after_created_at AND id > :after_id))
    ORDER BY created_at, id LIMIT 50;

   -- external IdP and DID links (tenant PII)
   SELECT 'linked:' || id AS id, tenant_id, user_id, provider_id, provider_user_id, linked_at
     FROM linked_identities
    WHERE linked_at < :cutoff_at
      AND (linked_at > :after_created_at
           OR (linked_at = :after_created_at AND 'linked:' || id > :after_id))
    ORDER BY linked_at, 'linked:' || id LIMIT 50;

   -- passkeys and guest devices (tenant core users)
   SELECT id, tenant_id, user_id, provider_id, provider_user_id, linked_at FROM (
     SELECT 'passkey:' || id AS id, tenant_id, user_id,
            'urn:authrim:passkey:' || lower(rp_id) AS provider_id,
            credential_id AS provider_user_id, created_at AS linked_at
       FROM passkeys WHERE rp_id IS NOT NULL AND rp_id <> ''
     UNION ALL
     SELECT 'anonymous:' || id, tenant_id, user_id, 'urn:authrim:guest-resume:v1',
            resume_credential_hash, created_at FROM guest_devices WHERE is_active = 1
   ) WHERE linked_at < :cutoff_at
       AND (linked_at > :after_created_at OR (linked_at = :after_created_at AND id > :after_id))
   ORDER BY linked_at, id LIMIT 50;
   ```

4. Compute two digests for each row with the recompute script above: under the **source**
   generation key and under the **candidate** generation key (`LOOKUP_HMAC_GENERATION` and
   the key of that generation). The account of a row is `account:<user_id>` (`owner_id` for
   an email). Then look the reservations up **directly by digest**, with no filter on the
   state, in the Lookup database (one tuple per source row; replace the placeholders):

   ```sql
   -- runbook: reindex-batch-reservations
   WITH batch(account_id, source_digest, candidate_digest) AS (
     VALUES ('<account>', '<source digest>', '<candidate digest>')
   )
   SELECT batch.account_id, batch.candidate_digest,
          source.reservation_state AS source_state, source.account_id AS source_holder,
          candidate.reservation_state AS candidate_state,
          candidate.account_id AS candidate_holder,
          candidate.operation_id AS candidate_operation,
          candidate.updated_at AS candidate_updated_at,
          CASE
            WHEN source.reservation_state IS NULL OR source.reservation_state <> 'committed'
                 OR source.account_id <> batch.account_id THEN 'source_reservation_invalid'
            WHEN candidate.reservation_state IS NULL THEN 'none (the reindex creates it)'
            WHEN candidate.account_id = batch.account_id
                 AND candidate.reservation_state = 'committed' THEN 'none'
            ELSE 'reservation_conflict'
          END AS blocks_with
     FROM batch
     LEFT JOIN lookup_identifier_reservations source
       ON source.tenant_id = :tenant AND source.hmac_key_generation = :source_generation
      AND source.identifier_blind_digest = batch.source_digest
     LEFT JOIN lookup_identifier_reservations candidate
       ON candidate.tenant_id = :tenant AND candidate.hmac_key_generation = :candidate_generation
      AND candidate.identifier_blind_digest = batch.candidate_digest
    ORDER BY blocks_with LIKE 'none%', batch.account_id;
   ```

   Every row of the batch is listed whatever its state, holder or absence. The rows whose
   `blocks_with` is not `none` are the ones that fail the batch (a missing candidate
   reservation is normal: the reindex creates it).

5. Decide by what the row shows:

   | Source reservation                         | Candidate reservation               | Error                                                                           | What to do                                                                                                                                                                                                                                                                        |
   | ------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | missing, not committed, or another account | any                                 | `source_reservation_invalid`                                                    | The directory lost the link's old-generation reservation. If the authority still has the link, unlink and link it again through the product. A source row captured before an unlink is finished as stale after the primary authority recheck; unexplained leftovers still require the diagnostics and Repair section. |
   | committed, same account                    | none                                | none                                                                            | The reindex creates it.                                                                                                                                                                                                                                                           |
   | committed, same account                    | `committed`, same account           | none                                                                            | Done.                                                                                                                                                                                                                                                                             |
   | committed, same account                    | `committed`, **another account**    | `reservation_conflict`                                                          | Another account holds the identifier in the new generation (a link added after the rotation started took it). Find which of the two the authority has (step 2 of the diagnostics for both accounts); the other is the orphan to repair.                                           |
   | committed, same account                    | `reserved` (any account)            | `reservation_conflict`                                                          | An add holds it under a lease (up to two hours). Wait for it to finish or expire; if the add is the authority's link, nothing is wrong.                                                                                                                                           |
   | committed, same account                    | `releasing` or `repair_required`    | `reservation_conflict`                                                          | An email replacement is running or blocked (check `identity_identifier_replacement_operations`: wait for it, or repair it first), otherwise a stuck leftover: Repair section, after the authority check.                                                                          |
   | committed, same account                    | `released`, same or another account | `reservation_conflict` (`not_committed` on the run that raced with the release) | The authority has the link but the directory has no usable row: unlink and link the identifier again through the product. If the authority no longer has it, the row is finished by itself.                                                                                       |

   The reindex does not take over a candidate reservation that exists in any other state.

6. Do not repair a candidate-generation reservation by hand just to make the reindex pass;
   the repair section applies to orphans, not to links the authority still has. If an unfinished
   email replacement exists for the account, resume or repair that replacement first.

## Restoring the whole Lookup database (disaster recovery, separate from the repair)

`wrangler d1 time-travel restore <LOOKUP_DATABASE_NAME> --bookmark <bookmark>` rolls the
**entire** database back, and with it every write of every tenant since the bookmark, while
the tenant core and PII databases keep theirs. The two sides then disagree (accounts linked
or unlinked in the meantime have authority rows but no directory rows, or the reverse). Use
it only as a recovery of the shard as a whole, not to undo a repair:

1. Stop all writes to the shard first (no links, unlinks, account creation, SCIM, reindex or
   key-rotation work routed to it) and keep them stopped.
2. List what will be lost: the writes since the bookmark (reservation and route rows changed
   after it, and the outbox rows of core that refer to them).
3. Restore, then run the directory reconciliation for the period (re-run the account
   routing outbox for the period and verify, or follow the tenant disaster-recovery procedure
   for the shard) before accepting writes again.

A single mistaken repair statement is undone row by row, as above, not by this procedure.

## When to re-evaluate

Implement the persisted generation (below) when any of these holds:

- A customer is selected (end-2026 selection) and identifier links are in real use.
- An HMAC rotation is going to be run in production.
- The diagnostics above find stuck rows in a real environment.
- Before 1.0.

## Design memo: reservation with a link reference (plan A)

Goal: a removal releases only the reservation that belongs to the link it removes.

- Where: a nullable `link_ref TEXT` column on `lookup_identifier_reservations`, set to a
  stable opaque id of the link (the `linked_identities.id`, passkey id, device id, or
  email value id; not the identifier itself), carried in the publication payload
  (`AccountDirectoryPublication` and `AccountDirectoryRemovalPublication` gain
  `linkRef`; both are validated and compared byte-for-byte in the outbox, so the payload
  format changes with a version bump).
- Who sets it: every operation that creates a reservation: `reserve()` (adds, from the
  publication), the account-creation and guest producers, the HMAC reindex (copies the
  `link_ref` of the source-generation reservation, and `created_at` as it does now), and
  the email replacement (new value id).
- Where it is compared: the removal's release statement and its route-disable guard
  (`link_ref = removal.linkRef` replaces the `created_at <= fence` test; a NULL
  `link_ref`, from before the migration, keeps the old fence); `reserve()` replays (a
  replay with a different `link_ref` on the row is refused, which also ends limit 2);
  the reindex stale path (releases only a row with its own `operation_id`, as now).
  With a `link_ref` on the row, the reindex stale path and a takeover of a stuck `releasing`
  row could be decided by link instead of by the replacement lookup used now.
- Migrations: Lookup D1 `00N_reservation_link_ref.sql` adds the column (and an index on
  `(tenant_id, account_id, link_ref)` for the reconciler); a core/pii migration is needed
  only if the outbox payload version has to be recorded there. Lookup migrations ship with
  the release manifest and the setup migration tests.
- Optional reconciler: a scheduled job that lists reservations stuck in `releasing` /
  `repair_required` (the query above) and `committed` ones whose `link_ref` no longer
  exists in the authority, and releases them with the repair statements above.
- Files (about 15 to 20): `account-directory-reservation.ts`,
  `account-directory-coordinator.ts`, `account-directory-removal.ts`,
  `account-identifier-addition.ts`, `account-identifier-replacement.ts` and
  `identifier-replacement-coordinator.ts`, `lookup-hmac-reindex.ts`,
  `account-directory-producer.ts`, `account-guest-upgrade.ts`, `guest-lifecycle-scheduled.ts`,
  `auth-account-provisioning-entrypoint.ts`, `routes/directory-connectors.ts`,
  `account-passkeys.ts`; in `ar-lib-core` the publication types and validators
  (`services/lookup-directory/publication.ts`); the Lookup migration and the migration
  manifest; the tests that build publications and rows.
