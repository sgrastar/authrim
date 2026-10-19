# Identity mapping: inventory of mappings that apply without being chosen

An OIDC app (an `oauth_clients` row) chooses its identity mapping with `identity_mapping`
(`{"fieldMappingSetId": "..."}`). An app that names no Mapping Set is not mapping-free today:
the runtime looks for an **active activation of the tenant** whose scope fits an OIDC call and
applies that Mapping Set to the app. An activation with no protocol, no role and no client
(`{"kind":"tenant"}`, which is what the admin console sends when it activates a Mapping Set)
fits **every** OIDC call. So a Mapping Set that someone activated for a SAML provider, or for a
test, can end up deciding what the ID token, UserInfo and the consent screen of every app
that has no Mapping Set of its own may carry.

This page lists the read-only statements that show where that happens in an environment: which
activations can reach an OIDC app without the app choosing them, which Destination Profile each
brings, and how many apps in each tenant are exposed. Run them before any change that makes
the choice explicit (setting a tenant default, selecting a Mapping Set on an app, or
deactivating an activation), and keep the output as the record of what applied before.

Nothing here writes. Every statement is a `SELECT`.

## Why this matters

- An activation that reaches the app decides which claims leave the Authorization Server. If its
  Destination Profile lists the standard claims as optional, or lists them for UserInfo only, the
  ID token loses `name`, `email`, `phone_number` and `address` for an app that never chose that
  Mapping Set. UserInfo of the same app then depends on whether the Worker that serves it can
  read the Admin database.
- If the Destination Profile of that Mapping Set is a SAML profile, an OIDC app that reaches it
  cannot get an ID token (the release fails with `destination_profile_type_mismatch`).
- When the Admin database cannot be read, the lookup fails and the request goes on **without**
  the mapping. That is logged as an error (`identity_mapping_resolution_swallowed`, with
  `failure_kind` and `reason_code`); search for it in the Worker logs.

## How the runtime picks the mapping (what the statements reproduce)

For an OIDC call the lookup uses the tenant, protocol `oidc`, role `op` and the app's client id.
It takes the tenant's activations in state `active`, scores each by the scope fields it has,
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
than tenant, protocol and role add up to). If the best activation has no active compiled snapshot, the lookup returns no mapping (it does
not fall back to the next one). An app that names a Mapping Set is not affected: its lookup is
limited to that Mapping Set.

## Statement 1: active activations that can reach an OIDC app (Admin database)

Run it on the Admin database (`DB_ADMIN`).

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
- `without_mapping_set`: apps the runtime treats as naming no Mapping Set: `NULL`, text that is
  not JSON, or JSON without a non-empty `fieldMappingSetId` (an old `destinationProfileId`-only
  selector, for example). Only these apps are looked up by activation at all.
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

## Putting the two together

For each tenant, from Statement 1 take the `wins_for_apps_without_a_choice = 1` row (the
tenant-wide one, if any) and every `wins_for_named_app = 1` row (one per named app); from
Statement 2 take the counts.

- **A tenant-wide row and `left_to_tenant_wide_activation` above 0**: that Mapping Set applies,
  today, to exactly that many apps that never chose it. Apps in `bound_by_client_activation` are
  not among them; they take their own `one_client` activation instead.
- **A tenant-wide row and `left_to_tenant_wide_activation` = 0**: the tenant-wide activation is
  shadowed everywhere today (every app without a choice is named by a `one_client` activation).
- **No tenant-wide row**: apps in `left_to_tenant_wide_activation` are mapped by nothing. They
  are unaffected.
- **A `one_client` row (`wins_for_named_app = 1`)**: the app named in `target_client_id` is bound
  to that Mapping Set if it names no Mapping Set itself, although a tenant-wide activation or
  nothing else says so. That holds even when the tenant has no tenant-wide activation. If the
  app's `identity_mapping` names a Mapping Set, the activation is not used for it.

For each affected app decide whether the mapping is wanted. If it is, select the Mapping Set on
the app; if it is not, deactivate the activation or scope it to the protocol, role and client it
is meant for. A winning row with `snapshot_ready = 0` finds no mapping at all (the runtime does
not fall back to another activation).

An environment that is used only for conformance testing normally has no activation that wins.
If one does, that is the finding.

Keep the outputs with the date. They are the record of which mapping applied to which app before
the choice was made explicit.
