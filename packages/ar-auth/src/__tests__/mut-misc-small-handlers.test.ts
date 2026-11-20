import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import { AR_ERROR_CODES, type Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  sources: vi.fn(),
  listFields: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  resolveCustomClaimRuntimeSourcesFromEnv: mocks.sources,
  listRegistrationFieldDefinitions: mocks.listFields,
  getLogger: () => ({ module: () => ({ error: mocks.error, info: vi.fn(), warn: vi.fn() }) }),
}));

import { registrationFieldsHandler } from '../registration-fields';
import {
  AUTH_REQUEST_DIAGNOSTIC_CONTEXT_KEY,
  timeAuthRequestDiagnosticOperation,
} from '../request-diagnostics';

function context(values: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>([['tenantId', 'tenant-1'], ...Object.entries(values)]);
  return {
    env: { NAME: 'env' },
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
    req: { header: () => undefined, path: '/api/v1/registration-fields' },
    json: (body: unknown, status = 200) => Response.json(body, { status }),
  } as unknown as Context<{ Bindings: Env }>;
}

beforeEach(() => {
  mocks.sources.mockReset().mockResolvedValue({ schemaDb: 'schema-db' });
  mocks.listFields.mockReset().mockResolvedValue([{ field_key: 'dept' }]);
  mocks.error.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('registration fields handler', () => {
  it('lists the fields of the tenant from its schema source', async () => {
    const c = context();
    const response = await registrationFieldsHandler(c);
    expect(await response.json()).toEqual({ fields: [{ field_key: 'dept' }] });
    expect(mocks.sources).toHaveBeenCalledWith(c.env, 'tenant-1');
    expect(mocks.listFields).toHaveBeenCalledWith('schema-db', 'tenant-1');
  });

  it('answers server_error and logs when the fields cannot be read', async () => {
    mocks.listFields.mockRejectedValue(new Error('down'));
    const response = await registrationFieldsHandler(context());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error_code: AR_ERROR_CODES.INTERNAL_ERROR });
    expect(mocks.error).toHaveBeenCalledWith('Failed to fetch registration fields', {
      error: 'Error: down',
    });
  });
});

describe('auth request diagnostic operation timing', () => {
  it('only runs the operation when no diagnostics are being collected', async () => {
    await expect(timeAuthRequestDiagnosticOperation(context(), 'x', async () => 7)).resolves.toBe(
      7
    );
  });

  it('records the rounded duration of the operation, even when it fails', async () => {
    const state = { lastMarkAt: 0, spans: [] as Array<{ name: string; durationMs: number }> };
    const c = context({ [AUTH_REQUEST_DIAGNOSTIC_CONTEXT_KEY]: state });
    const clock = [10, 12.345, 20, 21.26];
    vi.spyOn(performance, 'now').mockImplementation(() => clock.shift() ?? 0);

    await expect(timeAuthRequestDiagnosticOperation(c, 'first', async () => 'ok')).resolves.toBe(
      'ok'
    );
    await expect(
      timeAuthRequestDiagnosticOperation(c, 'second', () => Promise.reject(new Error('boom')))
    ).rejects.toThrow('boom');

    expect(state.spans).toEqual([
      { name: 'first', durationMs: 2.3 },
      { name: 'second', durationMs: 1.3 },
    ]);
    expect(state.lastMarkAt).toBe(21.26);
  });
});
