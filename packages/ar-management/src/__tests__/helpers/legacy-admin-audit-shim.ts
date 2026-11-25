/**
 * Tests written against createAuditLogFromContext assert on its positional arguments. Modules
 * now record admin operations with recordAdminOperationAudit, which this replaces in those
 * tests: each call is forwarded to the (usually mocked) createAuditLogFromContext, so the tests
 * keep checking which action, resource and metadata a handler records, and a rejection still
 * reaches the handler. recordAdminOperationAudit itself is tested in
 * admin-operation-audit.test.ts.
 *
 *   vi.mock('../admin-operation-audit', () => import('./helpers/legacy-admin-audit-shim'));
 */
import { createAuditLogFromContext } from '@authrim/ar-lib-core';
import type { AdminOperationAuditInput } from '../../admin-operation-audit';

export async function recordAdminOperationAudit(
  c: unknown,
  input: AdminOperationAuditInput
): Promise<string> {
  const args: unknown[] = [
    c,
    input.action,
    input.resourceType,
    input.resourceId ?? '',
    input.metadata ?? {},
  ];
  if (input.severity) args.push(input.severity);
  await (createAuditLogFromContext as (...forwarded: unknown[]) => Promise<void>)(...args);
  return `audit-${input.action}`;
}
