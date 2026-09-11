# Webhook events and delivery

This reference covers subscription-based webhooks, their event names and payloads, and the separate
logout and test callback formats. The catalog reflects the current source tree. It distinguishes
an implemented publication path from an event name that is only declared; declaring or subscribing
to a name does not make every related operation emit that event.

- [Configuration and scope](#configuration-and-scope)
- [HTTP envelope and signatures](#http-envelope-and-signatures)
- [Event catalog](#event-catalog)
- [Naming proposal and coverage inventory](#naming-proposal-and-coverage-inventory)
- [Event data](#event-data)
- [Account lifecycle notifications](#account-lifecycle-notifications)
- [Selected account snapshots](#selected-account-snapshots)
- [Test and logout callbacks](#test-and-logout-callbacks)
- [Delivery behavior](#delivery-behavior)

## Configuration and scope

Configure subscriptions in Admin > Webhooks or through the
[Admin OpenAPI contract](../../packages/ar-management/openapi/admin.openapi.yaml).

| Operation                             | Endpoint                                             |
| ------------------------------------- | ---------------------------------------------------- |
| Create / list subscriptions           | `POST` / `GET /api/admin/webhooks`                   |
| Read / update / delete a subscription | `GET` / `PUT` / `DELETE /api/admin/webhooks/:id`     |
| Send a test callback                  | `POST /api/admin/webhooks/:id/test`                  |
| Inspect deliveries                    | `GET /api/admin/webhooks/:id/deliveries`             |
| Inspect one delivery                  | `GET /api/admin/webhooks/:id/deliveries/:deliveryId` |
| Request replay                        | `POST /api/admin/webhooks/:id/replay`                |

Replay requests use a JSON body containing `delivery_id`.

Use exact event names or wildcard patterns: `auth.*`, `token.*`, `account.*`, or
`account.email.*`. `auth.*` matches three-segment events such as `auth.passkey.succeeded`.
`session.created`, `session.revoked`, `token.issued`, and `token.revoked` are not the event names
emitted by the producers listed below; use the full names in the catalog.

Tenant-scoped subscriptions receive matching events for their tenant. Client-scoped subscriptions
are additionally considered only when the publisher identifies that client as the internal event
actor (`metadata.actor.type = client`). A `clientId` in `data` alone does not enable client-scoped
delivery. Account notifications use tenant scope. Inactive subscriptions are excluded.
See [subscription matching](../../packages/ar-lib-core/src/services/webhook-registry.ts) and
[dispatcher routing](../../packages/ar-lib-core/src/services/event-dispatcher.ts).

## HTTP envelope and signatures

Subscription events use an HTTP POST with `Content-Type: application/json`:

```json
{
  "id": "evt_0123456789abcdef0123456789abcdef",
  "type": "account.updated",
  "timestamp": "2026-09-11T09:00:00.000Z",
  "tenantId": "tenant-example",
  "data": { "userId": "user-example" }
}
```

The wire envelope contains `id`, `type`, `timestamp`, `tenantId`, and `data`.
The internal event's `version` and `metadata` are not serialized by the current dispatcher.
`timestamp` is an ISO 8601 event time, not necessarily the delivery time. Payload fields vary by
producer; do not assume every optional field in a shared TypeScript interface is present.

Current secret-based signing uses:

| Header                        | Meaning                                                   |
| ----------------------------- | --------------------------------------------------------- |
| `X-Authrim-Signature-Version` | `v1`                                                      |
| `X-Authrim-Signature-256`     | `sha256=` followed by the hexadecimal HMAC-SHA256         |
| `X-Authrim-Timestamp`         | Signature timestamp in Unix seconds                       |
| `X-Authrim-Delivery`          | Delivery attempt identifier; distinct from the event `id` |

The HMAC input is these four values joined with newline characters (no trailing newline):

```text
<X-Authrim-Timestamp>
POST
<receiver pathname including query string>
<lowercase SHA-256 hex of the exact raw request body>
```

Verify against the unmodified body bytes, the request path/query, and the subscription secret.
Compare signatures in constant time and enforce an acceptable timestamp window. Deduplicate
subscription events using the body `id`; an attempt header can change on redelivery.
The sender also supports a legacy precomputed body-only signature, without the `v1` header.
Do not apply that legacy formula to a `v1` request.
See [signing implementation](../../packages/ar-lib-logging/src/delivery/http-sink-signature.ts)
and [HTTP sender](../../packages/ar-lib-core/src/services/webhook-sender.ts).

## Event catalog

**Published** means a production publication path was found, not a promise of exhaustive coverage,
enablement in every deployment, or durable retries. **Defined only** means the name is declared
but no subscription-event publisher was found. **Audit vocabulary** means the name is also declared for SCIM
audit logging, which does not itself publish to Admin webhook subscriptions.
Account lifecycle webhooks use the canonical `account.*` names below. Removed lifecycle names
have no compatibility aliases.

The catalog is based on [event constants](../../packages/ar-lib-core/src/types/events/event-types.ts)
and their production callers. Protocol support does not depend on whether its webhook publisher exists.

### Authentication

| Event                               | Meaning                                                    | Publication  |
| ----------------------------------- | ---------------------------------------------------------- | ------------ |
| `auth.passkey.succeeded`            | Passkey/WebAuthn authentication succeeded.                 | Published    |
| `auth.passkey.failed`               | Passkey/WebAuthn authentication failed.                    | Published    |
| `auth.password.succeeded`           | Password authentication succeeded.                         | Defined only |
| `auth.password.failed`              | Password authentication failed.                            | Defined only |
| `auth.directory_password.succeeded` | Directory connector password authentication succeeded.     | Published    |
| `auth.directory_password.failed`    | Directory connector password authentication failed.        | Published    |
| `auth.email_code.succeeded`         | Email OTP authentication succeeded.                        | Published    |
| `auth.email_code.failed`            | Email OTP authentication failed.                           | Published    |
| `auth.totp.succeeded`               | TOTP authentication succeeded.                             | Published    |
| `auth.totp.failed`                  | TOTP authentication failed.                                | Published    |
| `auth.magic_link.succeeded`         | Magic-link authentication succeeded.                       | Defined only |
| `auth.magic_link.failed`            | Magic-link authentication failed.                          | Defined only |
| `auth.external_idp.succeeded`       | External identity-provider authentication succeeded.       | Published    |
| `auth.external_idp.failed`          | External identity-provider authentication failed.          | Published    |
| `auth.did.succeeded`                | DID authentication succeeded.                              | Published    |
| `auth.did.failed`                   | DID authentication failed.                                 | Published    |
| `auth.saml.succeeded`               | SAML service-provider authentication succeeded.            | Published    |
| `auth.saml.failed`                  | SAML service-provider authentication failed.               | Published    |
| `auth.login.succeeded`              | Generic login success; currently published by guest login. | Published    |
| `auth.login.failed`                 | Generic login failed.                                      | Defined only |

### Sessions

| Event                      | Meaning                                      | Publication  |
| -------------------------- | -------------------------------------------- | ------------ |
| `session.user.created`     | A user session was created.                  | Published    |
| `session.user.destroyed`   | A user session ended, for example on logout. | Published    |
| `session.user.refreshed`   | A user session was refreshed.                | Defined only |
| `session.client.created`   | An RP/client session was created.            | Defined only |
| `session.client.destroyed` | An RP/client session ended.                  | Defined only |

### Tokens

| Event                       | Meaning                                              | Publication |
| --------------------------- | ---------------------------------------------------- | ----------- |
| `token.access.issued`       | An access token was issued.                          | Published   |
| `token.access.revoked`      | An access token was revoked.                         | Published   |
| `token.access.introspected` | An access token was inspected through introspection. | Published   |
| `token.refresh.issued`      | A refresh token was issued.                          | Published   |
| `token.refresh.revoked`     | A refresh token was revoked.                         | Published   |
| `token.refresh.rotated`     | A refresh token was rotated.                         | Published   |
| `token.id.issued`           | An ID token was issued.                              | Published   |
| `token.batch.revoked`       | A batch token-revocation request was processed.      | Published   |

### Consent

| Event                           | Meaning                                                 | Publication  |
| ------------------------------- | ------------------------------------------------------- | ------------ |
| `consent.granted`               | The user granted client consent.                        | Published    |
| `consent.denied`                | The user denied client consent.                         | Published    |
| `consent.revoked`               | Previously granted client consent was revoked.          | Published    |
| `consent.version_upgraded`      | The user accepted updated policy versions.              | Published    |
| `consent.scopes_updated`        | The set of consented scopes changed.                    | Defined only |
| `consent.expired`               | Authorization detected that stored consent had expired. | Published    |
| `consent.item_granted`          | The user accepted an individual consent item.           | Published    |
| `consent.item_denied`           | The user declined an individual consent item.           | Published    |
| `consent.item_withdrawn`        | The user withdrew an individual consent item.           | Defined only |
| `consent.item_version_upgraded` | The user accepted a newer consent-item version.         | Defined only |

### Accounts — canonical events for new integrations

Use these events for human account integrations, including guest and registered accounts. Select
`registrationStates` to filter by registration state. These names are implemented, not proposals.

| Event                          | Meaning                                                                     | Publication                |
| ------------------------------ | --------------------------------------------------------------------------- | -------------------------- |
| `account.created`              | Human account completed directory activation.                               | Published — durable outbox |
| `account.updated`              | Account, profile, contact, custom profile, or guest-retention data changed. | Published — durable outbox |
| `account.deleted`              | Account deletion completed, including authentication and cleanup fences.    | Published — durable outbox |
| `account.registration.changed` | Guest-to-registered or registered-to-guest state transition committed.      | Published — durable outbox |
| `account.email.changed`        | Canonical primary email changed or identifier replacement completed.        | Published — durable outbox |

See [Account lifecycle notifications](#account-lifecycle-notifications) for payloads, selected data,
state filtering and delivery guarantees.

### Other user events

These events are separate from account lifecycle notifications. `user.password_changed` and
`user.email_verified` remain definitions only. `account.email.changed` reports address changes,
not verification of an unchanged address. The existing `user.logout` event remains separate.

| Event                   | Meaning                      | Publication  |
| ----------------------- | ---------------------------- | ------------ |
| `user.password_changed` | The user password changed.   | Defined only |
| `user.email_verified`   | The user email was verified. | Defined only |
| `user.logout`           | A user logout was processed. | Published    |

### Clients

| Event                   | Meaning                                            | Publication  |
| ----------------------- | -------------------------------------------------- | ------------ |
| `client.created`        | An OAuth/OIDC client was created.                  | Published    |
| `client.updated`        | An OAuth/OIDC client was updated.                  | Published    |
| `client.deleted`        | An OAuth/OIDC client was deleted.                  | Published    |
| `client.secret_rotated` | A client secret was rotated.                       | Defined only |
| `client.config.read`    | Client configuration was read through RFC 7592.    | Published    |
| `client.config.updated` | Client configuration was updated through RFC 7592. | Published    |
| `client.config.deleted` | Client configuration was deleted through RFC 7592. | Published    |

### Security

| Event                                     | Meaning                                       | Publication  |
| ----------------------------------------- | --------------------------------------------- | ------------ |
| `security.rate_limit.exceeded`            | A request exceeded the configured rate limit. | Published    |
| `security.suspicious.login_attempt`       | A suspicious login attempt was detected.      | Defined only |
| `security.suspicious.credential_stuffing` | Credential stuffing was detected.             | Defined only |
| `security.account.locked`                 | An account was locked.                        | Defined only |
| `security.account.unlocked`               | An account was unlocked.                      | Defined only |

### Domain verification

| Event                           | Meaning                        | Publication |
| ------------------------------- | ------------------------------ | ----------- |
| `domain.verification.started`   | Domain verification started.   | Published   |
| `domain.verification.succeeded` | Domain verification succeeded. | Published   |
| `domain.verification.failed`    | Domain verification failed.    | Published   |

### Settings

| Event                         | Meaning                                 | Publication  |
| ----------------------------- | --------------------------------------- | ------------ |
| `settings.updated`            | A settings category was updated.        | Defined only |
| `settings.rollback.started`   | Rollback to a settings version started. | Published    |
| `settings.rollback.completed` | Settings rollback completed.            | Published    |
| `settings.rollback.failed`    | Settings rollback failed.               | Published    |

### SCIM definitions

| Event                | Meaning                        | Publication      |
| -------------------- | ------------------------------ | ---------------- |
| `scim.user.create`   | Create a SCIM user.            | Audit vocabulary |
| `scim.user.replace`  | Replace a SCIM user.           | Audit vocabulary |
| `scim.user.patch`    | Patch a SCIM user.             | Audit vocabulary |
| `scim.user.delete`   | Delete a SCIM user.            | Audit vocabulary |
| `scim.group.create`  | Create a SCIM group.           | Audit vocabulary |
| `scim.group.replace` | Replace a SCIM group.          | Audit vocabulary |
| `scim.group.patch`   | Patch a SCIM group.            | Audit vocabulary |
| `scim.group.delete`  | Delete a SCIM group.           | Audit vocabulary |
| `scim.bulk.execute`  | Execute a SCIM bulk operation. | Audit vocabulary |
| `scim.token.create`  | Create a SCIM token.           | Audit vocabulary |
| `scim.token.revoke`  | Revoke a SCIM token.           | Audit vocabulary |

### Additional published events

These names are published directly rather than through the constants above.

| Event                                        | Trigger                                                   | Producer                                                  |
| -------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| `auth.email_verification_protocol.succeeded` | Successful direct email-verification protocol completion. | [Direct Auth](../../packages/ar-auth/src/direct-auth.ts)  |
| `ciba.request.created`                       | CIBA request created and awaiting user approval.          | [CIBA](../../packages/ar-async/src/ciba-authorization.ts) |

SCIM audit records are emitted by [SCIM audit logging](../../packages/ar-lib-scim/src/utils/scim-audit.ts).
An audit action with the same name is not evidence that a subscription webhook is emitted.
Similarly, permission-change `grant`/`revoke` notifications use the
[PermissionChangeHub/WebSocket path](../../packages/ar-lib-core/src/services/permission-change-notifier.ts),
not the subscription dispatcher. HTTP log destinations have their own delivery contract;
see [Logging](../logging.md#delivery-retry-and-dlq).

## Naming proposal and coverage inventory

Reviewed against the working tree on 2026-09-11. This section is a design inventory, not an
additional subscription contract. The event catalog and account lifecycle section remain the reference for current wire names.
Except for the implemented account normalization, registration-state filters, and selected snapshots
described below, proposed names and scopes remain design candidates. A Published status describes the current name/path, not its proposed replacement. Source-tree
publication also does not prove that a deployment has installed the required migrations and Workers.

### Reading the inventory

| Status        | Meaning for Admin subscription webhooks                                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Published     | A production publication path exists. Coverage can be limited to that path; see the evidence and limitations.                                               |
| Defined only  | A subscription event name is declared, but no production publisher was found in the reviewed source.                                                        |
| Not supported | No dedicated subscription event definition or publisher was found for this operation. This does **not** mean the underlying product feature is unavailable. |

Delivery is a separate dimension: account outbox, ordinary dispatcher, audit logging, protocol
callback, or permission WebSocket. Audit records and protocol callbacks must not be counted as
Published subscription events. Candidate events without an implemented operation remain planning
items; their inclusion is not a commitment to implement that operation.

Brace notation in the tables enumerates alternatives, for example `client.{created,updated}` means
two names. It is documentation shorthand, not accepted subscription syntax. Each operation must get
its own catalog record if its status, payload, scope, or delivery guarantee differs.

### Proposed naming and ownership rules

Use `<resource>[.<subresource>].<past-tense occurrence>`, with stable resource names and no fixed
number of segments. Underscores join words within a resource name (`access_token`, `token_exchange`);
dots separate resources or processes (`client.secret.rotated`, `vc.presentation.verified`).

- Keep guest/registered state in payload attributes and proposed subscription filters. Model registration
  transitions with `account.registration.changed` and previous/current state, rather than separate names
  for every possible pair of states. These canonical names replace the eight state-specific names without compatibility aliases.
- An agent acting on an account emits `account.updated`; actor information identifies the agent.
  Use `agent.*` for the agent's own registration, delegation, or execution resources.
- Reserve `admin.*` for Authrim administrator identities, roles, and access policy. An administrator
  changing a client still produces `client.updated`, with the administrator recorded as actor.
- Client-owned settings belong to `client.*`; SAML provider configuration belongs to `saml.provider.*`.
  Use `settings.updated` for generic settings documents, with scope/category/resource identity in the
  payload. System/tenant/organization/client scope is not inferred from the actor or event name.
- Distinguish a protocol operation from the resource it changes. SCIM may update an account; Token
  Exchange may issue a token. Separate operation events are useful only when their outcome carries
  additional meaning. Correlate operation and resource events instead of treating them as duplicates.
- Define exactly when events become true. `requested` is not `completed`, `revoked` is not `expired`,
  and an HTTP request returning successfully is not necessarily a completed asynchronous operation.
- A child-resource update must have an explicit policy for whether a parent `updated` invalidation
  also occurs. Renaming must not silently change this policy or create two business notifications.

### Identity, authentication, sessions, and consent

The detailed current authentication-method and consent catalog above is part of this inventory.

| Area / operation               | Proposed names                                                             | Current names / status                                                                                                              | Evidence and limitations                                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Human account lifecycle        | `account.{created,updated,deleted}`                                        | `account.{created,updated,deleted}` — Published                                                                                     | [Account outbox](../../packages/ar-management/src/account-webhook-outbox.ts); durable, human accounts only.                                                               |
| Registration transition        | `account.registration.changed`                                             | `account.registration.changed` — Published                                                                                          | Account outbox. The implemented registrationStates filter uses the current state; previous-state filtering is not implemented. No downgrade API is implied.               |
| Password/email changes         | `account.password.changed`, `account.email.verified`                       | `user.password_changed`, `user.email_verified` — Defined only                                                                       | [Constants](../../packages/ar-lib-core/src/types/events/event-types.ts). An authentication success event is not equivalent to a persistent email-verification transition. |
| Authentication methods         | `auth.<method>.{succeeded,failed}`                                         | See authentication catalog — status is per method/outcome                                                                           | Preserve useful method distinctions; do not claim all declared failures are emitted.                                                                                      |
| Direct email verification flow | `auth.email_verification.succeeded`                                        | `auth.email_verification_protocol.succeeded` — Published                                                                            | [Direct Auth](../../packages/ar-auth/src/direct-auth.ts). Flow success, distinct from account email state.                                                                |
| User session creation/end      | `session.created`; classify end as `session.{ended,revoked,expired}`       | `session.user.{created,destroyed}` — Published                                                                                      | [Logout](../../packages/ar-auth/src/logout.ts). End causes require inspection; do not rename every destruction to revocation.                                             |
| User session refresh           | `session.refreshed`                                                        | `session.user.refreshed` — Defined only                                                                                             | Session constants; no verified producer.                                                                                                                                  |
| Client session lifecycle       | `session.{created,ended}` with session-kind discriminator                  | `session.client.{created,destroyed}` — Defined only                                                                                 | Shared naming requires a defined payload union and filters first.                                                                                                         |
| Explicit user logout           | `auth.logout.completed`                                                    | `user.logout` — Published                                                                                                           | Logout dispatcher; dedicated client logout callback remains a different contract.                                                                                         |
| Consent decisions              | `consent.{granted,denied,revoked,expired}`                                 | Same names — Published                                                                                                              | [Consent](../../packages/ar-auth/src/consent.ts), [user consents](../../packages/ar-management/src/user-consents.ts).                                                     |
| Consent version / scopes       | `consent.version.accepted`, `consent.scopes.updated`                       | `consent.version_upgraded` — Published; `consent.scopes_updated` — Defined only                                                     | Split status by occurrence.                                                                                                                                               |
| Consent items                  | `consent.item.{granted,denied,withdrawn}`, `consent.item.version.accepted` | `consent.item_granted`, `consent.item_denied` — Published; `consent.item_withdrawn`, `consent.item_version_upgraded` — Defined only | Item-level decisions must retain their item identity.                                                                                                                     |

### Client, SAML, and settings administration

| Area / operation                                                                                                                  | Proposed names                                                     | Current names / status                                                               | Evidence and limitations                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth/OIDC client lifecycle                                                                                                       | `client.{created,updated,deleted}`                                 | Same names — Published                                                               | [Admin clients](../../packages/ar-management/src/admin-clients.ts). Covers the emitting paths, not proof of all client mutations.                                                                                                         |
| RFC 7592 client configuration                                                                                                     | `client.read`, consolidate changes into `client.{updated,deleted}` | `client.config.{read,updated,deleted}` — Published                                   | [Client configuration](../../packages/ar-management/src/client-config.ts). Preserve access channel as context; review whether reads need external notifications.                                                                          |
| Client secret rotation                                                                                                            | `client.secret.rotated`                                            | `client.secret_rotated` — Defined only                                               | Event must never include the secret.                                                                                                                                                                                                      |
| SAML provider lifecycle/configuration                                                                                             | `saml.provider.{created,updated,deleted}`                          | Not supported                                                                        | [Providers](../../packages/ar-saml/src/admin/providers.ts). Provider role (IdP/SP) belongs in data. SAML authentication publication does not cover configuration changes.                                                                 |
| SAML metadata refresh                                                                                                             | `saml.provider.metadata.refresh.{completed,failed}`                | Not supported                                                                        | [Metadata refresh](../../packages/ar-saml/src/admin/metadata-refresh.ts), [polling](../../packages/ar-saml/src/admin/metadata-polling.ts). Separate configuration changes from remote metadata observations.                              |
| SAML signing rollover                                                                                                             | `saml.signing_key.rollover.{started,completed,failed}`             | Not supported                                                                        | [Signing rollover](../../packages/ar-saml/src/admin/signing-rollover.ts). Emit only persisted milestones; exclude private keys.                                                                                                           |
| SAML profile defaults                                                                                                             | `saml.profile_defaults.updated`                                    | Not supported                                                                        | [Profile defaults](../../packages/ar-saml/src/admin/profile-defaults.ts).                                                                                                                                                                 |
| Generic settings changes                                                                                                          | `settings.updated`                                                 | Same name — Defined only                                                             | [Settings v2](../../packages/ar-management/src/routes/settings-v2/index.ts). Include scope, category, document ID, and revision; exclude values by default.                                                                               |
| Settings rollback                                                                                                                 | `settings.rollback.{started,completed,failed}`                     | Same names — Published                                                               | [History](../../packages/ar-management/src/routes/settings-v2/history.ts). Does not establish general `settings.updated` publication.                                                                                                     |
| OAuth/FAPI, Token Exchange, token claims, rate limits, retention, encryption, logging, storage, routing, and plugin configuration | `settings.updated` with category/scope filters                     | Dedicated category events — Not supported; generic `settings.updated` — Defined only | [Settings routes](../../packages/ar-management/src/routes/settings), [Token Exchange settings](../../packages/ar-management/src/routes/settings/token-exchange.ts). Inventory each mutation route before claiming category-wide coverage. |
| Webhook subscription lifecycle                                                                                                    | `webhook.subscription.{created,updated,deleted}`                   | Not supported                                                                        | [Webhook routes](../../packages/ar-management/src/routes/settings/webhooks.ts). Test/replay endpoints are not subscription lifecycle events.                                                                                              |
| Domain verification                                                                                                               | `domain.verification.{started,succeeded,failed}`                   | Same names — Published                                                               | [Domain mappings](../../packages/ar-management/src/routes/settings/org-domain-mappings.ts). Mapping CRUD and verification are different occurrences.                                                                                      |
| Domain mapping CRUD                                                                                                               | `domain.mapping.{created,updated,deleted}`                         | Not supported                                                                        | Same domain-mapping routes.                                                                                                                                                                                                               |
| Tenant lifecycle                                                                                                                  | `tenant.{created,updated,deleted}`                                 | Not supported                                                                        | [Tenant administration](../../packages/ar-management/src/admin-tenants.ts). Requested deletion and completed deletion need distinct milestones.                                                                                           |

### Authrim system administrators and control plane

These resources belong to Authrim's management plane. Any future subscriptions require an explicit
platform or tenant-admin authorization boundary; existing tenant account subscriptions must not
implicitly receive platform administrator or fleet information.

| Area / operation                              | Proposed names                                                                             | Current subscription status                                         | Evidence / other channel                                                                                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Administrator account changes                 | `admin.account.{updated,deleted,suspended,activated,unlocked}`                             | Not supported                                                       | [Administrators](../../packages/ar-management/src/routes/admin-management/admins.ts) writes Admin audit records. These are separate from end-user accounts.                                                                         |
| Administrator invitations                     | `admin.invitation.{created,accepted,revoked}`                                              | Not supported                                                       | [Invitations](../../packages/ar-management/src/routes/admin-management/admin-invitations.ts); Admin audit path. Candidate milestones must match persisted invitation transitions.                                                   |
| Administrator roles                           | `admin.role.{created,updated,deleted}`                                                     | Not supported                                                       | [Roles](../../packages/ar-management/src/routes/admin-management/admin-roles.ts); Admin audit path.                                                                                                                                 |
| Role assignments                              | `admin.role_assignment.{created,updated,deleted}`                                          | Not supported                                                       | Role routes and Admin audit path; distinguish role definition from membership.                                                                                                                                                      |
| Administrator policy                          | `admin.policy.{created,updated,deleted,activated}`                                         | Not supported                                                       | [Policies](../../packages/ar-management/src/routes/admin-management/admin-policies.ts); Admin audit path.                                                                                                                           |
| Admin ABAC/ReBAC/access control               | `admin.access_policy.updated`, `admin.relationship.{created,deleted}`                      | Not supported                                                       | [Admin management](../../packages/ar-management/src/routes/admin-management). Normalize actual resource ownership before finalizing these candidate names.                                                                          |
| Admin approval/elevation                      | `admin.approval.{requested,approved,denied}`, `admin.elevation.{granted,revoked,expired}`  | Not supported                                                       | [Approvals](../../packages/ar-management/src/routes/admin-management/admin-approvals.ts), [elevation access](../../packages/ar-management/src/admin-elevation-access.ts). Do not infer every candidate transition is implemented.   |
| System storage/database/routing configuration | `settings.updated` with system scope                                                       | Generic name — Defined only; dedicated system event — Not supported | [Admin management](../../packages/ar-management/src/routes/admin-management). No credentials or connection strings in proposed payloads.                                                                                            |
| Release rollout and other control operations  | `system.release.{started,completed,failed}`, `system.operation.{started,completed,failed}` | Not supported                                                       | [Control-plane operations](../../packages/ar-management/src/routes/admin-management/control-plane-operations.ts); operation persistence/audit is not subscription publication. Completion must reflect the durable operation state. |
| Permission change notifications               | `permission.{granted,revoked}`                                                             | Not supported                                                       | Existing [PermissionChangeHub](../../packages/ar-lib-core/src/services/permission-change-notifier.ts) uses a separate WebSocket path.                                                                                               |

### OAuth extensions, CIBA, RAR, and SCIM

| Area / operation                         | Proposed names                                                                                            | Current names / status                                                                                                | Evidence and limitations                                                                                                                                                                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access/refresh/ID tokens                 | `access_token.{issued,revoked,introspected}`, `refresh_token.{issued,revoked,rotated}`, `id_token.issued` | `token.access.{issued,revoked,introspected}`, `token.refresh.{issued,revoked,rotated}`, `token.id.issued` — Published | [Token endpoint](../../packages/ar-token/src/token.ts); use the detailed token catalog for other producers. Coverage is grant-path-specific.                                                                                                          |
| Batch token revocation                   | `token.revocation_batch.completed`                                                                        | `token.batch.revoked` — Published                                                                                     | [Revocation](../../packages/ar-management/src/revoke.ts). Confirm completion semantics before adopting the proposed name.                                                                                                                             |
| Token Exchange success                   | `token_exchange.succeeded` if a separate operation event is needed                                        | Dedicated event — Not supported; `token.access.issued` — Published                                                    | [Token Exchange branch](../../packages/ar-token/src/token.ts) emits `grantType = urn:ietf:params:oauth:grant-type:token-exchange`. Generic issuance is not a dedicated exchange event.                                                                |
| Token Exchange rejection/failure         | `token_exchange.failed`                                                                                   | Not supported                                                                                                         | [Token endpoint](../../packages/ar-token/src/token.ts), [Native SSO exchange](../../packages/ar-token/src/native-sso-token-exchange.ts). Diagnostic logging is not a subscription event.                                                              |
| CIBA request creation                    | `ciba.request.created`                                                                                    | Same name — Published                                                                                                 | [CIBA authorization](../../packages/ar-async/src/ciba-authorization.ts); direct string publisher, not a shared constant.                                                                                                                              |
| CIBA approval/denial                     | `ciba.request.{approved,denied}`                                                                          | Not supported                                                                                                         | [Approve](../../packages/ar-async/src/ciba-approve.ts), [deny](../../packages/ar-async/src/ciba-deny.ts). CIBA client notification endpoints are protocol callbacks, not Admin webhook subscriptions.                                                 |
| CIBA request expiration/token completion | `ciba.request.{expired,completed}`                                                                        | Dedicated events — Not supported                                                                                      | [Async service](../../packages/ar-async/src), [token endpoint](../../packages/ar-token/src/token.ts). Approval, token issuance, and completion are distinct milestones.                                                                               |
| RAR validation/authorization outcome     | `authorization.request.{accepted,rejected}` with authorization-details context                            | Dedicated RAR events — Not supported                                                                                  | [Authorize](../../packages/ar-auth/src/authorize.ts), [RAR validation](../../packages/ar-lib-core/src/utils/rar-validation.ts). RAR is request data, not an independently persisted account/resource. Candidate events need an explicit commit point. |
| RAR consent and token issuance           | Existing consent and token event families                                                                 | Related consent/token paths — Published; dedicated RAR event — Not supported                                          | [Consent](../../packages/ar-auth/src/consent.ts), [token endpoint](../../packages/ar-token/src/token.ts). Does not promise authorization-details payloads or RAR-specific filters. Do not copy sensitive authorization details wholesale.             |
| Device authorization lifecycle           | `device_authorization.request.{created,approved,denied,expired}`                                          | Not supported                                                                                                         | [Device authorization](../../packages/ar-async/src/device-authorization.ts), [verification](../../packages/ar-async/src/device-verify-api.ts). Generic issued-token events are separate.                                                              |
| SCIM users                               | `scim.user.{created,replaced,patched,deleted}`                                                            | `scim.user.{create,replace,patch,delete}` — Defined only for subscriptions                                            | [SCIM audit](../../packages/ar-lib-scim/src/utils/scim-audit.ts) uses the current vocabulary. Account outbox events may also occur for resulting canonical mutations.                                                                                 |
| SCIM groups                              | `scim.group.{created,replaced,patched,deleted}`                                                           | `scim.group.{create,replace,patch,delete}` — Defined only for subscriptions                                           | SCIM audit channel; group changes are not account lifecycle changes.                                                                                                                                                                                  |
| SCIM bulk                                | `scim.bulk.completed`                                                                                     | `scim.bulk.execute` — Defined only for subscriptions                                                                  | SCIM audit channel. Completion must include per-operation success/failure counts, not imply all succeeded.                                                                                                                                            |
| SCIM tokens                              | `scim.token.{created,revoked}`                                                                            | `scim.token.{create,revoke}` — Defined only for subscriptions                                                         | [SCIM tokens](../../packages/ar-management/src/scim-tokens.ts), SCIM audit vocabulary; never emit bearer tokens.                                                                                                                                      |
| SCIM configuration                       | `settings.updated` with SCIM category                                                                     | Generic name — Defined only; dedicated event — Not supported                                                          | [SCIM settings](../../packages/ar-management/src/scim-settings.ts).                                                                                                                                                                                   |

### Agent and verifiable credentials

| Area / operation        | Proposed names                                    | Current subscription status | Evidence / boundary                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent registration      | `agent.registration.{created,updated,deleted}`    | Not supported               | [Agent access](../../packages/ar-agent-access/src), [agent management](../../packages/ar-management/src/routes/admin-management). Human account outbox excludes machine subjects. Candidate names do not establish a new registration API. |
| Agent delegation/grants | `agent.delegation.{granted,revoked,expired}`      | Not supported               | [Agent grants](../../packages/ar-management/src/routes/admin-management/agent-grants.ts) persists grant/audit information. Existing grants must be mapped to the proposed delegation resource before naming is finalized.                  |
| Agent execution         | `agent.execution.{started,completed,failed}`      | Not supported               | Agent access runtime. Operation/checkpoint records do not establish webhook publication.                                                                                                                                                   |
| VC offers               | `vc.offer.{created,expired}`                      | Not supported               | [Offers](../../packages/ar-vc/src/issuer/routes/offer.ts); expiration candidate requires an authoritative transition/observer.                                                                                                             |
| VC issuance             | `vc.credential.issued`, `vc.issuance.failed`      | Not supported               | [Credential issuance](../../packages/ar-vc/src/issuer/routes/credential.ts), [deferred issuance](../../packages/ar-vc/src/issuer/routes/deferred.ts). Failed issuance may have no credential ID.                                           |
| VC status / revocation  | `vc.credential.revoked`, `vc.status_list.updated` | Not supported               | [Status list](../../packages/ar-vc/src/issuer/routes/status-list.ts). A status-list HTTP route alone is not evidence of an implemented revoke operation or observer.                                                                       |
| VC presentation request | `vc.presentation.requested`                       | Not supported               | [Verifier authorization](../../packages/ar-vc/src/verifier/routes/authorize.ts).                                                                                                                                                           |
| VC presentation outcome | `vc.presentation.{verified,rejected}`             | Not supported               | [Verifier response](../../packages/ar-vc/src/verifier/routes/response.ts). Transport errors and cryptographic/claim verification rejection need distinct reason codes.                                                                     |

Security and domain-verification events already enumerated in the current catalog remain in scope.
For security names, retain `security.rate_limit.exceeded`, consider
`security.credential_stuffing.detected` for the declared suspicious-activity name, and use
`account.{locked,unlocked}` for actual account state transitions. Their current publication statuses
remain those in the catalog; these naming suggestions do not add publishers.

### Implementation tracking and migration requirements

Before implementing or renaming a row, expand it into one record per concrete event with:

- Current and proposed name, decision state (proposed/accepted/deprecated), and payload schema version.
- Owning resource and producer, exact commit point, triggering routes/jobs, and known missing paths.
- Publication status, delivery mechanism, retry/replay guarantees, and route/state-transition tests.
- Permitted subscription scope, actor/subject distinction, explicitly selected payload fields, and supported filters.
- Compatibility mapping for saved subscriptions, in-flight outbox entries, receiver payload types,
  and historical delivery/replay records. A pattern alias alone does not migrate the emitted `type`.

Keep a machine-readable catalog as a follow-up implementation option, with generated documentation
and checks for undeclared publishers. Static checks cannot prove complete emission across all routes;
behavior tests must establish that. The account normalization and [selected snapshots](#selected-account-snapshots) are implemented;
other proposed renames and missing publishers are not implemented by this inventory. Agree on the vocabulary, payload/filter contract, and compatibility policy before
changing current event names.

## Event data

The following lists the shared payload fields and event-specific additions. Optional fields depend
on the emitting path. The [shared event data types](../../packages/ar-lib-core/src/types/events/event-types.ts)
provide field types; the linked producers are the source of truth for concrete payloads.

| Event family                                      | `data` fields and interpretation                                                                                                                                                                                                                                  | Example producer                                                                                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.*`                                          | `method`, `clientId`; successful paths can include `userId`, `sessionId`; failures can include `errorCode`, `usernameHash`, `ipHash`, `userAgent`, `connectorId`, `requestId`. Do not require a user ID on failure.                                               | [Passkey](../../packages/ar-auth/src/passkey.ts), [directory password](../../packages/ar-auth/src/directory-password-login.ts)                                                    |
| `session.*`                                       | `sessionId`, `userId`; creation can include `ttlSeconds`; destruction can include `reason`.                                                                                                                                                                       | [Logout](../../packages/ar-auth/src/logout.ts)                                                                                                                                    |
| `token.access.*`, `token.refresh.*`, `token.id.*` | `clientId`, with optional `jti`, `userId`, `scopes`, `expiresAt`, `grantType`. These are token metadata, not raw token credentials.                                                                                                                               | [Token issuance](../../packages/ar-token/src/token.ts), [revocation](../../packages/ar-management/src/revoke.ts), [introspection](../../packages/ar-management/src/introspect.ts) |
| `token.batch.revoked`                             | A batch token-revocation request was processed.                                                                                                                                                                                                                   | [Batch revocation](../../packages/ar-management/src/revoke.ts)                                                                                                                    |
| `consent.*`                                       | Shared fields: `userId`, `clientId`, `scopes`. Version changes can include previous/new privacy-policy and TOS versions; revocation can include `revocationReason`, `initiatedBy`. Item events have their own item details.                                       | [Consent decisions](../../packages/ar-auth/src/consent.ts), [revocation](../../packages/ar-management/src/user-consents.ts)                                                       |
| Subscription `user.logout`                        | `userId`, `sessionId`, `reason` where provided. Different from the dedicated logout callback below.                                                                                                                                                               | [Logout](../../packages/ar-auth/src/logout.ts)                                                                                                                                    |
| `client.*`                                        | `clientId`. Configuration operations may include additional operation-specific details.                                                                                                                                                                           | [Admin clients](../../packages/ar-management/src/admin-clients.ts), [RFC 7592 configuration](../../packages/ar-management/src/client-config.ts)                                   |
| `security.rate_limit.exceeded`                    | A request exceeded the configured rate limit.                                                                                                                                                                                                                     | [Rate limiting](../../packages/ar-lib-core/src/middleware/rate-limit.ts)                                                                                                          |
| `domain.verification.*`                           | `mappingId`, `orgId`, `verificationMethod`; optional `domain`, `errorMessage`.                                                                                                                                                                                    | [Domain mappings](../../packages/ar-management/src/routes/settings/org-domain-mappings.ts)                                                                                        |
| `settings.rollback.*`                             | `category`, `targetVersion`, with optional `currentVersion`, `actorId`, `changeSource`, `errorMessage`.                                                                                                                                                           | [Settings history](../../packages/ar-management/src/routes/settings-v2/history.ts)                                                                                                |
| `auth.email_verification_protocol.succeeded`      | `userId`, `method: "email_verification_protocol"`, `clientId`.                                                                                                                                                                                                    | [Direct Auth](../../packages/ar-auth/src/direct-auth.ts)                                                                                                                          |
| `ciba.request.created`                            | `auth_req_id`, `client_id`, `delivery_mode`, `expires_at`; optional `login_hint`, `binding_message`, `user_code`. These can contain user-supplied or authentication-related information; they are not covered by the account events' no-profile-values guarantee. | [CIBA](../../packages/ar-async/src/ciba-authorization.ts)                                                                                                                         |

The declared `ScimEventData` shape contains `resourceType`, `resourceId`, optional `externalId`,
`tokenHash`, `ipHash`, `userAgent`, and optional bulk counts (`total`, `succeeded`, `failed`).
It does not establish a subscription webhook delivery contract for the SCIM audit vocabulary.

## Account lifecycle notifications

Subscribe a **tenant-scoped** webhook to `account.*` (or individual patterns) in Admin > Webhooks.
These durable notifications cover human accounts (`account_type = user`), including guest accounts.
Client-scoped subscriptions do not receive these tenant-wide account notifications.

| Event                          | Trigger                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `account.created`              | Human account completed directory activation; registration state identifies guest/registered.                      |
| `account.updated`              | Account, profile, contact, custom profile, or guest-retention data changed.                                        |
| `account.deleted`              | Account deletion completed, including authentication and guest-cleanup fences.                                     |
| `account.registration.changed` | Committed registration-state transition, with previous/current state. No downgrade API is introduced.              |
| `account.email.changed`        | Canonical primary email changed, or identifier replacement completed. Selected fields provide before/after values. |

Only the canonical names above are published. There is no alias lookup or legacy wire format for
`account.guest.*`, `account.registered.*`, `account.registration.promoted`, or
`account.registration.demoted`. The operation-specific `user.created`, `user.updated`, and
`user.deleted` events are no longer delivered to webhook subscriptions. Their internal handler and
audit vocabulary is unchanged.

Saved subscriptions to removed names must be explicitly reconfigured. They are not automatically
mapped to new names. Pending outbox rows using removed event names produce no subscription
notification and can be marked handled; this release does not backfill them under a new name.
Use `account.created`, `account.updated`, or `account.deleted` with
`registrationStates: ["guest"]` or `["registered"]` to replace state-specific subscriptions. Use
`account.registration.changed` with the resulting registration state to distinguish promotion from
demotion. Historical delivery records do not change their recorded event names.

An example event body (using the existing webhook envelope and signing protocol):

```json
{
  "id": "evt_0123456789abcdef0123456789abcdef",
  "type": "account.registration.changed",
  "timestamp": "2026-09-11T09:00:00.000Z",
  "tenantId": "tenant-example",
  "data": {
    "userId": "user-example",
    "registration_state": "registered",
    "previous_registration_state": "guest",
    "changed_fields": ["registration_state"]
  }
}
```

`userId` is the internal user identifier; do not assume it equals a client's pairwise OIDC `sub`.
`previous_registration_state` is null except for promotion/demotion.
`changed_fields` contains broad invalidation categories (`account`, `profile`, `contact`,
`custom_profile`, `email`, or `registration_state`), not attribute values. It is empty for creation/deletion.
By default, no email or profile values are included. Explicit selection adds email snapshots for
email changes and deletion as described in [Selected account snapshots](#selected-account-snapshots). Passwords and credentials are never selectable.

### Selected account snapshots

Decision: option A, per-subscription field selection. Configure `payloadFields` with any subset of
`email` and `registration_state`. An empty array (the default for existing subscriptions) adds no
snapshot fields. Selectable fields currently apply to `account.email.changed` and account deletion;
other account events retain their metadata payload. This is an allow-list, not an arbitrary profile
or custom-claim export. `email` means the canonical primary email, not every secondary contact.

`registrationStates` filters account events to `guest` and/or `registered`; an empty array accepts
both. Filtering uses the event’s resulting `registration_state`: a guest-to-registered transition
matches `registered`, and the reverse matches `guest`. Select both states to receive both transitions.
Other event families are unaffected. Subscription create/update/get/list support both fields.
Admin > Webhooks supports choosing fields and states at creation and editing them per destination.

```json
{
  "name": "Email integration",
  "url": "https://example.com/account-events",
  "secret": "replace-with-your-webhook-signing-secret",
  "events": ["account.email.changed", "account.deleted"],
  "payloadFields": ["email", "registration_state"],
  "registrationStates": ["registered"]
}
```

Selected account fields require tenant-scoped subscriptions. In addition to normal webhook management
permission, configuration requires `admin:webhooks:payload:read`. Changing a destination that already
selects account fields also requires that permission, including changes to its URL or active state.
Normal subscription delivery requires a configured signing secret; a missing secret defers durable
account delivery. Secret material is never selectable. This does not authorize platform-admin data export.

The existing envelope and `userId` identifier are preserved. `userId` is the internal user identifier;
`account_id` is the canonical account ID. Neither is promised to equal a client's pairwise OIDC `sub`.
Illustrative `data` for `account.email.changed` when email is selected:

```json
{
  "userId": "user_example",
  "account_id": "account_example",
  "registration_state": "registered",
  "previous_registration_state": null,
  "changed_fields": ["email"],
  "changes": {
    "email": { "before": "old@example.com", "after": "new@example.com" }
  }
}
```

If `registration_state` is also selected for an email event,
`changes.registration_state` contains the same captured state in `before` and `after`; the email event
does not itself indicate a registration-state transition.

Illustrative `data` for `account.deleted` with both fields selected:

```json
{
  "userId": "user_example",
  "account_id": "account_example",
  "registration_state": "registered",
  "previous_registration_state": null,
  "changed_fields": [],
  "before": { "email": "last@example.com", "registration_state": "registered" },
  "after": null
}
```

Email snapshots commit in the PII database with canonical email writes. Identifier-replacement
completion also captures the old/new values from operation history in its completion transaction,
including the scheduled recovery path and SCIM replacement. Admin deletion/anonymization, SCIM
deletion, and expired-guest cleanup capture the last active email before erasing PII and completing
Core deletion. If snapshot persistence fails, that PII erasure does not proceed. Repeating deletion
does not replace the saved snapshot. An email already removed before account deletion is represented
as JSON `null`, not its former value. Delivery still waits for the existing authentication and guest-cleanup fences. No selected PII enters the Core
account outbox, internal event handlers, or dispatcher audit data.

Snapshots expire seven days after capture. Scheduled PII maintenance clears email values at/after
expiry; the delivery path enforces expiry even if maintenance has not yet run or cleanup fails.
Cleanup failure in one PII store is logged without preventing the remaining stores from being scanned
or preventing outbox delivery attempts. This isolation does not bypass snapshot availability or expiry
checks when a destination selects fields. A selected snapshot that is missing, malformed, or expired fails delivery explicitly, without falling back to current
account data or inventing a null old value. Metadata/tombstones can remain for idempotency and pending
notification recovery. Undelivered metadata is not a reason to retain email values indefinitely.

Automatic retries use the same event snapshot. The first selected attempt freezes fields and the
endpoint URL; changed selections/destinations cannot redirect or expand that attempt. A subscription
configuration newer than the event cannot receive that historical email/deletion notification,
including when its selected fields have been cleared. Configuration changes can therefore prevent
old pending account notifications from completing, even for a name-only edit because the guard uses
the subscription’s `updatedAt`. Provision the subscription before generating the events it must
receive. Empty fields omit snapshots, and explicit null means an absent email value or a deleted account. This snapshot mechanism does not add a new
manual replay API: the existing delivery-history replay endpoint still requires its own retained
request artifact and is not a general account-outbox replay interface.

### Account delivery and consumers

Core database triggers append the notification in the same transaction as the relevant Core write.
PII-only custom profile writes persist their notification in the same PII database batch as the
values. Scheduled delivery scans both Core and PII outboxes. The registration state is observed
from Core before the PII batch; these databases do not share a transaction. Other canonical profile
and contact writes notify on their Core reference update; if a request fails between its PII and
Core writes, retry the request to complete that update. Guest deadline, upgrade-hold, and retention
policy changes also produce `account.updated` invalidations with `registration_state: guest`.
There is no historical backfill when installing this migration.

Management's five-minute admin-job schedule (`*/5 * * * *`) and six-hour maintenance schedule
(`0 */6 * * *`) scan tenant Core and PII shards and deliver pending notifications with
bounded batches of up to 20 eligible rows per store and tenant. Delivery is asynchronous and follows
the configured schedules and tenant pagination; it is not an immediate request callback. Failed
account events remain pending with a fixed exponential backoff starting at 30 seconds and capped at
one hour. These are earliest retry times, not promised delivery times. The account outbox currently
does not use a subscription’s `retryPolicy` to limit attempts or choose its backoff.
A worker interruption releases the delivery lease after 15 minutes. Successfully handled records are
retained for 30 days. Unsuccessful records are not pruned.

Delivery is **at least once**, with the same event `id` and `timestamp` on retries. Consumers must
idempotently handle duplicates. A retry reevaluates all matching destinations: if one destination
failed, a destination that already acknowledged the same event can receive it again. Multiple writes
in one operation can produce multiple update events;
updates are invalidations, not a complete ordered change-data stream. There is no global ordering
promise. Fetch current authorized account data when reconciling updates. A `2xx` response acknowledges
delivery. Subscriptions are evaluated at delivery time; an event with no eligible subscription is
considered handled. Disabled subscriptions are excluded; attempts skipped because a signing secret is missing remain
pending for retry.

For deletion, the event is persisted before the account can disappear. Delivery waits for the
SessionRevocationStore to report `deleted`, and for an in-progress guest deletion phase to finish.
A deletion event’s timestamp records the Core mutation, not the HTTP delivery time. Core D1 triggers
and email-replacement publication preserve milliseconds so a subscription created earlier in the same
second is not incorrectly treated as newer than the event.

`deletion_due_at` is deletion eligibility, not confirmation. Passing that timestamp while the account
is still a guest does not prove deletion completed: upgrade holds, legal holds, an upgrade race, or
maintenance delay can defer deletion. A service may apply its own independent retention policy, but
should use `account.deleted` with a guest registration-state filter to synchronize deletion with Authrim.

### Account migration prerequisites

Apply these migrations to the corresponding D1 or PostgreSQL stores before activating the changed
Workers:

| Stream | Required migrations                                                   |
| ------ | --------------------------------------------------------------------- |
| Core   | `005_account_webhook_outbox.sql`, `006_webhook_payload_fields.sql`    |
| PII    | `003_account_webhook_outbox.sql`, `004_account_webhook_snapshots.sql` |

Apply them to every assigned store, not only the tenant’s default database. Subscriptions are read
from the tenant’s default Core store; account events and snapshots can reside on other assigned Core
and PII stores. PostgreSQL Core migration `006` also creates the subscription configuration table
when it is absent from the earlier baseline.

Use the matching Setup/Control migration renderer: Core D1 `005` uses
`__AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__` for event timestamps. Do not execute the unrendered SQL
or substitute the legacy second-truncated millisecond expression. The existing time placeholders
retain their previous rendering so historical migration behavior is unchanged.

The development draft manifest includes these migrations; published release artifacts are prepared
only at the release boundary. No new queue payload schema or webhook signing scheme is introduced.

## Test and logout callbacks

### Test callback

`POST /api/admin/webhooks/:id/test` sends directly to that configured endpoint. It is not a normal
subscription event, does not use the five-field subscription envelope, and does not prove that a
particular business operation publishes an event.

```json
{
  "event": "webhook.test",
  "webhook_id": "webhook-example",
  "tenant_id": "tenant-example",
  "timestamp": "2026-09-11T09:00:00.000Z",
  "test": true,
  "data": { "message": "This is a test webhook delivery" }
}
```

The test route also sends `X-Authrim-Event: webhook.test` and `X-Authrim-Webhook`.
It signs when the configured secret can be decrypted. Check signature configuration as well as
connectivity when testing. See the [test handler](../../packages/ar-management/src/routes/settings/webhooks.ts).

### Dedicated client logout callback

Client `logout_webhook_uri` configuration uses a separate simple JSON notification:

```json
{
  "event": "user.logout",
  "iat": 1789117200,
  "client_id": "client-example",
  "issuer": "https://issuer.example.com",
  "sub": "user-example",
  "sid": "session-example"
}
```

`sub` and `sid` are conditional on logout webhook configuration. This callback has no subscription
event `id`, `type`, `tenantId`, or `data` envelope. It has its own retry/deduplication handling and
must not be confused with subscription `user.logout`. OIDC Back-Channel Logout is another separate
protocol using a logout token, not either JSON format above.
See [logout sender](../../packages/ar-lib-core/src/services/logout-webhook-sender.ts)
and [logout types](../../packages/ar-lib-core/src/types/logout.ts).

## Delivery behavior

| Path                                  | Delivery behavior                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ordinary published subscription event | The dispatcher attempts HTTP delivery during publication. Many callers log/catch publication errors. Do not assume durable retries or complete operation coverage. |
| `account.*`                           | Persisted outbox, scheduled retries, stable event ID/time, at-least-once handling as described above.                                                              |
| Test callback                         | A direct diagnostic HTTP request.                                                                                                                                  |
| Dedicated logout callback             | Its own bounded retry policy and KV duplicate suppression.                                                                                                         |
| Audit/log HTTP destination            | A separate logging delivery/retry/DLQ system, not the Admin subscription stream.                                                                                   |

A successful HTTP response acknowledges delivery. Configure receivers to process idempotently and
return promptly. Subscription matching occurs at delivery time. Manual replay depends on retained
delivery data and the replay endpoint's permissions and validation; it is not a substitute for a
durable publisher. Do not generalize the account outbox's retention or retry guarantees to other
notification paths. Inspect [delivery/replay APIs](../../packages/ar-management/src/routes/settings/webhooks.ts)
for the available diagnostics and replay contract.
