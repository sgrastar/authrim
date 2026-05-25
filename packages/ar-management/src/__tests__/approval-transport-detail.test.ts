import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest, ApprovalRequestRepository, Env } from '@authrim/ar-lib-core';
import {
  appendApprovalTransportEvent,
  loadApprovalTransportDetail,
} from '../approval-transport-detail';

const OBJECT_ROOT_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

interface StoredObject {
  body: Uint8Array;
  contentType?: string;
}

function createMockBucket(initial: Record<string, StoredObject> = {}) {
  const store = new Map<string, StoredObject>(Object.entries(initial));
  return {
    store,
    bucket: {
      put: vi.fn(
        async (
          key: string,
          value: ArrayBuffer | ArrayBufferView | string,
          options?: { httpMetadata?: { contentType?: string } }
        ) => {
          const body =
            typeof value === 'string'
              ? new TextEncoder().encode(value)
              : value instanceof ArrayBuffer
                ? new Uint8Array(value)
                : new Uint8Array(
                    value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
                  );
          store.set(key, {
            body,
            contentType: options?.httpMetadata?.contentType,
          });
        }
      ),
      get: vi.fn(async (key: string) => {
        const object = store.get(key);
        if (!object) {
          return null;
        }
        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(object.body);
              controller.close();
            },
          }),
          size: object.body.byteLength,
          text: async () => new TextDecoder().decode(object.body),
          writeHttpMetadata(headers: Headers) {
            if (object.contentType) {
              headers.set('Content-Type', object.contentType);
            }
          },
        };
      }),
    } as unknown as R2Bucket,
  };
}

function createMockContext(envOverrides: Partial<Env> = {}) {
  const objectStore = createMockBucket();
  return {
    objectStore,
    c: {
      env: {
        SENSITIVE_DETAILS: objectStore.bucket,
        OBJECT_ENCRYPTION_ROOT_KEY: OBJECT_ROOT_KEY,
        OBJECT_ENCRYPTION_KEY_VERSION: '5',
        ...envOverrides,
      } as Env,
    },
  };
}

function createRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const now = Date.now();
  return {
    id: 'req-1',
    public_request_id: 'apr_public_1',
    tenant_id: 'tenant-a',
    investigation_id: 'inv_test_1',
    requester_subject_type: 'admin_user',
    requester_subject_id: 'admin-1',
    target_subject_type: 'artifact',
    target_subject_id: 'audit-1',
    request_surface: 'approvals',
    requested_action: 'detail_read',
    redaction_level: 'masked',
    status: 'pending',
    scope_canonical: '{"version":1}',
    scope_json: {
      version: 1,
      surface: 'approvals',
      action: 'detail_read',
      tenant_id: 'tenant-a',
      resource_class: 'approval_transport_detail',
      resource_ids: ['apr_public_1'],
    },
    reason_code: 'support_case',
    reason_note: null,
    reference: null,
    ticket_reference: null,
    reuse_scope: 'request',
    policy_preset: 'support_case_default',
    partial_access_allowed: false,
    requested_at: now,
    expires_at: now + 60_000,
    decided_at: null,
    detail_object_catalog_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('approval-transport-detail helpers', () => {
  it('creates and updates externalized transport evidence in place', async () => {
    const state = {
      logical: [] as Array<Record<string, unknown>>,
      physical: [] as Array<Record<string, unknown>>,
      chunkIndex: [] as Array<Record<string, unknown>>,
    };
    const adapter = {
      execute: vi.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('INSERT INTO object_catalog_objects')) {
          state.physical.push({
            id: params[0],
            catalog_id: params[1],
            representation: params[2],
            object_kind: params[3],
            object_index: params[4],
            bucket_binding: params[5],
            object_key: params[6],
            key_version: params[7],
            checksum_sha256: params[8],
            total_bytes: params[9],
            created_at: params[10],
            deleted_at: null,
          });
          return { rowsAffected: 1 };
        }
        if (sql.includes('INSERT INTO object_catalog')) {
          state.logical.push({
            id: params[0],
            public_artifact_id: params[1],
            tenant_id: params[2],
            object_class: params[3],
            created_at: params[4],
            updated_at: params[5],
            deleted_at: null,
          });
          return { rowsAffected: 1 };
        }
        if (sql.includes('UPDATE object_catalog_objects')) {
          const row = state.physical.find(
            (item) => item.catalog_id === params[4] && item.representation === 'canonical_json'
          );
          if (row) {
            row.object_kind = 'chunk';
            row.bucket_binding = 'SENSITIVE_DETAILS';
            row.object_key = params[0] ?? row.object_key;
            row.key_version = params[1];
            row.checksum_sha256 = params[2];
            row.total_bytes = params[3];
          }
          return { rowsAffected: row ? 1 : 0 };
        }
        if (sql.includes('INSERT INTO sensitive_detail_chunk_index')) {
          state.chunkIndex.push({
            catalog_id: params[0],
            tenant_id: params[1],
            object_class: params[2],
            bucket_binding: params[3],
            object_key: params[4],
            content_encoding: params[5],
            line_number: params[6],
            byte_offset: params[7],
            byte_length: params[8],
            key_version: params[9],
            checksum_sha256: params[10],
            created_at: params[11],
            deleted_at: params[12],
          });
          return { rowsAffected: 1 };
        }
        if (sql.includes('UPDATE sensitive_detail_chunk_index')) {
          const row = state.chunkIndex.find((item) => item.catalog_id === params[11]);
          if (row) {
            row.tenant_id = params[0];
            row.object_class = params[1];
            row.bucket_binding = 'SENSITIVE_DETAILS';
            row.object_key = params[2];
            row.content_encoding = params[3];
            row.line_number = params[4];
            row.byte_offset = params[5];
            row.byte_length = params[6];
            row.key_version = params[7];
            row.checksum_sha256 = params[8];
            row.created_at = params[9];
            row.deleted_at = null;
          }
          return { rowsAffected: row ? 1 : 0 };
        }
        if (sql.includes('UPDATE object_catalog')) {
          const row = state.logical.find(
            (item) => item.id === params[1] && item.tenant_id === params[2]
          );
          if (row) {
            row.updated_at = params[0];
          }
          return { rowsAffected: row ? 1 : 0 };
        }
        return { rowsAffected: 1 };
      }),
      queryOne: vi.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('FROM object_catalog') && !sql.includes('object_catalog oc')) {
          const row = state.logical.find(
            (item) =>
              item.id === params[0] &&
              item.tenant_id === params[1] &&
              item.object_class === params[2] &&
              item.deleted_at === null
          );
          return row
            ? {
                id: row.id,
                public_artifact_id: row.public_artifact_id,
                created_at: row.created_at,
              }
            : null;
        }
        if (sql.includes('FROM sensitive_detail_chunk_index sdci')) {
          const row = state.chunkIndex.find(
            (item) =>
              item.catalog_id === params[0] &&
              item.tenant_id === params[1] &&
              item.object_class === params[2] &&
              item.deleted_at === null
          );
          return row ?? null;
        }
        if (sql.includes('FROM sensitive_detail_chunk_index')) {
          const row = state.chunkIndex.find((item) => item.catalog_id === params[0]);
          return row ? { catalog_id: row.catalog_id } : null;
        }
        if (!sql.includes('FROM object_catalog oc')) {
          return null;
        }
        const tenantId = params[0];
        const identifier = params[1];
        const representation = params[2];
        const objectIndex = params[3];
        const catalog =
          state.logical.find((row) => row.tenant_id === tenantId && row.id === identifier) ??
          state.logical.find(
            (row) => row.tenant_id === tenantId && row.public_artifact_id === identifier
          );
        const object = state.physical.find(
          (row) =>
            row.catalog_id === catalog?.id &&
            row.representation === representation &&
            row.object_index === objectIndex
        );
        if (!catalog || !object) {
          return null;
        }
        return {
          catalog_id: catalog.id,
          public_artifact_id: catalog.public_artifact_id,
          tenant_id: catalog.tenant_id,
          object_class: catalog.object_class,
          catalog_created_at: catalog.created_at,
          catalog_updated_at: catalog.updated_at,
          catalog_deleted_at: catalog.deleted_at,
          physical_id: object.id,
          representation: object.representation,
          object_kind: object.object_kind,
          object_index: object.object_index,
          bucket_binding: object.bucket_binding,
          object_key: object.object_key,
          key_version: object.key_version,
          checksum_sha256: object.checksum_sha256,
          total_bytes: object.total_bytes,
          physical_created_at: object.created_at,
          physical_deleted_at: object.deleted_at,
        };
      }),
    } as any;
    const { c, objectStore } = createMockContext();
    const requestRepo = {
      updateApprovalRequestDetailObjectCatalogId: vi.fn(async (_id: string, catalogId: string) =>
        createRequest({ detail_object_catalog_id: catalogId })
      ),
    } as unknown as ApprovalRequestRepository;

    const initialRequest = createRequest();
    const requestWithDetail = await appendApprovalTransportEvent(
      c as any,
      adapter,
      requestRepo,
      initialRequest,
      {
        kind: 'request_created',
        actorSubjectType: 'admin_user',
        actorSubjectId: 'admin-1',
        requestStatus: 'pending',
        reasonCode: 'support_case',
        notificationAction: 'initial',
        occurredAt: initialRequest.created_at,
      }
    );

    expect(requestWithDetail.detail_object_catalog_id).toMatch(/[0-9a-f-]{36}/);
    expect(state.logical).toHaveLength(1);
    expect(state.physical).toHaveLength(1);
    expect(state.physical[0]?.object_kind).toBe('chunk');
    expect(state.chunkIndex).toHaveLength(1);
    expect(objectStore.store.size).toBe(1);

    const loadedInitial = await loadApprovalTransportDetail(c as any, adapter, requestWithDetail);
    expect(loadedInitial?.events).toHaveLength(1);
    expect(loadedInitial?.events[0]?.kind).toBe('request_created');

    const updatedRequest = await appendApprovalTransportEvent(
      c as any,
      adapter,
      requestRepo,
      requestWithDetail,
      {
        kind: 'step_remind',
        actorSubjectType: 'admin_user',
        actorSubjectId: 'admin-1',
        requestStatus: 'pending',
        approval: {
          id: 'step-1',
          approval_request_id: 'req-1',
          step_key: 'operator-1',
          side: 'admin_operator',
          subject_type: 'admin_user',
          subject_id: 'admin-2',
          relation_type: null,
          relation_source: null,
          status: 'pending',
          method: 'portal_confirm',
          transport_channel: null,
          reason_code: 'support_case',
          reason_note: null,
          last_notification_action: 'remind',
          last_notified_at: Date.now(),
          notification_count: 2,
          requested_at: Date.now(),
          decided_at: null,
          expires_at: Date.now() + 60_000,
          created_at: Date.now(),
          updated_at: Date.now(),
        },
        method: 'portal_confirm',
        reasonCode: 'support_case',
        notificationAction: 'remind',
        notificationCount: 2,
        transportSummary: {
          provider: 'portal',
          delivery_status: 'sent',
          target: 'admin-2',
          correlation_id: 'corr-1',
          transport_request_id: 'req-portal-1',
        },
        transportDetail: {
          request: {
            channel: 'portal_confirm',
          },
          response: {
            status: 'accepted',
          },
          metadata: {
            attempt: 2,
          },
        },
      }
    );

    expect(updatedRequest.detail_object_catalog_id).toBe(
      requestWithDetail.detail_object_catalog_id
    );
    expect(state.logical).toHaveLength(1);
    expect(state.physical).toHaveLength(1);
    expect(state.physical[0]?.object_kind).toBe('chunk');
    expect(state.chunkIndex).toHaveLength(1);
    expect(objectStore.store.size).toBe(1);

    const loadedUpdated = await loadApprovalTransportDetail(c as any, adapter, updatedRequest);
    expect(loadedUpdated?.events).toHaveLength(2);
    expect(loadedUpdated?.events[1]?.kind).toBe('step_remind');
    expect(loadedUpdated?.events[1]?.notification_count).toBe(2);
    expect(loadedUpdated?.events[1]?.transport_summary).toEqual({
      provider: 'portal',
      delivery_status: 'sent',
      target: 'admin-2',
      correlation_id: 'corr-1',
      transport_request_id: 'req-portal-1',
    });
    expect(loadedUpdated?.events[1]?.transport_detail).toEqual({
      request: {
        channel: 'portal_confirm',
      },
      response: {
        status: 'accepted',
      },
      metadata: {
        attempt: 2,
      },
    });
  });

  it('skips externalization when sensitive object storage is unavailable', async () => {
    const request = createRequest();
    const requestRepo = {
      updateApprovalRequestDetailObjectCatalogId: vi.fn(),
    } as unknown as ApprovalRequestRepository;

    const updated = await appendApprovalTransportEvent(
      { env: {} } as any,
      { execute: vi.fn(), queryOne: vi.fn() } as any,
      requestRepo,
      request,
      {
        kind: 'request_created',
        actorSubjectType: 'admin_user',
        actorSubjectId: 'admin-1',
        requestStatus: 'pending',
      }
    );

    expect(updated).toEqual(request);
    expect(requestRepo.updateApprovalRequestDetailObjectCatalogId).not.toHaveBeenCalled();
  });
});
