/**
 * Tests written against createAuditLogFromContext (and scheduleAdminAuditLog) assert on their
 * positional arguments. Modules now record admin operations with recordAdminOperationAudit,
 * which this replaces in those tests. Each call is forwarded the way the older code wrote it:
 *
 * - to createAuditLogFromContext (usually mocked), where the end-user log still gets a row: a
 *   configuration change (written there by the older code) or an operation on a named end user
 *   (under that user's action name). An operation on a user that names no user (an
 *   anonymization) is not forwarded, as nothing is written to the end-user log for it. The tests
 *   keep checking the action, resource and metadata a handler records, and a rejection still
 *   reaches the handler;
 * - for an operation on a user, which the older code also recorded in the admin audit log: to
 *   scheduleAdminAuditLog when a test mocks it, otherwise to writeAdminAuditLog, under the admin
 *   action name.
 *
 * recordAdminOperationAudit itself is tested in admin-operation-audit.test.ts and
 * admin-operation-audit.integration.test.ts.
 *
 *   vi.mock('../admin-operation-audit', () => import('./helpers/legacy-admin-audit-shim'));
 */
import { vi } from 'vitest';
import { createAuditLog, createAuditLogFromContext, type Env } from '@authrim/ar-lib-core';
import { scheduleAdminAuditLog, writeAdminAuditLog } from '../../admin-shared';
import type {
  AdminOperationAuditFromEnvInput,
  AdminOperationAuditInput,
} from '../../admin-operation-audit';

export async function recordAdminOperationAudit(
  c: unknown,
  input: AdminOperationAuditInput
): Promise<string> {
  const args: unknown[] = [
    c,
    input.endUser?.action ?? input.action,
    input.resourceType,
    input.resourceId ?? '',
    input.endUser?.metadata ?? input.metadata ?? {},
  ];
  if (input.severity) args.push(input.severity);
  if (input.endUser || input.resourceType !== 'user') {
    await (createAuditLogFromContext as (...forwarded: unknown[]) => Promise<void>)(...args);
  }
  if (input.resourceType === 'user') {
    if (vi.isMockFunction(scheduleAdminAuditLog)) {
      (scheduleAdminAuditLog as (...forwarded: unknown[]) => void)(
        c,
        input.action,
        input.resourceId,
        input.result ?? 'success',
        input.metadata
      );
    } else if (typeof writeAdminAuditLog === 'function') {
      // Best effort, as the older scheduleAdminAuditLog was; a test that stubs the admin store
      // away is not testing this record.
      await writeAdminAuditLog(c as Parameters<typeof writeAdminAuditLog>[0], {
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        result: input.result ?? 'success',
        metadata: input.metadata,
      }).catch(() => null);
    }
  }
  return `audit-${input.action}`;
}

/** A deferred admin operation, forwarded to createAuditLog as the older code wrote it. */
export async function recordAdminOperationAuditFromEnv(
  env: Env,
  input: AdminOperationAuditFromEnvInput
): Promise<string> {
  await createAuditLog(env, {
    tenantId: input.tenantId,
    userId: input.actorId,
    action: input.action,
    resource: input.resourceType,
    resourceId: input.resourceId ?? '',
    ipAddress: 'internal',
    userAgent: 'internal',
    metadata: JSON.stringify(input.metadata ?? {}),
    severity: input.severity ?? 'info',
  });
  return `audit-${input.action}`;
}
