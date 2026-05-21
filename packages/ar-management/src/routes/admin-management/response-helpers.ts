import type { Context } from 'hono';
import type { ARErrorCode } from '@authrim/ar-lib-core';
import { AR_ERROR_CODES, createErrorResponse } from '@authrim/ar-lib-core';

export interface AdminFieldError {
  path: string;
  code: string;
  message: string;
}

export interface AdminErrorDetails {
  fields?: AdminFieldError[];
  conflict?: {
    expected_version?: number;
    actual_version?: number;
    current_etag?: string;
    reason?: string;
  };
  permission?: {
    required_permission?: string;
    required_scope?: string;
    reason?: string;
  };
}

export interface AdminListEnvelope<T> {
  items: T[];
  total: number;
  page?: Record<string, unknown>;
}

export interface AdminDetailEnvelope<T> {
  item: T;
}

export interface AdminMutationEnvelope<T> {
  item: T;
  audit_id?: string | null;
  version?: number;
}

export interface AdminActionEnvelope<T> {
  result: T;
  audit_id?: string | null;
  job_id?: string;
}

export function fieldError(path: string, code: string, message: string): AdminFieldError {
  return { path, code, message };
}

export function adminListEnvelope<T>(
  items: T[],
  options?: { total?: number; page?: Record<string, unknown> }
): AdminListEnvelope<T> {
  return {
    items,
    total: options?.total ?? items.length,
    ...(options?.page && { page: options.page }),
  };
}

export function adminDetailEnvelope<T>(item: T): AdminDetailEnvelope<T> {
  return { item };
}

export function adminMutationEnvelope<T>(
  item: T,
  options?: { auditId?: string | null; version?: number }
): AdminMutationEnvelope<T> {
  return {
    item,
    ...(options?.auditId !== undefined && { audit_id: options.auditId }),
    ...(options?.version !== undefined && { version: options.version }),
  };
}

export function adminActionEnvelope<T>(
  result: T,
  options?: { auditId?: string | null; jobId?: string }
): AdminActionEnvelope<T> {
  return {
    result,
    ...(options?.auditId !== undefined && { audit_id: options.auditId }),
    ...(options?.jobId && { job_id: options.jobId }),
  };
}

export async function createAdminErrorResponseWithDetails(
  c: Context,
  code: ARErrorCode,
  details: AdminErrorDetails
): Promise<Response> {
  return createErrorResponse(c, code, {
    extensions: {
      details,
    },
  });
}

export async function createAdminFieldErrorResponse(
  c: Context,
  fields: AdminFieldError[]
): Promise<Response> {
  return createAdminErrorResponseWithDetails(c, AR_ERROR_CODES.ADMIN_INVALID_REQUEST, {
    fields,
  });
}

export async function createAdminPermissionErrorResponse(
  c: Context,
  permission: NonNullable<AdminErrorDetails['permission']>
): Promise<Response> {
  return createAdminErrorResponseWithDetails(c, AR_ERROR_CODES.ADMIN_INSUFFICIENT_PERMISSIONS, {
    permission,
  });
}
