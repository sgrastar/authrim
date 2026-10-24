# Identity mapping: from implicit application to an explicit choice

An OIDC app (an `oauth_clients` row) is bound to an identity mapping by a **name**, never by a
lookup. The Mapping Set that applies to its ID token, its UserInfo and the fields its consent
screen asks about is, in this order:

1. the app's own choice (`identity_mapping`: `{"fieldMappingSetId": "..."}`), or
   `{"mode": "none"}` for an app that takes no mapping at all. An app names a Mapping Set its tenant
   owns; a Mapping Set the platform owns reaches an app through the tenant default or the platform
   default, not by the app naming it (the Admin API refuses that until the tenant backup can carry
   the reference; see `platform-mapping-sets.md`);
2. the tenant's default (`identity_mapping.oidc_default_set_id` of the tenant, or `none` to refuse
   the platform's default too);
3. the platform's default (`identity_mapping.oidc_default_set_id` of the platform);
4. none: no mapping applies, and the app's claims are what its scopes release.

Only a level that is **unset** falls to the next one. A level that is set and cannot be used (the
Mapping Set was deleted, is not active, its Destination Profile is not one OIDC profile, the value
is not a Mapping Set ID, or the settings cannot be read) **fails** the request: no ID token is
issued (`invalid_client`, or `server_error` for a database or settings that cannot be read),
UserInfo answers `invalid_client_metadata` or `server_error`, and the sign-in page cannot be
shown. It never becomes another level's answer, and it never becomes "no mapping".

An activation of a Mapping Set does not decide which apps it applies to. Before this change, an
activation whose scope fit an OIDC call (the admin console sends `{"kind":"tenant"}`, which fits
every call) was applied to every app that named no Mapping Set. That is gone for OIDC. Activating a
Mapping Set only says that it can be used; to make it apply, name it (on the app, as the tenant
default, or as the platform default).

## What changes in a running environment

| Situation (app names no Mapping Set)                             | Before                                                                                               | After                                                                                                                    |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| The tenant has an activation that fits every OIDC call           | That Mapping Set applied to the app (ID token, UserInfo and consent could each differ by the Worker) | Nothing applies, unless the tenant or the platform names a default                                                       |
| No activation                                                    | Nothing applied                                                                                      | Nothing applies                                                                                                          |
| The Admin database cannot be read (not bound, no table, error)   | The request went on without the mapping and logged `identity_mapping_resolution_swallowed`           | Nothing is looked up for an app bound to nothing, so nothing fails; a **named** Mapping Set fails without DB_ADMIN       |
| The tenant names a default, or the app names a Mapping Set       | Only the app's own choice was read                                                                   | The named set applies in every Worker; one that cannot be used fails the request                                         |
| The app's `identity_mapping` holds only a `destinationProfileId` | That Destination Profile held the claims and set the fields the consent screen asked about           | **Fails** the request (`invalid_client`), so its profile's gate is not dropped in silence. Fix it first: see Statement 3 |

Other protocols are not changed by this: SAML, Introspection, VC and SCIM keep their own ways of
naming a mapping (a Mapping Set on the provider or profile, or the older lookups that are still in
place for Introspection and VC).

Every Worker that releases claims (authorization, token, UserInfo, and the sign-in page) needs
`SETTINGS` and `DB_ADMIN` bound. A selection of **none** reads neither the Admin database nor the
tenant database for a mapping, so an app bound to nothing is answered the same in every Worker.

## Before you deploy: what applied until now

Run the statements below on each environment and keep the output with the date: it is the record
of which mapping applied to which app before the choice was made explicit. Nothing here writes;
every statement is a `SELECT`.

- **Statement 1** lists the active activations that can reach an OIDC app, and the Destination
  Profile each brings. A row with `wins_for_apps_without_a_choice = 1` is the Mapping Set that
  applied to every app of that tenant that named none. A row with `wins_for_named_app = 1` is an
  app bound by a client-scoped activation. **After this change neither applies.**
- **Statement 2** counts, per tenant, the apps that name no Mapping Set, and splits them by what
  applied to them.
- **Statement 3** lists app selectors that the new rules read differently (see below).

An environment that is used only for conformance testing normally has no activation that wins, and
needs no tenant default: with nothing named, no mapping applies, which is what it should do.

### Moving what applied before to an explicit default

