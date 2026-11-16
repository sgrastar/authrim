# Mapping graphs

`MappingRuleGraph` has one target and one explicit output. Step inputs are ordered rule-local
edge/step references; conditional inputs use the names described below. All references are checked,
including unused steps. Steps can refer only to earlier steps. `analyzeMappingDependencies` walks
from the output, returning evaluation order and every source dependency. Runtime and dry-run call
the same evaluator; authoring exports it for console preview including structure and constant operations.

Values use tagged states: absent, value (including null, empty string and empty array), failed,
suppressed and the trusted preparation-only state deferred. Valid references to missing attributes produce absence, not missing_input. Suppression
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
steps still apply failure/suppression checks before reading prepared results. Tenant keyed hashes use this hook through the resumable evaluation driver. No caller needs to become asynchronous just to execute a graph.
OIDC rebuilds its graph view from the selected binding after the pre-pass awaits external reads.
Trusted callers may also supply synchronous `stepPreparers`.
Each preparer receives already evaluated dependencies, runs once after input budget checks, and
has its output checked against the same per-rule budget. Failure, suppression and absence are
handled before invoking a preparer, just as for native operations. `evaluateAllSteps` additionally
fills the `steps` map for disconnected intermediate values using the remaining budget after output
dependencies, so trace-only work cannot change the runtime output. Normal runtime evaluation
continues to execute only output dependencies. The console compiles the
whole preview before evaluating once and reads every intermediate row from the returned map.

Replaced settings are validated at evaluation, so a prepared identifier cannot mask invalid settings.

## Stored graphs

Each value-producing `mapping_rules` row owns one `target_ref_json` and exactly one of
`output_edge_id` / `output_step_id`. Policy-only rules have no graph, output or target.
`mapping_rule_edges` holds the rule's source references. Its target references retain input naming
for operations such as `json_build`; only the rule target is released. `mapping_transform_steps`
holds the operation, parameters and rule-local `step_order`. It has no `edge_id` or target column.
`mapping_transform_step_inputs` stores `(tenant_id, step_id, position)` with exactly one of `edge_id`
or `input_step_id` and an optional `name`. Positions start at zero and are contiguous. A composite
tenant/step foreign key cascades input deletion when its step (or parent rule/version/set) is deleted.
Insert/update triggers reject edges and input steps belonging to another tenant or rule, including
on restore connections with foreign key enforcement disabled.

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
`metadata_json.graphMigration023`. This equivalence commits atomically with the recompiled snapshot.
Runtime accepts it only on that exact active snapshot row, whose dependency graph ID must be
`graph_023_<snapshot id>`. A different snapshot row, including a same-content recompile, does not
inherit equivalence. Normal compilation cannot supply the migration dependency graph ID.
Core DB `attribute_verifications` and Durable Object `vp_requests` keep their original pins;
verification initiation, pending requests and evidence reads use the same comparison helper.
Ambiguous previous/new pairs are refused with a snapshot inventory. Credential offers also persist
mapping hashes, but their claims and signed issuance contract are already fixed; redemption does not
resolve or compare a live mapping snapshot.
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
Snapshot equivalence is deployment-local migration authority, not portable tenant data. Both the
installed D1 restore transform (also used for verification) and AWS snapshot importer remove
`metadata_json.graphMigration023` and force `snapshotPinState: 'requires_recompile'`, preserving
other metadata. The importer's supplied `snapshot_hash` remains inventory data and cannot authorize
historical pins, including direct equality. This applies even to missing/null metadata and a forged
`compiled` marker. Graphs remain available for normal protocol mapping, but evidence, pending VP
requests, Credential Profile publication and issuance reject their pins until the server recompiles
and activates a fresh snapshot. Normal compilation always writes `snapshotPinState: 'compiled'`.
Every restored `field_mapping_versions` row receives a destination-owned `restore_id`, even when
the bundle's compiled/dependency snapshot datasets are empty. D1 uses the destination operation ID
for idempotent writes and verification; AWS generates a fresh import ID. Both overwrite any uploaded
restore ID. Normal authoring and publication cannot set or clear this dedicated column. Every later
compilation reads this record from the primary and binds both the restore ID and a fresh compilation
ID into the hash. Deleting snapshot history does not remove version provenance, and unbound policy
changes such as `rule.action` cannot revive old pins through retained authoring/catalog hashes.
Activate the new snapshot, republish profiles against its new
pin, and verify evidence again. Both unchanged legitimate bundles and modified graphs follow this rule.

