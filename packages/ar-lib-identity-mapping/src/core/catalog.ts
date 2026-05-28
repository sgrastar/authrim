import { buildTraceEntry } from './trace';
import { reason } from './reason-registry';
import { statusFromReasons } from './result';
import type {
  FieldCatalogBundle,
  FieldCatalogEntry,
  ReasonCode,
  RedactionClassification,
  TargetType,
  ValidationResult,
} from './types';

const TARGET_TYPES: TargetType[] = [
  'canonical',
  'custom',
  'derived',
  'outbound-only',
  'review-only',
];

const CLASSIFICATIONS: RedactionClassification[] = [
  'public',
  'internal',
  'pii',
  'secret',
  'regulated',
  'credential',
  'token',
  'key_material',
];

export function validateCatalogBundle(catalog: FieldCatalogBundle): ValidationResult {
  const reasons: ReasonCode[] = [];

  if (
    !catalog.identity.id ||
    !catalog.identity.version ||
    !catalog.identity.contentHash ||
    !catalog.identity.compatibilityRange
  ) {
    reasons.push(reason('catalog.invalid_bundle'));
  }

  const ids = new Set<string>();
  const aliases = new Set<string>();

  for (const entry of catalog.entries) {
    if (!isValidEntry(entry)) {
      reasons.push(reason('catalog.invalid_entry'));
    }

    if (ids.has(entry.id)) {
      reasons.push(reason('catalog.duplicate_id'));
    }
    ids.add(entry.id);

    for (const alias of entryAliases(entry)) {
      if (aliases.has(alias)) {
        reasons.push(reason('catalog.duplicate_alias'));
      }
      aliases.add(alias);
    }
  }

  return {
    status: statusFromReasons(reasons),
    reasons,
    trace: reasons.map((item) => buildTraceEntry({ reason: item })),
  };
}

export function findCatalogEntry(
  catalog: FieldCatalogBundle,
  ref: { catalogEntryId?: string; namespace: string; path: string }
): FieldCatalogEntry | undefined {
  if (ref.catalogEntryId) {
    return catalog.entries.find((entry) => entry.id === ref.catalogEntryId);
  }
  return catalog.entries.find((entry) =>
    entryAliases(entry).includes(`${ref.namespace}:${ref.path}`)
  );
}

function isValidEntry(entry: FieldCatalogEntry): boolean {
  return Boolean(
    entry.id &&
    entry.namespace &&
    entry.path &&
    entry.valueType &&
    (entry.cardinality === 'single' || entry.cardinality === 'multi') &&
    CLASSIFICATIONS.includes(entry.classification) &&
    (!entry.targetType || TARGET_TYPES.includes(entry.targetType))
  );
}

function entryAliases(entry: FieldCatalogEntry): string[] {
  return [
    `${entry.namespace}:${entry.path}`,
    ...(entry.aliases ?? []).map((alias) => `${alias.namespace}:${alias.path}`),
  ];
}
