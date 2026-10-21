# Platform-owned Mapping Sets: what they are and how to move them

A Mapping Set normally belongs to one tenant: its rows (`field_mapping_sets`, versions,
activations, snapshots, rules, edges) carry that tenant's `tenant_id`. The platform can also own
Mapping Sets. They are stored under the reserved tenant ID `platform` in the Admin database, and
every tenant can read them. This page says what that means for operating an environment.

## What a platform Mapping Set is

- It lives in the Admin database under `tenant_id = 'platform'`, with `owner_scope_type =
'platform'`. `platform` is not a tenant: no tenant can be registered under that ID (or with
  that tenant code), so a row owned by it never belongs to a customer.
- A platform admin creates it through the same Admin API as a tenant's set, with
  `ownerScopeType: "platform"` in the create request. Every later call (versions, publish,
  compile, activate, deactivate, rollback, delete) names the set by ID and runs under its owner.
  A tenant admin can list and read a platform set, and cannot change it (403).
- It is compiled against the platform's own standard field catalog
  (`platform_default_canonical_catalog_v1`), and it releases into exactly one OIDC Destination
  Profile that the platform owns.
- Its activation is stored with an empty scope, so it applies to whichever tenant resolves it.
- It cannot contain anything that only one tenant has: custom claims, custom fields,
  attributes, persistent identifiers (`oidc_pairwise_sub`), a Source Profile, or a Destination
  Profile a tenant owns. These are refused when the version is saved, compiled or activated.

Creating and activating a platform Mapping Set changes nothing by itself: an app is bound to a
Mapping Set only by a name. The platform's default (`identity_mapping.oidc_default_set_id` at the
platform scope) can name one, which then applies to every app of every tenant that has no tenant
default and names no Mapping Set of its own; a tenant's default can name one too. The ID token,
UserInfo and consent screen of those apps then read the set under the platform as its owner. An
app cannot be given a platform set directly yet: the Admin API refuses the app's own choice when it
names one (it answers as a set that does not exist), until the backup side can carry that
reference (see "What the backup side has to do" at the end of this page).

## What a platform Mapping Set is checked for, in the three places that read it

The same rules judge a platform set when its version is saved, compiled and activated, and the
runtime reads it by the same resolution (`catalogReferenceResolver`), so none of them reads a
reference differently from the others:

- A source that names **only a catalog entry** (no namespace and no path) reads the place the
  entry describes. Once that place is known it is judged like a place the author wrote: an entry
  whose namespace is one only a tenant defines the keys of (`authrim.custom_claims`,
  `authrim.custom_fields`, `authrim.attributes`, or a path into them) is refused when the version
  is compiled and again when it is activated, though the entry is not marked `custom`. A
  destination or a validation rule that names such an entry is refused the same way.
- A **destination** keeps the claim name it is written under (a custom claim name differs from the
  catalog entry's own path). Only its catalog entry ID is brought to the stable ID the runtime
  catalog carries, whatever the claim is called. Before, an ID that was an entry's row ID stayed
  as it was when the claim name differed from the entry's path, and the value was dropped when the
  mapping was released.
- An entry of the older taxonomy `destination` is `destination-only` for every check, as the
  runtime reads it: it describes what is released, so it is never a source, and a source that
  names only it completes to no place. Compile and activation read the stored word the same way.

## Backup and restore

A platform Mapping Set is **not part of a tenant backup**. A tenant backup holds the rows of that
tenant's `tenant_id`; the platform's rows belong to no tenant, so they are neither exported with
a tenant nor restored with one.

When you restore a tenant, or move it to another environment:

1. Move the platform Mapping Sets first, if the destination does not have them. Copy the rows
   with `tenant_id = 'platform'` from `field_mapping_sets`, `field_mapping_versions`,
   `field_mapping_activations`, `compiled_mapping_snapshots`, `mapping_rules`,
   `mapping_rule_edges`, `mapping_transform_steps`, `mapping_validation_rules`,
   `dependency_graph_snapshots`, `field_catalogs`, `field_catalog_versions`,
   `field_catalog_entries`, and the platform-owned `destination_profiles` and
   `destination_profile_versions`, keeping their IDs.
2. Apply the Admin migrations on the destination (a fresh install, `setup update` and `setup
deploy` all do). The platform catalog needs no step of its own; see the next section.
3. Restore the tenant. A tenant whose default names a platform Mapping Set by ID resolves it only
   if the same ID exists in the destination; if it does not, the apps that follow that default
   cannot sign in.

Keep the IDs. A tenant's selection refers to the set by ID, so a copy under a new ID is a
different set to it.

## How the platform catalog gets into an environment

The platform's standard field catalog (`tenant_id = 'platform'`: catalog
`platform_default_canonical_catalog`, version `platform_default_canonical_catalog_v1`, and one
entry `platform_canonical_<field>` per standard field) is made by the Admin migration
`041_platform_default_canonical_catalog.sql`. It is the only source: `setup` has no separate seed
for it. A fresh install gets it with the Admin baseline and the later migrations, and an existing
environment gets it when `setup update` applies the migration.

- It does not depend on the tenant that `setup` bootstraps, and it has no link to the `tenants`
  table.
- It inserts only what is missing and runs once. If an operator changed or removed an entry
  afterwards, nothing puts it back; a later migration would be needed for that.
- The fields are the same as the tenant's default canonical catalog (same classification). A test
  applies the migration to SQLite and requires the rows to equal
  `DEFAULT_CANONICAL_CATALOG_ENTRIES` in `packages/setup/src/core/cloudflare.ts`. When that
  definition changes, add a migration for the platform catalog as well.

## Checking what the platform owns

```sql
SELECT id, field_mapping_key, lifecycle_state, updated_at
  FROM field_mapping_sets
 WHERE tenant_id = 'platform'
 ORDER BY updated_at DESC;
```

An owner scope that disagrees with its tenant ID is a defect. This statement returns no rows
when the two agree:

```sql
SELECT id, tenant_id, owner_scope_type
  FROM field_mapping_sets
 WHERE (owner_scope_type = 'platform') <> (tenant_id = 'platform');
```

## What the backup side has to do

This is a note for whoever owns the tenant backup and restore (the dependency rules in
`phase3-sqlite-references.ts`). Nothing here is done yet.

- A tenant backup holds the tenant's own rows. The platform's rows, and so a platform-owned
  Mapping Set, are not part of it.
- The tenant's settings document (category `identity-mapping`) can hold
  `identity_mapping.oidc_default_set_id` naming a platform-owned set. The dependency rule for that
  key must not treat the set as a required resource of the bundle (the bundle cannot contain it).
  It needs an external precondition check instead: "the destination has a Mapping Set with this
  ID, owned by the platform, and it is usable". A restore into an environment that lacks it should
  say so, not fail with `backup_reference_target_missing`.
- The same holds for the app's `identity_mapping` (`oauth_clients`) once the Admin API accepts a
  platform set there. That is why saving it is refused for now (`TODO(backup dependency)` in
  `validateOidcMappingSetReference`, scope `client`). When the precondition check exists for the
  tenant default, apply it to the app's reference too, then lift the refusal and let the app
  console offer platform sets again.
- A set the tenant owns stays an ordinary required dependency, as today.
