import type { LogPlane, LogType } from '../registry';
import {
  parseLoggingKeyMaterialRef,
  type LoggingKeyMaterialBackendKind,
} from './key-material-backend';

export type LoggingKeyRegistryStatus =
  | 'active'
  | 'rotating'
  | 'stale'
  | 'compromised'
  | 'disabled';

export type LoggingKeyVersionStatus = 'active' | 'retired' | 'rewrap_required' | 'compromised';

export interface LoggingKeyRegistryRow {
  id: string;
  tenantKey: string;
  surface?: string | null;
  logType: LogType;
  plane: LogPlane;
  activeVersion: number;
  status: LoggingKeyRegistryStatus;
  lastRotatedAt?: number | null;
  updatedAt: number;
}

export interface LoggingKeyVersionRow {
  keyRegistryId: string;
  version: number;
  backendRef: string;
  status: LoggingKeyVersionStatus;
  usageCount: number;
  staleCount: number;
  createdAt: number;
  retiredAt?: number | null;
}

export interface RuntimeLoggingKeyVersionSnapshot {
  version: number;
  backend: LoggingKeyMaterialBackendKind;
  backend_ref: string;
  status: LoggingKeyVersionStatus;
  created_at: number;
  retired_at?: number | null;
}

export interface RuntimeLoggingKeyRegistrySnapshot {
  id: string;
  tenant_key: string;
  surface?: string | null;
  log_type: LogType;
  plane: LogPlane;
  active_version: number;
  status: LoggingKeyRegistryStatus;
  last_rotated_at?: number | null;
  updated_at: number;
  versions: RuntimeLoggingKeyVersionSnapshot[];
}

export function buildRuntimeLoggingKeyRegistrySnapshot(
  registry: LoggingKeyRegistryRow,
  versions: LoggingKeyVersionRow[]
): RuntimeLoggingKeyRegistrySnapshot {
  return {
    id: registry.id,
    tenant_key: registry.tenantKey,
    surface: registry.surface ?? null,
    log_type: registry.logType,
    plane: registry.plane,
    active_version: registry.activeVersion,
    status: registry.status,
    last_rotated_at: registry.lastRotatedAt ?? null,
    updated_at: registry.updatedAt,
    versions: versions
      .filter((version) => version.keyRegistryId === registry.id)
      .map((version) => ({
        version: version.version,
        backend: parseLoggingKeyMaterialRef(version.backendRef).backend,
        backend_ref: version.backendRef,
        status: version.status,
        created_at: version.createdAt,
        retired_at: version.retiredAt ?? null,
      })),
  };
}
