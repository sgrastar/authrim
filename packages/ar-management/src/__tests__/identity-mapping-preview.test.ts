import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { edge, fieldRef, TEST_CATALOG } from '@authrim/ar-lib-identity-mapping/test-support';
import type { FieldRef } from '@authrim/ar-lib-identity-mapping';
import { adminCsvDryRunPreviewHandler } from '../identity-mapping-preview';

interface PreviewResponseBody {
  preview: unknown;
  status: string;
  rowResults: Array<{ canonicalTargetPreview: unknown[] }>;
}

interface ErrorResponseBody {
  error: string;
  error_description: string;
}

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/preview/csv', adminCsvDryRunPreviewHandler);
  return app;
}

function buildPreviewBody(overrides: Record<string, unknown> = {}) {
  const emailSource = fieldRef('csv', 'email', 'field.csv.email');
  const emailTarget: FieldRef = {
    side: 'canonical',
    namespace: 'authrim.profile',
    path: 'email',
    catalogEntryId: 'field.canonical.email',
  };

  return {
    rows: [{ email: 'person@example.test', display_name: 'Private Name' }],
    columnToPath: { email: 'email' },
    catalog: TEST_CATALOG,
    edges: [edge(emailSource, emailTarget)],
    ...overrides,
  };
}

describe('adminCsvDryRunPreviewHandler', () => {
  it('returns CSV dry-run preview without raw row values', async () => {
    const app = buildApp();
    const response = await app.request('/preview/csv', {
      method: 'POST',
      body: JSON.stringify(buildPreviewBody()),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as PreviewResponseBody;
    expect(body.preview).toEqual({
      protocol: 'csv',
      persisted: false,
      maxRows: 100,
    });
    expect(body.status).toBe('success');
    expect(body.rowResults[0].canonicalTargetPreview).toContainEqual({
      action: 'mapped',
      namespace: 'authrim.profile',
      path: 'email',
      catalogEntryId: 'field.canonical.email',
      edgeId: expect.any(String),
      transformStepId: null,
    });
    expect(JSON.stringify(body)).not.toContain('person@example.test');
    expect(JSON.stringify(body)).not.toContain('Private Name');
  });

  it('rejects invalid request bodies', async () => {
    const app = buildApp();
    const response = await app.request('/preview/csv', {
      method: 'POST',
      body: JSON.stringify({ rows: 'not-array' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorResponseBody;
    expect(body).toMatchObject({
      error: 'invalid_request',
      error_description: 'rows must be an array',
    });
  });

  it('rejects previews above the row cap', async () => {
    const app = buildApp();
    const rows = Array.from({ length: 101 }, (_, index) => ({
      email: `person-${index}@example.test`,
    }));
    const response = await app.request('/preview/csv', {
      method: 'POST',
      body: JSON.stringify(buildPreviewBody({ rows })),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorResponseBody;
    expect(body).toMatchObject({
      error: 'invalid_request',
      error_description: 'rows must contain at most 100 items',
    });
  });
});
