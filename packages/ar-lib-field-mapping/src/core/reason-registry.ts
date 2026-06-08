import type { ReasonCategory, ReasonCode, ReasonCodeName, ReasonRegistryEntry } from './types';

export const REASON_REGISTRY: ReasonRegistryEntry[] = [
  {
    code: 'adapter.malformed_record',
    category: 'adapter',
    severity: 'error',
    stability: 'stable',
    description: 'Adapter input record cannot be converted into core input.',
  },
  {
    code: 'adapter.missing_column',
    category: 'adapter',
    severity: 'error',
    stability: 'stable',
    description: 'CSV input is missing a required column.',
  },
  {
    code: 'adapter.unsupported_attribute_shape',
    category: 'adapter',
    severity: 'error',
    stability: 'stable',
    description: 'SAML attribute shape is unsupported by the preview adapter.',
  },
  {
    code: 'adapter.unsupported_claim_shape',
    category: 'adapter',
    severity: 'error',
    stability: 'stable',
    description: 'OIDC claims request shape is unsupported by the preview adapter.',
  },
  {
    code: 'catalog.duplicate_alias',
    category: 'catalog',
    severity: 'error',
    stability: 'stable',
    description: 'Catalog aliases must be unique within a bundle.',
  },
  {
    code: 'catalog.duplicate_id',
    category: 'catalog',
    severity: 'error',
    stability: 'stable',
    description: 'Catalog entry identifiers must be unique.',
  },
  {
    code: 'catalog.invalid_bundle',
    category: 'catalog',
    severity: 'error',
    stability: 'stable',
    description: 'Catalog bundle identity or compatibility metadata is invalid.',
  },
  {
    code: 'catalog.invalid_entry',
    category: 'catalog',
    severity: 'error',
    stability: 'stable',
    description: 'Catalog entry is missing required fields or contains unsupported taxonomy.',
  },
  {
    code: 'fixture.invalid_static_fixture',
    category: 'fixture',
    severity: 'error',
    stability: 'stable',
    description: 'Static fixture does not match the PR1 fixture contract.',
  },
  {
    code: 'policy.deny_locked',
    category: 'policy',
    severity: 'critical',
    stability: 'stable',
    description: 'Deny or lock policy overrides lower-priority allows.',
  },
  {
    code: 'policy.rule_discarded',
    category: 'policy',
    severity: 'info',
    stability: 'stable',
    description: 'Candidate policy rule was discarded during merge.',
  },
  {
    code: 'policy.rule_selected',
    category: 'policy',
    severity: 'info',
    stability: 'stable',
    description: 'Candidate policy rule was selected during merge.',
  },
  {
    code: 'trace.unsafe_metadata',
    category: 'trace',
    severity: 'error',
    stability: 'stable',
    description: 'Trace metadata key or value is not allowlisted.',
  },
  {
    code: 'trace.mapping_evaluated',
    category: 'trace',
    severity: 'info',
    stability: 'stable',
    description: 'Mapping edge was evaluated during dry-run.',
  },
  {
    code: 'trace.transform_evaluated',
    category: 'trace',
    severity: 'info',
    stability: 'stable',
    description: 'Transform step was evaluated during dry-run.',
  },
  {
    code: 'transform.invalid_output',
    category: 'transform',
    severity: 'error',
    stability: 'stable',
    description: 'Transform output does not satisfy its output contract.',
  },
  {
    code: 'transform.missing_input',
    category: 'transform',
    severity: 'error',
    stability: 'stable',
    description: 'Transform step input edge did not produce a value.',
  },
  {
    code: 'transform.invalid_parameter',
    category: 'transform',
    severity: 'error',
    stability: 'stable',
    description: 'Transform parameter has an invalid type or value.',
  },
  {
    code: 'transform.missing_parameter',
    category: 'transform',
    severity: 'error',
    stability: 'stable',
    description: 'Required transform parameter is missing.',
  },
  {
    code: 'transform.unknown_parameter',
    category: 'transform',
    severity: 'warning',
    stability: 'stable',
    description: 'Transform parameter is not defined by the operation schema.',
  },
  {
    code: 'transform.unsupported_operation',
    category: 'transform',
    severity: 'error',
    stability: 'stable',
    description: 'Transform operation is not supported by PR1.',
  },
  {
    code: 'validation.cardinality_mismatch',
    category: 'validation',
    severity: 'error',
    stability: 'stable',
    description: 'Value cardinality does not match the catalog or validation rule.',
  },
  {
    code: 'validation.format_mismatch',
    category: 'validation',
    severity: 'warning',
    stability: 'stable',
    description: 'Value does not match the requested format.',
  },
  {
    code: 'validation.required_missing',
    category: 'validation',
    severity: 'critical',
    stability: 'stable',
    description: 'Required input or target value is missing.',
  },
  {
    code: 'validation.type_mismatch',
    category: 'validation',
    severity: 'error',
    stability: 'stable',
    description: 'Value type does not match the catalog or validation rule.',
  },
  {
    code: 'validation.value_not_allowed',
    category: 'validation',
    severity: 'error',
    stability: 'stable',
    description: 'Value is not included in the allowed enum set.',
  },
];

const registryByCode = new Map(REASON_REGISTRY.map((entry) => [entry.code, entry]));

export function reason(code: ReasonCodeName): ReasonCode {
  const entry = registryByCode.get(code);
  if (entry) {
    return { category: entry.category, code: entry.code, severity: entry.severity };
  }
  return { category: categoryFromCode(code), code, severity: 'error' };
}

export function categoryFromCode(code: ReasonCodeName): ReasonCategory {
  return code.split('.')[0] as ReasonCategory;
}

export function validateReasonRegistry(entries = REASON_REGISTRY): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (seen.has(entry.code)) {
      errors.push(`duplicate reason code: ${entry.code}`);
    }
    seen.add(entry.code);

    if (categoryFromCode(entry.code) !== entry.category) {
      errors.push(`category mismatch for ${entry.code}`);
    }
  }

  return errors;
}
