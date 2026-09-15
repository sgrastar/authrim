export const PHASE4_EXTERNAL_PREREQUISITE_KINDS = [
  'key_material',
  'shared_key',
  'external_callback',
  'certificate_trust',
  'email_delivery',
  'directory_connection',
] as const;

export type Phase4ExternalPrerequisiteKind = (typeof PHASE4_EXTERNAL_PREREQUISITE_KINDS)[number];

export interface Phase4ExternalPrerequisite {
  id: string;
  kind: Phase4ExternalPrerequisiteKind;
  scope: 'tenant' | 'shared';
  resolution: 'included' | 'target_binding' | 'reconnect';
  status: 'resolved' | 'unresolved';
  required: boolean;
}

const ID_PATTERN = /^[A-Za-z0-9_.:/-]{1,256}$/;
const EXACT_KEYS = ['id', 'kind', 'required', 'resolution', 'scope', 'status'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>): void {
  const keys = Object.keys(value).sort();
  if (keys.length !== EXACT_KEYS.length || keys.some((key, index) => key !== EXACT_KEYS[index]))
    throw new Error('backup_phase4_prerequisites_invalid');
}

/**
 * Validates the target-side dependencies which cannot always be carried in a tenant bundle.
 * The returned list is stable and safe to display because it contains identifiers and states only.
 */
export function assertPhase4ExternalPrerequisitesResolved(
  value: unknown
): readonly Phase4ExternalPrerequisite[] {
  if (!Array.isArray(value) || value.length > 1024)
    throw new Error('backup_phase4_prerequisites_invalid');

  const seen = new Set<string>();
  const normalized = value.map((candidate): Phase4ExternalPrerequisite => {
    if (!isRecord(candidate)) throw new Error('backup_phase4_prerequisites_invalid');
    assertExactKeys(candidate);
    const { id, kind, scope, resolution, status, required } = candidate;
    if (
      typeof id !== 'string' ||
      !ID_PATTERN.test(id) ||
      !PHASE4_EXTERNAL_PREREQUISITE_KINDS.includes(kind as Phase4ExternalPrerequisiteKind) ||
      (scope !== 'tenant' && scope !== 'shared') ||
      (resolution !== 'included' &&
        resolution !== 'target_binding' &&
        resolution !== 'reconnect') ||
      (status !== 'resolved' && status !== 'unresolved') ||
      typeof required !== 'boolean' ||
      seen.has(id) ||
      (scope === 'shared' && resolution === 'included')
    )
      throw new Error('backup_phase4_prerequisites_invalid');
    seen.add(id);
    return {
      id,
      kind: kind as Phase4ExternalPrerequisiteKind,
      scope,
      resolution,
      status,
      required,
    };
  });

  if (normalized.some(({ required, status }) => required && status !== 'resolved'))
    throw new Error('backup_phase4_prerequisites_unresolved');
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}
