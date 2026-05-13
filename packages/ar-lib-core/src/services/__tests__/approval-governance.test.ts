import { describe, expect, it } from 'vitest';
import {
  canonicalizeApprovalScope,
  generateInvestigationId,
  generatePublicApprovalRequestId,
  generatePublicElevationGrantId,
  normalizeStructuredReference,
} from '../approval-governance';

describe('approval-governance', () => {
  it('normalizes string references with an explicit default system', () => {
    expect(normalizeStructuredReference('CASE-123', { defaultSystem: 'zendesk' })).toEqual({
      system: 'zendesk',
      id: 'CASE-123',
    });
  });

  it('drops malformed structured references', () => {
    expect(
      normalizeStructuredReference({
        system: ' ',
        id: 'abc',
      })
    ).toBeNull();
  });

  it('canonicalizes approval scope deterministically', () => {
    const first = canonicalizeApprovalScope({
      surface: ' webhook_payload ',
      action: 'detail_read',
      tenant_id: 'tenant-a',
      resource_class: 'webhook_delivery',
      resource_ids: ['delivery-2', 'delivery-1', 'delivery-1'],
      detail_classes: ['response_body', 'request_headers', 'request_headers'],
      redaction_level: 'masked',
      attributes: {
        zeta: true,
        alpha: {
          second: 'b',
          first: 'a',
        },
      },
    });
    const second = canonicalizeApprovalScope({
      action: 'detail_read',
      surface: 'webhook_payload',
      tenant_id: 'tenant-a',
      resource_class: 'webhook_delivery',
      detail_classes: ['request_headers', 'response_body'],
      resource_ids: ['delivery-1', 'delivery-2'],
      redaction_level: 'masked',
      attributes: {
        alpha: {
          first: 'a',
          second: 'b',
        },
        zeta: true,
      },
    });

    expect(first.normalized.resource_ids).toEqual(['delivery-1', 'delivery-2']);
    expect(first.normalized.detail_classes).toEqual(['request_headers', 'response_body']);
    expect(first.canonical).toBe(second.canonical);
  });

  it('generates opaque governance identifiers', () => {
    expect(generateInvestigationId()).toMatch(/^inv_[0-9a-f]{32}$/);
    expect(generatePublicApprovalRequestId()).toMatch(/^apr_[0-9a-f]{32}$/);
    expect(generatePublicElevationGrantId()).toMatch(/^egr_[0-9a-f]{32}$/);
  });
});
