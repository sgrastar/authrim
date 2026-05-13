import type { AuditTarget } from '../../types/runtime-profile';

function normalizeBindingCandidates(ref: string | undefined): string[] {
  if (!ref) {
    return [];
  }

  const normalized = ref.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  return [...new Set([ref, normalized, `HYPERDRIVE_${normalized}`])];
}

export function resolveHyperdriveBindingForAuditTarget(
  env: Record<string, unknown>,
  target: AuditTarget
): Hyperdrive | null {
  if (target.type !== 'postgres' && target.type !== 'mysql') {
    return null;
  }

  const refs = [
    ...normalizeBindingCandidates(target.bindingRef),
    ...normalizeBindingCandidates(target.connectionRef),
  ];

  for (const ref of refs) {
    const binding = env[ref];
    if (binding && typeof binding === 'object' && 'connectionString' in binding) {
      return binding as Hyperdrive;
    }
  }

  return null;
}