The change does not convert anything for you: an activation that bound the apps of a tenant by
accident should not become a setting by accident. For each tenant whose row in Statement 1 was
**wanted**, name that Mapping Set as the tenant default. The bulk apply API takes several tenants at
once and checks the same things a single save does (the Mapping Set exists, is active, has one OIDC
Destination Profile). Preview first; it writes nothing and reports, per tenant, what is in force now,
what would be written, and how many apps follow the default (`impact`).

```sh
curl -sS -X POST "$ISSUER/api/admin/settings/bulk-apply" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "mode": "preview",
    "tenant_ids": ["tenant-a", "tenant-b"],
    "changes": [{
      "category": "identity-mapping",
      "set": { "identity_mapping.oidc_default_set_id": "<mapping set id>" }
    }]
  }'
```

Read the answer, then repeat the request with `"mode": "apply"` (and, to refuse a write if a
tenant's settings changed since the preview, `"expected"` with the `version` the preview returned).
A tenant that already has a default of its own is skipped unless `"on_existing_override":
"overwrite"` is given. A Mapping Set owned by the platform can be named for tenants this way; to
make one the default of every tenant that names none, set the platform's default instead
(`PATCH /api/admin/platform/settings/identity-mapping`).

For an app that must **not** follow the default (a conformance client, say), save
`"identity_mapping": {"mode": "none"}` on the app. An app with `identity_mapping` unset follows
the default; `{"mode": "none"}` does not, and the two must not be mixed up.

To check what an app is bound to, and why, ask the admin API that runs the same selection as the
runtime: `GET /api/admin/identity-mapping/effective?client_id=<client id>`.

**After the switch**, an implicit application that stopped working shows up there too. When
nothing is named for the tenant (`selection.reason` is `no_default`) and the tenant still has an
active activation that fits an OIDC call, the answer carries a warning:

```json
"warnings": [{ "code": "implicit_activation_no_longer_applies",
               "activations": [{ "activationId": "...", "setId": "...", "setName": "..." }] }]
```

It names the activations and their Mapping Sets (IDs and names only) that once applied to the
apps naming no Mapping Set, and no longer do. Name the set as the tenant default to keep what it
did, or leave it unset on purpose (the warning goes away when a default, or the tenant's `none`, is
saved). `warnings_unavailable: true` means the Admin database could not be read for the check. The
preview of the bulk apply gives the same warning per tenant in `impact.warnings`, and counts in
`impact.apps_with_unusable_choice` the apps whose selector names only a Destination Profile
(Statement 3), which fail rather than follow the default; `impact.apps_with_own_set` and
`impact.apps_opted_out` count the apps the change leaves alone. The operator's list of every
tenant (`GET /api/admin/platform/identity-mapping/tenants`) gives the same source and counts per
tenant, before and after.

## How the old lookup picked an activation (what Statements 1 and 2 reproduce)

Until this change, for an OIDC call that named no Mapping Set the lookup used the tenant,
protocol `oidc`, role `op` and the app's client id. It takes the tenant's activations in state `active`, scores each by the scope fields it has,
drops one whose scope disagrees with the call, and uses the best:

| Scope field                                                                                    | Disagrees with an OIDC call when                  | Score |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----- |
| `tenantId` (or `id`)                                                                           | it is another tenant                              | 1     |
| `protocol`                                                                                     | it is not `oidc`                                  | 2     |
| `role`                                                                                         | it is not `op`                                    | 4     |
| `clientId`, `partnerEntityId`, `spEntityId`, `rpClientId`                                      | it is not the app's client id                     | 16    |
| `localEntityId`, `providerId`, `credentialProfileId`, `credentialConfigurationId`, `direction` | it is set at all (an OIDC call has none of these) | -     |

A scope with none of these fields scores 0 and still fits. Ties go to the activation activated
last. An activation that names the app by client id always outranks one that does not (16 is more
than tenant, protocol and role add up to). If the best activation has no active compiled snapshot,
the lookup returns no mapping (it does not fall back to the next one). An app that named a Mapping Set was not affected: its lookup was
limited to that Mapping Set. Introspection, VC and SAML (without a Mapping Set on the provider)
still use this lookup.

## Statement 1: active activations that can reach an OIDC app (Admin database)

These are the activations the old lookup would have applied. Run it on the Admin database
(`DB_ADMIN`).

```sql
-- runbook: reachable-activations
WITH act AS (
  SELECT a.tenant_id, a.id AS activation_id, a.field_mapping_set_id AS set_id,
         a.field_mapping_version_id AS version_id, a.activated_at, a.created_at,
         a.activation_scope_json AS scope_json,
         CASE WHEN json_valid(a.activation_scope_json) THEN a.activation_scope_json ELSE '{}' END AS scope
    FROM field_mapping_activations a
    JOIN field_mapping_versions v
      ON v.tenant_id = a.tenant_id
     AND v.field_mapping_set_id = a.field_mapping_set_id
     AND v.id = a.field_mapping_version_id
   WHERE a.lifecycle_state = 'active'
),
sc AS (
  SELECT act.*,
         COALESCE(NULLIF(json_extract(scope, '$.tenantId'), ''), NULLIF(json_extract(scope, '$.id'), '')) AS scope_tenant,
         NULLIF(json_extract(scope, '$.kind'), '') AS scope_kind,
         NULLIF(json_extract(scope, '$.protocol'), '') AS scope_protocol,
         NULLIF(json_extract(scope, '$.role'), '') AS scope_role,
         COALESCE(NULLIF(json_extract(scope, '$.clientId'), ''), NULLIF(json_extract(scope, '$.client_id'), '')) AS scope_client,
         COALESCE(NULLIF(json_extract(scope, '$.partnerEntityId'), ''), NULLIF(json_extract(scope, '$.partner_entity_id'), ''),
                  NULLIF(json_extract(scope, '$.spEntityId'), ''), NULLIF(json_extract(scope, '$.rpClientId'), '')) AS scope_partner,
         COALESCE(NULLIF(json_extract(scope, '$.localEntityId'), ''), NULLIF(json_extract(scope, '$.local_entity_id'), ''),
                  NULLIF(json_extract(scope, '$.providerId'), ''), NULLIF(json_extract(scope, '$.provider_id'), ''),
                  NULLIF(json_extract(scope, '$.credentialProfileId'), ''), NULLIF(json_extract(scope, '$.credential_profile_id'), ''),
                  NULLIF(json_extract(scope, '$.credentialConfigurationId'), ''), NULLIF(json_extract(scope, '$.credential_configuration_id'), ''),
                  NULLIF(json_extract(scope, '$.direction'), '')) AS scope_other
    FROM act
),
rc AS (
  SELECT sc.*,
         CASE
           WHEN (scope_tenant IS NOT NULL AND scope_tenant <> tenant_id)
             OR (scope_protocol IS NOT NULL AND scope_protocol <> 'oidc')
             OR (scope_role IS NOT NULL AND scope_role <> 'op')
             OR scope_other IS NOT NULL
             OR (scope_client IS NOT NULL AND scope_partner IS NOT NULL AND scope_client <> scope_partner)
           THEN 'never'
           WHEN COALESCE(scope_client, scope_partner) IS NOT NULL THEN 'one_client'
           ELSE 'every_client'
         END AS reach,
         (scope_tenant IS NOT NULL) * 1 + (scope_protocol IS NOT NULL) * 2 + (scope_role IS NOT NULL) * 4
           + (scope_client IS NOT NULL) * 16 + (scope_partner IS NOT NULL) * 16 AS score
    FROM sc
),
rk AS (
  SELECT rc.*,
         ROW_NUMBER() OVER (PARTITION BY tenant_id, reach, COALESCE(scope_client, scope_partner, '') ORDER BY score DESC, activated_at DESC, created_at DESC) AS position_in_reach
    FROM rc
),
refs AS (
  SELECT DISTINCT rk.tenant_id, rk.activation_id,
         COALESCE(NULLIF(json_extract(e.target_ref_json, '$.profileId'), ''), NULLIF(json_extract(e.target_ref_json, '$.profile_id'), '')) AS ref
    FROM rk
    JOIN mapping_rules r ON r.tenant_id = rk.tenant_id AND r.field_mapping_version_id = rk.version_id
    JOIN mapping_rule_edges e ON e.tenant_id = r.tenant_id AND e.rule_id = r.id
   WHERE json_valid(e.target_ref_json)
     AND COALESCE(NULLIF(json_extract(e.target_ref_json, '$.side'), ''), 'destination') = 'destination'
  UNION
  SELECT tenant_id, activation_id, NULLIF(json_extract(scope, '$.destinationProfileId'), '') FROM rk
),
prof AS (
  SELECT refs.tenant_id, refs.activation_id, refs.ref, dp.id AS profile_id, dp.destination_type, dpv.schema_json
    FROM refs
    LEFT JOIN destination_profiles dp
      ON (dp.id = refs.ref OR dp.id = CASE WHEN refs.ref LIKE 'destination-profile-%' THEN substr(refs.ref, 21) END)
     AND dp.tenant_id IN (refs.tenant_id, 'platform')
    LEFT JOIN destination_profile_versions dpv
      ON dpv.id = dp.active_version_id AND dpv.profile_id = dp.id AND dpv.tenant_id = dp.tenant_id
   WHERE refs.ref IS NOT NULL
),
fields AS (
  SELECT prof.activation_id, prof.destination_type,
         CASE WHEN prof.destination_type = 'saml' THEN json_extract(j.value, '$.name') ELSE json_extract(j.value, '$.claimName') END AS field_name,
         CASE
           WHEN prof.destination_type = 'saml' THEN 1
           WHEN json_type(j.value, '$.required') = 'true' OR json_extract(j.value, '$.claimName') = 'sub' THEN 0
           ELSE 1
         END AS is_optional,
         CASE
           WHEN prof.destination_type = 'oidc' AND COALESCE(json_array_length(j.value, '$.surfaces'), 0) > 0
            AND NOT EXISTS (SELECT 1 FROM json_each(j.value, '$.surfaces') s WHERE s.value = 'id_token')
           THEN 1 ELSE 0
         END AS not_in_id_token
    FROM prof,
         json_each(CASE WHEN json_valid(prof.schema_json) THEN prof.schema_json ELSE '{}' END,
                   CASE WHEN prof.destination_type = 'saml' THEN '$.attributes' ELSE '$.claims' END) j
   WHERE j.type = 'object'
)
SELECT rk.tenant_id, rk.activation_id, rk.set_id,
       s.field_mapping_key AS set_key, s.display_name AS set_name, s.lifecycle_state AS set_state,
       v.version_label, rk.scope_json, rk.scope_kind, rk.reach,
       COALESCE(rk.scope_client, rk.scope_partner) AS target_client_id,
       CASE WHEN rk.reach = 'every_client' AND rk.position_in_reach = 1 THEN 1 ELSE 0 END AS wins_for_apps_without_a_choice,
       CASE WHEN rk.reach = 'one_client' AND rk.position_in_reach = 1 THEN 1 ELSE 0 END AS wins_for_named_app,
       EXISTS (SELECT 1 FROM compiled_mapping_snapshots c
                WHERE c.tenant_id = rk.tenant_id AND c.field_mapping_version_id = rk.version_id
                  AND c.lifecycle_state = 'active' AND c.catalog_version_id IS NOT NULL) AS snapshot_ready,
       (SELECT group_concat(destination_type, ',') FROM
          (SELECT DISTINCT destination_type FROM prof
            WHERE prof.activation_id = rk.activation_id AND destination_type IS NOT NULL ORDER BY 1)) AS profile_types,
       (SELECT COUNT(*) FROM prof WHERE prof.activation_id = rk.activation_id AND prof.profile_id IS NULL) AS unresolved_profile_refs,
       EXISTS (SELECT 1 FROM prof WHERE prof.activation_id = rk.activation_id AND prof.destination_type <> 'oidc') AS has_non_oidc_profile,
       (SELECT COUNT(*) FROM fields WHERE fields.activation_id = rk.activation_id) AS field_count,
       (SELECT COALESCE(SUM(is_optional), 0) FROM fields WHERE fields.activation_id = rk.activation_id) AS optional_field_count,
       (SELECT COALESCE(SUM(not_in_id_token), 0) FROM fields WHERE fields.activation_id = rk.activation_id) AS claims_not_in_id_token,
       (SELECT group_concat(field_name, ',') FROM
          (SELECT field_name FROM fields
            WHERE fields.activation_id = rk.activation_id AND is_optional = 1 AND destination_type = 'oidc'
              AND field_name IN ('name', 'family_name', 'given_name', 'middle_name', 'nickname', 'preferred_username', 'profile',
                                 'picture', 'website', 'email', 'email_verified', 'gender', 'birthdate', 'zoneinfo', 'locale',
                                 'phone_number', 'phone_number_verified', 'address', 'updated_at')
            ORDER BY field_name)) AS optional_standard_claims
  FROM rk
  JOIN field_mapping_sets s ON s.id = rk.set_id
  JOIN field_mapping_versions v ON v.id = rk.version_id
 ORDER BY rk.tenant_id, wins_for_apps_without_a_choice DESC, wins_for_named_app DESC, rk.activated_at DESC;
```

How to run (the shell would expand `$.` inside a double-quoted string, so keep the statement in a
file and leave the `-- runbook:` comment line out of it):

```sh
npx wrangler d1 execute <ADMIN_DATABASE_NAME> --remote --json --command "$(cat reachable-activations.sql)"
```

Columns, and how to read a row:

| Column                                | Meaning                                                                                                                                                                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reach`                               | `every_client`: fits any OIDC app of the tenant. `one_client`: fits only the app named in `target_client_id`. `never`: its scope disagrees with an OIDC call (another protocol, role or tenant, or a field an OIDC call never has).       |
| `wins_for_apps_without_a_choice`      | `1` for the activation the runtime picks for an app that names no Mapping Set and is not named by a `one_client` activation (the best `every_client` activation of the tenant).                                                           |
| `wins_for_named_app`                  | `1` for the `one_client` activation the runtime picks for the app named in `target_client_id` (the best-scored one if several name it). It is chosen before any `every_client` activation, whatever their scopes: a client match adds 16. |
| `snapshot_ready`                      | `0`: the activation has no active compiled snapshot. If it wins, the lookup finds no mapping at all.                                                                                                                                      |
| `profile_types`                       | The destination types of the Destination Profiles the mapping writes to (`oidc`, `saml`, `resource_server`). Anything but `oidc` on a row that is not `never` is a mismatch (`has_non_oidc_profile = 1`).                                 |
| `unresolved_profile_refs`             | Profile references the mapping makes that match no Destination Profile of the tenant or the platform.                                                                                                                                     |
| `field_count`, `optional_field_count` | Fields of the Destination Profiles' active versions, and how many are optional (a SAML profile counts every attribute as optional, as the release does).                                                                                  |
| `claims_not_in_id_token`              | OIDC claims whose `surfaces` is set and leaves out `id_token`. They never appear in the ID token.                                                                                                                                         |
| `optional_standard_claims`            | Standard OIDC claims that are optional: released only after the user has selected them.                                                                                                                                                   |

Rows to look at first: `wins_for_apps_without_a_choice = 1` or `wins_for_named_app = 1` with
`optional_standard_claims` or `claims_not_in_id_token` above 0 (the apps it applies to get fewer
claims than their scopes allow), `has_non_oidc_profile = 1` on a row that is not `never` (issuance
fails for the apps it applies to), and every `wins_for_named_app = 1` row (an app is bound by
client id although its own setting says nothing, with or without a tenant-wide activation).

The scope fields are read as the runtime reads them: camelCase and snake_case names, a string
that is not empty, and a scope that is not valid JSON counts as having none. The runtime also
treats a scope value that is not a string (a number, say) as absent; the statement does not
model that, which only matters for a scope written by hand.

## Statement 2: apps per tenant that name no Mapping Set (Core database)

`oauth_clients` is in the tenant Core database, not the Admin database, so the statements cannot
be joined to Statement 1. The two are linked by one list that you copy from Statement 1: the
`(tenant_id, client_id)` pairs of the rows with `wins_for_named_app = 1`, i.e. the apps that a
client-scoped (`one_client`) activation names. An app on that list takes that activation, and only
an app that is not on it is left to the tenant-wide (`every_client`) activation of its tenant, exactly
as the runtime scores them (a client match adds 16, more than any tenant, protocol and role
together can). Replace the placeholder pair `('<tenant>', '<client id>')` in the `named` list of
both statements below with those pairs, separated by commas; with no `one_client` row, leave the
placeholder (it matches nothing). If tenants are spread over several Core databases, run the
statements on each one.

```sql
-- runbook: apps-per-tenant
WITH named(tenant_id, client_id) AS (VALUES ('<tenant>', '<client id>')),
apps AS (
  SELECT c.tenant_id, c.client_id, c.identity_mapping,
         CASE
           WHEN c.identity_mapping IS NULL THEN 1
           WHEN NOT json_valid(c.identity_mapping) THEN 1
           WHEN json_type(c.identity_mapping, '$.fieldMappingSetId') = 'text'
            AND json_extract(c.identity_mapping, '$.fieldMappingSetId') <> '' THEN 0
           ELSE 1
         END AS without_mapping_set,
         EXISTS (SELECT 1 FROM named n WHERE n.tenant_id = c.tenant_id AND n.client_id = c.client_id) AS is_named
    FROM oauth_clients c
)
SELECT tenant_id,
       COUNT(*) AS oidc_apps,
       SUM(CASE WHEN identity_mapping IS NULL THEN 1 ELSE 0 END) AS identity_mapping_null,
       SUM(without_mapping_set) AS without_mapping_set,
       SUM(without_mapping_set * is_named) AS bound_by_client_activation,
       SUM(without_mapping_set * (1 - is_named)) AS left_to_tenant_wide_activation
  FROM apps
 GROUP BY tenant_id
 ORDER BY tenant_id;
```

```sh
npx wrangler d1 execute <CORE_DATABASE_NAME> --remote --json --command "$(cat apps-per-tenant.sql)"
```

- `oidc_apps`: every row of `oauth_clients` is an OIDC app.
- `identity_mapping_null`: apps whose `identity_mapping` is `NULL`.
- `without_mapping_set`: apps the old lookup treated as naming no Mapping Set: `NULL`, text that is
  not JSON, or JSON without a non-empty `fieldMappingSetId` (an old `destinationProfileId`-only
  selector, for example). Only these apps were looked up by activation at all. Since this change
  a `NULL` one follows the default instead, and a `destinationProfileId`-only one fails (Statement 3
  lists the shapes that fail rather than follow it).
- `bound_by_client_activation`: of those, the apps on your list. They take the `one_client`
  activation that names them (Statement 1, `wins_for_named_app = 1`), whether or not a
  tenant-wide activation exists.
- `left_to_tenant_wide_activation`: the rest. These are the apps the tenant-wide activation of
  Statement 1 (`wins_for_apps_without_a_choice = 1`) applies to; with no such activation they are
  mapped by nothing.

To list the apps of one tenant, add `AND c.tenant_id = '<tenant>'` after the `END = 1` line (before `ORDER BY`):

```sql
-- runbook: apps-without-mapping-set
WITH named(tenant_id, client_id) AS (VALUES ('<tenant>', '<client id>'))
SELECT c.tenant_id, c.client_id, c.client_name, c.identity_mapping,
       CASE WHEN n.client_id IS NOT NULL THEN 'client_activation' ELSE 'tenant_wide_activation' END AS applied_by
  FROM oauth_clients c
  LEFT JOIN named n ON n.tenant_id = c.tenant_id AND n.client_id = c.client_id
 WHERE CASE
         WHEN c.identity_mapping IS NULL THEN 1
         WHEN NOT json_valid(c.identity_mapping) THEN 1
         WHEN json_type(c.identity_mapping, '$.fieldMappingSetId') = 'text'
          AND json_extract(c.identity_mapping, '$.fieldMappingSetId') <> '' THEN 0
         ELSE 1
       END = 1
 ORDER BY c.tenant_id, c.client_id
 LIMIT 200;
```

`applied_by` says which kind of activation the app is subject to: `client_activation` (the app is
on your list) or `tenant_wide_activation` (it is not; applies only if the tenant has a winning
`every_client` activation).

## Putting the two together (the record of what applied before)

For each tenant, from Statement 1 take the `wins_for_apps_without_a_choice = 1` row (the
tenant-wide one, if any) and every `wins_for_named_app = 1` row (one per named app); from
Statement 2 take the counts.

- **A tenant-wide row and `left_to_tenant_wide_activation` above 0**: that Mapping Set applied,
  until this change, to exactly that many apps that never chose it. Apps in `bound_by_client_activation` are
  not among them; they take their own `one_client` activation instead.
- **A tenant-wide row and `left_to_tenant_wide_activation` = 0**: the tenant-wide activation was
  shadowed everywhere (every app without a choice is named by a `one_client` activation).
- **No tenant-wide row**: apps in `left_to_tenant_wide_activation` were mapped by nothing. They
  are unaffected.
- **A `one_client` row (`wins_for_named_app = 1`)**: the app named in `target_client_id` is bound
  to that Mapping Set if it names no Mapping Set itself, although a tenant-wide activation or
  nothing else says so. That holds even when the tenant has no tenant-wide activation. If the
  app's `identity_mapping` names a Mapping Set, the activation is not used for it.

For each affected app decide whether the mapping is wanted. If it is, name the Mapping Set (on
the app, or as the tenant default, as above); if it is not, do nothing: since this change the
activation no longer reaches the app. A winning row with `snapshot_ready = 0` found no mapping at
all, so the apps it would have applied to were never mapped. It is still worth deactivating or
scoping an activation that was only ever meant for one protocol, role or client, because
Introspection, VC and SAML keep the old lookup.

Keep the outputs with the date.

## Statement 3: selectors of the older kind and values that are no choice (Core database)

The runtime reads an app's `identity_mapping` as one of: nothing (unset), `{"mode":"none"}`, a
Mapping Set (`fieldMappingSetId`, or its older spelling `policySetId`, which counts the same), or
**not a choice**. A selector that is not a choice fails the request instead of being ignored, so
find them before deploying. Run it on each Core database.

```sql
-- runbook: legacy-selectors
SELECT *
  FROM (
    WITH sel AS (
      SELECT c.tenant_id, c.client_id, c.client_name, c.identity_mapping AS raw,
             CASE WHEN json_valid(c.identity_mapping) THEN json_type(c.identity_mapping) END AS root_type
        FROM oauth_clients c
       WHERE c.identity_mapping IS NOT NULL AND trim(c.identity_mapping) <> ''
    ),
    parts AS (
      SELECT sel.*,
             CASE WHEN root_type = 'object' THEN NULLIF(json_type(raw, '$.mode'), 'null') END AS mode_type,
             CASE WHEN root_type = 'object' THEN json_extract(raw, '$.mode') END AS mode_value,
             CASE WHEN root_type = 'object' THEN NULLIF(json_type(raw, '$.fieldMappingSetId'), 'null') END AS set_type,
             CASE WHEN root_type = 'object' THEN NULLIF(json_type(raw, '$.policySetId'), 'null') END AS old_set_type,
             CASE WHEN root_type = 'object' THEN COALESCE(NULLIF(json_type(raw, '$.destinationProfileId'), 'null'), NULLIF(json_type(raw, '$.destination_profile_id'), 'null')) END AS profile_type
        FROM sel
    ),
    named AS (
      SELECT parts.*,
             COALESCE(set_type, old_set_type) AS named_type,
             CASE WHEN set_type IS NOT NULL THEN json_extract(raw, '$.fieldMappingSetId')
                  WHEN old_set_type IS NOT NULL THEN json_extract(raw, '$.policySetId') END AS named_value
        FROM parts
    )
    SELECT tenant_id, client_id, client_name, raw AS identity_mapping,
           CASE
             WHEN root_type IS NULL THEN 'not_json'
             WHEN root_type = 'null' THEN NULL
             WHEN root_type <> 'object' THEN 'not_an_object'
             WHEN mode_type IS NOT NULL AND (mode_type <> 'text' OR mode_value <> 'none' OR named_type IS NOT NULL) THEN 'invalid_mode'
             WHEN mode_type IS NOT NULL THEN NULL
             WHEN named_type IS NULL AND profile_type IS NOT NULL THEN 'profile_only'
             WHEN named_type IS NULL THEN NULL
             WHEN named_type <> 'text' OR named_value = '' OR named_value <> trim(named_value) OR length(named_value) > 200 THEN 'invalid_set_id'
           END AS finding,
           CASE WHEN named_type IS NULL AND profile_type = 'text' THEN COALESCE(json_extract(raw, '$.destinationProfileId'), json_extract(raw, '$.destination_profile_id')) END AS destination_profile_id
      FROM named
  )
 WHERE finding IS NOT NULL
 ORDER BY tenant_id, client_id
 LIMIT 200;
```

```sh
npx wrangler d1 execute <CORE_DATABASE_NAME> --remote --json --command "$(cat legacy-selectors.sql)"
```

| `finding`                   | Meaning                                                                                                                                                                                                                                                                                                                                                                             | What to do                                                                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile_only`              | An object with a `destinationProfileId` (and no Mapping Set). Before, that Destination Profile held the claims and set the fields asked about on the consent screen. It binds nothing now, and the app **fails** (`invalid_client`) rather than lose that gate in silence. `destination_profile_id` names the profile (`destinationProfileId` or `destination_profile_id` is read). | Select the Mapping Set whose Destination Profile it is on the app (`fieldMappingSetId`), or save `{"mode":"none"}`; clear `identity_mapping` only if the app should follow the tenant default. |
| `invalid_set_id`            | A Mapping Set ID that is not a non-empty string without surrounding spaces and up to 200 characters (`""`, a number, ...). The release fails for the app (`invalid_client`).                                                                                                                                                                                                        | Save the app again with a Mapping Set, or clear `identity_mapping`.                                                                                                                            |
| `invalid_mode`              | A `mode` other than `none`, or `none` beside a Mapping Set. The release fails for the app.                                                                                                                                                                                                                                                                                          | Save `{"mode":"none"}` alone, or a Mapping Set alone.                                                                                                                                          |
| `not_json`, `not_an_object` | Text that is not a JSON object. The release fails for the app.                                                                                                                                                                                                                                                                                                                      | Clear `identity_mapping`.                                                                                                                                                                      |

**These rows fail after the switch.** Fix each one before you deploy: select a Mapping Set
(`fieldMappingSetId`) or save `{"mode":"none"}`; a row that should simply follow the default is
cleared (`NULL`).

An app whose `identity_mapping` is `NULL`, empty, `null`, `{}`, or an object with no Mapping Set
and no destination profile is unset, and follows the default. (The admin API refuses to save
most of these shapes, so the rows come from hand edits or older versions.)

## Deleting a Mapping Set, and what the search for its uses looks at

A Mapping Set that something names (a platform or tenant default, an app, a SAML provider, a
credential profile version, a federation trust source, SCIM) cannot be deleted or switched off:
the request is refused with 409 and `reason` `referenced`, with the first references. The same
search answers `GET /api/admin/identity-mapping/usage?set_id=...`.

`DELETE /api/admin/identity-mapping/sets/{id}` switches a set that is on off and deletes it in one
request. There is no step of switching it off first, and nothing is left half done: the set, its
activations, snapshots, versions and rules go in one atomic batch, or none of them does. The
request is refused (409, nothing changed) when:

- something names the set, or where it is used could not be checked everywhere
  (`reason` `scan_incomplete`);
- `If-Match` is sent and is not the `content_version` (`ETag`) of the set as it is now;
- someone saved the set or switched another version on between the moment the request read the
  set and the batch (the batch begins with a check of the version in use, else the one saved last).

A repeat of a successful request with the same `Idempotency-Key` is answered with the stored answer.
A repeat with another key, once the set is gone, is 404. The older
`DELETE /api/admin/field-mapping/field-mapping-sets/{fieldMappingSetId}` still refuses a set that
is switched on.

The audit record `identity_mapping.set.deleted` says whether the set was on (`was_enabled`).

An app that names the set from another tenant's database, or a default saved after the search
read that place, cannot be excluded by the batch itself (the references live in other databases):
the search and the batch are not one transaction. Check usage first when that matters.

### How far the search looks

The search reads each place with a row limit, reads the other tenants' databases for a platform
set a few at a time, and lists only the first references. These are platform settings of the
`identity-mapping` category (Settings API `PATCH /api/admin/platform/settings/identity-mapping`;
a tenant cannot set them), with a deployment default in the environment (see
`docs/ENVIRONMENT_VARIABLES.md`):

| Setting                                        | Environment variable                           | Default | Range     |
| ---------------------------------------------- | ---------------------------------------------- | ------- | --------- |
| `identity_mapping.reference_scan_tenant_limit` | `IDENTITY_MAPPING_REFERENCE_SCAN_TENANT_LIMIT` | 200     | 1 - 1000  |
| `identity_mapping.reference_scan_row_limit`    | `IDENTITY_MAPPING_REFERENCE_SCAN_ROW_LIMIT`    | 500     | 10 - 5000 |
| `identity_mapping.reference_scan_concurrency`  | `IDENTITY_MAPPING_REFERENCE_SCAN_CONCURRENCY`  | 8       | 1 - 16    |
| `identity_mapping.reference_display_limit`     | `IDENTITY_MAPPING_REFERENCE_DISPLAY_LIMIT`     | 20      | 1 - 100   |

The order is the saved platform value, then the environment variable, then the default. A value
that is outside the range, or that is not a whole number, is not used (the default is). A change
takes effect on the next search.

What each one does when it is too low:

- Tenants: a platform set is looked for in at most this many tenants' databases (the calling tenant
  is always among them). With more tenants, the rest are listed as not looked at
  (`tenant_limit`), and deleting or switching off the set is refused as `scan_incomplete`. Raise
  it (the cost is a database read per tenant), or run the search with global authority.
- Rows per place: a place that holds more rows that name the set (a tenant's apps, say) is cut
  off, and the count is given as a lower bound (`countIsLowerBound`). The change is refused anyway,
  since something names the set.
- Concurrency: only how many tenants are read at once.
- Displayed references: only how many references the answer lists. The count is always the whole.

## Rolling back

Redeploy the previous version of the Workers that release claims (`ar-auth`, `ar-token`,
`ar-userinfo`) and of `ar-management`. The settings written in the meantime stay valid for it: the
previous version does not read `identity_mapping.oidc_default_set_id` for the release of claims.
Two things to know:

- The previous version applies the implicit lookup again, so the apps that Statement 1 reported are
  bound to those Mapping Sets again.
- It does not understand `{"mode":"none"}`: it reads the selector as one that names no Mapping Set
  and applies the implicit lookup to it. If you saved the opt-out on an app that must stay
  unmapped, deactivate the activation that would reach it before you roll back.