Recomputing the old snapshot formula is insufficient: it binds graph material plus supplied version
and catalog hashes, while some rule policy and catalog fields are not directly in that material.
Original authoring hashes cannot be reliably reconstructed after persistence normalizes omitted
values, and source rowid writer ordering is not portable. Import therefore never promotes an uploaded
hash into historical-pin authority. Preserve the original deployment when pin continuity is required.
Old backups containing step `edge_id` / `target_ref_json`, or rules without explicit output columns,
are refused with `backup_mapping_graph_legacy_shape`. Restore such a backup using its original
release, apply migration 023 through the supported runner, and export a new backup before restoring
into a current deployment. The importer never executes legacy migration SQL from a backup.

## Text and value transforms

The runtime and console preview share `TRANSFORM_OPERATION_SCHEMAS`, settings validation and
execution for keep_part, remove_text, replace_text, regex_replace, to_halfwidth, to_fullwidth,
strip_accents, ascii_digits, value_map, text_to_number, date_format, filter_values,
normalize_empty, default_if_empty and has_value. Every operation takes one input edge.
Text edits affect only strings and string elements of arrays; other elements pass through.
Value maps store JSON text `[ ["from", "to"] ]`, require exactly two strings per row, and use
the first matching row. Flags are booleans. Literal replacements treat replacement dollars
literally; regex replacements use JavaScript capture substitutions. Empty literals are no-ops.

Empty means absent, null, empty string or empty array; false, zero and whitespace have values.
Only normalize_empty's spaces flag treats whitespace (including U+3000) as empty. Empty handling
is whole-value, not recursive. default_if_empty and has_value consume graph absence; other text
operations propagate absence. Failure and identifier suppression always propagate, including
through defaults. Text-to-number accepts signed-minus integer or decimal text, optionally padded
with whitespace, or finite numbers; there is no console integer/decimal mode parameter. It rejects
hex, exponent notation, booleans, non-finite numbers and integers outside the safe integer range.
Invalid numeric/date input fails the whole step, including an invalid array element.

Dates accept YYYY-MM-DD, or YYYY-MM-DDTHH:mm:ss with optional 1–3 millisecond digits and optional
Z or ±HH:mm offset. Dates and times without an offset mean UTC; calendar rollovers, leap seconds,
24:00, year zero and informal date strings are refused. Epoch input accepts seconds or milliseconds;
auto uses milliseconds at absolute values >= 1e11, otherwise seconds. Decimal seconds are converted
from decimal digits exactly: 1.001 seconds is 1001 milliseconds, and trailing zeroes are accepted;
actual sub-millisecond precision is refused without rounding. The computed milliseconds
must be safe integers and the UTC year must be 1–9999. timeZone defaults to UTC and must be an
Intl-recognized IANA zone (including UTC aliases), never a numeric offset. It changes output only;
explicit input offsets determine the instant, including during repeated DST hours. ISO output has
second precision and the zone's offset at that instant, date output has its calendar day, unix_s floors
seconds and unix_ms retains milliseconds. Numeric output also validates a supplied time zone. Historical second-based zone offsets fail
ISO output because the offered ±HH:mm output format cannot represent them exactly.

Width conversion changes ASCII U+0021–007E ↔ U+FF01–FF5E and U+0020 ↔ U+3000. With katakana
true, an explicit half-kana table (U+FF61–FF9F) and its NFKC-derived full forms handle voiced and
semi-voiced kana, including decomposed full-width kana composed with NFC first; other compatibility
characters are preserved. Accent folding uses NFD, removes
marks in U+0300–036F, U+1AB0–1AFF, U+1DC0–1DFF, U+20D0–20FF and U+FE20–FE2F, recomposes NFC,
and applies the explicit Latin letter table (ß→ss, æ→ae, etc.). Japanese/Arabic/Hebrew/Indic marks
outside these ranges remain. ascii_digits maps Unicode Decimal_Number (Nd) runs of ten codepoints
to ASCII, including Arabic-Indic U+0660–0669, extended Arabic-Indic U+06F0–06F9, Devanagari
U+0966–096F and full-width U+FF10–FF19. Adjacent ten-digit runs use position modulo ten.

### Bounded synchronous execution

