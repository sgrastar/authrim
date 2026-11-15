# Mapping graphs (W1a)

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

## Persistence boundary for W1b

No schema or stored JSON format changes in W1a. The admin facade and version endpoints accept
legacy `edgeIndex` and new `inputs`/`output`. GET translates single-edge stored rules into the new
shape. Canonical graph request size is checked before saving, so a GET can be saved unchanged.
SQL still writes exactly one `edge_id` per step. Multi-input, chaining, named inputs, multiple targets,
and non-last output requests return 400 `unsupported_until_w1b`; none is silently flattened.

Runtime rows retain their existing `rule_id` when loaded. Single-edge groups and generating rules
are reconstructed with an explicit last-step output, including competing rules allowed by a conflict
policy. Only each rule's final output is released. Runtime merges these outputs at their original
edge or last-step positions among legacy writers, preserving row priority and order without releasing
raw edges or intermediate steps. Existing multi-edge or multi-target groups remain on the one
legacy compatibility evaluator until W1b migrates them; their GET shape also remains legacy because
one output cannot represent them faithfully. Legacy conflict policies explicitly resolve several
rules writing the same target; save rejects `duplicate_target` unless such a policy names it.
Explicit runtime graphs always require unique targets. Suppressed identifiers remove stand-ins
from the target even across legacy writers.

For reconstructed stored rows, the evaluator reads an edge into an envelope whose `sourceRef` is
that edge's `targetRef`, just as the compatibility evaluator did. This preserves existing `json_build`
keys and keyMap lookup, while retaining source metadata and provenance. Native in-memory graphs keep
source references by default, so authoring operations can name individual source inputs. The adapter
selects `edgeValueReferences: 'target'`; this is runtime compatibility, not additional stored metadata.

W1b must persist ordered references and explicit output, migrate legacy multi-target/conflict
rules, then remove reconstruction and the compatibility evaluator. W2 registers the remaining
identifier-safe text operations; the allow-list is data and does not itself register those operations.
Pairwise OIDC subject and SAML NameID require the identifier itself as output, without post-steps.
