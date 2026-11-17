import type { MachineApiConfig } from './admin-api';
import { parseOrigin, parsePrivateJwk } from './config';
import type { Env } from './types';

/** This task can never select a visitor tenant, even through configuration. */
export const SWEEP_TENANT_ID = 'default';
export const isSweepUserId = (id: unknown): id is string =>
  typeof id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(id);

export interface SweepConfig extends MachineApiConfig {
  dryRun: boolean;
  minAgeMinutes: number;
  maxDeletes: number;
  maxPages: number;
  keepUserIds: ReadonlySet<string>;
}

type SweepConfigResult =
  | { ok: true; config: SweepConfig | null }
  | { ok: false; problems: string[] };

/** Disabled without credentials; enabled with invalid policy never falls back to deletion. */
export function loadSweepConfig(env: Env): SweepConfigResult {
  if (env.SWEEP_ENABLED === undefined || env.SWEEP_ENABLED === 'false') {
    return { ok: true, config: null };
  }
  const problems: string[] = [];
  if (env.SWEEP_ENABLED !== 'true') problems.push('SWEEP_ENABLED');
  const dryRun = env.SWEEP_DRY_RUN !== 'false';
  if (env.SWEEP_DRY_RUN !== undefined && !['true', 'false'].includes(env.SWEEP_DRY_RUN)) {
    problems.push('SWEEP_DRY_RUN');
  }
  if (env.DEFAULT_TENANT_ID !== undefined && env.DEFAULT_TENANT_ID !== SWEEP_TENANT_ID) {
    problems.push('DEFAULT_TENANT_ID');
  }
  const integer = (
    name: 'SWEEP_MIN_AGE_MINUTES' | 'SWEEP_MAX_DELETES_PER_RUN' | 'SWEEP_MAX_PAGES',
    fallback: number,
    maximum: number
  ): number => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = String(raw);
    if (!/^\d{1,6}$/.test(value) || Number(value) < 1 || Number(value) > maximum) {
      problems.push(name);
      return fallback;
    }
    return Number(value);
  };
  const minAgeMinutes = integer('SWEEP_MIN_AGE_MINUTES', 30, 10080);
  const maxDeletes = integer('SWEEP_MAX_DELETES_PER_RUN', 5, 200);
  const maxPages = integer('SWEEP_MAX_PAGES', 10, 10);
  // An explicitly empty list is allowed; destructive operation requires the operator to set it.
  const keep = env.SWEEP_KEEP_USER_IDS;
  const ids = keep === undefined || keep === '' ? [] : keep.split(',').map((id) => id.trim());
  if (
    (!dryRun && keep === undefined) ||
    (keep?.length ?? 0) > 65536 ||
    ids.length > 1000 ||
    ids.some((id) => !isSweepUserId(id))
  ) {
    problems.push('SWEEP_KEEP_USER_IDS');
  }
  const required = (name: 'SWEEP_MACHINE_CLIENT_ID' | 'SWEEP_MACHINE_KEY_ID'): string => {
    const value = env[name];
    if (!value || value.length > 256 || value.trim() !== value) {
      problems.push(name);
      return '';
    }
    return value;
  };
  const machineClientId = required('SWEEP_MACHINE_CLIENT_ID');
  const machineKeyId = required('SWEEP_MACHINE_KEY_ID');
  if (machineClientId && machineClientId === env.MACHINE_CLIENT_ID) {
    problems.push('SWEEP_MACHINE_CLIENT_ID');
  }
  const machinePrivateJwk = parsePrivateJwk(env.SWEEP_MACHINE_PRIVATE_JWK);
  if (!machinePrivateJwk) problems.push('SWEEP_MACHINE_PRIVATE_JWK');
  const adminApiOrigin = parseOrigin(env.ADMIN_API_ORIGIN, env.ENVIRONMENT === 'development');
  if (!adminApiOrigin) problems.push('ADMIN_API_ORIGIN');
  if (problems.length || !machinePrivateJwk || !adminApiOrigin) return { ok: false, problems };
  return {
    ok: true,
    config: {
      adminApiOrigin,
      machineClientId,
      machineKeyId,
      machinePrivateJwk,
      dryRun,
      minAgeMinutes,
      maxDeletes,
      maxPages,
      keepUserIds: new Set(ids),
    },
  };
}
