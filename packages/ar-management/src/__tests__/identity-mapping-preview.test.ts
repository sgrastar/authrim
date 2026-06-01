import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { edge, fieldRef, TEST_CATALOG } from '@authrim/ar-lib-identity-mapping/test-support';
import type { FieldRef } from '@authrim/ar-lib-identity-mapping';
import {
  adminCsvDryRunPreviewHandler,
  adminOidcReleasePreviewHandler,
  adminSamlReleasePreviewHandler,
} from '../identity-mapping-preview';

interface PreviewResponseBody {
  preview: unknown;
  status: string;
  rowResults: Array<{ canonicalTargetPreview: unknown[] }>;
}

interface OutboundPreviewResponseBody {
  preview: unknown;
  status: string;
  summary: {
    releaseCount: number;
    omitCount: number;
    denyCount: number;
    regulatedDenyCount: number;
  };
  items: Array<{
    decision: string;
    legalBasis: string;
    reasons: Array<{ code: string; severity: string }>;
    consentPreview?: unknown;
    oidcConstraint?: unknown;
  }>;
}

interface ErrorResponseBody {
  error: string;
  error_description: string;
}

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/preview/csv', adminCsvDryRunPreviewHandler);
  app.post('/preview/saml', adminSamlReleasePreviewHandler);
  app.post('/preview/oidc', adminOidcReleasePreviewHandler);
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

  it('rejects CSV preview cells that exceed the preview budget', async () => {
    const app = buildApp();
    const response = await app.request('/preview/csv', {
      method: 'POST',
      body: JSON.stringify(
        buildPreviewBody({
          rows: [{ email: 'a'.repeat(4097) }],
        })
      ),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorResponseBody;
    expect(body).toMatchObject({
      error: 'invalid_request',
      error_description: 'request.rows[0].email string value must be at most 4096 characters',
    });
  });

  it('rejects CSV previews with excessive edge counts', async () => {
    const app = buildApp();
    const emailSource = fieldRef('csv', 'email', 'field.csv.email');
    const emailTarget: FieldRef = {
      side: 'canonical',
      namespace: 'authrim.profile',
      path: 'email',
      catalogEntryId: 'field.canonical.email',
    };
    const edges = Array.from({ length: 501 }, () => edge(emailSource, emailTarget));

    const response = await app.request('/preview/csv', {
      method: 'POST',
      body: JSON.stringify(buildPreviewBody({ edges })),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorResponseBody;
    expect(body).toMatchObject({
      error: 'invalid_request',
      error_description: 'edges must contain at most 500 items',
    });
  });
});

describe('admin outbound release preview handlers', () => {
  it('returns OIDC release preview with ASC constraints and no raw requested value leakage', async () => {
    const app = buildApp();
    const response = await app.request('/preview/oidc', {
      method: 'POST',
      body: JSON.stringify({
        destination: {
          protocol: 'oidc',
          destinationId: 'client-web',
          purpose: 'login',
        },
        values: [
          {
            fieldRef: {
              side: 'canonical',
              namespace: 'authrim.profile',
              path: 'email',
              catalogEntryId: 'field.canonical.email',
            },
            outputName: 'email',
            classification: 'pii',
            valueType: 'string',
            legalBasis: 'contract',
            valueFingerprint: 'fp_email',
          },
        ],
        oidcClaimsRequest: {
          email: { essential: true, value: 'person@example.test' },
        },
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as OutboundPreviewResponseBody;
    expect(body.preview).toEqual({
      protocol: 'oidc',
      persisted: false,
    });
    expect(body.status).toBe('success');
    expect(body.items[0]).toMatchObject({
      decision: 'release',
      legalBasis: 'contract',
      oidcConstraint: {
        essential: true,
        requestedValueCount: 1,
      },
    });
    expect(JSON.stringify(body)).not.toContain('person@example.test');
  });

  it('returns SAML consent preview and omits when attribute release consent is missing', async () => {
    const app = buildApp();
    const response = await app.request('/preview/saml', {
      method: 'POST',
      body: JSON.stringify({
        destination: {
          protocol: 'saml',
          destinationId: 'sp-acme',
          purpose: 'login',
        },
        values: [
          {
            fieldRef: {
              side: 'canonical',
              namespace: 'authrim.profile',
              path: 'email',
              catalogEntryId: 'field.canonical.email',
            },
            outputName: 'mail',
            classification: 'pii',
            valueType: 'string',
            legalBasis: 'consent',
            consent: {
              required: true,
              granted: false,
              mode: 'once',
              attributeSetHash: 'attrs_v1_hash',
            },
          },
        ],
        samlRequestedAttributes: [{ name: 'mail', isRequired: false }],
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as OutboundPreviewResponseBody;
    expect(body.status).toBe('partial');
    expect(body.summary.omitCount).toBe(1);
    expect(body.items[0]).toMatchObject({
      decision: 'omit',
      legalBasis: 'consent',
      consentPreview: {
        required: true,
        granted: false,
        mode: 'once',
        attributeSetHash: 'attrs_v1_hash',
      },
    });
  });

  it('denies regulated legal-obligation fields for purpose mismatches', async () => {
    const app = buildApp();
    const response = await app.request('/preview/oidc', {
      method: 'POST',
      body: JSON.stringify({
        destination: {
          protocol: 'oidc',
          destinationId: 'client-web',
          purpose: 'marketing',
        },
        values: [
          {
            fieldRef: {
              side: 'canonical',
              namespace: 'authrim.profile',
              path: 'governmentId',
              catalogEntryId: 'field.canonical.government_id',
            },
            outputName: 'government_id',
            classification: 'regulated',
            valueType: 'string',
            legalBasis: 'legal_obligation',
            allowedPurposes: ['tax_reporting'],
          },
        ],
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as OutboundPreviewResponseBody;
    expect(body.status).toBe('failed');
    expect(body.summary.regulatedDenyCount).toBe(1);
    expect(body.items[0]?.reasons).toContainEqual({
      code: 'release.regulated_purpose_mismatch',
      severity: 'critical',
      message: expect.any(String),
    });
  });

  it('rejects protocol mismatches for dedicated preview endpoints', async () => {
    const app = buildApp();
    const response = await app.request('/preview/saml', {
      method: 'POST',
      body: JSON.stringify({
        destination: {
          protocol: 'oidc',
          destinationId: 'client-web',
          purpose: 'login',
        },
        values: [],
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorResponseBody;
    expect(body).toMatchObject({
      error: 'invalid_request',
      error_description: 'destination.protocol must be saml',
    });
  });

  it('rejects outbound previews above the value cap', async () => {
    const app = buildApp();
    const values = Array.from({ length: 251 }, (_, index) => ({
      fieldRef: {
        side: 'canonical',
        namespace: 'authrim.profile',
        path: `field_${index}`,
      },
      outputName: `field_${index}`,
      classification: 'internal',
      valueType: 'string',
      legalBasis: 'contract',
    }));

    const response = await app.request('/preview/oidc', {
      method: 'POST',
      body: JSON.stringify({
        destination: {
          protocol: 'oidc',
          destinationId: 'client-web',
          purpose: 'login',
        },
        values,
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorResponseBody;
    expect(body).toMatchObject({
      error: 'invalid_request',
      error_description: 'values must contain at most 250 items',
    });
  });
});
