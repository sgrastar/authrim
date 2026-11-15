# Mapping graphs

`MappingRuleGraph` has one target and one explicit output. Step inputs are ordered rule-local
edge/step references; names are reserved for future conditional inputs. All references are checked,
including unused steps. Steps can refer only to earlier steps. `analyzeMappingDependencies` walks
from the output, returning evaluation order and every source dependency. Runtime and dry-run call
the same evaluator; authoring exports it for console preview without changing console-only operations.

Values use tagged states: absent, value (including null, empty string and empty array), failed and
suppressed. Valid references to missing attributes produce absence, not missing_input. Suppression
and failure propagate through dependencies, including fallback. Only the explicit output is released.
The final target is checked for required/type/cardinality; intermediate values are never candidates.
All dependency classifications and provenance hints are retained, including input two and later.

Final-value validation runs after identifier suppression and receiver conflict resolution. The default
projection and OIDC share `lastWriterMappingValues`; earlier writers cannot satisfy or invalidate a
later writer's required/type/cardinality checks. SAML supplies `resolveValidationValues` to validate
its merged, deduplicated attribute values (before lexical serialization), and ACS supplies its scalar
projection. Runtime retains the ordered output envelopes for consumers; validation uses the resolved
projection and never falls back to an original target value after suppression or an absent output.
These receiver hooks are in-memory options, not stored metadata. Identifier targets have exactly one
writer even when a conflict policy is present, whether declared on the step or the rule.

Evaluation remains synchronous. Callers await an asynchronous pre-pass and pass a `preparedSteps`
map of step IDs to tagged results, or the existing prepared identifier runtime context. Dependent
steps still apply failure/suppression checks before reading prepared results. W2 can prepare tenant
keyed hashes with this hook. No caller needs to become asynchronous just to execute a graph.
OIDC rebuilds its graph view from the selected binding after the pre-pass awaits external reads.
Replaced settings are validated at evaluation, so a prepared identifier cannot mask invalid settings.

## Stored graphs

Each value-producing `mapping_rules` row owns one `target_ref_json` and exactly one of
`output_edge_id` / `output_step_id`. Policy-only rules have no graph, output or target.
`mapping_rule_edges` holds the rule's source references. Its target references retain input naming
for operations such as `json_build`; only the rule target is released. `mapping_transform_steps`
holds the operation, parameters and rule-local `step_order`. It has no `edge_id` or target column.
`mapping_transform_step_inputs` stores `(tenant_id, step_id, position)` with exactly one of `edge_id`
or `input_step_id` and an optional `name`. Positions start at zero and are contiguous.

Saving resolves API indexes to newly allocated IDs inside the version transaction. Reading resolves
IDs back to indexes, checking tenant and rule ownership, input positions and earlier-step ordering.
All references are validated, including unused steps. GET and version copy/rollback retain ordered
inputs, names, target and explicit output. Legacy transform-level `edgeIndex` requests are refused.
The runtime loads these graphs directly; there is no compatibility evaluator or stored-row inference.
OIDC, UserInfo, introspection, SAML release/NameID/deferred identifiers, ACS and SCIM evaluate only
explicit graphs. Receiver conflict policies still consume ordered final outputs from separate rules.
Identifier targets always have a single writer. Stored edge values keep target-based input naming;
native authoring graphs use source-based naming by default. SAML's receiver validates runtime-defined
sources through its release-safety catalog before protocol release, using `sourceCatalogValidation:
'receiver'`; other callers require source entries in the mapping catalog. SCIM assigns distinct
runtime catalog IDs to each input path, so several inputs sharing a target retain their own values.

## Migration 023 and operator procedure

Apply `023_mapping_rule_graph.sql` through the manifest-aware setup runner or D1 migration engine.
Do not apply the SQL alone in production: these runners append recompilation SQL before migration
history commits, in the same atomic D1 batch. Existing compiled snapshots are rehashed with the
stored graph, dependency snapshots are regenerated, stale compiled artifacts are cleared, and the
same versions/snapshots remain active. Credential Profile versions pinning those snapshots receive
both replacement mapping hashes and the corresponding profile contract hash in that transaction.
Missing or ambiguous pins and invalid profile contracts are refused with a tenant/profile/version
inventory before mutation. Concurrent profile edits also abort the transaction.
Migration 023 also records the exact previous/new hash pair in each compiled snapshot's
`metadata_json.graphMigration023`. This equivalence commits atomically with the recompiled snapshot
and survives DR with that snapshot. Runtime resolution also requires the migration-generated
`graph_023_<snapshot id>` dependency graph ID; metadata supplied to normal compilation cannot forge
an equivalence record. Core DB `attribute_verifications` and Durable Object `vp_requests`
keep their original pins: verification and evidence reads accept the previous hash only when the
resolved tenant/version snapshot still has the recorded new hash. A same-content recompile retains equivalence by tenant/version/hash, even if its snapshot row changes.
A later policy recompile does not inherit equivalence to its different hash. Ambiguous previous/new pairs are refused with a snapshot
inventory. Credential offers also persist mapping hashes, but their claims and signed issuance
contract are already fixed; redemption does not resolve or compare a live mapping snapshot.
Uncompiled draft versions use the normal compile workflow.
A failed batch commits neither schema changes, snapshots nor migration history; retry normally.

A legacy rule with at most one edge, at most one step and one target migrates to an explicit edge
input and step output (or an edge output for a direct copy). A generating `persistent_identifier`
step moves its target to the rule and uses an empty input list and a step output.
The preflight refuses multiple edges, multiple steps, mismatched step/edge targets, dangling or
cross-rule edge references, generating steps without a target, and conflict-policy writers sharing a
target. Both the preflight and SQL guard report the `(tenant, set, version, rule)` inventory.
Target comparisons use the runtime's first non-empty string from `path`, `fieldKey`, and `nodeId`.
Large graph material is assembled from bounded Unicode-safe chunks in a transaction-local staging
table, so no statement embeds an entire version or exceeds the migration statement size limit.
The operator must edit those rules on the previous release into independent single-target rules,
resolve competing writers explicitly, then retry the deployment. No flattening or target selection
is performed automatically. Preserve a pre-migration backup until the deployment is verified.

## Disaster recovery

The input table is a settings dataset. Restore rules before edges/steps, then step inputs. Rule output
references are validated without inverting this insertion order. Edge and earlier-step references are
nullable individually; exactly one is required per input. Graph ownership and ordering are checked
again when loading the restored version.
Old backups containing step `edge_id` / `target_ref_json`, or rules without explicit output columns,
are refused with `backup_mapping_graph_legacy_shape`. Restore such a backup using its original
release, apply migration 023 through the supported runner, and export a new backup before restoring
into a current deployment. The importer never executes legacy migration SQL from a backup.
