/**
 * FlowStateStore Durable Object Unit Tests
 *
 * Tests for Flow Engine state management:
 * - RuntimeState initialization
 * - requestId idempotency (critical for submit re-sends)
 * - TTL management
 * - Session cancellation
 *
 * @see /private/docs/track-c-flow-engine-design.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlowStateStore } from '../flow-engine/flow-state-store';
import type { CreateRuntimeStateParams, FlowSubmitResult } from '../flow-engine/types';
import type { UIContract } from '@authrim/ar-lib-core';

// =============================================================================
// Test Helper: Create minimal UIContract for tests
// =============================================================================

function createTestUIContract(overrides: Partial<UIContract> = {}): UIContract {
  return {
    version: '0.1',
    state: 'test',
    intent: 'identify_user',
    features: {
      policy: { rbac: 'simple', abac: false, rebac: false },
      targets: { human: true, iot: false, ai_agent: false, ai_mcp: false, service: false },
      authMethods: {
        passkey: true,
        email_code: true,
        password: false,
        external_idp: false,
        did: false,
      },
    },
    capabilities: [],
    actions: {
      primary: { type: 'SUBMIT', label: 'Continue' },
    },
    ...overrides,
  };
}

// =============================================================================
// Mock DurableObjectState
// =============================================================================

function createMockDurableObjectState() {
  const storage = new Map<string, unknown>();
  let alarm: number | null = null;

  return {
    storage: {
      get: vi.fn().mockImplementation(async <T>(key: string): Promise<T | undefined> => {
        return storage.get(key) as T | undefined;
      }),
      put: vi.fn().mockImplementation(async (key: string, value: unknown) => {
        storage.set(key, value);
      }),
      delete: vi.fn().mockImplementation(async (key: string) => {
        return storage.delete(key);
      }),
      setAlarm: vi.fn().mockImplementation(async (time: number) => {
        alarm = time;
      }),
      deleteAlarm: vi.fn().mockImplementation(async () => {
        alarm = null;
      }),
    },
    _storage: storage,
    _getAlarm: () => alarm,
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

function createInitRequest(params: Partial<CreateRuntimeStateParams> = {}): Request {
  const body: CreateRuntimeStateParams = {
    sessionId: params.sessionId ?? 'session_test_123',
    flowId: params.flowId ?? 'human-basic-login',
    flowType: params.flowType ?? 'login',
    tenantId: params.tenantId ?? 'tenant_default',
    clientId: params.clientId ?? 'client_test',
    entryNodeId: params.entryNodeId ?? 'start',
    ttlMs: params.ttlMs ?? 600000,
    oauthParams: params.oauthParams,
  };

  return new Request('http://localhost/init', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': body.tenantId,
      'X-Flow-Session-Id': body.sessionId,
    },
    body: JSON.stringify(body),
  });
}

function createSubmitRequest(params: {
  requestId: string;
  capabilityId: string;
  response: unknown;
  result: FlowSubmitResult;
  nextNodeId: string;
  tenantId?: string;
  sessionId?: string;
}): Request {
  return new Request('http://localhost/submit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': params.tenantId ?? 'tenant_default',
      'X-Flow-Session-Id': params.sessionId ?? 'session_test_123',
    },
    body: JSON.stringify(params),
  });
}

function createStateRequest(params: { tenantId?: string; sessionId?: string } = {}): Request {
  return new Request('http://localhost/state', {
    method: 'GET',
    headers: {
      'X-Tenant-Id': params.tenantId ?? 'tenant_default',
      'X-Flow-Session-Id': params.sessionId ?? 'session_test_123',
    },
  });
}

function createCancelRequest(params: { tenantId?: string; sessionId?: string } = {}): Request {
  return new Request('http://localhost/cancel', {
    method: 'DELETE',
    headers: {
      'X-Tenant-Id': params.tenantId ?? 'tenant_default',
      'X-Flow-Session-Id': params.sessionId ?? 'session_test_123',
    },
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('FlowStateStore', () => {
  let mockState: ReturnType<typeof createMockDurableObjectState>;
  let flowStateStore: FlowStateStore;

  beforeEach(() => {
    mockState = createMockDurableObjectState();
    flowStateStore = new FlowStateStore(mockState as unknown as DurableObjectState);
  });

  // ===========================================================================
  // Initialization Tests
  // ===========================================================================

  describe('POST /init', () => {
    it('should create a new session successfully', async () => {
      const request = createInitRequest({ sessionId: 'session_new_123' });
      const response = await flowStateStore.fetch(request);

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        success: boolean;
        state: { sessionId: string; flowId: string; currentNodeId: string };
      };
      expect(body.success).toBe(true);
      expect(body.state).toBeDefined();
      expect(body.state.sessionId).toBe('session_new_123');
      expect(body.state.flowId).toBe('human-basic-login');
      expect(body.state.currentNodeId).toBe('start');
    });

    it('should reject duplicate session initialization', async () => {
      // First initialization
      const request1 = createInitRequest({ sessionId: 'session_dup_123' });
      await flowStateStore.fetch(request1);

      // Second initialization should fail
      const request2 = createInitRequest({ sessionId: 'session_dup_456' });
      const response = await flowStateStore.fetch(request2);

      expect(response.status).toBe(409);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe('session_exists');
    });

    it('should set TTL alarm', async () => {
      const request = createInitRequest({ ttlMs: 300000 });
      await flowStateStore.fetch(request);

      expect(mockState.storage.setAlarm).toHaveBeenCalled();
      const alarmTime = mockState._getAlarm();
      expect(alarmTime).toBeDefined();
      expect(alarmTime).toBeGreaterThan(Date.now());
    });

    it('should reject init when tenant header does not match body tenant', async () => {
      const request = new Request('http://localhost/init', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-Id': 'tenant_other',
          'X-Flow-Session-Id': 'session_test_123',
        },
        body: JSON.stringify({
          sessionId: 'session_test_123',
          flowId: 'human-basic-login',
          flowType: 'login',
          tenantId: 'tenant_default',
          clientId: 'client_test',
          entryNodeId: 'start',
        }),
      });

      const response = await flowStateStore.fetch(request);

      expect(response.status).toBe(403);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe('tenant_mismatch');
    });
  });

  // ===========================================================================
  // Idempotency Tests (Critical)
  // ===========================================================================

  describe('POST /submit - Idempotency', () => {
    beforeEach(async () => {
      // Initialize session first
      const initRequest = createInitRequest();
      await flowStateStore.fetch(initRequest);
    });

    it('should process first submit and store snapshot', async () => {
      const submitResult: FlowSubmitResult = {
        type: 'continue',
        uiContract: createTestUIContract({
          state: 'human-basic-login:auth_method',
          intent: 'authenticate_user',
        }),
      };

      const request = createSubmitRequest({
        requestId: 'req_unique_001',
        capabilityId: 'identifier_email',
        response: { email: 'test@example.com' },
        result: submitResult,
        nextNodeId: 'auth_method',
      });

      const response = await flowStateStore.fetch(request);

      expect(response.status).toBe(200);
      expect(response.headers.get('X-Idempotent')).toBeNull(); // First request
      const body = (await response.json()) as { type: string };
      expect(body.type).toBe('continue');
    });

    it('should return same result for duplicate requestId (idempotent)', async () => {
      const submitResult: FlowSubmitResult = {
        type: 'continue',
        uiContract: createTestUIContract({
          state: 'human-basic-login:auth_method',
          intent: 'authenticate_user',
        }),
      };

      const requestParams = {
        requestId: 'req_dup_001',
        capabilityId: 'identifier_email',
        response: { email: 'test@example.com' },
        result: submitResult,
        nextNodeId: 'auth_method',
      };

      // First submit
      const request1 = createSubmitRequest(requestParams);
      const response1 = await flowStateStore.fetch(request1);
      expect(response1.status).toBe(200);
      expect(response1.headers.get('X-Idempotent')).toBeNull();
      const body1 = (await response1.json()) as FlowSubmitResult;

      // Second submit with same requestId (re-send)
      const request2 = createSubmitRequest(requestParams);
      const response2 = await flowStateStore.fetch(request2);
      expect(response2.status).toBe(200);
      expect(response2.headers.get('X-Idempotent')).toBe('true'); // Idempotent marker
      const body2 = (await response2.json()) as FlowSubmitResult;

      // Results should be identical
      expect(body2).toEqual(body1);
    });

    it('should process different requestIds independently', async () => {
      const submitResult1: FlowSubmitResult = {
        type: 'continue',
        uiContract: createTestUIContract({
          state: 'human-basic-login:auth_method',
          intent: 'authenticate_user',
        }),
      };

      const submitResult2: FlowSubmitResult = {
        type: 'continue',
        uiContract: createTestUIContract({
          state: 'human-basic-login:complete',
          intent: 'complete_flow',
        }),
      };

      // First unique requestId
      const request1 = createSubmitRequest({
        requestId: 'req_diff_001',
        capabilityId: 'identifier_email',
        response: { email: 'test@example.com' },
        result: submitResult1,
        nextNodeId: 'auth_method',
      });
      const response1 = await flowStateStore.fetch(request1);
      expect(response1.headers.get('X-Idempotent')).toBeNull();

      // Second unique requestId
      const request2 = createSubmitRequest({
        requestId: 'req_diff_002',
        capabilityId: 'auth_method_passkey',
        response: { webauthn: { success: true } },
        result: submitResult2,
        nextNodeId: 'complete',
      });
      const response2 = await flowStateStore.fetch(request2);
      expect(response2.headers.get('X-Idempotent')).toBeNull();
    });
  });

  // ===========================================================================
  // Session Not Found Tests
  // ===========================================================================

  describe('Session validation', () => {
    it('should return 404 for submit without init', async () => {
      // Do not call init
      const submitResult: FlowSubmitResult = {
        type: 'continue',
        uiContract: createTestUIContract({
          state: 'test',
          intent: 'identify_user',
          features: {
            policy: { rbac: 'simple', abac: false, rebac: false },
            targets: { human: true, iot: false, ai_agent: false, ai_mcp: false, service: false },
            authMethods: {
              passkey: false,
              email_code: false,
              password: false,
              external_idp: false,
              did: false,
            },
          },
        }),
      };

      const request = createSubmitRequest({
        requestId: 'req_no_session',
        capabilityId: 'test',
        response: {},
        result: submitResult,
        nextNodeId: 'test',
      });
      const response = await flowStateStore.fetch(request);

      expect(response.status).toBe(404);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe('session_not_found');
    });

    it('should return 404 for get state without init', async () => {
      const request = createStateRequest();
      const response = await flowStateStore.fetch(request);

      expect(response.status).toBe(404);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe('session_not_found');
    });

    it('should reject runtime access without tenant header', async () => {
      const initRequest = createInitRequest();
      await flowStateStore.fetch(initRequest);

      const request = new Request('http://localhost/state', {
        method: 'GET',
        headers: { 'X-Flow-Session-Id': 'session_test_123' },
      });
      const response = await flowStateStore.fetch(request);

      expect(response.status).toBe(400);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe('tenant_required');
    });

    it('should reject runtime access for a different tenant', async () => {
      const initRequest = createInitRequest();
      await flowStateStore.fetch(initRequest);

      const request = createStateRequest({ tenantId: 'tenant_other' });
      const response = await flowStateStore.fetch(request);

      expect(response.status).toBe(403);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe('tenant_mismatch');
    });
  });

  // ===========================================================================
  // Cancellation Tests
  // ===========================================================================

  describe('DELETE /cancel', () => {
    it('should cancel existing session', async () => {
      // Initialize first
      const initRequest = createInitRequest();
      await flowStateStore.fetch(initRequest);

      // Cancel
      const cancelRequest = createCancelRequest();
      const response = await flowStateStore.fetch(cancelRequest);

      expect(response.status).toBe(200);
      const body = (await response.json()) as { success: boolean };
      expect(body.success).toBe(true);

      // Verify session is gone
      const stateRequest = createStateRequest();
      const stateResponse = await flowStateStore.fetch(stateRequest);
      expect(stateResponse.status).toBe(404);
    });

    it('should succeed even without existing session', async () => {
      const cancelRequest = createCancelRequest();
      const response = await flowStateStore.fetch(cancelRequest);

      expect(response.status).toBe(200);
      const body = (await response.json()) as { success: boolean };
      expect(body.success).toBe(true);
    });
  });

  // ===========================================================================
  // 404 Not Found Tests
  // ===========================================================================

  describe('Unknown routes', () => {
    it('should return 404 for unknown routes', async () => {
      const request = new Request('http://localhost/unknown', {
        method: 'GET',
      });
      const response = await flowStateStore.fetch(request);

      expect(response.status).toBe(404);
    });
  });
});