`TRANSFORM_LIMITS` centralizes the limits for **all** operations: 32 KiB UTF-8 input and output
(including conservative JSON framing), 500 array/object entries per container, 1000 visited nodes,
12 nesting levels, 256 value-map rows and 16 KiB table text. The complete mapping-version save
path uses this same UTF-8 table limit for value_map entries; other profile strings keep their
4096-character save budget. json_build additionally caps each source key string (catalog ID,
column/header name, metadata field path and reference path) at 4 KiB UTF-8. Those strings count
alongside values toward the 32 KiB aggregate input cap and the rule work charge, before key lookup
or shaping; underscore trimming uses linear boundary scans. Ordinary string settings retain the
2048-character limit. Cycles, oversized collections and outputs fail with transform.limit_exceeded.
Invalid settings fail validation on save and again on load/execution, before using a regex or table.

Regexes have at most 512 characters and 1024 input UTF-16 code units per string. Plain captures,
classes, anchors, top-level alternatives and a **single quantified atom** (_, + or ?) are supported.
Backreferences, lookaround, special groups, group alternation, quantified groups, repeated quantifiers,
bounded repetition, Unicode/hex/control escapes and a second quantifier are refused. This intentionally
conservative subset prevents combinatorial backtracking without adding a regex dependency. A remaining
unanchored single repetition can be quadratic; execution charges (input length + 1)^2 × (pattern
length + 1) plus ordinary work before running it. Conditions in the console use the same validator
and input cap. For example, replace unsafe ^(.+)@.+$ with ^(.+)@example[.]com$ for a known domain,
or use keep_part for general address splitting. The email display-name demo uses ^._<|>$.

Each rule receives 8,388,608 work units shared across its steps. Every operation charges input bytes
× setting bytes (with one added to each) plus output bytes, bounding replacements, table scanning
and normalization as well as regex work. Exhaustion fails with transform.work_limit_exceeded.
The standalone step API uses the same budget, or accepts a caller-owned workBudget. Neither values
nor patterns appear in failure reasons. No new dependency, asynchronous operation or ambient state
is required. Identifier post-transforms remain the data allow-list in graph.ts; value_map,
default_if_empty and has_value are deliberately refused after a persistent identifier.

## Structure, conditions, constants and tenant hashes (W2b)

`json_extract_array` uses `path` and returns the found array without text conversion. Missing
input/path or invalid JSON yields absence; present non-array values (including null) yield null.
`json_extract_or` consumes absence: missing input/path or invalid JSON returns `defaultValue`.
`nullAsMissing: true` also selects the default for null. Otherwise null remains null, scalar values
become text and arrays/objects become JSON text. Empty strings and arrays are present values.
Paths use dot keys and nonnegative bracket indexes, up to 512 characters and 32 segments. Indexes
must be less than 500. Empty segments, malformed brackets and prototype keys are refused.

`array_build` flattens one level in input order and always drops absence and null. `omitEmpty`
also drops empty strings and empty nested arrays. `unique` compares JSON representations, keeping
the first value and its type (objects with different key order remain distinct). Input and output
collections are each capped at 500 entries, with the shared byte/node/depth limits.

`constant_text`, `constant_boolean`, `constant_number` have no inputs and require `value` with the
corresponding native JSON type. Text may be empty. Numbers may be fractional, must be finite and
have magnitude at most Number.MAX_SAFE_INTEGER. Console text controls convert at
`runtimeTransformParams`; malformed numeric text is refused rather than becoming zero.

`conditional` retains the console parameters: `condition` (JSON text), `valueType`
(as_text/as_boolean/as_number), `thenValue`/`thenBool`, `elseMode` (as_is/none/fixed) and
`elseValue`/`elseBool`. Number branches require decimal text (optional minus, digits, optional fraction and surrounding
whitespace), finite with safe magnitude; exponent, hexadecimal and leading-plus forms are refused,
matching the console branch converter.
boolean branch settings are the console strings true/false. `none` returns null. `as_is` preserves
the value input's tagged absence, null, empty string or array. A matching branch may produce a
fixed value even when the value input is absent. A missing condition attribute is undefined:
exists/not_exists use the console's blank definition (absent, null, empty string, empty array),
text comparisons use console string coercion and numeric comparisons treat blank as NaN.

Every conditional must have exactly one input named `value` and one named `field:<field>` for
each distinct rule field in its condition. These names resolve rule-owned edge/earlier-step
references, never ambient subject fields. Missing, extra or duplicated names fail shared save/load
validation. Group nodes use kind=group, match=all/any/none, children; leaves use kind=rule,
field/operator/value. Groups must be nonempty. Conditions allow three group levels and 64 nodes;
JSON text is at most 16 KiB. Operators match the console condition builder. Regexes use W2a's
bounded subset and input cap, with every regex charged against the rule budget before execution.
All condition dependencies contribute to analysis, source reads, classification, provenance and
release safety, including fields only used in a false condition. Catalog classifications also taint a result when
a condition field is absent, because its presence itself can be sensitive. Any failed/suppressed dependency
fails/suppresses the entire conditional; a fixed branch never replaces those states.

