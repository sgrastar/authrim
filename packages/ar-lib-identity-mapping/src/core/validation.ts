import { findCatalogEntry, validateCatalogBundle } from './catalog';
import { buildTraceEntry } from './trace';
import { reason } from './reason-registry';
import { statusFromReasons } from './result';
import { validateTransformStep } from './transforms';
import type {
  FieldCatalogEntry,
  FormatKind,
  MappingInput,
  ReasonCode,
  SourceValueEnvelope,
  ValidationResult,
} from './types';

export function validateMappingInput(input: MappingInput): ValidationResult {
  const catalogResult = validateCatalogBundle(input.catalog);
  const reasons: ReasonCode[] = [...catalogResult.reasons];

  for (const edge of input.edges) {
    if (!findCatalogEntry(input.catalog, edge.targetRef)) {
      reasons.push(reason('catalog.invalid_entry'));
    }
  }

  for (const value of input.sourceValues) {
    const entry = findCatalogEntry(input.catalog, value.sourceRef);
    if (entry) {
      reasons.push(...validateValueAgainstCatalog(value, entry));
    }
  }

  for (const transform of input.transforms ?? []) {
    reasons.push(...validateTransformStep(transform).reasons);
  }

  for (const rule of input.validationRules ?? []) {
    const matched = input.sourceValues.find((value) =>
      sameFieldRef(value.sourceRef, rule.targetRef)
    );
    if (rule.kind === 'required' && (!matched || isMissing(matched.value))) {
      reasons.push({
        ...reason('validation.required_missing'),
        severity: rule.defaultSeverity ?? 'critical',
      });
    }
    if (rule.kind === 'type' && matched) {
      const valueType = rule.parameters?.valueType;
      if (typeof valueType === 'string' && !matchesValueType(valueType, matched.value)) {
        reasons.push({
          ...reason('validation.type_mismatch'),
          severity: rule.defaultSeverity ?? 'error',
        });
      }
    }
    if (rule.kind === 'enum' && matched) {
      const allowedValues = rule.parameters?.allowedValues;
      if (Array.isArray(allowedValues) && !allowedValues.includes(matched.value)) {
        reasons.push({
          ...reason('validation.value_not_allowed'),
          severity: rule.defaultSeverity ?? 'error',
        });
      }
    }
    if (rule.kind === 'format' && matched && typeof matched.value === 'string') {
      const format = rule.parameters?.format as FormatKind | undefined;
      if (format && !matchesFormat(format, matched.value)) {
        reasons.push({
          ...reason('validation.format_mismatch'),
          severity: rule.defaultSeverity ?? 'warning',
        });
      }
    }
    if (rule.kind === 'cardinality' && matched) {
      const cardinality = rule.parameters?.cardinality;
      const isMulti = Array.isArray(matched.value);
      if (
        (cardinality === 'single' && isMulti) ||
        (cardinality === 'multi' && !isMulti && !isMissing(matched.value))
      ) {
        reasons.push({
          ...reason('validation.cardinality_mismatch'),
          severity: rule.defaultSeverity ?? 'error',
        });
      }
    }
  }

  return {
    status: statusFromReasons(reasons),
    reasons,
    trace: reasons.map((item) => buildTraceEntry({ reason: item })),
  };
}

function validateValueAgainstCatalog(
  sourceValue: SourceValueEnvelope,
  entry: FieldCatalogEntry
): ReasonCode[] {
  const reasons: ReasonCode[] = [];

  if (entry.cardinality === 'single' && Array.isArray(sourceValue.value)) {
    reasons.push(reason('validation.cardinality_mismatch'));
  }

  if (!matchesValueType(entry.valueType, sourceValue.value)) {
    reasons.push(reason('validation.type_mismatch'));
  }

  return reasons;
}

function matchesValueType(valueType: string, value: unknown): boolean {
  if (value === undefined || value === null || value === '') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => matchesValueType(valueType, item));
  }
  if (valueType === 'string') {
    return typeof value === 'string';
  }
  if (valueType === 'number') {
    return typeof value === 'number';
  }
  if (valueType === 'boolean') {
    return typeof value === 'boolean';
  }
  return true;
}

function matchesFormat(format: FormatKind, value: string): boolean {
  switch (format) {
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case 'uri':
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value);
    case 'datetime':
      return !Number.isNaN(Date.parse(value));
    case 'phone':
      return /^\+?[0-9][0-9 .-]{6,}$/.test(value);
    case 'locale':
      return /^[a-z]{2,3}(-[A-Z]{2})?$/.test(value);
    default:
      return true;
  }
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function sameFieldRef(
  left: SourceValueEnvelope['sourceRef'],
  right: SourceValueEnvelope['sourceRef']
): boolean {
  if (left.catalogEntryId && right.catalogEntryId) {
    return left.catalogEntryId === right.catalogEntryId;
  }
  return left.side === right.side && left.namespace === right.namespace && left.path === right.path;
}
