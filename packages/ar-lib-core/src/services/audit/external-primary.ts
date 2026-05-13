import type { D1Database } from '@cloudflare/workers-types';
import type { DatabaseAdapter } from '../../db';
import { ensureDatabaseAdapter, MysqlAdapter, PostgresAdapter } from '../../db';
import type { AuditTarget } from '../../types/runtime-profile';
import { resolveHyperdriveBindingForAuditTarget } from './hyperdrive-binding';
import type { IAuditStorageAdapter } from './storage';
import {
  createD1EventLogAdapter,
  createD1PIILogAdapter,
  createHyperdriveAuditAdapter,
  createMysqlAuditAdapter,
} from './storage';

function isD1Database(value: unknown): value is D1Database {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as { prepare?: unknown }).prepare === 'function'
  );
}

function resolveAuditD1Binding(
  env: Record<string, unknown>,
  target: { bindingRef?: string },
  logType: 'event' | 'pii'
): D1Database | null {
  if (logType === 'pii') {
    const piiDb = env.DB_PII;
    return isD1Database(piiDb) ? piiDb : null;
  }

  const bindingRef = target.bindingRef ?? 'DB';
  const binding = env[bindingRef];
  return isD1Database(binding) ? binding : null;
}

export function createAuditPrimaryDatabaseAdapter(
  env: Record<string, unknown>,
  target: AuditTarget,
  partition: string
): DatabaseAdapter | null {
  if (target.type === 'd1') {
    const db = resolveAuditD1Binding(env, target, 'event');
    return db ? ensureDatabaseAdapter(db, partition) : null;
  }

  return createExternalAuditDatabaseAdapter(env, target, partition);
}

export function createExternalAuditDatabaseAdapter(
  env: Record<string, unknown>,
  target: AuditTarget,
  partition: string
): DatabaseAdapter | null {
  if (target.type !== 'postgres' && target.type !== 'mysql') {
    return null;
  }

  const hyperdrive = resolveHyperdriveBindingForAuditTarget(env, target);
  if (!hyperdrive) {
    return null;
  }

  if (target.type === 'postgres') {
    return new PostgresAdapter({
      hyperdrive,
      partition,
    });
  }

  return new MysqlAdapter({
    hyperdrive,
    partition,
  });
}

export function createExternalAuditStorageAdapter(
  env: Record<string, unknown>,
  target: AuditTarget,
  logType: 'event' | 'pii',
  options?: {
    id?: string;
    postgresSchema?: string;
    mysqlSchema?: string;
  }
): IAuditStorageAdapter | null {
  if (target.type !== 'postgres' && target.type !== 'mysql') {
    return null;
  }

  const hyperdrive = resolveHyperdriveBindingForAuditTarget(env, target);
  if (!hyperdrive) {
    return null;
  }

  const id =
    options?.id ?? target.connectionRef ?? target.bindingRef ?? `${target.type}-${logType}`;

  if (target.type === 'postgres') {
    return createHyperdriveAuditAdapter(hyperdrive, {
      id,
      schema: options?.postgresSchema ?? 'audit',
      isPiiDb: logType === 'pii',
    });
  }

  return createMysqlAuditAdapter(hyperdrive, {
    id,
    schema: options?.mysqlSchema,
    isPiiDb: logType === 'pii',
  });
}

export function createAuditPrimaryStorageAdapter(
  env: Record<string, unknown>,
  target: AuditTarget,
  logType: 'event' | 'pii',
  options?: {
    id?: string;
    postgresSchema?: string;
    mysqlSchema?: string;
  }
): IAuditStorageAdapter | null {
  if (target.type === 'd1') {
    const db = resolveAuditD1Binding(env, target, logType);
    if (!db) {
      return null;
    }

    const id = options?.id ?? `d1-${logType}-${target.bindingRef ?? 'DB'}`;
    return logType === 'event' ? createD1EventLogAdapter(db, id) : createD1PIILogAdapter(db, id);
  }

  return createExternalAuditStorageAdapter(env, target, logType, options);
}