`hash` accepts one string, including the empty string. Null passes through; absence, failure and
suppression propagate. Other input types fail; convert them explicitly before hashing. Output is
HMAC-SHA-256 over UTF-8 text, encoded as lowercase hex or unpadded base64url. There is no plain
SHA mode or public/default key. The key is the authenticated runtime tenant's KeyManager secret
`field-mapping-hash`, never a tenant id supplied by the graph or a subject value. Runtime reads
only the installed active secret; unavailable bindings/keys or preparation exceptions produce a
failed step and critical `transform.hash_unavailable`, stopping release. The console preview and demo say decided at sign-in.
Actual hashing uses the runtime/explain boundary; explain retains its synthetic test-user guard
and does not expose secrets or add a new value-disclosure surface.

The evaluator remains synchronous. Its internal continuation yields only hash requests after
cached dependencies and input budget checks. The async driver awaits a tenant preparer and resumes
the same evaluation; every upstream step runs once and all steps share the same 8 Mi work budget.
The async runtime wrapper reuses those rule results during final validation. SAML's synchronous
attribute receiver consumes a preparedSteps map from one pre-pass per rule. Before consent it
prepares string hashes as `{ kind: 'deferred' }` without reading or provisioning a key. Null remains
null; absent, failed and suppressed dependencies retain their states. Deferred is not a string or
an envelope value. Every dependent step propagates it without executing, including conditions
(all named condition dependencies), conversions, deletion/filtering and another hash. Suppression
and failure take precedence. Persistent identifier consent preparation uses the same state, with
its text allow-list and explicit suppression unchanged.

The consent-only in-memory `allowDeferredOutputs` option exposes pending `deferredTargets` separately
from runtime `values`. Pending targets defer their final-value validation until actual preparation;
other targets are validated normally. Without this explicit opt-in, any pending output produces
critical `transform.deferred_output`. These options/states are not saved graph parameters, API
request fields or queue data. The SAML adapter retains pending attribute identities with no values,
then applies destination visibility and required-item policies. It never runs institution value
checks against provisional data. Consent items remain present even when a condition or filter might
remove their actual output. Every approved pending item requires fresh computation; required,
type, cardinality, institution and destination checks then run on actual values. If actual output
is missing for a required item, release fails. A declined optional pending item contributes no
value. Approval uses pending-item metadata, never substring matching of attribute values. Key
acquisition failure during the approved computation fails release, even if a downstream step
could otherwise produce a constant or remove the value. OIDC (ID token and
UserInfo), introspection, SAML attributes, ACS, SCIM, VC verification and credential issuance use
this preparation. SAML NameID retains its single persistent_identifier-only rule. Identifier
post-processing remains the existing text allow-list: no conditional, constant, fallback extraction,
array build, hash or other unapproved structure operation can follow an identifier; pairwise sub
and SAML NameID still allow no post-step.

### Key lifecycle and disaster recovery

After all graph/source/version validation on an authorized Mapping Set version creation, the
management repository calls `provisionMappingHashKeyRpc` idempotently if the version authors hash.
No list/get/load/preview/explain/runtime path provisions the secret. A subsequent settings database
failure can leave the newly enrolled key installed; retry reuses it. No SQL migration is needed.
Generic KeyManager create/rotate routes refuse this dedicated reference. Platform-owned graphs
never authorize use of the platform's key for tenant data: each consuming tenant needs its own
key enrolled through an authorized hash authoring mutation; without it runtime fails closed.

The owning Admin OpenAPI contract exposes GET `/api/admin/field-mapping/hash-key` (settings read,
installed/kid metadata only) and POST `/api/admin/field-mapping/hash-key/rotate` (settings write,
audit record, expectedKid precondition). Rotation changes every subsequent output immediately.
Retrying the previous kid returns the completed rotation; another stale kid conflicts. Rotation
never creates a missing key. Enrollment and rotation use the existing DR mutation admission and
persist in the existing KeyManager secret map. Tenant export/restore preserves active and previous
versions unchanged; restoring the same active key preserves hash outputs. No key is placed in a
mapping row, trace, response, queue schema or new DR dataset. Release migration/baseline/manifests
remain owner-controlled and are unchanged.
