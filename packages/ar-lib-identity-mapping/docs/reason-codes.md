# Reason Codes

This file is the reviewed docs snapshot for the PR1 reason code registry.

| Code | Category | Severity | Stability | Description |
|---|---|---|---|---|
| `adapter.malformed_record` | adapter | error | stable | Adapter input record cannot be converted into core input. |
| `adapter.missing_column` | adapter | error | stable | CSV input is missing a required column. |
| `adapter.unsupported_attribute_shape` | adapter | error | stable | SAML attribute shape is unsupported by the preview adapter. |
| `adapter.unsupported_claim_shape` | adapter | error | stable | OIDC claims request shape is unsupported by the preview adapter. |
| `catalog.duplicate_alias` | catalog | error | stable | Catalog aliases must be unique within a bundle. |
| `catalog.duplicate_id` | catalog | error | stable | Catalog entry identifiers must be unique. |
| `catalog.invalid_bundle` | catalog | error | stable | Catalog bundle identity or compatibility metadata is invalid. |
| `catalog.invalid_entry` | catalog | error | stable | Catalog entry is missing required fields or contains unsupported taxonomy. |
| `fixture.invalid_static_fixture` | fixture | error | stable | Static fixture does not match the PR1 fixture contract. |
| `policy.deny_locked` | policy | critical | stable | Deny or lock policy overrides lower-priority allows. |
| `policy.rule_discarded` | policy | info | stable | Candidate policy rule was discarded during merge. |
| `policy.rule_selected` | policy | info | stable | Candidate policy rule was selected during merge. |
| `trace.unsafe_metadata` | trace | error | stable | Trace metadata key or value is not allowlisted. |
| `trace.mapping_evaluated` | trace | info | stable | Mapping edge was evaluated during dry-run. |
| `transform.invalid_output` | transform | error | stable | Transform output does not satisfy its output contract. |
| `transform.invalid_parameter` | transform | error | stable | Transform parameter has an invalid type or value. |
| `transform.missing_parameter` | transform | error | stable | Required transform parameter is missing. |
| `transform.unknown_parameter` | transform | warning | stable | Transform parameter is not defined by the operation schema. |
| `transform.unsupported_operation` | transform | error | stable | Transform operation is not supported by PR1. |
| `validation.cardinality_mismatch` | validation | error | stable | Value cardinality does not match the catalog or validation rule. |
| `validation.format_mismatch` | validation | warning | stable | Value does not match the requested format. |
| `validation.required_missing` | validation | critical | stable | Required input or target value is missing. |
| `validation.type_mismatch` | validation | error | stable | Value type does not match the catalog or validation rule. |
| `validation.value_not_allowed` | validation | error | stable | Value is not included in the allowed enum set. |
