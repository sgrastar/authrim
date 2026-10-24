# OIDC mapping failure observations

OIDC ID token issuance and UserInfo record failed identity mapping attempts in the dedicated
Admin database. The tuple is tenant, client, fixed error code, selected tier and Mapping Set ID.
Each tuple has a cumulative count and first/last occurrence times in Unix milliseconds. The
operation atomically increments one row; nullable tiers and sets retain their identity. A clock
rollback preserves the earliest and latest observed time.

The recorder accepts configuration identifiers and fixed codes only. It does not accept an Error,
message, stack, user identifier, claim value or selector object. Unknown codes use `mapping_failed`.
It records one observation from the common ID token mapping failure boundary, or the separate
UserInfo mapping boundary. Successful mapping, explain requests, consent rejection and failures
outside those mapping boundaries do not create observations.

Recording uses the request's bound `waitUntil` lifetime and is best effort. Missing or throwing
lifetime registration skips storage. Admin database or write failure cannot replace the protocol
error response. There is no detached request work or fallback to Core storage. These observations
are diagnostic totals and are not a complete audit ledger of all failed authentication attempts.

## Read observations

`GET /api/admin/identity-mapping/failures` requires settings read permission for the calling tenant.
Optional filters are `client_id` and `since`; `since` is an inclusive Unix millisecond lower bound
on `last_at`. It selects tuples, not individual occurrences: a selected row's count includes all
earlier observations. There is no derived recent-period count.

The default page size is 50 and the maximum is 100. Results are ordered by `last_at DESC, id DESC`.
Use `next_cursor` with the same tenant and filters. Concurrent observations can move mutable rows
between pages; pagination is not a frozen snapshot. Client deletion does not remove historical
observations. An unknown client or another tenant's client returns an empty list.

## Storage and backup

Apply Admin migration `051_identity_mapping_failures.sql` before activating Workers that depend
on it. Use the normal setup-managed release update and the development draft manifest while the
release remains unpublished. Do not generate a release baseline solely for this change.

Rows stay in D1 without a new automatic TTL, cleanup job or R2 writer. Tenant backup classifies
the dataset under `history` / `logs.other`, selecting rows by `last_at` in milliseconds. The saved
count remains the tuple's cumulative count even when `first_at` precedes the selected range.
The append-only log row archiver does not move or delete these mutable aggregates: deleting by ID
after an archive read could lose observations added after that read. Existing log retention
settings and move-to-R2 settings do not turn these aggregates into append-only events.
