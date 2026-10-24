# Preview a platform default Mapping Set

`POST /api/admin/platform/identity-mapping/preview-default` accepts exactly one `set_id`, either a
platform-owned Mapping Set ID or `null`. A null proposal clears the saved platform value and uses
the inherited fallback, just as a normal clear does. The operation requires settings read access
for every tenant. Agents and administrators limited to one tenant cannot use it.

The preview classifies each non-deleted tenant as `following`, `own_default` or `opted_out`, using
the runtime's fresh settings selection. An explicit tenant default remains `own_default` even if
it names the same set as the platform. Suspended tenants are included. Single-tenant installations
inspect only their configured tenant.

`apps_affected` counts apps with no choice of their own in following tenants when the effective
platform default changes. It is zero for an unchanged effective default. An app with its own set,
an explicit opt-out or an unusable selector does not contribute. Each tenant row includes its
number of apps following the default.

`claim_changes` summarizes the default's structural added, removed and renamed claims, using the
runtime's active version, catalog and namespace. It does not evaluate user values or an app's
scopes. Unaffected tenants have zero changes. When the old mapping cannot be used, following rows
identify `before_unavailable` and return a null difference rather than a misleading zero. The
proposed mapping must be usable.

The preview reads a complete inventory of at most 100 tenants, with concurrency four. App choice
reads allow at most 100 distinct stored selectors per tenant and 4,096 bytes per selector, bounded
in SQL before values reach the Worker. Over-budget or incomplete reads return 503. Existing non-global platform activations
also return 503 rather than applying one shared difference to different runtime choices. The
canonical platform setting and runtime projection must agree; a lagging projection is retried,
without repair writes from the preview.

## Save after preview

Use the existing `PATCH /api/admin/platform/settings/identity-mapping`. Send the preview's
`expected_version` with the normal `set` or `clear` operation. `ifMatch` remains supported; if both
version fields are present they must match. Optionally send `expected_following` with
`tenants.following` from the preview. Zero is a valid expected count.

Immediately before saving, the server re-reads the complete tenant relation inventory when the
count guard is present. A mismatch returns 409, and an incomplete read returns 503. Malformed
guards, or a count guard without a default set/clear operation, return 400. These failures leave
the settings document and runtime projection unchanged; ordinary failure audit evidence can still
be written. The settings version is checked through the existing canonical CAS.

The count check is a fresh observation just before the save. Tenant stores are not locked into an
atomic fleet snapshot, so concurrent changes after that read remain possible. Repeat the preview
after a conflict. The exact read-only preview POST remains available during a release mutation
fence; the actual PATCH remains fenced and requires the existing global write authority.
