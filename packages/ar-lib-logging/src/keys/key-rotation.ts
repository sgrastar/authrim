import { parseLoggingKeyMaterialRef } from './key-material-backend';
import type { LoggingKeyRegistryRow, LoggingKeyVersionRow } from './key-registry-snapshot';

export interface RotateLoggingKeyRegistryInput {
  registry: LoggingKeyRegistryRow;
  versions: LoggingKeyVersionRow[];
  newBackendRef: string;
  now: number;
}

export interface RotateLoggingKeyRegistryResult {
  registry: LoggingKeyRegistryRow;
  versions: LoggingKeyVersionRow[];
  previousActiveVersions: LoggingKeyVersionRow[];
}

export function rotateLoggingKeyRegistry(
  input: RotateLoggingKeyRegistryInput
): RotateLoggingKeyRegistryResult {
  const existingVersions = input.versions.filter(
    (version) => version.keyRegistryId === input.registry.id
  );
  const nextVersion =
    Math.max(input.registry.activeVersion, ...existingVersions.map((v) => v.version)) + 1;
  const parsedRef = parseLoggingKeyMaterialRef(input.newBackendRef);
  if (parsedRef.version !== nextVersion) {
    throw new Error('logging_key_rotation_backend_ref_version_mismatch');
  }

  const previousActiveVersions = existingVersions.filter((version) => version.status === 'active');
  const hasStaleMaterial = previousActiveVersions.some(
    (version) => version.usageCount > 0 || version.staleCount > 0
  );
  const rotatedVersions: LoggingKeyVersionRow[] = [
    ...input.versions.filter((version) => version.keyRegistryId !== input.registry.id),
    ...existingVersions.map((version) => {
      if (version.status !== 'active') {
        return version;
      }
      return {
        ...version,
        status: hasStaleMaterial ? 'rewrap_required' : 'retired',
        retiredAt: hasStaleMaterial ? null : input.now,
        staleCount: Math.max(version.staleCount, version.usageCount),
      } satisfies LoggingKeyVersionRow;
    }),
    {
      keyRegistryId: input.registry.id,
      version: nextVersion,
      backendRef: input.newBackendRef,
      status: 'active',
      usageCount: 0,
      staleCount: 0,
      createdAt: input.now,
      retiredAt: null,
    },
  ];

  return {
    registry: {
      ...input.registry,
      activeVersion: nextVersion,
      status: hasStaleMaterial ? 'stale' : 'active',
      lastRotatedAt: input.now,
      updatedAt: input.now,
    },
    versions: rotatedVersions,
    previousActiveVersions,
  };
}
