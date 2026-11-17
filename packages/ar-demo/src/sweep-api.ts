import { AdminApiError, callMachineApi } from './admin-api';
import { isSweepUserId, SWEEP_TENANT_ID, type SweepConfig } from './sweep-config';
import type { Deps } from './types';

export const SWEEP_SCOPES = ['admin:users:read', 'admin:users:delete'] as const;
export type SweepPosition = { cursor: string } | { page: number };
export interface SweepUser {
  id: string;
  createdAt: number | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reduce the rich Admin API response immediately. Nothing containing PII escapes this helper. */
export async function listSweepUsers(
  config: SweepConfig,
  deps: Deps,
  position?: SweepPosition
): Promise<{ users: SweepUser[]; next: SweepPosition | null }> {
  const query = new URLSearchParams({ limit: '100' });
  if (position && 'cursor' in position) query.set('cursor', position.cursor);
  if (position && 'page' in position) query.set('page', String(position.page));
  const { status, body } = await callMachineApi(
    config,
    deps,
    `/api/admin/users?${query.toString()}`,
    { method: 'GET', headers: { 'X-Tenant-Id': SWEEP_TENANT_ID } },
    SWEEP_SCOPES,
    undefined,
    1024 * 1024
  );
  if (status !== 200) throw new AdminApiError('upstream', status);
  const invalid = () => new AdminApiError('invalid_response', status);
  if (!record(body) || !Array.isArray(body.users) || body.users.length > 100) throw invalid();
  const users: SweepUser[] = [];
  for (const user of body.users) {
    if (
      !record(user) ||
      !isSweepUserId(user.id) ||
      user.tenant_id !== SWEEP_TENANT_ID ||
      (user.created_at !== null &&
        (typeof user.created_at !== 'number' ||
          !Number.isSafeInteger(user.created_at) ||
          user.created_at <= 0))
    ) {
      throw invalid();
    }
    users.push({ id: user.id, createdAt: user.created_at });
  }
  const pagination = body.pagination;
  if (!record(pagination) || typeof pagination.hasNext !== 'boolean') throw invalid();
  let next: SweepPosition | null = null;
  if (pagination.mode === 'cursor') {
    if (position && 'page' in position) throw invalid();
    if (pagination.hasNext) {
      if (
        typeof pagination.nextCursor !== 'string' ||
        pagination.nextCursor.length === 0 ||
        pagination.nextCursor.length > 8192
      ) {
        throw invalid();
      }
      next = { cursor: pagination.nextCursor };
    } else if (pagination.nextCursor !== null) throw invalid();
  } else {
    if (position && 'cursor' in position) throw invalid();
    const page = position && 'page' in position ? position.page : 1;
    if (
      pagination.mode !== undefined ||
      pagination.page !== page ||
      pagination.limit !== 100 ||
      typeof pagination.totalPages !== 'number' ||
      !Number.isSafeInteger(pagination.totalPages) ||
      pagination.totalPages < 0 ||
      pagination.hasNext !== page < pagination.totalPages
    ) {
      throw invalid();
    }
    if (pagination.hasNext) next = { page: page + 1 };
  }
  return { users, next };
}

export async function deleteSweepUser(
  config: SweepConfig,
  deps: Deps,
  id: string
): Promise<'deleted' | 'not_found' | 'legal_hold'> {
  if (!isSweepUserId(id)) throw new AdminApiError('invalid_response');
  const { status, body } = await callMachineApi(
    config,
    deps,
    `/api/admin/users/${encodeURIComponent(id)}`,
    { method: 'DELETE', headers: { 'X-Tenant-Id': SWEEP_TENANT_ID } },
    SWEEP_SCOPES
  );
  if (status === 200) return 'deleted';
  if (status === 404) return 'not_found';
  if (status === 409 && record(body) && body.error === 'legal_hold_active') return 'legal_hold';
  throw new AdminApiError('upstream', status);
}
